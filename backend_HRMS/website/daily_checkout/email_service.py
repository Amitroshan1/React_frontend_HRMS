"""Day-use email sending via Zepto outbox rows."""

from __future__ import annotations

from datetime import timezone
from html import escape

from flask import current_app

from ..datetime_utils import IST, utc_now
from ..email import send_email_via_zeptomail
from ..manager_utils import get_manager_emails, resolve_manager_contact_for_employee
from ..models.Admin_models import Admin
from ..models.daily_checkout import DailyCheckoutOutbox, DailyCheckoutRequest
from .service import _add_event


def _manager_emails(row):
    """Requester's current L1/L2/L3; falls back to the snapshot taken when the request was raised."""
    requester = Admin.query.get(row.requester_admin_id) if row.requester_admin_id else None
    if requester:
        contact = resolve_manager_contact_for_employee(requester)
        if contact:
            current = get_manager_emails(contact, exclude_email=requester.email)
            if current:
                return current
    return [e for e in (row.manager_emails_snapshot or []) if e]


def _cc_list(to_email, *groups):
    seen = {(to_email or "").strip().lower()}
    out = []
    for group in groups:
        for email in group:
            key = (email or "").strip().lower()
            if key and key not in seen:
                seen.add(key)
                out.append(email.strip())
    return out


def _fmt_ist(dt):
    if not dt:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST).strftime("%d %b %Y, %I:%M %p IST")


def _render(greeting, intro, details, action=None, note=None):
    rows = "".join(
        f'<tr><td style="padding:6px 14px;color:#64748b;white-space:nowrap">{escape(label)}</td>'
        f'<td style="padding:6px 14px;color:#0f172a"><strong>{escape(str(value))}</strong></td></tr>'
        for label, value in details
        if value not in (None, "")
    )
    action_html = f"<p>{action}</p>" if action else ""
    note_html = f'<p style="color:#475569">{note}</p>' if note else ""
    return (
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">'
        f"<p>{greeting}</p>"
        f"<p>{intro}</p>"
        '<table style="border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;margin:12px 0">'
        f"{rows}</table>"
        f"{action_html}{note_html}"
        "<p>Regards,<br/>IT Asset Management Team</p>"
        '<p style="font-size:12px;color:#94a3b8">This is an automated message from Day-use Assets. '
        "Please do not reply to this email.</p>"
        "</div>"
    )


def send_outbox_row(item: DailyCheckoutOutbox):
    row = DailyCheckoutRequest.query.get(item.request_id)
    item.attempts = int(item.attempts or 0) + 1
    if not row:
        item.status = "failed"
        item.last_error = "Request missing"
        return

    employee = (row.requester_email_snapshot or "").strip()
    managers = _manager_emails(row)
    it_mailbox = (
        current_app.config.get("ZEPTO_CC_IT") or current_app.config.get("EMAIL_IT") or ""
    ).strip()
    sender = current_app.config.get("ZEPTO_SENDER_EMAIL")
    payload = item.payload_json or {}
    code = row.request_code
    items_summary = payload.get("items_summary") or row.requested_hw_type
    name = row.requester_name_snapshot or "Employee"
    emp_label = f"{name} ({row.requester_emp_id_snapshot})" if row.requester_emp_id_snapshot else name
    safe_name = escape(name)
    safe_code = escape(code or "")
    base_details = [
        ("Request ID", code),
        ("Employee", emp_label),
        ("Department", row.requester_dept_snapshot),
    ]
    expected = _fmt_ist(row.expected_return_at)
    event = item.event_code

    if event == "REQUEST_CREATED":
        to_email = it_mailbox or employee
        cc = _cc_list(to_email, [employee], managers)
        subject = f"Day-use Asset Request {code} – {name}"
        body = _render(
            "Dear IT Team,",
            f"A new day-use asset request has been raised by <strong>{safe_name}</strong> and is awaiting your review.",
            base_details + [("Items requested", items_summary), ("Expected return", expected)],
            action="Please review and approve or reject the request from the IT Day-use Assets inbox.",
            note="The employee's reporting managers are copied on this email for their information.",
        )
    elif event == "REJECTED":
        to_email = employee
        cc = _cc_list(to_email, managers, [it_mailbox])
        reason = (row.rejection_reason or payload.get("reason") or "").strip()
        subject = f"Day-use Asset Request {code} – Not Approved"
        body = _render(
            f"Dear {safe_name},",
            f"We regret to inform you that your day-use asset request <strong>{safe_code}</strong> could not be approved.",
            base_details + [("Items requested", items_summary), ("Reason", reason or "Not specified")],
            action="If you still require the asset, please raise a new request or contact the IT team.",
        )
    elif event == "ASSIGNED":
        to_email = employee
        cc = _cc_list(to_email, managers, [it_mailbox])
        asset = payload.get("asset_name") or row.requested_hw_type
        subject = f"Day-use Asset Assigned – {code}"
        body = _render(
            f"Dear {safe_name},",
            f"Your day-use asset request <strong>{safe_code}</strong> has been approved and the asset(s) below have been assigned to you.",
            base_details + [("Asset(s) assigned", asset), ("Expected return", expected)],
            action=(
                "Please collect the device(s) from the IT team, then open <strong>Day-use Assets</strong> "
                "and click <strong>Acknowledge</strong> to download your Acceptance PDF."
            ),
            note="Kindly handle the asset with care and return it by the expected return time.",
        )
    elif event == "RETURN_REQUESTED":
        to_email = it_mailbox or employee
        cc = _cc_list(to_email, [employee], managers)
        subject = f"Day-use Asset Return Initiated – {code}"
        body = _render(
            "Dear IT Team,",
            f"<strong>{safe_name}</strong> has initiated the return of the day-use asset(s) under request <strong>{safe_code}</strong>.",
            base_details + [("Items", items_summary), ("Expected return", expected)],
            action="Please inspect the device(s) and confirm the return in the IT Day-use Assets inbox.",
        )
    elif event == "RETURNED":
        to_email = employee
        cc = _cc_list(to_email, managers, [it_mailbox])
        subject = f"Day-use Asset Returned – {code}"
        body = _render(
            f"Dear {safe_name},",
            f"This is to confirm that the IT team has received the day-use asset(s) under request <strong>{safe_code}</strong>.",
            base_details + [("Items", items_summary)],
            note="No further action is required from you. Thank you for returning the asset.",
        )
    elif event == "OVERDUE":
        to_email = employee
        cc = _cc_list(to_email, managers, [it_mailbox])
        subject = f"Reminder: Day-use Asset Overdue – {code}"
        body = _render(
            f"Dear {safe_name},",
            f"Our records show that the day-use asset(s) under request <strong>{safe_code}</strong> were due for return and have not yet been received.",
            base_details + [("Items", items_summary), ("Was due on", expected)],
            action="Please return the asset(s) to the IT team <strong>today</strong>, or contact IT if you need an extension.",
        )
    else:
        item.status = "failed"
        item.last_error = f"Unknown event {event}"
        return

    if not to_email:
        item.status = "failed"
        item.last_error = "No recipient"
        return

    ok, msg = send_email_via_zeptomail(
        sender_email=sender,
        subject=subject,
        body=body,
        recipient_email=to_email,
        cc_emails=cc or None,
        from_name="Day-use Assets",
    )
    if ok:
        item.status = "sent"
        item.sent_at = utc_now()
        item.last_error = None
        _add_event(row.id, "EMAIL_SENT", role="system", payload={"event_code": event, "to": to_email, "cc": cc})
    else:
        item.status = "failed" if item.attempts >= 5 else "pending"
        item.last_error = str(msg)[:500]
        current_app.logger.warning("Day-use email failed %s %s: %s", code, event, msg)
