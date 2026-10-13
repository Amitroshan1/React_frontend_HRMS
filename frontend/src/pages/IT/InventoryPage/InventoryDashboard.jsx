// InventoryDashboard.jsx
import { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { toast } from "react-toastify";
import ClickableImage from "../../../components/ClickableImage";
import ShowMoreRows from "../../../components/ShowMoreRows";
import { useRefreshOnNavigate } from "../../../hooks/useRefreshOnNavigate";
import { useIncrementalList } from "../../../hooks/useIncrementalList";
import { buildUnitLookupIndex, lookupUnitsForAsset } from "../unitLookupIndex";
import { isAdminVisitActive } from "../../../hooks/useAdminVisitNav";
import "./InventoryDashboard.css";
import {
  InventoryPanel,
  InventoryFiltersInner,
  InventoryFilterSearch,
} from "./InventoryPanel";

import {
  getInventoryFromStorage,
  saveInventoryToStorage,
  getAssetUnitsFromStorage,
  saveAssetUnitsToStorage,
  notifyInventoryChange,
  logDeletedAsset,
  getInventoryCounts,
  toastITApiFailure,
  syncITDataFromAPI,
  IT_NAV_SYNC_MAX_AGE_MS,
  syncDeletedLogsFromAPI,
  setUnitStatusAPI,
  createDeletedLogAPI,
  deleteAssetUnitAPI,
  updateInventoryItemAPI,
  getDeletedAssetsFromStorage,
  getSoftwareInventory,
  toLocalInventoryItem,
} from "../Data";
import { IT_SERVER_LISTS_ENABLED, useDebouncedValue, useITList } from "../useITList";
import { useTransitionRemark } from "../itam/TransitionRemarkModal";
import { actionCodeForStatusChange, remarkPayload } from "../itam/transitionUi";
import AssetHistoryTimeline from "../itam/AssetHistoryTimeline";
import { AssetReviewsModal } from "../itam/AssetReviewsPanel";
import { isItamFlagEnabled } from "../../../utils/itamFlags";
import { unitCustodyLabel, unitStatusLabel } from "../itam/lifecycleUi";

import AddNewAssets    from "./AddnewAssets";
import NotWorking      from "./NotWorking";
import InRepair        from "./InRepair";
import RemovedAssets   from "./RemovedAssets";
import RemovedITAssets from "./RemovedITAssets";
import Parcel          from "./Parcel/ParcelDashboard";
import AddImported     from "./Parcel/AddImportedAssets";
import ReadyExport     from "./Parcel/ExportedAssets";
import ActivityLogPage from "../itam/ActivityLogPage";
import {
  INV_CATEGORIES,
  deletedLogBelongsToInventoryCategory,
  filterInventoryByCategory,
  getAssignedColumnLabel,
  resolveInventoryCategory,
  getHardwareFields,
  getMobileTabletHardwareFields,
  isLaptopHardwareRow,
  shouldShowLaptopCodeColumn,
  isMobileTabletHwType,
  getUnitBrandModelDisplay,
  hideAssignedColumnForCategory,
  isStockInventoryCategory,
  isValidInventoryCategory,
  isVehicleInventoryCategory,
  showInventoryDeploy,
  getDeployModalConfig,
  rowSupportsInventoryDeploy,
  isUnitDeployRow,
  getAccessoryTypesForCategory,
  getConsumableTypesForCategory,
  getHwTypesForCategory,
  subscribeHwTypesChange,
  INVENTORY_CATEGORY_CONFIG,
} from "../inventoryCategories";
import { OfficeIssueModal, OfficeReturnModal } from "./OfficeStockModals";
import { formatDate } from "../../../utils/dateFormat";

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE           = "/it/inventory";
const REMOVED_IT_KEY = "removedITAssets";

const SUMMARY_CARDS = [
  { label: "Total Assets",    segment: "total",          color: "#3b82f6" },
  { label: "Not Working",     segment: "not-working",    color: "#ef4444" },
  { label: "In Repair",       segment: "in-repair",      color: "#f59e0b" },
  { label: "Removed From IT", segment: "removed-it",     color: "#06b6d4" },
  { label: "Dead Assets",     segment: "removed-assets", color: "#64748b" },
];

const FILTER_OPTIONS = ["All", "Available", "Assigned"];

const STATUS_FILTERS = [
  { id: "All", label: "All", chip: "all" },
  { id: "Available", label: "Available", chip: "available" },
  { id: "Assigned", label: "Assigned", chip: "assigned" },
];

const OVERVIEW_PATH = "/inventory/overview";
const SERVER_PAGE_SIZE = 50;
const OVERVIEW_MORE_PARAMS = { counts: 0 };
const NO_ROWS = [];

/** Overview / Total Assets rows, filtered + counted + paged on the server (falls back to the cache on error). */
function useInventoryOverviewList(params) {
  const list = useITList(OVERVIEW_PATH, params, {
    enabled: IT_SERVER_LISTS_ENABLED,
    pageSize: SERVER_PAGE_SIZE,
    moreParams: OVERVIEW_MORE_PARAMS,
    mapItem: mapServerInventoryRow,
  });
  return { ...list, active: IT_SERVER_LISTS_ENABLED && !list.error };
}

const EDIT_OPTIONS = [
  { key: "repair",     label: "Repair",     icon: "🔧", color: "#d97706", hoverBg: "#fef3c7", bg: "#fffbeb", borderColor: "#d97706" },
  { key: "notWorking", label: "Not Working", icon: "⚠️",  color: "#ef4444", hoverBg: "#fee2e2", bg: "#fef2f2", borderColor: "#ef4444" },
  { key: "removed",   label: "Remove",     icon: "🗑️",  color: "#64748b", hoverBg: "#f1f5f9", bg: "#f8fafc", borderColor: "#94a3b8" },
];

const IT_CATEGORY_FILTERS = [
  { id: "All", label: "All", chip: "all" },
  { id: "Hardware", label: "Hardware", chip: "hardware" },
  { id: "Accessories", label: "Accessories", chip: "accessories" },
  { id: "Consumables", label: "Consumable", chip: "consumables" },
];

function useItHwSubFilters() {
  const [filters, setFilters] = useState(() => [
    "All",
    ...getHwTypesForCategory("IT Assets"),
  ]);
  useEffect(() => {
    const refresh = () =>
      setFilters(["All", ...getHwTypesForCategory("IT Assets")]);
    refresh();
    return subscribeHwTypesChange(refresh);
  }, []);
  return filters;
}

function useItAccSubFilters() {
  const [filters, setFilters] = useState(() => [
    "All",
    ...getAccessoryTypesForCategory("IT Assets"),
  ]);
  useEffect(() => {
    const refresh = () =>
      setFilters(["All", ...getAccessoryTypesForCategory("IT Assets")]);
    refresh();
    return subscribeHwTypesChange(refresh);
  }, []);
  return filters;
}

function useItConsSubFilters() {
  const [filters, setFilters] = useState(() => [
    "All",
    ...getConsumableTypesForCategory("IT Assets"),
  ]);
  useEffect(() => {
    const refresh = () =>
      setFilters(["All", ...getConsumableTypesForCategory("IT Assets")]);
    refresh();
    return subscribeHwTypesChange(refresh);
  }, []);
  return filters;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

const isSoftware = (item) =>
  (item?.category ?? "").trim().toLowerCase() === "software";

const isAssignedToObject = (assignedTo) =>
  assignedTo != null && typeof assignedTo === "object";

function daysLeft(end) {
  if (!end) return null;
  return Math.ceil((new Date(end) - Date.now()) / 864e5);
}

function formatAssignedToLabel(assignedTo) {
  if (!assignedTo) return "—";
  if (isAssignedToObject(assignedTo)) {
    const name = assignedTo.name;
    const empId = assignedTo.empId;
    if (name && name !== "—") {
      return empId && empId !== "—" ? `${name} (${empId})` : name;
    }
    return empId || "—";
  }
  return String(assignedTo);
}

function getSoftwareLicensesForAsset(asset) {
  const nameKey = (asset?.name || "").trim().toLowerCase();
  const assetId = asset?.id != null ? String(asset.id) : "";
  return (getSoftwareInventory() || []).filter((lic) => {
    if (assetId && lic.inventoryId != null && String(lic.inventoryId) === assetId) {
      return true;
    }
    return (lic.name || "").trim().toLowerCase() === nameKey;
  });
}

function licenseStatusMeta(lic) {
  const days = daysLeft(lic.subscriptionEnd || lic.licenseExpiry);
  const expired = days !== null && days < 0;
  const warn = !expired && days !== null && days <= 30;
  if (expired) {
    return { label: "Expired", className: "inv-sw-status--expired" };
  }
  if (warn) {
    return { label: "Expiring Soon", className: "inv-sw-status--warn" };
  }
  if (lic.status === "assigned" && lic.assignedTo) {
    return { label: "Assigned", className: "inv-sw-status--assigned" };
  }
  return { label: "Available", className: "inv-sw-status--available" };
}

const isQtyManagedCategory = (category) =>
  ["accessories", "consumables", "accessory", "consumable", "stock"].includes(
    String(category || "").trim().toLowerCase(),
  );

const isStockLineItem = (item) =>
  String(item?.category || "").trim().toLowerCase() === "stock";

/** Office / Infrastructure bulk stock and qty-managed lines use quantity actions. */
const isQuantityStockRow = (row) =>
  Boolean(row?.isStock) ||
  isStockLineItem(row) ||
  isQtyManagedCategory(row?.category);

const readInventory  = () => getInventoryFromStorage() ?? [];
const writeInventory = (data) => saveInventoryToStorage(data);
const readUnits      = () => getAssetUnitsFromStorage() ?? [];
const writeUnits     = (data) => saveAssetUnitsToStorage(data);

function dispatchInventoryUpdate() {
  try { window.dispatchEvent(new Event("inventory-updated")); } catch { /* no-op */ }
}

function readRemovedITCount() {
  try { return (JSON.parse(localStorage.getItem(REMOVED_IT_KEY) ?? "[]")).length; }
  catch { return 0; }
}

function countRemovedAssetsForCategory(inventoryCategory) {
  const deleted = getDeletedAssetsFromStorage() || [];
  if (!inventoryCategory) return deleted.length;
  const inventory = readInventory();
  const units = readUnits();
  return deleted.filter((d) =>
    deletedLogBelongsToInventoryCategory(d, inventoryCategory, {
      inventory,
      units,
    }),
  ).length;
}

function readLiveCounts(inventoryCategory = null) {
  const inventory = filterInventoryByCategory(readInventory(), inventoryCategory);
  const counts = getInventoryCounts();

  const total = inventory
    .filter((i) => !isSoftware(i))
    .reduce((sum, i) => sum + (Number(i.totalQuantity) || 0), 0);
  const notWorking = inventory
    .filter((i) => !isSoftware(i))
    .reduce((sum, i) => sum + (Number(i.notWorkingQuantity) || 0), 0);
  const inRepair = inventory
    .filter((i) => !isSoftware(i))
    .reduce((sum, i) => sum + (Number(i.repairQuantity) || 0), 0);

  return {
    total:            Math.max(0, total),
    "not-working":    Math.max(0, notWorking || (inventoryCategory ? 0 : counts.notWorking) || 0),
    "in-repair":      Math.max(0, inRepair || (inventoryCategory ? 0 : counts.inRepair) || 0),
    "removed-assets": inventoryCategory
      ? countRemovedAssetsForCategory(inventoryCategory)
      : (counts.removedAssets || 0),
    "removed-it":     inventoryCategory === "IT Assets" || !inventoryCategory
      ? readRemovedITCount()
      : 0,
  };
}

function mapInventoryItem(item, unitIndex = null) {
  const units = getUnitsForAsset(item.id, item.name, item.hwType, unitIndex);
  return mapInventoryRow(item, units[0]);
}

/** Row from /inventory/overview: the server sends the newest unit's brand/make/model as first_unit. */
function mapServerInventoryRow(apiItem) {
  return mapInventoryRow(toLocalInventoryItem(apiItem), apiItem?.first_unit || undefined);
}

function mapInventoryRow(item, firstUnit) {
  const inventoryCategory = resolveInventoryCategory(item);
  return {
    id:                item.id,
    name:              item.name,
    hwType:            item.hwType             ?? null,
    total:             Number(item.totalQuantity)     || 0,
    available:         Number(item.availableQuantity) || 0,
    inventoryCategory,
    assigned:          Number(item.assignedQuantity)  || 0,
    notWorking:        Number(item.notWorkingQuantity) || 0,
    inRepair:          Number(item.repairQuantity)     || 0,
    brand:             firstUnit?.brand ?? item.brand ?? "—",
    make:              firstUnit?.make ?? item.make ?? "—",
    model:             firstUnit?.model ?? item.model ?? "—",
    serialNumber:      item.serialNumber || "—",
    category:          item.category     || "—",
    vendor:            item.vendor       || "—",
    purchaseDate:      item.purchaseDate || null,
    location:          item.location     || "—",
    notes:             item.notes        || "",
    receipts:          item.receipts     || [],
    photos:            item.photos       || [],
    isStock:           isStockLineItem(item),
    isSoftware:        isSoftware(item),
  };
}

function getMappedInventory(inventoryCategory = null) {
  const unitIndex = buildInventoryUnitIndex();
  const items = readInventory()
    .map((item) => mapInventoryItem(item, unitIndex))
    .filter((i) => !i.isSoftware);
  return inventoryCategory
    ? filterInventoryByCategory(items, inventoryCategory)
    : items;
}

const sameUnitHwType = (u, hwType) =>
  String(u.hwType ?? "").toLowerCase() === String(hwType).toLowerCase();

function buildInventoryUnitIndex() {
  return buildUnitLookupIndex(readUnits());
}

/**
 * Units for an inventory row: by inventoryId, else legacy name + hwType (so Apple Mobile ≠
 * Apple Laptop), else name only. Pass a prebuilt `unitIndex` when looping over many rows.
 */
function getUnitsForAsset(inventoryId, assetName, hwType, unitIndex = null) {
  return lookupUnitsForAsset(
    unitIndex || buildInventoryUnitIndex(),
    inventoryId,
    assetName,
    hwType,
    sameUnitHwType,
  );
}

function buildReviewTarget(row, preferredUnit = null) {
  const units = getUnitsForAsset(row?.id, row?.name, row?.hwType);
  const numbered = units.filter((u) => u?.id != null && Number.isFinite(Number(u.id)));
  const preferredId = preferredUnit?.id != null ? Number(preferredUnit.id) : null;
  const unitId =
    preferredId && numbered.some((u) => Number(u.id) === preferredId)
      ? preferredId
      : numbered.length > 0
        ? Number(numbered[0].id)
        : null;
  return {
    asset: row,
    units: numbered,
    unitId,
    inventoryItemId: unitId == null ? row?.id ?? null : null,
  };
}

function inventoryCategoryMatches(assetCategory, filterId) {
  if (!filterId || filterId === "All") return true;
  const c = String(assetCategory || "").trim().toLowerCase();
  const f = String(filterId).trim().toLowerCase();
  if (f === "consumables") return c === "consumables" || c === "consumable";
  if (f === "accessories") return c === "accessories" || c === "accessory";
  return c === f;
}

function assetMatchesHwSubFilter(asset, hwSubFilter) {
  if (!hwSubFilter || hwSubFilter === "All") return true;
  return String(asset.hwType || "").trim().toLowerCase() === hwSubFilter.toLowerCase();
}

/** Sum of total qty by hwType within a category (All = category total). Keys preserve first-seen casing. */
function buildHwTypeQtyCounts(assets, categoryFilter) {
  const counts = Object.create(null);
  counts.All = 0;
  const keyMap = Object.create(null); // lower -> display key

  (assets || []).forEach((a) => {
    if (!inventoryCategoryMatches(a.category, categoryFilter)) return;
    const qty = Number(a.total) || 0;
    if (qty <= 0) return;
    counts.All += qty;
    const raw = String(a.hwType || "").trim() || "Other";
    const lower = raw.toLowerCase();
    if (!keyMap[lower]) keyMap[lower] = raw;
    const key = keyMap[lower];
    counts[key] = (counts[key] || 0) + qty;
  });
  return counts;
}

function getHwTypeQtyCount(counts, typeLabel) {
  if (!counts) return 0;
  if (!typeLabel || typeLabel === "All") return counts.All || 0;
  if (counts[typeLabel] != null) return counts[typeLabel];
  const lower = String(typeLabel).toLowerCase();
  const key = Object.keys(counts).find((k) => k.toLowerCase() === lower);
  return key ? counts[key] : 0;
}

/** Qty totals for IT category chips (All / Hardware / Software / …). */
function buildCategoryQtyCounts(assets) {
  const base = (assets || []).filter((a) => Number(a.total) > 0);
  const sumFor = (filterId) =>
    base
      .filter((a) => inventoryCategoryMatches(a.category, filterId))
      .reduce((sum, a) => sum + (Number(a.total) || 0), 0);
  return {
    All: base.reduce((sum, a) => sum + (Number(a.total) || 0), 0),
    Hardware: sumFor("Hardware"),
    Software: sumFor("Software"),
    Accessories: sumFor("Accessories"),
    Consumables: sumFor("Consumables"),
  };
}

function assetMatchesProjectName(asset, projectName, unitIndex = null) {
  if (!projectName || projectName === "All") return true;
  const needle = projectName.trim().toLowerCase();
  const units = getUnitsForAsset(asset.id, asset.name, asset.hwType, unitIndex);
  return units.some((u) => {
    const code = (u.projectCode || u.project_code || "").trim().toLowerCase();
    const legacy = (u.make || "").trim().toLowerCase();
    return code === needle || (!code && legacy === needle);
  });
}

function collectProjectNamesFromAssets(assets) {
  const names = new Set();
  const unitIndex = buildInventoryUnitIndex();
  assets.forEach((asset) => {
    if (!isMobileTabletHwType(asset.hwType)) return;
    getUnitsForAsset(asset.id, asset.name, asset.hwType, unitIndex).forEach((unit) => {
      const code = (unit.projectCode || unit.project_code || "").trim();
      if (code) {
        names.add(code);
        return;
      }
      const legacy = (unit.make || "").trim();
      if (legacy) names.add(legacy);
    });
  });
  return ["All", ...Array.from(names).sort((a, b) => a.localeCompare(b))];
}

function filterITOverviewAssets(assets, {
  categoryFilter,
  hwSubFilter,
  projectNameFilter,
  searchQuery,
  statusFilter = "All",
}) {
  const q = searchQuery.trim().toLowerCase();
  const needsProjectMatch =
    categoryFilter === "Hardware" &&
    isMobileTabletHwType(hwSubFilter) &&
    projectNameFilter &&
    projectNameFilter !== "All";
  const unitIndex = needsProjectMatch ? buildInventoryUnitIndex() : null;
  return assets
    .filter((a) => inventoryCategoryMatches(a.category, categoryFilter))
    .filter((a) => {
      if (categoryFilter === "Hardware" || categoryFilter === "Accessories" || categoryFilter === "Consumables") {
        return assetMatchesHwSubFilter(a, hwSubFilter);
      }
      return true;
    })
    .filter((a) => {
      if (categoryFilter !== "Hardware" || !isMobileTabletHwType(hwSubFilter)) return true;
      return assetMatchesProjectName(a, projectNameFilter, unitIndex);
    })
    .filter((a) => {
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        (a.hwType ?? "").toLowerCase().includes(q) ||
        (a.category ?? "").toLowerCase().includes(q)
      );
    })
    .filter((a) => {
      if (statusFilter === "Available") return Number(a.available) > 0;
      if (statusFilter === "Assigned") return Number(a.assigned) > 0;
      return true;
    });
}

function buildStatusQtyCounts(assets) {
  const list = assets || [];
  return {
    All: list.length,
    Available: list.filter((a) => Number(a.available) > 0).length,
    Assigned: list.filter((a) => Number(a.assigned) > 0).length,
  };
}

function safeLogDeletedAsset(asset, deletedBy, reason) {
  try { logDeletedAsset(asset, deletedBy, reason); }
  catch (err) { console.error("[InventoryDashboard] logDeletedAsset failed:", err); }
}

function applyInventoryCountMutation(item, actionKey) {
  if (actionKey === "repair") {
    item.repairQuantity    = (Number(item.repairQuantity)    || 0) + 1;
    item.availableQuantity = Math.max(0, (Number(item.availableQuantity) || 0) - 1);
  } else if (actionKey === "notWorking") {
    item.notWorkingQuantity = (Number(item.notWorkingQuantity) || 0) + 1;
    item.availableQuantity  = Math.max(0, (Number(item.availableQuantity) || 0) - 1);
  } else if (actionKey === "removed") {
    item.totalQuantity      = Math.max(0, (Number(item.totalQuantity)     || 0) - 1);
    item.availableQuantity  = Math.max(0, (Number(item.availableQuantity) || 0) - 1);
  }
}

function updateInventoryCounts(row, actionKey) {
  const inventory = readInventory();
  const index     = inventory.findIndex((i) => String(i.id) === String(row.id));
  if (index < 0) { notifyInventoryChange(); return; }

  const item = { ...inventory[index] };
  applyInventoryCountMutation(item, actionKey);

  if (actionKey === "removed" && Number(item.totalQuantity) <= 0) {
    writeInventory(inventory.filter((_, i) => i !== index));
  } else {
    inventory[index] = item;
    writeInventory(inventory);
  }
  notifyInventoryChange();
}

function buildSyntheticUnit(row, status) {
  const clean = (val) => (val && val !== "—" ? val : "");
  return {
    id:           `synth-unit-${row.id}`,
    inventoryId:  String(row.id),
    assetName:    row.name,
    brand:        clean(row.brand)        || row.name,
    model:        clean(row.model),
    category:     clean(row.category)     || "Hardware",
    serialNumber: clean(row.serialNumber),
    location:     clean(row.location),
    purchaseDate: row.purchaseDate ?? null,
    status,
    repairDate:   status === "repair" ? new Date().toISOString() : null,
  };
}

function findUnitIndex(all, row) {
  const byId = all.findIndex(
    (u) =>
      String(u.inventoryId) === String(row.id) ||
      u.id === `synth-unit-${row.id}`,
  );
  if (byId >= 0) return byId;
  return all.findIndex((u) => u.assetName === row.name || u.name === row.name);
}

// ─── RemoveAssetModal ─────────────────────────────────────────────────────────

function RemoveAssetModal({ asset, onConfirm, onCancel }) {
  const prefilledReason = String(asset?._remarkText || "").trim();
  const [removedBy, setRemovedBy] = useState("");
  const [reason,    setReason]    = useState(prefilledReason);
  const [errors,    setErrors]    = useState({});

  const handleSubmit = () => {
    const nextErrors = {};
    if (!removedBy.trim()) nextErrors.removedBy = "Required";
    if (!reason.trim())    nextErrors.reason    = "Required";
    else if (reason.trim().length < 20) nextErrors.reason = "Min 20 characters";
    if (Object.keys(nextErrors).length) { setErrors(nextErrors); return; }
    const trimmed = reason.trim();
    onConfirm(removedBy.trim(), trimmed, {
      ...(asset?._remarkFields || {}),
      remark: trimmed,
      notes: trimmed,
    });
  };

  return (
    <div className="inv-modal-backdrop" onClick={onCancel}>
      <div className="inv-modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="inv-modal-hero">
          <p className="inv-modal-hero-label">Asset Action</p>
          <h2 className="inv-modal-hero-title">Remove Asset</h2>
          <p className="inv-modal-hero-sub">{asset?.name}</p>
        </div>
        <div className="inv-modal-body">
          <p className="inv-modal-hint">
            This asset will be moved to <strong>Removed Assets</strong>. Confirm who is removing it
            {prefilledReason ? " (remarks already captured)" : " and why"}.
          </p>

          <div className="inv-modal-field">
            <label className="inv-modal-label">Removed By <span className="req">*</span></label>
            <input
              className={`inv-modal-input${errors.removedBy ? " err" : ""}`}
              value={removedBy}
              onChange={(e) => setRemovedBy(e.target.value)}
              placeholder="Enter your name"
            />
            {errors.removedBy && <span className="inv-modal-err">{errors.removedBy}</span>}
          </div>

          <div className="inv-modal-field">
            <label className="inv-modal-label">Reason for Removal <span className="req">*</span></label>
            <textarea
              className={`inv-modal-textarea${errors.reason ? " err" : ""}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why this asset is being removed..."
              rows={3}
            />
            {errors.reason && <span className="inv-modal-err">{errors.reason}</span>}
          </div>

          <div className="inv-modal-actions">
            <button className="inv-modal-btn-confirm" onClick={handleSubmit}>Confirm Remove</button>
            <button className="inv-modal-btn-cancel"  onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuantityActionModal({ actionTarget, onConfirm, onCancel }) {
  const row = actionTarget?.row || null;
  const actionKey = actionTarget?.actionKey || "";
  const actionLabel = actionKey === "notWorking"
    ? "Not Working"
    : actionKey === "removed"
      ? "Dead Device"
      : "Repair";

  const isRemove = actionKey === "removed";
  const remarkMin = actionKey === "notWorking" ? 15 : actionKey === "removed" ? 20 : 10;
  const maxQty = Math.max(0, Number(row?.available ?? 0));
  const [quantity, setQuantity] = useState(maxQty > 0 ? "1" : "0");
  const [removedBy, setRemovedBy] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  const submit = () => {
    const qty = Number.parseInt(quantity, 10);
    const nextErrors = {};
    if (!Number.isFinite(qty) || qty < 1) {
      setError("Enter a valid quantity (minimum 1).");
      return;
    }
    if (qty > maxQty) {
      setError(`Quantity cannot exceed available count (${maxQty}).`);
      return;
    }
    if (!reason.trim()) nextErrors.reason = "Remarks required";
    else if (reason.trim().length < remarkMin) {
      nextErrors.reason = `Min ${remarkMin} characters`;
    }
    if (isRemove && !removedBy.trim()) nextErrors.removedBy = "Required";
    if (Object.keys(nextErrors).length) {
      setFieldErrors(nextErrors);
      setError("");
      return;
    }
    setError("");
    setFieldErrors({});
    onConfirm(qty, {
      removedBy: isRemove ? removedBy.trim() : "",
      reason: reason.trim(),
      remark: reason.trim(),
      notes: reason.trim(),
    });
  };

  return (
    <div className="inv-modal-backdrop" onClick={onCancel}>
      <div className="inv-modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="inv-modal-hero">
          <p className="inv-modal-hero-label">Quantity Action</p>
          <h2 className="inv-modal-hero-title">{actionLabel}</h2>
          <p className="inv-modal-hero-sub">{row?.name || "Asset"}</p>
        </div>
        <div className="inv-modal-body">
          <p className="inv-modal-hint">
            How many items do you want to mark for <strong>{actionLabel}</strong>? Add remarks for the audit trail.
          </p>
          <div className="inv-modal-field">
            <label className="inv-modal-label">
              Quantity <span className="req">*</span>
            </label>
            <input
              className={`inv-modal-input${error ? " err" : ""}`}
              type="number"
              min={1}
              max={maxQty}
              value={quantity}
              onChange={(e) => {
                setQuantity(e.target.value);
                setError("");
              }}
              placeholder={`1 to ${maxQty}`}
            />
            <span className="inv-modal-hint-sub">Available: {maxQty}</span>
            {error && <span className="inv-modal-err">{error}</span>}
          </div>

          {isRemove && (
            <div className="inv-modal-field">
              <label className="inv-modal-label">
                Removed By <span className="req">*</span>
              </label>
              <input
                className={`inv-modal-input${fieldErrors.removedBy ? " err" : ""}`}
                value={removedBy}
                onChange={(e) => setRemovedBy(e.target.value)}
                placeholder="Enter your name"
              />
              {fieldErrors.removedBy && (
                <span className="inv-modal-err">{fieldErrors.removedBy}</span>
              )}
            </div>
          )}

          <div className="inv-modal-field">
            <label className="inv-modal-label">
              Remarks <span className="req">*</span>
            </label>
            <textarea
              className={`inv-modal-textarea${fieldErrors.reason ? " err" : ""}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                isRemove
                  ? "Explain why these items are being removed…"
                  : `Why marking as ${actionLabel}?`
              }
              rows={3}
            />
            <span className="inv-modal-hint-sub">
              {reason.trim().length}/{remarkMin} min
            </span>
            {fieldErrors.reason && (
              <span className="inv-modal-err">{fieldErrors.reason}</span>
            )}
          </div>

          <div className="inv-modal-actions">
            <button className="inv-modal-btn-confirm" onClick={submit}>
              Confirm
            </button>
            <button className="inv-modal-btn-cancel" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── UnitPickerModal ──────────────────────────────────────────────────────────
// Opens when user clicks Edit — lists each available unit (brand + serial no)
// so the user picks exactly which device to act on before choosing an action.

function UnitPickerModal({ row, onAction, onCancel }) {
  const [selectedUnitId, setSelectedUnitId] = useState(null);

  const allUnits = getUnitsForAsset(row.id, row.name, row.hwType);
  // Only show units that are still available (not assigned / day-use out / repair / etc.)
  const availableUnits = allUnits.filter((u) => {
    const s = String(u.status || "available").trim().toLowerCase();
    return s === "available";
  });

  const selectedUnit = availableUnits.find(
    (u) => (u.assetId ?? u.id) === selectedUnitId,
  ) ?? null;
  const useQuantityFallback = availableUnits.length === 0;

  return (
    <div className="inv-modal-backdrop" onClick={onCancel}>
      <div className="inv-upicker-box" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="inv-upicker-header">
          <div>
            <p className="inv-upicker-label">Edit Asset</p>
            <h2 className="inv-upicker-title">{row.name}</h2>
            {row.hwType && <p className="inv-upicker-sub">{row.hwType}</p>}
          </div>
          <button className="inv-detail-close-btn" onClick={onCancel}>×</button>
        </div>

        {/* Unit list */}
        <div className="inv-upicker-body">
          <p className="inv-upicker-hint">Select the unit you want to act on:</p>

          {availableUnits.length === 0 ? (
            <div className="inv-upicker-empty">
              <span>📦</span>
              <p>No available units found for this asset.</p>
              <p className="inv-upicker-empty-sub">
                You can still use actions below to update quantity-level status.
              </p>
            </div>
          ) : (
            <div className="inv-upicker-list">
              {availableUnits.map((u) => {
                const uid      = u.assetId ?? u.id;
                const brand    = u.brand || row.name;
                const serial   = u.serialNumber || "—";
                const serialPrefix = isVehicleInventoryCategory(row.inventoryCategory)
                  ? "Reg"
                  : "S/N";
                const isSelected = selectedUnitId === uid;
                return (
                  <button
                    key={uid}
                    className={`inv-upicker-unit${isSelected ? " inv-upicker-unit--selected" : ""}`}
                    onClick={() => setSelectedUnitId(isSelected ? null : uid)}
                  >
                    <span className="inv-upicker-unit-check">{isSelected ? "✔" : ""}</span>
                    <div className="inv-upicker-unit-info">
                      <span className="inv-upicker-unit-brand">{brand}</span>
                      <span className="inv-upicker-unit-serial">{serialPrefix}: {serial}</span>
                    </div>
                    {u.assetId && (
                      <span className="inv-upicker-unit-id">#{u.assetId}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Action buttons — use selected unit when present, else quantity-level fallback */}
        <div className="inv-upicker-actions">
          {EDIT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              className="inv-upicker-action-btn"
              style={{ color: opt.color, borderColor: opt.borderColor, background: opt.bg }}
              disabled={!selectedUnit && !useQuantityFallback}
              title={!selectedUnit && !useQuantityFallback ? "Select a unit first" : opt.label}
              onClick={() => onAction(row, opt.key, selectedUnit || null)}
              onMouseEnter={(e) => { if (selectedUnit || useQuantityFallback) e.currentTarget.style.background = opt.hoverBg; }}
              onMouseLeave={(e) => (e.currentTarget.style.background = opt.bg)}
            >
              <span>{opt.icon}</span> {opt.label}
            </button>
          ))}
          <button className="inv-upicker-cancel-btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── ViewActionGroup ──────────────────────────────────────────────────────────

function ViewActionGroup({
  row,
  onViewAsset,
  inventoryCategory,
  inventoryDeploy = false,
  onOfficeIssue,
  onOfficeReturn,
}) {
  const deployConfig = inventoryCategory ? getDeployModalConfig(inventoryCategory) : null;
  const deployable =
    inventoryDeploy && rowSupportsInventoryDeploy(row, inventoryCategory);
  const canIssue = deployable && Number(row.available) > 0;
  const canReturn = deployable && Number(row.assigned) > 0;

  return (
    <div className="inv-action-group">
      <button type="button" className="inv-action-btn" onClick={() => onViewAsset(row)}>
        View
      </button>
      {inventoryDeploy && deployable && (
        <>
          <button
            type="button"
            className="inv-action-btn inv-action-btn--issue"
            disabled={!canIssue}
            title={
              canIssue
                ? deployConfig?.deployTitle || "Deploy to location"
                : deployConfig?.deployDisabledTitle || "Nothing available to deploy"
            }
            onClick={() => onOfficeIssue?.(row)}
          >
            {deployConfig?.deployLabel || "Deploy"}
          </button>
          <button
            type="button"
            className="inv-action-btn inv-action-btn--return"
            disabled={!canReturn}
            title={
              canReturn
                ? deployConfig?.returnTitle || "Return to available"
                : deployConfig?.returnDisabledTitle || "Nothing currently in use"
            }
            onClick={() => onOfficeReturn?.(row)}
          >
            {deployConfig?.returnLabel || "Return"}
          </button>
        </>
      )}
    </div>
  );
}

// ─── SoftwareAssetDetailModal ─────────────────────────────────────────────────

const SW_SEAT_TABS = ["All", "Available", "Assigned"];

function SoftwareAssetDetailModal({ asset, onClose }) {
  const [seatTab, setSeatTab] = useState("All");

  const licenses = useMemo(() => getSoftwareLicensesForAsset(asset), [asset.id, asset.name]);

  const filteredLicenses = useMemo(() => {
    if (seatTab === "Available") {
      return licenses.filter((l) => l.status === "available" || !l.assignedTo);
    }
    if (seatTab === "Assigned") {
      return licenses.filter((l) => l.status === "assigned" && l.assignedTo);
    }
    return licenses;
  }, [licenses, seatTab]);

  const tabCounts = useMemo(
    () => ({
      All: licenses.length,
      Available: licenses.filter((l) => l.status === "available" || !l.assignedTo).length,
      Assigned: licenses.filter((l) => l.status === "assigned" && l.assignedTo).length,
    }),
    [licenses],
  );

  const subscriptionSummary = useMemo(() => {
    const starts = licenses.map((l) => l.subscriptionStart).filter(Boolean).sort();
    const ends = licenses.map((l) => l.subscriptionEnd).filter(Boolean).sort();
    return {
      start: starts[0] || null,
      end: ends.length ? ends[ends.length - 1] : null,
    };
  }, [licenses]);

  const firstAdded = useMemo(() => {
    const dates = licenses
      .map((l) => l.created_at || l.subscriptionStart)
      .filter(Boolean)
      .sort();
    return dates[0] || null;
  }, [licenses]);

  return (
    <div className="inv-detail-backdrop" onClick={onClose}>
      <div
        className="inv-detail-box inv-detail-box--software"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="inv-detail-hero inv-detail-hero--software">
          <div>
            <p className="inv-detail-hero-label">Software Details</p>
            <h2 className="inv-detail-hero-title">{asset.name}</h2>
            <div className="inv-detail-hero-badges">
              <span className="inv-detail-badge inv-detail-badge--software">💿 Software</span>
              <span className="inv-detail-badge inv-detail-badge--units">
                {licenses.length} license{licenses.length !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
          <button type="button" className="inv-detail-close-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="inv-detail-body">
          <div className="inv-sw-summary-grid">
            {[
              ["Total licenses", asset.total ?? licenses.length],
              ["Available", asset.available ?? tabCounts.Available],
              ["Assigned", asset.assigned ?? tabCounts.Assigned],
              ["Added", formatDate(firstAdded)],
              ["Subscription start", formatDate(subscriptionSummary.start)],
              ["Subscription end", formatDate(subscriptionSummary.end)],
            ].map(([label, value]) => (
              <div key={label} className="inv-sw-summary-item">
                <span className="inv-sw-summary-label">{label}</span>
                <strong className="inv-sw-summary-value">{value}</strong>
              </div>
            ))}
          </div>

          <p className="inv-sw-section-title">License seats</p>
          <div className="inv-sw-tabs">
            {SW_SEAT_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`inv-sw-tab${seatTab === tab ? " inv-sw-tab--active" : ""}`}
                onClick={() => setSeatTab(tab)}
              >
                {tab}
                <span className="inv-sw-tab-count">{tabCounts[tab]}</span>
              </button>
            ))}
          </div>

          {filteredLicenses.length === 0 ? (
            <div className="inv-sw-empty">No {seatTab.toLowerCase()} licenses.</div>
          ) : (
            <div className="inv-sw-table-wrap">
              <table className="inv-sw-table">
                <thead>
                  <tr>
                    <th>License ID</th>
                    <th>Status</th>
                    <th>Start</th>
                    <th>Expiry</th>
                    <th>Assigned to</th>
                    <th>Assigned on</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLicenses.map((lic) => {
                    const status = licenseStatusMeta(lic);
                    return (
                      <tr key={lic.id}>
                        <td className="inv-sw-mono">{lic.id}</td>
                        <td>
                          <span className={`inv-sw-status ${status.className}`}>
                            {status.label}
                          </span>
                        </td>
                        <td>{formatDate(lic.subscriptionStart)}</td>
                        <td>{formatDate(lic.subscriptionEnd)}</td>
                        <td>{formatAssignedToLabel(lic.assignedTo)}</td>
                        <td>{formatDate(lic.assignedDate)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="inv-detail-footer">
          <button type="button" className="inv-detail-footer-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── AssetDetailModal ─────────────────────────────────────────────────────────

function AssetDetailModal({
  asset,
  onClose,
  onStatusChange,
  inventoryCategory,
}) {
  const [selectedUnitIndex, setSelectedUnitIndex] = useState(0);
  const [detailTab, setDetailTab] = useState("details");
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const timelineOn = isItamFlagEnabled("itam_timeline_v1");

  useEffect(() => {
    setDetailTab("details");
  }, [selectedUnitIndex, asset?.id]);

  const units  = getUnitsForAsset(asset.id, asset.name, asset.hwType);
  const unit   = units[selectedUnitIndex] ?? null;
  const photos = unit?.photos ?? unit?.assignmentPhotos ?? [];
  const inventoryPhotos = asset?.photos ?? [];
  const inventoryReceipts = asset?.receipts ?? [];
  const stockMode = asset?.isStock || isStockLineItem(asset);
  const hwFields = isMobileTabletHwType(asset.hwType)
    ? getMobileTabletHardwareFields(getHardwareFields(asset.inventoryCategory, asset.category, asset.hwType))
    : getHardwareFields(asset.inventoryCategory, asset.category, asset.hwType);
  const showItemMeta =
    !stockMode &&
    (isVehicleInventoryCategory(asset.inventoryCategory) ||
      String(asset.category || "").toLowerCase() === "equipment");

  const invCat = inventoryCategory || asset?.inventoryCategory;
  const isInfraEquipment =
    invCat === "Infrastructure Assets" &&
    String(asset.category || "").toLowerCase() === "equipment";
  const brandModel = unit ? getUnitBrandModelDisplay(unit, invCat) : { primary: "—", secondary: "" };
  const hideInUseInSummary = showInventoryDeploy(invCat);
  const historyUnitId = unit?.id != null && Number.isFinite(Number(unit.id)) ? Number(unit.id) : null;
  const historyLabel =
    unit?.assetName ||
    unit?.serialNumber ||
    asset?.name ||
    "Asset";

  const detailFields = isInfraEquipment
    ? [
        {
          label: hwFields.serialNumber.label,
          value: unit?.serialNumber ?? "—",
          mono: true,
          highlight: true,
        },
        { label: "Make", value: brandModel.primary, mono: false, highlight: false },
        { label: hwFields.model.label, value: brandModel.secondary || "—", mono: false, highlight: false },
      ]
    : isMobileTabletHwType(asset.hwType)
    ? [
        { label: hwFields.projectCode.label, value: unit?.projectCode ?? "—", mono: false, highlight: false },
        { label: hwFields.brand.label, value: unit?.brand ?? brandModel.primary, mono: false, highlight: false },
        { label: hwFields.make.label, value: unit?.make || unit?.model || "—", mono: false, highlight: false },
        { label: "IMEI 1", value: unit?.imei1 ?? "—", mono: true, highlight: false },
        { label: "IMEI 2", value: unit?.imei2 ?? "—", mono: true, highlight: false },
        {
          label: hwFields.serialNumber.label,
          value: unit?.serialNumber ?? "—",
          mono: true,
          highlight: false,
        },
        { label: hwFields.deviceLocation.label, value: unit?.deviceLocation ?? "—", mono: false, highlight: false },
      ]
    : [
        { label: "Asset ID", value: unit?.assetId ?? unit?.id ?? "—", mono: true, highlight: true },
        { label: hwFields.brand.label, value: brandModel.primary, mono: false, highlight: false },
        { label: hwFields.make.label, value: unit?.make ?? "—", mono: false, highlight: false },
        {
          label: hwFields.model.label,
          value: brandModel.secondary || unit?.model || "—",
          mono: false,
          highlight: false,
        },
        {
          label: hwFields.serialNumber.label,
          value: unit?.serialNumber ?? "—",
          mono: true,
          highlight: false,
        },
      ];

  if (asset?.notes) {
    detailFields.push({
      label: isMobileTabletHwType(asset.hwType) ? "Comment" : "Remarks",
      value: asset.notes,
      mono: false,
      highlight: false,
    });
  }

  return (
    <>
      <div className="inv-detail-backdrop" onClick={onClose}>
        <div className="inv-detail-box" onClick={(e) => e.stopPropagation()}>

          <div className="inv-detail-hero">
            <div>
              <p className="inv-detail-hero-label">Asset Details</p>
              <h2 className="inv-detail-hero-title">{asset.name}</h2>
              <div className="inv-detail-hero-badges">
                <span className="inv-detail-badge inv-detail-badge--cat">{asset.inventoryCategory}</span>
                {!stockMode && (
                  <span className="inv-detail-badge inv-detail-badge--units">
                    {units.length} unit{units.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </div>
            <button className="inv-detail-close-btn" onClick={onClose}>×</button>
          </div>

          {units.length > 1 && (
            <div className="inv-unit-tabs">
              <span className="inv-unit-label">Unit:</span>
              {units.map((u, i) => (
                <button
                  key={u.assetId ?? i}
                  className={`inv-unit-tab${selectedUnitIndex === i ? " inv-unit-tab--active" : ""}`}
                  onClick={() => setSelectedUnitIndex(i)}
                >
                  #{u.assetTag ?? u.assetId ?? i + 1}
                </button>
              ))}
            </div>
          )}

          {timelineOn && historyUnitId ? (
            <div className="inv-detail-tabs" style={{ display: "flex", gap: 8, padding: "0 16px 8px" }}>
              <button
                type="button"
                className={`inv-unit-tab${detailTab === "details" ? " inv-unit-tab--active" : ""}`}
                onClick={() => setDetailTab("details")}
              >
                Details
              </button>
              <button
                type="button"
                className={`inv-unit-tab${detailTab === "history" ? " inv-unit-tab--active" : ""}`}
                onClick={() => setDetailTab("history")}
              >
                History
              </button>
            </div>
          ) : null}

          {unit?.lastRemark ? (
            <p
              className="itam-hist-latest"
              style={{ margin: "0 16px 8px", fontSize: "0.82rem", color: "#475569" }}
              title={unit.lastRemark}
            >
              Last remark: {unit.lastRemark}
            </p>
          ) : null}

          {unit && isItamFlagEnabled("itam_lifecycle_v1") ? (
            <p
              style={{ margin: "0 16px 8px", fontSize: "0.82rem", color: "#334155" }}
            >
              Status: {unitStatusLabel(unit)}
              {unit.custodyType ? ` · Custody: ${unitCustodyLabel(unit)}` : ""}
            </p>
          ) : null}

          <div className="inv-detail-body">
            {detailTab === "history" && timelineOn && historyUnitId ? (
              <AssetHistoryTimeline
                unitId={historyUnitId}
                assetLabel={historyLabel}
                embedded
              />
            ) : units.length === 0 ? (
              <div className="inv-detail-empty">
                <div className="inv-empty-qty-layout">
                  <div className="inv-empty-photo-card">
                    <p className="inv-empty-photo-title">
                      Photos {inventoryPhotos.length > 0 ? `(${inventoryPhotos.length})` : ""}
                    </p>
                    {inventoryPhotos.length === 0 ? (
                      <div className="inv-photos-empty">
                        <div className="inv-photos-empty-icon">📷</div>
                        <p className="inv-photos-empty-text">No photos available</p>
                      </div>
                    ) : (
                      <>
                        <div className="inv-photo-main">
                          <ClickableImage src={inventoryPhotos[0]} alt="asset" />
                          {inventoryPhotos.length > 1 && (
                            <span className="inv-photo-more-badge">+{inventoryPhotos.length - 1} more</span>
                          )}
                        </div>
                        {inventoryPhotos.length > 1 && (
                          <div className="inv-photo-strip">
                            {inventoryPhotos.map((src, i) => (
                              <ClickableImage
                                key={i}
                                src={src}
                                alt=""
                                className="inv-photo-thumb"
                              />
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {inventoryReceipts.length > 0 && (
                    <div className="inv-empty-photo-card">
                      <p className="inv-empty-photo-title">
                        Receipts ({inventoryReceipts.length})
                      </p>
                      <div className="inv-photo-strip">
                        {inventoryReceipts.map((src, i) => (
                          <ClickableImage
                            key={i}
                            src={src}
                            alt=""
                            className="inv-photo-thumb"
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="inv-empty-stats-card">
                    <p className="inv-empty-stats-title">Asset Summary</p>
                    <div className="inv-empty-stats-grid">
                      {[
                        ["Total Quantity", asset?.total ?? 0],
                        ["Available", asset?.available ?? 0],
                        ...(!hideInUseInSummary && !stockMode
                          ? [["Assigned", asset?.assigned ?? 0]]
                          : []),
                        ["Not Working", asset?.notWorking ?? 0],
                        ["In Repair", asset?.inRepair ?? 0],
                        ...(stockMode && asset?.vendor && asset.vendor !== "—"
                          ? [["Supplier", asset.vendor]]
                          : []),
                        ...(stockMode && asset?.purchaseDate
                          ? [["Purchase date", asset.purchaseDate]]
                          : []),
                        ...(stockMode && asset?.location && asset.location !== "—"
                          ? [["Location", asset.location]]
                          : []),
                      ].map(([label, value]) => (
                        <div key={label} className="inv-empty-stat">
                          <span>{label}</span>
                          <strong>{value}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {showItemMeta && (
                  <div className="inv-detail-meta-strip">
                    {asset.vendor && asset.vendor !== "—" && (
                      <span><strong>Vendor:</strong> {asset.vendor}</span>
                    )}
                    {asset.purchaseDate && (
                      <span><strong>Purchase:</strong> {asset.purchaseDate}</span>
                    )}
                    {asset.location && asset.location !== "—" && (
                      <span><strong>Location:</strong> {asset.location}</span>
                    )}
                  </div>
                )}
                <div className="inv-detail-fields">
                  {detailFields.map(({ label, value, mono, highlight }, idx) => (
                    <div
                      key={label}
                      className={[
                        "inv-detail-field-row",
                        highlight ? "inv-detail-field-row--highlight"
                          : idx % 2 !== 0 ? "inv-detail-field-row--alt"
                          : "",
                      ].filter(Boolean).join(" ")}
                    >
                      <span className="inv-detail-field-label">{label}</span>
                      <span
                        className={[
                          "inv-detail-field-value",
                          highlight ? "inv-detail-field-value--highlight" : "",
                          mono      ? "inv-detail-field-value--mono"      : "",
                        ].filter(Boolean).join(" ")}
                      >
                        {value}
                      </span>
                    </div>
                  ))}
                </div>

                <div>
                  <p className="inv-photos-label">
                    Photos {photos.length > 0 ? `(${photos.length})` : ""}
                  </p>
                  {photos.length === 0 ? (
                    <div className="inv-photos-empty">
                      <div className="inv-photos-empty-icon">📷</div>
                      <p className="inv-photos-empty-text">No photos available</p>
                    </div>
                  ) : (
                    <>
                      <div className="inv-photo-main">
                        <ClickableImage src={photos[0]} alt="asset" />
                        {photos.length > 1 && (
                          <span className="inv-photo-more-badge">+{photos.length - 1} more</span>
                        )}
                      </div>
                      {photos.length > 1 && (
                        <div className="inv-photo-strip">
                          {photos.map((src, i) => (
                            <ClickableImage
                              key={i}
                              src={src}
                              alt=""
                              className="inv-photo-thumb"
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="inv-detail-footer">
            <div className="inv-detail-footer-actions">
              {EDIT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  className="inv-inline-action-btn"
                  style={{
                    color: opt.color,
                    background: opt.bg,
                    borderColor: opt.borderColor,
                  }}
                  onClick={() => {
                    const actionUnit = stockMode && units.length === 0 ? null : unit;
                    onStatusChange?.(asset, opt.key, actionUnit);
                    onClose();
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = opt.hoverBg; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = opt.bg; }}
                >
                  <span>{opt.icon}</span> {opt.label}
                </button>
              ))}
              <button
                type="button"
                className="inv-inline-action-btn inv-reviews-footer-btn"
                onClick={() => setReviewsOpen(true)}
              >
                Reviews
              </button>
            </div>
            <button className="inv-detail-footer-btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>

      {reviewsOpen ? (
        <AssetReviewsModal
          target={buildReviewTarget(asset, unit)}
          onClose={() => setReviewsOpen(false)}
        />
      ) : null}

    </>
  );
}

// ─── useAssetActions hook ─────────────────────────────────────────────────────

function useAssetActions(onRefresh) {
  const [removeTarget, setRemoveTarget] = useState(null);
  const [quantityTarget, setQuantityTarget] = useState(null);
  const [toast,        setToast]        = useState("");
  const { requestRemark } = useTransitionRemark();

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2_800);
  }, []);

  const handleStatusChange = useCallback(async (row, actionKey, unit) => {
    if (!unit && isQuantityStockRow(row)) {
      setQuantityTarget({ row, actionKey });
      return;
    }

    const resolveUnitPreview = () => {
      const all = readUnits();
      if (unit) {
        const uid = unit.assetId ?? unit.id;
        const idx = all.findIndex((u) => (u.assetId ?? u.id) === uid);
        return idx >= 0 ? all[idx] : unit;
      }
      const matchIdx = findUnitIndex(all, row);
      return matchIdx >= 0 ? all[matchIdx] : null;
    };

    if (actionKey === "removed") {
      const previewUnit = resolveUnitPreview();
      const remarkResult = await requestRemark("RETIRE", {
        force: true,
        assetLabel: previewUnit?.assetName || previewUnit?.serialNumber || row?.name || "Asset",
        subtitle: "Remove / retire from inventory",
        defaultReasonCode: "PERMANENT_DELETE",
        defaultConditionGrade: "Fail",
      });
      if (remarkResult === null) return;
      setRemoveTarget({
        ...row,
        _selectedUnit: unit ?? null,
        _remarkFields: remarkPayload(remarkResult),
        _remarkText: String(remarkResult.remark || "").trim(),
      });
      return;
    }

    const targetStatus = actionKey === "repair" ? "repair" : "notWorking";
    const all          = readUnits();

    const resolveUnit = () => {
      if (unit) {
        const uid = unit.assetId ?? unit.id;
        const idx = all.findIndex((u) => (u.assetId ?? u.id) === uid);
        return idx >= 0 ? all[idx] : unit;
      }
      const matchIdx = findUnitIndex(all, row);
      return matchIdx >= 0 ? all[matchIdx] : null;
    };

    const rowUnit = resolveUnit();
    const serverUnitId = rowUnit != null ? Number(rowUnit.id) : NaN;
    const canSyncServer = Number.isFinite(serverUnitId) && serverUnitId > 0;

    const actionCode = actionCodeForStatusChange(actionKey, rowUnit?.status);
    const remarkResult = await requestRemark(actionCode, {
      force: true,
      assetLabel: rowUnit?.assetName || rowUnit?.serialNumber || row?.name || "Asset",
      subtitle: `Mark as ${targetStatus === "repair" ? "In Repair" : "Not Working"}`,
    });
    if (remarkResult === null) return;
    const remarkFields = remarkPayload(remarkResult);

    if (canSyncServer) {
      try {
        await setUnitStatusAPI({
          unitId: serverUnitId,
          status: targetStatus,
          ...remarkFields,
        });
        await syncITDataFromAPI();
      } catch (err) {
        console.error("[InventoryDashboard] set unit status via API failed:", err);
        toastITApiFailure(err, "Could not update this unit on the server.");
        return;
      }
    } else {
      if (rowUnit) {
        const uid = rowUnit.assetId ?? rowUnit.id;
        const idx = all.findIndex((u) => (u.assetId ?? u.id) === uid);
        if (idx >= 0) {
          all[idx] = {
            ...all[idx],
            status:     targetStatus,
            repairDate: targetStatus === "repair"
              ? all[idx].repairDate ?? new Date().toISOString()
              : all[idx].repairDate,
            lastRemark: remarkFields.remark || all[idx].lastRemark,
          };
          writeUnits(all);
        }
      } else {
        writeUnits([...all, buildSyntheticUnit(row, targetStatus)]);
      }
      updateInventoryCounts(row, actionKey);
    }

    showToast(
      actionKey === "repair"
        ? `✅ "${row.name}" sent to Repair`
        : `⚠️ "${row.name}" marked as Not Working`,
    );
    dispatchInventoryUpdate();
    onRefresh();
  }, [onRefresh, showToast, requestRemark]);

  const handleQuantityConfirm = useCallback(async (qty, actionMeta = null) => {
    if (!quantityTarget) return;
    const { row, actionKey } = quantityTarget;
    const remarkText = String(actionMeta?.remark || actionMeta?.reason || "").trim();

    const inventory = readInventory();
    const index = inventory.findIndex((i) => String(i.id) === String(row.id));
    if (index < 0) {
      setQuantityTarget(null);
      return;
    }
    const item = { ...inventory[index] };

    const available = Number(item.availableQuantity || 0);
    const total = Number(item.totalQuantity || 0);
    const safeQty = Math.max(1, Math.min(Number(qty || 0), available));
    if (safeQty < 1) {
      toast.error("No available quantity left for this action.");
      return;
    }

    if (actionKey === "repair") {
      item.repairQuantity = Number(item.repairQuantity || 0) + safeQty;
      item.availableQuantity = Math.max(0, available - safeQty);
    } else if (actionKey === "notWorking") {
      item.notWorkingQuantity = Number(item.notWorkingQuantity || 0) + safeQty;
      item.availableQuantity = Math.max(0, available - safeQty);
    } else if (actionKey === "removed") {
      item.totalQuantity = Math.max(0, total - safeQty);
      item.availableQuantity = Math.max(0, available - safeQty);
    }

    const actionLabel =
      actionKey === "repair"
        ? "Repair"
        : actionKey === "notWorking"
          ? "Not Working"
          : "Removed";
    const notesPayload = remarkText
      ? {
          notes: [
            String(item.notes || "").trim(),
            `[${actionLabel} x${safeQty}] ${remarkText}`,
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 500),
        }
      : {};

    try {
      await updateInventoryItemAPI(row.id, {
        total_quantity: item.totalQuantity,
        available_quantity: item.availableQuantity,
        assigned_quantity: item.assignedQuantity,
        not_working_quantity: item.notWorkingQuantity,
        repair_quantity: item.repairQuantity,
        ...notesPayload,
      });
      if (actionKey === "removed") {
        await createDeletedLogAPI({
          delete_code: `del-qty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          inventory_item_id: Number(row.id) || null,
          deleted_by_name: actionMeta?.removedBy || "Inventory",
          asset_name: row.name,
          category: row.category || "Accessories",
          serial_number: "",
          reason: remarkText || `Dead quantity marked: ${safeQty}`,
        });
        await syncDeletedLogsFromAPI();
      }
      await syncITDataFromAPI();
    } catch (err) {
      console.error("[InventoryDashboard] quantity action via API failed:", err);
      toastITApiFailure(err, "Could not update quantity status on the server.");
      return;
    }

    setQuantityTarget(null);
    showToast(
      actionKey === "repair"
        ? `✅ ${safeQty} item(s) moved to Repair`
        : actionKey === "notWorking"
          ? `⚠️ ${safeQty} item(s) marked Not Working`
          : `🗑️ ${safeQty} item(s) moved to Dead Assets`,
    );
    dispatchInventoryUpdate();
    onRefresh();
  }, [quantityTarget, onRefresh, showToast]);

  const handleRemoveConfirm = useCallback(async (removedBy, reason, remarkFields = {}) => {
    if (!removeTarget) return;

    const all          = readUnits();
    const selectedUnit = removeTarget._selectedUnit ?? null;
    const retireFields = {
      ...(removeTarget._remarkFields || {}),
      ...(remarkFields || {}),
      remark: reason || remarkFields?.remark || removeTarget._remarkText || "",
      notes: reason || remarkFields?.notes || removeTarget._remarkText || "",
    };

    let unit = null;
    if (selectedUnit) {
      const uid = selectedUnit.assetId ?? selectedUnit.id;
      const idx = all.findIndex((u) => (u.assetId ?? u.id) === uid);
      unit = idx >= 0 ? all[idx] : selectedUnit;
    } else {
      const matchIdx = findUnitIndex(all, removeTarget);
      unit = matchIdx >= 0 ? all[matchIdx] : null;
    }

    const unitIdNum = unit != null ? Number(unit.id) : NaN;
    const canUseApi = Number.isFinite(unitIdNum) && unitIdNum > 0;

    const entry = {
      deletedId:    `del-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      assetName:    unit?.assetName || removeTarget.name,
      brand:        unit?.brand     || removeTarget.name,
      model:        unit?.model     || "",
      category:     unit?.category  || removeTarget.inventoryCategory || "Hardware",
      serialNumber: unit?.serialNumber || "",
    };

    if (canUseApi) {
      try {
        // Soft-delete unit first (404 = already gone). Then log history without requiring FK.
        try {
          await deleteAssetUnitAPI(unitIdNum, retireFields);
        } catch (delErr) {
          const status = delErr?.status || delErr?.response?.status;
          if (status !== 404) throw delErr;
        }
        await createDeletedLogAPI({
          delete_code: entry.deletedId,
          asset_unit_id: null,
          inventory_item_id: Number(unit.inventoryId) || Number(removeTarget.id) || null,
          deleted_by_name: removedBy,
          asset_name: entry.assetName,
          category: entry.category,
          serial_number: entry.serialNumber,
          reason,
        });
        await syncITDataFromAPI();
        await syncDeletedLogsFromAPI();
      } catch (err) {
        console.error("[InventoryDashboard] remove via API failed:", err);
        toastITApiFailure(err, "Could not remove this asset on the server.");
        return;
      }
    } else if (unit) {
      const uid = unit.assetId ?? unit.id;
      const idx = all.findIndex((u) => (u.assetId ?? u.id) === uid);
      if (idx >= 0) {
        safeLogDeletedAsset(
          {
            ...unit,
            assetName: unit.assetName || removeTarget.name,
            brand:     unit.brand     || removeTarget.name,
            category:  unit.category  || removeTarget.inventoryCategory || "Hardware",
          },
          removedBy,
          reason,
        );
        writeUnits(all.filter((_, i) => i !== idx));
      }
      updateInventoryCounts(removeTarget, "removed");
    } else {
      safeLogDeletedAsset(
        {
          assetName: removeTarget.name,
          brand: removeTarget.name,
          model: "",
          category: removeTarget.inventoryCategory || "Hardware",
          serialNumber: "",
          id: removeTarget.id,
        },
        removedBy,
        reason,
      );
      updateInventoryCounts(removeTarget, "removed");
    }

    showToast(`🗑️ "${removeTarget.name}" moved to Dead Assets`);
    setRemoveTarget(null);
    dispatchInventoryUpdate();
    onRefresh();
  }, [removeTarget, onRefresh, showToast]);

  return {
    removeTarget,
    setRemoveTarget,
    quantityTarget,
    setQuantityTarget,
    toast,
    handleStatusChange,
    handleRemoveConfirm,
    handleQuantityConfirm,
  };
}

// ─── InventoryShell ───────────────────────────────────────────────────────────

export function InventoryShell({ children, category, setCategory, activeSegment }) {
  const navigate  = useNavigate();
  const headerRef = useRef(null);
  const navRef    = useRef(null);
  const fromAdmin = isAdminVisitActive();

  const [stickyTop, setStickyTop] = useState(0);
  const [counts,    setCounts]    = useState(() => readLiveCounts(category));

  useEffect(() => {
    const measure = () => {
      const headerH = headerRef.current?.offsetHeight ?? 0;
      const navH    = navRef.current?.offsetHeight    ?? 0;
      setStickyTop(headerH + navH);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const syncInventoryCounts = useCallback(() => {
    const update = () => setCounts(readLiveCounts(category));
    syncITDataFromAPI({ maxAgeMs: IT_NAV_SYNC_MAX_AGE_MS }).then(update).catch((err) => {
      console.error("[InventoryDashboard] API sync failed, using cached data:", err);
      toastITApiFailure(
          err,
          "Could not sync IT data from the server. Showing cached inventory.",
          { toastId: "it-sync-fail" },
        );
      update();
    });
  }, [category]);

  useRefreshOnNavigate(syncInventoryCounts, [category]);

  useEffect(() => {
    const update = () => setCounts(readLiveCounts(category));
    window.addEventListener("inventory-updated", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("inventory-updated", update);
      window.removeEventListener("storage", update);
    };
  }, [category]);

  const visibleCards = useMemo(
    () => SUMMARY_CARDS.filter(
      (c) => !(c.segment === "removed-it" && category !== "IT Assets"),
    ),
    [category],
  );

  return (
    <div className={`inv-root${fromAdmin ? ' inv-root--admin-visit' : ''}`}>
      {!fromAdmin ? (
        <nav className="inv-tab-bar" ref={navRef}>
          {INV_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              className={category === cat ? 'inv-tab--active' : 'inv-tab'}
              onClick={() => {
                setCategory(cat);
                navigate(`${BASE}?cat=${encodeURIComponent(cat)}`);
              }}
            >
              {cat}
            </button>
          ))}
        </nav>
      ) : null}

      <header className={`inv-header${fromAdmin ? ' inv-header--admin-visit' : ''}`} ref={headerRef}>
        {!fromAdmin ? (
          <div className="inv-header-left">
            <button type="button" className="inv-back-btn" onClick={() => navigate('/dashboard')}>← Back</button>
            <div className="inv-logo-group">
              <div className="inv-logo">
                <span className="inv-logo-dot" />
                <span className="inv-logo-text">INVENTORY</span>
              </div>
              <span className="inv-header-sub">Asset Management System</span>
            </div>
          </div>
        ) : null}
        <div className="inv-header-right">
          <button type="button" className="inv-btn-outline" onClick={() => navigate(`${BASE}/activity-log`)}>
            Log
          </button>
          <button type="button" className="inv-btn-outline" onClick={() => navigate(`${BASE}/parcels`)}>
            📦 Parcels
          </button>
          <button
            type="button"
            className="inv-btn-primary"
            onClick={() => navigate(`${BASE}/add-assets?inv=${encodeURIComponent(category)}`)}
          >
            + Add Assets
          </button>
        </div>
      </header>

      {fromAdmin ? (
        <nav className="inv-tab-bar inv-tab-bar--page" ref={navRef}>
          {INV_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              className={category === cat ? 'inv-tab--active' : 'inv-tab'}
              onClick={() => {
                setCategory(cat);
                navigate(`${BASE}?cat=${encodeURIComponent(cat)}`);
              }}
            >
              {cat}
            </button>
          ))}
        </nav>
      ) : null}

      <section className="inv-cards-grid inv-cards-grid--sticky" style={{ top: stickyTop }}>
        {visibleCards.map((card) => {
          const isActive = activeSegment === card.segment;
          const count    = counts[card.segment] ?? 0;
          return (
            <button
              key={card.segment}
              className="inv-card"
              style={{
                borderColor: isActive ? card.color : "#e2e8f0",
                boxShadow:   isActive ? `0 4px 14px ${card.color}33` : "none",
              }}
              onClick={() =>
                navigate(
                  `${BASE}/${card.segment}?cat=${encodeURIComponent(category)}`,
                )
              }
            >
              <span className="inv-card-label">{card.label}</span>
              <span
                className="inv-card-count"
                style={{ color: count === 0 ? "#94a3b8" : isActive ? card.color : "#0f172a" }}
              >
                {count}
              </span>
              <div className="inv-card-bar" style={{ background: card.color }} />
            </button>
          );
        })}
      </section>

      {children}
    </div>
  );
}

// ─── Shared AssetTable ────────────────────────────────────────────────────────

function formatCategoryLabel(category) {
  const c = String(category || "").trim();
  if (!c || c === "—") return "—";
  const lower = c.toLowerCase();
  if (lower === "consumables") return "Consumable";
  if (lower === "accessories") return "Accessories";
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function categoryPillVariant(category) {
  const key = String(category || "").trim().toLowerCase();
  const map = {
    hardware: "hardware",
    accessories: "accessories",
    accessory: "accessories",
    consumables: "consumables",
    consumable: "consumables",
    software: "software",
    stock: "stock",
    vehicle: "vehicle",
    equipment: "equipment",
  };
  return map[key] || "default";
}

function CategoryPill({ category }) {
  const label = formatCategoryLabel(category);
  if (label === "—") return <span className="inv-cat-pill inv-cat-pill--muted">—</span>;
  const variant = categoryPillVariant(category);
  return <span className={`inv-cat-pill inv-cat-pill--${variant}`}>{label}</span>;
}

function ITOverviewFilterBar({
  categoryFilter,
  onCategoryFilterChange,
  hwSubFilter,
  onHwSubFilterChange,
  projectNameFilter,
  onProjectNameFilterChange,
  projectNameOptions,
  searchQuery,
  onSearchQueryChange,
  categoryCounts,
  subTypeCounts,
  statusFilter = "All",
  onStatusFilterChange,
  statusCounts,
}) {
  const showHwSub = categoryFilter === "Hardware";
  const showAccSub = categoryFilter === "Accessories";
  const showConsSub = categoryFilter === "Consumables";
  const showProject = showHwSub && isMobileTabletHwType(hwSubFilter);
  const hwSubFilters = useItHwSubFilters();
  const accSubFilters = useItAccSubFilters();
  const consSubFilters = useItConsSubFilters();

  const renderSubChip = (type) => (
    <button
      key={type}
      type="button"
      className={
        hwSubFilter === type
          ? "inv-hw-subfilter-chip inv-hw-subfilter-chip--active"
          : "inv-hw-subfilter-chip"
      }
      onClick={() => onHwSubFilterChange(type)}
    >
      {type}
      <span className="inv-hw-subfilter-count">{getHwTypeQtyCount(subTypeCounts, type)}</span>
    </button>
  );

  return (
    <div className="inv-overview-filters-inner" aria-label="IT asset filters">
      <div className="inv-overview-toolbar">
        <div className="inv-overview-filter-block inv-overview-filter-block--select">
          <label className="inv-overview-filter-label" htmlFor="inv-overview-category">
            Category
          </label>
          <select
            id="inv-overview-category"
            className="inv-overview-select"
            value={categoryFilter}
            onChange={(e) => onCategoryFilterChange(e.target.value)}
            aria-label="Category"
          >
            {IT_CATEGORY_FILTERS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label} ({categoryCounts?.[opt.id] ?? 0})
              </option>
            ))}
          </select>
        </div>

        <div className="inv-overview-filter-block inv-overview-filter-block--select">
          <label className="inv-overview-filter-label" htmlFor="inv-overview-status">
            Status
          </label>
          <select
            id="inv-overview-status"
            className="inv-overview-select"
            value={statusFilter}
            onChange={(e) => onStatusFilterChange?.(e.target.value)}
            aria-label="Status"
          >
            {STATUS_FILTERS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label} ({statusCounts?.[opt.id] ?? 0})
              </option>
            ))}
          </select>
        </div>

        <div className="inv-overview-filter-block inv-overview-filter-block--search">
          <label className="inv-overview-filter-label" htmlFor="inv-overview-search">
            Search
          </label>
          <div className="inv-search-wrap inv-search-wrap--overview">
            <span className="inv-search-icon" aria-hidden>🔍</span>
            <input
              id="inv-overview-search"
              className="inv-search-input"
              type="search"
              placeholder="Search brand, type…"
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="inv-search-clear"
                onClick={() => onSearchQueryChange("")}
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>

      {showHwSub && (
        <div className="inv-overview-filter-block inv-overview-filter-block--sub">
          <span className="inv-overview-filter-label">Hardware type</span>
          <div className="inv-hw-subfilter-row" role="group" aria-label="Hardware type">
            {hwSubFilters.map(renderSubChip)}
          </div>
        </div>
      )}

      {showAccSub && (
        <div className="inv-overview-filter-block inv-overview-filter-block--sub">
          <span className="inv-overview-filter-label">Accessory type</span>
          <div className="inv-hw-subfilter-row" role="group" aria-label="Accessory type">
            {accSubFilters.map(renderSubChip)}
          </div>
        </div>
      )}

      {showConsSub && (
        <div className="inv-overview-filter-block inv-overview-filter-block--sub">
          <span className="inv-overview-filter-label">Consumable type</span>
          <div className="inv-hw-subfilter-row" role="group" aria-label="Consumable type">
            {consSubFilters.map(renderSubChip)}
          </div>
        </div>
      )}

      {showProject && (
        <div className="inv-overview-filter-block inv-overview-filter-block--project">
          <span className="inv-overview-filter-label">Project code</span>
          {projectNameOptions.length > 1 ? (
            <div className="inv-project-filter-row">
              {projectNameOptions.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={
                    projectNameFilter === name
                      ? "inv-project-chip inv-project-chip--active"
                      : "inv-project-chip"
                  }
                  onClick={() => onProjectNameFilterChange(name)}
                >
                  {name === "All" ? "All projects" : name}
                </button>
              ))}
            </div>
          ) : (
            <p className="inv-project-empty-hint">No project codes on mobile/tablet units yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function AssetTable({
  assets,
  filter,
  onViewAsset,
  onReviews,
  hideAssigned = false,
  assignedColumnLabel = "Assigned",
  inventoryCategory,
  inventoryDeploy = false,
  onOfficeIssue,
  onOfficeReturn,
  responsive = false,
  resetKey = "",
  serverList = null,
}) {
  const showAvailable = filter !== "Assigned" && filter !== "In use";
  const showAssigned  = !hideAssigned && filter !== "Available";
  const showLaptopCode = serverList
    ? Boolean(serverList.meta?.show_laptop_code)
    : shouldShowLaptopCodeColumn(assets, inventoryCategory);
  const emptyColSpan  =
    5 +
    (showLaptopCode ? 1 : 0) +
    (showAvailable ? 1 : 0) +
    (showAssigned ? 1 : 0);
  const localRows = useIncrementalList(assets, `${filter}|${resetKey}`);
  const rows = serverList
    ? {
        visible: assets,
        shown: assets.length,
        total: serverList.total,
        hasMore: serverList.hasMore,
        showMore: serverList.loadMore,
        loading: serverList.loadingMore,
      }
    : localRows;
  const firstLoad = Boolean(serverList && !serverList.loaded && serverList.loading);

  return (
    <div className={`inv-table-scroll${responsive ? " inv-table-scroll--responsive" : ""}`}>
      <table className="inv-table">
        <thead>
          <tr>
            {showLaptopCode && <th>Laptop Code</th>}
            <th>Assets Name</th>
            <th>Category</th>
            <th>Total Qty</th>
            {showAvailable && <th>Available</th>}
            {showAssigned  && <th>{assignedColumnLabel}</th>}
            <th>Action</th>
            <th>Reviews</th>
          </tr>
        </thead>
        <tbody>
          {assets.length === 0 ? (
            <tr>
              <td colSpan={emptyColSpan} className="inv-empty-row">
                {firstLoad ? "Loading assets…" : "No assets found."}
              </td>
            </tr>
          ) : (
            rows.visible.map((row, i) => (
              <tr key={row.id} className={i % 2 === 0 ? "tr-even" : "tr-odd"}>
                {showLaptopCode && (
                  <td
                    data-label="Laptop Code"
                    style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
                  >
                    {isLaptopHardwareRow(row) && row.model && row.model !== "—"
                      ? row.model
                      : "—"}
                  </td>
                )}
                <td className="td-name" data-label="Asset name">
                  {row.hwType && !row.isStock && !row.isSoftware ? (
                    <div className="td-name-wrap">
                      <span className="td-name-brand">{row.name}</span>
                      <span className="td-name-sub">{row.hwType}</span>
                    </div>
                  ) : (
                    <div className="td-name-wrap">
                      <span className="td-name-brand">{row.name}</span>
                      {row.isStock && row.vendor && row.vendor !== "—" && (
                        <span className="td-name-sub">{row.vendor}</span>
                      )}
                    </div>
                  )}
                </td>
                <td className="td-category" data-label="Category">
                  <CategoryPill category={row.category} />
                </td>
                <td data-label="Total qty">{row.total}</td>
                {showAvailable && <td className="td-available" data-label="Available">{row.available}</td>}
                {showAssigned  && <td className="td-assigned" data-label={assignedColumnLabel}>{row.assigned}</td>}
                <td data-label="Action">
                  <ViewActionGroup
                    row={row}
                    onViewAsset={onViewAsset}
                    inventoryCategory={inventoryCategory}
                    inventoryDeploy={inventoryDeploy}
                    onOfficeIssue={onOfficeIssue}
                    onOfficeReturn={onOfficeReturn}
                  />
                </td>
                <td data-label="Reviews">
                  <button
                    type="button"
                    className="inv-action-btn inv-action-btn--reviews"
                    onClick={() => onReviews?.(row)}
                  >
                    Reviews
                  </button>
                </td>
              </tr>
            ))
          )}
          <ShowMoreRows
            list={rows}
            colSpan={emptyColSpan}
            pageSize={serverList ? SERVER_PAGE_SIZE : undefined}
          />
        </tbody>
      </table>
    </div>
  );
}

function TotalAssetsFilterBar({
  showTypeFilter,
  categoryTypeFilter,
  onCategoryTypeFilterChange,
  subTypeFilter,
  onSubTypeFilterChange,
  subTypeCounts,
  categoryCounts,
}) {
  const showHwSub = categoryTypeFilter === "Hardware";
  const showAccSub = categoryTypeFilter === "Accessories";
  const showConsSub = categoryTypeFilter === "Consumables";
  const hwSubFilters = useItHwSubFilters();
  const accSubFilters = useItAccSubFilters();
  const consSubFilters = useItConsSubFilters();

  if (!showTypeFilter) return null;

  const renderSubChip = (type) => {
    const count = getHwTypeQtyCount(subTypeCounts, type);
    return (
      <button
        key={type}
        type="button"
        className={
          subTypeFilter === type
            ? "inv-hw-subfilter-chip inv-hw-subfilter-chip--active"
            : "inv-hw-subfilter-chip"
        }
        onClick={() => onSubTypeFilterChange(type)}
      >
        {type}
        <span className="inv-hw-subfilter-count">{count}</span>
      </button>
    );
  };

  return (
    <InventoryFiltersInner>
      <div className="inv-overview-filter-block">
        <span className="inv-overview-filter-label">Type</span>
        <div className="inv-category-filter-row" role="group" aria-label="Type">
          {[
            { id: "All", label: "All", chip: "all" },
            { id: "Hardware", label: "Hardware", chip: "hardware" },
            { id: "Accessories", label: "Accessories", chip: "accessories" },
            { id: "Consumables", label: "Consumables", chip: "consumables" },
          ].map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={
                categoryTypeFilter === opt.id
                  ? `inv-cat-filter-chip inv-cat-filter-chip--active inv-cat-filter-chip--${opt.chip}`
                  : `inv-cat-filter-chip inv-cat-filter-chip--${opt.chip}`
              }
              onClick={() => onCategoryTypeFilterChange(opt.id)}
            >
              {opt.label}
              <span className="inv-hw-subfilter-count">
                {categoryCounts?.[opt.id] ?? 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {showHwSub && (
        <div className="inv-overview-filter-block inv-overview-filter-block--sub">
          <span className="inv-overview-filter-label">Hardware type</span>
          <div className="inv-hw-subfilter-row" role="group" aria-label="Hardware type">
            {hwSubFilters.map(renderSubChip)}
          </div>
        </div>
      )}

      {showAccSub && (
        <div className="inv-overview-filter-block inv-overview-filter-block--sub">
          <span className="inv-overview-filter-label">Accessory type</span>
          <div className="inv-hw-subfilter-row" role="group" aria-label="Accessory type">
            {accSubFilters.map(renderSubChip)}
          </div>
        </div>
      )}

      {showConsSub && (
        <div className="inv-overview-filter-block inv-overview-filter-block--sub">
          <span className="inv-overview-filter-label">Consumable type</span>
          <div className="inv-hw-subfilter-row" role="group" aria-label="Consumable type">
            {consSubFilters.map(renderSubChip)}
          </div>
        </div>
      )}
    </InventoryFiltersInner>
  );
}

// ─── TotalAssetsPage ──────────────────────────────────────────────────────────

function TotalAssetsPage({ category }) {
  const showTypeFilter = category === "IT Assets";
  const [categoryTypeFilter, setCategoryTypeFilter] = useState("All");
  const [subTypeFilter, setSubTypeFilter] = useState("All");
  const [detailAsset,   setDetailAsset]   = useState(null);
  const [reviewTarget, setReviewTarget] = useState(null);
  const [officeIssueTarget, setOfficeIssueTarget] = useState(null);
  const [officeReturnTarget, setOfficeReturnTarget] = useState(null);
  const [refreshKey,    setRefreshKey]    = useState(0);

  const inventoryDeploy = showInventoryDeploy(category);
  const assignedLabel = getAssignedColumnLabel(category);

  const server = useInventoryOverviewList({
    inventory_category: category,
    category: categoryTypeFilter,
    hw_type: subTypeFilter,
    counts: 1,
  });
  const serverActive = server.active;
  const reloadServer = server.reload;
  const serverFailed = Boolean(server.error);

  // Local cache refresh (modals/actions read it); the server list reloads only after saves.
  const refreshLocal = useCallback(() => setRefreshKey((k) => k + 1), []);
  const refresh = useCallback(() => {
    refreshLocal();
    if (IT_SERVER_LISTS_ENABLED) reloadServer();
  }, [refreshLocal, reloadServer]);
  const {
    removeTarget,
    setRemoveTarget,
    quantityTarget,
    setQuantityTarget,
    toast,
    handleStatusChange,
    handleRemoveConfirm,
    handleQuantityConfirm,
  } = useAssetActions(refresh);

  useRefreshOnNavigate(() => {
    if (serverFailed) reloadServer();
    syncITDataFromAPI({ maxAgeMs: IT_NAV_SYNC_MAX_AGE_MS })
      .then(() => refreshLocal())
      .catch((err) => {
        console.error("[TotalAssetsPage] API sync failed, using cached data:", err);
        toastITApiFailure(
            err,
            "Could not sync inventory from the server. Showing cached assets.",
            { toastId: "it-sync-fail" },
          );
        refreshLocal();
      });
  }, [category]);

  const handleCategoryTypeFilterChange = useCallback((next) => {
    setCategoryTypeFilter(next);
    setSubTypeFilter("All");
  }, []);

  const inventoryForCounts = useMemo(() => {
    void refreshKey;
    if (serverActive) return NO_ROWS;
    return getMappedInventory(category).filter((a) => Number(a.total) > 0);
  }, [category, refreshKey, serverActive]);

  const serverCounts = server.meta?.counts;
  const categoryCounts = useMemo(
    () => (serverActive ? serverCounts?.category || {} : buildCategoryQtyCounts(inventoryForCounts)),
    [serverActive, serverCounts, inventoryForCounts],
  );

  const subTypeCounts = useMemo(
    () =>
      serverActive
        ? serverCounts?.sub_type || {}
        : buildHwTypeQtyCounts(inventoryForCounts, categoryTypeFilter),
    [serverActive, serverCounts, inventoryForCounts, categoryTypeFilter],
  );

  const filteredAssets = useMemo(() => {
    if (serverActive) return server.items;
    return inventoryForCounts
      .filter((a) => inventoryCategoryMatches(a.category, categoryTypeFilter))
      .filter((a) => {
        if (
          categoryTypeFilter === "Hardware" ||
          categoryTypeFilter === "Accessories" ||
          categoryTypeFilter === "Consumables"
        ) {
          return assetMatchesHwSubFilter(a, subTypeFilter);
        }
        return true;
      });
  }, [serverActive, server.items, inventoryForCounts, categoryTypeFilter, subTypeFilter]);

  const filterBadgeParts = [
    categoryTypeFilter !== "All" ? categoryTypeFilter : null,
    subTypeFilter !== "All" ? subTypeFilter : null,
  ].filter(Boolean);

  return (
    <>
      {toast && <div className="inv-toast">{toast}</div>}

      <InventoryPanel
        eyebrow={category}
        title="Total Assets"
        recordCount={serverActive ? server.total : filteredAssets.length}
        filterBadge={
          filterBadgeParts.length > 0 ? (
            <span className="inv-table-filter-badge">{filterBadgeParts.join(" · ")}</span>
          ) : null
        }
        filters={
          <TotalAssetsFilterBar
            showTypeFilter={showTypeFilter}
            categoryTypeFilter={categoryTypeFilter}
            onCategoryTypeFilterChange={handleCategoryTypeFilterChange}
            subTypeFilter={subTypeFilter}
            onSubTypeFilterChange={setSubTypeFilter}
            subTypeCounts={subTypeCounts}
            categoryCounts={categoryCounts}
          />
        }
      >
        <AssetTable
          assets={filteredAssets}
          filter="All"
          onViewAsset={setDetailAsset}
          onReviews={(row) => setReviewTarget(buildReviewTarget(row))}
          hideAssigned={hideAssignedColumnForCategory(category)}
          assignedColumnLabel={assignedLabel}
          inventoryCategory={category}
          inventoryDeploy={inventoryDeploy}
          onOfficeIssue={setOfficeIssueTarget}
          onOfficeReturn={setOfficeReturnTarget}
          responsive
          resetKey={`${category}|${categoryTypeFilter}|${subTypeFilter}`}
          serverList={serverActive ? server : null}
        />
      </InventoryPanel>

      {detailAsset && (
        detailAsset.isSoftware ? (
          <SoftwareAssetDetailModal
            asset={detailAsset}
            onClose={() => setDetailAsset(null)}
          />
        ) : (
          <AssetDetailModal
            asset={detailAsset}
            onClose={() => setDetailAsset(null)}
            onStatusChange={handleStatusChange}
            inventoryCategory={category}
          />
        )
      )}
      {reviewTarget && (
        <AssetReviewsModal
          target={reviewTarget}
          onClose={() => setReviewTarget(null)}
        />
      )}
      {officeIssueTarget && (
        <OfficeIssueModal
          asset={officeIssueTarget}
          inventoryCategory={category}
          onClose={() => setOfficeIssueTarget(null)}
          onSuccess={refresh}
        />
      )}
      {officeReturnTarget && (
        <OfficeReturnModal
          asset={officeReturnTarget}
          inventoryCategory={category}
          onClose={() => setOfficeReturnTarget(null)}
          onSuccess={refresh}
        />
      )}
      {removeTarget && <RemoveAssetModal asset={removeTarget} onConfirm={handleRemoveConfirm} onCancel={() => setRemoveTarget(null)} />}
      {quantityTarget && (
        <QuantityActionModal
          actionTarget={quantityTarget}
          onConfirm={handleQuantityConfirm}
          onCancel={() => setQuantityTarget(null)}
        />
      )}
    </>
  );
}

// ─── OverviewPage ─────────────────────────────────────────────────────────────

function OverviewPage({ category }) {
  const showItFilters = category === "IT Assets";
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [hwSubFilter, setHwSubFilter] = useState("All");
  const [projectNameFilter, setProjectNameFilter] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [detailAsset, setDetailAsset] = useState(null);
  const [reviewTarget, setReviewTarget] = useState(null);
  const [officeIssueTarget, setOfficeIssueTarget] = useState(null);
  const [officeReturnTarget, setOfficeReturnTarget] = useState(null);
  const [refreshKey,  setRefreshKey]  = useState(0);

  const inventoryDeploy = showInventoryDeploy(category);
  const assignedLabel = getAssignedColumnLabel(category);

  const debouncedSearchQuery = useDebouncedValue(searchQuery, 300);
  const server = useInventoryOverviewList({
    inventory_category: category,
    category: showItFilters ? categoryFilter : "All",
    hw_type: showItFilters ? hwSubFilter : "All",
    project: showItFilters ? projectNameFilter : "All",
    q: showItFilters ? debouncedSearchQuery.trim() : "",
    status: statusFilter,
    counts: 1,
  });
  const serverActive = server.active;
  const reloadServer = server.reload;
  const serverFailed = Boolean(server.error);
  const serverCounts = server.meta?.counts;

  // Local cache refresh (modals/actions read it); the server list reloads only after saves.
  const refreshLocal = useCallback(() => setRefreshKey((k) => k + 1), []);
  const refresh = useCallback(() => {
    refreshLocal();
    if (IT_SERVER_LISTS_ENABLED) reloadServer();
  }, [refreshLocal, reloadServer]);
  const {
    removeTarget,
    setRemoveTarget,
    quantityTarget,
    setQuantityTarget,
    toast,
    handleStatusChange,
    handleRemoveConfirm,
    handleQuantityConfirm,
  } = useAssetActions(refresh);

  useRefreshOnNavigate(() => {
    if (serverFailed) reloadServer();
    syncITDataFromAPI({ maxAgeMs: IT_NAV_SYNC_MAX_AGE_MS })
      .then(() => refreshLocal())
      .catch((err) => {
        console.error("[OverviewPage] API sync failed, using cached data:", err);
        toastITApiFailure(
            err,
            "Could not sync inventory from the server. Showing cached overview.",
            { toastId: "it-sync-fail" },
          );
        refreshLocal();
      });
  }, [category]);

  const baseAssets = useMemo(() => {
    void refreshKey;
    if (serverActive) return NO_ROWS;
    return getMappedInventory(category).filter((a) => Number(a.total) > 0);
  }, [category, refreshKey, serverActive]);

  const categoryCounts = useMemo(
    () => (serverActive ? serverCounts?.category || {} : buildCategoryQtyCounts(baseAssets)),
    [serverActive, serverCounts, baseAssets],
  );

  const subTypeCounts = useMemo(
    () =>
      serverActive
        ? serverCounts?.sub_type || {}
        : buildHwTypeQtyCounts(baseAssets, categoryFilter),
    [serverActive, serverCounts, baseAssets, categoryFilter],
  );

  const projectNameOptions = useMemo(() => {
    if (!showItFilters || categoryFilter !== "Hardware" || !isMobileTabletHwType(hwSubFilter)) {
      return ["All"];
    }
    if (serverActive) {
      const names = [...(serverCounts?.project_options || [])];
      return ["All", ...names.sort((a, b) => a.localeCompare(b))];
    }
    const hardwareMobile = baseAssets.filter(
      (a) =>
        inventoryCategoryMatches(a.category, "Hardware") &&
        assetMatchesHwSubFilter(a, hwSubFilter),
    );
    return collectProjectNamesFromAssets(hardwareMobile);
  }, [baseAssets, showItFilters, categoryFilter, hwSubFilter, serverActive, serverCounts]);

  // Server options only describe the current Hardware type once its first page has loaded.
  const projectOptionsSettled = !serverActive || !server.loading;
  useEffect(() => {
    if (projectOptionsSettled && !projectNameOptions.includes(projectNameFilter)) {
      setProjectNameFilter("All");
    }
  }, [projectOptionsSettled, projectNameOptions, projectNameFilter]);

  const preStatusAssets = useMemo(() => {
    if (serverActive) return NO_ROWS;
    if (!showItFilters) return baseAssets;
    return filterITOverviewAssets(baseAssets, {
      categoryFilter,
      hwSubFilter,
      projectNameFilter,
      searchQuery: deferredSearchQuery,
      statusFilter: "All",
    });
  }, [serverActive, baseAssets, showItFilters, categoryFilter, hwSubFilter, projectNameFilter, deferredSearchQuery]);

  const statusCounts = useMemo(
    () => (serverActive ? serverCounts?.status || {} : buildStatusQtyCounts(preStatusAssets)),
    [serverActive, serverCounts, preStatusAssets],
  );

  const assets = useMemo(() => {
    if (serverActive) return server.items;
    if (!showItFilters) {
      if (statusFilter === "Available") {
        return baseAssets.filter((a) => Number(a.available) > 0);
      }
      if (statusFilter === "Assigned") {
        return baseAssets.filter((a) => Number(a.assigned) > 0);
      }
      return baseAssets;
    }
    return filterITOverviewAssets(baseAssets, {
      categoryFilter,
      hwSubFilter,
      projectNameFilter,
      searchQuery: deferredSearchQuery,
      statusFilter,
    });
  }, [serverActive, server.items, baseAssets, showItFilters, categoryFilter, hwSubFilter, projectNameFilter, deferredSearchQuery, statusFilter]);

  const handleCategoryFilterChange = useCallback((next) => {
    setCategoryFilter(next);
    setHwSubFilter("All");
    if (next !== "Hardware") {
      setProjectNameFilter("All");
    }
  }, []);

  const handleHwSubFilterChange = useCallback((next) => {
    setHwSubFilter(next);
    setProjectNameFilter("All");
  }, []);

  return (
    <>
      {toast && <div className="inv-toast">{toast}</div>}

      <InventoryPanel
        eyebrow={category}
        title="Asset Overview"
        recordCount={serverActive ? server.total : assets.length}
        filterBadge={
          showItFilters &&
          (categoryFilter !== "All" ||
            statusFilter !== "All" ||
            hwSubFilter !== "All" ||
            projectNameFilter !== "All") ? (
            <span className="inv-table-filter-badge">
              {[
                categoryFilter !== "All" ? categoryFilter : null,
                statusFilter !== "All" ? statusFilter : null,
                hwSubFilter !== "All" ? hwSubFilter : null,
                projectNameFilter !== "All" ? projectNameFilter : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : statusFilter !== "All" ? (
            <span className="inv-table-filter-badge">{statusFilter}</span>
          ) : null
        }
        filters={
          showItFilters ? (
            <ITOverviewFilterBar
              categoryFilter={categoryFilter}
              onCategoryFilterChange={handleCategoryFilterChange}
              hwSubFilter={hwSubFilter}
              onHwSubFilterChange={handleHwSubFilterChange}
              projectNameFilter={projectNameFilter}
              onProjectNameFilterChange={setProjectNameFilter}
              projectNameOptions={projectNameOptions}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              categoryCounts={categoryCounts}
              subTypeCounts={subTypeCounts}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              statusCounts={statusCounts}
            />
          ) : (
            <div className="inv-overview-filters-inner" aria-label="Asset status filters">
              <div className="inv-overview-filter-row-dropdowns">
                <div className="inv-overview-filter-block inv-overview-filter-block--select">
                  <label className="inv-overview-filter-label" htmlFor="inv-overview-status-only">
                    Status
                  </label>
                  <select
                    id="inv-overview-status-only"
                    className="inv-overview-select"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    aria-label="Status"
                  >
                    {STATUS_FILTERS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label} ({statusCounts?.[opt.id] ?? 0})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )
        }
      >
        <AssetTable
          assets={assets}
          filter={statusFilter}
          onViewAsset={setDetailAsset}
          onReviews={(row) => setReviewTarget(buildReviewTarget(row))}
          hideAssigned={hideAssignedColumnForCategory(category)}
          assignedColumnLabel={assignedLabel}
          inventoryCategory={category}
          inventoryDeploy={inventoryDeploy}
          onOfficeIssue={setOfficeIssueTarget}
          onOfficeReturn={setOfficeReturnTarget}
          responsive
          resetKey={`${category}|${categoryFilter}|${hwSubFilter}|${projectNameFilter}|${deferredSearchQuery}`}
          serverList={serverActive ? server : null}
        />
      </InventoryPanel>

      {detailAsset && (
        detailAsset.isSoftware ? (
          <SoftwareAssetDetailModal
            asset={detailAsset}
            onClose={() => setDetailAsset(null)}
          />
        ) : (
          <AssetDetailModal
            asset={detailAsset}
            onClose={() => setDetailAsset(null)}
            onStatusChange={handleStatusChange}
            inventoryCategory={category}
          />
        )
      )}
      {reviewTarget && (
        <AssetReviewsModal
          target={reviewTarget}
          onClose={() => setReviewTarget(null)}
        />
      )}
      {officeIssueTarget && (
        <OfficeIssueModal
          asset={officeIssueTarget}
          inventoryCategory={category}
          onClose={() => setOfficeIssueTarget(null)}
          onSuccess={refresh}
        />
      )}
      {officeReturnTarget && (
        <OfficeReturnModal
          asset={officeReturnTarget}
          inventoryCategory={category}
          onClose={() => setOfficeReturnTarget(null)}
          onSuccess={refresh}
        />
      )}
      {removeTarget && <RemoveAssetModal asset={removeTarget} onConfirm={handleRemoveConfirm} onCancel={() => setRemoveTarget(null)} />}
      {quantityTarget && (
        <QuantityActionModal
          actionTarget={quantityTarget}
          onConfirm={handleQuantityConfirm}
          onCancel={() => setQuantityTarget(null)}
        />
      )}
    </>
  );
}

// ─── InventoryRoot + default export ──────────────────────────────────────────

function InventoryRoot() {
  const [searchParams, setSearchParams] = useSearchParams();
  const catParam = searchParams.get("cat");
  const [category, setCategoryState] = useState(
    isValidInventoryCategory(catParam) ? catParam : "IT Assets",
  );
  const location  = useLocation();
  const segment   = location.pathname.replace(BASE, "").replace(/^\//, "");

  useEffect(() => {
    if (isValidInventoryCategory(catParam)) setCategoryState(catParam);
  }, [catParam]);

  const setCategory = useCallback((cat) => {
    setCategoryState(cat);
    setSearchParams({ cat }, { replace: true });
  }, [setSearchParams]);

  return (
    <InventoryShell category={category} setCategory={setCategory} activeSegment={segment}>
      <Routes>
        <Route path="/"              element={<OverviewPage    category={category} />} />
        <Route path="total"          element={<TotalAssetsPage category={category} />} />
        <Route path="not-working"    element={<NotWorking inventoryCategory={category} />} />
        <Route path="in-repair"      element={<InRepair inventoryCategory={category} />} />
        <Route path="removed-it"     element={<RemovedITAssets />} />
        <Route path="removed-assets" element={<RemovedAssets inventoryCategory={category} />} />
      </Routes>
    </InventoryShell>
  );
}

const InventoryDashboard = () => (
  <Routes>
    <Route path="activity-log" element={<ActivityLogPage defaultScope="inventory" />} />
    <Route path="add-assets"   element={<AddNewAssets />} />
    <Route path="parcels"      element={<Parcel />} />
    <Route path="parcel-log"   element={<Navigate to="/it/inventory/parcels?tab=log" replace />} />
    <Route path="add-import"   element={<AddImported />} />
    <Route path="ready-export" element={<ReadyExport />} />
    <Route path="/*"           element={<InventoryRoot />} />
  </Routes>
);

export default InventoryDashboard;
// // InventoryDashboard.jsx
// import { useState, useRef, useEffect, useCallback, useMemo } from "react";
// import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
// import "./InventoryDashboard.css";

// import {
//   getInventoryFromStorage,
//   saveInventoryToStorage,
//   getAssetUnitsFromStorage,
//   saveAssetUnitsToStorage,
//   notifyInventoryChange,
//   logDeletedAsset,
//   getInventoryCounts,
// } from "../Data";

// import AddNewAssets    from "./AddnewAssets";
// import NotWorking      from "./NotWorking";
// import InRepair        from "./InRepair";
// import RemovedAssets   from "./RemovedAssets";
// import RemovedITAssets from "./RemovedITAssets";
// import Parcel          from "./Parcel/ParcelDashboard";
// import AddImported     from "./Parcel/AddImportedAssets";
// import ReadyExport     from "./Parcel/ExportedAssets";

// // ─── Constants ────────────────────────────────────────────────────────────────

// const BASE           = "/it/inventory";
// const REMOVED_IT_KEY = "removedITAssets";

// const INV_CATEGORIES = [
//   "IT Assets",
//   "Office Assets",
//   "Transport Assets",
//   "Infrastructure Assets",
// ];

// const SUMMARY_CARDS = [
//   { label: "Total Assets",    segment: "total",          color: "#3b82f6" },
//   { label: "Not Working",     segment: "not-working",    color: "#ef4444" },
//   { label: "In Repair",       segment: "in-repair",      color: "#f59e0b" },
//   { label: "Removed From IT", segment: "removed-it",     color: "#06b6d4" },
//   { label: "Removed Assets",  segment: "removed-assets", color: "#64748b" },
// ];

// const FILTER_OPTIONS = ["All", "Available", "Assigned"];

// const EDIT_OPTIONS = [
//   { key: "repair",     label: "Repair",     icon: "🔧", color: "#d97706", hoverBg: "#fef3c7", bg: "#fffbeb", borderColor: "#d97706" },
//   { key: "notWorking", label: "Not Working", icon: "⚠️",  color: "#ef4444", hoverBg: "#fee2e2", bg: "#fef2f2", borderColor: "#ef4444" },
//   { key: "removed",   label: "Remove",     icon: "🗑️",  color: "#64748b", hoverBg: "#f1f5f9", bg: "#f8fafc", borderColor: "#94a3b8" },
// ];

// // ─── Pure helpers ─────────────────────────────────────────────────────────────

// const formatDate = (iso) => {
//   if (!iso) return "—";
//   const d = new Date(iso);
//   return isNaN(d) ? iso : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
// };

// const isSoftware = (item) =>
//   (item?.category ?? "").trim().toLowerCase() === "software";

// const readInventory  = () => getInventoryFromStorage() ?? [];
// const writeInventory = (data) => saveInventoryToStorage(data);
// const readUnits      = () => getAssetUnitsFromStorage() ?? [];
// const writeUnits     = (data) => saveAssetUnitsToStorage(data);

// function dispatchInventoryUpdate() {
//   try { window.dispatchEvent(new Event("inventory-updated")); } catch { /* no-op */ }
// }

// function readRemovedITCount() {
//   try { return (JSON.parse(localStorage.getItem(REMOVED_IT_KEY) ?? "[]")).length; }
//   catch { return 0; }
// }

// function readLiveCounts() {
//   const counts = getInventoryCounts();

//   // Total = available + assigned + notWorking + inRepair (excludes removed assets)
//   const hardwareItems = readInventory().filter((i) => !isSoftware(i));
//   const totalActive = hardwareItems.reduce((sum, i) => {
//     return (
//       sum +
//       (Number(i.availableQuantity)  || 0) +
//       (Number(i.assignedQuantity)   || 0) +
//       (Number(i.notWorkingQuantity) || 0) +
//       (Number(i.repairQuantity)     || 0)
//     );
//   }, 0);

//   return {
//     total:            Math.max(0, totalActive),
//     "not-working":    counts.notWorking    || 0,
//     "in-repair":      counts.inRepair      || 0,
//     "removed-assets": counts.removedAssets || 0,
//     "removed-it":     readRemovedITCount(),
//   };
// }

// function mapInventoryItem(item) {
//   return {
//     id:                item.id,
//     name:              item.name,
//     hwType:            item.hwType             ?? null,
//     total:             Number(item.totalQuantity)     || 0,
//     available:         Number(item.availableQuantity) || 0,
//     inventoryCategory: item.inventoryCategory         || "IT Assets",
//     assigned:          Number(item.assignedQuantity)  || 0,
//     notWorking:        Number(item.notWorkingQuantity) || 0,
//     inRepair:          Number(item.repairQuantity)     || 0,
//     brand:             item.brand        || "—",
//     make:              item.make         || "—",
//     model:             item.model        || "—",
//     serialNumber:      item.serialNumber || "—",
//     category:          item.category     || "—",
//     purchaseDate:      item.purchaseDate || null,
//     location:          item.location     || "—",
//   };
// }

// function getMappedInventory() {
//   return readInventory().filter((i) => !isSoftware(i)).map(mapInventoryItem);
// }

// function getUnitsForAsset(inventoryId, assetName, hwType) {
//   const all = readUnits();

//   // 1️⃣ Best match: by inventoryId (unique per brand+hwType combo)
//   const byId = all.filter((u) => String(u.inventoryId) === String(inventoryId));
//   if (byId.length > 0) return byId;

//   // 2️⃣ Fallback for legacy data: match by name AND hwType so Apple Mobile ≠ Apple Laptop
//   if (hwType) {
//     const byNameAndType = all.filter(
//       (u) =>
//         (u.assetName === assetName || u.name === assetName) &&
//         (u.hwType ?? "").toLowerCase() === hwType.toLowerCase(),
//     );
//     if (byNameAndType.length > 0) return byNameAndType;
//   }

//   // 3️⃣ Last resort: name only (old data with no hwType stored on unit)
//   return all.filter((u) => u.assetName === assetName || u.name === assetName);
// }

// function safeLogDeletedAsset(asset, deletedBy, reason) {
//   try { logDeletedAsset(asset, deletedBy, reason); }
//   catch (err) { console.error("[InventoryDashboard] logDeletedAsset failed:", err); }
// }

// function applyInventoryCountMutation(item, actionKey) {
//   if (actionKey === "repair") {
//     item.repairQuantity    = (Number(item.repairQuantity)    || 0) + 1;
//     item.availableQuantity = Math.max(0, (Number(item.availableQuantity) || 0) - 1);
//   } else if (actionKey === "notWorking") {
//     item.notWorkingQuantity = (Number(item.notWorkingQuantity) || 0) + 1;
//     item.availableQuantity  = Math.max(0, (Number(item.availableQuantity) || 0) - 1);
//   } else if (actionKey === "removed") {
//     item.totalQuantity      = Math.max(0, (Number(item.totalQuantity)     || 0) - 1);
//     item.availableQuantity  = Math.max(0, (Number(item.availableQuantity) || 0) - 1);
//   }
// }

// function updateInventoryCounts(row, actionKey) {
//   const inventory = readInventory();
//   const index     = inventory.findIndex((i) => String(i.id) === String(row.id));
//   if (index < 0) { notifyInventoryChange(); return; }

//   const item = { ...inventory[index] };
//   applyInventoryCountMutation(item, actionKey);

//   if (actionKey === "removed" && Number(item.totalQuantity) <= 0) {
//     writeInventory(inventory.filter((_, i) => i !== index));
//   } else {
//     inventory[index] = item;
//     writeInventory(inventory);
//   }
//   notifyInventoryChange();
// }

// function buildSyntheticUnit(row, status) {
//   const clean = (val) => (val && val !== "—" ? val : "");
//   return {
//     id:           `synth-unit-${row.id}`,
//     inventoryId:  String(row.id),
//     assetName:    row.name,
//     brand:        clean(row.brand)        || row.name,
//     model:        clean(row.model),
//     category:     clean(row.category)     || "Hardware",
//     serialNumber: clean(row.serialNumber),
//     location:     clean(row.location),
//     purchaseDate: row.purchaseDate ?? null,
//     status,
//     repairDate:   status === "repair" ? new Date().toISOString() : null,
//   };
// }

// function findUnitIndex(all, row) {
//   const byId = all.findIndex(
//     (u) =>
//       String(u.inventoryId) === String(row.id) ||
//       u.id === `synth-unit-${row.id}`,
//   );
//   if (byId >= 0) return byId;
//   return all.findIndex((u) => u.assetName === row.name || u.name === row.name);
// }

// // ─── RemoveAssetModal ─────────────────────────────────────────────────────────

// function RemoveAssetModal({ asset, onConfirm, onCancel }) {
//   const [removedBy, setRemovedBy] = useState("");
//   const [reason,    setReason]    = useState("");
//   const [errors,    setErrors]    = useState({});

//   const handleSubmit = () => {
//     const nextErrors = {};
//     if (!removedBy.trim()) nextErrors.removedBy = "Required";
//     if (!reason.trim())    nextErrors.reason    = "Required";
//     if (Object.keys(nextErrors).length) { setErrors(nextErrors); return; }
//     onConfirm(removedBy.trim(), reason.trim());
//   };

//   return (
//     <div className="inv-modal-backdrop" onClick={onCancel}>
//       <div className="inv-modal-box" onClick={(e) => e.stopPropagation()}>
//         <div className="inv-modal-hero">
//           <p className="inv-modal-hero-label">Asset Action</p>
//           <h2 className="inv-modal-hero-title">Remove Asset</h2>
//           <p className="inv-modal-hero-sub">{asset?.name}</p>
//         </div>
//         <div className="inv-modal-body">
//           <p className="inv-modal-hint">
//             This asset will be moved to <strong>Removed Assets</strong>. Please fill in the details below.
//           </p>

//           <div className="inv-modal-field">
//             <label className="inv-modal-label">Removed By <span className="req">*</span></label>
//             <input
//               className={`inv-modal-input${errors.removedBy ? " err" : ""}`}
//               value={removedBy}
//               onChange={(e) => setRemovedBy(e.target.value)}
//               placeholder="Enter your name"
//             />
//             {errors.removedBy && <span className="inv-modal-err">{errors.removedBy}</span>}
//           </div>

//           <div className="inv-modal-field">
//             <label className="inv-modal-label">Reason for Removal <span className="req">*</span></label>
//             <textarea
//               className={`inv-modal-textarea${errors.reason ? " err" : ""}`}
//               value={reason}
//               onChange={(e) => setReason(e.target.value)}
//               placeholder="Explain why this asset is being removed..."
//               rows={3}
//             />
//             {errors.reason && <span className="inv-modal-err">{errors.reason}</span>}
//           </div>

//           <div className="inv-modal-actions">
//             <button className="inv-modal-btn-confirm" onClick={handleSubmit}>Confirm Remove</button>
//             <button className="inv-modal-btn-cancel"  onClick={onCancel}>Cancel</button>
//           </div>
//         </div>
//       </div>
//     </div>
//   );
// }

// // ─── EditDropdown ─────────────────────────────────────────────────────────────

// function EditDropdown({ row, onStatusChange }) {
//   const [isOpen, setIsOpen] = useState(false);
//   const wrapRef             = useRef(null);
//   const isDisabled          = (row.available || 0) === 0;

//   useEffect(() => {
//     if (!isOpen) return;
//     const handleOutsideClick = (e) => {
//       if (wrapRef.current && !wrapRef.current.contains(e.target)) setIsOpen(false);
//     };
//     document.addEventListener("mousedown", handleOutsideClick);
//     return () => document.removeEventListener("mousedown", handleOutsideClick);
//   }, [isOpen]);

//   if (isDisabled) {
//     return (
//       <span className="inv-edit-dropdown-wrap">
//         <button
//           className="inv-action-btn-edit"
//           disabled
//           title="All units are assigned — make a unit available before changing status"
//         >
//           Edit ▾
//         </button>
//       </span>
//     );
//   }

//   if (isOpen) {
//     return (
//       <span ref={wrapRef} className="inv-inline-actions">
//         {EDIT_OPTIONS.map((opt, i) => (
//           <button
//             key={opt.key}
//             className="inv-inline-action-btn"
//             style={{
//               color:       opt.color,
//               borderColor: opt.borderColor,
//               background:  opt.bg,
//               borderLeft:  i === 0 ? `1px solid ${opt.borderColor}` : "none",
//               borderRadius:
//                 i === 0 ? "6px 0 0 6px"
//                 : i === EDIT_OPTIONS.length - 1 ? "0 6px 6px 0"
//                 : "0",
//             }}
//             onClick={() => { setIsOpen(false); onStatusChange(row, opt.key); }}
//             onMouseEnter={(e) => (e.currentTarget.style.background = opt.hoverBg)}
//             onMouseLeave={(e) => (e.currentTarget.style.background = opt.bg)}
//           >
//             <span style={{ fontSize: 13 }}>{opt.icon}</span>
//             {opt.label}
//           </button>
//         ))}
//         <button className="inv-inline-cancel-btn" onClick={() => setIsOpen(false)} title="Cancel">
//           ✕
//         </button>
//       </span>
//     );
//   }

//   return (
//     <span ref={wrapRef} className="inv-edit-dropdown-wrap">
//       <button className="inv-action-btn-edit" onClick={() => setIsOpen(true)}>Edit ▾</button>
//     </span>
//   );
// }

// // ─── PhotoLightbox ────────────────────────────────────────────────────────────

// function PhotoLightbox({ photos, startIndex, onClose }) {
//   const [currentIndex, setCurrentIndex] = useState(startIndex);

//   const goToPrev = (e) => {
//     e.stopPropagation();
//     setCurrentIndex((i) => (i - 1 + photos.length) % photos.length);
//   };
//   const goToNext = (e) => {
//     e.stopPropagation();
//     setCurrentIndex((i) => (i + 1) % photos.length);
//   };

//   return (
//     <div className="inv-lightbox" onClick={onClose}>
//       <button className="inv-lightbox-close" onClick={onClose}>×</button>
//       {photos.length > 1 && (
//         <button className="inv-lightbox-prev" onClick={goToPrev}>‹</button>
//       )}
//       <div className="inv-lightbox-img-wrap" onClick={(e) => e.stopPropagation()}>
//         <img src={photos[currentIndex]} alt="" />
//         {photos.length > 1 && (
//           <div className="inv-lightbox-counter">
//             {currentIndex + 1} / {photos.length}
//           </div>
//         )}
//       </div>
//       {photos.length > 1 && (
//         <button className="inv-lightbox-next" onClick={goToNext}>›</button>
//       )}
//     </div>
//   );
// }

// // ─── AssetDetailModal ─────────────────────────────────────────────────────────

// function AssetDetailModal({ asset, onClose }) {
//   const [selectedUnitIndex, setSelectedUnitIndex] = useState(0);
//   const [lightboxStartIdx,  setLightboxStartIdx]  = useState(null);

//   const units  = getUnitsForAsset(asset.id, asset.name, asset.hwType);
//   const unit   = units[selectedUnitIndex] ?? null;
//   const photos = unit?.photos ?? unit?.assignmentPhotos ?? [];

//   const detailFields = [
//     { label: "Asset ID",   value: unit?.assetId ?? unit?.id ?? "—", mono: true,  highlight: true  },
//     { label: "Brand",      value: unit?.brand              ?? "—",  mono: false, highlight: false },
//     { label: "Make",       value: unit?.make               ?? "—",  mono: false, highlight: false },
//     { label: "Serial No.", value: unit?.serialNumber       ?? "—",  mono: true,  highlight: false },
//   ];

//   return (
//     <>
//       <div className="inv-detail-backdrop" onClick={onClose}>
//         <div className="inv-detail-box" onClick={(e) => e.stopPropagation()}>

//           <div className="inv-detail-hero">
//             <div>
//               <p className="inv-detail-hero-label">Asset Details</p>
//               <h2 className="inv-detail-hero-title">{asset.name}</h2>
//               <div className="inv-detail-hero-badges">
//                 <span className="inv-detail-badge inv-detail-badge--cat">{asset.inventoryCategory}</span>
//                 <span className="inv-detail-badge inv-detail-badge--units">
//                   {units.length} unit{units.length !== 1 ? "s" : ""}
//                 </span>
//               </div>
//             </div>
//             <button className="inv-detail-close-btn" onClick={onClose}>×</button>
//           </div>

//           {units.length > 1 && (
//             <div className="inv-unit-tabs">
//               <span className="inv-unit-label">Unit:</span>
//               {units.map((u, i) => (
//                 <button
//                   key={u.assetId ?? i}
//                   className={`inv-unit-tab${selectedUnitIndex === i ? " inv-unit-tab--active" : ""}`}
//                   onClick={() => setSelectedUnitIndex(i)}
//                 >
//                   #{u.assetTag ?? u.assetId ?? i + 1}
//                 </button>
//               ))}
//             </div>
//           )}

//           <div className="inv-detail-body">
//             {units.length === 0 ? (
//               <div className="inv-detail-empty">
//                 <div className="inv-detail-empty-icon">📦</div>
//                 <p className="inv-detail-empty-title">No unit records found</p>
//                 <p className="inv-detail-empty-sub">Individual units added via Add Assets will appear here</p>
//               </div>
//             ) : (
//               <>
//                 <div className="inv-detail-fields">
//                   {detailFields.map(({ label, value, mono, highlight }, idx) => (
//                     <div
//                       key={label}
//                       className={[
//                         "inv-detail-field-row",
//                         highlight ? "inv-detail-field-row--highlight"
//                           : idx % 2 !== 0 ? "inv-detail-field-row--alt"
//                           : "",
//                       ].filter(Boolean).join(" ")}
//                     >
//                       <span className="inv-detail-field-label">{label}</span>
//                       <span
//                         className={[
//                           "inv-detail-field-value",
//                           highlight ? "inv-detail-field-value--highlight" : "",
//                           mono      ? "inv-detail-field-value--mono"      : "",
//                         ].filter(Boolean).join(" ")}
//                       >
//                         {value}
//                       </span>
//                     </div>
//                   ))}
//                 </div>

//                 <div>
//                   <p className="inv-photos-label">
//                     Photos {photos.length > 0 ? `(${photos.length})` : ""}
//                   </p>
//                   {photos.length === 0 ? (
//                     <div className="inv-photos-empty">
//                       <div className="inv-photos-empty-icon">📷</div>
//                       <p className="inv-photos-empty-text">No photos available</p>
//                     </div>
//                   ) : (
//                     <>
//                       <div className="inv-photo-main" onClick={() => setLightboxStartIdx(0)}>
//                         <img src={photos[0]} alt="asset" />
//                         {photos.length > 1 && (
//                           <span className="inv-photo-more-badge">+{photos.length - 1} more</span>
//                         )}
//                       </div>
//                       {photos.length > 1 && (
//                         <div className="inv-photo-strip">
//                           {photos.map((src, i) => (
//                             <img
//                               key={i}
//                               src={src}
//                               alt=""
//                               className="inv-photo-thumb"
//                               onClick={() => setLightboxStartIdx(i)}
//                             />
//                           ))}
//                         </div>
//                       )}
//                     </>
//                   )}
//                 </div>
//               </>
//             )}
//           </div>

//           <div className="inv-detail-footer">
//             <button className="inv-detail-footer-btn" onClick={onClose}>Close</button>
//           </div>
//         </div>
//       </div>

//       {lightboxStartIdx !== null && (
//         <PhotoLightbox
//           photos={photos}
//           startIndex={lightboxStartIdx}
//           onClose={() => setLightboxStartIdx(null)}
//         />
//       )}
//     </>
//   );
// }

// // ─── useAssetActions hook ─────────────────────────────────────────────────────

// function useAssetActions(onRefresh) {
//   const [removeTarget, setRemoveTarget] = useState(null);
//   const [toast,        setToast]        = useState("");

//   const showToast = useCallback((msg) => {
//     setToast(msg);
//     setTimeout(() => setToast(""), 2_800);
//   }, []);

//   const handleStatusChange = useCallback((row, actionKey) => {
//     if (actionKey === "removed") { setRemoveTarget(row); return; }

//     const targetStatus = actionKey === "repair" ? "repair" : "notWorking";
//     const all          = readUnits();
//     const matchIdx     = findUnitIndex(all, row);

//     if (matchIdx >= 0) {
//       all[matchIdx] = {
//         ...all[matchIdx],
//         status:     targetStatus,
//         repairDate:
//           targetStatus === "repair"
//             ? all[matchIdx].repairDate ?? new Date().toISOString()
//             : all[matchIdx].repairDate,
//       };
//       writeUnits(all);
//     } else {
//       console.debug("[InventoryDashboard] No unit found, building synthetic:", row.id);
//       writeUnits([...all, buildSyntheticUnit(row, targetStatus)]);
//     }

//     updateInventoryCounts(row, actionKey);
//     showToast(
//       actionKey === "repair"
//         ? `✅ "${row.name}" sent to Repair`
//         : `⚠️ "${row.name}" marked as Not Working`,
//     );
//     dispatchInventoryUpdate();
//     onRefresh();
//   }, [onRefresh, showToast]);

//   const handleRemoveConfirm = useCallback((removedBy, reason) => {
//     if (!removeTarget) return;

//     const all      = readUnits();
//     const matchIdx = findUnitIndex(all, removeTarget);

//     if (matchIdx >= 0) {
//       const unit = all[matchIdx];
//       safeLogDeletedAsset(
//         {
//           ...unit,
//           assetName: unit.assetName || removeTarget.name,
//           brand:     unit.brand     || removeTarget.name,
//           category:  unit.category  || removeTarget.inventoryCategory || "Hardware",
//         },
//         removedBy,
//         reason,
//       );
//       writeUnits(all.filter((_, i) => i !== matchIdx));
//     } else {
//       safeLogDeletedAsset(
//         {
//           assetName: removeTarget.name, brand: removeTarget.name,
//           model: "", category: removeTarget.inventoryCategory || "Hardware",
//           serialNumber: "", id: removeTarget.id,
//         },
//         removedBy,
//         reason,
//       );
//     }

//     updateInventoryCounts(removeTarget, "removed");
//     showToast(`🗑️ "${removeTarget.name}" moved to Removed Assets`);
//     setRemoveTarget(null);
//     dispatchInventoryUpdate();
//     onRefresh();
//   }, [removeTarget, onRefresh, showToast]);

//   return { removeTarget, setRemoveTarget, toast, handleStatusChange, handleRemoveConfirm };
// }

// // ─── InventoryShell ───────────────────────────────────────────────────────────

// export function InventoryShell({ children, category, setCategory, activeSegment }) {
//   const navigate  = useNavigate();
//   const headerRef = useRef(null);
//   const navRef    = useRef(null);

//   const [stickyTop, setStickyTop] = useState(0);
//   const [counts,    setCounts]    = useState(readLiveCounts);

//   useEffect(() => {
//     const measure = () => {
//       const headerH = headerRef.current?.offsetHeight ?? 0;
//       const navH    = navRef.current?.offsetHeight    ?? 0;
//       setStickyTop(headerH + navH);
//     };
//     measure();
//     window.addEventListener("resize", measure);
//     return () => window.removeEventListener("resize", measure);
//   }, []);

//   useEffect(() => {
//     const update = () => setCounts(readLiveCounts());
//     window.addEventListener("inventory-updated", update);
//     window.addEventListener("storage",           update);
//     return () => {
//       window.removeEventListener("inventory-updated", update);
//       window.removeEventListener("storage",           update);
//     };
//   }, []);

//   const visibleCards = useMemo(
//     () => SUMMARY_CARDS.filter(
//       (c) => !(c.segment === "removed-it" && category !== "IT Assets"),
//     ),
//     [category],
//   );

//   return (
//     <div className="inv-root">
//       <header className="inv-header" ref={headerRef}>
//         <div className="inv-header-left">
//           <button className="inv-back-btn" onClick={() => navigate("/it/")}>← Back</button>
//           <div className="inv-logo-group">
//             <div className="inv-logo">
//               <span className="inv-logo-dot" />
//               <span className="inv-logo-text">INVENTORY</span>
//             </div>
//             <span className="inv-header-sub">Asset Management System</span>
//           </div>
//         </div>
//         <div className="inv-header-right">
//           <button className="inv-btn-outline" onClick={() => navigate(`${BASE}/parcels`)}>📦 Parcels</button>
//           <button className="inv-btn-primary" onClick={() => navigate(`${BASE}/add-assets`)}>+ Add Assets</button>
//         </div>
//       </header>

//       <nav className="inv-tab-bar" ref={navRef}>
//         {INV_CATEGORIES.map((cat) => (
//           <button
//             key={cat}
//             className={category === cat ? "inv-tab--active" : "inv-tab"}
//             onClick={() => { setCategory(cat); navigate(BASE); }}
//           >
//             {cat}
//           </button>
//         ))}
//       </nav>

//       <section className="inv-cards-grid inv-cards-grid--sticky" style={{ top: stickyTop }}>
//         {visibleCards.map((card) => {
//           const isActive = activeSegment === card.segment;
//           const count    = counts[card.segment] ?? 0;
//           return (
//             <button
//               key={card.segment}
//               className="inv-card"
//               style={{
//                 borderColor: isActive ? card.color : "#e2e8f0",
//                 boxShadow:   isActive ? `0 4px 14px ${card.color}33` : "none",
//               }}
//               onClick={() => navigate(`${BASE}/${card.segment}`)}
//             >
//               <span className="inv-card-label">{card.label}</span>
//               <span
//                 className="inv-card-count"
//                 style={{ color: count === 0 ? "#94a3b8" : isActive ? card.color : "#0f172a" }}
//               >
//                 {count}
//               </span>
//               <div className="inv-card-bar" style={{ background: card.color }} />
//             </button>
//           );
//         })}
//       </section>

//       {children}
//     </div>
//   );
// }

// // ─── Shared AssetTable ────────────────────────────────────────────────────────

// function AssetTable({ assets, filter, onViewAsset, onStatusChange }) {
//   const showAvailable = filter !== "Assigned";
//   const showAssigned  = filter !== "Available";
//   const emptyColSpan  = 4 + (showAvailable ? 1 : 0) + (showAssigned ? 1 : 0);

//   return (
//     <div className="inv-table-scroll">
//       <table className="inv-table">
//         <thead>
//           <tr>
//             <th>Assets Name</th>
//             <th>Total Qty</th>
//             {showAvailable && <th>Available</th>}
//             <th>Category</th>
//             {showAssigned  && <th>Assigned</th>}
//             <th>Action</th>
//           </tr>
//         </thead>
//         <tbody>
//           {assets.length === 0 ? (
//             <tr>
//               <td colSpan={emptyColSpan} className="inv-empty-row">No assets found.</td>
//             </tr>
//           ) : (
//             assets.map((row, i) => (
//               <tr key={row.id} className={i % 2 === 0 ? "tr-even" : "tr-odd"}>
//                 <td className="td-name">
//                   {row.hwType ? (
//                     <div className="td-name-wrap">
//                       <span className="td-name-brand">{row.name}</span>
//                       <span className="td-name-sub">{row.hwType}</span>
//                     </div>
//                   ) : (
//                     <span className="td-name-brand">{row.name}</span>
//                   )}
//                 </td>
//                 <td>{row.total}</td>
//                 {showAvailable && <td className="td-available">{row.available}</td>}
//                 <td><span className="inv-category-badge">{row.inventoryCategory}</span></td>
//                 {showAssigned  && <td className="td-assigned">{row.assigned}</td>}
//                 <td>
//                   <button className="inv-action-btn" onClick={() => onViewAsset(row)}>View</button>
//                   <EditDropdown row={row} onStatusChange={onStatusChange} />
//                 </td>
//               </tr>
//             ))
//           )}
//         </tbody>
//       </table>
//     </div>
//   );
// }

// // ─── TotalAssetsPage ──────────────────────────────────────────────────────────

// function TotalAssetsPage({ category }) {
//   const [filter,        setFilter]        = useState("All");
//   const [hwTypeFilter,  setHwTypeFilter]  = useState("All");
//   const [searchQuery,   setSearchQuery]   = useState("");
//   const [detailAsset,   setDetailAsset]   = useState(null);
//   const [refreshKey,    setRefreshKey]    = useState(0);

//   const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
//   const { removeTarget, setRemoveTarget, toast, handleStatusChange, handleRemoveConfirm } =
//     useAssetActions(refresh);

//   // Base list for this category (unfiltered by status) — used for per-pill counts
//   const baseAssets = useMemo(() => {
//     void refreshKey;
//     return getMappedInventory().filter((a) => a.inventoryCategory === category);
//   }, [category, refreshKey]);

//   // Per-filter counts shown on the pills
//   const filterCounts = useMemo(() => ({
//     All:       baseAssets.length,
//     Available: baseAssets.filter((a) => a.available > 0).length,
//     Assigned:  baseAssets.filter((a) => a.assigned  > 0).length,
//   }), [baseAssets]);

//   const filteredAssets = useMemo(() => {
//     void refreshKey;
//     const q = searchQuery.trim().toLowerCase();
//     return baseAssets
//       .filter((a) => {
//         if (filter === "Available") return a.available > 0;
//         if (filter === "Assigned")  return a.assigned  > 0;
//         return true; // "All" — every asset regardless of status
//       })
//       .filter((a) => {
//         if (hwTypeFilter === "All") return true;
//         return (a.category ?? "").toLowerCase() === hwTypeFilter.toLowerCase();
//       })
//       .filter((a) => {
//         if (!q) return true;
//         return (
//           a.name.toLowerCase().includes(q) ||
//           (a.hwType  ?? "").toLowerCase().includes(q) ||
//           (a.category ?? "").toLowerCase().includes(q)
//         );
//       });
//   }, [baseAssets, filter, hwTypeFilter, searchQuery, refreshKey]);

//   return (
//     <>
//       {toast && <div className="inv-toast">{toast}</div>}

//       <div className="inv-filter-row">
//         <span className="inv-filter-label">Filter:</span>
//         {FILTER_OPTIONS.map((f) => (
//           <button
//             key={f}
//             className={filter === f ? "inv-filter-pill--active" : "inv-filter-pill"}
//             onClick={() => setFilter(f)}
//           >
//             {f}
//             <span className="inv-filter-pill-count">{filterCounts[f] ?? 0}</span>
//           </button>
//         ))}

//         <span className="inv-filter-divider" />

//         <span className="inv-filter-label">Type:</span>
//         <select
//           className="inv-hwtype-dropdown"
//           value={hwTypeFilter}
//           onChange={(e) => setHwTypeFilter(e.target.value)}
//         >
//           {["All", "Hardware", "Consumables", "Accessories"].map((opt) => (
//             <option key={opt} value={opt}>{opt}</option>
//           ))}
//         </select>

//         <div className="inv-search-wrap">
//           <span className="inv-search-icon">🔍</span>
//           <input
//             className="inv-search-input"
//             type="text"
//             placeholder="Search by brand..."
//             value={searchQuery}
//             onChange={(e) => setSearchQuery(e.target.value)}
//           />
//           {searchQuery && (
//             <button className="inv-search-clear" onClick={() => setSearchQuery("")}>×</button>
//           )}
//         </div>
//       </div>

//       <section className="inv-table-wrap">
//         <div className="inv-table-header">
//           <span className="inv-table-title">{category} — TOTAL ASSETS</span>
//           <span className="inv-table-count">{filteredAssets.length} assets</span>
//         </div>
//         <AssetTable
//           assets={filteredAssets}
//           filter={filter}
//           onViewAsset={setDetailAsset}
//           onStatusChange={handleStatusChange}
//         />
//       </section>

//       {detailAsset  && <AssetDetailModal asset={detailAsset}  onClose={() => setDetailAsset(null)} />}
//       {removeTarget && <RemoveAssetModal asset={removeTarget} onConfirm={handleRemoveConfirm} onCancel={() => setRemoveTarget(null)} />}
//     </>
//   );
// }

// // ─── OverviewPage ─────────────────────────────────────────────────────────────

// function OverviewPage({ category }) {
//   const [detailAsset, setDetailAsset] = useState(null);
//   const [refreshKey,  setRefreshKey]  = useState(0);

//   const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
//   const { removeTarget, setRemoveTarget, toast, handleStatusChange, handleRemoveConfirm } =
//     useAssetActions(refresh);

//   const assets = useMemo(() => {
//     void refreshKey;
//     return getMappedInventory().filter((a) => a.inventoryCategory === category);
//   }, [category, refreshKey]);

//   return (
//     <>
//       {toast && <div className="inv-toast">{toast}</div>}

//       <section className="inv-table-wrap">
//         <div className="inv-table-header">
//           <span className="inv-table-title">{category} — OVERVIEW</span>
//           <span className="inv-table-count">{assets.length} records</span>
//         </div>
//         <AssetTable
//           assets={assets}
//           filter="All"
//           onViewAsset={setDetailAsset}
//           onStatusChange={handleStatusChange}
//         />
//       </section>

//       {detailAsset  && <AssetDetailModal asset={detailAsset}  onClose={() => setDetailAsset(null)} />}
//       {removeTarget && <RemoveAssetModal asset={removeTarget} onConfirm={handleRemoveConfirm} onCancel={() => setRemoveTarget(null)} />}
//     </>
//   );
// }

// // ─── InventoryRoot + default export ──────────────────────────────────────────

// function InventoryRoot() {
//   const [category, setCategory] = useState("IT Assets");
//   const location  = useLocation();
//   const segment   = location.pathname.replace(BASE, "").replace(/^\//, "");

//   return (
//     <InventoryShell category={category} setCategory={setCategory} activeSegment={segment}>
//       <Routes>
//         <Route path="/"              element={<OverviewPage    category={category} />} />
//         <Route path="total"          element={<TotalAssetsPage category={category} />} />
//         <Route path="not-working"    element={<NotWorking />} />
//         <Route path="in-repair"      element={<InRepair />} />
//         <Route path="removed-it"     element={<RemovedITAssets />} />
//         <Route path="removed-assets" element={<RemovedAssets />} />
//       </Routes>
//     </InventoryShell>
//   );
// }

// const InventoryDashboard = () => (
//   <Routes>
//     <Route path="add-assets"   element={<AddNewAssets />} />
//     <Route path="parcels"      element={<Parcel />} />
//     <Route path="add-import"   element={<AddImported />} />
//     <Route path="ready-export" element={<ReadyExport />} />
//     <Route path="/*"           element={<InventoryRoot />} />
//   </Routes>
// );

// export default InventoryDashboard;



