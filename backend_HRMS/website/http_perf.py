"""Transport-level speedups for JSON API responses (no change to response content).

- ETag + conditional GET: when a JSON body is unchanged since the browser last fetched it,
  respond 304 with no body; the browser reuses its cached copy transparently (fetch/XHR
  still see a normal 200 with the same JSON).
- gzip: compress JSON bodies when the client accepts it.

Streaming (SSE), file downloads and non-JSON responses are left untouched.
Disable either feature without a deploy rollback: HTTP_ETAG=0 / HTTP_GZIP=0.
"""
from __future__ import annotations

import gzip
import os

from flask import request

_MIN_GZIP_BYTES = 1024
# Large bodies (base64 photos) compress poorly; use the cheapest level to save CPU.
_FAST_GZIP_ABOVE_BYTES = 1024 * 1024


def _env_on(name: str, default: str = "1") -> bool:
    return (os.getenv(name, default) or "").strip().lower() in ("1", "true", "yes", "on")


def _is_plain_json(response) -> bool:
    return (
        response.mimetype == "application/json"
        and not response.direct_passthrough
        and not response.is_streamed
        and "Content-Encoding" not in response.headers
    )


def _apply_etag(response):
    if request.method not in ("GET", "HEAD") or response.status_code != 200:
        return response
    if "ETag" not in response.headers:
        response.add_etag(weak=True)
    if "Cache-Control" not in response.headers:
        # Browser may store, but must revalidate with the server (JWT is checked every time).
        response.headers["Cache-Control"] = "private, no-cache"
    vary = response.headers.get("Vary", "")
    if "authorization" not in vary.lower():
        response.headers["Vary"] = f"{vary}, Authorization" if vary else "Authorization"
    return response.make_conditional(request)


def _apply_gzip(response):
    if response.status_code < 200 or response.status_code == 204 or response.status_code == 304:
        return response
    if "gzip" not in (request.headers.get("Accept-Encoding") or "").lower():
        return response
    data = response.get_data()
    if len(data) < _MIN_GZIP_BYTES:
        return response
    level = 1 if len(data) > _FAST_GZIP_ABOVE_BYTES else 5
    compressed = gzip.compress(data, compresslevel=level, mtime=0)
    if len(compressed) >= len(data):
        return response
    response.set_data(compressed)
    response.headers["Content-Encoding"] = "gzip"
    response.headers["Content-Length"] = str(len(compressed))
    vary = response.headers.get("Vary", "")
    if "accept-encoding" not in vary.lower():
        response.headers["Vary"] = f"{vary}, Accept-Encoding" if vary else "Accept-Encoding"
    return response


def init_http_perf(app) -> None:
    etag_on = _env_on("HTTP_ETAG")
    gzip_on = _env_on("HTTP_GZIP")
    if not (etag_on or gzip_on):
        return

    @app.after_request
    def _json_transport_perf(response):
        try:
            if not _is_plain_json(response):
                return response
            if etag_on:
                response = _apply_etag(response)
            if gzip_on:
                response = _apply_gzip(response)
        except Exception:
            app.logger.exception("http_perf: skipped optimisation for %s", request.path)
        return response
