"""Day-use Assets business logic. Does not call long-term assignment APIs."""

from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, time, timedelta, timezone

from flask import current_app
from sqlalchemy.exc import IntegrityError

from .. import db
from ..datetime_utils import IST, isoformat_api, utc_now
from ..manager_utils import get_manager_emails, resolve_manager_contact_for_employee
from ..models.Admin_models import Admin
from ..models.daily_checkout import (
    DailyCheckoutAssignment,
    DailyCheckoutDocument,
    DailyCheckoutEvent,
    DailyCheckoutOutbox,
    DailyCheckoutRequest,
    DailyCheckoutReturn,
    DailyEmployeeOpenHold,
    DailyUnitHold,
    EmployeeSignature,
)
from ..models.it_models import ITAssetUnit
from ..models.notification import Notification
from ..plan_features import is_inventory_department, is_it_department
from .state import (
    DEFAULT_HW_TYPES,
    IT_COMPLETE_RETURN_FROM,
    OPEN_STATUSES,
    can_employee_cancel,
    can_employee_request_return,
    can_transition,
)

STATUS_DAILY_OUT = "daily_out"
DOC_ACCEPTANCE = "acceptance"
DOC_RETURN = "return_ack"


class DailyCheckoutError(Exception):
    def __init__(self, message, code=400):
        super().__init__(message)
        self.message = message
        self.code = code


def _uploads_root():
    root = (current_app.config.get("UPLOADS_ROOT") or "").strip()
    if root:
        return root
    return os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", "uploads")


def default_expected_return_utc(now_utc=None):
    """Same IST calendar day; default hour from config; if already past, 23:59 IST."""
    raw = now_utc or utc_now()
    if raw.tzinfo is None:
        aware = raw.replace(tzinfo=timezone.utc)
    else:
        aware = raw.astimezone(timezone.utc)
    ist = aware.astimezone(IST)
    try:
        hour = int(current_app.config.get("DAILY_CHECKOUT_RETURN_HOUR") or 18)
    except (TypeError, ValueError):
        hour = 18
    try:
        minute = int(current_app.config.get("DAILY_CHECKOUT_RETURN_MINUTE") or 0)
    except (TypeError, ValueError):
        minute = 0
    hour = min(23, max(0, hour))
    minute = min(59, max(0, minute))
    local_end = datetime.combine(ist.date(), time(hour, minute), tzinfo=IST)
    if ist >= local_end:
        local_end = datetime.combine(ist.date(), time(23, 59), tzinfo=IST)
    return local_end.astimezone(timezone.utc).replace(tzinfo=None)


def parse_expected_return_at(raw, *, now_utc=None):
    """
    Parse employee-chosen return datetime.
    Accepts ISO strings; naive values are treated as IST wall-clock.
    Must be after now and within 30 IST days.
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    if isinstance(raw, datetime):
        dt = raw
    else:
        text = str(raw).strip().replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(text)
        except ValueError as exc:
            raise DailyCheckoutError("Invalid expected return date/time") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)
    else:
        dt = dt.astimezone(IST)

    now = now_utc or utc_now()
    if now.tzinfo is None:
        now_aware = now.replace(tzinfo=timezone.utc)
    else:
        now_aware = now.astimezone(timezone.utc)
    now_ist = now_aware.astimezone(IST)

    if dt <= now_ist:
        raise DailyCheckoutError("Expected return must be in the future")
    max_dt = now_ist + timedelta(days=30)
    if dt > max_dt:
        raise DailyCheckoutError("Expected return cannot be more than 30 days from now")
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def current_signature(admin_id):
    return (
        EmployeeSignature.query.filter_by(admin_id=admin_id, is_current=True)
        .order_by(EmployeeSignature.version.desc())
        .first()
    )


def _add_event(request_id, event_code, *, actor=None, role=None, from_status=None, to_status=None, payload=None):
    db.session.add(
        DailyCheckoutEvent(
            request_id=request_id,
            event_code=event_code,
            actor_admin_id=actor.id if actor else None,
            actor_role=role,
            from_status=from_status,
            to_status=to_status,
            payload_json=payload,
            occurred_at=utc_now(),
        )
    )


def _enqueue_email(request_row, event_code, payload):
    dedupe = f"{request_row.id}:{event_code}:email"
    existing = DailyCheckoutOutbox.query.filter_by(dedupe_key=dedupe).first()
    if existing:
        return
    db.session.add(
        DailyCheckoutOutbox(
            request_id=request_row.id,
            event_code=event_code,
            channel="email",
            dedupe_key=dedupe,
            status="pending",
            payload_json=payload,
        )
    )
    _add_event(
        request_row.id,
        "EMAIL_ENQUEUED",
        role="system",
        payload={"event_code": event_code, "dedupe_key": dedupe},
    )


def _it_staff_admins():
    rows = Admin.query.filter(
        db.or_(Admin.is_exited == False, Admin.is_exited.is_(None))  # noqa: E712
    ).all()
    out = []
    for a in rows:
        et = (a.emp_type or "").strip()
        if is_it_department(et) or is_inventory_department(et):
            out.append(a)
    return out


def notify_it_staff(title, body, entity_id):
    for admin in _it_staff_admins():
        db.session.add(
            Notification(
                recipient_admin_id=admin.id,
                notif_type="daily_checkout",
                title=title,
                body=body,
                entity_type="daily_checkout",
                entity_id=entity_id,
            )
        )


def snapshot_managers(admin):
    contact = resolve_manager_contact_for_employee(admin)
    emails = get_manager_emails(contact, exclude_email=admin.email) if contact else []
    ids = []
    if contact:
        for attr in ("l1_admin_id", "l2_admin_id", "l3_admin_id"):
            val = getattr(contact, attr, None)
            if val:
                ids.append(int(val))
    return ids, emails


def _next_request_code():
    day = datetime.now(IST).strftime("%Y%m%d")
    prefix = f"DC-{day}-"
    last = (
        DailyCheckoutRequest.query.filter(DailyCheckoutRequest.request_code.like(f"{prefix}%"))
        .order_by(DailyCheckoutRequest.id.desc())
        .first()
    )
    n = 1
    if last and last.request_code:
        try:
            n = int(last.request_code.rsplit("-", 1)[-1]) + 1
        except ValueError:
            n = 1
    return f"{prefix}{n:04d}"


def serialize_signature(sig):
    if not sig:
        return None
    return {
        "id": sig.id,
        "version": sig.version,
        "file_path": sig.file_path,
        "uploaded_at": isoformat_api(sig.uploaded_at),
        "is_current": bool(sig.is_current),
    }


def serialize_request(row, *, include_events=False):
    assignment = row.assignment
    ret = row.return_row
    docs = {d.doc_type: d for d in (row.documents or [])}
    items = _normalize_items(getattr(row, "items_json", None), fallback_hw=row.requested_hw_type)
    payload = {
        "id": row.id,
        "request_code": row.request_code,
        "status": row.status,
        "requested_category": row.requested_category,
        "requested_hw_type": row.requested_hw_type,
        "requested_notes": row.requested_notes,
        "items": items,
        "items_summary": _items_summary(items),
        "expected_return_at": isoformat_api(row.expected_return_at),
        "rejection_reason": row.rejection_reason,
        "cancelled_reason": row.cancelled_reason,
        "requester_admin_id": row.requester_admin_id,
        "requester_emp_id": row.requester_emp_id_snapshot,
        "requester_name": row.requester_name_snapshot,
        "requester_email": row.requester_email_snapshot,
        "requester_dept": row.requester_dept_snapshot,
        "requester_circle": row.requester_circle_snapshot,
        "manager_emails": row.manager_emails_snapshot or [],
        "created_at": isoformat_api(row.created_at),
        "updated_at": isoformat_api(row.updated_at),
        "overdue_notified_at": isoformat_api(row.overdue_notified_at),
        "assignment": None,
        "return": None,
        "documents": {
            "acceptance": bool(docs.get(DOC_ACCEPTANCE)),
            "return_ack": bool(docs.get(DOC_RETURN)),
        },
    }
    if assignment:
        fulfillment = getattr(assignment, "fulfillment_json", None) or {}
        payload["assignment"] = {
            "asset_unit_id": assignment.asset_unit_id,
            "unit_code": assignment.unit_code_snapshot,
            "serial": assignment.serial_snapshot,
            "brand": assignment.brand_snapshot,
            "model": assignment.model_snapshot,
            "asset_name": assignment.asset_name_snapshot,
            "assigned_by_admin_id": assignment.assigned_by_admin_id,
            "assigned_at": isoformat_api(assignment.assigned_at),
            "expected_return_at": isoformat_api(assignment.expected_return_at),
            "fulfillment": fulfillment,
            "accessory_comments": fulfillment.get("accessories") if isinstance(fulfillment, dict) else [],
            "devices": fulfillment.get("devices") if isinstance(fulfillment, dict) else [],
            "device_remarks": fulfillment.get("device_remarks") if isinstance(fulfillment, dict) else None,
        }
    if ret:
        payload["return"] = {
            "initiated_at": isoformat_api(ret.initiated_at),
            "received_at": isoformat_api(ret.received_at),
            "condition_in": ret.condition_in,
            "remarks": ret.remarks,
            "walk_up": bool(ret.walk_up),
            "completed_at": isoformat_api(ret.completed_at),
        }
    if include_events:
        payload["events"] = [
            {
                "id": e.id,
                "event_code": e.event_code,
                "actor_admin_id": e.actor_admin_id,
                "actor_role": e.actor_role,
                "from_status": e.from_status,
                "to_status": e.to_status,
                "payload": e.payload_json,
                "occurred_at": isoformat_api(e.occurred_at),
            }
            for e in (row.events or [])
        ]
    return payload


def _parse_quantity(raw, *, default=1, max_qty=50):
    try:
        qty = int(raw)
    except (TypeError, ValueError):
        qty = default
    return max(1, min(max_qty, qty))


def _normalize_items(raw_items, *, fallback_hw=None):
    """Return a clean list of device/accessory line items."""
    items = []
    if isinstance(raw_items, list):
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            line_type = (raw.get("line_type") or raw.get("type") or "device").strip().lower()
            qty = _parse_quantity(raw.get("quantity") or raw.get("qty") or 1)
            if line_type == "accessory":
                desc = (raw.get("description") or raw.get("label") or raw.get("name") or "").strip()
                if not desc:
                    continue
                items.append({
                    "line_type": "accessory",
                    "description": desc[:200],
                    "quantity": qty,
                })
            else:
                hw = (raw.get("hw_type") or raw.get("requested_hw_type") or "").strip()
                if not hw:
                    continue
                items.append({
                    "line_type": "device",
                    "hw_type": hw[:40],
                    "quantity": qty,
                })
    if not items and fallback_hw:
        items.append({"line_type": "device", "hw_type": str(fallback_hw).strip()[:40], "quantity": 1})
    return items


def _items_summary(items):
    parts = []
    for it in items or []:
        if it.get("line_type") == "accessory":
            parts.append(f"{it.get('description') or 'Accessory'} ×{it.get('quantity') or 1}")
        else:
            parts.append(f"{it.get('hw_type') or 'Device'} ×{it.get('quantity') or 1}")
    return ", ".join(parts) if parts else ""


def _primary_hw_type(items):
    for it in items or []:
        if it.get("line_type") == "device" and it.get("hw_type"):
            return it["hw_type"]
    return "Hardware"


def upload_signature(admin, file_storage):
    if not file_storage or not file_storage.filename:
        raise DailyCheckoutError("Signature file is required")
    filename = (file_storage.filename or "").lower()
    if not filename.endswith((".png", ".jpg", ".jpeg")):
        raise DailyCheckoutError("Signature must be a PNG or JPG image")
    data = file_storage.read()
    if not data:
        raise DailyCheckoutError("Signature file is empty")
    if len(data) > 2 * 1024 * 1024:
        raise DailyCheckoutError("Signature must be 2 MB or smaller")
    content_type = "image/png" if filename.endswith(".png") else "image/jpeg"
    last = (
        EmployeeSignature.query.filter_by(admin_id=admin.id)
        .order_by(EmployeeSignature.version.desc())
        .first()
    )
    version = (last.version + 1) if last else 1
    EmployeeSignature.query.filter_by(admin_id=admin.id, is_current=True).update(
        {"is_current": False}, synchronize_session=False
    )
    ext = "png" if content_type == "image/png" else "jpg"
    rel = f"signatures/{admin.id}/v{version}.{ext}"
    abs_dir = os.path.join(_uploads_root(), "signatures", str(admin.id))
    os.makedirs(abs_dir, exist_ok=True)
    abs_path = os.path.join(_uploads_root(), rel.replace("/", os.sep))
    with open(abs_path, "wb") as fh:
        fh.write(data)
    row = EmployeeSignature(
        admin_id=admin.id,
        version=version,
        file_path=rel.replace("\\", "/"),
        content_type=content_type,
        sha256=hashlib.sha256(data).hexdigest(),
        is_current=True,
        uploaded_by_admin_id=admin.id,
    )
    db.session.add(row)
    db.session.commit()
    return row


def create_request(admin, *, hw_type=None, notes=None, items=None, expected_return_at=None):
    sig = current_signature(admin.id)
    if not sig:
        raise DailyCheckoutError("Upload your signature before creating a request", 403)

    # Prefer multi-item payload; fall back to legacy single hw_type.
    raw_items = items
    if raw_items is None and hw_type:
        raw_items = [{"line_type": "device", "hw_type": hw_type, "quantity": 1}]
    normalized = _normalize_items(raw_items, fallback_hw=hw_type)
    if not normalized:
        raise DailyCheckoutError("Add at least one device or accessory line")
    has_device = any(it.get("line_type") == "device" for it in normalized)
    if not has_device:
        raise DailyCheckoutError(f"Add at least one device ({', '.join(DEFAULT_HW_TYPES)})")
    allowed = {t.lower() for t in (hardware_types() or list(DEFAULT_HW_TYPES))}
    for it in normalized:
        if it.get("line_type") != "device":
            continue
        hw = (it.get("hw_type") or "").strip()
        if hw.lower() not in allowed:
            raise DailyCheckoutError(f"Unsupported device type: {hw}")

    notes = (notes or "").strip() or None
    if notes and len(notes) > 500:
        notes = notes[:500]

    primary_hw = _primary_hw_type(normalized)
    summary = _items_summary(normalized)

    expected = parse_expected_return_at(expected_return_at) if expected_return_at else None
    if expected is None:
        expected = default_expected_return_utc()

    mgr_ids, mgr_emails = snapshot_managers(admin)
    row = DailyCheckoutRequest(
        request_code=_next_request_code(),
        requester_admin_id=admin.id,
        requester_emp_id_snapshot=(admin.emp_id or "")[:20] or None,
        requester_name_snapshot=admin.first_name or admin.user_name,
        requester_email_snapshot=admin.email,
        requester_dept_snapshot=admin.emp_type,
        requester_circle_snapshot=admin.circle,
        manager_admin_ids_json=mgr_ids,
        manager_emails_snapshot=mgr_emails,
        requested_category="Hardware",
        requested_hw_type=primary_hw,
        requested_notes=notes,
        items_json=normalized,
        expected_return_at=expected,
        status="requested",
    )
    db.session.add(row)
    db.session.flush()

    # Parallel open requests are allowed — do not create DailyEmployeeOpenHold.

    _add_event(
        row.id,
        "REQUEST_CREATED",
        actor=admin,
        role="employee",
        to_status="requested",
        payload={"items": normalized, "items_summary": summary},
    )
    _enqueue_email(
        row,
        "REQUEST_CREATED",
        {"hw_type": primary_hw, "items_summary": summary, "request_code": row.request_code},
    )
    notify_it_staff(
        "Day-use request",
        f"{row.requester_name_snapshot or 'Employee'} requested {summary or primary_hw} ({row.request_code})",
        row.id,
    )
    db.session.commit()
    flush_outbox(request_id=row.id)
    return row


def _release_employee_hold(request_row):
    DailyEmployeeOpenHold.query.filter_by(request_id=request_row.id).delete(synchronize_session=False)


def _release_unit_hold(request_row):
    holds = DailyUnitHold.query.filter_by(request_id=request_row.id).all()
    if not holds:
        return
    from ..it import _recalc_inventory_counts

    touched_inventory = set()
    for hold in holds:
        unit = ITAssetUnit.query.get(hold.asset_unit_id)
        db.session.delete(hold)
        if unit and (unit.status or "").lower() == STATUS_DAILY_OUT:
            unit.status = "available"
            if unit.inventory_item_id:
                touched_inventory.add(unit.inventory_item_id)
    for inv_id in touched_inventory:
        _recalc_inventory_counts(inv_id)


def cancel_request(admin, request_id, reason=None):
    row = DailyCheckoutRequest.query.get(request_id)
    if not row:
        raise DailyCheckoutError("Request not found", 404)
    if int(row.requester_admin_id) != int(admin.id):
        raise DailyCheckoutError("You can only cancel your own request", 403)
    if not can_employee_cancel(row.status):
        raise DailyCheckoutError(
            "Once a device is assigned, this request cannot be cancelled. Please request a return instead."
        )
    prev = row.status
    if not can_transition(prev, "cancelled"):
        raise DailyCheckoutError("Invalid status transition")
    row.status = "cancelled"
    row.cancelled_reason = (reason or "").strip() or None
    _release_employee_hold(row)
    _add_event(row.id, "CANCELLED", actor=admin, role="employee", from_status=prev, to_status="cancelled")
    db.session.commit()
    return row


def approve_request(actor, request_id):
    row = DailyCheckoutRequest.query.get(request_id)
    if not row:
        raise DailyCheckoutError("Request not found", 404)
    if not can_transition(row.status, "approved"):
        raise DailyCheckoutError("Request cannot be approved in its current status")
    prev = row.status
    row.status = "approved"
    _add_event(row.id, "APPROVED", actor=actor, role="it", from_status=prev, to_status="approved")
    db.session.commit()
    return row


def reject_request(actor, request_id, reason):
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise DailyCheckoutError("Rejection reason is required")
    row = DailyCheckoutRequest.query.get(request_id)
    if not row:
        raise DailyCheckoutError("Request not found", 404)
    if not can_transition(row.status, "rejected"):
        raise DailyCheckoutError("Request cannot be rejected in its current status")
    prev = row.status
    row.status = "rejected"
    row.rejection_reason = reason
    _release_employee_hold(row)
    _add_event(
        row.id,
        "REJECTED",
        actor=actor,
        role="it",
        from_status=prev,
        to_status="rejected",
        payload={"reason": reason},
    )
    _enqueue_email(row, "REJECTED", {"reason": reason, "request_code": row.request_code})
    db.session.commit()
    flush_outbox(request_id=row.id)
    return row


def list_available_daily_units(hw_type=None, search=None):
    """Available hardware units from inventory management (same stock as IT inventory)."""
    q = ITAssetUnit.query.filter(db.func.lower(ITAssetUnit.status) == "available")
    # Match inventory hardware devices; exclude software seats (those live in licenses).
    q = q.filter(
        db.or_(
            ITAssetUnit.category.is_(None),
            ITAssetUnit.category == "",
            db.func.lower(ITAssetUnit.category) != "software",
        )
    )
    if hw_type:
        q = q.filter(db.func.lower(ITAssetUnit.hw_type) == hw_type.strip().lower())
    term = (search or "").strip()
    if term:
        like = f"%{term}%"
        q = q.filter(
            db.or_(
                ITAssetUnit.asset_name.ilike(like),
                ITAssetUnit.unit_code.ilike(like),
                ITAssetUnit.serial_number.ilike(like),
                ITAssetUnit.brand.ilike(like),
                ITAssetUnit.make.ilike(like),
                ITAssetUnit.model.ilike(like),
                ITAssetUnit.hw_type.ilike(like),
                ITAssetUnit.project_code.ilike(like),
                ITAssetUnit.imei1.ilike(like),
                ITAssetUnit.imei2.ilike(like),
                ITAssetUnit.asset_tag.ilike(like),
                ITAssetUnit.device_location.ilike(like),
            )
        )
    held_ids = [h.asset_unit_id for h in DailyUnitHold.query.all()]
    if held_ids:
        q = q.filter(~ITAssetUnit.id.in_(held_ids))
    return q.order_by(ITAssetUnit.hw_type.asc(), ITAssetUnit.asset_name.asc(), ITAssetUnit.id.asc()).all()


def _normalize_accessory_comments(raw_comments, request_items):
    items = [it for it in (request_items or []) if isinstance(it, dict)]
    accessories = [
        (idx, it)
        for idx, it in enumerate(items)
        if (it.get("line_type") or "").lower() == "accessory"
    ]
    by_index = {}
    by_desc = {}
    if isinstance(raw_comments, list):
        for raw in raw_comments:
            if not isinstance(raw, dict):
                continue
            comment = (raw.get("comment") or raw.get("notes") or "").strip()
            if not comment:
                continue
            comment = comment[:500]
            desc = (raw.get("description") or "").strip()
            entry = {"description": desc or None, "comment": comment, "quantity": raw.get("quantity")}
            idx = raw.get("line_index")
            if idx is not None:
                try:
                    by_index[int(idx)] = entry
                except (TypeError, ValueError):
                    pass
            if desc:
                by_desc[desc.lower()] = entry

    result = []
    for idx, acc in accessories:
        desc = (acc.get("description") or "").strip()
        matched = by_index.get(idx) or by_desc.get(desc.lower())
        result.append({
            "line_index": idx,
            "description": desc,
            "quantity": acc.get("quantity") or 1,
            "comment": (matched or {}).get("comment") or "",
        })
    return result


def _device_slots(request_items):
    """Expand device lines into assignable slots (one per quantity)."""
    slots = []
    for idx, it in enumerate(request_items or []):
        if not isinstance(it, dict):
            continue
        if (it.get("line_type") or "device").strip().lower() == "accessory":
            continue
        hw = (it.get("hw_type") or "").strip()
        if not hw:
            continue
        try:
            qty = int(it.get("quantity") or 1)
        except (TypeError, ValueError):
            qty = 1
        qty = max(1, min(50, qty))
        for slot in range(qty):
            slots.append({
                "line_index": idx,
                "slot": slot,
                "hw_type": hw,
                "key": f"{idx}:{slot}",
            })
    return slots


def _unit_snapshot(unit, *, line_index=None, slot=None, hw_type=None, remarks=None):
    return {
        "line_index": line_index,
        "slot": slot,
        "hw_type": hw_type or unit.hw_type,
        "asset_unit_id": unit.id,
        "unit_code": unit.unit_code,
        "asset_name": unit.asset_name,
        "serial": unit.serial_number,
        "brand": unit.brand,
        "make": unit.make,
        "model": unit.model,
        "project_code": unit.project_code,
        "imei1": unit.imei1,
        "imei2": unit.imei2,
        "remarks": (remarks or "").strip()[:500] or None,
    }


def assign_unit(
    actor,
    request_id,
    asset_unit_id=None,
    condition_out=None,
    accessory_comments=None,
    remarks=None,
    devices=None,
):
    row = DailyCheckoutRequest.query.get(request_id)
    if not row:
        raise DailyCheckoutError("Request not found", 404)
    if not can_transition(row.status, "assigned"):
        raise DailyCheckoutError("Approve the request before assigning a unit")

    items = _normalize_items(getattr(row, "items_json", None), fallback_hw=row.requested_hw_type)
    slots = _device_slots(items)
    if not slots:
        raise DailyCheckoutError("Request has no device lines to assign")

    # Normalize device assignments: prefer multi `devices`, else legacy single unit.
    raw_devices = devices if isinstance(devices, list) else None
    if not raw_devices and asset_unit_id:
        first = slots[0]
        raw_devices = [{
            "line_index": first["line_index"],
            "slot": first["slot"],
            "hw_type": first["hw_type"],
            "asset_unit_id": asset_unit_id,
            "remarks": remarks,
        }]
    if not raw_devices:
        raise DailyCheckoutError("Select a unit for each requested device")

    by_key = {}
    for raw in raw_devices:
        if not isinstance(raw, dict):
            continue
        try:
            line_index = int(raw.get("line_index"))
            slot = int(raw.get("slot") if raw.get("slot") is not None else 0)
            unit_id = int(raw.get("asset_unit_id") or raw.get("unit_id"))
        except (TypeError, ValueError):
            continue
        key = f"{line_index}:{slot}"
        by_key[key] = {
            "line_index": line_index,
            "slot": slot,
            "asset_unit_id": unit_id,
            "hw_type": (raw.get("hw_type") or "").strip() or None,
            "remarks": (raw.get("remarks") or raw.get("device_remarks") or "").strip() or None,
        }

    if len(slots) > 1 and len(by_key) < len(slots):
        missing = [s["hw_type"] for s in slots if s["key"] not in by_key]
        raise DailyCheckoutError(
            "Select a unit for each device: " + ", ".join(missing[:8])
        )
    if len(slots) == 1 and not by_key:
        raise DailyCheckoutError("Select an inventory unit to assign")

    # For single-slot legacy payloads that omit line_index, accept any single mapping.
    if len(slots) == 1 and len(by_key) == 1:
        only = next(iter(by_key.values()))
        by_key = {slots[0]["key"]: {**only, "line_index": slots[0]["line_index"], "slot": slots[0]["slot"]}}

    normalized_accessories = _normalize_accessory_comments(accessory_comments, items)
    for acc in normalized_accessories:
        if not (acc.get("comment") or "").strip():
            raise DailyCheckoutError(
                f"Add an IT comment for accessory: {acc.get('description') or 'Accessory'}"
            )

    shared_remarks = (remarks or condition_out or "").strip() or None
    if shared_remarks and len(shared_remarks) > 500:
        shared_remarks = shared_remarks[:500]

    unit_ids = []
    planned = []
    for slot in slots:
        entry = by_key.get(slot["key"])
        if not entry:
            raise DailyCheckoutError(f"Select a unit for {slot['hw_type']}")
        unit_ids.append(entry["asset_unit_id"])
        planned.append((slot, entry))

    if len(set(unit_ids)) != len(unit_ids):
        raise DailyCheckoutError("Each device slot must use a different inventory unit")

    locked_units = []
    for slot, entry in planned:
        unit = ITAssetUnit.query.get(entry["asset_unit_id"])
        if not unit:
            raise DailyCheckoutError(f"Asset unit not found for {slot['hw_type']}", 404)
        unit = ITAssetUnit.query.filter_by(id=unit.id).with_for_update().first()
        if (unit.status or "").lower() != "available":
            raise DailyCheckoutError(f"Unit for {slot['hw_type']} is not available")
        if (unit.category or "").strip().lower() == "software":
            raise DailyCheckoutError("Cannot assign software seats via Day-use")
        if DailyUnitHold.query.get(unit.id):
            raise DailyCheckoutError(f"Unit for {slot['hw_type']} is already on Day-use checkout", 409)
        want = (slot["hw_type"] or "").strip().lower()
        got = (unit.hw_type or "").strip().lower()
        if want and got and want != got:
            raise DailyCheckoutError(
                f"Selected unit type ({unit.hw_type}) does not match requested {slot['hw_type']}"
            )
        locked_units.append((slot, entry, unit))

    prev = row.status
    device_rows = []
    from ..it import _recalc_inventory_counts

    touched_inventory = set()
    try:
        for slot, entry, unit in locked_units:
            db.session.add(DailyUnitHold(asset_unit_id=unit.id, request_id=row.id, held_at=utc_now()))
            db.session.flush()
            rem = entry.get("remarks") or (shared_remarks if len(locked_units) == 1 else None)
            device_rows.append(
                _unit_snapshot(
                    unit,
                    line_index=slot["line_index"],
                    slot=slot["slot"],
                    hw_type=slot["hw_type"],
                    remarks=rem,
                )
            )
            unit.status = STATUS_DAILY_OUT
            if unit.inventory_item_id:
                touched_inventory.add(unit.inventory_item_id)
    except IntegrityError:
        db.session.rollback()
        raise DailyCheckoutError("One or more units are already on Day-use checkout", 409)

    for inv_id in touched_inventory:
        _recalc_inventory_counts(inv_id)

    primary = locked_units[0][2]
    fulfillment = {
        "devices": device_rows,
        "accessories": normalized_accessories,
        "device_remarks": shared_remarks if len(device_rows) == 1 else None,
    }

    assignment = DailyCheckoutAssignment(
        request_id=row.id,
        asset_unit_id=primary.id,
        unit_code_snapshot=primary.unit_code,
        serial_snapshot=primary.serial_number,
        brand_snapshot=primary.brand,
        model_snapshot=primary.model,
        asset_name_snapshot=primary.asset_name,
        assigned_by_admin_id=actor.id if actor else None,
        assigned_at=utc_now(),
        expected_return_at=row.expected_return_at,
        condition_out=(condition_out or "").strip()[:20] or None,
        fulfillment_json=fulfillment,
    )
    db.session.add(assignment)
    row.status = "assigned"
    _add_event(
        row.id,
        "ASSIGNED",
        actor=actor,
        role="it",
        from_status=prev,
        to_status="assigned",
        payload={
            "asset_unit_ids": [u.id for _, _, u in locked_units],
            "devices": device_rows,
            "accessories": normalized_accessories,
        },
    )
    names = ", ".join(
        filter(None, [(u.asset_name or u.hw_type or "unit") for _, _, u in locked_units])
    ) or primary.asset_name
    _enqueue_email(row, "ASSIGNED", {"request_code": row.request_code, "asset_name": names})
    db.session.commit()
    # Acceptance PDF is generated when employee/IT clicks Acknowledge — not auto on assign.
    flush_outbox(request_id=row.id)
    return DailyCheckoutRequest.query.get(row.id)


def acknowledge_acceptance(actor, request_id):
    """Generate (or return existing) Acceptance PDF after devices are assigned."""
    row = DailyCheckoutRequest.query.get(request_id)
    if not row:
        raise DailyCheckoutError("Request not found", 404)
    status = (row.status or "").strip().lower()
    if status not in ("assigned", "overdue", "return_requested", "returned"):
        raise DailyCheckoutError("Acknowledge is available only after devices are assigned")

    from .pdf_service import generate_document

    existing = DailyCheckoutDocument.query.filter_by(request_id=row.id, doc_type=DOC_ACCEPTANCE).first()
    created = not existing
    try:
        generate_document(row.id, DOC_ACCEPTANCE, actor=actor, force=True)
    except Exception as exc:
        raise DailyCheckoutError(f"Could not generate acceptance PDF: {exc}") from exc
    _add_event(
        row.id,
        "ACCEPTANCE_ACKNOWLEDGED" if created else "ACCEPTANCE_DOWNLOADED",
        actor=actor,
        role="it" if actor else "employee",
        payload={"request_code": row.request_code},
    )
    db.session.commit()

    row = DailyCheckoutRequest.query.get(request_id)
    return row, created


def request_return(admin, request_id):
    row = DailyCheckoutRequest.query.get(request_id)
    if not row:
        raise DailyCheckoutError("Request not found", 404)
    if int(row.requester_admin_id) != int(admin.id):
        raise DailyCheckoutError("You can only return your own Day-use asset", 403)
    if not can_employee_request_return(row.status):
        raise DailyCheckoutError("No assigned Day-use asset to return")
    prev = row.status
    if not can_transition(prev, "return_requested"):
        raise DailyCheckoutError("Invalid status transition")
    row.status = "return_requested"
    ret = row.return_row
    if not ret:
        ret = DailyCheckoutReturn(request_id=row.id)
        db.session.add(ret)
    ret.initiated_by_admin_id = admin.id
    ret.initiated_at = utc_now()
    ret.walk_up = False
    _add_event(
        row.id,
        "RETURN_REQUESTED",
        actor=admin,
        role="employee",
        from_status=prev,
        to_status="return_requested",
    )
    _enqueue_email(row, "RETURN_REQUESTED", {"request_code": row.request_code})
    notify_it_staff(
        "Day-use return",
        f"{row.requester_name_snapshot or 'Employee'} requested return of {row.request_code}",
        row.id,
    )
    db.session.commit()
    flush_outbox(request_id=row.id)
    return row


def complete_return(actor, request_id, *, condition_in=None, remarks=None, walk_up=False):
    row = DailyCheckoutRequest.query.get(request_id)
    if not row:
        raise DailyCheckoutError("Request not found", 404)
    if row.status not in IT_COMPLETE_RETURN_FROM:
        raise DailyCheckoutError("This request is not awaiting return")
    prev = row.status
    if not can_transition(prev, "returned"):
        raise DailyCheckoutError("Invalid status transition")
    row.status = "returned"
    ret = row.return_row
    if not ret:
        ret = DailyCheckoutReturn(request_id=row.id)
        db.session.add(ret)
    if walk_up:
        ret.walk_up = True
        if not ret.initiated_at:
            ret.initiated_at = utc_now()
            ret.initiated_by_admin_id = actor.id if actor else None
    ret.received_by_admin_id = actor.id if actor else None
    ret.received_at = utc_now()
    ret.completed_at = utc_now()
    ret.condition_in = (condition_in or "ok").strip()[:20]
    ret.remarks = (remarks or "").strip() or None
    _release_unit_hold(row)
    _release_employee_hold(row)
    _add_event(
        row.id,
        "RETURN_COMPLETED",
        actor=actor,
        role="it",
        from_status=prev,
        to_status="returned",
        payload={"walk_up": bool(walk_up), "condition_in": ret.condition_in},
    )
    _enqueue_email(row, "RETURNED", {"request_code": row.request_code, "walk_up": bool(walk_up)})
    db.session.commit()

    from .pdf_service import generate_document

    try:
        generate_document(row.id, DOC_RETURN, actor=actor)
    except Exception as exc:
        current_app.logger.warning("Day-use return PDF failed request_id=%s: %s", row.id, exc)
        db.session.commit()

    flush_outbox(request_id=row.id)
    return DailyCheckoutRequest.query.get(row.id)


def set_daily_pool(unit_id, enabled):
    unit = ITAssetUnit.query.get(int(unit_id))
    if not unit:
        raise DailyCheckoutError("Unit not found", 404)
    if (unit.category or "Hardware").strip().lower() != "hardware":
        raise DailyCheckoutError("Day-use pool is hardware-only")
    if DailyUnitHold.query.get(unit.id) and not enabled:
        raise DailyCheckoutError("Cannot remove a unit that is currently on Day-use")
    unit.is_daily_pool = bool(enabled)
    db.session.commit()
    return unit


def mark_overdue_and_notify():
    now = utc_now()
    rows = DailyCheckoutRequest.query.filter(
        DailyCheckoutRequest.status == "assigned",
        DailyCheckoutRequest.expected_return_at <= now,
    ).all()
    n = 0
    for row in rows:
        if not can_transition("assigned", "overdue"):
            continue
        row.status = "overdue"
        row.overdue_notified_at = now
        _add_event(row.id, "OVERDUE", role="system", from_status="assigned", to_status="overdue")
        _enqueue_email(row, "OVERDUE", {"request_code": row.request_code})
        notify_it_staff(
            "Day-use overdue",
            f"{row.request_code} is overdue for return",
            row.id,
        )
        n += 1
    if n:
        db.session.commit()
        flush_outbox()
    return n


def retry_pending_pdfs():
    from .pdf_service import generate_document

    assigned = DailyCheckoutRequest.query.filter(
        DailyCheckoutRequest.status.in_(["assigned", "overdue", "return_requested", "returned"])
    ).all()
    for row in assigned:
        types_needed = [DOC_ACCEPTANCE]
        if row.status == "returned":
            types_needed.append(DOC_RETURN)
        have = {d.doc_type for d in row.documents}
        for doc_type in types_needed:
            if doc_type in have:
                continue
            if doc_type == DOC_RETURN and row.status != "returned":
                continue
            try:
                generate_document(row.id, doc_type, actor=None)
            except Exception as exc:
                current_app.logger.warning("Day-use PDF retry failed %s %s: %s", row.id, doc_type, exc)


def flush_outbox(request_id=None):
    from .email_service import send_outbox_row

    q = DailyCheckoutOutbox.query.filter_by(status="pending")
    if request_id:
        q = q.filter_by(request_id=request_id)
    rows = q.order_by(DailyCheckoutOutbox.id.asc()).limit(50).all()
    for item in rows:
        send_outbox_row(item)
    db.session.commit()


def list_requests_for_employee(admin_id):
    return (
        DailyCheckoutRequest.query.filter_by(requester_admin_id=admin_id)
        .order_by(DailyCheckoutRequest.id.desc())
        .limit(50)
        .all()
    )


def list_inbox(status=None):
    q = DailyCheckoutRequest.query
    if status:
        q = q.filter(db.func.lower(DailyCheckoutRequest.status) == status.strip().lower())
    return q.order_by(DailyCheckoutRequest.created_at.desc(), DailyCheckoutRequest.id.desc()).limit(200).all()


def hardware_types():
    extra = (
        db.session.query(ITAssetUnit.hw_type)
        .filter(ITAssetUnit.is_daily_pool.is_(True), ITAssetUnit.hw_type.isnot(None))
        .distinct()
        .all()
    )
    found = list(DEFAULT_HW_TYPES)
    seen = {t.lower() for t in found}
    for (hw,) in extra:
        name = (hw or "").strip()
        if name and name.lower() not in seen:
            seen.add(name.lower())
            found.append(name)
    return found
