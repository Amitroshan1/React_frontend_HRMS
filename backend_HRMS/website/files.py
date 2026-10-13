"""Authenticated / signed file download API."""

import time

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required, get_jwt

from .models.Admin_models import Admin
from .secure_file_service import (
    authorize_upload_access,
    build_signed_file_url,
    normalize_upload_rel,
    send_resolved_upload,
    verify_signature,
)

files_bp = Blueprint("files", __name__)


def _current_admin():
    claims = get_jwt() or {}
    email = (claims.get("email") or "").strip()
    if email:
        admin = Admin.query.filter_by(email=email).first()
        if admin:
            return admin, claims
    try:
        from flask_jwt_extended import get_jwt_identity

        return Admin.query.get(int(get_jwt_identity())), claims
    except Exception:
        return None, claims


@files_bp.route("/signed/<path:relative_path>", methods=["GET"])
def serve_signed_file(relative_path):
    """
    Short-lived HMAC URL for <img src> / email links (no Authorization header).
    Query: exp=<unix>&sig=<hex>
    """
    rel = normalize_upload_rel(relative_path)
    exp = request.args.get("exp")
    sig = request.args.get("sig")
    if not exp or not sig or not verify_signature(rel, exp, sig):
        return jsonify({"success": False, "message": "Invalid or expired file link"}), 401
    response = send_resolved_upload(rel)
    if rel.startswith("it_media/") and getattr(response, "status_code", None) in (200, 304):
        # IT media files are immutable (random name per upload): let the browser reuse them
        # for as long as this signed URL is valid instead of re-downloading every page view.
        max_age = max(0, min(int(exp) - int(time.time()), 86400))
        response.headers["Cache-Control"] = f"private, max-age={max_age}, immutable"
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@files_bp.route("/content/<path:relative_path>", methods=["GET"])
@jwt_required()
def serve_content_file(relative_path):
    """JWT download — same auth rules as Accounts /file/ for payslips etc."""
    admin, claims = _current_admin()
    if not admin:
        return jsonify({"success": False, "message": "Unauthorized user"}), 401

    rel = normalize_upload_rel(relative_path)

    # Sensitive OTP for own payslip/form16/tax (parity with Accounts.serve_uploaded_file)
    if rel.startswith(("payslips/", "form16/", "tax_declarations/")):
        from .sensitive_data_auth import require_sensitive_for_employee
        from .models.news_feed import PaySlip, Form16

        target_id = admin.id
        if rel.startswith("payslips/"):
            row = PaySlip.query.filter_by(file_path=rel).first()
            if row:
                target_id = row.admin_id
        elif rel.startswith("form16/"):
            row = Form16.query.filter_by(file_path=rel).first()
            if row:
                target_id = row.admin_id
        elif rel.startswith("tax_declarations/"):
            parts = rel.split("/")
            if len(parts) >= 2 and parts[1].isdigit():
                target_id = None
                from .models.employee_tax_declaration import EmployeeTaxDeclaration

                decl = EmployeeTaxDeclaration.query.get(int(parts[1]))
                if decl:
                    target_id = decl.admin_id
        if target_id is not None:
            blocked = require_sensitive_for_employee(admin, target_id)
            if blocked:
                return blocked

    ok, reason = authorize_upload_access(admin, rel, claims)
    if not ok:
        return jsonify({"success": False, "message": reason or "Access denied"}), 403
    return send_resolved_upload(rel)


@files_bp.route("/sign", methods=["POST"])
@jwt_required()
def mint_signed_url():
    """Mint a signed URL for a path the caller is allowed to access."""
    admin, claims = _current_admin()
    if not admin:
        return jsonify({"success": False, "message": "Unauthorized user"}), 401
    data = request.get_json(silent=True) or {}
    rel = normalize_upload_rel(data.get("path") or data.get("file_path") or "")
    if not rel:
        return jsonify({"success": False, "message": "path is required"}), 400
    ok, reason = authorize_upload_access(admin, rel, claims)
    if not ok:
        return jsonify({"success": False, "message": reason or "Access denied"}), 403
    ttl = data.get("ttl")
    try:
        ttl_i = int(ttl) if ttl is not None else None
    except (TypeError, ValueError):
        ttl_i = None
    url = build_signed_file_url(rel, ttl=ttl_i)
    return jsonify({"success": True, "url": url, "path": rel}), 200


@files_bp.route("/resolve", methods=["GET"])
@jwt_required()
def resolve_legacy_static_path():
    """
    Convert legacy /static/uploads/... to a signed URL for the current user.
    Helps frontends that still hold old paths.
    """
    admin, claims = _current_admin()
    if not admin:
        return jsonify({"success": False, "message": "Unauthorized user"}), 401
    raw = (request.args.get("path") or "").strip()
    rel = normalize_upload_rel(raw)
    if not rel:
        return jsonify({"success": False, "message": "path is required"}), 400
    ok, reason = authorize_upload_access(admin, rel, claims)
    if not ok:
        return jsonify({"success": False, "message": reason or "Access denied"}), 403
    return jsonify({"success": True, "url": build_signed_file_url(rel), "path": rel}), 200
