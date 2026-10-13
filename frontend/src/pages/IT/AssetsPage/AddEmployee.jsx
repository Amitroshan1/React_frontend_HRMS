

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { useRefreshOnNavigate } from "../../../hooks/useRefreshOnNavigate";
import {
  getEmployees,
  saveEmployees,
  getAssetUnitsFromStorage,
  saveAssetUnitsToStorage,
  getInventoryFromStorage,
  saveInventoryToStorage,
  getSoftwareInventory,
  saveSoftwareInventory,
  assignSoftwareToEmployeeAPI,
  assignInventoryQuantityAPI,
  assignUnitToEmployeeAPI,
  compressImage,
  toastITApiFailure,
  lookupEmployeeByEmpIdOrEmailAPI,
  syncITDataFromAPI,
  IT_NAV_SYNC_MAX_AGE_MS,
  SEED_EMPLOYEES
} from "../Data";
import { useTransitionRemark } from "../itam/TransitionRemarkModal";
import { remarkPayload } from "../itam/transitionUi";
import {
  getHardwareFields,
  getMobileTabletHardwareFields,
  isMobileTabletHwType,
  getHwTypesForCategory,
  subscribeHwTypesChange,
} from "../inventoryCategories";
import "./AddEmployee.css";
import { UserAvatar } from "../../../components/UserAvatar";

// ─── Pure utilities ───────────────────────────────────────────────────────────

const generateAssetId = () =>
  "ASSET-" +
  Date.now().toString(36).toUpperCase() +
  "-" +
  Math.random().toString(36).slice(2, 6).toUpperCase();

// ─── Constants ────────────────────────────────────────────────────────────────

const ASSIGN_CATS   = ["Hardware", "Accessories", "Consumables"];
const TAB_ICONS     = { Hardware: "🖥️", Software: "💿", Accessories: "🖱️", Consumables: "📦" };
const HW_TYPE_ICONS = { Laptop: "💻", Mobile: "📱", Desktop: "🖥️", Tablet: "📲", Other: "🔧" };

const EMPTY_PROFILE = {
  employeeId: "", name: "", type: "", circle: "", email: "", photoUrl: "", photoFile: null,
};

const LOOKUP_MIN_CHARS = 2;
const LOOKUP_DEBOUNCE_MS = 300;

function isLookupQueryReady(raw) {
  return String(raw || "").trim().length >= LOOKUP_MIN_CHARS;
}

function localEmployeeMatches(emp, q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return false;
  const id = (emp.id || emp.empId || "").toLowerCase();
  const email = (emp.email || "").toLowerCase();
  const name = (emp.name || "").toLowerCase();
  return id.includes(needle) || email.includes(needle) || name.includes(needle);
}

// ─── Self-healing employee getter ─────────────────────────────────────────────

function getEmployeesSafe() {
  try {
    const existing = getEmployees();
    if (Array.isArray(existing) && existing.length > 0) return existing;
    if (Array.isArray(SEED_EMPLOYEES) && SEED_EMPLOYEES.length > 0) {
      saveEmployees(SEED_EMPLOYEES);
      console.warn("[AddEmployee] employees was empty — restored seed employees.");
      return SEED_EMPLOYEES;
    }
  } catch (_) {}
  return [];
}

// ─── SuccessPopup ─────────────────────────────────────────────────────────────

const SuccessPopup = ({ employeeName, totalAssets, onClose }) => (
  <div className="ane-success-overlay" role="dialog" aria-modal="true" aria-labelledby="ane-success-title">
    <div className="ane-success-box">
      <div className="ane-success-icon-wrap" aria-hidden>✓</div>
      <h2 id="ane-success-title" className="ane-success-title">Employee Saved!</h2>
      <p className="ane-success-sub">
        <strong>{employeeName}</strong> has been added successfully.
      </p>
      <p className="ane-success-count">
        {totalAssets} asset{totalAssets !== 1 ? "s" : ""} assigned
      </p>
      <button type="button" className="ane-success-btn" onClick={onClose}>
        Go to Assets Dashboard →
      </button>
    </div>
  </div>
);

// ─── LookupGate ──────────────────────────────────────────────────────────────

const LookupGate = ({ onFound }) => {
  const navigate = useNavigate();

  const [query,         setQuery]         = useState("");
  const [loading,       setLoading]       = useState(false);
  const [results,       setResults]       = useState([]);
  const [notFound,      setNotFound]      = useState(false);
  const [alreadyExists, setAlreadyExists] = useState(null);
  const lastFetchedRef = useRef("");
  const searchInFlightRef = useRef(false);

  const clearMessages = useCallback(() => {
    setNotFound(false);
    setAlreadyExists(null);
  }, []);

  const hints = useMemo(() =>
    getEmployeesSafe()
      .filter((e) => !e.activated)
      .slice(0, 3)
      .map((e) => ({ label: `${e.id} — ${e.name}`, value: e.id, name: e.name })),
  [], []);

  const handleSelectEmployee = useCallback(
    (match) => {
      if (!match) return;
      if (match.activated && (match.assignedAssets || []).length > 0) {
        setAlreadyExists(match);
        setNotFound(false);
        return;
      }
      clearMessages();
      setResults([]);
      onFound(match);
    },
    [onFound, clearMessages],
  );

  const performSearch = useCallback(
    async (rawQuery) => {
      const trimmed = String(rawQuery || "").trim();
      if (!isLookupQueryReady(trimmed) || searchInFlightRef.current) return;

      searchInFlightRef.current = true;
      setLoading(true);
      setNotFound(false);
      setAlreadyExists(null);

      let matches = [];
      try {
        matches = await lookupEmployeeByEmpIdOrEmailAPI(trimmed);
      } catch (err) {
        console.warn("[AddEmployee] lookup API failed; falling back to local store", err);
      } finally {
        searchInFlightRef.current = false;
        setLoading(false);
      }

      if (!matches.length) {
        const employees = getEmployeesSafe();
        matches = employees.filter((emp) => localEmployeeMatches(emp, trimmed));
      }

      setResults(matches);
      setNotFound(matches.length === 0);
    },
    [],
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (!isLookupQueryReady(trimmed)) {
      setResults([]);
      setNotFound(false);
      setAlreadyExists(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      if (lastFetchedRef.current === trimmed) return;
      lastFetchedRef.current = trimmed;
      performSearch(trimmed);
    }, LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, performSearch]);

  const handleQueryChange = useCallback(
    (e) => {
      setQuery(e.target.value);
      clearMessages();
      lastFetchedRef.current = "";
    },
    [clearMessages],
  );

  const applyHint = useCallback(
    (value) => {
      setQuery(value);
      clearMessages();
      lastFetchedRef.current = "";
    },
    [clearMessages],
  );

  const hasError = notFound || !!alreadyExists;
  const queryReady = isLookupQueryReady(query);
  const showResults = queryReady && !alreadyExists && (loading || results.length > 0 || notFound);

  return (
    <div className="ane-lookup-wrap">
      <div className="ane-lookup-toolbar">
        <div
          className={`ane-lookup-input-wrap${hasError ? " ane-lookup-input-wrap--error" : ""}${loading ? " ane-lookup-input-wrap--loading" : ""}`}
        >
          <span className="ane-lookup-input-icon" aria-hidden>
            {loading ? "⏳" : "🔍"}
          </span>
          <input
            className="ane-lookup-input"
            type="search"
            placeholder="Search by name, employee ID, or email…"
            value={query}
            onChange={handleQueryChange}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-busy={loading}
            aria-invalid={hasError}
            aria-expanded={showResults}
            aria-controls="ane-lookup-results"
          />
          {loading && (
            <span className="ane-lookup-spinner" aria-label="Searching" />
          )}
          {query && !loading && (
            <button
              type="button"
              className="ane-lookup-clear"
              onClick={() => { setQuery(""); setResults([]); clearMessages(); lastFetchedRef.current = ""; }}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <p className="ane-lookup-helper">
          {loading
            ? "Searching employees…"
            : queryReady
              ? `${results.length} match${results.length === 1 ? "" : "es"} — select a profile to continue`
              : "Type at least 2 characters to search"}
        </p>
      </div>

      {showResults && (
        <div id="ane-lookup-results" className="ane-lookup-results" role="listbox" aria-label="Employee search results">
          {loading && results.length === 0 && (
            <div className="ane-lookup-results-skeleton">
              {[1, 2, 3].map((i) => (
                <div key={i} className="ane-lookup-skeleton-row" />
              ))}
            </div>
          )}
          {!loading && results.map((emp) => (
            <button
              key={emp.adminId || emp.id || emp.email}
              type="button"
              role="option"
              className="ane-lookup-result-card"
              onClick={() => handleSelectEmployee(emp)}
            >
              <div className="ane-lookup-result-avatar">
                {emp.photo || emp.photo_url ? (
                  <UserAvatar
                    user={emp}
                    photo={emp.photo}
                    photo_url={emp.photo_url}
                    name={emp.name || ""}
                    imgClassName="ane-lookup-result-avatar-img"
                  />
                ) : (
                  <span>{(emp.name || "?").charAt(0).toUpperCase()}</span>
                )}
              </div>
              <div className="ane-lookup-result-body">
                <strong className="ane-lookup-result-name">{emp.name || "—"}</strong>
                <span className="ane-lookup-result-meta">
                  <span className="ane-lookup-result-id">{emp.id || emp.empId}</span>
                  {emp.email ? ` · ${emp.email}` : ""}
                </span>
                {(emp.type || emp.circle) && (
                  <span className="ane-lookup-result-tags">
                    {emp.type && <em>{emp.type}</em>}
                    {emp.circle && <em>{emp.circle}</em>}
                  </span>
                )}
              </div>
              <span className="ane-lookup-result-cta">Select</span>
            </button>
          ))}
          {!loading && notFound && (
            <div className="ane-lookup-not-found ane-lookup-not-found--inline">
              <span>⚠️</span> No employee found for <strong>"{query}"</strong>
            </div>
          )}
        </div>
      )}

      {!queryReady && hints.length > 0 && (
        <div className="ane-lookup-hints">
          <span className="ane-lookup-hint-label">Suggestions</span>
          {hints.map((h) => (
            <button
              key={h.value}
              type="button"
              className="ane-lookup-hint-btn"
              onClick={() => applyHint(h.value)}
            >
              {h.label}
            </button>
          ))}
        </div>
      )}

      {alreadyExists && (
        <div className="ane-lookup-already-exists">
          <div className="ane-lookup-already-exists-icon">⚠️</div>
          <div className="ane-lookup-already-exists-content">
            <strong>Employee already has assets</strong>
            <p>
              <span className="ane-lookup-already-exists-id">{alreadyExists.id}</span>{" "}
              — <em>{alreadyExists.name}</em> already has{" "}
              {(alreadyExists.assignedAssets || []).length} asset(s) assigned.
            </p>
            <div className="ane-lookup-already-exists-actions">
              <button
                className="ane-lookup-btn-assign-more"
                onClick={() => { setAlreadyExists(null); onFound(alreadyExists); }}
              >
                Assign more assets
              </button>
              <button
                className="ane-lookup-btn-dashboard"
                onClick={() => navigate(-1)}
              >
                Back to assets
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── AddEmployee (main) ───────────────────────────────────────────────────────

const AddEmployee = () => {
  const navigate = useNavigate();
  const { requestRemark } = useTransitionRemark();

  const [step,                 setStep]                = useState(0);
  const [saving,               setSaving]              = useState(false);
  const [showSuccess,          setShowSuccess]          = useState(false);
  const [profileErrors,        setProfileErrors]        = useState({});
  const [assetValidationError, setAssetValidationError] = useState("");
  const [submitError,          setSubmitError]          = useState(""); // replaces alert()
  const [profileResolved,      setProfileResolved]      = useState(false);
  const [profile,              setProfile]              = useState(EMPTY_PROFILE);
  const [activeTab,            setActiveTab]            = useState("Hardware");
  const [hwType,               setHwType]               = useState("Laptop");
  const [hwTypes, setHwTypes] = useState(() =>
    getHwTypesForCategory("IT Assets"),
  );
  useEffect(() => {
    const refresh = () => setHwTypes(getHwTypesForCategory("IT Assets"));
    refresh();
    return subscribeHwTypesChange(refresh);
  }, []);
  const hwTableFields = useMemo(() => {
    const base = getHardwareFields("IT Assets", "Hardware", hwType);
    return isMobileTabletHwType(hwType) ? getMobileTabletHardwareFields(base) : base;
  }, [hwType]);
  const [selectedHwUnits,      setSelectedHwUnits]      = useState({});
  const [selectedSw,           setSelectedSw]           = useState([]); // { name, quantity }
  const [selectedNonHw,        setSelectedNonHw]        = useState([]);
  const qtyHoldTimeoutRef = useRef(null);
  const qtyHoldIntervalRef = useRef(null);
  const [unitsRefreshKey, setUnitsRefreshKey] = useState(0);

  const refreshAssignableUnits = useCallback(() => {
    syncITDataFromAPI({ maxAgeMs: IT_NAV_SYNC_MAX_AGE_MS })
      .then(() => setUnitsRefreshKey((k) => k + 1))
      .catch((err) => {
        console.error("[AddEmployee] API sync failed, using cached units:", err);
        toastITApiFailure(
            err,
            "Could not refresh assignable assets from the server. Showing cached inventory.",
          );
        setUnitsRefreshKey((k) => k + 1);
      });
  }, []);

  useRefreshOnNavigate(refreshAssignableUnits);

  // Stable reference to asset units — re-read when sync completes or storage changes.
  const allUnits = useMemo(() => getAssetUnitsFromStorage(), [unitsRefreshKey]); // eslint-disable-line

  // ── Derived data ──────────────────────────────────────────────────────────

  const availableHwUnits = useMemo(
    () =>
      allUnits.filter(
        (u) =>
          u.category === "Hardware" &&
          u.status   === "available" &&
          (u.hwType  || "").toLowerCase() === hwType.toLowerCase(),
      ),
    [hwType, allUnits], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const nonHwGroups = useMemo(
    () =>
      getInventoryFromStorage()
        .filter(
          (i) =>
            (i.category === "Accessories" || i.category === "Consumables") &&
            (i.availableQuantity || 0) > 0,
        )
        .map((i) => ({
          assetName:   i.name,
          category:    i.category,
          inventoryId: i.id,
          units:       Array(i.availableQuantity).fill({ assetId: i.id, inventoryId: i.id }),
        })),
    [allUnits], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const availableSwGroups = useMemo(() => {
    const byName = {};
    getSoftwareInventory()
      .filter((i) => i.status === "available")
      .forEach((item) => {
        if (!byName[item.name]) byName[item.name] = { name: item.name, licenses: [] };
        byName[item.name].licenses.push(item);
      });
    return Object.values(byName);
  }, [allUnits]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Selection counts ──────────────────────────────────────────────────────

  const hwCount     = Object.keys(selectedHwUnits).length;
  const swCount     = selectedSw.reduce((sum, a) => sum + (Number(a.quantity) || 0), 0);
  const nonHwCount  = selectedNonHw.reduce((sum, a) => sum + (Number(a.quantity) || 0), 0);
  const totalAssets = hwCount + swCount + nonHwCount;
  const accCount    = selectedNonHw
    .filter((a) => a.category === "Accessories")
    .reduce((sum, a) => sum + (Number(a.quantity) || 0), 0);
  const consCount   = selectedNonHw
    .filter((a) => a.category === "Consumables")
    .reduce((sum, a) => sum + (Number(a.quantity) || 0), 0);

  // ── Duplicate tag detection ───────────────────────────────────────────────

  const selectedUnitIds = useMemo(
    () => new Set(Object.keys(selectedHwUnits)),
    [selectedHwUnits],
  );

  const usedTagsInForm = useMemo(
    () => Object.values(selectedHwUnits).map((s) => s.assetTag.trim()).filter(Boolean),
    [selectedHwUnits],
  );

  const isTagDuplicate = useCallback(
    (tag, unitAssetId) => {
      if (!tag.trim() || tag.trim() === unitAssetId) return false;
      const otherIds = new Set(
        allUnits.filter((u) => !selectedUnitIds.has(u.assetId)).map((u) => u.assetId),
      );
      if (otherIds.has(tag.trim())) return true;
      return usedTagsInForm.filter((t) => t === tag.trim()).length > 1;
    },
    [allUnits, selectedUnitIds, usedTagsInForm],
  );

  // ── Profile handlers ──────────────────────────────────────────────────────

  const handleLookupFound = useCallback((emp) => {
    const photo = emp.photo || "";
    setProfile({
      employeeId: emp.id || emp.empId || "",
      name:       emp.name   || "",
      type:       emp.type   || "",
      circle:     emp.circle || "",
      email:      emp.email  || "",
      photoUrl:   photo && !photo.startsWith("data:") ? photo : "",
      photoFile:  photo &&  photo.startsWith("data:") ? photo : null,
    });
    setProfileErrors({});
    setProfileResolved(true);
    setStep(1);
  }, []);

  const handleLookupReset = useCallback(() => {
    setProfileResolved(false);
    setProfile(EMPTY_PROFILE);
    setProfileErrors({});
  }, []);

  const validateProfile = useCallback(() => {
    const e = {};
    if (!profile.employeeId.trim()) e.employeeId = "Employee ID is required";
    if (!profile.name.trim())       e.name       = "Name is required";
    if (!profile.email.trim())      e.email      = "Email is required";
    else if (!/\S+@\S+\.\S+/.test(profile.email)) e.email = "Invalid email";
    setProfileErrors(e);
    return Object.keys(e).length === 0;
  }, [profile]);

  // ── Asset selection handlers ───────────────────────────────────────────────

  const toggleHwUnit = useCallback((unit) => {
    setAssetValidationError("");
    setSelectedHwUnits((prev) => {
      const next = { ...prev };
      if (next[unit.assetId]) delete next[unit.assetId];
      else next[unit.assetId] = { unit, assetTag: unit.assetId || "" };
      return next;
    });
  }, []);

  const setAssetTag = useCallback(
    (assetId, tag) =>
      setSelectedHwUnits((prev) => ({
        ...prev,
        [assetId]: { ...prev[assetId], assetTag: tag },
      })),
    [],
  );

  const setAssignmentPhoto = useCallback(
    (assetId, photos) =>
      setSelectedHwUnits((prev) => ({
        ...prev,
        [assetId]: { ...prev[assetId], assignmentPhotos: photos },
      })),
    [],
  );

  const toggleSw = useCallback((name) => {
    setAssetValidationError("");
    setSelectedSw((prev) => {
      const exists = prev.find((a) => a.name === name);
      if (exists) return prev.filter((a) => a.name !== name);
      return [...prev, { name, quantity: 1 }];
    });
  }, []);

  const adjustSwQuantity = useCallback((name, delta, maxAllowed) => {
    setSelectedSw((prev) =>
      prev.map((a) => {
        if (a.name !== name) return a;
        const current = Math.max(1, Number(a.quantity) || 1);
        const nextQty = Math.max(1, Math.min(maxAllowed, current + delta));
        return { ...a, quantity: nextQty };
      }),
    );
  }, []);

  const toggleNonHw = useCallback(
    (assetName, category) => {
      setAssetValidationError("");
      const key = `${assetName}||${category}`;
      setSelectedNonHw((prev) => {
        const exists = prev.find((a) => `${a.assetName}||${a.category}` === key);
        if (exists) return prev.filter((a) => `${a.assetName}||${a.category}` !== key);
        const group = nonHwGroups.find((g) => `${g.assetName}||${g.category}` === key);
        if (!group?.units.length) return prev;
        return [
          ...prev,
          {
            assetId: group.inventoryId,
            assetName,
            category,
            inventoryId: group.inventoryId,
            quantity: 1,
          },
        ];
      });
    },
    [nonHwGroups],
  );

  const setNonHwQuantity = useCallback((assetName, category, quantity, maxAllowed) => {
    const key = `${assetName}||${category}`;
    const nextQty = Math.max(1, Math.min(maxAllowed, Number(quantity) || 1));
    setSelectedNonHw((prev) =>
      prev.map((a) =>
        `${a.assetName}||${a.category}` === key
          ? { ...a, quantity: nextQty }
          : a,
      ),
    );
  }, []);

  const adjustNonHwQuantity = useCallback((assetName, category, delta, maxAllowed) => {
    const key = `${assetName}||${category}`;
    setSelectedNonHw((prev) =>
      prev.map((a) => {
        if (`${a.assetName}||${a.category}` !== key) return a;
        const current = Math.max(1, Number(a.quantity) || 1);
        const nextQty = Math.max(1, Math.min(maxAllowed, current + delta));
        return { ...a, quantity: nextQty };
      }),
    );
  }, []);

  const stopQtyHold = useCallback(() => {
    if (qtyHoldTimeoutRef.current) {
      clearTimeout(qtyHoldTimeoutRef.current);
      qtyHoldTimeoutRef.current = null;
    }
    if (qtyHoldIntervalRef.current) {
      clearInterval(qtyHoldIntervalRef.current);
      qtyHoldIntervalRef.current = null;
    }
  }, []);

  const startQtyHold = useCallback((assetName, category, delta, maxAllowed) => {
    stopQtyHold();
    qtyHoldTimeoutRef.current = setTimeout(() => {
      qtyHoldIntervalRef.current = setInterval(() => {
        adjustNonHwQuantity(assetName, category, delta, maxAllowed);
      }, 90);
    }, 320);
  }, [adjustNonHwQuantity, stopQtyHold]);

  const startSwQtyHold = useCallback((name, delta, maxAllowed) => {
    stopQtyHold();
    qtyHoldTimeoutRef.current = setTimeout(() => {
      qtyHoldIntervalRef.current = setInterval(() => {
        adjustSwQuantity(name, delta, maxAllowed);
      }, 90);
    }, 320);
  }, [adjustSwQuantity, stopQtyHold]);

  React.useEffect(() => () => stopQtyHold(), [stopQtyHold]);

  // ── Navigation ────────────────────────────────────────────────────────────

  const goNext = useCallback(() => {
    setSubmitError("");
    if (step === 0 && !profileResolved) return;
    if (step === 0 && !validateProfile()) return;
    if (step === 1 && totalAssets === 0) {
      setAssetValidationError("Please assign at least one asset before continuing.");
      return;
    }
    setAssetValidationError("");
    setStep((s) => Math.min(s + 1, 2));
  }, [step, profileResolved, validateProfile, totalAssets]);

  const goBack = useCallback(() => {
    if (step === 1) {
      handleLookupReset();
    }
    setStep((s) => Math.max(s - 1, 0));
  }, [step, handleLookupReset]);

  // ── Submit ─────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    setSubmitError("");
    const empId   = profile.employeeId.trim();
    const empName = profile.name.trim();

    // Guard: profile completeness
    if (!empId || !empName || !profile.email.trim()) {
      setSubmitError("Some required profile fields are missing. Please go back to Step 1.");
      setStep(0);
      return;
    }

    // Guard: all selected HW units have an asset tag
    if (Object.values(selectedHwUnits).some((s) => !s?.assetTag?.trim())) {
      setSubmitError("Asset ID is missing for one or more hardware units.");
      setStep(1);
      return;
    }

    // Guard: duplicate tag detection
    const selectedEntries = Object.values(selectedHwUnits);
    const ownIds   = new Set(selectedEntries.map((s) => s.unit.assetId));
    const otherIds = new Set(
      getAssetUnitsFromStorage()
        .filter((u) => !ownIds.has(u.assetId))
        .map((u) => u.assetId),
    );
    const seenTags = new Set();
    let dupTag     = null;

    for (const { unit, assetTag } of selectedEntries) {
      const tag = assetTag.trim();
      if ((tag !== unit.assetId && otherIds.has(tag)) || seenTags.has(tag)) {
        dupTag = tag;
        break;
      }
      seenTags.add(tag);
    }

    if (dupTag) {
      setSubmitError(`Asset ID "${dupTag}" is already in use. Each unit must have a unique ID.`);
      setStep(1);
      return;
    }

    try {
      setSaving(true);

      const remarkResult = await requestRemark("CHECKOUT", {
        title: "Assign assets",
        assetLabel: profile.name || empId,
        subtitle: `${selectedEntries.length} hardware unit(s) will be assigned`,
      });
      if (remarkResult === null) {
        setSaving(false);
        return;
      }
      const fields = remarkPayload(remarkResult);

      // 1. Persist hardware assignment to backend first.
      for (const { unit, assetTag, assignmentPhotos } of selectedEntries) {
        await assignUnitToEmployeeAPI({
          unitId: unit.id || unit.assetId,
          empId,
          assetTag: assetTag.trim(),
          assignmentPhotos: assignmentPhotos || [],
          ...fields,
        });
      }

      // Keep local shape in sync for screens that still read local employee data.
      saveAssetUnitsToStorage(
        getAssetUnitsFromStorage().map((u) => {
          const sel = selectedEntries.find((s) => s.unit.assetId === u.assetId);
          if (!sel) return u;
          return {
            ...u,
            status: "assigned",
            assignedTo: { empId, name: empName },
            assignedDate: new Date().toISOString(),
            assetTag: sel.assetTag.trim(),
            assignmentPhotos: sel.assignmentPhotos || [],
          };
        }),
      );

      // 2. Sync Accessories / Consumables inventory counts
      if (selectedNonHw.length) {
        const changes = {};
        selectedNonHw.forEach(({ assetName, category, inventoryId, quantity }) => {
          const key = inventoryId || `${assetName}||${category}`;
          if (!changes[key]) changes[key] = { inventoryId, assetName, category, count: 0 };
          changes[key].count += Math.max(1, Number(quantity) || 1);
        });
        for (const change of Object.values(changes)) {
          const targetInventoryId = change.inventoryId;
          if (!targetInventoryId) {
            throw new Error(`Missing inventory id for ${change.assetName}`);
          }
          await assignInventoryQuantityAPI({
            inventoryItemId: targetInventoryId,
            quantity: change.count,
            action: "assign",
            empId,
          });
        }
      }

      // 3. Mark software licenses as assigned (API + local mirror)
      const assignedSwLicenses = [];
      if (selectedSw.length) {
        const swInv   = getSoftwareInventory();
        const usedIds = new Set();

        for (const { name, quantity } of selectedSw) {
          const qty = Math.max(1, Number(quantity) || 1);
          for (let i = 0; i < qty; i += 1) {
            const license = swInv.find(
              (item) =>
                item.name === name &&
                item.status === "available" &&
                !usedIds.has(item.id),
            );
            if (!license) break;
            await assignSoftwareToEmployeeAPI({ licenseId: license.id, empId });
            license.status     = "assigned";
            license.assignedTo = empId;
            usedIds.add(license.id);
            assignedSwLicenses.push({ name, license });
          }
        }
        saveSoftwareInventory(swInv);

        const swCatalog = getInventoryFromStorage();
        const swQtyByName = {};
        assignedSwLicenses.forEach(({ name }) => {
          swQtyByName[name] = (swQtyByName[name] || 0) + 1;
        });
        Object.entries(swQtyByName).forEach(([name, count]) => {
          const idx = swCatalog.findIndex(
            (i) =>
              (i.category || "").toLowerCase() === "software" &&
              (i.name     || "").trim().toLowerCase() === name.trim().toLowerCase(),
          );
          if (idx !== -1) {
            swCatalog[idx] = {
              ...swCatalog[idx],
              availableQuantity: Math.max(
                0,
                (Number(swCatalog[idx].availableQuantity) || 0) - count,
              ),
              assignedQuantity: (Number(swCatalog[idx].assignedQuantity) || 0) + count,
            };
          }
        });
        saveInventoryToStorage(swCatalog);
      }

      await syncITDataFromAPI();

      // 4. Build assignedAssets array for the employee record
      const assignedAssets = [
        ...selectedEntries.map(({ unit, assetTag, assignmentPhotos }) => ({
          id:           unit.assetId,
          assetId:      unit.assetId,
          assetTag:     assetTag.trim(),
          name:         unit.assetName,
          category:     "Hardware",
          hwType:       unit.hwType,
          status:       "Assigned",
          brand:        unit.brand        || "",
          make:         unit.make         || "",
          model:        unit.model        || "",
          serialNumber: unit.serialNumber || "",
          imei1:        unit.imei1        || null,
          imei2:        unit.imei2        || null,
          photos:       assignmentPhotos  || [],
          assignedDate: new Date().toISOString(),
        })),

        ...assignedSwLicenses.map(({ name, license }) => ({
          id:                generateAssetId(),
          licenseId:         license?.id || null,
          assetId:           null,
          assetTag:          null,
          name,
          category:          "Software",
          status:            "Assigned",
          subscriptionStart: license?.subscriptionStart || null,
          subscriptionEnd:   license?.subscriptionEnd   || null,
          usageStatus:       "Active",
          photos:            [],
          assignedDate:      new Date().toISOString(),
        })),

        ...selectedNonHw.map(({ assetName, category, inventoryId, quantity }) => ({
          id:          generateAssetId(),
          assetId:     null,
          assetTag:    null,
          inventoryId: inventoryId || null,
          name:        assetName,
          category,
          quantity:    Math.max(1, Number(quantity) || 1),
          status:      "Assigned",
          photos:      [],
          assignedDate: new Date().toISOString(),
        })),
      ];

      // 5. Update employee record
      const currentEmployees = getEmployeesSafe();
      saveEmployees(
        currentEmployees.map((emp) => {
          if ((emp.id || emp.empId || "").toUpperCase() !== empId.toUpperCase()) return emp;
          return {
            ...emp,
            activated:      true,
            assignedAssets: [...(emp.assignedAssets || []), ...assignedAssets],
          };
        }),
      );

      // 6. Notify all listening dashboards
      try { window.dispatchEvent(new Event("inventory-updated")); } catch (_) {}

      setShowSuccess(true);
    } catch (err) {
      setSaving(false);
      console.error("[AddEmployee] handleSubmit error:", err);
      const msg = toastITApiFailure(
        err,
        "Could not save this employee on the server. Please try again.",
      );
      setSubmitError(`Failed to save employee: ${msg}`);
    }
  }, [profile, selectedHwUnits, selectedNonHw, selectedSw]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="ane-page">
      <div className="ane-page-inner">
        {submitError && (
          <div className="ane-submit-error" role="alert">
            {submitError}
          </div>
        )}

        {/* ── STEP 0: Profile ── */}
        {step === 0 && (
          <section className="ane-card ane-card--profile">
            <div className="ane-card-head">
              <button type="button" className="ane-change-emp-btn ane-card-back-btn" onClick={() => navigate(-1)}>
                ← Back
              </button>
              <div className="ane-card-head-text">
                <p className="ane-kicker">IT · Asset assignment</p>
                <h2>Select employee</h2>
                <p>Find the employee, then assign hardware, accessories, or consumables.</p>
              </div>
            </div>
            <LookupGate onFound={handleLookupFound} />
          </section>
        )}

        {/* ── STEP 1: Assign Assets ── */}
        {step === 1 && (
          <div className="ane-card">
            <div className="ane-card-head">
              <div className="ane-card-head-text">
                <p className="ane-kicker">Step 2 of 3</p>
                <h2>Assign assets</h2>
                <p>Choose assets for <strong>{profile.name}</strong></p>
              </div>
            </div>

            {/* Category tabs */}
            <div className="ane-cat-tabs">
              {ASSIGN_CATS.map((cat) => {
                const count =
                  cat === "Hardware"
                    ? hwCount
                    : cat === "Software"
                      ? swCount
                      : selectedNonHw
                          .filter((a) => a.category === cat)
                          .reduce((sum, a) => sum + (Number(a.quantity) || 0), 0);
                return (
                  <button
                    key={cat}
                    className={`ane-cat-tab${activeTab === cat ? " active" : ""}`}
                    onClick={() => setActiveTab(cat)}
                  >
                    <span className="ane-tab-icon">{TAB_ICONS[cat]}</span>
                    {cat}
                    {count > 0 && <span className="ane-tab-badge">{count}</span>}
                  </button>
                );
              })}
            </div>

            {/* Hardware tab */}
            {activeTab === "Hardware" && (
              <div className="ane-hw-panel">
                <div className="ane-hw-type-row">
                  <span className="ane-hw-type-label">Hardware Type:</span>
                  <div className="ane-hw-type-chips">
                    {hwTypes.map((t) => (
                      <button
                        key={t}
                        className={`ane-hw-chip${hwType === t ? " active" : ""}`}
                        onClick={() => setHwType(t)}
                      >
                        {HW_TYPE_ICONS[t] || "🔧"} {t}
                      </button>
                    ))}
                  </div>
                </div>

                {availableHwUnits.length === 0 ? (
                  <div className="ane-hw-empty">
                    <div className="ane-hw-empty-icon">📭</div>
                    <p>No available <strong>{hwType}</strong> units in inventory.</p>
                    <span className="ane-hint">Add more {hwType}s via Inventory → Add Assets</span>
                  </div>
                ) : (
                  <div className="ane-hw-table-wrap">
                    <div className="ane-hw-table-info">
                      Showing <strong>{availableHwUnits.length}</strong> available {hwType}(s).
                    </div>
                    <table className="ane-hw-table">
                      <thead>
                        <tr>
                          <th className="ane-hw-th-check">Select</th>
                          <th>Brand</th>
                          <th>{hwTableFields.make.label}</th>
                          {!isMobileTabletHwType(hwType) && <th>{hwTableFields.model.label}</th>}
                          {isMobileTabletHwType(hwType) && <th>{hwTableFields.projectCode.label}</th>}
                          <th>Serial Number</th>
                          {isMobileTabletHwType(hwType) && <th>IMEI 1</th>}
                          {isMobileTabletHwType(hwType) && <th>IMEI 2</th>}
                          <th>Asset ID</th><th>Photo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {availableHwUnits.map((unit) => {
                          const isSelected     = !!selectedHwUnits[unit.assetId];
                          const tagVal         = selectedHwUnits[unit.assetId]?.assetTag ?? "";
                          const isDuplicate    = isSelected && isTagDuplicate(tagVal, unit.assetId);
                          const assignedPhotos = selectedHwUnits[unit.assetId]?.assignmentPhotos || [];

                          return (
                            <tr
                              key={unit.assetId}
                              className={`ane-hw-row${isSelected ? " selected" : ""}`}
                            >
                              <td>
                                <input
                                  type="checkbox"
                                  className="ane-hw-checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleHwUnit(unit)}
                                />
                              </td>
                              <td><span className="ane-hw-val">{unit.brand || "—"}</span></td>
                              <td><span className="ane-hw-val">{unit.make || unit.model || "—"}</span></td>
                              {!isMobileTabletHwType(hwType) && (
                                <td><span className="ane-hw-val">{unit.model || "—"}</span></td>
                              )}
                              {isMobileTabletHwType(hwType) && (
                                <td><span className="ane-hw-val">{unit.projectCode || "—"}</span></td>
                              )}
                              <td><span className="ane-hw-mono">{unit.serialNumber || unit.assetId}</span></td>
                              {isMobileTabletHwType(hwType) && (
                                <>
                                  <td><span className="ane-hw-mono">{unit.imei1 || "—"}</span></td>
                                  <td><span className="ane-hw-mono">{unit.imei2 || "—"}</span></td>
                                </>
                              )}
                              <td>
                                {isSelected ? (
                                  <div className="ane-tag-cell">
                                    <input
                                      type="text"
                                      className={`ane-tag-input${isDuplicate ? " err" : tagVal ? " ok" : ""}`}
                                      value={tagVal}
                                      onChange={(e) => setAssetTag(unit.assetId, e.target.value)}
                                    />
                                    {isDuplicate && <span className="ane-tag-err">Already in use</span>}
                                    {!isDuplicate && tagVal && <span className="ane-tag-ok">✓</span>}
                                  </div>
                                ) : (
                                  <span className="ane-hw-mono ane-hw-mono--muted">{unit.assetId}</span>
                                )}
                              </td>
                              <td>
                                {isSelected ? (
                                  <label className="ane-photo-upload-btn" title="Upload assignment photo">
                                    <input
                                      type="file"
                                      accept="image/*"
                                      multiple
                                      style={{ display: "none" }}
                                      onChange={async (e) => {
                                        const files = Array.from(e.target.files);
                                        if (!files.length) return;
                                        const compressed = await Promise.all(files.map(compressImage));
                                        setAssignmentPhoto(unit.assetId, [...assignedPhotos, ...compressed]);
                                      }}
                                    />
                                    {assignedPhotos.length > 0 ? `📷 (${assignedPhotos.length})` : "📷 Add"}
                                  </label>
                                ) : (
                                  <span className="ane-hw-mono ane-hw-mono--muted">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    {hwCount > 0 && (
                      <div className="ane-hw-selected-summary">
                        {hwCount} {hwType}(s) selected
                        {Object.values(selectedHwUnits).some((s) => !s.assetTag.trim()) && (
                          <span className="ane-hw-warn"> — Some units are missing an Asset ID</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Software tab */}
            {activeTab === "Software" && (
              <div className="ane-checklist">
                {availableSwGroups.length === 0 ? (
                  <div className="ane-checklist-empty">
                    No software licenses available. Add licenses via Inventory → Add Assets.
                  </div>
                ) : (
                  availableSwGroups.map(({ name, licenses }) => {
                    const selectedEntry = selectedSw.find((a) => a.name === name);
                    const isChecked = !!selectedEntry;
                    const qty = Math.max(1, Number(selectedEntry?.quantity) || 1);
                    const maxQty = licenses.length;
                    return (
                      <label
                        key={name}
                        className={`ane-check-item${isChecked ? " checked" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSw(name)}
                        />
                        <span className="ane-check-icon">💿</span>
                        <span className="ane-check-name">{name}</span>
                        <span className="ane-stock-tag in-stock">{maxQty} available</span>
                        {isChecked && (
                          <div
                            className="ane-qty-stepper"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="ane-qty-btn"
                              disabled={qty <= 1}
                              onClick={(e) => {
                                e.preventDefault();
                                adjustSwQuantity(name, -1, maxQty);
                              }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                startSwQtyHold(name, -1, maxQty);
                              }}
                              onMouseUp={stopQtyHold}
                              onMouseLeave={stopQtyHold}
                              onTouchStart={(e) => {
                                e.preventDefault();
                                startSwQtyHold(name, -1, maxQty);
                              }}
                              onTouchEnd={stopQtyHold}
                              onTouchCancel={stopQtyHold}
                            >
                              −
                            </button>
                            <span className="ane-qty-value">{qty}</span>
                            <button
                              type="button"
                              className="ane-qty-btn"
                              disabled={qty >= maxQty}
                              onClick={(e) => {
                                e.preventDefault();
                                adjustSwQuantity(name, 1, maxQty);
                              }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                startSwQtyHold(name, 1, maxQty);
                              }}
                              onMouseUp={stopQtyHold}
                              onMouseLeave={stopQtyHold}
                              onTouchStart={(e) => {
                                e.preventDefault();
                                startSwQtyHold(name, 1, maxQty);
                              }}
                              onTouchEnd={stopQtyHold}
                              onTouchCancel={stopQtyHold}
                            >
                              +
                            </button>
                          </div>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
            )}

            {/* Accessories / Consumables tab */}
            {(activeTab === "Accessories" || activeTab === "Consumables") && (
              <div className="ane-checklist">
                {nonHwGroups.filter((g) => g.category === activeTab).length === 0 ? (
                  <div className="ane-checklist-empty">
                    No available {activeTab} in inventory.
                  </div>
                ) : (
                  nonHwGroups
                    .filter((g) => g.category === activeTab)
                    .map((g) => {
                      const key     = `${g.assetName}||${g.category}`;
                      const selectedEntry = selectedNonHw.find(
                        (a) => `${a.assetName}||${a.category}` === key,
                      );
                      const isChecked = !!selectedEntry;
                      const qty = Math.max(1, Number(selectedEntry?.quantity) || 1);
                      const maxQty = g.units.length;
                      return (
                        <label
                          key={key}
                          className={`ane-check-item${isChecked ? " checked" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleNonHw(g.assetName, g.category)}
                          />
                          <span className="ane-check-icon">
                            {activeTab === "Accessories" ? "🖱️" : "📦"}
                          </span>
                          <span className="ane-check-name">{g.assetName}</span>
                          <span className="ane-stock-tag in-stock">{g.units.length} available</span>
                          {isChecked && (
                            <div
                              className="ane-qty-stepper"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="ane-qty-btn"
                                disabled={qty <= 1}
                                onClick={(e) => {
                                  e.preventDefault();
                                  adjustNonHwQuantity(g.assetName, g.category, -1, maxQty);
                                }}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  startQtyHold(g.assetName, g.category, -1, maxQty);
                                }}
                                onMouseUp={stopQtyHold}
                                onMouseLeave={stopQtyHold}
                                onTouchStart={(e) => {
                                  e.preventDefault();
                                  startQtyHold(g.assetName, g.category, -1, maxQty);
                                }}
                                onTouchEnd={stopQtyHold}
                                onTouchCancel={stopQtyHold}
                              >
                                −
                              </button>
                              <span className="ane-qty-value">{qty}</span>
                              <button
                                type="button"
                                className="ane-qty-btn"
                                disabled={qty >= maxQty}
                                onClick={(e) => {
                                  e.preventDefault();
                                  adjustNonHwQuantity(g.assetName, g.category, 1, maxQty);
                                }}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  startQtyHold(g.assetName, g.category, 1, maxQty);
                                }}
                                onMouseUp={stopQtyHold}
                                onMouseLeave={stopQtyHold}
                                onTouchStart={(e) => {
                                  e.preventDefault();
                                  startQtyHold(g.assetName, g.category, 1, maxQty);
                                }}
                                onTouchEnd={stopQtyHold}
                                onTouchCancel={stopQtyHold}
                              >
                                +
                              </button>
                            </div>
                          )}
                        </label>
                      );
                    })
                )}
              </div>
            )}

            {/* Selection summary bar */}
            {totalAssets > 0 && (
              <div className="ane-selection-bar">
                <span className="ane-selection-title">Selected:</span>
                {hwCount   > 0 && <span className="ane-sel-chip hardware">{hwCount} Hardware</span>}
                {swCount   > 0 && <span className="ane-sel-chip software">{swCount} Software</span>}
                {accCount  > 0 && <span className="ane-sel-chip accessories">{accCount} Accessories</span>}
                {consCount > 0 && <span className="ane-sel-chip consumables">{consCount} Consumables</span>}
                <span className="ane-sel-total">Total: {totalAssets}</span>
              </div>
            )}

            {assetValidationError && (
              <div className="ane-asset-validation-error">
                <span className="ane-asset-validation-error-icon">⚠️</span>
                <span>{assetValidationError}</span>
              </div>
            )}
          </div>
        )}

        {/* ── STEP 2: Review ── */}
        {step === 2 && (
          <div className="ane-card">
            <div className="ane-card-head">
              <div className="ane-card-head-text">
                <p className="ane-kicker">Step 3 of 3</p>
                <h2>Review &amp; confirm</h2>
                <p>Double-check the employee and selected assets before saving</p>
              </div>
            </div>

            <div className="ane-review-body">
            {totalAssets > 0 ? (
              <div className="ane-review-section">
                <h3 className="ane-review-section-title">
                  Assets to Assign <span className="ane-review-count">{totalAssets}</span>
                </h3>

                {hwCount > 0 && (
                  <div className="ane-review-asset-group">
                    <div className="ane-review-group-label">
                      <span className="ane-rdot hardware" /> Hardware ({hwCount})
                    </div>
                    <div className="ane-review-table-wrap">
                      <table className="ane-review-table">
                        <thead>
                          <tr>
                            <th>Asset Name</th>
                            <th>Brand / Model</th>
                            <th>Serial Number</th>
                            <th>Asset ID</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.values(selectedHwUnits).map(({ unit, assetTag }) => (
                            <tr key={unit.assetId}>
                              <td data-label="Asset Name"><strong>{unit.assetName}</strong></td>
                              <td data-label="Brand / Model">{unit.brand} {unit.model}</td>
                              <td data-label="Serial Number">
                                <span className="ane-review-mono">{unit.serialNumber || unit.assetId}</span>
                              </td>
                              <td data-label="Asset ID">
                                {assetTag
                                  ? <span className="ane-review-tag">{assetTag}</span>
                                  : <span className="ane-review-missing">Missing!</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {swCount > 0 && (
                  <div className="ane-review-asset-group">
                    <div className="ane-review-group-label">
                      <span className="ane-rdot software" /> Software ({swCount})
                    </div>
                    <div className="ane-review-pill-list">
                      {selectedSw.map(({ name, quantity }) => (
                        <span key={name} className="ane-review-pill">
                          {name}
                          <span className="ane-review-pill-cat">
                            x{Math.max(1, Number(quantity) || 1)}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {nonHwCount > 0 && (
                  <div className="ane-review-asset-group">
                    <div className="ane-review-group-label">
                      <span className="ane-rdot other" /> Accessories &amp; Consumables ({nonHwCount})
                    </div>
                    <div className="ane-review-pill-list">
                      {selectedNonHw.map((a) => (
                        <span key={a.assetId} className="ane-review-pill">
                          {a.assetName}
                          <span className="ane-review-pill-cat">x{Math.max(1, Number(a.quantity) || 1)}</span>
                          <span className="ane-review-pill-cat">{a.category}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="ane-review-no-assets">
                <span>ℹ</span> No assets selected — employee will be created with no assigned assets.
              </div>
            )}
            </div>
          </div>
        )}

        {/* Footer — assign & review only */}
        {step > 0 && (
          <div className="ane-footer">
            <div className="ane-footer-left">
              {step > 0 && (
                <button className="ane-btn-back" onClick={goBack}>← Back</button>
              )}
            </div>
            <div className="ane-footer-right">
              {step < 2 ? (
                <button className="ane-btn-next" onClick={goNext}>Next →</button>
              ) : (
                <button
                  className="ane-btn-submit"
                  onClick={handleSubmit}
                  disabled={saving}
                  aria-busy={saving}
                >
                  {saving ? "⏳ Saving…" : "✅ Save Employee"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Success popup */}
      {showSuccess && (
        <SuccessPopup
          employeeName={profile.name.trim()}
          totalAssets={totalAssets}
          onClose={() => navigate(-1)}
        />
      )}
    </div>
  );
};

export default AddEmployee;


