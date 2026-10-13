"""Shared helpers for opt-in server-side list paging and search.

Contract (only when the caller sends ?limit=):
    GET /things?limit=50&cursor=<last id>&q=<search>
    -> {"<key>": [...], "next_cursor": <id|null>, "has_more": bool}

Without ?limit= endpoints keep returning the full list, so existing pages are unaffected.
Keyset paging (WHERE id < cursor ORDER BY id DESC) stays fast at any depth, unlike OFFSET.
"""
from __future__ import annotations

from flask import request

from . import db

MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 50


def opt_in_page_args():
    """(limit, cursor) when the caller opted into paging, else (None, None)."""
    raw = request.args.get("limit")
    if raw in (None, ""):
        return None, None
    try:
        limit = int(raw)
    except (TypeError, ValueError):
        limit = DEFAULT_PAGE_SIZE
    limit = min(max(limit, 1), MAX_PAGE_SIZE)
    cursor = request.args.get("cursor", type=int)
    return limit, cursor


def page_args(default: int = DEFAULT_PAGE_SIZE):
    """(limit, cursor) for endpoints that always page."""
    try:
        limit = int(request.args.get("limit") or default)
    except (TypeError, ValueError):
        limit = default
    limit = min(max(limit, 1), MAX_PAGE_SIZE)
    return limit, request.args.get("cursor", type=int)


def search_term(min_len: int = 1) -> str:
    term = (request.args.get("q") or "").strip()
    return term if len(term) >= min_len else ""


LIKE_ESCAPE = "!"


def contains_pattern(term: str) -> str:
    """LIKE pattern matching `term` literally (user-typed % and _ are not wildcards)."""
    escaped = (
        term.lower()
        .replace(LIKE_ESCAPE, LIKE_ESCAPE * 2)
        .replace("%", LIKE_ESCAPE + "%")
        .replace("_", LIKE_ESCAPE + "_")
    )
    return f"%{escaped}%"


def apply_search(query, columns, term: str):
    """Case-insensitive partial match across columns (OR)."""
    if not term:
        return query
    pattern = contains_pattern(term)
    return query.filter(
        db.or_(
            *[
                db.func.lower(db.func.coalesce(col, "")).like(pattern, escape=LIKE_ESCAPE)
                for col in columns
            ]
        )
    )


def keyset_page(query, id_col, *, limit: int, cursor=None):
    """Newest-first page by primary key. Returns (rows, next_cursor, has_more)."""
    if cursor:
        query = query.filter(id_col < int(cursor))
    rows = query.order_by(id_col.desc()).limit(limit + 1).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = int(getattr(rows[-1], id_col.key)) if (has_more and rows) else None
    return rows, next_cursor, has_more
