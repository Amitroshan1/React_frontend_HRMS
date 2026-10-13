"""ITAM P3 — lifecycle dual-write + open custody records (behind itam_lifecycle_v1)."""

from __future__ import annotations

from typing import Any, Optional

from .. import db
from ..datetime_utils import utc_now
from ..models.it_models import ITAssetCustody, ITAssetUnit, ITOfficeStockDeployment
from .flags import is_itam_flag_enabled
from .lifecycle import (
    CanonicalStatus,
    CustodyType,
    canonical_status,
    custody_label,
    default_custody_type,
    is_allowed_transition,
    legacy_status_for_canonical,
    status_label,
)


class LifecycleValidationError(ValueError):
    """Illegal lifecycle / custody transition while lifecycle flag enforces rules."""


def lifecycle_enabled(config=None) -> bool:
    return is_itam_flag_enabled("itam_lifecycle_v1", config)


def _should_apply(config=None, require: Optional[bool] = None) -> bool:
    enabled = lifecycle_enabled(config)
    if require is None:
        return enabled
    return bool(require)


def open_deploy_unit_ids(unit_ids) -> set[int]:
    """Unit ids that have an open (quantity > 0) location deployment — one query for a batch."""
    ids = [int(i) for i in (unit_ids or []) if i]
    if not ids:
        return set()
    rows = (
        db.session.query(ITOfficeStockDeployment.asset_unit_id)
        .filter(
            ITOfficeStockDeployment.asset_unit_id.in_(ids),
            ITOfficeStockDeployment.quantity > 0,
        )
        .distinct()
        .all()
    )
    return {int(r[0]) for r in rows if r[0] is not None}


def resolve_unit_lifecycle(
    unit: ITAssetUnit,
    *,
    inventory_category: Optional[str] = None,
    deployed_unit_ids: Optional[set[int]] = None,
) -> tuple[str, str]:
    """
    Resolve (lifecycle_status, custody_type) for a unit.

    Prefer persisted P3 columns; else derive from legacy status + assignee / deploy.
    ``deployed_unit_ids`` (from open_deploy_unit_ids) avoids a per-unit query in list views.
    """
    if getattr(unit, "lifecycle_status", None):
        life = unit.lifecycle_status
        ctype = (unit.custody_type or default_custody_type(life)).upper()
        return life, ctype

    inv = unit.inventory_item
    cat = inventory_category or (inv.inventory_category if inv else None)
    has_emp = bool(unit.assigned_to_admin_id)

    # Location deploy rows mark Deployed even when legacy status is "assigned".
    open_deploy = False
    if unit.id and (unit.status or "").lower() == "assigned" and not has_emp:
        if deployed_unit_ids is not None:
            open_deploy = int(unit.id) in deployed_unit_ids
        else:
            open_deploy = (
                ITOfficeStockDeployment.query.filter(
                    ITOfficeStockDeployment.asset_unit_id == unit.id,
                    ITOfficeStockDeployment.quantity > 0,
                ).first()
                is not None
            )

    life = canonical_status(
        unit.status,
        inventory_category=cat if (open_deploy or not has_emp) else None,
        has_employee_assignee=has_emp if (unit.status or "").lower() == "assigned" else None,
    )
    if open_deploy:
        life = CanonicalStatus.DEPLOYED.value
    if not life:
        life = CanonicalStatus.IN_STOCK.value

    ctype = default_custody_type(life)
    if life == CanonicalStatus.CHECKED_OUT.value and has_emp:
        ctype = CustodyType.EMPLOYEE.value
    if life == CanonicalStatus.DEPLOYED.value:
        ctype = CustodyType.LOCATION.value
    return life, ctype


def serialize_lifecycle_fields(
    unit: ITAssetUnit,
    *,
    deployed_unit_ids: Optional[set[int]] = None,
) -> dict[str, Any]:
    life, ctype = resolve_unit_lifecycle(unit, deployed_unit_ids=deployed_unit_ids)
    custody = unit.custody_json if isinstance(getattr(unit, "custody_json", None), dict) else None
    if custody is None:
        custody = {"type": ctype}
        if unit.assigned_to_admin_id and ctype == CustodyType.EMPLOYEE.value:
            custody["admin_id"] = unit.assigned_to_admin_id
    return {
        "lifecycleStatus": life,
        "statusLabel": status_label(life),
        "custodyType": ctype,
        "custodyLabel": custody_label(ctype),
        "custody": custody,
        "isCheckedOut": life == CanonicalStatus.CHECKED_OUT.value,
        "isDeployed": life == CanonicalStatus.DEPLOYED.value,
    }


def close_open_custodies(
    *,
    asset_unit_id: Optional[int] = None,
    software_license_id: Optional[int] = None,
) -> int:
    q = ITAssetCustody.query.filter(ITAssetCustody.is_open.is_(True))
    if asset_unit_id is not None:
        q = q.filter(ITAssetCustody.asset_unit_id == int(asset_unit_id))
    if software_license_id is not None:
        q = q.filter(ITAssetCustody.software_license_id == int(software_license_id))
    closed = 0
    now = utc_now()
    for row in q.all():
        row.is_open = False
        row.closed_at = now
        closed += 1
    return closed


def open_custody_count(
    *,
    asset_unit_id: Optional[int] = None,
    software_license_id: Optional[int] = None,
) -> int:
    q = ITAssetCustody.query.filter(ITAssetCustody.is_open.is_(True))
    if asset_unit_id is not None:
        q = q.filter(ITAssetCustody.asset_unit_id == int(asset_unit_id))
    if software_license_id is not None:
        q = q.filter(ITAssetCustody.software_license_id == int(software_license_id))
    return q.count()


def apply_unit_lifecycle(
    unit: ITAssetUnit,
    *,
    lifecycle_status: str,
    custody_type: Optional[str] = None,
    custody: Optional[dict] = None,
    actor_admin_id: Optional[int] = None,
    dual_write_legacy: bool = True,
    enforce_allowed: bool = False,
    config=None,
    require: Optional[bool] = None,
) -> Optional[ITAssetCustody]:
    """
    Dual-write lifecycle columns + open/close custody records when flag ON.

    Returns the new open custody row (or None when custody is NONE / flag off).
    """
    if not _should_apply(config, require):
        return None

    life = canonical_status(lifecycle_status) or str(lifecycle_status or "").strip()
    if life not in (
        CanonicalStatus.ORDERED.value,
        CanonicalStatus.IN_TRANSIT.value,
        CanonicalStatus.RECEIVED.value,
        CanonicalStatus.IN_STOCK.value,
        CanonicalStatus.RESERVED.value,
        CanonicalStatus.CHECKED_OUT.value,
        CanonicalStatus.DEPLOYED.value,
        CanonicalStatus.PENDING_RETURN.value,
        CanonicalStatus.IN_REPAIR.value,
        CanonicalStatus.QUARANTINE.value,
        CanonicalStatus.EXPORTED.value,
        CanonicalStatus.RETIRED.value,
        CanonicalStatus.LOST.value,
    ):
        raise LifecycleValidationError(f"Unknown lifecycle_status: {lifecycle_status}")

    prev = unit.lifecycle_status or canonical_status(unit.status)
    if enforce_allowed and prev and not is_allowed_transition(prev, life):
        raise LifecycleValidationError(f"Illegal lifecycle transition {prev} → {life}")

    ctype = (custody_type or default_custody_type(life) or CustodyType.NONE.value).strip().upper()
    if ctype not in {
        CustodyType.EMPLOYEE.value,
        CustodyType.LOCATION.value,
        CustodyType.VENDOR.value,
        CustodyType.NONE.value,
    }:
        raise LifecycleValidationError(f"Unknown custody_type: {custody_type}")

    # Invariant: CheckedOut ↔ EMPLOYEE, Deployed ↔ LOCATION
    if life == CanonicalStatus.CHECKED_OUT.value and ctype != CustodyType.EMPLOYEE.value:
        raise LifecycleValidationError("CheckedOut requires EMPLOYEE custody")
    if life == CanonicalStatus.DEPLOYED.value and ctype != CustodyType.LOCATION.value:
        raise LifecycleValidationError("Deployed requires LOCATION custody")
    if life == CanonicalStatus.CHECKED_OUT.value and ctype == CustodyType.LOCATION.value:
        raise LifecycleValidationError("Deploy must not use CheckedOut / LOCATION mismatch")

    snap = dict(custody or {})
    snap["type"] = ctype

    unit.lifecycle_status = life
    unit.custody_type = ctype
    unit.custody_json = snap

    if dual_write_legacy:
        legacy = legacy_status_for_canonical(life)
        if legacy:
            unit.status = legacy

    close_open_custodies(asset_unit_id=unit.id)

    if ctype == CustodyType.NONE.value:
        return None

    row = ITAssetCustody(
        asset_unit_id=unit.id,
        custody_type=ctype,
        holder_admin_id=snap.get("admin_id") or unit.assigned_to_admin_id,
        location=snap.get("location"),
        vendor_name=snap.get("vendor_name"),
        custody_json=snap,
        is_open=True,
        opened_at=utc_now(),
        opened_by_admin_id=actor_admin_id,
    )
    db.session.add(row)

    # Enforce one-open invariant after flush
    db.session.flush()
    if open_custody_count(asset_unit_id=unit.id) > 1:
        raise LifecycleValidationError("Invariant violated: more than one open custody")

    return row


def lifecycle_for_legacy_status_change(
    to_status: str,
    *,
    from_unit: Optional[ITAssetUnit] = None,
    force_deployed: bool = False,
) -> tuple[str, str]:
    """Map a legacy status PATCH / return destination to (lifecycle, custody_type)."""
    to_l = (to_status or "").strip().lower().replace("_", "-")
    if force_deployed or to_l == "deployed":
        return CanonicalStatus.DEPLOYED.value, CustodyType.LOCATION.value
    if to_l in {"repair", "in-repair", "inrepair"}:
        return CanonicalStatus.IN_REPAIR.value, CustodyType.VENDOR.value
    if to_l in {"notworking", "not-working", "removed-from-it", "removed"}:
        return CanonicalStatus.QUARANTINE.value, CustodyType.NONE.value
    if to_l in {"dead", "deleted", "retired"}:
        return CanonicalStatus.RETIRED.value, CustodyType.NONE.value
    if to_l == "exported":
        return CanonicalStatus.EXPORTED.value, CustodyType.NONE.value
    if to_l == "assigned":
        if from_unit and not from_unit.assigned_to_admin_id:
            return CanonicalStatus.DEPLOYED.value, CustodyType.LOCATION.value
        return CanonicalStatus.CHECKED_OUT.value, CustodyType.EMPLOYEE.value
    if to_l == "available":
        return CanonicalStatus.IN_STOCK.value, CustodyType.NONE.value
    mapped = canonical_status(to_status) or CanonicalStatus.IN_STOCK.value
    return mapped, default_custody_type(mapped)


def backfill_unit_lifecycle(*, limit: int = 500, config=None) -> dict[str, int]:
    """Hydrate lifecycle_status / custody_type / open custody from legacy rows."""
    limit = max(1, min(5000, int(limit or 500)))
    units = ITAssetUnit.query.order_by(ITAssetUnit.id.asc()).limit(limit).all()
    updated = 0
    skipped = 0
    for unit in units:
        try:
            life, ctype = resolve_unit_lifecycle(unit)
            custody = {"type": ctype}
            if ctype == CustodyType.EMPLOYEE.value and unit.assigned_to_admin_id:
                custody["admin_id"] = unit.assigned_to_admin_id
            if ctype == CustodyType.LOCATION.value:
                dep = (
                    ITOfficeStockDeployment.query.filter(
                        ITOfficeStockDeployment.asset_unit_id == unit.id,
                        ITOfficeStockDeployment.quantity > 0,
                    )
                    .order_by(ITOfficeStockDeployment.id.desc())
                    .first()
                )
                if dep:
                    custody["location"] = dep.deployment_location
                    custody["deployment_id"] = dep.id
            apply_unit_lifecycle(
                unit,
                lifecycle_status=life,
                custody_type=ctype,
                custody=custody,
                dual_write_legacy=False,  # do not rewrite legacy status on backfill
                config=config,
                require=True,
            )
            updated += 1
        except Exception:
            skipped += 1
    if updated:
        db.session.commit()
    return {"updated": updated, "skipped": skipped, "scanned": len(units)}
