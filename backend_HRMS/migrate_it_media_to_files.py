"""
One-time migration: move base64 photos/receipts stored in IT JSON columns to files
under UPLOADS_ROOT/it_media/... and keep only the file key in the database.

Safe to re-run (already-migrated values are left as they are). Values that are not a
supported image/PDF/Word data URL stay inline, exactly as before.

    python migrate_it_media_to_files.py              # dry run: report only, writes nothing
    python migrate_it_media_to_files.py --apply      # migrate (take a DB backup first)
    python migrate_it_media_to_files.py --apply --only it_asset_units --batch-size 20
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from website import create_app, db  # noqa: E402
from website.it_media import is_storable_data_url, media_in  # noqa: E402
from website.models.it_models import (  # noqa: E402
    ITAssetReturnRequest,
    ITAssetUnit,
    ITInventoryItem,
    ITParcelExport,
    ITParcelExportItem,
    ITParcelImport,
    ITRemovedAsset,
)

# (model, column attribute, media kind)
TARGETS = [
    (ITInventoryItem, "photos_json", "inventory"),
    (ITInventoryItem, "receipts_json", "receipt"),
    (ITAssetUnit, "photos_json", "unit"),
    (ITAssetUnit, "assignment_photos_json", "assignment"),
    (ITRemovedAsset, "photos_json", "removed"),
    (ITAssetReturnRequest, "photos_json", "return_request"),
    (ITParcelImport, "photos_json", "parcel_import"),
    (ITParcelExport, "parcel_photos_json", "parcel_export"),
    (ITParcelExportItem, "individual_photo_json", "parcel_item"),
]


def _inline_values(value):
    items = value if isinstance(value, list) else [value]
    return [v for v in items if isinstance(v, str) and v.startswith("data:")]


def migrate_column(model, attr, kind, *, apply, batch_size):
    col = getattr(model, attr)
    stats = {"rows_scanned": 0, "rows_changed": 0, "files": 0, "kept_inline": 0, "bytes_inline": 0}
    last_id = 0
    while True:
        rows = (
            db.session.query(model.id, col)
            .filter(model.id > last_id)
            .order_by(model.id.asc())
            .limit(batch_size)
            .all()
        )
        if not rows:
            break
        last_id = rows[-1][0]
        changed = 0
        for row_id, value in rows:
            stats["rows_scanned"] += 1
            inline = _inline_values(value)
            if not inline:
                continue
            storable = [v for v in inline if is_storable_data_url(v)]
            stats["files"] += len(storable)
            stats["kept_inline"] += len(inline) - len(storable)
            stats["bytes_inline"] += sum(len(v) for v in storable)
            if not storable:
                continue
            stats["rows_changed"] += 1
            if apply:
                new_value = media_in(value, kind, force=True)
                db.session.query(model).filter(model.id == row_id).update(
                    {col: new_value}, synchronize_session=False
                )
                changed += 1
        if apply and changed:
            db.session.commit()
        db.session.expunge_all()
    return stats


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="write files and update rows (default: dry run)")
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--only", help="limit to one table name, e.g. it_asset_units")
    args = parser.parse_args()

    app = create_app()
    with app.app_context():
        mode = "APPLY" if args.apply else "DRY RUN (nothing written; use --apply to migrate)"
        print(f"IT media migration — {mode}")
        totals = {"rows_changed": 0, "files": 0, "kept_inline": 0, "bytes_inline": 0}
        for model, attr, kind in TARGETS:
            if args.only and model.__tablename__ != args.only:
                continue
            try:
                stats = migrate_column(
                    model, attr, kind, apply=args.apply, batch_size=max(1, args.batch_size)
                )
            except Exception:
                db.session.rollback()
                print(f"  {model.__tablename__}.{attr}: FAILED (earlier batches are kept; re-run is safe)")
                raise
            for k in totals:
                totals[k] += stats[k]
            print(
                f"  {model.__tablename__}.{attr}: scanned {stats['rows_scanned']}, "
                f"rows to move {stats['rows_changed']}, files {stats['files']}, "
                f"left inline {stats['kept_inline']}, base64 size {stats['bytes_inline'] / 1_048_576:.1f} MB"
            )
        print(
            f"Total: rows {totals['rows_changed']}, files {totals['files']}, "
            f"left inline {totals['kept_inline']}, base64 moved out of DB "
            f"{totals['bytes_inline'] / 1_048_576:.1f} MB"
        )


if __name__ == "__main__":
    main()
