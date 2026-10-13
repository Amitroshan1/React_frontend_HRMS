
import { useState, useMemo, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "react-toastify";
import { useRefreshOnNavigate } from "../../../../hooks/useRefreshOnNavigate";
import ClickableImage from "../../../../components/ClickableImage";
import { openImageInNewTab } from "../../../../utils/openImageInNewTab";
import {toastITApiFailure, syncParcelsFromAPI} from "../../Data";
import {
  formatParcelBrandModel,
  getParcelAssetDisplayName,
} from "../../inventoryCategories";
import ActivityLogPage from "../../itam/ActivityLogPage";
import "./ParcelDashboard.css";
import { formatDate } from "../../../../utils/dateFormat";

// ─── Constants ────────────────────────────────────────────────────────────────
const PER_PAGE = 10;

const EXPORT_CATEGORY_FILTERS = [
  { id: "All", label: "All" },
  { id: "IT Assets", label: "IT" },
  { id: "Office Assets", label: "Office" },
  { id: "Infrastructure Assets", label: "Infra" },
  { id: "Transport Assets", label: "Transport" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const readImported = () => {
  try { return JSON.parse(localStorage.getItem("pcl_imported") || "[]"); }
  catch { return []; }
};

const readExported = () => {
  try { return JSON.parse(localStorage.getItem("pcl_exported") || "[]"); }
  catch { return []; }
};

// ─── Shared modal primitives ──────────────────────────────────────────────────

function ModalBackdrop({ onClose, className, children }) {
  return (
    <div className={className} onClick={onClose} role="presentation">
      {children}
    </div>
  );
}

function ModalHeader({ title, subtitle, onClose, titleId }) {
  return (
    <div className="pcl-modal-head">
      <div className="pcl-modal-head-text">
        <h3 className="pcl-modal-title" id={titleId}>{title}</h3>
        {subtitle && <span className="pcl-modal-id">{subtitle}</span>}
      </div>
      <button type="button" className="pcl-modal-close" onClick={onClose} aria-label="Close modal">
        ×
      </button>
    </div>
  );
}

function ModalDetailRow({ label, value }) {
  if (!value) return null;
  return (
    <div className="pcl-modal-row">
      <span className="pcl-modal-label">{label}</span>
      <span className="pcl-modal-value">{value}</span>
    </div>
  );
}

function ModalPhotoGrid({ photos, label }) {
  if (!photos?.length) return null;
  return (
    <div className="pcl-modal-sn-section">
      <span className="pcl-modal-label">📦 {label} ({photos.length})</span>
      <div className="pcl-parcel-photo-grid">
        {photos.map((src, i) => (
          <button
            key={i}
            type="button"
            className="pcl-photo-thumb-btn"
            onClick={() => openImageInNewTab(src)}
            title="Open full image in new tab"
          >
            <img
              src={src}
              alt={`photo-${i + 1}`}
              className="pcl-parcel-photo-thumb pcl-photo-gallery-img"
              loading="lazy"
              decoding="async"
            />
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Modals ───────────────────────────────────────────────────────────────────

/** Parcel / import photo gallery — click thumbnail to open full image in new tab. */
function PhotoGalleryModal({ photos, title, onClose }) {
  if (!photos?.length) return null;

  return (
    <ModalBackdrop className="pcl-modal-backdrop" onClose={onClose}>
      <div
        className="pcl-modal pcl-photo-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pcl-photo-gallery-title"
        onClick={(e) => e.stopPropagation()}
      >
        <ModalHeader
          title={title || "Parcel Photos"}
          subtitle={`${photos.length} photo${photos.length !== 1 ? "s" : ""} — click to open in new tab`}
          onClose={onClose}
          titleId="pcl-photo-gallery-title"
        />
        <div className="pcl-modal-body pcl-photo-gallery-body">
          <div className="pcl-parcel-photo-grid pcl-photo-gallery-grid">
            {photos.map((src, i) => (
              <button
                key={i}
                type="button"
                className="pcl-photo-thumb-btn"
                onClick={() => openImageInNewTab(src)}
                title="Open full image in new tab"
              >
                <img
                  src={src}
                  alt={`Parcel photo ${i + 1}`}
                  className="pcl-parcel-photo-thumb pcl-photo-gallery-img"
                  loading="lazy"
                  decoding="async"
                />
              </button>
            ))}
          </div>
        </div>
      </div>
    </ModalBackdrop>
  );
}

/** Exported asset detail modal — shows Exported By */
function DetailsModal({ asset, onClose }) {
  if (!asset) return null;

  const photoBySerial = {};
  asset.assets?.forEach((a) => {
    if (a.serialNo) photoBySerial[a.serialNo] = a.individualPhoto || null;
  });

  const serialNumbers = asset.serialNumbers?.length
    ? asset.serialNumbers
    : asset.assets?.map((a) => a.serialNo).filter(Boolean) ?? [];

  return (
    <ModalBackdrop className="pcl-modal-backdrop" onClose={onClose}>
      <div
        className="pcl-modal pcl-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pcl-export-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <ModalHeader
          title={asset.assetName}
          subtitle={asset.id}
          onClose={onClose}
          titleId="pcl-export-detail-title"
        />

        <div className="pcl-modal-body">
          <ModalDetailRow label="Exported To"  value={asset.to || "—"} />
          <ModalDetailRow label="Exported By"  value={asset.exportedBy || "—"} />
          <ModalDetailRow label="Date"         value={formatDate(asset.date)} />
          <ModalDetailRow label="Total Assets" value={String(asset.count)} />
          {asset.idNo && <ModalDetailRow label="ID No" value={asset.idNo} />}

          {asset.assets?.length > 0 && (
            <div className="pcl-modal-sn-section">
              <span className="pcl-modal-label">Assets Detail</span>
              <ul className="pcl-sn-list pcl-sn-list-rich">
                {asset.assets.map((a, idx) => (
                  <li key={a.id || idx} className="pcl-sn-item-rich">
                    <div className="pcl-sn-photo-cell">
                      {a.individualPhoto
                        ? (
                          <ClickableImage
                            src={a.individualPhoto}
                            alt={a.serialNo}
                            className="pcl-sn-indiv-photo"
                          />
                        )
                        : <div className="pcl-sn-no-photo">No Photo</div>
                      }
                    </div>
                    <div className="pcl-sn-asset-detail">
                      <div className="pcl-sn-asset-name">
                        {getParcelAssetDisplayName(a, asset.category)}
                      </div>
                      {formatParcelBrandModel(a, asset.category) !== "—" && (
                        <div className="pcl-sn-asset-brand">
                          {formatParcelBrandModel(a, asset.category)}
                        </div>
                      )}
                      <span className="pcl-sn-code">{a.serialNo || "—"}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!asset.assets?.length && serialNumbers.length > 0 && (
            <div className="pcl-modal-sn-section">
              <span className="pcl-modal-label">Serial Numbers</span>
              <ul className="pcl-sn-list pcl-sn-list-rich">
                {serialNumbers.map((sn) => (
                  <li key={sn} className="pcl-sn-item-rich">
                    <div className="pcl-sn-photo-cell">
                      {photoBySerial[sn]
                        ? (
                          <ClickableImage
                            src={photoBySerial[sn]}
                            alt={sn}
                            className="pcl-sn-indiv-photo"
                          />
                        )
                        : <div className="pcl-sn-no-photo">No Photo</div>
                      }
                    </div>
                    <span className="pcl-sn-code">{sn}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ModalPhotoGrid photos={asset.photos} label="Parcel Photos" />
        </div>
      </div>
    </ModalBackdrop>
  );
}

/** Imported asset detail modal — shows Received By */
function ImportDetailsModal({ asset, onClose }) {
  if (!asset) return null;
  return (
    <ModalBackdrop className="pcl-modal-backdrop" onClose={onClose}>
      <div className="pcl-modal pcl-detail-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <ModalHeader title={asset.assetName} subtitle={asset.id} onClose={onClose} />
        <div className="pcl-modal-body">
          <ModalDetailRow label="From"        value={asset.from || "—"} />
          <ModalDetailRow label="Received By" value={asset.receivedBy || "—"} />
          <ModalDetailRow label="Date"        value={formatDate(asset.date)} />
          <ModalDetailRow label="Count"       value={String(asset.count)} />
          {asset.idNo && <ModalDetailRow label="ID No" value={asset.idNo} />}
          <ModalPhotoGrid photos={asset.photos} label="Photos" />
        </div>
      </div>
    </ModalBackdrop>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Parcel() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("tab") === "log" ? "log" : "parcels";
  const isLog = view === "log";

  const [importedData, setImportedData] = useState([]);
  const [exportedData, setExportedData] = useState([]);
  const [activeTab,         setActiveTab]         = useState("imported");
  const [exportCategory,    setExportCategory]    = useState("All");
  const [search,            setSearch]            = useState("");
  const [page,              setPage]              = useState(1);

  const [detailAsset,   setDetailAsset]   = useState(null);
  const [importDetail,  setImportDetail]  = useState(null);
  const [photoPreview,  setPhotoPreview]  = useState(null);

  useEffect(() => {
    if (isLog) return;
    setActiveTab("imported");
    setExportCategory("All");
    setSearch("");
    setPage(1);
  }, [isLog]);

  const setView = useCallback(
    (next) => {
      if (next === "log") setSearchParams({ tab: "log" });
      else setSearchParams({});
    },
    [setSearchParams],
  );

  // ── Data loading ───────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    try {
      await syncParcelsFromAPI();
    } catch (err) {
      console.error("[ParcelDashboard] API sync failed, using cached parcels:", err);
      toastITApiFailure(
          err,
          "Could not sync parcels from the server. Showing cached data.",
        );
    }
    setImportedData(readImported());
    setExportedData(readExported());
  }, []);

  useRefreshOnNavigate(loadData);

  useEffect(() => {
    window.addEventListener("inventory-updated", loadData);
    window.addEventListener("storage", loadData);
    return () => {
      window.removeEventListener("inventory-updated", loadData);
      window.removeEventListener("storage", loadData);
    };
  }, [loadData]);

  // ── Derived state ──────────────────────────────────────────────────────────
  const rawData = activeTab === "exported" ? exportedData : importedData;

  const exportCountByCategory = useMemo(() => {
    const counts = Object.fromEntries(
      EXPORT_CATEGORY_FILTERS.map((c) => [c.id, 0])
    );
    exportedData.forEach((r) => {
      const cat = r.category || "";
      if (counts[cat] !== undefined) counts[cat]++;
      counts.All++;
    });
    return counts;
  }, [exportedData]);

  const filtered = useMemo(() => {
    let rows = rawData;
    if (activeTab === "exported" && exportCategory !== "All") {
      rows = rows.filter((r) => r.category === exportCategory);
    }
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(
      (r) =>
        String(r.assetName ?? "").toLowerCase().includes(q) ||
        String(r.id ?? "").toLowerCase().includes(q) ||
        String(r.idNo ?? "").toLowerCase().includes(q) ||
        String(r.from || r.to || "").toLowerCase().includes(q) ||
        String(r.receivedBy ?? "").toLowerCase().includes(q) ||
        String(r.exportedBy ?? "").toLowerCase().includes(q) ||
        String(r.category ?? "").toLowerCase().includes(q)
    );
  }, [rawData, search, activeTab, exportCategory]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const paginated  = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleTabChange = useCallback((tab) => {
    setActiveTab(tab);
    setExportCategory("All");
    setSearch("");
    setPage(1);
  }, []);

  const handleExportCategoryChange = useCallback((catId) => {
    setExportCategory(catId);
    setPage(1);
  }, []);

  const handleSearchChange = (e) => {
    setSearch(e.target.value);
    setPage(1);
  };

  const openDetailModal = (row) => {
    if (activeTab === "exported") setDetailAsset(row);
    else setImportDetail(row);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="pcl-page">

      {/* Top Bar */}
      <div className="pcl-topbar">
        <button type="button" className="pcl-back-btn" onClick={() => navigate("/it/inventory")}>
          ← Back to Inventory Management
        </button>
        <div className="pcl-topbar-right">
          <div className="pcl-title-block">
            <h1 className="pcl-title">Parcels</h1>
            <p className="pcl-subtitle">
              {isLog
                ? "Activity log for parcel import and export only"
                : "Add imports and prepare assets for export"}
            </p>
          </div>
          <div className="pcl-view-switch" role="tablist" aria-label="Parcels sections">
            <button
              type="button"
              role="tab"
              aria-selected={!isLog}
              className={`pcl-view-btn${!isLog ? " active" : ""}`}
              onClick={() => setView("parcels")}
            >
              Parcels
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isLog}
              className={`pcl-view-btn${isLog ? " active" : ""}`}
              onClick={() => setView("log")}
            >
              Parcel Log
            </button>
          </div>
        </div>
      </div>

      {isLog ? (
        <ActivityLogPage defaultScope="parcel" embedded />
      ) : (
        <>
      {/* Tab + Action Row */}
      <div className="pcl-tab-action-row">
        <div className="pcl-tabs">
          <button
            type="button"
            className={`pcl-tab${activeTab === "imported" ? " active" : ""}`}
            onClick={() => handleTabChange("imported")}
          >
            📥 Imported
            <span className="pcl-tab-badge">{importedData.length}</span>
          </button>
          <button
            type="button"
            className={`pcl-tab${activeTab === "exported" ? " active" : ""}`}
            onClick={() => handleTabChange("exported")}
          >
            📤 Exported
            <span className="pcl-tab-badge">{exportedData.length}</span>
          </button>
        </div>

        <div className="pcl-actions">
          <button
            type="button"
            className="pcl-btn-import"
            onClick={() => navigate("/it/inventory/add-import")}
          >
            + Add in Import
          </button>
          <button
            type="button"
            className="pcl-btn-export"
            onClick={() => navigate("/it/inventory/ready-export")}
          >
            ✈ Ready for Export
          </button>
        </div>
      </div>

      {activeTab === "exported" && (
        <div className="pcl-export-cat-filters">
          {EXPORT_CATEGORY_FILTERS.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`pcl-export-cat-btn${exportCategory === cat.id ? " active" : ""}`}
              onClick={() => handleExportCategoryChange(cat.id)}
            >
              {cat.label}
              <span className="pcl-export-cat-count">
                {exportCountByCategory[cat.id] ?? 0}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="pcl-search-row">
        <div className="pcl-search-wrap">
          <span className="pcl-search-icon" aria-hidden>⌕</span>
          <input
            className="pcl-search-input"
            placeholder={`Search ${activeTab} parcels...`}
            value={search}
            onChange={handleSearchChange}
            aria-label="Search parcels"
          />
          {search && (
            <button
              type="button"
              className="pcl-search-clear"
              onClick={() => { setSearch(""); setPage(1); }}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <span className="pcl-result-count">
          {filtered.length} record{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="pcl-table-card">
        <div className="pcl-table-wrap pcl-table-wrap--scroll">
          <table className="pcl-table">
            <thead className="pcl-thead-sticky">
              <tr>
                <th className="pcl-th-sticky">Assets Name</th>
                <th className="pcl-th-sticky">Count</th>
                <th className="pcl-th-sticky">
                  {activeTab === "imported" ? "From" : "To"}
                </th>
                <th className="pcl-th-sticky">Date</th>
                <th className="pcl-th-sticky">ID No</th>
                <th className="pcl-th-sticky">
                  {activeTab === "imported" ? "Received By" : "Exported By"}
                </th>
                <th className="pcl-th-sticky">View Details</th>
                <th className="pcl-th-sticky">Photos</th>
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr>
                  <td colSpan={8} className="pcl-empty">
                    {rawData.length === 0
                      ? activeTab === "imported"
                        ? 'No imported parcels yet. Use "+ Add in Import" to add records.'
                        : "No exported parcels yet. Export assets to see them here."
                      : activeTab === "exported" && exportCategory !== "All"
                        ? `No exported parcels in ${EXPORT_CATEGORY_FILTERS.find((c) => c.id === exportCategory)?.label || exportCategory}.`
                        : `No ${activeTab} parcels match your search.`}
                  </td>
                </tr>
              ) : (
                paginated.map((row) => {
                  const handledBy =
                    activeTab === "imported" ? row.receivedBy : row.exportedBy;
                  return (
                  <tr key={`${activeTab}-${row.id}`} className="pcl-row">
                    <td className="pcl-asset-name">{row.assetName}</td>
                    <td>
                      <span className="pcl-count-badge">{row.count}</span>
                    </td>
                    <td className="pcl-from-to">{row.from || row.to || "—"}</td>
                    <td className="pcl-date">{formatDate(row.date)}</td>
                    <td>
                      {row.idNo ? (
                        <span className="pcl-id-chip pcl-id-chip--custom" title={`System ID: ${row.id}`}>
                          {row.idNo}
                        </span>
                      ) : (
                        <span className="pcl-id-chip pcl-id-chip--system">{row.id}</span>
                      )}
                    </td>
                    <td className="pcl-tracked-by">
                      {handledBy
                        ? <span className="pcl-tracked-by-chip">{handledBy}</span>
                        : <span className="pcl-no-photos">—</span>}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="pcl-btn-view"
                        onClick={() => openDetailModal(row)}
                      >
                        View Details
                      </button>
                    </td>
                    <td>
                      {row.photos?.length > 0 ? (
                        <button
                          type="button"
                          className="pcl-btn-photos"
                          onClick={() => setPhotoPreview({
                            photos: row.photos,
                            title: row.assetName || "Parcel Photos",
                          })}
                          title="View parcel photos"
                        >
                          📷 {row.photos.length}
                        </button>
                      ) : (
                        <span className="pcl-no-photos">—</span>
                      )}
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="pcl-pagination">
            <button
              type="button"
              className="pcl-page-btn"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ← Prev
            </button>
            <span className="pcl-page-info">Page {page} of {totalPages}</span>
            <button
              type="button"
              className="pcl-page-btn"
              disabled={page === totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        )}
      </div>

      {/* Modals */}
      <DetailsModal       asset={detailAsset}  onClose={() => setDetailAsset(null)}  />
      <ImportDetailsModal asset={importDetail}  onClose={() => setImportDetail(null)} />
      <PhotoGalleryModal
        photos={photoPreview?.photos}
        title={photoPreview?.title}
        onClose={() => setPhotoPreview(null)}
      />
        </>
      )}
    </div>
  );
}


