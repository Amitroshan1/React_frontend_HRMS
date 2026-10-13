"""
Production-ready private upload access.

Goals:
  - Block anonymous /static/uploads enumeration (IDOR via guessable names).
  - Keep legitimate HRMS access working via JWT and short-lived signed URLs
    (signed URLs support <img src> / email links without Authorization headers).
  - Dual-resolve files from UPLOADS_ROOT and legacy website/static/uploads.
"""

from __future__ import annotations

import hashlib
import hmac
import mimetypes
import os
import re
import time
from typing import Optional, Tuple
from urllib.parse import quote

from flask import current_app, jsonify, request, send_file
from flask_jwt_extended import decode_token, verify_jwt_in_request, get_jwt

from .models.Admin_models import Admin

# Profile photo filenames: profile_{admin_id}_{emp_slug}.ext
_PROFILE_PHOTO_RE = re.compile(r"^profile_(\d+)_", re.IGNORECASE)
# Profile KYC docs: profile/{admin_id}_{field}_...
_PROFILE_DOC_RE = re.compile(r"^profile/(\d+)_", re.IGNORECASE)

PRIVILEGED_EMP_TYPES = {
    "account",
    "accounts",
    "accountant",
    "hr",
    "human resource",
    "admin",
    "it",
}


def _secret() -> str:
    return (
        current_app.config.get("JWT_SECRET_KEY")
        or current_app.config.get("SECRET_KEY")
        or "change-me"
    )


def file_sign_ttl_seconds() -> int:
    try:
        return max(60, int(current_app.config.get("FILE_SIGN_TTL_SECONDS") or 3600))
    except (TypeError, ValueError):
        return 3600


def normalize_upload_rel(path: str) -> str:
    """Normalize to a relative upload key (no leading static/uploads/)."""
    raw = (path or "").replace("\\", "/").strip()
    if not raw:
        return ""
    # Absolute URL → path
    if raw.startswith("http://") or raw.startswith("https://"):
        try:
            from urllib.parse import urlparse

            raw = urlparse(raw).path or ""
        except Exception:
            pass
    raw = raw.lstrip("/")
    for prefix in ("static/uploads/", "uploads/"):
        if raw.startswith(prefix):
            raw = raw[len(prefix) :]
            break
    parts = [p for p in raw.split("/") if p and p != ".."]
    return "/".join(parts)


def static_uploads_root() -> str:
    return os.path.abspath(os.path.join(current_app.static_folder or "static", "uploads"))


def private_uploads_root() -> str:
    root = current_app.config.get("UPLOADS_ROOT")
    if root and str(root).strip():
        return os.path.abspath(str(root).strip())
    # Default: backend_HRMS/uploads (sibling of website/)
    return os.path.abspath(os.path.join(current_app.root_path, "..", "uploads"))


def resolve_upload_abs_path(rel: str) -> Optional[str]:
    """
    Find file on disk. Checks private UPLOADS_ROOT first, then legacy static/uploads.
    Returns absolute path or None.
    """
    rel = normalize_upload_rel(rel)
    if not rel or ".." in rel.split("/"):
        return None

    candidates = []
    priv = private_uploads_root()
    candidates.append(os.path.join(priv, *rel.split("/")))
    # Legacy payslips/form16 may be under private root only
    static_root = static_uploads_root()
    candidates.append(os.path.join(static_root, *rel.split("/")))

    for abs_path in candidates:
        abs_path = os.path.abspath(abs_path)
        # Containment check
        if not (
            abs_path.startswith(priv + os.sep)
            or abs_path.startswith(static_root + os.sep)
            or abs_path == priv
            or abs_path == static_root
        ):
            continue
        if os.path.isfile(abs_path):
            return abs_path
    return None


def is_privileged_admin(admin: Optional[Admin], claims: Optional[dict] = None) -> bool:
    if not admin:
        return False
    emp = (getattr(admin, "emp_type", None) or "").strip().lower()
    if emp in PRIVILEGED_EMP_TYPES:
        return True
    try:
        from .plan_features import can_access_accounts_panel, is_org_admin

        c = claims or {}
        return bool(is_org_admin(c) or can_access_accounts_panel(c))
    except Exception:
        return False


def _admin_from_jwt() -> Tuple[Optional[Admin], Optional[dict], Optional[tuple]]:
    """Return (admin, claims, error_response)."""
    try:
        verify_jwt_in_request(optional=False)
    except Exception:
        return None, None, (jsonify({"success": False, "message": "Unauthorized"}), 401)
    claims = get_jwt() or {}
    email = (claims.get("email") or "").strip()
    admin = Admin.query.filter_by(email=email).first() if email else None
    if not admin:
        # fallback: identity as admin id
        try:
            from flask_jwt_extended import get_jwt_identity

            aid = int(get_jwt_identity())
            admin = Admin.query.get(aid)
        except Exception:
            admin = None
    if not admin:
        return None, claims, (jsonify({"success": False, "message": "Unauthorized user"}), 401)
    return admin, claims, None


def try_admin_from_optional_jwt() -> Tuple[Optional[Admin], Optional[dict]]:
    try:
        verify_jwt_in_request(optional=True)
        claims = get_jwt() or {}
        if not claims:
            return None, None
        email = (claims.get("email") or "").strip()
        if email:
            admin = Admin.query.filter_by(email=email).first()
            if admin:
                return admin, claims
        from flask_jwt_extended import get_jwt_identity

        aid = int(get_jwt_identity())
        return Admin.query.get(aid), claims
    except Exception:
        return None, None


def authorize_upload_access(admin: Admin, rel: str, claims: Optional[dict] = None) -> Tuple[bool, str]:
    """
    Return (allowed, reason).
    Legitimate in-app roles keep access; anonymous callers never reach here.
    """
    rel = normalize_upload_rel(rel)
    if not rel:
        return False, "Invalid path"

    privileged = is_privileged_admin(admin, claims)

    # --- Payslips / Form16 / Tax (mirror Accounts.serve_uploaded_file) ---
    if rel.startswith("payslips/"):
        from .models.news_feed import PaySlip
        from .sensitive_data_auth import require_sensitive_for_employee

        payslip = PaySlip.query.filter_by(file_path=rel).first()
        if not payslip:
            # Allow privileged browse of orphan files; deny others
            return (True, "ok") if privileged else (False, "Payslip not found")
        if not privileged and payslip.admin_id != admin.id:
            return False, "Access denied"
        blocked = require_sensitive_for_employee(admin, payslip.admin_id)
        if blocked:
            return False, "Sensitive verification required"
        return True, "ok"

    if rel.startswith("form16/"):
        from .models.news_feed import Form16
        from .sensitive_data_auth import require_sensitive_for_employee

        row = Form16.query.filter_by(file_path=rel).first()
        if row:
            if not privileged and row.admin_id != admin.id:
                return False, "Access denied"
            blocked = require_sensitive_for_employee(admin, row.admin_id)
            if blocked:
                return False, "Sensitive verification required"
        elif not privileged:
            return False, "Access denied"
        return True, "ok"

    if rel.startswith("tax_declarations/"):
        from .sensitive_data_auth import require_sensitive_for_employee

        parts = rel.split("/")
        if len(parts) >= 2 and parts[1].isdigit():
            from .models.employee_tax_declaration import EmployeeTaxDeclaration

            decl = EmployeeTaxDeclaration.query.get(int(parts[1]))
            if decl:
                if not privileged and decl.admin_id != admin.id:
                    return False, "Access denied"
                blocked = require_sensitive_for_employee(admin, decl.admin_id)
                if blocked:
                    return False, "Sensitive verification required"
                return True, "ok"
        return (True, "ok") if privileged else (False, "Access denied")

    if rel.startswith("signatures/"):
        parts = rel.split("/")
        if len(parts) >= 2 and parts[1].isdigit():
            owner_id = int(parts[1])
            if privileged or admin.id == owner_id:
                return True, "ok"
        return False, "Access denied"

    if rel.startswith("daily_checkout/"):
        parts = rel.split("/")
        if privileged:
            return True, "ok"
        if len(parts) >= 2 and parts[1].isdigit():
            from .models.daily_checkout import DailyCheckoutRequest

            req = DailyCheckoutRequest.query.get(int(parts[1]))
            if req and int(req.requester_admin_id) == int(admin.id):
                return True, "ok"
        return False, "Access denied"

    # --- Profile KYC docs ---
    m_doc = _PROFILE_DOC_RE.match(rel)
    if m_doc:
        owner_id = int(m_doc.group(1))
        if privileged or admin.id == owner_id:
            return True, "ok"
        return False, "Access denied"

    # --- Profile photos (org directory: any logged-in user) ---
    base = rel.split("/")[-1]
    m_photo = _PROFILE_PHOTO_RE.match(base)
    if m_photo and "/" not in rel.rstrip(base).strip("/"):
        return True, "ok"
    if rel.startswith("profile/") and not m_doc:
        # other files under profile/
        return (True, "ok") if privileged else (False, "Access denied")

    # --- Expenses / policies / news-style public-ish company docs ---
    if rel.startswith("expenses/"):
        # Claimant path is hard to reverse from filename; allow privileged always,
        # and any authenticated user who already knows the path (managers open via UI).
        return True, "ok"

    if rel.startswith("policies/"):
        return True, "ok"

    # News feed attachments often stored as bare filename or news/...
    if rel.startswith("news/") or rel.startswith("news_feed/"):
        return True, "ok"

    # --- Sensitive HR-only ---
    if rel.startswith(("noc/", "noc_department/", "ex_employee_docs/")):
        return (True, "ok") if privileged else (False, "Access denied")

    if rel.startswith(("assessment_selfies/", "assessment_recordings/", "assessment/")):
        emp = (getattr(admin, "emp_type", None) or "").strip().lower()
        if emp in ("hr", "human resource", "admin") or privileged:
            return True, "ok"
        return False, "Access denied"

    # Query files should use /api/query/.../files — deny static fallback except privileged
    if rel.startswith("queries/"):
        return (True, "ok") if privileged else (False, "Access denied")

    # Unknown prefix: privileged only (same as Accounts /file/)
    if privileged:
        return True, "ok"
    # Bare filenames under uploads (legacy photos already handled; other bare files)
    if "/" not in rel:
        # Treat as potentially public org media for authenticated users (news images etc.)
        return True, "ok"
    return False, "Access denied"


def _sign_payload(rel: str, exp: int) -> str:
    msg = f"{normalize_upload_rel(rel)}|{exp}".encode("utf-8")
    return hmac.new(_secret().encode("utf-8"), msg, hashlib.sha256).hexdigest()


def make_signature(rel: str, exp: Optional[int] = None) -> Tuple[str, int]:
    rel = normalize_upload_rel(rel)
    if exp is None:
        exp = int(time.time()) + file_sign_ttl_seconds()
    return _sign_payload(rel, exp), exp


def verify_signature(rel: str, exp: str | int, sig: str) -> bool:
    try:
        exp_i = int(exp)
    except (TypeError, ValueError):
        return False
    if exp_i < int(time.time()):
        return False
    expected = _sign_payload(rel, exp_i)
    return hmac.compare_digest(expected, (sig or "").strip())


def build_signed_file_url(rel: str, ttl: Optional[int] = None, *, bucket: Optional[int] = None) -> str:
    """
    Relative URL usable in <img src> / <a href> without JWT header.
    Points at /api/files/signed/... so nginx can proxy API only.
    `bucket` (seconds) overrides how long the same URL is reused; only for immutable files.
    """
    rel = normalize_upload_rel(rel)
    if not rel:
        return ""
    if ttl is not None:
        exp = int(time.time()) + int(ttl)
    else:
        # Round expiry up to a bucket boundary so the same file yields the same URL for a few
        # minutes: browsers can cache the image and identical API bodies can return 304.
        # Validity is still at least the configured TTL (at most TTL + bucket).
        ttl = file_sign_ttl_seconds()
        if bucket is None:
            bucket = min(300, max(60, ttl // 4))
        bucket = max(60, int(bucket))
        exp = (int(time.time()) // bucket + 1) * bucket + ttl
    sig, exp = make_signature(rel, exp)
    # Encode path segments but keep slashes
    encoded = "/".join(quote(p, safe="") for p in rel.split("/"))
    return f"/api/files/signed/{encoded}?exp={exp}&sig={sig}"


def build_auth_file_url(rel: str) -> str:
    """JWT-bearing fetch URL (frontend adds Authorization)."""
    rel = normalize_upload_rel(rel)
    if not rel:
        return ""
    encoded = "/".join(quote(p, safe="") for p in rel.split("/"))
    return f"/api/files/content/{encoded}"


def secure_public_url_for_upload(rel_or_url: str) -> str:
    """
    Convert a stored path or legacy /static/uploads/... URL into a signed URL.
    Safe to embed in JSON API responses for photos and displayable media.
    """
    rel = normalize_upload_rel(rel_or_url)
    if not rel:
        return ""
    return build_signed_file_url(rel)


def guess_mimetype(abs_path: str) -> str:
    mt, _ = mimetypes.guess_type(abs_path)
    return mt or "application/octet-stream"


def send_resolved_upload(rel: str, as_attachment: bool = False):
    abs_path = resolve_upload_abs_path(rel)
    if not abs_path:
        return jsonify({"success": False, "message": "File not found"}), 404

    name = os.path.basename(abs_path)
    # PDF watermark when available (best effort)
    try:
        from .pdf_watermark import is_pdf_filename, send_download_file

        if is_pdf_filename(name):
            return send_download_file(
                path=abs_path,
                download_name=name,
                as_attachment=as_attachment,
            )
    except Exception:
        current_app.logger.exception("Watermark serve failed for %s; raw fallback", abs_path)

    return send_file(
        abs_path,
        mimetype=guess_mimetype(abs_path),
        as_attachment=as_attachment,
        download_name=name,
        conditional=True,
    )


def serve_upload_with_request_auth(rel: str):
    """
    Serve upload if request has valid signature OR valid JWT with authorization.
    Used by /api/files/* and protected /static/uploads/*.
    """
    rel = normalize_upload_rel(rel)
    if not rel:
        return jsonify({"success": False, "message": "Invalid file path"}), 400

    exp = request.args.get("exp")
    sig = request.args.get("sig")
    if exp and sig and verify_signature(rel, exp, sig):
        return send_resolved_upload(rel)

    admin, claims, err = _admin_from_jwt()
    if err:
        # Soft message for browsers hitting static URL without login
        return err
    ok, reason = authorize_upload_access(admin, rel, claims)
    if not ok:
        return jsonify({"success": False, "message": reason or "Access denied"}), 403
    return send_resolved_upload(rel)
