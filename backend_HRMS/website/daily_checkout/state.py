"""Day-use Assets state machine (no Flask)."""

from __future__ import annotations

OPEN_STATUSES = frozenset(
    {"requested", "approved", "assigned", "return_requested", "overdue"}
)
TERMINAL_STATUSES = frozenset({"rejected", "cancelled", "returned"})

# V1 hardware types (IT Assets catalog).
DEFAULT_HW_TYPES = ("Laptop", "Mobile", "Desktop", "Tablet", "Dashcam", "ODCP")

ALLOWED_TRANSITIONS = {
    "requested": frozenset({"approved", "rejected", "cancelled"}),
    "approved": frozenset({"assigned", "cancelled", "rejected"}),
    "assigned": frozenset({"return_requested", "returned", "overdue"}),
    "overdue": frozenset({"return_requested", "returned"}),
    "return_requested": frozenset({"returned"}),
}

# Employee may cancel only before a unit is physically assigned.
# Requested → Cancel ✅ | Approved → Cancel ✅ | Assigned → Cancel ❌ (must return)
EMPLOYEE_CANCEL_FROM = frozenset({"requested", "approved"})
EMPLOYEE_RETURN_FROM = frozenset({"assigned", "overdue"})
IT_COMPLETE_RETURN_FROM = frozenset({"assigned", "overdue", "return_requested"})


def _norm_status(status: str) -> str:
    return str(status or "").strip().lower()


def can_transition(from_status: str, to_status: str) -> bool:
    allowed = ALLOWED_TRANSITIONS.get(_norm_status(from_status), frozenset())
    return _norm_status(to_status) in allowed


def can_employee_cancel(status: str) -> bool:
    """True only for requested / approved — never after device assignment."""
    return _norm_status(status) in EMPLOYEE_CANCEL_FROM


def can_employee_request_return(status: str) -> bool:
    """True when a device is checked out (assigned / overdue)."""
    return _norm_status(status) in EMPLOYEE_RETURN_FROM
