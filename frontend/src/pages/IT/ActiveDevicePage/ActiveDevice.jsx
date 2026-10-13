import { useState, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useRefreshOnNavigate } from "../../../hooks/useRefreshOnNavigate";
import { useIncrementalList } from "../../../hooks/useIncrementalList";
import ShowMoreRows from "../../../components/ShowMoreRows";
import {
  getEmployees,
  getAssetUnitsFromStorage,
  toastITApiFailure,
  syncITDataFromAPI,
  IT_NAV_SYNC_MAX_AGE_MS,
} from "../Data";
import { UserAvatar } from "../../../components/UserAvatar";
import { getUserPhotoUrl } from "../../../utils/userPhoto";
import ClickableImage from "../../../components/ClickableImage";
import "./ActiveDevice.css";
import { formatDate as fmt } from "../../../utils/dateFormat";
import {
  getAssetCodeField,
  getHardwareFields,
  getMobileTabletHardwareFields,
  isLaptopHardwareRow,
  isMobileTabletHwType,
} from "../inventoryCategories";

// ─── Constants ────────────────────────────────────────────────────────────────
const ASSET_CATEGORIES = ["Hardware", "Accessories", "Consumables"];
const TABS = ["All", ...ASSET_CATEGORIES];
const CAT_ICONS = {
  All: "📋",
  Hardware: "🖥",
  Accessories: "🖱",
  Consumables: "🖨",
};

const normCat = (c) => {
  if (!c) return "Hardware";
  if (c === "Consumable") return "Consumables";
  return c;
};

/** Laptop Code is stored on unit.model (form label); fall back to unit_code. */
function resolveLaptopCode(unit) {
  const fromModel = String(unit?.model || "").trim();
  if (fromModel && fromModel !== "—") return fromModel;
  const fromCode = String(unit?.unitCode || unit?.unit_code || unit?.assetId || "").trim();
  return fromCode && fromCode !== "—" ? fromCode : "";
}

/** Prefer IMEI 1, else IMEI 2. */
function resolveImei(unit) {
  const imei1 = String(unit?.imei1 || "").trim();
  if (imei1) return imei1;
  const imei2 = String(unit?.imei2 || "").trim();
  return imei2 || "";
}

function findEmployeeById(empId) {
  if (!empId || empId === "—") return null;
  const key = String(empId).toUpperCase();
  return (
    (getEmployees() || []).find(
      (e) => String(e.empId || e.id || "").toUpperCase() === key,
    ) || null
  );
}

function buildDeviceDetailRows(asset) {
  const cat = String(asset?.category || "").trim().toLowerCase();
  const hwType = asset?.hwType || null;
  const mobileTablet = isMobileTabletHwType(hwType);
  const baseFields = getHardwareFields("IT Assets", "Hardware", hwType);
  const hwFields = mobileTablet
    ? getMobileTabletHardwareFields(baseFields)
    : baseFields;
  const codeField = getAssetCodeField(hwType || "Laptop");

  if (cat === "accessories" || cat === "consumables") {
    return [
      { label: "Asset ID", value: asset.id, mono: true },
      { label: "Category", value: asset.category },
      { label: "Quantity", value: asset.serialNumber },
      { label: "Asset Name", value: asset.name },
      { label: "Assigned Date", value: fmt(asset.assignedDate) },
    ];
  }

  const rows = [
    { label: "Asset ID", value: asset.id, mono: true },
    { label: "Category", value: asset.category },
    ...(hwType ? [{ label: "Type", value: hwType }] : []),
    { label: hwFields.brand?.label || "Brand", value: asset.brand },
    {
      label: hwFields.make?.label || "Make",
      value: asset.make || (mobileTablet ? asset.model : ""),
    },
  ];

  if (isLaptopHardwareRow(asset) || (!mobileTablet && hwType)) {
    rows.push({
      label: codeField.label,
      value: asset.laptopCode || asset.model,
      mono: true,
    });
  }

  rows.push({
    label: hwFields.serialNumber?.label || "Serial Number",
    value: asset.serialNumber,
    mono: true,
  });

  if (mobileTablet) {
    rows.push(
      { label: "IMEI 1", value: asset.imei1, mono: true },
      { label: "IMEI 2", value: asset.imei2, mono: true },
      {
        label: hwFields.projectCode?.label || "Project Code",
        value: asset.projectCode,
      },
      {
        label: hwFields.deviceLocation?.label || "Device Location",
        value: asset.deviceLocation,
      },
    );
  }

  rows.push({ label: "Assigned Date", value: fmt(asset.assignedDate) });
  rows.push({ label: "Status", value: asset.status || "Assigned" });
  return rows;
}

function buildAssigneeDetailRows(employee) {
  return [
    { label: "Email", value: employee?.email },
    { label: "Type", value: employee?.type },
    { label: "Circle", value: employee?.circle },
    { label: "Department", value: employee?.department || employee?.dept },
    { label: "Designation", value: employee?.designation || employee?.role },
    { label: "Phone", value: employee?.phone || employee?.mobile },
  ].filter((row) => row.value && String(row.value).trim() && String(row.value) !== "—");
}

function AssignmentDetailModal({ asset, employee, onClose }) {
  const [photoIdx, setPhotoIdx] = useState(0);
  const photos = Array.isArray(asset?.photos) ? asset.photos.filter(Boolean) : [];
  const deviceRows = buildDeviceDetailRows(asset);
  const userRows = buildAssigneeDetailRows(employee);
  const photo = getUserPhotoUrl(employee) || asset?.assigneePhoto || "";

  return createPortal(
    <div
      className="asd-detail-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className="asd-detail-panel"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="asd-detail-title"
      >
        <div className="asd-detail-header">
          <div>
            <p className="asd-detail-kicker">Assignment Details</p>
            <h2 id="asd-detail-title" className="asd-detail-title">
              {asset?.name || "Asset"}
            </h2>
            <div className="asd-detail-badges">
              <span className="asd-cat-pill">{asset?.category || "—"}</span>
              {asset?.hwType ? (
                <span className="asd-detail-badge">{asset.hwType}</span>
              ) : null}
              <span className="asd-detail-badge asd-detail-badge--status">
                {asset?.status || "Assigned"}
              </span>
            </div>
          </div>
          <button type="button" className="asd-detail-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="asd-detail-body">
          <section className="asd-detail-section">
            <h3 className="asd-detail-section-title">Device</h3>
            <div className="asd-detail-list">
              {deviceRows.map(({ label, value, mono }) => (
                <div key={label} className="asd-detail-row">
                  <span className="asd-detail-label">{label}</span>
                  <span className={`asd-detail-value${mono ? " mono" : ""}`}>
                    {value && String(value).trim() ? value : "—"}
                  </span>
                </div>
              ))}
            </div>
            {photos.length > 0 ? (
              <div className="asd-detail-photos">
                <ClickableImage
                  src={photos[photoIdx]}
                  alt={asset?.name || "Asset"}
                  className="asd-detail-photo-main"
                />
                {photos.length > 1 ? (
                  <div className="asd-detail-photo-nav">
                    <button
                      type="button"
                      onClick={() =>
                        setPhotoIdx((i) => (i - 1 + photos.length) % photos.length)
                      }
                    >
                      ‹
                    </button>
                    <span>
                      {photoIdx + 1} / {photos.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPhotoIdx((i) => (i + 1) % photos.length)}
                    >
                      ›
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="asd-detail-section">
            <h3 className="asd-detail-section-title">Assigned To</h3>
            <div className="asd-detail-user-card">
              <UserAvatar
                name={employee?.name || asset?.assignedTo || "—"}
                photo={photo}
                className="asd-detail-user-avatar"
                as="span"
                alt={employee?.name || asset?.assignedTo || ""}
              />
              <div>
                <p className="asd-detail-user-name">
                  {employee?.name || asset?.assignedTo || "—"}
                </p>
                <p className="asd-detail-user-id">
                  {employee?.empId || employee?.id || asset?.empId || "—"}
                </p>
              </div>
            </div>
            <div className="asd-detail-list">
              {userRows.length === 0 ? (
                <div className="asd-detail-row">
                  <span className="asd-detail-label">Employee ID</span>
                  <span className="asd-detail-value mono">
                    {employee?.empId || employee?.id || asset?.empId || "—"}
                  </span>
                </div>
              ) : (
                userRows.map(({ label, value, mono }) => (
                  <div key={label} className="asd-detail-row">
                    <span className="asd-detail-label">{label}</span>
                    <span className={`asd-detail-value${mono ? " mono" : ""}`}>
                      {value}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="asd-detail-footer">
          <button type="button" className="asd-detail-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Build merged active-device list (localStorage only) ─────────────────────
/** First employee (list order) per upper-cased empId — same pick as `employees.find`. */
function buildEmployeeByIdIndex(employees) {
  const byId = new Map();
  for (const e of employees) {
    const key = String(e.empId || e.id || "").toUpperCase();
    if (!byId.has(key)) byId.set(key, e);
  }
  return byId;
}

function resolveAssigneePhoto(employeesById, empId, assignedToObj) {
  if (assignedToObj && typeof assignedToObj === "object") {
    const fromObj = getUserPhotoUrl(assignedToObj);
    if (fromObj) return fromObj;
  }
  const key = String(empId || "").toUpperCase();
  if (!key || key === "—") return "";
  const match = employeesById.get(key);
  return match ? getUserPhotoUrl(match) : "";
}

function getMergedActiveDevices() {
  const employees = getEmployees() || [];
  const employeesById = buildEmployeeByIdIndex(employees);

  // 1. Individual hardware units that have been assigned (via AddEmployee)
  const units = (getAssetUnitsFromStorage() || [])
    .filter((u) => {
      const cat = normCat(u.category);
      return (
        u.status === "assigned" && u.assignedTo && ASSET_CATEGORIES.includes(cat)
      );
    })
    .map((u) => {
      const isObj = typeof u.assignedTo === "object" && u.assignedTo !== null;
      const empId = isObj ? u.assignedTo.empId || u.assignedTo.id || "—" : "—";
      const assignedTo = isObj
        ? u.assignedTo.name || String(u.assignedTo)
        : String(u.assignedTo);

      // ── KEY FIX ──────────────────────────────────────────────────────────
      // assetTag  → shown as "Asset ID" (the human-readable tag like HW-001)
      // assetId   → internal inventory reference (fallback)
      // id        → unit's own UUID (last fallback)
      // serialNumber → always its own separate field
      const assetId =
        u.assetTag ||          // prefer the asset tag as the display "Asset ID"
        u.assetId ||           // inventory-level ID
        u.id ||                // unit UUID
        "—";

      const serialNumber =
        u.serialNumber && u.serialNumber !== assetId
          ? u.serialNumber      // only use if it differs from assetId
          : u.serialNumber || "—";

      const hwType = u.hwType || null;
      const photos =
        Array.isArray(u.assignmentPhotos) && u.assignmentPhotos.length
          ? u.assignmentPhotos
          : Array.isArray(u.photos)
            ? u.photos
            : [];
      return {
        id: assetId,
        serialNumber,
        name: u.assetName || u.name || "—",
        category: normCat(u.category),
        hwType,
        brand: u.brand || "",
        make: u.make || "",
        model: u.model || "",
        laptopCode: resolveLaptopCode(u),
        imei: resolveImei(u),
        imei1: u.imei1 || null,
        imei2: u.imei2 || null,
        projectCode: u.projectCode || u.project_code || "",
        deviceLocation: u.deviceLocation || u.device_location || "",
        status: u.status || "Assigned",
        photos,
        assignedTo,
        assigneePhoto: resolveAssigneePhoto(employeesById, empId, isObj ? u.assignedTo : null),
        assignedDate:
          u.assignedDate || u.repairDate || new Date().toISOString(),
        empId,
        // keep raw unit id for dedup
        _unitId: u.id,
      };
    });

  // 3. Quantity-based assignments (Accessories / Consumables) from employee assignedAssets.
  // These do not always exist as unit rows, so include them explicitly.
  const quantityAssets = [];
  for (const emp of employees) {
    const empId = String(emp.empId || emp.id || "—");
    const assignedTo = String(emp.name || "—");
    for (const a of emp.assignedAssets || []) {
      const cat = normCat(a.category);
      if (cat !== "Accessories" && cat !== "Consumables") continue;
      const qty = Math.max(1, Number(a.quantity) || 1);
      const baseName = a.name || "Inventory item";
      quantityAssets.push({
        id: `INV-${a.inventoryId || a.inventoryAssignmentId || a.id || baseName}`,
        serialNumber: qty > 1 ? `Qty ${qty}` : "Qty 1",
        name: qty > 1 ? `${baseName} (x${qty})` : baseName,
        category: cat,
        status: "Assigned",
        photos: [],
        assignedTo,
        assigneePhoto: getUserPhotoUrl(emp),
        assignedDate: a.assignedDate || new Date().toISOString(),
        empId,
        _unitId: `inv-${empId}-${a.inventoryId || a.inventoryAssignmentId || a.id || baseName}-${qty}`,
      });
    }
  }

  // Deduplicate by unique source key
  const seen = new Set();
  return [...units, ...quantityAssets].filter((d) => {
    const key = d._unitId || d.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ActiveDevice({ onBack }) {
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState("All");
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [detailView, setDetailView] = useState(null);

  const syncDevices = useCallback(() => {
    syncITDataFromAPI({ maxAgeMs: IT_NAV_SYNC_MAX_AGE_MS })
      .then(() => setRefreshKey((k) => k + 1))
      .catch((err) => {
        console.error("[ActiveDevice] API sync failed, using cached data:", err);
        toastITApiFailure(
            err,
            "Could not refresh devices from the server. Showing cached assignments.",
          );
        setRefreshKey((k) => k + 1);
      });
  }, []);

  useRefreshOnNavigate(syncDevices);

  const allDevices = useMemo(() => getMergedActiveDevices(), [refreshKey]);

  const filtered = useMemo(() => {
    let r =
      activeTab === "All"
        ? allDevices
        : allDevices.filter((a) => a.category === activeTab);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      r = r.filter(
        (a) =>
          String(a.id ?? "").toLowerCase().includes(q) ||
          String(a.serialNumber ?? "").toLowerCase().includes(q) ||
          String(a.name ?? "").toLowerCase().includes(q) ||
          String(a.assignedTo ?? "").toLowerCase().includes(q) ||
          String(a.empId ?? "").toLowerCase().includes(q),
      );
    }
    return r;
  }, [allDevices, activeTab, searchQuery]);

  const tableRows = useIncrementalList(filtered, `${activeTab}|${searchQuery}`);

  const handleSearch = () => setSearchQuery(search);
  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleSearch();
  };

  const handleView = (empId, assetRow) => {
    if (!assetRow) return;

    // Prefer live unit data when this row maps to a real hardware unit.
    let enriched = { ...assetRow };
    const unitId = assetRow._unitId;
    if (unitId != null && !String(unitId).startsWith("inv-")) {
      const unit = (getAssetUnitsFromStorage() || []).find(
        (u) => String(u.id) === String(unitId),
      );
      if (unit) {
        const photos =
          Array.isArray(unit.assignmentPhotos) && unit.assignmentPhotos.length
            ? unit.assignmentPhotos
            : Array.isArray(unit.photos)
              ? unit.photos
              : [];
        enriched = {
          ...enriched,
          brand: unit.brand || enriched.brand || "",
          make: unit.make || enriched.make || "",
          model: unit.model || enriched.model || "",
          laptopCode: resolveLaptopCode(unit) || enriched.laptopCode,
          imei: resolveImei(unit) || enriched.imei,
          imei1: unit.imei1 || enriched.imei1 || null,
          imei2: unit.imei2 || enriched.imei2 || null,
          projectCode:
            unit.projectCode || unit.project_code || enriched.projectCode || "",
          deviceLocation:
            unit.deviceLocation ||
            unit.device_location ||
            enriched.deviceLocation ||
            "",
          hwType: unit.hwType || enriched.hwType,
          status: unit.status || enriched.status || "Assigned",
          serialNumber: unit.serialNumber || enriched.serialNumber,
          photos,
        };
      }
    }

    const employee =
      findEmployeeById(empId) ||
      (empId && empId !== "—"
        ? {
            empId,
            id: empId,
            name: assetRow.assignedTo,
            photo: assetRow.assigneePhoto || "",
          }
        : null);

    setDetailView({ asset: enriched, employee });
  };

  const handleBack = () => {
    if (onBack) onBack();
    else navigate(-1);
  };

  const secondColHeader =
    activeTab === "Accessories" || activeTab === "Consumables"
      ? "Quantity"
      : activeTab === "All"
        ? "Serial / Qty"
        : "Serial No.";

  // Extra identity columns only on All / Hardware (do not affect Accessories/Consumables).
  const showDeviceCodeCols = activeTab === "All" || activeTab === "Hardware";
  const showLaptopCodeCol =
    showDeviceCodeCols && filtered.some((a) => isLaptopHardwareRow(a));
  const showImeiCol =
    showDeviceCodeCols &&
    filtered.some(
      (a) =>
        String(a?.category || "").trim().toLowerCase() === "hardware" &&
        isMobileTabletHwType(a?.hwType),
    );

  const tableColSpan =
    (activeTab === "All" ? 7 : 6) +
    (showLaptopCodeCol ? 1 : 0) +
    (showImeiCol ? 1 : 0);

  return (
    <>
    <div className="asd-page">
      <div className="asd-container">
        {/* ── Top Bar ── */}
        <div className="asd-topbar">
          <div className="asd-topbar-left">
            <button type="button" className="asd-back-btn" onClick={handleBack}>
              ← Back
            </button>
            <div className="asd-tabs">
              {TABS.map((cat) => (
                <button
                  key={cat}
                  className={`asd-tab ${activeTab === cat ? "active" : ""}`}
                  onClick={() => {
                    setActiveTab(cat);
                    setSearch("");
                    setSearchQuery("");
                  }}
                >
                  <span className="asd-tab-icon">{CAT_ICONS[cat]}</span>
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <div className="asd-search-row">
            <div className="asd-search-wrap">
              <input
                className="asd-search-input"
                placeholder="Search by Asset ID / Serial No. / Asset Name"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              {search && (
                <button
                  className="asd-search-clear"
                  onClick={() => {
                    setSearch("");
                    setSearchQuery("");
                  }}
                >
                  ×
                </button>
              )}
            </div>
            <button className="asd-search-btn" onClick={handleSearch}>
              Search
            </button>
          </div>
        </div>

        {/* ── Table Card ── */}
        <div className="asd-table-card">
          <div className="asd-table-head-bar">
            <div className="asd-table-head-left">
              <span className="asd-table-icon">{CAT_ICONS[activeTab]}</span>
              <span className="asd-table-title">
                {activeTab === "All" ? "All" : activeTab} Assets
              </span>
            </div>
            <span className="asd-table-count">
              {filtered.length} record{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>

          <div className="asd-table-scroll it-m-scroll--cards">
            <table className="asd-table">
              <thead>
                <tr>
                  <th>Asset ID</th>
                  {activeTab === "All" && <th>Category</th>}
                  <th>{secondColHeader}</th>
                  {showLaptopCodeCol && <th>Laptop Code</th>}
                  {showImeiCol && <th>IMEI</th>}
                  <th>Asset Name</th>
                  <th>Assigned To</th>
                  <th>Assigned Date</th>
                  <th>View</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={tableColSpan} className="asd-empty">
                      <div className="asd-empty-inner">
                        <span>🔍</span>
                        <p>No assets found</p>
                        {searchQuery && (
                          <span className="asd-empty-hint">
                            Try clearing the search
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  tableRows.visible.map((asset, i) => (
                    <tr
                      key={(asset._unitId || asset.id) + i}
                      className={`asd-row ${
                        i % 2 === 0 ? "asd-row-even" : "asd-row-odd"
                      }`}
                    >
                      {/* Asset ID */}
                      <td data-label="Asset ID">
                        <span className="asd-asset-id">{asset.id}</span>
                      </td>
                      {activeTab === "All" && (
                        <td data-label="Category">
                          <span className="asd-cat-pill">{asset.category}</span>
                        </td>
                      )}
                      <td data-label="Serial">
                        <span className="asd-asset-id">{asset.serialNumber}</span>
                      </td>
                      {showLaptopCodeCol && (
                        <td data-label="Laptop Code">
                          <span className="asd-asset-id">
                            {isLaptopHardwareRow(asset)
                              ? asset.laptopCode || "—"
                              : "—"}
                          </span>
                        </td>
                      )}
                      {showImeiCol && (
                        <td data-label="IMEI">
                          <span className="asd-asset-id">
                            {String(asset?.category || "")
                              .trim()
                              .toLowerCase() === "hardware" &&
                            isMobileTabletHwType(asset?.hwType)
                              ? asset.imei || "—"
                              : "—"}
                          </span>
                        </td>
                      )}
                      <td className="asd-asset-name" data-label="Asset Name">{asset.name}</td>
                      <td data-label="Assignee">
                        <div className="asd-assignee">
                          <UserAvatar
                            name={asset.assignedTo}
                            photo={asset.assigneePhoto}
                            className="asd-assignee-avatar"
                            as="span"
                            alt={asset.assignedTo}
                          />
                          <div className="asd-assignee-info">
                            <span className="asd-assignee-name">
                              {asset.assignedTo}
                            </span>
                            <span className="asd-assignee-id">
                              {asset.empId}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="asd-date" data-label="Assigned">{fmt(asset.assignedDate)}</td>
                      <td data-label="Action">
                        <button
                          className="asd-view-btn"
                          onClick={() => handleView(asset.empId, asset)}
                          title="View assignment details"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))
                )}
                <ShowMoreRows list={tableRows} colSpan={tableColSpan} />
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    {detailView ? (
      <AssignmentDetailModal
        asset={detailView.asset}
        employee={detailView.employee}
        onClose={() => setDetailView(null)}
      />
    ) : null}
    </>
  );
}


// import { useState, useMemo } from "react";
// import { useNavigate } from "react-router-dom";
// import { getEmployees, saveEmployees, getAssetUnitsFromStorage } from "../Data";
// import "./ActiveDevice.css";

// // ─── Constants ────────────────────────────────────────────────────────────────
// const CATEGORIES = ["Hardware", "Accessories", "Consumables"];
// const CAT_ICONS = { Hardware: "🖥", Accessories: "🖱", Consumables: "🖨" };

// const fmt = (iso) => {
//   if (!iso) return "—";
//   const d = new Date(iso);
//   if (isNaN(d)) return iso;
//   return d.toLocaleDateString("en-IN", {
//     day: "2-digit",
//     month: "short",
//     year: "numeric",
//   });
// };

// const normCat = (c) => {
//   if (!c) return "Hardware";
//   if (c === "Consumable") return "Consumables";
//   return c;
// };

// // ─── Build merged active-device list (localStorage only) ─────────────────────
// function getMergedActiveDevices() {
//   // 1. Individual hardware units that have been assigned (via AddEmployee)
//   const units = (getAssetUnitsFromStorage() || [])
//     .filter((u) => {
//       const cat = normCat(u.category);
//       return (
//         u.status === "assigned" && u.assignedTo && CATEGORIES.includes(cat)
//       );
//     })
//     .map((u) => {
//       const isObj = typeof u.assignedTo === "object" && u.assignedTo !== null;
//       const empId = isObj ? u.assignedTo.empId || u.assignedTo.id || "—" : "—";
//       const assignedTo = isObj
//         ? u.assignedTo.name || String(u.assignedTo)
//         : String(u.assignedTo);
//       return {
//         id: u.assetId || u.id,
//         name: u.assetName || u.name,
//         category: normCat(u.category),
//         assignedTo,
//         assignedDate:
//           u.assignedDate || u.repairDate || new Date().toISOString(),
//         empId,
//       };
//     });

//   // 2. pcl_assigned_assets (written by AddEmployee save flow)
//   const pcl = JSON.parse(localStorage.getItem("pcl_assigned_assets") || "[]")
//     .filter((a) => {
//       const cat = normCat(a.category);
//       return a.category !== "Software" && CATEGORIES.includes(cat);
//     })
//     .map((a) => ({
//       id: a.assetInventoryId || a.id,
//       name: a.name,
//       category: normCat(a.category),
//       assignedTo: a.empName || "—",
//       assignedDate: a.assignedDate || new Date().toISOString(),
//       empId: a.empId || "—",
//     }));

//   // Deduplicate by id — prefer pcl entries over unit entries
//   const seen = new Set();
//   return [...units, ...pcl].filter((d) => {
//     if (seen.has(d.id)) return false;
//     seen.add(d.id);
//     return true;
//   });
// }

// // ─── Main Component ───────────────────────────────────────────────────────────
// export default function ActiveDevice({ onBack }) {
//   const navigate = useNavigate();

//   const [activeTab, setActiveTab] = useState("Hardware");
//   const [search, setSearch] = useState("");
//   const [searchQuery, setSearchQuery] = useState("");

//   const allDevices = getMergedActiveDevices();

//   const filtered = useMemo(() => {
//     let r = allDevices.filter((a) => a.category === activeTab);
//     if (searchQuery.trim()) {
//       const q = searchQuery.toLowerCase();
//       r = r.filter(
//         (a) =>
//           a.id.toLowerCase().includes(q) ||
//           a.name.toLowerCase().includes(q) ||
//           a.assignedTo.toLowerCase().includes(q) ||
//           a.empId.toLowerCase().includes(q),
//       );
//     }
//     return r;
//   }, [allDevices, activeTab, searchQuery]);

//   const handleSearch = () => setSearchQuery(search);
//   const handleKeyDown = (e) => {
//     if (e.key === "Enter") handleSearch();
//   };

//   // ✅ Fixed: guard against missing empId, navigate to IT-specific route
//   const handleView = (empId, assetRow) => {
//     if (!empId || empId === "—") {
//       alert("No employee ID is linked to this asset.");
//       return;
//     }

//     let employee = getEmployees().find(
//       (e) => (e.id || e.empId || "").toUpperCase() === empId.toUpperCase(),
//     );

//     if (!employee && assetRow) {
//       employee = {
//         id: empId,
//         empId,
//         name: assetRow.assignedTo,
//         type: "—",
//         circle: "—",
//         email: "—",
//         photo: "",
//         activated: true,
//         assignedAssets: [],
//       };
//     }

//     // ✅ Navigate to the IT employee details route
//     navigate(`/it/employee/${empId}`, {
//       state: { employee: employee || null },
//     });
//   };

//   const handleBack = () => {
//     if (onBack) onBack();
//     else navigate(-1);
//   };

//   return (
//     <div className="asd-page">
//       <div className="asd-container">
//         {/* ── Top Bar ── */}
//         <div className="asd-topbar">
//           <div className="asd-topbar-left">
//             <button className="asd-back-btn" onClick={handleBack}>
//               ← Back
//             </button>
//             <div className="asd-tabs">
//               {CATEGORIES.map((cat) => (
//                 <button
//                   key={cat}
//                   className={`asd-tab ${activeTab === cat ? "active" : ""}`}
//                   onClick={() => {
//                     setActiveTab(cat);
//                     setSearch("");
//                     setSearchQuery("");
//                   }}
//                 >
//                   <span className="asd-tab-icon">{CAT_ICONS[cat]}</span>
//                   {cat}
//                 </button>
//               ))}
//             </div>
//           </div>

//           <div className="asd-search-row">
//             <div className="asd-search-wrap">
//               <input
//                 className="asd-search-input"
//                 placeholder="Search by Asset ID / Asset Name"
//                 value={search}
//                 onChange={(e) => setSearch(e.target.value)}
//                 onKeyDown={handleKeyDown}
//               />
//               {search && (
//                 <button
//                   className="asd-search-clear"
//                   onClick={() => {
//                     setSearch("");
//                     setSearchQuery("");
//                   }}
//                 >
//                   ×
//                 </button>
//               )}
//             </div>
//             <button className="asd-search-btn" onClick={handleSearch}>
//               Search
//             </button>
//           </div>
//         </div>

//         {/* ── Table Card ── */}
//         <div className="asd-table-card">
//           <div className="asd-table-head-bar">
//             <div className="asd-table-head-left">
//               <span className="asd-table-icon">{CAT_ICONS[activeTab]}</span>
//               <span className="asd-table-title">{activeTab} Assets</span>
//             </div>
//             <span className="asd-table-count">
//               {filtered.length} record{filtered.length !== 1 ? "s" : ""}
//             </span>
//           </div>

//           <div className="asd-table-scroll">
//             <table className="asd-table">
//               <thead>
//                 <tr>
//                   <th>Asset ID</th>
//                   <th>Asset Name</th>
//                   <th>Assigned To</th>
//                   <th>Assigned Date</th>
//                   <th>View</th>
//                 </tr>
//               </thead>
//               <tbody>
//                 {filtered.length === 0 ? (
//                   <tr>
//                     <td colSpan={5} className="asd-empty">
//                       <div className="asd-empty-inner">
//                         <span>🔍</span>
//                         <p>No assets found</p>
//                         {searchQuery && (
//                           <span className="asd-empty-hint">
//                             Try clearing the search
//                           </span>
//                         )}
//                       </div>
//                     </td>
//                   </tr>
//                 ) : (
//                   filtered.map((asset, i) => (
//                     <tr
//                       key={asset.id + i}
//                       className={`asd-row ${
//                         i % 2 === 0 ? "asd-row-even" : "asd-row-odd"
//                       }`}
//                     >
//                       <td>
//                         <span className="asd-asset-id">{asset.id}</span>
//                       </td>
//                       <td className="asd-asset-name">{asset.name}</td>
//                       <td>
//                         <div className="asd-assignee">
//                           <span className="asd-assignee-avatar">
//                             {(asset.assignedTo || "?").charAt(0)}
//                           </span>
//                           <div className="asd-assignee-info">
//                             <span className="asd-assignee-name">
//                               {asset.assignedTo}
//                             </span>
//                             <span className="asd-assignee-id">
//                               {asset.empId}
//                             </span>
//                           </div>
//                         </div>
//                       </td>
//                       <td className="asd-date">{fmt(asset.assignedDate)}</td>
//                       <td>
//                         <button
//                           className="asd-view-btn"
//                           onClick={() => handleView(asset.empId, asset)}
//                           title={`View ${asset.assignedTo}'s profile`}
//                         >
//                           View 
//                         </button>
//                       </td>
//                     </tr>
//                   ))
//                 )}
//               </tbody>
//             </table>
//           </div>
//         </div>
//       </div>
//     </div>
//   );
// }
