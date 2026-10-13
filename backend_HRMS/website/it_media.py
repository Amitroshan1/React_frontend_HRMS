"""IT asset media (photos, receipts, return attachments) stored as files instead of base64 JSON.

Stored value per photo is a relative upload key:
    it_media/t{tenant_id}/{kind}/{YYYY}/{MM}/{32 hex}.{ext}
API responses turn those keys into signed /api/files/signed/... URLs (works in <img src>).

Backward compatible in both directions:
  * Incoming base64 data URLs are written to disk (when IT_MEDIA_FILES is on, default on).
    Unsupported/invalid data URLs are stored inline exactly as before.
  * Incoming signed/content URLs for it_media files map back to the stored key, so a page
    that round-trips the photos it received does not lose them.
  * Rows that still hold base64 are returned unchanged until migrated
    (see migrate_it_media_to_files.py).
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import unquote, urlparse

from flask import current_app, g

IT_MEDIA_PREFIX = "it_media"

# Strict key shape: only keys this module created can be signed or accepted back from clients.
_KEY_RE = re.compile(
    r"^it_media/t(\d+)/[a-z_]{1,40}/\d{4}/\d{2}/[0-9a-f]{32}\.(jpg|png|gif|webp|bmp|pdf|doc|docx)$"
)
_DATA_URL_RE = re.compile(r"^data:([\w.+-]+/[\w.+-]+)?((?:;[\w.+-]+=[^;,]*)*)(;base64)?,", re.IGNORECASE)

_IMAGE_EXTS = {"jpg", "png", "gif", "webp", "bmp"}
_DOC_MIME_EXT = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
}
# Signed IT media URLs stay identical for up to this long, so browsers reuse cached images.
SIGNED_URL_BUCKET_SECONDS = 3600


def _env_on(name: str, default: str = "1") -> bool:
    raw = current_app.config.get(name)
    if raw is None:
        raw = os.getenv(name, default)
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def media_files_enabled() -> bool:
    return _env_on("IT_MEDIA_FILES", "1")


def _max_bytes() -> int:
    try:
        return int(current_app.config.get("IT_MEDIA_MAX_BYTES") or os.getenv("IT_MEDIA_MAX_BYTES") or 25 * 1024 * 1024)
    except (TypeError, ValueError):
        return 25 * 1024 * 1024


def _current_tenant_id() -> int:
    try:
        from .tenant_context import get_current_tenant_id

        return int(get_current_tenant_id() or 1)
    except Exception:
        return 1


def _detect_ext(raw: bytes) -> Optional[str]:
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if raw.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    if raw.startswith(b"BM"):
        return "bmp"
    if raw.startswith(b"%PDF-"):
        return "pdf"
    if raw.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return "doc"
    if raw.startswith(b"PK\x03\x04"):
        return "docx"
    return None


def _decode_data_url(value: str) -> Optional[tuple[bytes, str]]:
    """Return (bytes, ext) for a supported base64 data URL, else None (caller keeps it inline)."""
    m = _DATA_URL_RE.match(value)
    if not m or not m.group(3):
        return None
    mime = (m.group(1) or "").lower()
    payload = value[m.end():]
    if not payload or (len(payload) * 3) // 4 > _max_bytes():
        return None
    try:
        raw = base64.b64decode("".join(payload.split()), validate=False)
    except (binascii.Error, ValueError):
        return None
    if not raw or len(raw) > _max_bytes():
        return None

    detected = _detect_ext(raw)
    if not detected:
        return None
    if mime.startswith("image/") and mime != "image/svg+xml":
        # Browsers label by file extension; trust the bytes for the actual image type.
        return (raw, detected) if detected in _IMAGE_EXTS else None
    if _DOC_MIME_EXT.get(mime) == detected:
        return raw, detected
    return None


def _write_media_file(raw: bytes, ext: str, kind: str) -> str:
    from .secure_file_service import private_uploads_root

    now = datetime.now(timezone.utc)
    safe_kind = re.sub(r"[^a-z_]", "", (kind or "misc").lower())[:40] or "misc"
    rel_dir = f"{IT_MEDIA_PREFIX}/t{_current_tenant_id()}/{safe_kind}/{now:%Y}/{now:%m}"
    rel = f"{rel_dir}/{uuid.uuid4().hex}.{ext}"

    abs_dir = os.path.join(private_uploads_root(), *rel_dir.split("/"))
    os.makedirs(abs_dir, exist_ok=True)
    abs_path = os.path.join(private_uploads_root(), *rel.split("/"))
    tmp_path = f"{abs_path}.tmp"
    with open(tmp_path, "wb") as fh:
        fh.write(raw)
    os.replace(tmp_path, abs_path)
    return rel


def media_key_from_ref(value: Any) -> Optional[str]:
    """it_media key for a stored key or a signed/content URL pointing at one, else None."""
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s or s.startswith("data:"):
        return None
    try:
        path = urlparse(s).path if "://" in s or "?" in s else s
    except ValueError:
        return None
    path = unquote(path).lstrip("/")
    for prefix in ("api/files/signed/", "api/files/content/", "static/uploads/", "uploads/"):
        if path.startswith(prefix):
            path = path[len(prefix):]
            break
    m = _KEY_RE.match(path)
    if not m:
        return None
    if int(m.group(1)) != _current_tenant_id():
        return None
    return path


def _store_one(value: Any, kind: str, *, force: bool = False) -> Any:
    if not isinstance(value, str):
        return value
    key = media_key_from_ref(value)
    if key:
        return key
    if not value.startswith("data:") or not (force or media_files_enabled()):
        return value

    decoded = _decode_data_url(value)
    if not decoded:
        return value

    # The same photo is often sent for every unit row of a bulk add: write it once.
    written = g.setdefault("_it_media_written", {})
    digest = (_current_tenant_id(), decoded[1], hashlib.sha256(decoded[0]).hexdigest())
    if digest in written:
        return written[digest]
    try:
        rel = _write_media_file(decoded[0], decoded[1], kind)
    except OSError:
        current_app.logger.exception("IT media write failed (%s); keeping inline data", kind)
        return value
    written[digest] = rel
    return rel


def media_in(value: Any, kind: str, *, force: bool = False) -> Any:
    """Normalize client photo payload (list or single value) for storage."""
    if isinstance(value, list):
        return [_store_one(v, kind, force=force) for v in value]
    return _store_one(value, kind, force=force)


def _sign_one(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    m = _KEY_RE.match(value)
    if not m or int(m.group(1)) != _current_tenant_id():
        return value
    from .secure_file_service import build_signed_file_url

    return build_signed_file_url(value, bucket=SIGNED_URL_BUCKET_SECONDS)


def media_out(value: Any) -> Any:
    """Stored photo value (list or single) -> response value with signed URLs."""
    if isinstance(value, list):
        return [_sign_one(v) for v in value]
    return _sign_one(value)


def is_storable_data_url(value: Any) -> bool:
    """True when media_in would move this inline value to a file (dry-run reporting)."""
    return isinstance(value, str) and value.startswith("data:") and _decode_data_url(value) is not None
