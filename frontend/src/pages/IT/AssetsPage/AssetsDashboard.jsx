import { useState, useMemo, useCallback, useEffect, useRef, useDeferredValue } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useRefreshOnNavigate } from "../../../hooks/useRefreshOnNavigate";
import { useIncrementalList } from "../../../hooks/useIncrementalList";
import ClickableImage from "../../../components/ClickableImage";
import ShowMoreRows from "../../../components/ShowMoreRows";
import { buildUnitLookupIndex, lookupUnitsForAsset } from "../unitLookupIndex";
import { UserAvatar } from "../../../components/UserAvatar";
import { getUserPhotoUrl } from "../../../utils/userPhoto";
import { formatDate as fmt } from "../../../utils/dateFormat";
import {
  addRemovedITAsset,
  getInventoryFromStorage,
  getAssetUnitsFromStorage,
  getRemovedITAssets,
  getSoftwareInventory,
  getEmployees,
  toastITApiFailure,
  notifyInventoryChange,
  assignSoftwareToEmployeeAPI,
  assignUnitToEmployeeAPI,
  createRemovedAssetAPI,
  renewSoftwareLicenseAPI,
  returnAssetUnitAPI,
  returnSoftwareLicenseAPI,
  saveAssetUnitsToStorage,
  saveEmployees,
  saveInventoryToStorage,
  saveSoftwareInventory,
  syncITDataFromAPI,
  IT_NAV_SYNC_MAX_AGE_MS,
  syncRemovedITFromAPI
} from "../Data";
import { useTransitionRemark } from "../itam/TransitionRemarkModal";
import { remarkPayload } from "../itam/transitionUi";
import AssetHistoryTimeline from "../itam/AssetHistoryTimeline";
import { isItamFlagEnabled } from "../../../utils/itamFlags";
import { unitCustodyLabel, unitStatusLabel } from "../itam/lifecycleUi";
import {
  getAssetCodeField,
  getHwTypesForCategory,
  getAccessoryTypesForCategory,
  getConsumableTypesForCategory,
  getHardwareFields,
  getMobileTabletHardwareFields,
  isLaptopHardwareRow,
  isMobileTabletHwType,
  subscribeHwTypesChange,
} from "../inventoryCategories";
import "./AssetsDashboard.css";

// ─── Persist + notify helpers ─────────────────────────────────────────────────

const saveUnits = (units) => {
  saveAssetUnitsToStorage(units);
  notifyInventoryChange();
};
const saveInventory = (inv) => {
  saveInventoryToStorage(inv);
  notifyInventoryChange();
};
const saveSoftware = (sw) => {
  saveSoftwareInventory(sw);
  notifyInventoryChange();
};

// ─── Removed-From-IT helpers ──────────────────────────────────────────────────

function getRemovedITList() {
  return getRemovedITAssets();
}

function logRemovedFromIT(unit, empId, empName, removedBy, reason) {
  try {
    const assetName = unit.brand
      ? `${unit.brand}${unit.model ? " " + unit.model : ""}`.trim()
      : unit.assetName || unit.name || "Asset";
    addRemovedITAsset({
      id: unit.id || unit.assetId || String(Date.now()),
      name: assetName,
      owner: empName || empId || "—",
      ownerId: empId || null,
      assetUnitId: unit.id,
      inventoryId: unit.inventoryId ?? null,
      itReason: reason,
      category: unit.category || "Hardware",
      assetId: unit.assetId || unit.id,
      brand: unit.brand || "",
      model: unit.model || "",
      hwType: unit.hwType || null,
      serialNumber: unit.serialNumber || "",
      assetTag: unit.assetTag || "",
      photos: unit.photos || [],
      empId,
      empName,
      removedBy,
      reason,
      removedAt: new Date().toISOString(),
      flaggedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[AssetsDashboard] logRemovedFromIT error:", err);
  }
}

// ─── Inventory count recalculator ─────────────────────────────────────────────

function recalcCounts(inventoryId) {
  if (!inventoryId) return;

  const inv = getInventoryFromStorage() || [];
  const units = getAssetUnitsFromStorage() || [];
  const idx = inv.findIndex((x) => String(x.id) === String(inventoryId));
  if (idx === -1) return;

  const related = units.filter(
    (u) =>
      String(u.inventoryId) === String(inventoryId) ||
      String(u.assetId) === String(inventoryId),
  );

  inv[idx] = {
    ...inv[idx],
    totalQuantity: related.length,
    availableQuantity: related.filter((u) => u.status === "available").length,
    assignedQuantity: related.filter((u) => u.status === "assigned").length,
    notWorkingQuantity: related.filter((u) => u.status === "not-working")
      .length,
    repairQuantity: related.filter((u) => u.status === "repair").length,
  };

  saveInventory(inv);
}

// ─── Employee record synchroniser ─────────────────────────────────────────────

function syncEmployee(empId, action, payload) {
  if (!empId || empId === "—") return;
  try {
    const employees = getEmployees() || [];
    const idx = employees.findIndex(
      (e) => (e.id || e.empId || "").toUpperCase() === empId.toUpperCase(),
    );
    if (idx === -1) return;

    const emp = {
      ...employees[idx],
      assignedAssets: [...(employees[idx].assignedAssets || [])],
    };

    if (action === "remove") {
      emp.assignedAssets = emp.assignedAssets.filter(
        (a) =>
          a.id !== payload.id &&
          a.assetId !== payload.id &&
          a.licenseId !== payload.id,
      );
    }

    if (action === "assign") {
      const alreadyAssigned = emp.assignedAssets.some(
        (a) => a.id === payload.id || a.assetId === payload.id,
      );
      if (!alreadyAssigned) {
        const isSoftware = normCat(payload.category) === "Software";
        emp.assignedAssets.push(
          isSoftware
            ? {
                id: payload.id,
                assetId: null,
                licenseId: payload.id,
                name: payload.name,
                category: "Software",
                status: "Assigned",
                subscriptionStart: payload.subscriptionStart || null,
                subscriptionEnd: payload.subscriptionEnd || null,
                version: payload.version || null,
                photos: [],
              }
            : {
                id: payload.id,
                assetId: payload.id,
                assetTag: payload.assetTag || "",
                name: payload.brand
                  ? `${payload.brand}${payload.model ? " " + payload.model : ""}`.trim()
                  : payload.assetName || payload.name || "Asset",
                category: normCat(payload.category),
                hwType: payload.hwType || null,
                status: "Assigned",
                brand: payload.brand || "",
                model: payload.model || "",
                serialNumber: payload.serialNumber || "",
                photos: payload.photos || [],
              },
        );
      }
    }

    if (action === "renew") {
      emp.assignedAssets = emp.assignedAssets.map((a) =>
        a.id === payload.id || a.licenseId === payload.id
          ? {
              ...a,
              subscriptionEnd: payload.newExpiry,
              licenseExpiry: payload.newExpiry,
            }
          : a,
      );
    }

    employees[idx] = emp;
    saveEmployees(employees);
    window.dispatchEvent(new Event("inventory-updated"));
  } catch (err) {
    console.error("[AssetsDashboard] syncEmployee error:", err);
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = ["ALL", "Hardware", "Accessories", "Consumable"];

const CAT_COLOR = {
  Hardware: { bg: "#eff6ff", color: "#3b82f6", border: "#bfdbfe" },
  Software: { bg: "#f0fdf4", color: "#16a34a", border: "#bbf7d0" },
  Accessories: { bg: "#fefce8", color: "#ca8a04", border: "#fef08a" },
  Consumable: { bg: "#fdf4ff", color: "#9333ea", border: "#e9d5ff" },
};

const STATUS_COLOR = {
  available: { bg: "#f0fdf4", color: "#16a34a", border: "#bbf7d0" },
  assigned: { bg: "#eff6ff", color: "#3b82f6", border: "#bfdbfe" },
  "not-working": { bg: "#fef2f2", color: "#ef4444", border: "#fecaca" },
  repair: { bg: "#fffbeb", color: "#f59e0b", border: "#fde68a" },
};

const UNASSIGN_OPTS = [
  {
    value: "available",
    label: "Available",
    color: "#16a34a",
    bg: "#f0fdf4",
    border: "#bbf7d0",
  },
  {
    value: "repair",
    label: "In Repair",
    color: "#f59e0b",
    bg: "#fffbeb",
    border: "#fde68a",
  },
  {
    value: "not-working",
    label: "Not Working",
    color: "#ef4444",
    bg: "#fef2f2",
    border: "#fecaca",
  },
];
const SW_UNASSIGN_OPTS = [UNASSIGN_OPTS[0]];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CAT_MAP = {
  software: "Software",
  hardware: "Hardware",
  accessories: "Accessories",
};

function normCat(c) {
  if (!c) return "Hardware";
  const key = String(c).trim().toLowerCase();
  if (CAT_MAP[key]) return CAT_MAP[key];
  if (key.startsWith("consumable")) return "Consumable";
  return String(c).trim();
}

function daysLeft(end) {
  if (!end) return null;
  return Math.ceil((new Date(end) - Date.now()) / 864e5);
}

/** typeof null === "object" in JS — use this before reading .empId on assignedTo. */
function isAssignedToObject(assignedTo) {
  return assignedTo != null && typeof assignedTo === "object";
}

function formatAssignedToLabel(assignedTo) {
  if (!assignedTo) return "—";
  if (isAssignedToObject(assignedTo)) {
    return assignedTo.empId || assignedTo.name || "—";
  }
  return String(assignedTo);
}

/** Lowercased concatenation of fields used by main table search (Available + Assigned). */
const _searchBlobCache = new WeakMap();

function assetSearchBlob(a) {
  let blob = _searchBlobCache.get(a);
  if (blob === undefined) {
    blob = buildAssetSearchBlob(a);
    _searchBlobCache.set(a, blob);
  }
  return blob;
}

function buildAssetSearchBlob(a) {
  const parts = [
    a.name,
    a.hwType,
    a.category,
    a.id,
    a.unitId,
    a.empId,
    a.empName,
    a.vendor,
    a.version,
    a.licenseKey,
    a.laptopCode,
    a.imei,
  ];
  return parts.map((p) => String(p ?? "").toLowerCase()).join(" ");
}

/** Laptop Code lives on unit.model (form label); fall back to unit_code / assetId. */
function resolveLaptopCode(unit) {
  const fromModel = String(unit?.model || "").trim();
  if (fromModel && fromModel !== "—") return fromModel;
  const fromCode = String(
    unit?.unitCode || unit?.unit_code || unit?.assetId || "",
  ).trim();
  return fromCode && fromCode !== "—" ? fromCode : "";
}

/** Prefer IMEI 1, else IMEI 2. */
function resolveImei(unit) {
  const imei1 = String(unit?.imei1 || "").trim();
  if (imei1) return imei1;
  const imei2 = String(unit?.imei2 || "").trim();
  return imei2 || "";
}

const isAvailableUnit = (u) => String(u.status || "").toLowerCase() === "available";
const sameAvailableHwType = (u, hwType) =>
  String(u.hwType || "").toLowerCase() === String(hwType).toLowerCase();

function buildAvailableUnitIndex() {
  return buildUnitLookupIndex(getAssetUnitsFromStorage() || [], isAvailableUnit);
}

function getAvailableUnitsForInventory(inventoryId, assetName, hwType, index = null) {
  return lookupUnitsForAsset(
    index || buildAvailableUnitIndex(),
    inventoryId,
    assetName,
    hwType,
    sameAvailableHwType,
  );
}

function resolveAvailableIdentityFields(inventoryItem, index = null) {
  const units = getAvailableUnitsForInventory(
    inventoryItem.id,
    inventoryItem.name,
    inventoryItem.hwType,
    index,
  );
  let laptopCode = "";
  let imei = "";
  for (const u of units) {
    if (!laptopCode) laptopCode = resolveLaptopCode(u);
    if (!imei) imei = resolveImei(u);
    if (laptopCode && imei) break;
  }
  return { laptopCode, imei };
}

function resolveAssigneeFromUnit(unit) {
  const assignedTo = unit?.assignedTo;
  if (!assignedTo) return null;

  let empId = "—";
  let empName = "—";
  let empPhoto = "";
  let adminId = null;

  if (isAssignedToObject(assignedTo)) {
    adminId = assignedTo.adminId || assignedTo.id || null;
    empId = assignedTo.empId || "—";
    empName = assignedTo.name || "—";
    empPhoto = getUserPhotoUrl(assignedTo);
  } else {
    empId = String(assignedTo);
    if (/^\d+$/.test(empId)) adminId = empId;
  }

  const match = (getEmployees() || []).find((x) => {
    const xEmpId = (x.id || x.empId || "").toUpperCase();
    const xAdminId = String(x.adminId || x.id || "");
    if (empId !== "—" && xEmpId === empId.toUpperCase()) return true;
    if (adminId != null && xAdminId === String(adminId)) return true;
    return false;
  });
  if (match) {
    empId = match.empId || match.id || empId;
    empName = match.name || empName;
    empPhoto = getUserPhotoUrl(match) || empPhoto;
    return {
      empId,
      empName,
      empPhoto,
      email: match.email || "",
      type: match.type || "",
      circle: match.circle || "",
      department: match.department || match.dept || "",
      phone: match.phone || match.mobile || "",
    };
  }
  return { empId, empName, empPhoto, email: "", type: "", circle: "", department: "", phone: "" };
}

function buildHardwareUnitDetailRows(unit, itemHwType) {
  const hwType = unit?.hwType || itemHwType || null;
  const mobileTablet = isMobileTabletHwType(hwType);
  const baseFields = getHardwareFields("IT Assets", "Hardware", hwType);
  const hwFields = mobileTablet
    ? getMobileTabletHardwareFields(baseFields)
    : baseFields;
  const codeField = getAssetCodeField(hwType || "Laptop");
  const isLaptop =
    String(unit?.category || "Hardware").trim().toLowerCase() === "hardware" &&
    String(hwType || "").trim().toLowerCase() === "laptop";

  const rows = [
    { label: "Asset Tag / ID", value: unit?.assetTag || unit?.assetId || unit?.id, mono: true },
    { label: "Type", value: hwType },
    { label: hwFields.brand?.label || "Brand", value: unit?.brand },
    {
      label: hwFields.make?.label || "Make",
      value: unit?.make || (mobileTablet ? unit?.model : ""),
    },
  ];

  if (isLaptop || (!mobileTablet && hwType)) {
    rows.push({
      label: codeField.label,
      value: resolveLaptopCode(unit) || unit?.model,
      mono: true,
    });
  }

  rows.push({
    label: hwFields.serialNumber?.label || "Serial Number",
    value: unit?.serialNumber,
    mono: true,
  });

  if (mobileTablet) {
    rows.push(
      { label: "IMEI 1", value: unit?.imei1, mono: true },
      { label: "IMEI 2", value: unit?.imei2, mono: true },
      {
        label: hwFields.projectCode?.label || "Project Code",
        value: unit?.projectCode || unit?.project_code,
      },
      {
        label: hwFields.deviceLocation?.label || "Device Location",
        value: unit?.deviceLocation || unit?.device_location,
      },
    );
  }

  rows.push({ label: "Status", value: unit?.status });
  if (unit?.assignedDate) {
    rows.push({ label: "Assigned Date", value: fmt(unit.assignedDate) });
  }
  return rows.filter(
    (r) => r.value != null && String(r.value).trim() !== "" && String(r.value) !== "—",
  );
}

function HardwareUnitDetailCard({ unit, itemHwType }) {
  const rows = buildHardwareUnitDetailRows(unit, itemHwType);
  const assignee = unit?.status === "assigned" ? resolveAssigneeFromUnit(unit) : null;
  const photos =
    unit?.status === "assigned" && Array.isArray(unit.assignmentPhotos) && unit.assignmentPhotos.length
      ? unit.assignmentPhotos
      : Array.isArray(unit?.photos)
        ? unit.photos
        : [];
  const sc = STATUS_COLOR[unit?.status] || STATUS_COLOR.available;

  return (
    <div className="adp-unit-card">
      <div className="adp-unit-card-head">
        <div>
          <p className="adp-unit-card-title">
            {unit?.brand
              ? `${unit.brand}${unit.model ? ` ${unit.model}` : ""}`.trim()
              : unit?.assetName || unit?.name || "Unit"}
          </p>
          <div className="adp-unit-card-badges">
            {(unit?.hwType || itemHwType) && (
              <span className="adp-badge adp-badge-blue">
                {unit?.hwType || itemHwType}
              </span>
            )}
            <span
              className="adp-status-badge"
              style={{
                background: sc.bg,
                color: sc.color,
                border: `1px solid ${sc.border}`,
              }}
            >
              {unit?.status || "—"}
            </span>
          </div>
        </div>
      </div>

      <div className="adp-detail-list">
        {rows.map(({ label, value, mono }) => (
          <div key={label} className="adp-detail-row">
            <span className="adp-detail-label">{label}</span>
            <span className={`adp-detail-value${mono ? " mono" : ""}`}>
              {value || "—"}
            </span>
          </div>
        ))}
      </div>

      {assignee ? (
        <div className="adp-assignee-block">
          <p className="adp-section-label">Assigned To</p>
          <div className="adp-assignee-row">
            <UserAvatar
              name={assignee.empName}
              photo={assignee.empPhoto}
              className="adp-assignee-avatar"
              as="span"
              alt={assignee.empName}
            />
            <div>
              <p className="adp-assignee-name">{assignee.empName}</p>
              <p className="adp-assignee-id">{assignee.empId}</p>
            </div>
          </div>
          <div className="adp-detail-list">
            {[
              { label: "Email", value: assignee.email },
              { label: "Type", value: assignee.type },
              { label: "Circle", value: assignee.circle },
              { label: "Department", value: assignee.department },
              { label: "Phone", value: assignee.phone },
            ]
              .filter((r) => r.value)
              .map(({ label, value }) => (
                <div key={label} className="adp-detail-row">
                  <span className="adp-detail-label">{label}</span>
                  <span className="adp-detail-value">{value}</span>
                </div>
              ))}
          </div>
        </div>
      ) : null}

      {photos.length > 0 ? (
        <div className="adp-photo-section">
          <p className="adp-photo-title">Photos ({photos.length})</p>
          <div className="adp-photo-grid">
            {photos.map((src, i) => (
              <ClickableImage
                key={`${unit?.id || "u"}-${i}`}
                src={src}
                alt={`unit-${i + 1}`}
                className="adp-photo-thumb"
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function compareAssetRows(a, b, sortMode) {
  const nameKey = (x) => String(x.name ?? "").toLowerCase();
  const idNum = (x) => {
    const n = Number(x.id);
    return Number.isFinite(n) ? n : 0;
  };
  if (sortMode === "name-asc") return nameKey(a).localeCompare(nameKey(b));
  if (sortMode === "name-desc") return nameKey(b).localeCompare(nameKey(a));
  if (sortMode === "recent") return idNum(b) - idNum(a);
  if (sortMode === "oldest") return idNum(a) - idNum(b);
  return 0;
}

// ─── Data builders ────────────────────────────────────────────────────────────

function buildAvailableData() {
  const inv = getInventoryFromStorage() || [];
  const seen = new Set();
  const unitIndex = buildAvailableUnitIndex();

  return inv
    .filter((a) => {
      if (seen.has(String(a.id))) return false;
      seen.add(String(a.id));
      if ((a.inventoryCategory || "IT Assets") !== "IT Assets") return false;
      const cat = normCat(a.category);
      if (cat === "Software") return false;
      return Number(a.availableQuantity) > 0;
    })
    .map((a) => {
      const { laptopCode, imei } = resolveAvailableIdentityFields(a, unitIndex);
      return {
        id: a.id,
        name: a.name || "",
        hwType: a.hwType || null,
        category: normCat(a.category),
        photos: Array.isArray(a.photos) ? a.photos : [],
        availableQty: Number(a.availableQuantity) || 0,
        assignedQty: Number(a.assignedQuantity) || 0,
        totalQty: Number(a.totalQuantity) || 0,
        licenseKey: a.licenseKey || a.license_key || null,
        version: a.version || null,
        vendor: a.vendor || null,
        expiryDate: a.expiryDate || a.expiry_date || a.subscriptionEnd || null,
        seats: a.seats || a.totalSeats || Number(a.totalQuantity) || null,
        laptopCode,
        imei,
      };
    });
}

/**
 * Same result as `employees.find(x => empId match || adminId match)` — the first employee
 * (in list order) matching either key — without scanning the list per unit.
 */
function buildEmployeeMatcher(employees) {
  const byEmpId = new Map();
  const byAdminId = new Map();
  employees.forEach((x, i) => {
    const xEmpId = String(x.id || x.empId || "").toUpperCase();
    const xAdminId = String(x.adminId || x.id || "");
    if (!byEmpId.has(xEmpId)) byEmpId.set(xEmpId, i);
    if (!byAdminId.has(xAdminId)) byAdminId.set(xAdminId, i);
  });
  return (empId, adminId) => {
    let best = -1;
    if (empId !== "—") {
      const i = byEmpId.get(String(empId).toUpperCase());
      if (i != null) best = i;
    }
    if (adminId != null) {
      const i = byAdminId.get(String(adminId));
      if (i != null && (best < 0 || i < best)) best = i;
    }
    return best >= 0 ? employees[best] : undefined;
  };
}

function buildAssignedData() {
  const employees = getEmployees() || [];
  const findEmployee = buildEmployeeMatcher(employees);

  const resolveEmployee = (assignedTo) => {
    if (!assignedTo) return { empId: "—", empName: "—", empPhoto: "" };

    let empId = "—";
    let empName = "—";
    let empPhoto = "";
    let adminId = null;

    if (isAssignedToObject(assignedTo)) {
      adminId = assignedTo.adminId || assignedTo.id || null;
      empId = assignedTo.empId || "—";
      empName = assignedTo.name || "—";
      empPhoto = getUserPhotoUrl(assignedTo);
    } else {
      empId = String(assignedTo);
      if (/^\d+$/.test(empId)) adminId = empId;
    }

    const match = findEmployee(empId, adminId);
    if (match) {
      empId = match.empId || match.id || empId;
      empName = match.name || empName;
      empPhoto = getUserPhotoUrl(match) || empPhoto;
    }

    return { empId, empName, empPhoto };
  };

  const result = [];
  const seen = new Set();

  // Hardware units
  for (const u of (getAssetUnitsFromStorage() || []).filter(
    (u) => u.status === "assigned" && u.assignedTo,
  )) {
    const uid = u.id || u.assetId;
    if (seen.has(uid)) continue;
    seen.add(uid);

    const { empId, empName, empPhoto } = resolveEmployee(u.assignedTo);
    result.push({
      id: u.assetId || u.inventoryId || u.id,
      unitId: u.id,
      name: u.brand
        ? `${u.brand}${u.model ? " " + u.model : ""}`
        : u.assetName || u.name || "—",
      category: normCat(u.category),
      hwType: u.hwType || null,
      empId,
      empName,
      empPhoto,
      _unit: u,
    });
  }

  // Accessories / Consumables tracked on employee assignedAssets
  // (count-only inventory assignments don't create unit/license rows).
  for (const emp of employees) {
    const empId = emp.empId || emp.id || "—";
    const empName = emp.name || "—";
    const empPhoto = getUserPhotoUrl(emp);
    for (const a of emp.assignedAssets || []) {
      const category = normCat(a.category);
      if (category !== "Accessories" && category !== "Consumable") continue;
      const qty = Math.max(1, Number(a.quantity) || 1);
      const baseName = a.name || "—";
      const displayName = qty > 1 ? `${baseName} (x${qty})` : baseName;
      const uid = `inv-${empId}-${category}-${a.inventoryId || a.id || baseName}-${qty}`;
      if (seen.has(uid)) continue;
      seen.add(uid);
      result.push({
        id: uid,
        unitId: uid,
        name: displayName,
        category,
        hwType: a.hwType || null,
        empId: String(empId),
        empName: String(empName),
        empPhoto,
        _unit: a,
      });
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
//  AVAILABLE DETAIL PANEL
// ══════════════════════════════════════════════════════════════════════════════

function getBulkAssignees(item) {
  const employees = getEmployees() || [];
  const rows = [];
  const itemCat = normCat(item.category);
  for (const emp of employees) {
    for (const a of emp.assignedAssets || []) {
      const cat = normCat(a.category);
      const sameItem =
        (a.inventoryId != null && String(a.inventoryId) === String(item.id)) ||
        (a.name || "").trim().toLowerCase() === (item.name || "").trim().toLowerCase();
      if (!sameItem || cat !== itemCat) continue;
      rows.push({
        key: `${emp.empId || emp.id}-${a.id || a.name}`,
        empId: emp.empId || emp.id || "—",
        empName: emp.name || "—",
        quantity: Math.max(1, Number(a.quantity) || 1),
      });
    }
  }
  return rows;
}

function AvailableDetailPanel({ item, onClose }) {
  const [tab, setTab] = useState("Available");
  if (!item) return null;

  const isSoftware = item.category === "Software";
  const isQtyCategory = item.category === "Accessories" || item.category === "Consumable";
  const isBulkItem = isSoftware || isQtyCategory;
  const itemPhotos = Array.isArray(item.photos) ? item.photos : [];
  const allUnits = getAssetUnitsFromStorage() || [];
  const invRow = (getInventoryFromStorage() || []).find(
    (i) => String(i.id) === String(item.id),
  );

  const units = isSoftware
    ? []
    : allUnits.filter(
        (u) =>
          String(u.inventoryId) === String(item.id) ||
          String(u.assetId) === String(item.id),
      );

  const hwAvail = units.filter((u) => u.status === "available");
  const hwAssigned = units.filter(
    (u) => u.status === "assigned" && u.assignedTo,
  );

  const swSeats = isSoftware
    ? (getSoftwareInventory() || []).filter((s) => s.name === item.name)
    : [];
  const swAssigned = swSeats.filter(
    (s) => s.status === "assigned" && s.assignedTo,
  );
  const swAvail = swSeats.filter((s) => s.status === "available");

  const bulkAvailable =
    Number(item.availableQty ?? invRow?.availableQuantity) ||
    (isSoftware ? swAvail.length : 0);
  const bulkAssigned =
    Number(item.assignedQty ?? invRow?.assignedQuantity) ||
    (isSoftware ? swAssigned.length : 0);
  const bulkAssignees = isBulkItem ? getBulkAssignees(item) : [];

  const tabCounts = isBulkItem
    ? {
        Available: bulkAvailable,
        Assigned: bulkAssigned,
      }
    : {
        Available: hwAvail.length,
        Assigned: hwAssigned.length,
      };

  const visibleItems = isSoftware
    ? tab === "Available"
      ? swAvail
      : swAssigned
    : tab === "Available"
      ? hwAvail
      : hwAssigned;

  const tabs = ["Available", "Assigned"];

  const inventorySummaryRows = [
    { label: "Asset Name", value: item.name || invRow?.name },
    { label: "Category", value: item.category },
    { label: "Type", value: item.hwType || invRow?.hwType },
    {
      label: "Available Qty",
      value: item.availableQty ?? invRow?.availableQuantity,
    },
    {
      label: "Assigned Qty",
      value: item.assignedQty ?? invRow?.assignedQuantity,
    },
    {
      label: "Total Qty",
      value: item.totalQty ?? invRow?.totalQuantity,
    },
    { label: "Vendor", value: item.vendor || invRow?.vendor },
    { label: "Location", value: invRow?.location },
    { label: "Notes", value: invRow?.notes },
  ];

  if (
    isLaptopHardwareRow({
      category: item.category,
      hwType: item.hwType || invRow?.hwType,
    })
  ) {
    inventorySummaryRows.push({
      label: "Laptop Code",
      value: item.laptopCode || resolveAvailableIdentityFields(item).laptopCode,
      mono: true,
    });
  }
  if (
    String(item.category || "").trim().toLowerCase() === "hardware" &&
    isMobileTabletHwType(item.hwType || invRow?.hwType)
  ) {
    inventorySummaryRows.push({
      label: "IMEI",
      value: item.imei || resolveAvailableIdentityFields(item).imei,
      mono: true,
    });
  }

  const summaryVisible = inventorySummaryRows.filter(
    (r) => r.value != null && String(r.value).trim() !== "" && String(r.value) !== "—",
  );

  return createPortal(
    <div
      className="adp-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="adp-panel adp-panel--wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="adp-hdr">
          <div>
            <p className="adp-title">{item.name}</p>
            <div className="adp-badges">
              <span className="adp-badge">{item.category}</span>
              {item.hwType && (
                <span className="adp-badge adp-badge-blue">
                  {item.hwType}
                </span>
              )}
              {isSoftware && (
                <span className="adp-badge adp-badge-green">💿 Software</span>
              )}
            </div>
          </div>
          <button className="adp-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="adp-body">
          <section className="adp-summary-card">
            <p className="adp-section-label">Asset Overview</p>
            <div className="adp-detail-list">
              {summaryVisible.map(({ label, value, mono }) => (
                <div key={label} className="adp-detail-row">
                  <span className="adp-detail-label">{label}</span>
                  <span className={`adp-detail-value${mono ? " mono" : ""}`}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
            {itemPhotos.length > 0 && (
              <div className="adp-photo-section">
                <p className="adp-photo-title">Photos ({itemPhotos.length})</p>
                <div className="adp-photo-grid">
                  {itemPhotos.map((src, i) => (
                    <ClickableImage
                      key={i}
                      src={src}
                      alt={`asset-${i + 1}`}
                      className="adp-photo-thumb"
                    />
                  ))}
                </div>
              </div>
            )}
          </section>

          <div className="adp-tabs">
            {tabs.map((t) => (
              <button
                key={t}
                className={`adp-tab${tab === t ? " adp-tab--active" : ""}`}
                onClick={() => setTab(t)}
              >
                {t} <span className="adp-tab-count">{tabCounts[t]}</span>
              </button>
            ))}
          </div>

          {isBulkItem ? (
            <>
              {tab === "Available" ? (
                <div className="adp-bulk-summary">
                  <p className="adp-bulk-count">{bulkAvailable}</p>
                  <p className="adp-bulk-label">available to assign</p>
                  <p className="adp-bulk-hint">
                    Quantity-based {String(item.category || "item").toLowerCase()} — full stock
                    details are shown above.
                  </p>
                </div>
              ) : (
                <>
                  <div className="adp-bulk-summary adp-bulk-summary--assigned">
                    <p className="adp-bulk-count">{bulkAssigned}</p>
                    <p className="adp-bulk-label">assigned</p>
                  </div>
                  {isSoftware && swAssigned.length > 0 ? (
                    <table className="adp-table">
                      <thead>
                        <tr>
                          <th>License ID</th>
                          <th>Status</th>
                          <th>Start</th>
                          <th>Expiry</th>
                          <th>Assigned To</th>
                        </tr>
                      </thead>
                      <tbody>
                        {swAssigned.map((s) => {
                          const days = daysLeft(
                            s.subscriptionEnd || s.licenseExpiry,
                          );
                          const expired = days !== null && days < 0;
                          const warn = !expired && days !== null && days <= 30;
                          return (
                            <tr key={s.id}>
                              <td className="adp-mono">{s.id}</td>
                              <td>
                                <span
                                  className="adp-status-badge"
                                  style={
                                    expired
                                      ? {
                                          background: "#fef2f2",
                                          color: "#ef4444",
                                          border: "1px solid #fecaca",
                                        }
                                      : warn
                                        ? {
                                            background: "#fffbeb",
                                            color: "#f59e0b",
                                            border: "1px solid #fde68a",
                                          }
                                        : {
                                            background: "#f0fdf4",
                                            color: "#16a34a",
                                            border: "1px solid #bbf7d0",
                                          }
                                  }
                                >
                                  {expired
                                    ? "Expired"
                                    : warn
                                      ? "Expiring Soon"
                                      : s.status}
                                </span>
                              </td>
                              <td>{fmt(s.subscriptionStart)}</td>
                              <td>{fmt(s.subscriptionEnd || s.licenseExpiry)}</td>
                              <td>{formatAssignedToLabel(s.assignedTo)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : bulkAssignees.length > 0 ? (
                    <table className="adp-table">
                      <thead>
                        <tr>
                          <th>Employee ID</th>
                          <th>Employee Name</th>
                          <th>Qty</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bulkAssignees.map((row) => (
                          <tr key={row.key}>
                            <td className="adp-mono">{row.empId}</td>
                            <td>{row.empName}</td>
                            <td>{row.quantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="adp-empty">No assignments yet.</div>
                  )}
                </>
              )}
            </>
          ) : visibleItems.length === 0 ? (
            <div className="adp-empty">
              No {tab.toLowerCase()} units found.
            </div>
          ) : isSoftware ? (
            <table className="adp-table">
              <thead>
                <tr>
                  <th>License ID</th>
                  <th>Status</th>
                  <th>Start</th>
                  <th>Expiry</th>
                  <th>Assigned To</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((s) => {
                  const days = daysLeft(s.subscriptionEnd || s.licenseExpiry);
                  const expired = days !== null && days < 0;
                  const warn = !expired && days !== null && days <= 30;
                  return (
                    <tr key={s.id}>
                      <td className="adp-mono">{s.id}</td>
                      <td>
                        <span
                          className="adp-status-badge"
                          style={
                            expired
                              ? {
                                  background: "#fef2f2",
                                  color: "#ef4444",
                                  border: "1px solid #fecaca",
                                }
                              : warn
                                ? {
                                    background: "#fffbeb",
                                    color: "#f59e0b",
                                    border: "1px solid #fde68a",
                                  }
                                : {
                                    background: "#f0fdf4",
                                    color: "#16a34a",
                                    border: "1px solid #bbf7d0",
                                  }
                          }
                        >
                          {expired
                            ? "Expired"
                            : warn
                              ? "Expiring Soon"
                              : s.status}
                        </span>
                      </td>
                      <td>{fmt(s.subscriptionStart)}</td>
                      <td>{fmt(s.subscriptionEnd || s.licenseExpiry)}</td>
                      <td>{formatAssignedToLabel(s.assignedTo)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="adp-unit-list">
              <p className="adp-section-label">
                {tab} units ({visibleItems.length})
              </p>
              {visibleItems.map((u) => (
                <HardwareUnitDetailCard
                  key={u.id}
                  unit={u}
                  itemHwType={item.hwType}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  ASSET VERIFY MODAL  (Hardware / Accessories / Consumable only)
// ══════════════════════════════════════════════════════════════════════════════

function AssetVerifyModal({ unit, empName, onConfirm, onCancel }) {
  const fileRef = useRef(null);
  const [assetTag, setAssetTag] = useState(unit?.assetTag || "");
  const [serialNumber, setSerialNumber] = useState(unit?.serialNumber || "");
  const [photoPreview, setPhotoPreview] = useState(
    unit?.photos?.[0] || null,
  );
  const [photoData, setPhotoData] = useState(unit?.photos || []);
  const [errors, setErrors] = useState({});

  if (!unit) return null;

  const cat = normCat(unit.category);
  const cc = CAT_COLOR[cat] || CAT_COLOR.Hardware;

  const catIcon =
    cat === "Accessories" ? "🖱️" : cat === "Consumable" ? "📦" : "💻";

  const name = unit.brand
    ? `${unit.brand}${unit.model ? " " + unit.model : ""}`.trim()
    : unit.assetName || unit.name || "Asset";

  const handlePhotoChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPhotoPreview(ev.target.result);
      setPhotoData([ev.target.result]);
    };
    reader.readAsDataURL(file);
  };

  const handleConfirm = () => {
    const errs = {};
    if (!assetTag.trim()) errs.assetTag = "Asset Tag / ID is required";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    onConfirm({
      ...unit,
      assetTag: assetTag.trim(),
      serialNumber: serialNumber.trim() || unit.serialNumber || "",
      photos: photoData.length > 0 ? photoData : unit.photos || [],
    });
  };

  return (
    <div className="ep-modal-backdrop" onClick={onCancel}>
      <div
        className="ep-modal-box av-modal-box"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="av-modal-hdr">
          <div className="av-modal-hdr-top">
            <span className="av-modal-hdr-icon">{catIcon}</span>
            <div>
              <h3 className="av-modal-hdr-title">Verify & Assign</h3>
              <p className="av-modal-hdr-sub">Confirm asset details before assigning</p>
            </div>
          </div>
          <div className="av-asset-identity">
            <span className="av-asset-name">{name}</span>
            <div className="av-asset-badges">
              <span
                className="av-cat-badge"
                style={{
                  background: cc.bg,
                  color: cc.color,
                  border: `1px solid ${cc.border}`,
                }}
              >
                {catIcon} {cat}
              </span>
              {unit.hwType && (
                <span className="av-hw-badge">{unit.hwType}</span>
              )}
            </div>
          </div>
          {/* Assigning to indicator */}
          <div className="av-assign-to-row">
            <span className="av-assign-to-label">Assigning to</span>
            <span className="av-assign-to-name">👤 {empName}</span>
          </div>
        </div>

        {/* Body */}
        <div className="av-modal-body">
          {/* Asset Tag — required */}
          <div className="ep-modal-field">
            <label className="av-field-label">
              Asset Tag / ID <span className="req">*</span>
            </label>
            <div className="av-input-wrap">
              <span className="av-input-icon">🏷️</span>
              <input
                className={`ep-modal-input av-input${errors.assetTag ? " err" : ""}`}
                value={assetTag}
                onChange={(e) => {
                  setAssetTag(e.target.value);
                  if (errors.assetTag) setErrors({});
                }}
                placeholder="Scan barcode or enter asset tag"
                autoFocus
              />
            </div>
            {errors.assetTag && (
              <span className="ep-modal-err av-err">{errors.assetTag}</span>
            )}
          </div>

          {/* Serial Number — optional */}
          <div className="ep-modal-field">
            <label className="av-field-label">Serial Number</label>
            <div className="av-input-wrap">
              <span className="av-input-icon">#</span>
              <input
                className="ep-modal-input av-input"
                value={serialNumber}
                onChange={(e) => setSerialNumber(e.target.value)}
                placeholder="Enter or verify serial number"
              />
            </div>
          </div>

          {/* Photo Upload */}
          <div className="ep-modal-field">
            <label className="av-field-label">Asset Photo</label>
            <div
              className="av-photo-zone"
              onClick={() => !photoPreview && fileRef.current?.click()}
              style={{ cursor: photoPreview ? "default" : "pointer" }}
            >
              {photoPreview ? (
                <div className="av-photo-preview-wrap">
                  <ClickableImage
                    src={photoPreview}
                    alt="Asset"
                    className="av-photo-preview"
                  />
                  <button
                    className="av-photo-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPhotoPreview(null);
                      setPhotoData([]);
                      if (fileRef.current) fileRef.current.value = "";
                    }}
                  >
                    ✕ Remove
                  </button>
                </div>
              ) : (
                <div className="av-photo-placeholder">
                  <span className="av-photo-icon">📷</span>
                  <span className="av-photo-text">Click to add a photo</span>
                  <span className="av-photo-hint">JPG, PNG, WEBP supported</span>
                </div>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={handlePhotoChange}
            />
          </div>

          {/* Summary row */}
          {(unit.brand || unit.model) && (
            <div className="av-summary-row">
              {unit.brand && (
                <div className="av-summary-item">
                  <span className="av-summary-lbl">Brand</span>
                  <span className="av-summary-val">{unit.brand}</span>
                </div>
              )}
              {unit.model && (
                <div className="av-summary-item">
                  <span className="av-summary-lbl">Model</span>
                  <span className="av-summary-val">{unit.model}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="av-modal-footer">
          <button className="av-btn-confirm" onClick={handleConfirm}>
            ✔ Confirm & Assign
          </button>
          <button className="av-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  EDIT ASSIGNED PANEL
// ══════════════════════════════════════════════════════════════════════════════

function EditAssignedPanel({ assignedRow, onClose, onUpdated }) {
  const empId = assignedRow?.empId || "";
  const empName = assignedRow?.empName || "—";
  const empPhoto = assignedRow?.empPhoto || "";

  if (!empId || empId === "—") {
    return (
      <div className="ep-overlay" onClick={onClose}>
        <div
          className="ep-panel ep-panel--error"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="ep-error-msg">⚠ Employee ID not found. Cannot edit.</p>
          <button onClick={onClose} className="ep-error-close">
            Close
          </button>
        </div>
      </div>
    );
  }

  const [activeTab, setActiveTab] = useState("All");
  const [removingId, setRemovingId] = useState(null);
  const [renewingId, setRenewingId] = useState(null);
  const [renewDate, setRenewDate] = useState("");
  const { requestRemark } = useTransitionRemark();
  const [availSearch, setAvailSearch] = useState("");
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState(null);
  const [removeFromITTarget, setRemoveFromITTarget] = useState(null);
  const [assignTarget, setAssignTarget] = useState(null);
  const [historyUnit, setHistoryUnit] = useState(null);
  const timelineOn = isItamFlagEnabled("itam_timeline_v1");

  const assignedEmpId = useCallback((assignedTo) => {
    if (!assignedTo) return "";
    if (isAssignedToObject(assignedTo)) {
      return String(assignedTo.empId || assignedTo.id || "").trim();
    }
    return String(assignedTo).trim();
  }, []);

  const bump = useCallback(() => {
    setTick((k) => k + 1);
    onUpdated?.();
  }, [onUpdated]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  }, []);

  /* eslint-disable react-hooks/exhaustive-deps */
  const currentHw = useMemo(() => {
    return (getAssetUnitsFromStorage() || []).filter((u) => {
      if (u.status !== "assigned" || !u.assignedTo) return false;
      if (normCat(u.category) === "Software") return false;
      const aid = assignedEmpId(u.assignedTo);
      return aid.toUpperCase() === empId.toUpperCase();
    });
  }, [tick, empId, assignedEmpId]);

  const currentSw = [];

  const availableAssets = useMemo(() => {
    const hw = (getAssetUnitsFromStorage() || []).filter(
      (u) => String(u.status || "").toLowerCase() === "available" && normCat(u.category) !== "Software",
    );
    const q = availSearch.trim().toLowerCase();
    if (!q) return hw;
    return hw.filter((a) => {
      const name = (
        a.brand ? `${a.brand} ${a.model || ""}` : a.assetName || a.name || ""
      ).toLowerCase();
      return name.includes(q) || (a.category || "").toLowerCase().includes(q);
    });
  }, [tick, availSearch]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const totalAssigned = currentHw.length + currentSw.length;

  const tabData = {
    All: { hw: currentHw, sw: currentSw },
    Hardware: {
      hw: currentHw.filter((u) => normCat(u.category) === "Hardware"),
      sw: [],
    },
    Software: { hw: [], sw: currentSw },
    Accessories: {
      hw: currentHw.filter((u) => {
        const c = normCat(u.category);
        return c === "Accessories" || c === "Consumable";
      }),
      sw: [],
    },
  };

  const visHw = tabData[activeTab]?.hw || [];
  const visSw = tabData[activeTab]?.sw || [];

  // ── Remove ─────────────────────────────────────────────────────────────────

  const handleRemove = useCallback(
    async (unit, newStatus) => {
      const isSw = normCat(unit.category) === "Software";
      const actionCode =
        String(newStatus || "available").toLowerCase() === "available"
          ? "CHECKIN"
          : String(newStatus || "").toLowerCase().includes("repair")
            ? "SEND_REPAIR"
            : "MARK_QUARANTINE";
      const remarkResult = await requestRemark(actionCode, {
        force: true,
        assetLabel: unit.assetName || unit.name || unit.serialNumber || "Asset",
        subtitle: isSw ? "Unassign software license" : `Unassign → ${newStatus}`,
        defaultConditionGrade: actionCode === "CHECKIN" ? "B" : "",
      });
      if (remarkResult === null) return;
      const fields = remarkPayload(remarkResult);
      try {
        if (isSw) {
          await returnSoftwareLicenseAPI(unit.id, fields);
        } else {
          await returnAssetUnitAPI(unit.id, newStatus, fields);
        }
        await syncITDataFromAPI();
        syncEmployee(empId, "remove", unit);
        setRemovingId(null);
        bump();
        showToast(
          isSw
            ? "✔ License unassigned and moved to Available"
            : `✔ Removed — marked as "${newStatus}"`,
        );
      } catch (err) {
        const msg = toastITApiFailure(err, "Could not unassign this asset.");
        showToast(`⚠️ ${msg}`);
      }
    },
    [empId, bump, showToast, requestRemark],
  );

  // ── Remove From IT ─────────────────────────────────────────────────────────

  const handleRemoveFromIT = useCallback(
    async (unit, removedBy, reason) => {
      const isSw = normCat(unit.category) === "Software";
      const ownerAdminId = isAssignedToObject(unit.assignedTo)
        ? unit.assignedTo.adminId || null
        : null;
      const cleanReason = String(reason || "").trim();

      try {
        if (isSw) {
          await returnSoftwareLicenseAPI(unit.id);
        } else {
          await returnAssetUnitAPI(unit.id, "not-working");
        }

        await createRemovedAssetAPI({
          asset_unit_id: isSw ? null : unit.id,
          inventory_item_id: unit.inventoryId || null,
          owner_admin_id: ownerAdminId,
          name: unit.brand
            ? `${unit.brand}${unit.model ? ` ${unit.model}` : ""}`.trim()
            : unit.assetName || unit.name || "Asset",
          category: normCat(unit.category),
          reason: cleanReason || "Removed from IT",
          removed_at: new Date().toISOString(),
        });

        logRemovedFromIT(unit, empId, empName, removedBy, reason);
        await Promise.all([syncITDataFromAPI(), syncRemovedITFromAPI()]);
        syncEmployee(empId, "remove", unit);
        setRemoveFromITTarget(null);
        bump();

        const name = unit.brand
          ? `${unit.brand}${unit.model ? " " + unit.model : ""}`.trim()
          : unit.assetName || unit.name || "Asset";
        showToast(`✔ "${name}" moved to Removed From IT`);
      } catch (err) {
        const msg = toastITApiFailure(err, "Could not remove this asset from IT.");
        showToast(`⚠️ ${msg}`);
      }
    },
    [empId, empName, bump, showToast],
  );

  // ── Assign ─────────────────────────────────────────────────────────────────

  const handleAssign = useCallback(
    async (unit) => {
      const isSw = normCat(unit.category) === "Software";
      const remarkResult = await requestRemark("CHECKOUT", {
        assetLabel: unit.assetName || unit.name || unit.serialNumber || "Asset",
        subtitle: isSw ? `Assign license to ${empId}` : `Assign unit to ${empId}`,
      });
      if (remarkResult === null) return;
      const fields = remarkPayload(remarkResult);

      try {
        if (isSw) {
          await assignSoftwareToEmployeeAPI({
            licenseId: unit.id,
            empId,
            ...fields,
          });
        } else {
          await assignUnitToEmployeeAPI({
            unitId: unit.id,
            empId,
            assetTag: unit.assetTag || unit.assetId || "",
            assignmentPhotos: unit.assignmentPhotos || unit.photos || [],
            ...fields,
          });
        }

        await syncITDataFromAPI();
        syncEmployee(empId, "assign", unit);
        setAssignTarget(null);
        bump();

        const name = unit.brand
          ? `${unit.brand} ${unit.model || ""}`.trim()
          : unit.assetName || unit.name || "Asset";
        showToast(`✔ "${name}" assigned`);
      } catch (err) {
        const msg = toastITApiFailure(err, "Could not assign this asset.");
        showToast(`⚠️ ${msg}`);
      }
    },
    [empId, bump, showToast, requestRemark],
  );

  // ── Renew ──────────────────────────────────────────────────────────────────

  const applyPreset = useCallback(
    (months) => {
      const base = renewDate ? new Date(renewDate) : new Date();
      base.setMonth(base.getMonth() + months);
      setRenewDate(base.toISOString().slice(0, 10));
    },
    [renewDate],
  );

  const handleRenew = useCallback(
    async (seatId) => {
      if (!renewDate) {
        showToast("⚠ Please set a new expiry date first");
        return;
      }
      try {
        await renewSoftwareLicenseAPI({
          licenseId: seatId,
          subscriptionEnd: renewDate,
        });
        await syncITDataFromAPI();
        syncEmployee(empId, "renew", { id: seatId, newExpiry: renewDate });
        setRenewingId(null);
        setRenewDate("");
        bump();
        showToast(`✔ Software renewed until ${fmt(renewDate)}`);
      } catch (err) {
        const msg = toastITApiFailure(err, "Could not renew this software license.");
        showToast(`⚠️ ${msg}`);
      }
    },
    [renewDate, empId, bump, showToast],
  );

  // ── Card renderers ─────────────────────────────────────────────────────────

  const renderHwCard = (unit) => {
    const cat = normCat(unit.category);
    const cc = CAT_COLOR[cat] || CAT_COLOR.Hardware;
    const sc = STATUS_COLOR.assigned;
    const name = unit.brand
      ? `${unit.brand}${unit.model ? " " + unit.model : ""}`.trim()
      : unit.assetName || unit.name || "Asset";
    const icon =
      cat === "Accessories" ? "🖱️" : cat === "Consumable" ? "📦" : "💻";
    const days = unit.assignedDate
      ? Math.floor((Date.now() - new Date(unit.assignedDate)) / 864e5)
      : null;
    const isRemoving = removingId === unit.id;

    return (
      <div key={unit.id} className="ep-card">
        <div className="ep-card-hd">
          {/* Show photo thumbnail if available */}
          {unit.photos?.[0] ? (
            <ClickableImage
              src={unit.photos[0]}
              alt={name}
              className="ep-card-photo-thumb"
            />
          ) : (
            <span className="ep-card-icon">{icon}</span>
          )}
          <div className="ep-card-hd-info">
            <div className="ep-card-name">{name}</div>
            {unit.serialNumber && (
              <div className="ep-card-sub">S/N: {unit.serialNumber}</div>
            )}
          </div>
          <div className="ep-card-badges">
            <span
              className="ep-card-cat"
              style={{
                background: cc.bg,
                color: cc.color,
                border: `1px solid ${cc.border}`,
              }}
            >
              {cat}
            </span>
            <span
              className="ep-card-status"
              style={{
                background: sc.bg,
                color: sc.color,
                border: `1px solid ${sc.border}`,
              }}
            >
              {unitStatusLabel(unit)}
            </span>
          </div>
        </div>

        <div className="ep-card-body">
          <div className="ep-detail-grid">
            {[
              ["Brand", unit.brand],
              ["Model", unit.model],
              ["Serial No.", unit.serialNumber],
              ["Asset Tag", unit.assetTag],
              ["HW Type", unit.hwType],
              isItamFlagEnabled("itam_lifecycle_v1")
                ? ["Custody", unitCustodyLabel(unit)]
                : null,
              [
                "Assigned On",
                unit.assignedDate
                  ? `${fmt(unit.assignedDate)}${days !== null ? ` (${days}d ago)` : ""}`
                  : null,
              ],
              unit.lastRemark ? ["Last remark", unit.lastRemark] : null,
            ]
              .filter(Boolean)
              .map(([label, value]) =>
              value ? (
                <div key={label} className="ep-detail-row">
                  <span className="ep-detail-lbl">{label}</span>
                  <span className="ep-detail-val">{value}</span>
                </div>
              ) : null,
            )}
          </div>
        </div>

        <div className="ep-card-foot">
          {!isRemoving ? (
            <div className="ep-card-foot-actions">
              {timelineOn && unit?.id != null ? (
                <button
                  type="button"
                  className="btn-ep-remove"
                  onClick={() => setHistoryUnit(unit)}
                >
                  History
                </button>
              ) : null}
              <button
                className="btn-ep-remove"
                onClick={() => {
                  setRenewingId(null);
                  setRemovingId(unit.id);
                }}
              >
                🔄 Unassign
              </button>
              <button
                className="btn-ep-remove-it"
                onClick={() => {
                  setRenewingId(null);
                  setRemovingId(null);
                  setRemoveFromITTarget(unit);
                }}
              >
                🗑 Remove from IT
              </button>
            </div>
          ) : (
            <div className="ep-unassign-picker">
              <span className="ep-picker-title">
                After unassign, mark asset as:
              </span>
              <div className="ep-picker-opts">
                {SW_UNASSIGN_OPTS.map((opt) => (
                  <button
                    key={opt.value}
                    className="ep-picker-opt"
                    style={{
                      background: opt.bg,
                      color: opt.color,
                      borderColor: opt.border,
                    }}
                    onClick={() => handleRemove(unit, opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <button
                className="ep-picker-cancel"
                onClick={() => setRemovingId(null)}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderSwCard = (seat) => {
    const cc = CAT_COLOR.Software;
    const sc = STATUS_COLOR.assigned;
    const days = daysLeft(seat.subscriptionEnd || seat.licenseExpiry);
    const isExpired = days !== null && days < 0;
    const isWarn = !isExpired && days !== null && days <= 30;
    const isRem = removingId === seat.id;
    const isRen = renewingId === seat.id;

    return (
      <div key={seat.id} className="ep-card">
        <div className="ep-card-hd">
          <span className="ep-card-icon">💿</span>
          <div className="ep-card-hd-info">
            <div className="ep-card-name">{seat.name}</div>
            {seat.licenseId && (
              <div className="ep-card-sub">License: {seat.licenseId}</div>
            )}
          </div>
          <div className="ep-card-badges">
            <span
              className="ep-card-cat"
              style={{
                background: cc.bg,
                color: cc.color,
                border: `1px solid ${cc.border}`,
              }}
            >
              Software
            </span>
            <span
              className="ep-card-status"
              style={
                isExpired
                  ? {
                      background: "#fef2f2",
                      color: "#ef4444",
                      border: "1px solid #fecaca",
                    }
                  : {
                      background: sc.bg,
                      color: sc.color,
                      border: `1px solid ${sc.border}`,
                    }
              }
            >
              {isExpired ? "Expired" : "Assigned"}
            </span>
          </div>
        </div>

        <div className="ep-card-body">
          <div className="ep-detail-grid">
            {[
              ["Version", seat.version],
              ["Vendor", seat.vendor],
              ["Start", fmt(seat.subscriptionStart)],
              ["Expiry", fmt(seat.subscriptionEnd || seat.licenseExpiry)],
              ["License ID", seat.licenseId || seat.swId],
              ["Assigned On", seat.assignedDate ? fmt(seat.assignedDate) : null],
            ].map(([label, value]) =>
              value && value !== "—" ? (
                <div key={label} className="ep-detail-row">
                  <span className="ep-detail-lbl">{label}</span>
                  <span className="ep-detail-val">{value}</span>
                </div>
              ) : null,
            )}
          </div>

          {days !== null && (
            <div
              className={`ep-days-left ep-days-left--${isExpired ? "expired" : isWarn ? "warn" : "ok"}`}
            >
              {isExpired
                ? `Expired ${Math.abs(days)}d ago`
                : `${days}d remaining`}
            </div>
          )}
        </div>

        <div className="ep-card-foot">
          {!isRem && !isRen ? (
            <div className="ep-card-foot-actions">
              <button
                className="btn-ep-remove"
                onClick={() => {
                  setRemovingId(seat.id);
                  setRenewingId(null);
                }}
              >
                🔄 Unassign
              </button>
              <button
                className="btn-ep-renew"
                onClick={() => {
                  setRenewingId(seat.id);
                  setRemovingId(null);
                }}
              >
                🔁 Renew
              </button>
              <button
                className="btn-ep-remove-it"
                onClick={() => {
                  setRemovingId(null);
                  setRenewingId(null);
                  setRemoveFromITTarget(seat);
                }}
              >
                🗑 Remove from IT
              </button>
            </div>
          ) : isRem ? (
            <div className="ep-unassign-picker">
              <span className="ep-picker-title">
                After unassign, mark license as:
              </span>
              <div className="ep-picker-opts">
                {UNASSIGN_OPTS.map((opt) => (
                  <button
                    key={opt.value}
                    className="ep-picker-opt"
                    style={{
                      background: opt.bg,
                      color: opt.color,
                      borderColor: opt.border,
                    }}
                    onClick={() => handleRemove(seat, opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <button
                className="ep-picker-cancel"
                onClick={() => setRemovingId(null)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="ep-renew-picker">
              <span className="ep-picker-title">New expiry date:</span>
              <input
                type="date"
                className="ep-renew-input"
                value={renewDate}
                onChange={(e) => setRenewDate(e.target.value)}
              />
              <div className="ep-renew-presets">
                {[3, 6, 12].map((m) => (
                  <button
                    key={m}
                    className="ep-renew-preset"
                    onClick={() => applyPreset(m)}
                  >
                    +{m}m
                  </button>
                ))}
              </div>
              <div className="ep-picker-opts">
                <button
                  className="ep-picker-opt"
                  style={{
                    background: "#eff6ff",
                    color: "#3b82f6",
                    borderColor: "#bfdbfe",
                  }}
                  onClick={() => handleRenew(seat.id)}
                >
                  Confirm Renew
                </button>
                <button
                  className="ep-picker-cancel"
                  onClick={() => {
                    setRenewingId(null);
                    setRenewDate("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── Remove-from-IT modal ───────────────────────────────────────────────────

  const RemoveFromITModal = () => {
    const [removedBy, setRemovedBy] = useState("");
    const [reason, setReason] = useState("");
    const [errors, setErrors] = useState({});

    const validate = () => {
      const e = {};
      if (!removedBy.trim()) e.removedBy = "Required";
      if (!reason.trim()) e.reason = "Required";
      setErrors(e);
      return Object.keys(e).length === 0;
    };

    if (!removeFromITTarget) return null;

    const targetName = removeFromITTarget.brand
      ? `${removeFromITTarget.brand}${removeFromITTarget.model ? " " + removeFromITTarget.model : ""}`.trim()
      : removeFromITTarget.assetName || removeFromITTarget.name || "Asset";

    return (
      <div
        className="ep-modal-backdrop"
        onClick={() => setRemoveFromITTarget(null)}
      >
        <div className="ep-modal-box" onClick={(e) => e.stopPropagation()}>
          <div className="ep-modal-hdr">
            <h3>Remove From IT</h3>
            <p className="ep-modal-sub">{targetName}</p>
          </div>
          <div className="ep-modal-body">
            <div className="ep-modal-field">
              <label>
                Removed By <span className="req">*</span>
              </label>
              <input
                className={`ep-modal-input${errors.removedBy ? " err" : ""}`}
                value={removedBy}
                onChange={(e) => setRemovedBy(e.target.value)}
                placeholder="Your name"
              />
              {errors.removedBy && (
                <span className="ep-modal-err">{errors.removedBy}</span>
              )}
            </div>
            <div className="ep-modal-field">
              <label>
                Reason <span className="req">*</span>
              </label>
              <textarea
                className={`ep-modal-textarea${errors.reason ? " err" : ""}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this asset being removed from IT?"
                rows={3}
              />
              {errors.reason && (
                <span className="ep-modal-err">{errors.reason}</span>
              )}
            </div>
            <div className="ep-modal-actions">
              <button
                className="ep-modal-btn-confirm"
                onClick={() => {
                  if (validate())
                    handleRemoveFromIT(
                      removeFromITTarget,
                      removedBy.trim(),
                      reason.trim(),
                    );
                }}
              >
                Confirm Remove from IT
              </button>
              <button
                className="ep-modal-btn-cancel"
                onClick={() => setRemoveFromITTarget(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── Panel render ───────────────────────────────────────────────────────────

  return (
    <>
      <div className="ep-overlay" onClick={onClose}>
        <div className="ep-panel" onClick={(e) => e.stopPropagation()}>
          {/* Panel header */}
          <div className="ep-hdr">
            <div className="ep-hdr-info">
              <UserAvatar
                name={empName}
                photo={empPhoto}
                className="ep-avatar"
                alt={empName}
              />
              <div>
                <p className="ep-emp-name">{empName}</p>
                <p className="ep-emp-id">{empId}</p>
              </div>
            </div>
            <div className="ep-hdr-right">
              <span className="ep-total-badge">{totalAssigned} assigned</span>
              <button className="ep-close" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </div>
          </div>

          {/* Category tabs */}
          <div className="ep-tabs">
            {["All", "Hardware", "Accessories"].map((t) => {
              const count =
                t === "All"
                  ? totalAssigned
                  : t === "Hardware"
                    ? tabData.Hardware.hw.length
                    : tabData.Accessories.hw.length;
              return (
                <button
                  key={t}
                  className={`ep-tab${activeTab === t ? " ep-tab--active" : ""}`}
                  onClick={() => setActiveTab(t)}
                >
                  {t}{" "}
                  {count > 0 && <span className="ep-tab-count">{count}</span>}
                </button>
              );
            })}
            <button
              className={`ep-tab${activeTab === "Assign" ? " ep-tab--active" : ""}`}
              onClick={() => setActiveTab("Assign")}
            >
              ＋ Assign
            </button>
          </div>

          {/* Card list */}
          <div className="ep-body">
            {activeTab !== "Assign" ? (
              visHw.length === 0 && visSw.length === 0 ? (
                <div className="ep-empty">
                  No {activeTab === "All" ? "" : activeTab + " "}assets
                  assigned.
                </div>
              ) : (
                <>
                  {visHw.map(renderHwCard)}
                  {visSw.map(renderSwCard)}
                </>
              )
            ) : (
              <div className="ep-assign-panel">
                <div className="ep-assign-search-row">
                  <input
                    className="ep-assign-search"
                    placeholder="Search available assets…"
                    value={availSearch}
                    onChange={(e) => setAvailSearch(e.target.value)}
                  />
                </div>

                {/* Info banner for hardware verification */}
                <div className="av-assign-info-banner">
                  <span className="av-assign-info-icon">ℹ️</span>
                  <span>
                    Hardware, Accessories &amp; Consumables require Asset Tag
                    verification before assignment.
                  </span>
                </div>

                {availableAssets.length === 0 ? (
                  <div className="ep-empty">No available assets found.</div>
                ) : (
                  availableAssets.map((a) => {
                    const isSw = normCat(a.category) === "Software";
                    const name = a.brand
                      ? `${a.brand} ${a.model || ""}`.trim()
                      : a.assetName || a.name || "—";
                    const cat = normCat(a.category);
                    const cc = CAT_COLOR[cat] || CAT_COLOR.Hardware;
                    const catIcon =
                      cat === "Accessories"
                        ? "🖱️"
                        : cat === "Consumable"
                          ? "📦"
                          : isSw
                            ? "💿"
                            : "💻";
                    return (
                      <div key={a.id || a.assetId} className="ep-avail-row">
                        <span className="ep-avail-icon">{catIcon}</span>
                        <div className="ep-avail-info">
                          <span className="ep-avail-name">{name}</span>
                          <div className="ep-avail-meta">
                            <span
                              className="ep-avail-cat"
                              style={{ color: cc.color }}
                            >
                              {cat}
                            </span>
                            {!isSw && a.serialNumber && (
                              <span className="ep-avail-serial">
                                S/N: {a.serialNumber}
                              </span>
                            )}
                          </div>
                        </div>
                        {/* Software: direct assign | Hardware/Accessories/Consumable: open verify modal */}
                        {isSw ? (
                          <button
                            className="ep-avail-assign-btn"
                            onClick={() => handleAssign(a)}
                          >
                            Assign
                          </button>
                        ) : (
                          <button
                            className="ep-avail-assign-btn ep-avail-assign-btn--verify"
                            onClick={() => setAssignTarget(a)}
                          >
                            🔍 Verify &amp; Assign
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Toast */}
          {toast && <div className="ep-toast">{toast}</div>}
        </div>
      </div>

      {/* Remove-from-IT modal */}
      <RemoveFromITModal />

      {/* Asset Verify modal — Hardware / Accessories / Consumable */}
      {assignTarget && (
        <AssetVerifyModal
          unit={assignTarget}
          empName={empName}
          onConfirm={(verifiedUnit) => handleAssign(verifiedUnit)}
          onCancel={() => setAssignTarget(null)}
        />
      )}

      {historyUnit && timelineOn ? (
        <AssetHistoryTimeline
          unitId={Number(historyUnit.id)}
          assetLabel={
            historyUnit.brand
              ? `${historyUnit.brand}${historyUnit.model ? ` ${historyUnit.model}` : ""}`.trim()
              : historyUnit.assetName || historyUnit.serialNumber || "Asset"
          }
          onClose={() => setHistoryUnit(null)}
        />
      ) : null}
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  ASSETS DASHBOARD (main export)
// ══════════════════════════════════════════════════════════════════════════════

export default function AssetsDashboard() {
  const navigate = useNavigate();

  const [mainFilter, setMainFilter] = useState("Available");
  const [catFilter, setCatFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("All");
  const [typeOptions, setTypeOptions] = useState([]);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [sortMode, setSortMode] = useState("name-asc");
  const [detailItem, setDetailItem] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const bumpRefreshKey = useCallback(() => setRefreshKey((k) => k + 1), []);

  const syncAssetsFromServer = useCallback(() => {
    syncITDataFromAPI({ maxAgeMs: IT_NAV_SYNC_MAX_AGE_MS }).then(bumpRefreshKey).catch((err) => {
      console.error("[AssetsDashboard] API sync failed, using cached data:", err);
      toastITApiFailure(
          err,
          "Could not sync IT data from the server. Showing cached assets.",
        );
      bumpRefreshKey();
    });
  }, [bumpRefreshKey]);

  useRefreshOnNavigate(syncAssetsFromServer);

  useEffect(() => {
    window.addEventListener("inventory-updated", bumpRefreshKey);
    window.addEventListener("storage", bumpRefreshKey);
    return () => {
      window.removeEventListener("inventory-updated", bumpRefreshKey);
      window.removeEventListener("storage", bumpRefreshKey);
    };
  }, [bumpRefreshKey]);

  /* Type chips match Inventory → IT Assets (Hardware / Accessories / Consumables). */
  useEffect(() => {
    const refreshTypes = () => {
      if (catFilter === "Hardware") {
        setTypeOptions(["All", ...getHwTypesForCategory("IT Assets")]);
      } else if (catFilter === "Accessories") {
        setTypeOptions(["All", ...getAccessoryTypesForCategory("IT Assets")]);
      } else if (catFilter === "Consumable") {
        setTypeOptions(["All", ...getConsumableTypesForCategory("IT Assets")]);
      } else {
        setTypeOptions([]);
      }
    };
    setTypeFilter("All");
    refreshTypes();
    return subscribeHwTypesChange(refreshTypes);
  }, [catFilter]);

  /* eslint-disable react-hooks/exhaustive-deps */
  const availableData = useMemo(() => buildAvailableData(), [refreshKey]);
  const assignedData = useMemo(() => buildAssignedData(), [refreshKey]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const data = mainFilter === "Available" ? availableData : assignedData;

  const filtered = useMemo(() => {
    let result = data;

    if (catFilter !== "ALL") {
      result = result.filter((a) => a.category === catFilter);
    }

    if (catFilter !== "ALL" && typeFilter !== "All") {
      const want = String(typeFilter).trim().toLowerCase();
      result = result.filter(
        (a) => String(a.hwType || "").trim().toLowerCase() === want,
      );
    }

    const tokens = deferredSearch
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length > 0) {
      result = result.filter((a) => {
        const blob = assetSearchBlob(a);
        return tokens.every((tok) => blob.includes(tok));
      });
    }

    const sorted = [...result];
    sorted.sort((a, b) => {
      let cmp = compareAssetRows(a, b, sortMode);
      if (cmp === 0) cmp = String(a.id ?? "").localeCompare(String(b.id ?? ""));
      return cmp;
    });
    return sorted;
  }, [data, catFilter, typeFilter, deferredSearch, sortMode]);

  const tableRows = useIncrementalList(
    filtered,
    `${mainFilter}|${catFilter}|${typeFilter}|${deferredSearch}|${sortMode}`,
  );

  const countForCategory = useMemo(() => {
    const byCategory = new Map();
    for (const a of data) byCategory.set(a.category, (byCategory.get(a.category) || 0) + 1);
    return (cat) => (cat === "ALL" ? data.length : byCategory.get(cat) || 0);
  }, [data]);

  const categoryScopedData = useMemo(() => {
    if (catFilter === "ALL") return data;
    return data.filter((a) => a.category === catFilter);
  }, [data, catFilter]);

  const getTypeCount = useCallback(
    (type) => {
      if (type === "All") return categoryScopedData.length;
      const want = String(type).trim().toLowerCase();
      return categoryScopedData.filter(
        (a) => String(a.hwType || "").trim().toLowerCase() === want,
      ).length;
    },
    [categoryScopedData],
  );

  // Extra identity columns on Available table only (Hardware Laptop / Mobile / Tablet).
  const showLaptopCodeCol =
    mainFilter === "Available" &&
    filtered.some((a) => isLaptopHardwareRow(a));
  const showImeiCol =
    mainFilter === "Available" &&
    filtered.some(
      (a) =>
        String(a?.category || "").trim().toLowerCase() === "hardware" &&
        isMobileTabletHwType(a?.hwType),
    );
  const availableColSpan =
    5 + (showLaptopCodeCol ? 1 : 0) + (showImeiCol ? 1 : 0);

  const totalAssetCount = useMemo(() => {
    if (mainFilter === "Available") {
      // Per unit, count it once under each distinct key it matches (inventoryId / assetId),
      // so countByKey[id] equals the old `units.filter(inventoryId === id || assetId === id).length`.
      const countByKey = new Map();
      for (const u of getAssetUnitsFromStorage() || []) {
        const invKey = String(u.inventoryId);
        const assetKey = String(u.assetId);
        countByKey.set(invKey, (countByKey.get(invKey) || 0) + 1);
        if (assetKey !== invKey) {
          countByKey.set(assetKey, (countByKey.get(assetKey) || 0) + 1);
        }
      }
      return filtered.reduce((sum, a) => {
        if (a.category === "Software") {
          return sum + (a.totalQty || a.seats || a.availableQty || 0);
        }
        const unitCount = countByKey.get(String(a.id)) || 0;
        return sum + (unitCount || a.availableQty || 0);
      }, 0);
    } else {
      return filtered.length;
    }
  }, [filtered, mainFilter]);

  const handleMainFilter = useCallback((filter) => {
    setMainFilter(filter);
    setCatFilter("ALL");
    setTypeFilter("All");
    setSearch("");
    setSortMode("name-asc");
    setDetailItem(null);
  }, []);

  const handleAssignedView = useCallback(
    (empId, empName) => {
      if (!empId || empId === "—") return;
      const emp = (getEmployees() || []).find(
        (e) => (e.id || e.empId || "").toUpperCase() === empId.toUpperCase(),
      ) || {
        id: empId,
        empId,
        name: empName || "—",
        type: "—",
        circle: "—",
        email: "—",
        photo: "",
        activated: true,
        assignedAssets: [],
      };
      navigate(`/it/employee/${empId}`, { state: { employee: emp } });
    },
    [navigate],
  );

  return (
    <div className="am-page">
      <div className="am-container">
        {/* Top bar */}
        <div className="am-topbar">
          <button type="button" className="am-back-btn" onClick={() => navigate("/it")}>
            ← Back
          </button>
          <h1 className="am-title">Asset Management</h1>
          <div className="am-topbar-right">
            <div className="am-action-btns">
              <button
                type="button"
                className="am-btn-add-emp am-btn-log"
                onClick={() => navigate("/it/Assets/activity-log")}
              >
                Log
              </button>
              <button
                className="am-btn-add-emp"
                onClick={() => navigate("/it/AssetsPage/AddEmployee")}
              >
                + Assign Asset
              </button>
            </div>
            <span className="am-total-text">
              Total Assets: <strong>{totalAssetCount}</strong>
            </span>
          </div>
        </div>

        {/* Controls */}
        <div className="am-controls">
          <div className="am-controls-left">
            <div className="am-toggle-group">
              {["Available", "Assigned"].map((f) => (
                <button
                  key={f}
                  className={`am-toggle${mainFilter === f ? " active" : ""}`}
                  onClick={() => handleMainFilter(f)}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div className="am-search-row">
            <div className="am-search-wrap">
              <span className="am-search-icon">⌕</span>
              <input
                className="am-search-input"
                placeholder="Search assets…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search assets"
              />
              {search && (
                <button
                  type="button"
                  className="am-search-clear"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>
            <div className="am-sort-inline">
              <label htmlFor="am-sort-select" className="am-sort-label">
                Sort
              </label>
              <select
                id="am-sort-select"
                className="am-sort-select"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value)}
              >
                <option value="name-asc">Name (A–Z)</option>
                <option value="name-desc">Name (Z–A)</option>
                <option value="recent">Recently added (ID)</option>
                <option value="oldest">Oldest first (ID)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Category filter bar */}
        <div className="am-cat-bar">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`am-cat-btn${catFilter === cat ? " active" : ""}`}
              onClick={() => setCatFilter(cat)}
            >
              {cat}
              <span className="am-cat-count">{countForCategory(cat)}</span>
            </button>
          ))}
        </div>

        {/* Type chips — same lists as Inventory → IT Assets */}
        {catFilter !== "ALL" && typeOptions.length > 0 && (
          <div className="am-type-bar" role="group" aria-label={`${catFilter} type`}>
            <span className="am-type-bar-label">
              {catFilter === "Hardware"
                ? "Hardware type"
                : catFilter === "Accessories"
                  ? "Accessory type"
                  : "Consumable type"}
            </span>
            <div className="am-type-chips">
              {typeOptions.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`am-type-btn${typeFilter === type ? " active" : ""}`}
                  onClick={() => setTypeFilter(type)}
                >
                  {type}
                  <span className="am-cat-count">{getTypeCount(type)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Table card */}
        <div className="am-table-card">
          <div className="am-table-head-bar">
            <div className="am-table-head-left">
              <span
                className={`am-filter-indicator ${mainFilter === "Available" ? "available" : "assigned"}`}
              >
                {mainFilter === "Available"
                  ? "● Available Assets"
                  : "● Assigned Assets"}
              </span>
              {catFilter !== "ALL" && (
                <span className="am-cat-indicator">
                  {catFilter}
                  {typeFilter !== "All" ? ` · ${typeFilter}` : ""}
                </span>
              )}
            </div>
            <span className="am-table-count">
              {filtered.length} record{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>

          <div className="am-table-scroll it-m-scroll--cards">
            {mainFilter === "Available" ? (
              <table className="am-table">
                <thead>
                  <tr>
                    <th>Assets Name</th>
                    <th>Category</th>
                    {showLaptopCodeCol && <th>Laptop Code</th>}
                    {showImeiCol && <th>IMEI</th>}
                    <th>Available Qty</th>
                    <th>Assigned</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={availableColSpan} className="am-empty">
                        No assets found
                      </td>
                    </tr>
                  ) : (
                    tableRows.visible.map((a, i) => {
                      const cc = CAT_COLOR[a.category] || CAT_COLOR.Hardware;
                      const assignedQty = Number(a.assignedQty) || 0;
                      return (
                        <tr
                          key={`${a.id}-${i}`}
                          className={i % 2 === 0 ? "am-tr-even" : "am-tr-odd"}
                        >
                          <td className="am-td-name" data-label="Asset Name">
                            {a.category === "Software" && (
                              <span className="am-sw-icon">💿</span>
                            )}
                            {a.name}
                            {a.hwType && (
                              <span className="am-hwtype-chip">{a.hwType}</span>
                            )}
                          </td>
                          <td data-label="Category">
                            <span
                              className="am-cat-badge"
                              style={{
                                background: cc.bg,
                                color: cc.color,
                                border: `1px solid ${cc.border}`,
                              }}
                            >
                              {a.category}
                            </span>
                          </td>
                          {showLaptopCodeCol && (
                            <td data-label="Laptop Code">
                              <span className="am-emp-id">
                                {isLaptopHardwareRow(a)
                                  ? a.laptopCode || "—"
                                  : "—"}
                              </span>
                            </td>
                          )}
                          {showImeiCol && (
                            <td data-label="IMEI">
                              <span className="am-emp-id">
                                {String(a?.category || "")
                                  .trim()
                                  .toLowerCase() === "hardware" &&
                                isMobileTabletHwType(a?.hwType)
                                  ? a.imei || "—"
                                  : "—"}
                              </span>
                            </td>
                          )}
                          <td data-label="Available">
                            {a.category === "Software" ? (
                              <span className="am-sw-qty">
                                {a.seats
                                  ? `${a.availableQty} / ${a.seats} seats`
                                  : a.availableQty || "—"}
                              </span>
                            ) : (
                              <span className="am-qty-badge">
                                {a.availableQty}
                              </span>
                            )}
                          </td>
                          <td data-label="Assigned">
                            {assignedQty > 0 ? (
                              <span className="am-assigned-badge">{assignedQty}</span>
                            ) : (
                              <span className="am-assigned-empty">—</span>
                            )}
                          </td>
                          <td data-label="Details">
                            <button
                              className="am-view-btn"
                              onClick={() => setDetailItem(a)}
                            >
                              View
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                  <ShowMoreRows list={tableRows} colSpan={availableColSpan} />
                </tbody>
              </table>
            ) : (
              <table className="am-table">
                <thead>
                  <tr>
                    <th>Assets Name</th>
                    <th>Category</th>
                    <th>Employee ID</th>
                    <th>Employee Name</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="am-empty">
                        No assets found
                      </td>
                    </tr>
                  ) : (
                    tableRows.visible.map((a, i) => {
                      const cc = CAT_COLOR[a.category] || CAT_COLOR.Hardware;
                      return (
                        <tr
                          key={`${a.id}-${i}`}
                          className={i % 2 === 0 ? "am-tr-even" : "am-tr-odd"}
                        >
                          <td className="am-td-name" data-label="Asset Name">{a.name}</td>
                          <td data-label="Category">
                            <span
                              className="am-cat-badge"
                              style={{
                                background: cc.bg,
                                color: cc.color,
                                border: `1px solid ${cc.border}`,
                              }}
                            >
                              {a.category}
                            </span>
                          </td>
                          <td data-label="Employee ID">
                            <span className="am-emp-id">{a.empId}</span>
                          </td>
                          <td data-label="Employee">
                            <div className="am-assignee">
                              <UserAvatar
                                name={a.empName}
                                photo={a.empPhoto}
                                className="am-avatar"
                                as="span"
                                alt={a.empName}
                              />
                              <span className="am-emp-name">{a.empName}</span>
                            </div>
                          </td>
                          <td data-label="Details">
                            <button
                              className="am-view-btn"
                              onClick={() =>
                                handleAssignedView(a.empId, a.empName)
                              }
                            >
                              View
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                  <ShowMoreRows list={tableRows} colSpan={5} />
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Panels / modals */}
      {detailItem && (
        <AvailableDetailPanel
          item={detailItem}
          onClose={() => setDetailItem(null)}
        />
      )}
    </div>
  );
}




// import { useState, useMemo, useEffect, useCallback } from "react";
// import { useNavigate } from "react-router-dom";
// import {
//   getInventoryFromStorage,
//   getAssetUnitsFromStorage,
//   getSoftwareInventory,
//   getEmployees,
//   saveEmployees,
// } from "../Data";
// import "./AssetsDashboard.css";

// // ─── localStorage key constants ───────────────────────────────────────────────
// const LS_ASSET_UNITS = "assetUnits";
// const LS_INVENTORY = "inventory";
// const LS_SOFTWARE = "softwareInventory";

// // ─── Persist + notify helpers ─────────────────────────────────────────────────

// function persistAndNotify(key, data) {
//   try {
//     localStorage.setItem(key, JSON.stringify(data));
//   } catch (err) {
//     console.error(`[AssetsDashboard] persistAndNotify(${key}) failed:`, err);
//   }
//   window.dispatchEvent(new Event("inventory-updated"));
// }

// const saveUnits = (units) => persistAndNotify(LS_ASSET_UNITS, units);
// const saveInventory = (inv) => persistAndNotify(LS_INVENTORY, inv);
// const saveSoftware = (sw) => persistAndNotify(LS_SOFTWARE, sw);

// // ─── Removed-From-IT helpers ──────────────────────────────────────────────────

// const REMOVED_IT_KEY = "removedITAssets";

// function getRemovedITList() {
//   try {
//     return JSON.parse(localStorage.getItem(REMOVED_IT_KEY) || "[]");
//   } catch {
//     return [];
//   }
// }

// function logRemovedFromIT(unit, empId, empName, removedBy, reason) {
//   try {
//     const list = getRemovedITList();
//     const assetName = unit.brand
//       ? `${unit.brand}${unit.model ? " " + unit.model : ""}`.trim()
//       : unit.assetName || unit.name || "Asset";

//     list.push({
//       id: unit.id || unit.assetId || String(Date.now()),
//       name: assetName,
//       owner: empName || empId || "—",
//       ownerId: empId || null,
//       itReason: reason,
//       category: unit.category || "Hardware",
//       assetId: unit.assetId || unit.id,
//       brand: unit.brand || "",
//       model: unit.model || "",
//       hwType: unit.hwType || null,
//       serialNumber: unit.serialNumber || "",
//       assetTag: unit.assetTag || "",
//       photos: unit.photos || [],
//       empId,
//       empName,
//       removedBy,
//       reason,
//       removedAt: new Date().toISOString(),
//       flaggedAt: new Date().toISOString(),
//     });

//     localStorage.setItem(REMOVED_IT_KEY, JSON.stringify(list));
//     window.dispatchEvent(new Event("inventory-updated"));
//   } catch (err) {
//     console.error("[AssetsDashboard] logRemovedFromIT error:", err);
//   }
// }

// // ─── Inventory count recalculator ─────────────────────────────────────────────

// function recalcCounts(inventoryId) {
//   if (!inventoryId) return;

//   const inv = getInventoryFromStorage() || [];
//   const units = getAssetUnitsFromStorage() || [];
//   const idx = inv.findIndex((x) => String(x.id) === String(inventoryId));
//   if (idx === -1) return;

//   const related = units.filter(
//     (u) =>
//       String(u.inventoryId) === String(inventoryId) ||
//       String(u.assetId) === String(inventoryId),
//   );

//   inv[idx] = {
//     ...inv[idx],
//     totalQuantity: related.length,
//     availableQuantity: related.filter((u) => u.status === "available").length,
//     assignedQuantity: related.filter((u) => u.status === "assigned").length,
//     notWorkingQuantity: related.filter((u) => u.status === "not-working")
//       .length,
//     repairQuantity: related.filter((u) => u.status === "repair").length,
//   };

//   saveInventory(inv);
// }

// // ─── Employee record synchroniser ─────────────────────────────────────────────

// function syncEmployee(empId, action, payload) {
//   if (!empId || empId === "—") return;
//   try {
//     const employees = getEmployees() || [];
//     const idx = employees.findIndex(
//       (e) => (e.id || e.empId || "").toUpperCase() === empId.toUpperCase(),
//     );
//     if (idx === -1) return;

//     const emp = {
//       ...employees[idx],
//       assignedAssets: [...(employees[idx].assignedAssets || [])],
//     };

//     if (action === "remove") {
//       emp.assignedAssets = emp.assignedAssets.filter(
//         (a) =>
//           a.id !== payload.id &&
//           a.assetId !== payload.id &&
//           a.licenseId !== payload.id,
//       );
//     }

//     if (action === "assign") {
//       const alreadyAssigned = emp.assignedAssets.some(
//         (a) => a.id === payload.id || a.assetId === payload.id,
//       );
//       if (!alreadyAssigned) {
//         const isSoftware = normCat(payload.category) === "Software";
//         emp.assignedAssets.push(
//           isSoftware
//             ? {
//                 id: payload.id,
//                 assetId: null,
//                 licenseId: payload.id,
//                 name: payload.name,
//                 category: "Software",
//                 status: "Assigned",
//                 subscriptionStart: payload.subscriptionStart || null,
//                 subscriptionEnd: payload.subscriptionEnd || null,
//                 version: payload.version || null,
//                 photos: [],
//               }
//             : {
//                 id: payload.id,
//                 assetId: payload.id,
//                 assetTag: payload.assetTag || "",
//                 name: payload.brand
//                   ? `${payload.brand}${payload.model ? " " + payload.model : ""}`.trim()
//                   : payload.assetName || payload.name || "Asset",
//                 category: normCat(payload.category),
//                 hwType: payload.hwType || null,
//                 status: "Assigned",
//                 brand: payload.brand || "",
//                 model: payload.model || "",
//                 serialNumber: payload.serialNumber || "",
//                 photos: payload.photos || [],
//               },
//         );
//       }
//     }

//     if (action === "renew") {
//       emp.assignedAssets = emp.assignedAssets.map((a) =>
//         a.id === payload.id || a.licenseId === payload.id
//           ? {
//               ...a,
//               subscriptionEnd: payload.newExpiry,
//               licenseExpiry: payload.newExpiry,
//             }
//           : a,
//       );
//     }

//     employees[idx] = emp;
//     saveEmployees(employees);
//     window.dispatchEvent(new Event("inventory-updated"));
//   } catch (err) {
//     console.error("[AssetsDashboard] syncEmployee error:", err);
//   }
// }

// // ─── Constants ────────────────────────────────────────────────────────────────

// const CATEGORIES = ["ALL", "Hardware", "Software", "Accessories", "Consumable"];

// const CAT_COLOR = {
//   Hardware: { bg: "#eff6ff", color: "#3b82f6", border: "#bfdbfe" },
//   Software: { bg: "#f0fdf4", color: "#16a34a", border: "#bbf7d0" },
//   Accessories: { bg: "#fefce8", color: "#ca8a04", border: "#fef08a" },
//   Consumable: { bg: "#fdf4ff", color: "#9333ea", border: "#e9d5ff" },
// };

// const STATUS_COLOR = {
//   available: { bg: "#f0fdf4", color: "#16a34a", border: "#bbf7d0" },
//   assigned: { bg: "#eff6ff", color: "#3b82f6", border: "#bfdbfe" },
//   "not-working": { bg: "#fef2f2", color: "#ef4444", border: "#fecaca" },
//   repair: { bg: "#fffbeb", color: "#f59e0b", border: "#fde68a" },
// };

// const UNASSIGN_OPTS = [
//   {
//     value: "available",
//     label: "Available",
//     color: "#16a34a",
//     bg: "#f0fdf4",
//     border: "#bbf7d0",
//   },
//   {
//     value: "repair",
//     label: "In Repair",
//     color: "#f59e0b",
//     bg: "#fffbeb",
//     border: "#fde68a",
//   },
//   {
//     value: "not-working",
//     label: "Not Working",
//     color: "#ef4444",
//     bg: "#fef2f2",
//     border: "#fecaca",
//   },
// ];

// // ─── Helpers ──────────────────────────────────────────────────────────────────

// const CAT_MAP = {
//   software: "Software",
//   hardware: "Hardware",
//   accessories: "Accessories",
// };

// function normCat(c) {
//   if (!c) return "Hardware";
//   const key = String(c).trim().toLowerCase();
//   if (CAT_MAP[key]) return CAT_MAP[key];
//   if (key.startsWith("consumable")) return "Consumable";
//   return String(c).trim();
// }

// function fmt(iso) {
//   if (!iso) return "—";
//   const d = new Date(iso);
//   return isNaN(d)
//     ? iso
//     : d.toLocaleDateString("en-IN", {
//         day: "2-digit",
//         month: "short",
//         year: "numeric",
//       });
// }

// function daysLeft(end) {
//   if (!end) return null;
//   return Math.ceil((new Date(end) - Date.now()) / 864e5);
// }

// // ─── Data builders ────────────────────────────────────────────────────────────

// function buildAvailableData() {
//   const inv = getInventoryFromStorage() || [];
//   const seen = new Set();

//   return inv
//     .filter((a) => {
//       if (seen.has(String(a.id))) return false;
//       seen.add(String(a.id));
//       const cat = normCat(a.category);
//       return cat === "Software"
//         ? Number(a.totalQuantity) > 0
//         : Number(a.availableQuantity) > 0;
//     })
//     .map((a) => ({
//       id: a.id,
//       name: a.name,
//       hwType: a.hwType || null,
//       category: normCat(a.category),
//       availableQty: Number(a.availableQuantity) || 0,
//       totalQty: Number(a.totalQuantity) || 0,
//       licenseKey: a.licenseKey || a.license_key || null,
//       version: a.version || null,
//       vendor: a.vendor || null,
//       expiryDate: a.expiryDate || a.expiry_date || a.subscriptionEnd || null,
//       seats: a.seats || a.totalSeats || Number(a.totalQuantity) || null,
//     }));
// }

// function buildAssignedData() {
//   const employees = getEmployees() || [];

//   const resolveEmployee = (assignedTo) => {
//     if (!assignedTo) return { empId: "—", empName: "—" };

//     let empId = "—";
//     let empName = "—";

//     if (typeof assignedTo === "object") {
//       empId = assignedTo.empId || assignedTo.id || "—";
//       empName = assignedTo.name || "—";
//     } else {
//       empId = String(assignedTo);
//     }

//     if (empId !== "—") {
//       const match = employees.find(
//         (x) => (x.id || x.empId || "").toUpperCase() === empId.toUpperCase(),
//       );
//       if (match) empName = match.name || empName;
//     }

//     return { empId, empName };
//   };

//   const result = [];
//   const seen = new Set();

//   // Hardware units
//   for (const u of (getAssetUnitsFromStorage() || []).filter(
//     (u) => u.status === "assigned" && u.assignedTo,
//   )) {
//     const uid = u.id || u.assetId;
//     if (seen.has(uid)) continue;
//     seen.add(uid);

//     const { empId, empName } = resolveEmployee(u.assignedTo);
//     result.push({
//       id: u.assetId || u.inventoryId || u.id,
//       unitId: u.id,
//       name: u.brand
//         ? `${u.brand}${u.model ? " " + u.model : ""}`
//         : u.assetName || u.name || "—",
//       category: normCat(u.category),
//       empId,
//       empName,
//       _unit: u,
//     });
//   }

//   // Software seats
//   for (const s of (getSoftwareInventory() || []).filter(
//     (s) => s.status === "assigned" && s.assignedTo,
//   )) {
//     if (seen.has(s.id)) continue;
//     seen.add(s.id);

//     const match = employees.find(
//       (x) =>
//         (x.id || x.empId || "").toUpperCase() ===
//         String(s.assignedTo).toUpperCase(),
//     );
//     result.push({
//       id: s.id,
//       unitId: s.id,
//       name: s.name,
//       category: "Software",
//       empId: String(s.assignedTo),
//       empName: match?.name || "—",
//       _unit: s,
//     });
//   }

//   return result;
// }

// // ══════════════════════════════════════════════════════════════════════════════
// //  AVAILABLE DETAIL PANEL
// // ══════════════════════════════════════════════════════════════════════════════

// function AvailableDetailPanel({ item, onClose }) {
//   const [tab, setTab] = useState("Available");
//   if (!item) return null;

//   const isSoftware = item.category === "Software";
//   const allUnits = getAssetUnitsFromStorage() || [];

//   const units = isSoftware
//     ? []
//     : allUnits.filter(
//         (u) =>
//           String(u.inventoryId) === String(item.id) ||
//           String(u.assetId) === String(item.id),
//       );

//   const hwAvail = units.filter((u) => u.status === "available");
//   const hwAssigned = units.filter((u) => u.status === "assigned");
//   const hwNotWorking = units.filter((u) => u.status === "not-working");
//   const hwRepair = units.filter((u) => u.status === "repair");

//   const swSeats = isSoftware
//     ? (getSoftwareInventory() || []).filter((s) => s.name === item.name)
//     : [];
//   const swAssigned = swSeats.filter((s) => s.status === "assigned");
//   const swAvail = swSeats.filter((s) => s.status === "available");

//   const tabCounts = {
//     Available: isSoftware ? swAvail.length : hwAvail.length,
//     All: isSoftware ? swSeats.length : units.length,
//     Assigned: isSoftware ? swAssigned.length : hwAssigned.length,
//     "Not Working": hwNotWorking.length,
//     "In Repair": hwRepair.length,
//   };

//   const visibleItems = isSoftware
//     ? tab === "Available"
//       ? swAvail
//       : tab === "Assigned"
//         ? swAssigned
//         : swSeats
//     : tab === "Available"
//       ? hwAvail
//       : tab === "Assigned"
//         ? hwAssigned
//         : tab === "Not Working"
//           ? hwNotWorking
//           : tab === "In Repair"
//             ? hwRepair
//             : units;

//   const tabs = isSoftware
//     ? ["Available", "Assigned", "All"]
//     : ["Available", "Assigned", "Not Working", "In Repair", "All"];

//   return (
//     <>
//       <div className="adp-overlay" onClick={onClose}>
//         <div className="adp-panel" onClick={(e) => e.stopPropagation()}>

//           {/* ── HEADER: only hwType badge, no "View" / "Available" / "Hardware" ── */}
//           <div className="adp-hdr">
//             <div>
//               <p className="adp-title">{item.name}</p>
//               <div className="adp-badges">
//                 {item.hwType && (
//                   <span className="adp-badge adp-badge-blue">
//                     {item.hwType}
//                   </span>
//                 )}
//                 {isSoftware && (
//                   <span className="adp-badge adp-badge-green">💿 Software</span>
//                 )}
//               </div>
//             </div>
//             <button className="adp-close" onClick={onClose} aria-label="Close">
//               ✕
//             </button>
//           </div>

//           {/* Tab bar */}
//           <div className="adp-tabs">
//             {tabs.map((t) => (
//               <button
//                 key={t}
//                 className={`adp-tab${tab === t ? " adp-tab--active" : ""}`}
//                 onClick={() => setTab(t)}
//               >
//                 {t} <span className="adp-tab-count">{tabCounts[t]}</span>
//               </button>
//             ))}
//           </div>

//           <div className="adp-body">
//             {visibleItems.length === 0 ? (
//               <div className="adp-empty">
//                 No {tab.toLowerCase()} units found.
//               </div>
//             ) : isSoftware ? (
//               <table className="adp-table">
//                 <thead>
//                   <tr>
//                     <th>License ID</th>
//                     <th>Status</th>
//                     <th>Start</th>
//                     <th>Expiry</th>
//                     <th>Assigned To</th>
//                   </tr>
//                 </thead>
//                 <tbody>
//                   {visibleItems.map((s) => {
//                     const days = daysLeft(s.subscriptionEnd || s.licenseExpiry);
//                     const expired = days !== null && days < 0;
//                     const warn = !expired && days !== null && days <= 30;
//                     return (
//                       <tr key={s.id}>
//                         <td className="adp-mono">{s.id}</td>
//                         <td>
//                           <span
//                             className="adp-status-badge"
//                             style={
//                               expired
//                                 ? {
//                                     background: "#fef2f2",
//                                     color: "#ef4444",
//                                     border: "1px solid #fecaca",
//                                   }
//                                 : warn
//                                   ? {
//                                       background: "#fffbeb",
//                                       color: "#f59e0b",
//                                       border: "1px solid #fde68a",
//                                     }
//                                   : {
//                                       background: "#f0fdf4",
//                                       color: "#16a34a",
//                                       border: "1px solid #bbf7d0",
//                                     }
//                             }
//                           >
//                             {expired
//                               ? "Expired"
//                               : warn
//                                 ? "Expiring Soon"
//                                 : s.status}
//                           </span>
//                         </td>
//                         <td>{fmt(s.subscriptionStart)}</td>
//                         <td>{fmt(s.subscriptionEnd || s.licenseExpiry)}</td>
//                         <td>{s.assignedTo || "—"}</td>
//                       </tr>
//                     );
//                   })}
//                 </tbody>
//               </table>
//             ) : (
//               /* ── HARDWARE TABLE: Brand/Model | Serial No. | Status | Assigned To ── */
//               <table
//                 className="adp-table"
//                 style={{ tableLayout: "fixed", width: "100%" }}
//               >
//                 <thead>
//                   <tr>
//                     <th style={{ width: "30%" }}>Brand / Model</th>
//                     <th style={{ width: "25%" }}>Serial No.</th>
//                     <th style={{ width: "20%" }}>Status</th>
//                     {/* <th style={{ width: "25%" }}>Assigned To</th> */}
//                   </tr>
//                 </thead>
//                 <tbody>
//                   {visibleItems.map((u) => {
//                     const sc = STATUS_COLOR[u.status] || STATUS_COLOR.available;

//                     const empIdStr =
//                       typeof u.assignedTo === "object"
//                         ? u.assignedTo?.empId || u.assignedTo?.id || null
//                         : u.assignedTo || null;

//                     const empRecord = empIdStr
//                       ? (getEmployees() || []).find(
//                           (e) =>
//                             (e.id || e.empId || "").toUpperCase() ===
//                             empIdStr.toUpperCase(),
//                         )
//                       : null;

//                     const assignedLabel = empRecord
//                       ? `${empRecord.name} (${empIdStr})`
//                       : empIdStr || "—";

//                     // Brand / Model display
//                     const brandModel = u.brand
//                       ? `${u.brand}${u.model ? " " + u.model : ""}`.trim()
//                       : u.assetName || u.name || "—";

//                     const rawSerial = String(u.serialNumber || "—");
//                     const displaySerial =
//                       rawSerial.length > 14
//                         ? rawSerial.slice(0, 14) + "…"
//                         : rawSerial;

//                     return (
//                       <tr key={u.id}>
//                         {/* Brand / Model — replaces old Asset ID cell */}
//                         <td
//                           title={brandModel}
//                           style={{
//                             overflow: "hidden",
//                             textOverflow: "ellipsis",
//                             whiteSpace: "nowrap",
//                             fontSize: "13px",
//                             fontWeight: "600",
//                             color: "#1e293b",
//                           }}
//                         >
//                           {brandModel}
//                         </td>

//                         {/* Serial No. */}
//                         <td
//                           title={rawSerial}
//                           style={{
//                             overflow: "hidden",
//                             textOverflow: "ellipsis",
//                             whiteSpace: "nowrap",
//                             fontFamily: "monospace",
//                             fontSize: "12px",
//                             color: "#334155",
//                           }}
//                         >
//                           {displaySerial}
//                         </td>

//                         {/* Status */}
//                         <td>
//                           <span
//                             className="adp-status-badge"
//                             style={{
//                               background: sc.bg,
//                               color: sc.color,
//                               border: `1px solid ${sc.border}`,
//                             }}
//                           >
//                             {u.status}
//                           </span>
//                         </td>

//                         {/* Assigned To */}
//                         {/* <td
//                           title={assignedLabel}
//                           style={{
//                             overflow: "hidden",
//                             textOverflow: "ellipsis",
//                             whiteSpace: "nowrap",
//                             fontSize: "13px",
//                             color: "#334155",
//                           }}
//                         >
//                           {assignedLabel}
//                         </td> */}
//                       </tr>
//                     );
//                   })}
//                 </tbody>
//               </table>
//             )}
//           </div>
//         </div>
//       </div>
//     </>
//   );
// }

// // ══════════════════════════════════════════════════════════════════════════════
// //  EDIT ASSIGNED PANEL
// // ══════════════════════════════════════════════════════════════════════════════

// function EditAssignedPanel({ assignedRow, onClose, onUpdated }) {
//   const empId = assignedRow?.empId || "";
//   const empName = assignedRow?.empName || "—";

//   if (!empId || empId === "—") {
//     return (
//       <div className="ep-overlay" onClick={onClose}>
//         <div
//           className="ep-panel ep-panel--error"
//           onClick={(e) => e.stopPropagation()}
//         >
//           <p className="ep-error-msg">⚠ Employee ID not found. Cannot edit.</p>
//           <button onClick={onClose} className="ep-error-close">
//             Close
//           </button>
//         </div>
//       </div>
//     );
//   }

//   const [activeTab, setActiveTab] = useState("All");
//   const [removingId, setRemovingId] = useState(null);
//   const [renewingId, setRenewingId] = useState(null);
//   const [renewDate, setRenewDate] = useState("");
//   const [availSearch, setAvailSearch] = useState("");
//   const [tick, setTick] = useState(0);
//   const [toast, setToast] = useState(null);
//   const [removeFromITTarget, setRemoveFromITTarget] = useState(null);

//   const bump = useCallback(() => {
//     setTick((k) => k + 1);
//     onUpdated?.();
//   }, [onUpdated]);

//   const showToast = useCallback((msg) => {
//     setToast(msg);
//     setTimeout(() => setToast(null), 2800);
//   }, []);

//   /* eslint-disable react-hooks/exhaustive-deps */
//   const currentHw = useMemo(() => {
//     return (getAssetUnitsFromStorage() || []).filter((u) => {
//       if (u.status !== "assigned" || !u.assignedTo) return false;
//       const aid =
//         typeof u.assignedTo === "object"
//           ? String(u.assignedTo.empId || u.assignedTo.id || "")
//           : String(u.assignedTo);
//       return aid.toUpperCase() === empId.toUpperCase();
//     });
//   }, [tick, empId]);

//   const currentSw = useMemo(() => {
//     return (getSoftwareInventory() || []).filter((s) => {
//       if (s.status !== "assigned" || !s.assignedTo) return false;
//       return String(s.assignedTo).toUpperCase() === empId.toUpperCase();
//     });
//   }, [tick, empId]);

//   const availableAssets = useMemo(() => {
//     const hw = (getAssetUnitsFromStorage() || []).filter(
//       (u) => u.status === "available",
//     );
//     const sw = (getSoftwareInventory() || []).filter(
//       (s) => s.status === "available",
//     );
//     const q = availSearch.trim().toLowerCase();
//     const all = [...hw, ...sw];
//     if (!q) return all;
//     return all.filter((a) => {
//       const name = (
//         a.brand ? `${a.brand} ${a.model || ""}` : a.assetName || a.name || ""
//       ).toLowerCase();
//       return name.includes(q) || (a.category || "").toLowerCase().includes(q);
//     });
//   }, [tick, availSearch]);
//   /* eslint-enable react-hooks/exhaustive-deps */

//   const totalAssigned = currentHw.length + currentSw.length;

//   const tabData = {
//     All: { hw: currentHw, sw: currentSw },
//     Hardware: {
//       hw: currentHw.filter((u) => normCat(u.category) === "Hardware"),
//       sw: [],
//     },
//     Software: { hw: [], sw: currentSw },
//     Accessories: {
//       hw: currentHw.filter((u) => {
//         const c = normCat(u.category);
//         return c === "Accessories" || c === "Consumable";
//       }),
//       sw: [],
//     },
//   };

//   const visHw = tabData[activeTab]?.hw || [];
//   const visSw = tabData[activeTab]?.sw || [];

//   // ── Remove ─────────────────────────────────────────────────────────────────

//   const handleRemove = useCallback(
//     (unit, newStatus) => {
//       const isSw = normCat(unit.category) === "Software";

//       if (isSw) {
//         const sw = getSoftwareInventory() || [];
//         const upd = sw.map((s) =>
//           s.id === unit.id
//             ? { ...s, status: newStatus, assignedTo: null, assignedDate: null }
//             : s,
//         );
//         saveSoftware(upd);

//         const inv = getInventoryFromStorage() || [];
//         const i = inv.findIndex(
//           (x) => x.name === unit.name && normCat(x.category) === "Software",
//         );
//         if (i !== -1) {
//           inv[i] = {
//             ...inv[i],
//             assignedQuantity: upd.filter(
//               (s) => s.name === unit.name && s.status === "assigned",
//             ).length,
//             availableQuantity: upd.filter(
//               (s) => s.name === unit.name && s.status === "available",
//             ).length,
//           };
//           saveInventory(inv);
//         }
//       } else {
//         const units = getAssetUnitsFromStorage() || [];
//         const upd = units.map((u) =>
//           u.id === unit.id
//             ? { ...u, status: newStatus, assignedTo: null, assignedDate: null }
//             : u,
//         );
//         saveUnits(upd);
//         recalcCounts(unit.inventoryId || unit.assetId);
//       }

//       syncEmployee(empId, "remove", unit);
//       setRemovingId(null);
//       bump();
//       showToast(`✔ Removed — marked as "${newStatus}"`);
//     },
//     [empId, bump, showToast],
//   );

//   // ── Remove From IT ─────────────────────────────────────────────────────────

//   const handleRemoveFromIT = useCallback(
//     (unit, removedBy, reason) => {
//       logRemovedFromIT(unit, empId, empName, removedBy, reason);

//       const isSw = normCat(unit.category) === "Software";

//       if (isSw) {
//         const sw = getSoftwareInventory() || [];
//         const upd = sw.filter((s) => s.id !== unit.id);
//         saveSoftware(upd);

//         const inv = getInventoryFromStorage() || [];
//         const i = inv.findIndex(
//           (x) => x.name === unit.name && normCat(x.category) === "Software",
//         );
//         if (i !== -1) {
//           const newTotal = Math.max(0, (Number(inv[i].totalQuantity) || 0) - 1);
//           if (newTotal <= 0) {
//             saveInventory(inv.filter((_, idx) => idx !== i));
//           } else {
//             inv[i] = {
//               ...inv[i],
//               totalQuantity: newTotal,
//               assignedQuantity: Math.max(
//                 0,
//                 (Number(inv[i].assignedQuantity) || 0) - 1,
//               ),
//             };
//             saveInventory(inv);
//           }
//         }
//       } else {
//         const units = getAssetUnitsFromStorage() || [];
//         saveUnits(units.filter((u) => u.id !== unit.id));

//         const inventoryId = unit.inventoryId || unit.assetId;
//         if (inventoryId) {
//           const inv = getInventoryFromStorage() || [];
//           const i = inv.findIndex((x) => String(x.id) === String(inventoryId));
//           if (i !== -1) {
//             const newTotal = Math.max(
//               0,
//               (Number(inv[i].totalQuantity) || 0) - 1,
//             );
//             if (newTotal <= 0) {
//               saveInventory(inv.filter((_, idx) => idx !== i));
//             } else {
//               inv[i] = {
//                 ...inv[i],
//                 totalQuantity: newTotal,
//                 assignedQuantity: Math.max(
//                   0,
//                   (Number(inv[i].assignedQuantity) || 0) - 1,
//                 ),
//               };
//               saveInventory(inv);
//             }
//           }
//         }
//       }

//       syncEmployee(empId, "remove", unit);
//       setRemoveFromITTarget(null);
//       bump();

//       const name = unit.brand
//         ? `${unit.brand}${unit.model ? " " + unit.model : ""}`.trim()
//         : unit.assetName || unit.name || "Asset";
//       showToast(`✔ "${name}" moved to Removed From IT`);
//     },
//     [empId, empName, bump, showToast],
//   );

//   // ── Assign ─────────────────────────────────────────────────────────────────

//   const handleAssign = useCallback(
//     (unit) => {
//       const isSw = normCat(unit.category) === "Software";

//       if (isSw) {
//         const sw = getSoftwareInventory() || [];
//         const upd = sw.map((s) =>
//           s.id === unit.id
//             ? {
//                 ...s,
//                 status: "assigned",
//                 assignedTo: empId,
//                 assignedDate: new Date().toISOString(),
//               }
//             : s,
//         );
//         saveSoftware(upd);

//         const inv = getInventoryFromStorage() || [];
//         const i = inv.findIndex(
//           (x) => x.name === unit.name && normCat(x.category) === "Software",
//         );
//         if (i !== -1) {
//           inv[i] = {
//             ...inv[i],
//             assignedQuantity: upd.filter(
//               (s) => s.name === unit.name && s.status === "assigned",
//             ).length,
//             availableQuantity: upd.filter(
//               (s) => s.name === unit.name && s.status === "available",
//             ).length,
//           };
//           saveInventory(inv);
//         }
//       } else {
//         const units = getAssetUnitsFromStorage() || [];
//         const upd = units.map((u) =>
//           u.id === unit.id
//             ? {
//                 ...u,
//                 status: "assigned",
//                 assignedTo: empId,
//                 assignedDate: new Date().toISOString(),
//               }
//             : u,
//         );
//         saveUnits(upd);
//         recalcCounts(unit.inventoryId || unit.assetId);
//       }

//       syncEmployee(empId, "assign", unit);
//       bump();

//       const name = unit.brand
//         ? `${unit.brand} ${unit.model || ""}`.trim()
//         : unit.assetName || unit.name || "Asset";
//       showToast(`✔ "${name}" assigned to ${empName}`);
//     },
//     [empId, empName, bump, showToast],
//   );

//   // ── Renew ──────────────────────────────────────────────────────────────────

//   const applyPreset = useCallback(
//     (months) => {
//       const base = renewDate ? new Date(renewDate) : new Date();
//       base.setMonth(base.getMonth() + months);
//       setRenewDate(base.toISOString().slice(0, 10));
//     },
//     [renewDate],
//   );

//   const handleRenew = useCallback(
//     (seatId) => {
//       if (!renewDate) {
//         showToast("⚠ Please set a new expiry date first");
//         return;
//       }

//       const sw = getSoftwareInventory() || [];
//       const upd = sw.map((s) =>
//         s.id === seatId
//           ? { ...s, subscriptionEnd: renewDate, licenseExpiry: renewDate }
//           : s,
//       );
//       saveSoftware(upd);
//       syncEmployee(empId, "renew", { id: seatId, newExpiry: renewDate });
//       setRenewingId(null);
//       setRenewDate("");
//       bump();
//       showToast(`✔ Software renewed until ${fmt(renewDate)}`);
//     },
//     [renewDate, empId, bump, showToast],
//   );

//   // ── Card renderers ─────────────────────────────────────────────────────────

//   const renderHwCard = (unit) => {
//     const cat = normCat(unit.category);
//     const cc = CAT_COLOR[cat] || CAT_COLOR.Hardware;
//     const sc = STATUS_COLOR.assigned;
//     const name = unit.brand
//       ? `${unit.brand}${unit.model ? " " + unit.model : ""}`.trim()
//       : unit.assetName || unit.name || "Asset";
//     const icon =
//       cat === "Accessories" ? "🖱️" : cat === "Consumable" ? "📦" : "💻";
//     const days = unit.assignedDate
//       ? Math.floor((Date.now() - new Date(unit.assignedDate)) / 864e5)
//       : null;
//     const isRemoving = removingId === unit.id;

//     return (
//       <div key={unit.id} className="ep-card">
//         <div className="ep-card-hd">
//           <span className="ep-card-icon">{icon}</span>
//           <div className="ep-card-hd-info">
//             <div className="ep-card-name">{name}</div>
//             {unit.serialNumber && (
//               <div className="ep-card-sub">S/N: {unit.serialNumber}</div>
//             )}
//           </div>
//           <div className="ep-card-badges">
//             <span
//               className="ep-card-cat"
//               style={{
//                 background: cc.bg,
//                 color: cc.color,
//                 border: `1px solid ${cc.border}`,
//               }}
//             >
//               {cat}
//             </span>
//             <span
//               className="ep-card-status"
//               style={{
//                 background: sc.bg,
//                 color: sc.color,
//                 border: `1px solid ${sc.border}`,
//               }}
//             >
//               Assigned
//             </span>
//           </div>
//         </div>

//         <div className="ep-card-body">
//           <div className="ep-detail-grid">
//             {[
//               ["Brand", unit.brand],
//               ["Model", unit.model],
//               ["Serial No.", unit.serialNumber],
//               ["Asset Tag", unit.assetTag],
//               ["HW Type", unit.hwType],
//               [
//                 "Assigned On",
//                 unit.assignedDate
//                   ? `${fmt(unit.assignedDate)}${days !== null ? ` (${days}d ago)` : ""}`
//                   : null,
//               ],
//             ].map(([label, value]) =>
//               value ? (
//                 <div key={label} className="ep-detail-row">
//                   <span className="ep-detail-lbl">{label}</span>
//                   <span className="ep-detail-val">{value}</span>
//                 </div>
//               ) : null,
//             )}
//           </div>
//         </div>

//         <div className="ep-card-foot">
//           {!isRemoving ? (
//             <div className="ep-card-foot-actions">
//               <button
//                 className="btn-ep-remove"
//                 onClick={() => {
//                   setRenewingId(null);
//                   setRemovingId(unit.id);
//                 }}
//               >
//                 🔄 Unassign
//               </button>
//               <button
//                 className="btn-ep-remove-it"
//                 onClick={() => {
//                   setRenewingId(null);
//                   setRemovingId(null);
//                   setRemoveFromITTarget(unit);
//                 }}
//               >
//                 🗑 Action Remove
//               </button>
//             </div>
//           ) : (
//             <div className="ep-unassign-picker">
//               <span className="ep-picker-title">
//                 After unassign, mark asset as:
//               </span>
//               <div className="ep-picker-opts">
//                 {UNASSIGN_OPTS.map((opt) => (
//                   <button
//                     key={opt.value}
//                     className="ep-picker-opt"
//                     style={{
//                       background: opt.bg,
//                       color: opt.color,
//                       borderColor: opt.border,
//                     }}
//                     onClick={() => handleRemove(unit, opt.value)}
//                   >
//                     {opt.label}
//                   </button>
//                 ))}
//               </div>
//               <button
//                 className="ep-picker-cancel"
//                 onClick={() => setRemovingId(null)}
//               >
//                 Cancel
//               </button>
//             </div>
//           )}
//         </div>
//       </div>
//     );
//   };

//   const renderSwCard = (seat) => {
//     const cc = CAT_COLOR.Software;
//     const sc = STATUS_COLOR.assigned;
//     const days = daysLeft(seat.subscriptionEnd || seat.licenseExpiry);
//     const isExpired = days !== null && days < 0;
//     const isWarn = !isExpired && days !== null && days <= 30;
//     const isRem = removingId === seat.id;
//     const isRen = renewingId === seat.id;

//     return (
//       <div key={seat.id} className="ep-card">
//         <div className="ep-card-hd">
//           <span className="ep-card-icon">💿</span>
//           <div className="ep-card-hd-info">
//             <div className="ep-card-name">{seat.name}</div>
//             {seat.licenseId && (
//               <div className="ep-card-sub">License: {seat.licenseId}</div>
//             )}
//           </div>
//           <div className="ep-card-badges">
//             <span
//               className="ep-card-cat"
//               style={{
//                 background: cc.bg,
//                 color: cc.color,
//                 border: `1px solid ${cc.border}`,
//               }}
//             >
//               Software
//             </span>
//             <span
//               className="ep-card-status"
//               style={
//                 isExpired
//                   ? {
//                       background: "#fef2f2",
//                       color: "#ef4444",
//                       border: "1px solid #fecaca",
//                     }
//                   : {
//                       background: sc.bg,
//                       color: sc.color,
//                       border: `1px solid ${sc.border}`,
//                     }
//               }
//             >
//               {isExpired ? "Expired" : "Assigned"}
//             </span>
//           </div>
//         </div>

//         <div className="ep-card-body">
//           <div className="ep-detail-grid">
//             {[
//               ["Version", seat.version],
//               ["Vendor", seat.vendor],
//               ["Start", fmt(seat.subscriptionStart)],
//               ["Expiry", fmt(seat.subscriptionEnd || seat.licenseExpiry)],
//               ["License ID", seat.licenseId || seat.swId],
//             ].map(([label, value]) =>
//               value && value !== "—" ? (
//                 <div key={label} className="ep-detail-row">
//                   <span className="ep-detail-lbl">{label}</span>
//                   <span className="ep-detail-val">{value}</span>
//                 </div>
//               ) : null,
//             )}
//           </div>

//           {days !== null && (
//             <div
//               className={`ep-days-left ep-days-left--${isExpired ? "expired" : isWarn ? "warn" : "ok"}`}
//             >
//               {isExpired
//                 ? `Expired ${Math.abs(days)}d ago`
//                 : `${days}d remaining`}
//             </div>
//           )}
//         </div>

//         <div className="ep-card-foot">
//           {!isRem && !isRen ? (
//             <div className="ep-card-foot-actions">
//               <button
//                 className="btn-ep-remove"
//                 onClick={() => {
//                   setRemovingId(seat.id);
//                   setRenewingId(null);
//                 }}
//               >
//                 🔄 Unassign
//               </button>
//               <button
//                 className="btn-ep-renew"
//                 onClick={() => {
//                   setRenewingId(seat.id);
//                   setRemovingId(null);
//                 }}
//               >
//                 🔁 Renew
//               </button>
//               <button
//                 className="btn-ep-remove-it"
//                 onClick={() => {
//                   setRemovingId(null);
//                   setRenewingId(null);
//                   setRemoveFromITTarget(seat);
//                 }}
//               >
//                 🗑 Action Remove
//               </button>
//             </div>
//           ) : isRem ? (
//             <div className="ep-unassign-picker">
//               <span className="ep-picker-title">
//                 After unassign, mark license as:
//               </span>
//               <div className="ep-picker-opts">
//                 {UNASSIGN_OPTS.map((opt) => (
//                   <button
//                     key={opt.value}
//                     className="ep-picker-opt"
//                     style={{
//                       background: opt.bg,
//                       color: opt.color,
//                       borderColor: opt.border,
//                     }}
//                     onClick={() => handleRemove(seat, opt.value)}
//                   >
//                     {opt.label}
//                   </button>
//                 ))}
//               </div>
//               <button
//                 className="ep-picker-cancel"
//                 onClick={() => setRemovingId(null)}
//               >
//                 Cancel
//               </button>
//             </div>
//           ) : (
//             <div className="ep-renew-picker">
//               <span className="ep-picker-title">New expiry date:</span>
//               <input
//                 type="date"
//                 className="ep-renew-input"
//                 value={renewDate}
//                 onChange={(e) => setRenewDate(e.target.value)}
//               />
//               <div className="ep-renew-presets">
//                 {[3, 6, 12].map((m) => (
//                   <button
//                     key={m}
//                     className="ep-renew-preset"
//                     onClick={() => applyPreset(m)}
//                   >
//                     +{m}m
//                   </button>
//                 ))}
//               </div>
//               <div className="ep-picker-opts">
//                 <button
//                   className="ep-picker-opt"
//                   style={{
//                     background: "#eff6ff",
//                     color: "#3b82f6",
//                     borderColor: "#bfdbfe",
//                   }}
//                   onClick={() => handleRenew(seat.id)}
//                 >
//                   Confirm Renew
//                 </button>
//                 <button
//                   className="ep-picker-cancel"
//                   onClick={() => {
//                     setRenewingId(null);
//                     setRenewDate("");
//                   }}
//                 >
//                   Cancel
//                 </button>
//               </div>
//             </div>
//           )}
//         </div>
//       </div>
//     );
//   };

//   // ── Remove-from-IT modal ───────────────────────────────────────────────────

//   const RemoveFromITModal = () => {
//     const [removedBy, setRemovedBy] = useState("");
//     const [reason, setReason] = useState("");
//     const [errors, setErrors] = useState({});

//     const validate = () => {
//       const e = {};
//       if (!removedBy.trim()) e.removedBy = "Required";
//       if (!reason.trim()) e.reason = "Required";
//       setErrors(e);
//       return Object.keys(e).length === 0;
//     };

//     if (!removeFromITTarget) return null;

//     const targetName = removeFromITTarget.brand
//       ? `${removeFromITTarget.brand}${removeFromITTarget.model ? " " + removeFromITTarget.model : ""}`.trim()
//       : removeFromITTarget.assetName || removeFromITTarget.name || "Asset";

//     return (
//       <div
//         className="ep-modal-backdrop"
//         onClick={() => setRemoveFromITTarget(null)}
//       >
//         <div className="ep-modal-box" onClick={(e) => e.stopPropagation()}>
//           <div className="ep-modal-hdr">
//             <h3>Remove From IT</h3>
//             <p className="ep-modal-sub">{targetName}</p>
//           </div>
//           <div className="ep-modal-body">
//             <div className="ep-modal-field">
//               <label>
//                 Removed By <span className="req">*</span>
//               </label>
//               <input
//                 className={`ep-modal-input${errors.removedBy ? " err" : ""}`}
//                 value={removedBy}
//                 onChange={(e) => setRemovedBy(e.target.value)}
//                 placeholder="Your name"
//               />
//               {errors.removedBy && (
//                 <span className="ep-modal-err">{errors.removedBy}</span>
//               )}
//             </div>
//             <div className="ep-modal-field">
//               <label>
//                 Reason <span className="req">*</span>
//               </label>
//               <textarea
//                 className={`ep-modal-textarea${errors.reason ? " err" : ""}`}
//                 value={reason}
//                 onChange={(e) => setReason(e.target.value)}
//                 placeholder="Why is this asset being removed from IT?"
//                 rows={3}
//               />
//               {errors.reason && (
//                 <span className="ep-modal-err">{errors.reason}</span>
//               )}
//             </div>
//             <div className="ep-modal-actions">
//               <button
//                 className="ep-modal-btn-confirm"
//                 onClick={() => {
//                   if (validate())
//                     handleRemoveFromIT(
//                       removeFromITTarget,
//                       removedBy.trim(),
//                       reason.trim(),
//                     );
//                 }}
//               >
//                 Confirm Remove
//               </button>
//               <button
//                 className="ep-modal-btn-cancel"
//                 onClick={() => setRemoveFromITTarget(null)}
//               >
//                 Cancel
//               </button>
//             </div>
//           </div>
//         </div>
//       </div>
//     );
//   };

//   // ── Panel render ───────────────────────────────────────────────────────────

//   return (
//     <>
//       <div className="ep-overlay" onClick={onClose}>
//         <div className="ep-panel" onClick={(e) => e.stopPropagation()}>
//           {/* Panel header */}
//           <div className="ep-hdr">
//             <div className="ep-hdr-info">
//               <div className="ep-avatar">
//                 {(empName || "?").charAt(0).toUpperCase()}
//               </div>
//               <div>
//                 <p className="ep-emp-name">{empName}</p>
//                 <p className="ep-emp-id">{empId}</p>
//               </div>
//             </div>
//             <div className="ep-hdr-right">
//               <span className="ep-total-badge">{totalAssigned} assigned</span>
//               <button className="ep-close" onClick={onClose} aria-label="Close">
//                 ✕
//               </button>
//             </div>
//           </div>

//           {/* Category tabs */}
//           <div className="ep-tabs">
//             {["All", "Hardware", "Software", "Accessories"].map((t) => {
//               const count =
//                 t === "All"
//                   ? totalAssigned
//                   : t === "Hardware"
//                     ? tabData.Hardware.hw.length
//                     : t === "Software"
//                       ? tabData.Software.sw.length
//                       : tabData.Accessories.hw.length;
//               return (
//                 <button
//                   key={t}
//                   className={`ep-tab${activeTab === t ? " ep-tab--active" : ""}`}
//                   onClick={() => setActiveTab(t)}
//                 >
//                   {t}{" "}
//                   {count > 0 && <span className="ep-tab-count">{count}</span>}
//                 </button>
//               );
//             })}
//             <button
//               className={`ep-tab${activeTab === "Assign" ? " ep-tab--active" : ""}`}
//               onClick={() => setActiveTab("Assign")}
//             >
//               ＋ Assign
//             </button>
//           </div>

//           {/* Card list */}
//           <div className="ep-body">
//             {activeTab !== "Assign" ? (
//               visHw.length === 0 && visSw.length === 0 ? (
//                 <div className="ep-empty">
//                   No {activeTab === "All" ? "" : activeTab + " "}assets
//                   assigned.
//                 </div>
//               ) : (
//                 <>
//                   {visHw.map(renderHwCard)}
//                   {visSw.map(renderSwCard)}
//                 </>
//               )
//             ) : (
//               <div className="ep-assign-panel">
//                 <div className="ep-assign-search-row">
//                   <input
//                     className="ep-assign-search"
//                     placeholder="Search available assets…"
//                     value={availSearch}
//                     onChange={(e) => setAvailSearch(e.target.value)}
//                   />
//                 </div>
//                 {availableAssets.length === 0 ? (
//                   <div className="ep-empty">No available assets found.</div>
//                 ) : (
//                   availableAssets.map((a) => {
//                     const isSw = normCat(a.category) === "Software";
//                     const name = a.brand
//                       ? `${a.brand} ${a.model || ""}`.trim()
//                       : a.assetName || a.name || "—";
//                     const cat = normCat(a.category);
//                     const cc = CAT_COLOR[cat] || CAT_COLOR.Hardware;
//                     return (
//                       <div key={a.id || a.assetId} className="ep-avail-row">
//                         <span className="ep-avail-icon">
//                           {isSw ? "💿" : "💻"}
//                         </span>
//                         <div className="ep-avail-info">
//                           <span className="ep-avail-name">{name}</span>
//                           <span
//                             className="ep-avail-cat"
//                             style={{ color: cc.color }}
//                           >
//                             {cat}
//                           </span>
//                         </div>
//                         <button
//                           className="ep-avail-assign-btn"
//                           onClick={() => handleAssign(a)}
//                         >
//                           Assign
//                         </button>
//                       </div>
//                     );
//                   })
//                 )}
//               </div>
//             )}
//           </div>

//           {/* Toast */}
//           {toast && <div className="ep-toast">{toast}</div>}
//         </div>
//       </div>

//       {/* Remove-from-IT modal */}
//       <RemoveFromITModal />
//     </>
//   );
// }

// // ══════════════════════════════════════════════════════════════════════════════
// //  ASSETS DASHBOARD (main export)
// // ══════════════════════════════════════════════════════════════════════════════

// export default function AssetsDashboard() {
//   const navigate = useNavigate();

//   const [mainFilter, setMainFilter] = useState("Available");
//   const [catFilter, setCatFilter] = useState("ALL");
//   const [search, setSearch] = useState("");
//   const [searchQuery, setSearchQuery] = useState("");
//   const [detailItem, setDetailItem] = useState(null);
//   const [editRow, setEditRow] = useState(null);
//   const [refreshKey, setRefreshKey] = useState(0);

//   useEffect(() => {
//     const refresh = () => setRefreshKey((k) => k + 1);
//     window.addEventListener("inventory-updated", refresh);
//     window.addEventListener("storage", refresh);
//     return () => {
//       window.removeEventListener("inventory-updated", refresh);
//       window.removeEventListener("storage", refresh);
//     };
//   }, []);

//   /* eslint-disable react-hooks/exhaustive-deps */
//   const availableData = useMemo(() => buildAvailableData(), [refreshKey]);
//   const assignedData = useMemo(() => buildAssignedData(), [refreshKey]);
//   /* eslint-enable react-hooks/exhaustive-deps */

//   const data = mainFilter === "Available" ? availableData : assignedData;

//   const filtered = useMemo(() => {
//     let result = data;

//     if (catFilter !== "ALL") {
//       result = result.filter((a) => a.category === catFilter);
//     }

//     if (searchQuery.trim()) {
//       const q = searchQuery.toLowerCase();
//       result = result.filter(
//         (a) =>
//           a.name.toLowerCase().includes(q) ||
//           String(a.id).toLowerCase().includes(q) ||
//           (a.empId || "").toLowerCase().includes(q) ||
//           (a.empName || "").toLowerCase().includes(q),
//       );
//     }

//     return result;
//   }, [data, catFilter, searchQuery]);

//   const totalAssetCount = useMemo(() => {
//     if (mainFilter === "Available") {
//       const allUnits = getAssetUnitsFromStorage() || [];
//       return filtered.reduce((sum, a) => {
//         if (a.category === "Software") {
//           return sum + (a.totalQty || a.seats || a.availableQty || 0);
//         }
//         const unitCount = allUnits.filter(
//           (u) =>
//             String(u.inventoryId) === String(a.id) ||
//             String(u.assetId) === String(a.id),
//         ).length;
//         return sum + (unitCount || a.availableQty || 0);
//       }, 0);
//     } else {
//       return filtered.length;
//     }
//   }, [filtered, mainFilter]);

//   const handleSearch = useCallback(() => setSearchQuery(search), [search]);

//   const handleKeyDown = useCallback(
//     (e) => {
//       if (e.key === "Enter") setSearchQuery(search);
//     },
//     [search],
//   );

//   const handleMainFilter = useCallback((filter) => {
//     setMainFilter(filter);
//     setCatFilter("ALL");
//     setSearch("");
//     setSearchQuery("");
//     setDetailItem(null);
//     setEditRow(null);
//   }, []);

//   const handleAssignedView = useCallback(
//     (empId, empName) => {
//       if (!empId || empId === "—") return;
//       const emp = (getEmployees() || []).find(
//         (e) => (e.id || e.empId || "").toUpperCase() === empId.toUpperCase(),
//       ) || {
//         id: empId,
//         empId,
//         name: empName || "—",
//         type: "—",
//         circle: "—",
//         email: "—",
//         photo: "",
//         activated: true,
//         assignedAssets: [],
//       };
//       navigate(`/it/employee/${empId}`, { state: { employee: emp } });
//     },
//     [navigate],
//   );

//   const handleEditUpdated = useCallback(() => setRefreshKey((k) => k + 1), []);

//   return (
//     <div className="am-page">
//       <div className="am-container">
//         {/* Top bar */}
//         <div className="am-topbar">
//           <button className="am-back-btn" onClick={() => navigate(-1)}>
//             ← Back
//           </button>
//           <h1 className="am-title">Asset Management</h1>
//           <div className="am-topbar-right">
//             <div className="am-action-btns">
//               <button
//                 className="am-btn-add-sw"
//                 onClick={() => navigate("/it/AssetsPage/AddSoftWare")}
//               >
//                 + Add Software
//               </button>
//               <button
//                 className="am-btn-add-emp"
//                 onClick={() => navigate("/it/AssetsPage/AddEmployee")}
//               >
//                 + Assign Asset
//               </button>
//             </div>
//             <span className="am-total-text">
//               Total Assets: <strong>{totalAssetCount}</strong>
//             </span>
//           </div>
//         </div>

//         {/* Controls */}
//         <div className="am-controls">
//           <div className="am-controls-left">
//             <div className="am-toggle-group">
//               {["Available", "Assigned"].map((f) => (
//                 <button
//                   key={f}
//                   className={`am-toggle${mainFilter === f ? " active" : ""}`}
//                   onClick={() => handleMainFilter(f)}
//                 >
//                   {f}
//                 </button>
//               ))}
//             </div>
//           </div>
//           <div className="am-search-row">
//             <div className="am-search-wrap">
//               <span className="am-search-icon">⌕</span>
//               <input
//                 className="am-search-input"
//                 placeholder="Search assets…"
//                 value={search}
//                 onChange={(e) => setSearch(e.target.value)}
//                 onKeyDown={handleKeyDown}
//               />
//               {search && (
//                 <button
//                   className="am-search-clear"
//                   onClick={() => {
//                     setSearch("");
//                     setSearchQuery("");
//                   }}
//                   aria-label="Clear search"
//                 >
//                   ×
//                 </button>
//               )}
//             </div>
//             <button className="am-search-btn" onClick={handleSearch}>
//               Search
//             </button>
//           </div>
//         </div>

//         {/* Category filter bar */}
//         <div className="am-cat-bar">
//           {CATEGORIES.map((cat) => (
//             <button
//               key={cat}
//               className={`am-cat-btn${catFilter === cat ? " active" : ""}`}
//               onClick={() => setCatFilter(cat)}
//             >
//               {cat}
//               <span className="am-cat-count">
//                 {cat === "ALL"
//                   ? data.length
//                   : data.filter((a) => a.category === cat).length}
//               </span>
//             </button>
//           ))}
//         </div>

//         {/* Table card */}
//         <div className="am-table-card">
//           <div className="am-table-head-bar">
//             <div className="am-table-head-left">
//               <span
//                 className={`am-filter-indicator ${mainFilter === "Available" ? "available" : "assigned"}`}
//               >
//                 {mainFilter === "Available"
//                   ? "● Available Assets"
//                   : "● Assigned Assets"}
//               </span>
//               {catFilter !== "ALL" && (
//                 <span className="am-cat-indicator">{catFilter}</span>
//               )}
//             </div>
//             <span className="am-table-count">
//               {filtered.length} record{filtered.length !== 1 ? "s" : ""}
//             </span>
//           </div>

//           <div className="am-table-scroll">
//             {mainFilter === "Available" ? (
//               <table className="am-table">
//                 <thead>
//                   <tr>
//                     <th>Assets Name</th>
//                     <th>Category</th>
//                     <th>Available Qty</th>
//                     <th>Details</th>
//                   </tr>
//                 </thead>
//                 <tbody>
//                   {filtered.length === 0 ? (
//                     <tr>
//                       <td colSpan={4} className="am-empty">
//                         No assets found
//                       </td>
//                     </tr>
//                   ) : (
//                     filtered.map((a, i) => {
//                       const cc = CAT_COLOR[a.category] || CAT_COLOR.Hardware;
//                       return (
//                         <tr
//                           key={`${a.id}-${i}`}
//                           className={i % 2 === 0 ? "am-tr-even" : "am-tr-odd"}
//                         >
//                           <td className="am-td-name">
//                             {a.category === "Software" && (
//                               <span className="am-sw-icon">💿</span>
//                             )}
//                             {a.name}
//                             {a.hwType && (
//                               <span className="am-hwtype-chip">{a.hwType}</span>
//                             )}
//                           </td>
//                           <td>
//                             <span
//                               className="am-cat-badge"
//                               style={{
//                                 background: cc.bg,
//                                 color: cc.color,
//                                 border: `1px solid ${cc.border}`,
//                               }}
//                             >
//                               {a.category}
//                             </span>
//                           </td>
//                           <td>
//                             {a.category === "Software" ? (
//                               <span className="am-sw-qty">
//                                 {a.seats
//                                   ? `${a.availableQty} / ${a.seats} seats`
//                                   : a.availableQty || "—"}
//                               </span>
//                             ) : (
//                               <span className="am-qty-badge">
//                                 {a.availableQty}
//                               </span>
//                             )}
//                           </td>
//                           <td>
//                             <button
//                               className="am-view-btn"
//                               onClick={() => setDetailItem(a)}
//                             >
//                               View
//                             </button>
//                           </td>
//                         </tr>
//                       );
//                     })
//                   )}
//                 </tbody>
//               </table>
//             ) : (
//               <table className="am-table">
//                 <thead>
//                   <tr>
//                     <th>Assets Name</th>
//                     <th>Category</th>
//                     <th>Employee ID</th>
//                     <th>Employee Name</th>
//                     <th>Details</th>
//                     <th>Edit</th>
//                   </tr>
//                 </thead>
//                 <tbody>
//                   {filtered.length === 0 ? (
//                     <tr>
//                       <td colSpan={6} className="am-empty">
//                         No assets found
//                       </td>
//                     </tr>
//                   ) : (
//                     filtered.map((a, i) => {
//                       const cc = CAT_COLOR[a.category] || CAT_COLOR.Hardware;
//                       return (
//                         <tr
//                           key={`${a.id}-${i}`}
//                           className={i % 2 === 0 ? "am-tr-even" : "am-tr-odd"}
//                         >
//                           <td className="am-td-name">{a.name}</td>
//                           <td>
//                             <span
//                               className="am-cat-badge"
//                               style={{
//                                 background: cc.bg,
//                                 color: cc.color,
//                                 border: `1px solid ${cc.border}`,
//                               }}
//                             >
//                               {a.category}
//                             </span>
//                           </td>
//                           <td>
//                             <span className="am-emp-id">{a.empId}</span>
//                           </td>
//                           <td>
//                             <div className="am-assignee">
//                               <span className="am-avatar">
//                                 {(a.empName || "?").charAt(0)}
//                               </span>
//                               <span className="am-emp-name">{a.empName}</span>
//                             </div>
//                           </td>
//                           <td>
//                             <button
//                               className="am-view-btn"
//                               onClick={() =>
//                                 handleAssignedView(a.empId, a.empName)
//                               }
//                             >
//                               View
//                             </button>
//                           </td>
//                           <td>
//                             <button
//                               className="am-edit-btn"
//                               onClick={() =>
//                                 setEditRow({
//                                   id: a.id,
//                                   unitId: a.unitId,
//                                   name: a.name,
//                                   category: a.category,
//                                   empId: String(a.empId || ""),
//                                   empName: String(a.empName || "—"),
//                                 })
//                               }
//                             >
//                               Edit
//                             </button>
//                           </td>
//                         </tr>
//                       );
//                     })
//                   )}
//                 </tbody>
//               </table>
//             )}
//           </div>
//         </div>
//       </div>

//       {/* Panels / modals */}
//       {detailItem && (
//         <AvailableDetailPanel
//           item={detailItem}
//           onClose={() => setDetailItem(null)}
//         />
//       )}
//       {editRow && (
//         <EditAssignedPanel
//           assignedRow={editRow}
//           onClose={() => setEditRow(null)}
//           onUpdated={handleEditUpdated}
//         />
//       )}
//     </div>
//   );
// }

