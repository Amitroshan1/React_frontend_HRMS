"""Resolve profile photo URL for an Admin from linked Employee.photo_filename."""

from .models.emp_detail_models import Employee
from .secure_file_service import secure_public_url_for_upload


def photo_url_for_admin_id(admin_id):
    if not admin_id:
        return ""
    emp = Employee.query.filter_by(admin_id=admin_id).first()
    if not emp:
        return ""
    photo_fn = (getattr(emp, "photo_filename", None) or "").strip()
    if not photo_fn:
        return ""
    # Signed URL — works in <img src> without exposing bare /static/uploads/
    return secure_public_url_for_upload(photo_fn)


def photo_url_for_admin(admin):
    if not admin:
        return ""
    return photo_url_for_admin_id(getattr(admin, "id", None))


def photo_urls_for_admin_ids(admin_ids):
    """Batch variant of photo_url_for_admin_id: {admin_id: url} using one query.

    Admin ids without an Employee row or photo map to "" (same as the single lookup).
    """
    ids = {int(i) for i in (admin_ids or []) if i}
    if not ids:
        return {}
    rows = (
        Employee.query.with_entities(Employee.id, Employee.admin_id, Employee.photo_filename)
        .filter(Employee.admin_id.in_(ids))
        .order_by(Employee.id.asc())
        .all()
    )
    out = {i: "" for i in ids}
    seen = set()
    for _emp_id, admin_id, photo_fn in rows:
        # Match .first() semantics of the single lookup: first Employee row per admin wins.
        if admin_id in seen:
            continue
        seen.add(admin_id)
        fn = (photo_fn or "").strip()
        out[int(admin_id)] = secure_public_url_for_upload(fn) if fn else ""
    return out
