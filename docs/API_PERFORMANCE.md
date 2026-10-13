# API performance (IT / Inventory) — deploy notes

No database migration and no new Python/npm packages. API response content is unchanged
for existing pages; all new behaviour is additive or opt-in.

## What changed

| Area | Change |
|---|---|
| IT list endpoints | Related admins/photos/deployments loaded in batches (fixed query count instead of 2–3 queries per row): `/api/it/units`, `/software/licenses`, `/employees/assigned-assets`, `/tickets`, `/return-requests`, `/removed-assets`, `/deleted-logs` |
| All JSON responses | gzip when the browser accepts it; `ETag` + `Cache-Control: private, no-cache` on GET so unchanged data returns `304` with no body (`website/http_perf.py`) |
| Signed file URLs | Expiry rounded to 5-minute buckets so photo URLs are stable and browser-cacheable (validity still ≥ `FILE_SIGN_TTL_SECONDS`) |
| `/api/it/units`, `/api/it/inventory/items` | Optional `?limit=&cursor=&q=` server-side paging + search (`website/list_query.py`). Without `limit` the full list is returned exactly as before |
| `/api/it/summary` | Extra count fields: `units_by_status`, `licenses_by_status`, `inventory_items_by_category`, `pending_return_requests` |
| Frontend `syncITDataFromAPI` | Concurrent calls share one request; page-navigation refreshes reuse data synced in the last 10 s; any IT write forces a fresh sync |

## Deploy order

1. Backend first (frontend keeps working against it unchanged), restart Gunicorn.
2. Frontend build (`npm run build`) and publish `dist/`.

## Verify after deploy

Browser DevTools → Network on the IT panel:

- `/api/it/units` response header `Content-Encoding: gzip`.
- Reloading the page without changes: IT list requests show `304`.
- Navigating between IT pages: no duplicate bursts of `/api/it/*` requests.

## Switches / rollback

Disable without redeploying code (set in the backend env, restart Gunicorn):

```bash
HTTP_GZIP=0   # turn off app-level gzip
HTTP_ETAG=0   # turn off ETag / 304
```

Full rollback = revert the commit; there is no schema or data change to undo.

## nginx

Nothing required. If nginx also has `gzip on`, it skips responses that already have
`Content-Encoding`, so there is no double compression. Keep the SSE block from
`ATTENDANCE_SSE.md` as is (SSE responses are never compressed or ETagged by the app).

## Release 2 — frontend filtering and rendering (frontend only)

No backend, API, or data change. Deploy = frontend build only; rollback = previous `dist/`.

| Area | Change |
|---|---|
| Search boxes (Asset Management, Inventory → Asset Overview) | `useDeferredValue`: typing stays instant, filtering runs right after at lower priority |
| Long tables (Asset Management Available/Assigned, Inventory Total Assets / Overview, Active Devices) | First 100 rows rendered, then "Show N more" / "Show all" (`hooks/useIncrementalList.js`, `components/ShowMoreRows.jsx`). Record counts and totals still use the full filtered list; rows reset to 100 when filters/search change |
| Unit / employee lookups | One-pass index maps (`pages/IT/unitLookupIndex.js`) replace per-row scans of all units/employees in Inventory mapping, Asset Management available/assigned lists, total asset count and Active Devices photos. Same results (verified against the old logic) |
| Total Assets filter chips | Reuse the already-mapped list instead of rebuilding inventory on every chip click |
| Images | `loading="lazy"` + `decoding="async"` on avatars, clickable photos and parcel thumbnails |

Bulk "Add New Assets" still creates items one request at a time on purpose: inventory codes
are allocated server-side from the latest code, so parallel creates could collide.

## Release 3 — IT photos as files instead of base64 in the database

No schema change. The frontend keeps sending base64 exactly as before; the backend does the rest.

| Area | Change |
|---|---|
| Saving (create item / units / assign / return request / removed asset / parcels) | Base64 images (jpg/png/gif/webp/bmp), PDFs and Word files are checked by their real bytes, written to `UPLOADS_ROOT/it_media/t{tenant}/{kind}/{yyyy}/{mm}/{random}.{ext}`, and only that key is stored. Identical uploads in one request share one file. Anything else (SVG, HTML, unknown) stays inline as before |
| Reading | Keys are returned as signed `/api/files/signed/...` URLs (same as employee photos), stable for up to 1 hour so the browser caches them (`Cache-Control: private, immutable`). Rows not migrated yet still return their base64 unchanged |
| Editing | Signed URLs sent back by the frontend are mapped to the stored key. Only keys of the strict `it_media` format and the current tenant are accepted, so no other upload (payslips etc.) can be attached |
| Frontend | `utils/mediaSrc.js` `isImageSrc()` treats image URLs like base64 images (file upload preview, return requests, My Assets return modal) |

### Deploy steps

1. Back up the database (the migration rewrites photo columns).
2. Make sure `UPLOADS_ROOT` (default `backend_HRMS/uploads`) is on persistent disk, writable by the
   Gunicorn user, and included in your file backups. Photos will live there from now on.
3. Deploy backend, restart Gunicorn. New photos are stored as files immediately.
4. Deploy the frontend build.
5. Move existing photos (quiet hours recommended; safe to stop and re-run):

```bash
cd backend_HRMS
python migrate_it_media_to_files.py            # dry run: shows what would move
python migrate_it_media_to_files.py --apply    # migrate
python migrate_it_media_to_files.py            # should report "Total: rows 0, files 0"
```

Verify: DevTools → `/api/it/units` response is now small and photos are `/api/files/signed/it_media/...` URLs.

### Switches / rollback

- `IT_MEDIA_FILES=0` (backend env, restart): new uploads are stored inline again. Files already
  written keep being served, so nothing breaks.
- Code rollback after the migration: the old code would return keys instead of images, so
  photos would not display until this release is redeployed. Data is not lost (files + keys
  remain). Roll back only together with the DB backup from step 1 if really needed.
- Optional: `IT_MEDIA_MAX_BYTES` (default 25 MB per file; larger stays inline).

## Release 4 — Inventory Overview / Total Assets paged on the server

No schema or data change. Deploy backend and frontend together (backend first is fine: the new
endpoint is only called by the new frontend).

| Area | Change |
|---|---|
| `GET /api/it/inventory/overview` (new, `website/it_inventory_overview.py`) | Rows for Inventory → Asset Overview and Total Assets: tab, category, type, project code, search and status filters, newest first, 50 per page (keyset cursor), `total`, Laptop Code column flag, and the filter-chip counts (`counts=1`). Same rows and counts as the old in-browser logic — checked by a parity test over 3,360 filter combinations |
| Frontend `pages/IT/useITList.js` | Reusable hook: fetches page one when filters change, search waits 300 ms after typing, "Show 50 more" loads the next page, stale responses are ignored, and it reloads after saves |
| Asset Overview, Total Assets | Use the hook. First page appears without waiting for the full IT sync; filtering/search/counting run in SQL |
| Search (all opt-in list endpoints) | `%` and `_` typed by users are matched literally |

Still loaded from the full IT sync (unchanged): the summary cards at the top, the asset detail
popup, Reviews and the Repair / Not Working / Remove actions, and every other IT page. The
full sync still runs in the background, so server load is not lower yet — moving those parts
to per-item requests is the next step.

### Switches / rollback

- Build the frontend with `VITE_IT_SERVER_LISTS=0` to use the old in-browser lists (no backend change needed).
- Automatic fallback: if the overview request fails, the page silently shows the cached in-browser list
  and retries on the next filter change or navigation.
- Code rollback: redeploy the previous frontend; the extra backend endpoint is harmless.

## Multi-tenancy

These changes do not read or write `tenant_id` in queries. When the tenant filter is added to the IT
queries, the batched queries and paging keep working; only tenant-first indexes need adding then.
IT media files are already stored per tenant (`it_media/t{tenant_id}/...`, tenant from the JWT, default 1),
and only the caller's tenant keys are signed or accepted.
