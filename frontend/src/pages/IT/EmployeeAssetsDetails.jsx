import React, { useState, useCallback, useMemo, useRef } from "react";
import { useNavigate, useLocation, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { useRefreshOnNavigate } from "../../hooks/useRefreshOnNavigate";
import { useUser } from "../../components/layout/UserContext";
import { canAccessItPanel, canViewOwnAssignedAssets } from "../../utils/planFeatures";
import {
  compressImage,
  createReturnRequestAPI,
  fetchEmployeeAssetsAPI,
  getEmployees,
  getAssetUnitsFromStorage,
  getInventoryFromStorage,
  toastITApiFailure,
  listEmployeeReturnRequestsAPI,
  syncITDataFromAPI
} from "./Data";
import ClickableImage from "../../components/ClickableImage";
import { UserAvatar } from "../../components/UserAvatar";
import { openFirstImageInNewTab } from "../../utils/openImageInNewTab";
import { isImageSrc } from "../../utils/mediaSrc";
import "./EmployeeAssetsDetails.css";
import { formatDate, formatDateTimeDDMMYYYY } from "../../utils/dateFormat";
import {
  getHardwareFields,
  getMobileTabletHardwareFields,
  isMobileTabletHwType,
} from "./inventoryCategories";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const swDaysRemaining = (endDate) => {
  if (!endDate) return null;
  return Math.ceil((new Date(endDate) - new Date()) / (1000 * 60 * 60 * 24));
};

const enrichHardware = (asset) => {
  const unit    = getAssetUnitsFromStorage().find((u) => u.assetId === asset.assetId) || {};
  const invItem = getInventoryFromStorage().find(
    (i) => i.name === asset.name && i.category === "Hardware",
  ) || {};
  const assetTag = (asset.assetTag || unit.assetTag || "").trim();
  const photos   =
    asset.status?.toLowerCase() === "available"
      ? unit.photos || asset.photos || []
      : unit.assignmentPhotos?.length
        ? unit.assignmentPhotos
        : asset.photos || unit.photos || [];
  return {
    ...asset,
    displayAssetId: assetTag || asset.assetId || "—",
    hwType:       asset.hwType       || unit.hwType       || "Laptop",
    brand:        asset.brand        || unit.brand        || invItem.brand  || "—",
    make:         asset.make         || unit.make         || invItem.make   || "—",
    model:        asset.model        || unit.model        || invItem.model  || "—",
    serialNumber: asset.serialNumber || unit.serialNumber || "—",
    imei1:        asset.imei1        || unit.imei1        || null,
    imei2:        asset.imei2        || unit.imei2        || null,
    projectCode:  asset.projectCode  || unit.projectCode  || unit.project_code || "",
    deviceLocation: asset.deviceLocation || unit.deviceLocation || unit.device_location || "",
    photos,
  };
};

// ─── Constants ────────────────────────────────────────────────────────────────
const TABS = ["All", "Hardware", "Accessories", "Consumables"];
const RETURN_STATUS_TABS = ["All", "Pending", "Approved", "Rejected", "Completed"];

const STATUS_CLS = {
  Assigned: "assigned", Available: "available",
  "Not Working": "not-working", Repair: "repair",
};
const statusCls = (s) => STATUS_CLS[s] || "assigned";
const rrStatusCls = (s) => {
  const key = String(s || "").toLowerCase();
  if (key === "pending") return "rr-pending";
  if (key === "approved") return "rr-approved";
  if (key === "rejected") return "rr-rejected";
  if (key === "completed") return "rr-completed";
  return "rr-pending";
};

const formatReturnDest = (dest) =>
  dest === "removed_from_it" ? "Removed From IT" : "Available";

const destBadgeCls = (dest) =>
  dest === "removed_from_it" ? "rr-dest-removed" : "rr-dest-available";

const formatReturnUpdate = (r) => {
  const status = String(r.status || "").toLowerCase();
  if (status === "rejected") {
    return r.rejectionReason || "Rejected by IT";
  }
  if (status === "completed") {
    const who = r.receiptConfirmedByName ? ` by ${r.receiptConfirmedByName}` : "";
    const when = r.receiptConfirmedAt
      ? ` · ${formatDateTimeDDMMYYYY(r.receiptConfirmedAt)}`
      : "";
    return `Received${who}${when}`;
  }
  if (status === "approved") {
    const who = r.approvedByName ? ` by ${r.approvedByName}` : "";
    const when = r.approvedAt
      ? ` · ${formatDateTimeDDMMYYYY(r.approvedAt)}`
      : "";
    return `Approved${who}${when}. Submit asset to IT desk.`;
  }
  return "Pending IT review";
};

const ReturnHistoryTable = ({ rows, onViewPhotos }) => (
  <div className="ea-table-wrap">
    <table className="ea-table rr-table">
      <thead>
        <tr>
          <th>Request Code</th>
          <th>Asset</th>
          <th>Qty</th>
          <th>Return To</th>
          <th>Reason</th>
          <th>Files</th>
          <th>Status</th>
          <th>Requested</th>
          <th>Update</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={9} className="ea-empty">
              No return requests yet.
            </td>
          </tr>
        ) : (
          rows.map((r) => {
            const photos = Array.isArray(r.photos) ? r.photos : [];
            const qty = Math.max(1, Number(r.quantity) || 1);
            return (
              <tr key={r.id}>
                <td className="rr-code" data-label="Request Code">{r.requestCode || "—"}</td>
                <td data-label="Asset">
                  <strong>{r.assetName || "—"}</strong>
                  <div className="rr-asset-cat">{r.category || "—"}</div>
                </td>
                <td data-label="Qty">{qty > 1 || r.inventoryItemId ? qty : "—"}</td>
                <td data-label="Return To">
                  <span className={`rr-dest-badge ${destBadgeCls(r.returnDestination)}`}>
                    {formatReturnDest(r.returnDestination)}
                  </span>
                </td>
                <td className="rr-reason-cell" data-label="Reason">{r.reason || "—"}</td>
                <td data-label="Files">
                  {photos.length > 0 ? (
                    <button
                      type="button"
                      className="ea-btn-photos"
                      onClick={() => onViewPhotos(photos)}
                    >
                      View ({photos.length})
                    </button>
                  ) : (
                    <span className="ea-no-photos">—</span>
                  )}
                </td>
                <td data-label="Status">
                  <span className={`rr-status-badge ${rrStatusCls(r.status)}`}>
                    {r.status || "pending"}
                  </span>
                </td>
                <td className="rr-date-cell" data-label="Requested">
                  {formatDateTimeDDMMYYYY(r.createdAt)}
                </td>
                <td className="rr-update-cell" data-label="Update">{formatReturnUpdate(r)}</td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  </div>
);

// ─── Sub-components ───────────────────────────────────────────────────────────
const PhotosCell = ({ photos }) =>
  photos?.length ? (
    <button
      type="button"
      className="ea-btn-photos"
      onClick={() => openFirstImageInNewTab(photos)}
      title="Open photo in new tab"
    >
      View ({photos.length})
    </button>
  ) : (
    <span className="ea-no-photos">No photos</span>
  );

const HardwareTable = ({ assets, onRemove, onViewDetails, canRequestReturn = true }) => (
  <div className="ea-table-wrap">
    <table className="ea-table">
      <thead>
        <tr>
          <th>Asset Name</th><th>Details</th>
          <th>Status</th><th>Photos</th>{canRequestReturn ? <th>Action</th> : null}
        </tr>
      </thead>
      <tbody>
        {assets.length === 0 ? (
          <tr><td colSpan={canRequestReturn ? 5 : 4} className="ea-empty">No hardware assets assigned</td></tr>
        ) : (
          assets.map((a) => (
            <tr key={a.id}>
              <td data-label="Asset Name">
                <strong className="ea-asset-name">{a.name}</strong>
                {(a.assetTag || a.assetId) && (
                  <div className="ea-asset-id-sub">#{a.assetTag || a.assetId}</div>
                )}
              </td>
              <td data-label="Details">
                <button className="ea-btn-view-details" onClick={() => onViewDetails(a)}>
                  View Details
                </button>
              </td>
              <td data-label="Status"><span className={`ea-status-badge ${statusCls(a.status)}`}>{a.status}</span></td>
              <td data-label="Photos"><PhotosCell photos={a.photos} /></td>
              {canRequestReturn ? (
                <td className="ea-action-cell" data-label="Action">
                  <button className="ea-btn-remove" onClick={() => onRemove(a.assetId, a.id)}>
                    Return
                  </button>
                </td>
              ) : null}
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

const SoftwareTable = ({ assets, onRemove, canRequestReturn = true }) => (
  <div className="ea-table-wrap">
    <table className="ea-table ea-sw-table">
      <thead>
        <tr>
          <th>Software Name</th><th>License ID</th>
          <th>Start Date</th><th>Valid Till</th>
          <th>Days Left</th><th>Status</th>{canRequestReturn ? <th>Action</th> : null}
        </tr>
      </thead>
      <tbody>
        {assets.length === 0 ? (
          <tr><td colSpan={canRequestReturn ? 7 : 6} className="ea-empty">No software assigned</td></tr>
        ) : (
          assets.map((a) => {
            const days      = swDaysRemaining(a.subscriptionEnd || a.licenseExpiry);
            const isExpired = days !== null && days < 0;
            const isWarning = !isExpired && days !== null && days <= 30;
            return (
              <tr
                key={a.id}
                className={isExpired ? "ea-sw-expired" : isWarning ? "ea-sw-warning" : ""}
              >
                <td data-label="Software Name"><strong className="ea-asset-name">{a.name}</strong></td>
                <td data-label="License ID">
                  <span className="ea-sw-license-id">{a.licenseId || a.swId || "—"}</span>
                </td>
                <td className="ea-sw-date" data-label="Start Date">
                  {a.subscriptionStart
                    ? formatDate(a.subscriptionStart) : "—"}
                </td>
                <td className="ea-sw-date" data-label="Valid Till">
                  {a.subscriptionEnd || a.licenseExpiry
                    ? formatDate(a.subscriptionEnd || a.licenseExpiry)
                    : "—"}
                </td>
                <td data-label="Days Left">
                  {days === null ? "—" : (
                    <span className={`ea-sw-days ${isExpired ? "expired" : isWarning ? "warning" : "ok"}`}>
                      {isExpired ? "Expired" : `${days}d`}
                    </span>
                  )}
                </td>
                <td data-label="Status">
                  <span className={`ea-status-badge ${isExpired ? "not-working" : "assigned"}`}>
                    {isExpired ? "Expired" : a.status || "Assigned"}
                  </span>
                </td>
                {canRequestReturn ? (
                  <td className="ea-action-cell" data-label="Action">
                    <button className="ea-btn-remove" onClick={() => onRemove(null, a.id)}>
                      Return
                    </button>
                  </td>
                ) : null}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  </div>
);

const readFileAsDataURL = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => resolve(e.target.result);
    reader.readAsDataURL(file);
  });

const ReturnRequestModal = ({ entry, onClose, onSubmit, submitting }) => {
  const [reason, setReason] = useState("");
  const [destination, setDestination] = useState("available");
  const [photos, setPhotos] = useState([]);
  const fileRef = useRef(null);

  const maxQty = Math.max(1, Number(entry?.quantity) || 1);
  const [qty, setQty] = useState(maxQty);
  const isBulk = maxQty > 1;

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    try {
      const encoded = await Promise.all(
        files.map(async (file) => {
          if (file.type.startsWith("image/")) {
            return compressImage(file);
          }
          return readFileAsDataURL(file);
        }),
      );
      setPhotos((prev) => [...prev, ...encoded]);
    } catch {
      toast.error("Could not read one or more files.");
    }
    e.target.value = "";
  };

  const handleSubmit = () => {
    const cleanReason = reason.trim();
    if (!cleanReason) {
      toast.error("Reason is required.");
      return;
    }
    onSubmit({
      reason: cleanReason,
      returnDestination: destination,
      quantity: isBulk ? Math.max(1, Math.min(maxQty, Number(qty) || 1)) : 1,
      photos,
    });
  };

  if (!entry) return null;

  return (
    <div className="ea-rr-overlay" onClick={onClose}>
      <div className="ea-rr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ea-rr-hdr">
          <h3>Return Asset</h3>
          <button type="button" className="ea-rr-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="ea-rr-asset">
          <strong>{entry.name}</strong>
          <span className="ea-rr-cat">{entry.category}</span>
        </p>

        {isBulk && (
          <label className="ea-rr-field">
            <span>Quantity to return</span>
            <input
              type="number"
              min={1}
              max={maxQty}
              value={qty}
              onChange={(e) =>
                setQty(Math.max(1, Math.min(maxQty, Number(e.target.value) || 1)))
              }
            />
            <small>Max: {maxQty}</small>
          </label>
        )}

        <label className="ea-rr-field">
          <span>Reason <em>*</em></span>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why are you returning this asset?"
          />
        </label>

        <fieldset className="ea-rr-dest">
          <legend>Return to</legend>
          <label className="ea-rr-radio">
            <input
              type="radio"
              name="returnDestination"
              value="removed_from_it"
              checked={destination === "removed_from_it"}
              onChange={() => setDestination("removed_from_it")}
            />
            <span>
              <strong>Removed From IT</strong>
              <small>Logged under Inventory → Dead Assets / Removed From IT</small>
            </span>
          </label>
          <label className="ea-rr-radio">
            <input
              type="radio"
              name="returnDestination"
              value="available"
              checked={destination === "available"}
              onChange={() => setDestination("available")}
            />
            <span>
              <strong>Available</strong>
              <small>Returned to available stock for reassignment</small>
            </span>
          </label>
        </fieldset>

        <div className="ea-rr-upload">
          <span>Photos / files <small>(optional)</small></span>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,.pdf,.doc,.docx"
            className="ea-rr-file-input"
            onChange={handleFiles}
          />
          <button
            type="button"
            className="ea-rr-upload-btn"
            onClick={() => fileRef.current?.click()}
          >
            + Add files
          </button>
          {photos.length > 0 && (
            <div className="ea-rr-previews">
              {photos.map((src, i) => (
                <div key={i} className="ea-rr-preview-wrap">
                  {isImageSrc(src) ? (
                    <ClickableImage src={src} alt={`upload-${i + 1}`} className="ea-rr-preview" />
                  ) : (
                    <span className="ea-rr-file-tag">File {i + 1}</span>
                  )}
                  <button
                    type="button"
                    className="ea-rr-preview-rm"
                    onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="ea-rr-footer">
          <button type="button" className="ea-rr-cancel" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="ea-rr-submit"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? "Submitting…" : "Submit Return Request"}
          </button>
        </div>
      </div>
    </div>
  );
};

const NonHardwareTable = ({ assets, onRemove, canRequestReturn = true }) => (
  <div className="ea-table-wrap">
    <table className="ea-table">
      <thead>
        <tr>
          <th>Asset Name</th><th>Category</th>
          <th>Status</th><th>Photos</th>{canRequestReturn ? <th>Action</th> : null}
        </tr>
      </thead>
      <tbody>
        {assets.length === 0 ? (
          <tr><td colSpan={canRequestReturn ? 5 : 4} className="ea-empty">No assets in this category</td></tr>
        ) : (
          assets.map((a) => (
            <tr key={a.id}>
              <td data-label="Asset Name"><strong className="ea-asset-name">{a.name}</strong></td>
              <td data-label="Category">
                <span className={`ea-cat-badge ${a.category.toLowerCase()}`}>{a.category}</span>
              </td>
              <td data-label="Status"><span className={`ea-status-badge ${statusCls(a.status)}`}>{a.status}</span></td>
              <td data-label="Photos"><PhotosCell photos={a.photos} /></td>
              {canRequestReturn ? (
                <td className="ea-action-cell" data-label="Action">
                  <button className="ea-btn-remove" onClick={() => onRemove(null, a.id)}>
                    Return
                  </button>
                </td>
              ) : null}
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

// ─── Main Component ───────────────────────────────────────────────────────────
const EmployeeDetails = () => {
  const navigate  = useNavigate();
  const location  = useLocation();
  const { empId } = useParams();
  const { userData } = useUser();
  const user = userData?.user;

  const [employee,   setEmployee  ] = useState(null);
  const [loading,    setLoading   ] = useState(true);
  const [filterTab,  setFilterTab ] = useState("All");
  const [hwModal,    setHwModal   ] = useState(null);
  const [hwPhotoIdx, setHwPhotoIdx] = useState(0);
  const [returnHistory, setReturnHistory] = useState([]);
  const [returnHistoryFilter, setReturnHistoryFilter] = useState("All");
  const [returnTarget, setReturnTarget] = useState(null);
  const [returnSubmitting, setReturnSubmitting] = useState(false);
  const returnHistoryRef = useRef(null);

  const loadReturnHistory = useCallback(async (employeeRecord) => {
    const id = String(
      employeeRecord?.empId || employeeRecord?.id || empId || "",
    ).trim();
    if (!id) {
      setReturnHistory([]);
      return [];
    }
    try {
      const historyRows = await listEmployeeReturnRequestsAPI(id);
      const rows = Array.isArray(historyRows) ? historyRows : [];
      setReturnHistory(rows);
      return rows;
    } catch {
      setReturnHistory([]);
      return [];
    }
  }, [empId]);

  const isSelfAssetsView =
    Boolean(location.state?.selfAssets)
    || canViewOwnAssignedAssets(user, empId);
  const isOwnAssetsPage = canViewOwnAssignedAssets(user, empId);
  const canRequestReturn = canAccessItPanel(user) || isOwnAssetsPage;
  const showReturnHistory = canRequestReturn || isSelfAssetsView;

  const loadEmployee = useCallback(async () => {
    const id = empId || "";
    if (!id) {
      setEmployee(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // Self-assets view should not depend on full IT sync access.
      if (!isSelfAssetsView) {
        try {
          await syncITDataFromAPI();
        } catch (syncErr) {
          console.warn("[EmployeeAssetsDetails] IT sync skipped:", syncErr);
        }
      }
      const apiEmployee = await fetchEmployeeAssetsAPI(id);
      setEmployee(apiEmployee || null);
      if (apiEmployee) await loadReturnHistory(apiEmployee);
    } catch (err) {
      console.error("[EmployeeAssetsDetails] API load failed, using fallback:", err);
      toastITApiFailure(
          err,
          "Could not load this employee from the server. Showing saved or cached data.",
        );
      const fromState = location.state?.employee;
      if (fromState) await loadReturnHistory(fromState);
      else await loadReturnHistory({ empId: id, id });
      if (fromState) {
        setEmployee(fromState);
      } else {
        const found = getEmployees().find(
          (e) =>
            (e.id || "").toUpperCase() === id.toUpperCase() ||
            (e.empId || "").toUpperCase() === id.toUpperCase(),
        );
        setEmployee(found || null);
      }
    } finally {
      setLoading(false);
    }
  }, [empId, isSelfAssetsView, location.state, loadReturnHistory, user]);

  useRefreshOnNavigate(loadEmployee, [empId]);

  const allAssets = (employee?.assignedAssets || []).filter(
    (a) => String(a.category || "").toLowerCase() !== "software",
  );

  const tabCount = useCallback(
    (tab) =>
      tab === "All"
        ? allAssets.length
        : allAssets.filter((a) => a.category === tab).length,
    [allAssets],
  );

  const filtered = useMemo(
    () =>
      filterTab === "All"
        ? allAssets
        : allAssets.filter((a) => a.category === filterTab),
    [allAssets, filterTab],
  );

  const hardwareAssets = useMemo(() => filtered.filter((a) => a.category === "Hardware"),  [filtered]);
  const accConAssets   = useMemo(
    () => filtered.filter((a) => a.category === "Accessories" || a.category === "Consumables"),
    [filtered],
  );
  const filteredReturnHistory = useMemo(() => {
    if (returnHistoryFilter === "All") return returnHistory;
    const wanted = returnHistoryFilter.toLowerCase();
    return returnHistory.filter((r) => String(r.status || "").toLowerCase() === wanted);
  }, [returnHistory, returnHistoryFilter]);

  const openReturnModal = useCallback(
    (assetId, entryId) => {
      if (!canRequestReturn) return;
      const list = employee?.assignedAssets || [];
      let entry = null;
      if (entryId != null && entryId !== "") {
        entry = list.find((a) => String(a.id) === String(entryId));
      }
      if (!entry && assetId != null && assetId !== "") {
        entry = list.find((a) => String(a.assetId) === String(assetId));
      }
      if (!entry) return;
      setReturnTarget(entry);
    },
    [employee, canRequestReturn],
  );

  const handleReturnSubmit = useCallback(
    async ({ reason, returnDestination, quantity, photos }) => {
      if (!canRequestReturn) return;
      const entry = returnTarget;
      if (!entry) return;
      setReturnSubmitting(true);
      try {
        const payload = {
          reason,
          returnDestination,
          photos: photos || [],
          quantity: Math.max(1, Number(quantity) || 1),
        };
        const cat = entry.category;
        let res;
        if (cat === "Hardware") {
          res = await createReturnRequestAPI({
            ...payload,
            assetUnitId: entry.id,
          });
        } else if (cat === "Software") {
          res = await createReturnRequestAPI({
            ...payload,
            softwareLicenseId: entry.licenseId || entry.id,
          });
        } else if (
          cat === "Accessories" ||
          cat === "Consumables" ||
          cat === "Consumable"
        ) {
          if (!entry.inventoryId) {
            toast.error("Inventory reference missing for this asset.");
            return;
          }
          res = await createReturnRequestAPI({
            ...payload,
            inventoryItemId: entry.inventoryId,
            quantity: payload.quantity,
          });
        } else {
          toast.error("Return request for this category is not supported yet.");
          return;
        }

        const created = res?.request;
        if (created?.id) {
          setReturnHistory((prev) => {
            const exists = prev.some((r) => r.id === created.id);
            if (exists) return prev;
            return [created, ...prev];
          });
        }
        setReturnHistoryFilter("Pending");
        await loadReturnHistory(employee);
        setReturnTarget(null);
        toast.success("Return request submitted. IT approval is pending.");
        requestAnimationFrame(() => {
          returnHistoryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      } catch (err) {
        console.error("[EmployeeAssetsDetails] Return request failed:", err);
        toastITApiFailure(err, "Could not submit return request.");
      } finally {
        setReturnSubmitting(false);
      }
    },
    [returnTarget, employee, empId, loadReturnHistory, canRequestReturn],
  );

  const openHwModal    = useCallback((asset) => { setHwModal(enrichHardware(asset)); setHwPhotoIdx(0); }, []);
  const closeHwModal   = useCallback(() => setHwModal(null), []);
  const hwModalFields = useMemo(() => {
    if (!hwModal) return null;
    const base = getHardwareFields("IT Assets", "Hardware", hwModal.hwType);
    return isMobileTabletHwType(hwModal.hwType) ? getMobileTabletHardwareFields(base) : base;
  }, [hwModal]);

  if (loading)   return <div className="employee-assets"><div className="ea-loading">Loading…</div></div>;
  if (!employee) return <div className="employee-assets"><div className="ea-loading">Employee not found.</div></div>;

  return (
    <div className="employee-assets">
      <div className="ea-page-inner">
      <header className="ea-topbar">
        <div className="ea-topbar-left">
          <button type="button" className="btn-back" onClick={() => navigate(isSelfAssetsView ? "/dashboard" : -1)}>
            ← {isSelfAssetsView ? "Back" : "Back to Active Devices"}
          </button>
          <div className="ea-title-block">
            <p className="ea-kicker">{isSelfAssetsView ? "My workspace" : "IT · Asset Management"}</p>
            <h1 className="ea-page-title">{isSelfAssetsView ? "My Assets" : "Employee assets"}</h1>
          </div>
        </div>
        <div className="ea-topbar-right">
          {isSelfAssetsView ? (
            <button type="button" className="ea-dayuse-btn" onClick={() => navigate("/daily-assets")}>
              Day-use Assets
            </button>
          ) : (
            <p className="ea-total">
              <strong>{allAssets.length}</strong> asset{allAssets.length === 1 ? "" : "s"}
            </p>
          )}
        </div>
      </header>

      {!isSelfAssetsView ? (
      <div className="employee-details-card">
        <div className="employee-layout">
          <div className="employee-photo-section">
            <div className="photo-container">
              <UserAvatar
                user={employee}
                name={employee.name}
                className="employee-profile-photo"
                alt={employee.name}
              />
            </div>
          </div>
          <div className="employee-info-section">
            <h2 className="ea-emp-name">{employee.name}</h2>
            <p className="ea-emp-meta">
              {[employee.type, employee.circle].filter(Boolean).join(" · ") || "Assigned inventory"}
            </p>
            <div className="info-grid">
              {[
                ["Employee ID",  employee.id     ],
                ["Type",         employee.type   ],
                ["Circle",       employee.circle ],
                ["Email",        employee.email  ],
                ["Total Assets", allAssets.length],
              ].map(([label, value]) => (
                <div key={label} className="info-item">
                  <span className="info-label">{label}</span>
                  <span className="info-value">{value || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      ) : null}

      {/* ── Assets Section ── */}
      <div className="assets-section">
        <h2>Assigned Assets ({allAssets.length})</h2>

        {/* Tabs */}
        <div className="filter-tabs">
          {TABS.map((tab) => (
            <button
              key={tab}
              className={`filter-tab ${filterTab === tab ? "active" : ""}`}
              onClick={() => setFilterTab(tab)}
            >
              {tab} <span className="count-badge">{tabCount(tab)}</span>
            </button>
          ))}
        </div>

        {filterTab === "All" && (
          <>
            {hardwareAssets.length > 0 && (
              <>
                <div className="ea-section-label">
                  <span className="ea-section-dot hardware" /> Hardware Assets
                </div>
                <HardwareTable
                  assets={hardwareAssets} onRemove={openReturnModal}
                  canRequestReturn={canRequestReturn}
                  onViewDetails={openHwModal}
                />
              </>
            )}
            {accConAssets.length > 0 && (
              <>
                <div className="ea-section-label">
                  <span className="ea-section-dot other" /> Accessories / Consumables
                </div>
                <NonHardwareTable
                  assets={accConAssets} onRemove={openReturnModal}
                  canRequestReturn={canRequestReturn}
                />
              </>
            )}
            {allAssets.length === 0 && (
              <div className="ea-table-wrap">
                <p className="ea-empty">No assets assigned yet.</p>
              </div>
            )}
          </>
        )}

        {filterTab === "Hardware" && (
          <HardwareTable
            assets={filtered} onRemove={openReturnModal}
            canRequestReturn={canRequestReturn}
            onViewDetails={openHwModal}
          />
        )}
        {(filterTab === "Accessories" || filterTab === "Consumables") && (
          <NonHardwareTable
            assets={filtered} onRemove={openReturnModal}
            canRequestReturn={canRequestReturn}
          />
        )}
      </div>

      {showReturnHistory ? (
        <div className="assets-section" ref={returnHistoryRef}>
          <h2>Return Request History ({returnHistory.length})</h2>
          <p className="rr-history-hint">
            {isSelfAssetsView && !canAccessItPanel(user)
              ? "Your return requests appear here after you submit them from the tables above."
              : "Requests appear here as soon as you submit a return. Use filters to see pending, approved, or completed items."}
          </p>
          <div className="rr-filter-tabs">
            {RETURN_STATUS_TABS.map((tab) => (
              <button
                key={tab}
                className={`rr-filter-tab ${returnHistoryFilter === tab ? "active" : ""}`}
                onClick={() => setReturnHistoryFilter(tab)}
              >
                {tab}
                <span className="count-badge">
                  {tab === "All"
                    ? returnHistory.length
                    : returnHistory.filter((r) => String(r.status || "").toLowerCase() === tab.toLowerCase()).length}
                </span>
              </button>
            ))}
          </div>
          <ReturnHistoryTable
            rows={filteredReturnHistory}
            onViewPhotos={(photos) => openFirstImageInNewTab(photos)}
          />
        </div>
      ) : null}

      {/* ── Hardware Details Modal ── */}
      {hwModal && (
        <div className="hdm-backdrop" onClick={closeHwModal}>
          <div className="hdm-panel" onClick={(e) => e.stopPropagation()}>
            <div className="hdm-header">
              <div className="hdm-header-left">
                <div>
                  <h2 className="hdm-title">{hwModal.name}</h2>
                  <div className="hdm-header-meta">
                    <span className="ea-cat-badge hardware">Hardware</span>
                    <span className={`ea-status-badge ${statusCls(hwModal.status)}`}>
                      {hwModal.status}
                    </span>
                  </div>
                </div>
              </div>
              <button className="hdm-close" onClick={closeHwModal}>×</button>
            </div>

            <div className="hdm-body">
              <div className="hdm-specs">
                <p className="hdm-col-title">Hardware Specifications</p>
                <div className="hdm-detail-list">
                  {[
                    { label: hwModalFields?.projectCode?.label || "Project Code", value: hwModal.projectCode, hide: !isMobileTabletHwType(hwModal.hwType) },
                    { label: "Brand",         value: hwModal.brand },
                    { label: hwModalFields?.make?.label || "Model",   value: hwModal.make || hwModal.model },
                    { label: "IMEI 1", value: hwModal.imei1, mono: true, hide: !isMobileTabletHwType(hwModal.hwType) },
                    { label: "IMEI 2", value: hwModal.imei2, mono: true, hide: !isMobileTabletHwType(hwModal.hwType) },
                    { label: "Serial Number", value: hwModal.serialNumber, mono: true },
                    { label: hwModalFields?.deviceLocation?.label || "Device Location", value: hwModal.deviceLocation, hide: !isMobileTabletHwType(hwModal.hwType) },
                  ].filter((row) => !row.hide).map(({ label, value, mono, highlight }) => (
                    <div key={label} className={`hdm-row ${highlight ? "highlight" : ""}`}>
                      <span className="hdm-row-label">{label}</span>
                      <span className={`hdm-row-value ${mono ? "mono" : ""}`}>{value || "—"}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="hdm-photos">
                <p className="hdm-col-title">Photos</p>
                {!hwModal.photos?.length ? (
                  <div className="hdm-no-photos">
                    <div className="hdm-no-photo-icon">📷</div>
                    <p>No photos available</p>
                  </div>
                ) : (
                  <div className="hdm-photo-viewer">
                    <div className="hdm-main-wrap">
                      <ClickableImage
                        src={hwModal.photos[hwPhotoIdx]}
                        alt=""
                        className="hdm-main-img"
                      />
                      {hwModal.photos.length > 1 && (
                        <>
                          <button
                            className="hdm-nav prev"
                            onClick={(e) => { e.stopPropagation(); setHwPhotoIdx((i) => (i - 1 + hwModal.photos.length) % hwModal.photos.length); }}
                          >‹</button>
                          <button
                            className="hdm-nav next"
                            onClick={(e) => { e.stopPropagation(); setHwPhotoIdx((i) => (i + 1) % hwModal.photos.length); }}
                          >›</button>
                          <div className="hdm-photo-counter">{hwPhotoIdx + 1} / {hwModal.photos.length}</div>
                        </>
                      )}
                    </div>
                    {hwModal.photos.length > 1 && (
                      <div className="hdm-thumbs">
                        {hwModal.photos.map((p, i) => (
                          <ClickableImage
                            key={i}
                            src={p}
                            alt=""
                            className={`hdm-thumb ${i === hwPhotoIdx ? "active" : ""}`}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="hdm-footer">
              <button className="hdm-btn-close" onClick={closeHwModal}>Close</button>
            </div>
          </div>
        </div>
      )}

      {canRequestReturn && returnTarget && (
        <ReturnRequestModal
          entry={returnTarget}
          onClose={() => !returnSubmitting && setReturnTarget(null)}
          onSubmit={handleReturnSubmit}
          submitting={returnSubmitting}
        />
      )}

      </div>
    </div>
  );
};

export default EmployeeDetails;
