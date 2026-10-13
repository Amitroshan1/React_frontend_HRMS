"""Server-paged Inventory "Asset Overview" / "Total Assets" list.

Reproduces the browser rules in frontend InventoryDashboard.jsx (getMappedInventory,
filterITOverviewAssets, buildCategoryQtyCounts, buildHwTypeQtyCounts, buildStatusQtyCounts,
collectProjectNamesFromAssets, shouldShowLaptopCodeColumn) so a page of rows plus the
filter-chip counts match what the full-download view showed. Keep both sides in sync.

GET /api/it/inventory/overview
    ?inventory_category=IT Assets   top-level tab ("" = every tab)
    &category=All|Hardware|Accessories|Consumables
    &hw_type=All|<type>             only applied with Hardware/Accessories/Consumables
    &project=All|<project code>     only applied with Hardware + Mobile/Tablet
    &q=<search>                     name / type / category
    &status=All|Available|Assigned
    &limit=50&cursor=<last id>      newest first (same order as /inventory/items)
    &counts=1                       include chip counts (send on the first page only)
"""
from __future__ import annotations

from flask import request
from sqlalchemy import and_, case, func

from . import db
from .list_query import apply_search, keyset_page, page_args, search_term
from .models.it_models import ITAssetUnit, ITInventoryItem

INV_CATEGORIES = ("IT Assets", "Office Assets", "Transport Assets", "Infrastructure Assets")
_NON_IT_CATEGORIES = ("Office Assets", "Transport Assets", "Infrastructure Assets")
_SUB_FILTER_CATEGORIES = ("Hardware", "Accessories", "Consumables")
_MOBILE_TABLET = ("Mobile", "Tablet")
_CATEGORY_VALUES = {
    "consumables": ("consumables", "consumable"),
    "accessories": ("accessories", "accessory"),
}

Item = ITInventoryItem
Unit = ITAssetUnit


def _norm(col):
    return func.lower(func.trim(func.coalesce(col, "")))


def _trimmed(col):
    return func.trim(func.coalesce(col, ""))


def resolved_inventory_category():
    """SQL for the tab an item shows under: server _effective_inventory_category, then the
    frontend resolveInventoryCategory applied to that value."""
    cat = _norm(Item.category)
    ic = _trimmed(Item.inventory_category)
    return case(
        (cat == "vehicle", "Transport Assets"),
        (cat == "equipment", "Infrastructure Assets"),
        (cat == "stock", case((ic.in_(_NON_IT_CATEGORIES), ic), else_="")),
        (cat.in_(("hardware", "software", "accessories", "consumables")), "IT Assets"),
        (cat.in_(("consumable", "accessory")), case((ic.in_(INV_CATEGORIES), ic), else_="IT Assets")),
        (ic == "", "IT Assets"),
        (ic.in_(INV_CATEGORIES), ic),
        else_="",
    )


def _category_condition(filter_id: str):
    if not filter_id or filter_id == "All":
        return None
    f = filter_id.strip().lower()
    return _norm(Item.category).in_(_CATEGORY_VALUES.get(f, (f,)))


def _is_mobile_tablet(hw_type) -> bool:
    return str(hw_type or "").strip() in _MOBILE_TABLET


def _units_by_item(items):
    """{item_id: [(project_code, make), ...]} using the frontend unit lookup: an item's own
    units, else units with the same asset name and type, else units with the same name."""
    if not items:
        return {}
    ids = [it.id for it in items]
    own = {}
    for item_id, code, make in (
        db.session.query(Unit.inventory_item_id, Unit.project_code, Unit.make)
        .filter(Unit.inventory_item_id.in_(ids))
        .distinct()
        .all()
    ):
        own.setdefault(item_id, []).append((code, make))

    orphans = [it for it in items if it.id not in own]
    if orphans:
        names = sorted({it.name for it in orphans if it.name})
        by_name = {}
        if names:
            for name, hw, code, make in (
                db.session.query(Unit.asset_name, Unit.hw_type, Unit.project_code, Unit.make)
                .filter(Unit.asset_name.in_(names))
                .distinct()
                .all()
            ):
                by_name.setdefault(name, []).append((hw, code, make))
        for it in orphans:
            rows = by_name.get(it.name, [])
            if it.hw_type:
                typed = [r for r in rows if str(r[0] or "").lower() == str(it.hw_type).lower()]
                if typed:
                    rows = typed
            own[it.id] = [(code, make) for _hw, code, make in rows]
    return own


def _project_label(code, make) -> str:
    return (code or "").strip() or (make or "").strip()


def _project_matches(units, needle: str) -> bool:
    for code, make in units:
        c = (code or "").strip().lower()
        if c == needle or (not c and (make or "").strip().lower() == needle):
            return True
    return False


def _first_unit_fields(items):
    """{item_id: {brand, make, model}} of the newest unit per row (frontend `units[0]`)."""
    if not items:
        return {}
    ids = [it.id for it in items]
    newest = dict(
        db.session.query(Unit.inventory_item_id, func.max(Unit.id))
        .filter(Unit.inventory_item_id.in_(ids))
        .group_by(Unit.inventory_item_id)
        .all()
    )
    pick = {item_id: unit_id for item_id, unit_id in newest.items() if unit_id}

    orphans = [it for it in items if it.id not in pick]
    names = sorted({it.name for it in orphans if it.name})
    if names:
        groups = (
            db.session.query(Unit.asset_name, func.lower(func.coalesce(Unit.hw_type, "")), func.max(Unit.id))
            .filter(Unit.asset_name.in_(names))
            .group_by(Unit.asset_name, func.lower(func.coalesce(Unit.hw_type, "")))
            .all()
        )
        for it in orphans:
            rows = [(hw, uid) for name, hw, uid in groups if name == it.name]
            if it.hw_type:
                typed = [uid for hw, uid in rows if hw == str(it.hw_type).lower()]
                if typed:
                    pick[it.id] = max(typed)
                    continue
            if rows:
                pick[it.id] = max(uid for _hw, uid in rows)

    if not pick:
        return {}
    units = {
        u.id: u
        for u in db.session.query(Unit.id, Unit.brand, Unit.make, Unit.model)
        .filter(Unit.id.in_(set(pick.values())))
        .all()
    }
    out = {}
    for item_id, unit_id in pick.items():
        u = units.get(unit_id)
        if u is not None:
            out[item_id] = {"brand": u.brand or "", "make": u.make or "", "model": u.model or ""}
    return out


def _qty_sum(cond):
    return func.coalesce(func.sum(case((cond, Item.total_quantity), else_=0)), 0)


def _category_counts(base):
    cat = _norm(Item.category)
    row = base.with_entities(
        func.coalesce(func.sum(Item.total_quantity), 0),
        _qty_sum(cat == "hardware"),
        _qty_sum(cat == "software"),
        _qty_sum(cat.in_(_CATEGORY_VALUES["accessories"])),
        _qty_sum(cat.in_(_CATEGORY_VALUES["consumables"])),
    ).one()
    keys = ("All", "Hardware", "Software", "Accessories", "Consumables")
    return {k: int(v or 0) for k, v in zip(keys, row)}


def _sub_type_counts(query):
    """Qty per hw type; keys are lower-case (the UI looks them up case-insensitively)."""
    hw = _norm(Item.hw_type)
    counts = {"All": 0}
    for key, qty in query.with_entities(hw, func.sum(Item.total_quantity)).group_by(hw).all():
        qty = int(qty or 0)
        counts["All"] += qty
        k = key or "other"
        counts[k] = counts.get(k, 0) + qty
    return counts


def _status_counts(query):
    row = query.with_entities(
        func.count(Item.id),
        func.coalesce(func.sum(case((Item.available_quantity > 0, 1), else_=0)), 0),
        func.coalesce(func.sum(case((Item.assigned_quantity > 0, 1), else_=0)), 0),
    ).one()
    return {"All": int(row[0] or 0), "Available": int(row[1] or 0), "Assigned": int(row[2] or 0)}


def overview_payload(serialize_item):
    args = request.args
    inventory_category = (args.get("inventory_category") or "").strip()
    category = (args.get("category") or "").strip() or "All"
    hw_type = (args.get("hw_type") or "").strip() or "All"
    project = (args.get("project") or "").strip() or "All"
    status = (args.get("status") or "").strip() or "All"
    want_counts = args.get("counts") in ("1", "true")
    limit, cursor = page_args()

    base = Item.query.filter(_norm(Item.category) != "software", Item.total_quantity > 0)
    if inventory_category:
        base = base.filter(resolved_inventory_category() == inventory_category)

    cat_cond = _category_condition(category)
    with_category = base.filter(cat_cond) if cat_cond is not None else base
    with_type = with_category
    if category in _SUB_FILTER_CATEGORIES and hw_type != "All":
        with_type = with_category.filter(_norm(Item.hw_type) == hw_type.lower())

    project_scope = category == "Hardware" and _is_mobile_tablet(hw_type)
    scoped_units = {}
    scoped_items = []
    if project_scope:
        scoped_items = with_type.with_entities(Item.id, Item.name, Item.hw_type).all()
        scoped_units = _units_by_item(scoped_items)

    pre_status = with_type
    if project_scope and project != "All":
        needle = project.lower()
        matched = [it.id for it in scoped_items if _project_matches(scoped_units.get(it.id, []), needle)]
        pre_status = pre_status.filter(Item.id.in_(matched or [-1]))
    pre_status = apply_search(pre_status, [Item.name, Item.hw_type, Item.category], search_term())

    filtered = pre_status
    if status == "Available":
        filtered = filtered.filter(Item.available_quantity > 0)
    elif status == "Assigned":
        filtered = filtered.filter(Item.assigned_quantity > 0)

    cat = _norm(Item.category)
    total, non_hardware, laptops = filtered.with_entities(
        func.count(Item.id),
        func.coalesce(func.sum(case((cat != "hardware", 1), else_=0)), 0),
        func.coalesce(
            func.sum(case((and_(cat == "hardware", _norm(Item.hw_type) == "laptop"), 1), else_=0)), 0
        ),
    ).one()
    total = int(total or 0)

    rows, next_cursor, has_more = keyset_page(filtered, Item.id, limit=limit, cursor=cursor)
    first_units = _first_unit_fields(rows)
    items = []
    for row in rows:
        data = serialize_item(row)
        data["first_unit"] = first_units.get(row.id)
        items.append(data)

    payload = {
        "items": items,
        "total": total,
        "next_cursor": next_cursor,
        "has_more": has_more,
        "show_laptop_code": bool(
            inventory_category == "IT Assets" and total > 0 and not non_hardware and laptops
        ),
    }
    if want_counts:
        project_options = []
        if project_scope:
            names = set()
            for it in scoped_items:
                if not _is_mobile_tablet(it.hw_type):
                    continue
                for code, make in scoped_units.get(it.id, []):
                    label = _project_label(code, make)
                    if label:
                        names.add(label)
            project_options = sorted(names)
        payload["counts"] = {
            "category": _category_counts(base),
            "sub_type": _sub_type_counts(with_category),
            "status": _status_counts(pre_status),
            "project_options": project_options,
        }
    return payload
