/** Shared inventory top-level categories (tabs) and add-assets configuration. */

export const INV_CATEGORIES = [
  "IT Assets",
  "Office Assets",
  "Transport Assets",
  "Infrastructure Assets",
];

export const ASSET_TYPE_TABS = [
  { label: "IT Assets", key: "it", inventoryCategory: "IT Assets" },
  { label: "Office Assets", key: "office", inventoryCategory: "Office Assets" },
  { label: "Transport Assets", key: "transport", inventoryCategory: "Transport Assets" },
  {
    label: "Infrastructure Assets",
    key: "infrastructure",
    inventoryCategory: "Infrastructure Assets",
  },
];

const KEY_BY_CATEGORY = Object.fromEntries(
  ASSET_TYPE_TABS.map((t) => [t.inventoryCategory, t.key]),
);

const CATEGORY_BY_KEY = Object.fromEntries(
  ASSET_TYPE_TABS.map((t) => [t.key, t.inventoryCategory]),
);

export const INVENTORY_CATEGORY_CONFIG = {
  "IT Assets": {
    hwTypes: ["Laptop", "Mobile", "Desktop", "Tablet", "Dashcam", "ODCP"],
    accessoryTypes: ["Mouse", "Keyboard", "Headset", "Monitor", "Charger", "Cable"],
    consumableTypes: ["Pen Drive", "Battery", "Toner", "SIM Card", "Cleaning Kit"],
    mobileTabletHwTypes: ["Mobile", "Tablet"],
    mobileHwType: "Mobile",
    itemCategories: ["Hardware", "Accessories", "Consumables"],
  },
  "Office Assets": {
    stockMode: true,
    hwTypes: ["Furniture", "Electronics", "Appliances", "Safety Equipment"],
    accessoryTypes: ["Stationery", "Decor", "Kitchen"],
    consumableTypes: ["Paper", "Ink", "Cleaning", "Pantry"],
    mobileHwType: null,
    itemCategories: ["Hardware", "Accessories", "Consumables"],
  },
  "Transport Assets": {
    vehicleMode: true,
    hwTypes: ["Car", "Bike", "Scooter", "Van", "Truck", "Bus"],
    mobileHwType: null,
    hardwareFields: {
      brand: { label: "Fleet / Owner", placeholder: "e.g. Company Fleet" },
      make: { label: "Make", placeholder: "e.g. Toyota, Honda" },
      model: { label: "Model", placeholder: "e.g. Innova Crysta" },
      serialNumber: { label: "Registration No.", placeholder: "e.g. MH12AB1234" },
    },
  },
  "Infrastructure Assets": {
    stockMode: true,
    equipmentMode: true,
    equipmentTypes: ["Networking", "Power", "Cooling", "Security"],
    hwTypes: ["Networking", "Power", "Cooling", "Security"],
    accessoryTypes: ["Mount", "Cable", "Bracket"],
    consumableTypes: ["Cable Tie", "Label", "Fuse", "Tape"],
    mobileHwType: null,
    itemCategories: ["Hardware", "Accessories", "Consumables"],
  },
};

export function inventoryCategoryToKey(inventoryCategory) {
  return KEY_BY_CATEGORY[inventoryCategory] || "it";
}

export function keyToInventoryCategory(key) {
  return CATEGORY_BY_KEY[key] || "IT Assets";
}

export function isValidInventoryCategory(cat) {
  return INV_CATEGORIES.includes(cat);
}

export function isSoftwareCategory(value) {
  return String(value || "").trim().toLowerCase() === "software";
}

export function excludeSoftwareItems(items, categoryKey = "category") {
  return (items || []).filter((item) => !isSoftwareCategory(item?.[categoryKey]));
}

/** Filter inventory rows by `inventoryCategory` field. */
/** Resolve top-level inventory tab from API/local row (never treat Stock/Vehicle as IT by default). */
export function resolveInventoryCategory(item) {
  const explicit = String(
    item?.inventoryCategory ?? item?.inventory_category ?? "",
  ).trim();
  const cat = String(item?.category ?? "").trim().toLowerCase();

  if (cat === "vehicle") return "Transport Assets";
  if (cat === "equipment") return "Infrastructure Assets";

  if (cat === "stock") {
    if (
      explicit === "Office Assets" ||
      explicit === "Infrastructure Assets" ||
      explicit === "Transport Assets"
    ) {
      return explicit;
    }
    return "";
  }

  if (
    ["hardware", "software", "accessories", "consumables", "consumable", "accessory"].includes(
      cat,
    )
  ) {
    return explicit && INV_CATEGORIES.includes(explicit) ? explicit : "IT Assets";
  }

  if (explicit && INV_CATEGORIES.includes(explicit)) return explicit;
  return "";
}

export function filterInventoryByCategory(items, inventoryCategory) {
  if (!inventoryCategory) return items;
  return (items || []).filter(
    (i) => resolveInventoryCategory(i) === inventoryCategory,
  );
}

/** Resolve parent inventory row for a unit. */
export function getInventoryRowForUnit(unit, inventory = null) {
  if (!unit) return null;
  const inv = inventory || [];
  return (
    inv.find((i) => String(i.id) === String(unit.inventoryId)) ||
    inv.find((i) => String(i.id) === String(unit.assetId)) ||
    null
  );
}

export const DEFAULT_HARDWARE_FIELDS = {
  brand: { label: "Brand", placeholder: "Enter Brand" },
  // DB: make stores model name; model stores asset/unit code (legacy data entry mapping).
  make: { label: "Model", placeholder: "Enter Model" },
  model: { label: "Asset Code", placeholder: "Enter Asset Code" },
  serialNumber: { label: "Serial Number", placeholder: "Serial No." },
};

/** Display name for a hardware type (e.g. speaker → Speaker). */
export function formatHwTypeDisplayName(hwType) {
  const raw = String(hwType || "").trim();
  if (!raw) return "Asset";
  if (raw === raw.toLowerCase() || raw === raw.toUpperCase()) {
    return raw
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return raw;
}

/** Label/placeholder for the unit code field (model column), e.g. Laptop Code / Speaker Code. */
export function getAssetCodeField(hwType) {
  const typeName = formatHwTypeDisplayName(hwType);
  const label = `${typeName} Code`;
  return { label, placeholder: `Enter ${label}` };
}

/** @deprecated Prefer getHardwareFields(…, "Laptop") — kept as alias of defaults without type. */
export const LAPTOP_HARDWARE_FIELDS = DEFAULT_HARDWARE_FIELDS;

export const MOBILE_TABLET_HW_TYPES = ["Mobile", "Tablet"];

export function isMobileTabletHwType(hwType) {
  return MOBILE_TABLET_HW_TYPES.includes(String(hwType || "").trim());
}

export function isLaptopHardwareRow(row) {
  return (
    String(row?.category || "").trim().toLowerCase() === "hardware" &&
    String(row?.hwType || "").trim().toLowerCase() === "laptop"
  );
}

/** Show Laptop Code column only for IT hardware laptop context (not Software/Accessories/etc.). */
export function shouldShowLaptopCodeColumn(assets, inventoryCategory) {
  if (inventoryCategory !== "IT Assets" || !Array.isArray(assets) || assets.length === 0) {
    return false;
  }
  const onlyHardware = assets.every(
    (row) => String(row?.category || "").trim().toLowerCase() === "hardware",
  );
  return onlyHardware && assets.some(isLaptopHardwareRow);
}

export function getMobileTabletHardwareFields(baseFields = DEFAULT_HARDWARE_FIELDS) {
  return {
    ...baseFields,
    make: { label: "Model", placeholder: "Enter Model" },
    model: { label: "Model", placeholder: "Enter Model" },
    projectCode: { label: "Project Code", placeholder: "Enter Project Code" },
    deviceLocation: { label: "Device Location", placeholder: "Enter Device Location" },
    remarks: { label: "Comment", placeholder: "Optional comment (min 10 chars if filled)" },
  };
}

const INFRA_EQUIPMENT_HARDWARE_FIELDS = {
  brand: { label: "Make", placeholder: "e.g. Cisco" },
  make: { label: "Make", placeholder: "e.g. Cisco" },
  model: { label: "Model", placeholder: "e.g. 2960" },
  serialNumber: { label: "Asset tag / ID", placeholder: "e.g. INF-001" },
};

export function isTransportInventoryCategory(inventoryCategory) {
  return inventoryCategory === "Transport Assets";
}

/** Owner / fleet name for transport units (brand field stores fleet/owner). */
export function getTransportOwnerName(unit) {
  return String(unit?.brand || unit?.assetName || unit?.name || "").trim() || "—";
}

/** Brand/model text for parcel & export tables (make/model for transport). */
export function formatParcelBrandModel(asset, inventoryCategory) {
  if (isTransportInventoryCategory(inventoryCategory)) {
    const make = String(asset?.make || "").trim();
    const model = String(asset?.model || "").trim();
    if (!make && !model) return "—";
    if (make && model) return `${make}/${model}`;
    return make || model;
  }
  const brand = String(asset?.brand || "").trim();
  const model = String(asset?.model || "").trim();
  if (!brand || brand === "—") return "—";
  return model ? `${brand} · ${model}` : brand;
}

/** Primary name column for export tables (owner for transport, asset name otherwise). */
export function getParcelAssetDisplayName(asset, inventoryCategory) {
  if (isTransportInventoryCategory(inventoryCategory)) {
    return getTransportOwnerName(asset);
  }
  return asset?.assetName || "Unknown";
}

/** Brand / Name column for unit rows (fixes legacy rows where site was stored in brand). */
export function getUnitBrandModelDisplay(unit, inventoryCategory) {
  const cat = String(unit?.category || "").trim().toLowerCase();
  if (inventoryCategory === "Infrastructure Assets" && cat === "equipment") {
    const make = String(unit?.make || "").trim();
    const model = String(unit?.model || "").trim();
    const assetName = String(unit?.assetName || "").trim();
    const primary =
      make && make !== "—" && make !== assetName
        ? make
        : assetName || make || String(unit?.brand || "").trim() || "—";
    const secondary = model && model !== "—" ? model : "";
    return { primary, secondary };
  }
  const primary = String(unit?.brand || unit?.assetName || unit?.name || "").trim() || "—";
  const secondary = String(unit?.model || "").trim();
  return { primary, secondary };
}

export function getHardwareFields(inventoryCategory, itemCategory = null, hwType = null) {
  const cat = String(itemCategory || "").trim().toLowerCase();
  if (inventoryCategory === "Infrastructure Assets" && cat === "equipment") {
    return INFRA_EQUIPMENT_HARDWARE_FIELDS;
  }
  const config = INVENTORY_CATEGORY_CONFIG[inventoryCategory];
  if (config?.hardwareFields) {
    return config.hardwareFields;
  }
  const hw = String(hwType || "").trim();
  // "{Type} Code" for Laptop, Desktop, Speaker, Mobile, etc. (not a hard-coded Laptop Code).
  if (hw) {
    return {
      ...DEFAULT_HARDWARE_FIELDS,
      model: getAssetCodeField(hw),
    };
  }
  return DEFAULT_HARDWARE_FIELDS;
}

export function isStockInventoryCategory(inventoryCategory) {
  return Boolean(INVENTORY_CATEGORY_CONFIG[inventoryCategory]?.stockMode);
}

export function isVehicleInventoryCategory(inventoryCategory) {
  return Boolean(INVENTORY_CATEGORY_CONFIG[inventoryCategory]?.vehicleMode);
}

/** Office, Transport, Infrastructure — no HR employee assign flow. */
export function isNonItInventoryCategory(inventoryCategory) {
  return inventoryCategory !== "IT Assets";
}

const DEPLOY_INVENTORY_CATEGORIES = new Set([
  "Office Assets",
  "Transport Assets",
  "Infrastructure Assets",
]);

/** Issue / return (location deploy) for Office, Transport, Infrastructure. */
export function showInventoryDeploy(inventoryCategory) {
  return DEPLOY_INVENTORY_CATEGORIES.has(inventoryCategory);
}

/** Show In use / Assigned column on IT and deploy-enabled inventory tabs. */
export function hideAssignedColumnForCategory(inventoryCategory) {
  if (inventoryCategory === "IT Assets") return false;
  return !showInventoryDeploy(inventoryCategory);
}

export function isOfficeInventoryCategory(inventoryCategory) {
  return inventoryCategory === "Office Assets";
}

/** @deprecated use showInventoryDeploy */
export function showOfficeStockAssign(inventoryCategory) {
  return showInventoryDeploy(inventoryCategory);
}

export function getAssignedColumnLabel(inventoryCategory) {
  return DEPLOY_INVENTORY_CATEGORIES.has(inventoryCategory) ? "In use" : "Assigned";
}

export function isUnitDeployRow(row, inventoryCategory) {
  const cat = String(row?.category || "").trim().toLowerCase();
  if (inventoryCategory === "Transport Assets") return cat === "vehicle";
  if (inventoryCategory === "Infrastructure Assets") return cat === "equipment";
  return false;
}

export function isStockDeployRow(row) {
  return String(row?.category || "").trim().toLowerCase() === "stock";
}

export function rowSupportsInventoryDeploy(row, inventoryCategory) {
  if (!showInventoryDeploy(inventoryCategory)) return false;
  return isStockDeployRow(row) || isUnitDeployRow(row, inventoryCategory);
}

const DEPLOY_LABEL_DEFAULTS = {
  deployLabel: "Deploy",
  returnLabel: "Return",
  deployModalTitle: "Deploy to location",
  returnModalTitle: "Return to available",
  deployTitle: "Deploy to a location (moves qty to In use)",
  deployDisabledTitle: "Nothing available to deploy",
  returnTitle: "Return deployed quantity to available",
  returnDisabledTitle: "Nothing currently in use",
  deployedAtLabel: "Deployed at",
  loadingDeployed: "Loading deployed records…",
  noDeployed: "Nothing is currently deployed for this item.",
};

export function getDeployModalConfig(inventoryCategory) {
  if (inventoryCategory === "Transport Assets") {
    return {
      ...DEPLOY_LABEL_DEFAULTS,
      label: "Transport",
      locationLabel: "Route / base / depot",
      locationPlaceholder: "e.g. Mumbai depot, Site A",
      hint: "Mark an available vehicle as in use at a location.",
      deployTitle: "Mark vehicle in use at a route or depot",
    };
  }
  if (inventoryCategory === "Infrastructure Assets") {
    return {
      ...DEPLOY_LABEL_DEFAULTS,
      label: "Infrastructure",
      locationLabel: "Site / location",
      locationPlaceholder: "e.g. Server room A, Plant 2",
      hint: "Deploy stock or an installed unit to a site.",
    };
  }
  return {
    ...DEPLOY_LABEL_DEFAULTS,
    label: "Office",
    locationLabel: "Location / department",
    locationPlaceholder: "e.g. 3rd floor pantry, Reception",
    hint: "Move quantity from Available to In use at a location.",
  };
}

/** Category tabs on Not Working / In Repair / Dead Assets (IT only). */
export const IT_INVENTORY_STATUS_TABS = [
  "All",
  "Hardware",
  "Accessories",
  "Consumables",
];

export function getInventoryStatusCategoryTabs(inventoryCategory) {
  if (isNonItInventoryCategory(inventoryCategory)) {
    return ["All"];
  }
  return IT_INVENTORY_STATUS_TABS;
}

export function showInventoryStatusCategoryTabs(inventoryCategory) {
  return !isNonItInventoryCategory(inventoryCategory);
}

export function unitBelongsToInventoryCategory(unit, inventoryCategory, inventory = null) {
  if (!inventoryCategory) return true;
  const row = getInventoryRowForUnit(unit, inventory);
  if (!row) return false;
  return resolveInventoryCategory(row) === inventoryCategory;
}

/** Scope dead-asset audit rows to Office / Transport / Infrastructure / IT tabs. */
export function deletedLogBelongsToInventoryCategory(
  record,
  inventoryCategory,
  { inventory = [], units = [] } = {},
) {
  if (!inventoryCategory) return true;

  const invId = record?.inventoryId ?? record?.inventory_item_id;
  if (invId != null && invId !== "") {
    const row = inventory.find((i) => String(i.id) === String(invId));
    if (row) return resolveInventoryCategory(row) === inventoryCategory;
  }

  const explicit = String(
    record?.inventoryCategory ?? record?.inventory_category ?? "",
  ).trim();
  if (explicit && INV_CATEGORIES.includes(explicit)) {
    return explicit === inventoryCategory;
  }

  const unitId = record?.assetUnitId ?? record?.asset_unit_id;
  if (unitId != null && unitId !== "") {
    const unit = units.find((u) => String(u.id) === String(unitId));
    if (unit) {
      const row = getInventoryRowForUnit(unit, inventory);
      if (row) return resolveInventoryCategory(row) === inventoryCategory;
      const fromUnit = resolveInventoryCategory({
        category: unit.category,
        inventoryCategory: unit.inventoryCategory,
      });
      if (fromUnit) return fromUnit === inventoryCategory;
    }
  }

  const cat = String(record?.category || "").trim().toLowerCase();
  if (cat === "vehicle") return inventoryCategory === "Transport Assets";
  if (cat === "equipment") return inventoryCategory === "Infrastructure Assets";
  if (cat === "stock") {
    if (explicit && INV_CATEGORIES.includes(explicit)) {
      return explicit === inventoryCategory;
    }
    return inventoryCategory === "Office Assets";
  }
  if (
    inventoryCategory === "IT Assets" &&
    ["hardware", "software", "accessories", "consumables", "consumable", "accessory"].includes(
      cat,
    )
  ) {
    return true;
  }

  return false;
}

/* ── Custom / dynamic item types (hardware + accessories + consumables) ─── */

export const ADD_NEW_HW_TYPE_VALUE = "__add_new_hw_type__";
export const ADD_NEW_HW_TYPE_LABEL = "+ Add new type…";

const CUSTOM_HW_TYPES_STORAGE_KEY = "it_custom_hw_types_v1";
const HW_TYPES_CHANGED_EVENT = "it-hw-types-changed";

const TYPE_KIND = {
  hardware: "hardware",
  accessories: "accessories",
  consumables: "consumables",
};

function _readCustomHwStore() {
  try {
    const raw = localStorage.getItem(CUSTOM_HW_TYPES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function _writeCustomHwStore(store) {
  try {
    localStorage.setItem(CUSTOM_HW_TYPES_STORAGE_KEY, JSON.stringify(store || {}));
  } catch {
    /* ignore quota */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(HW_TYPES_CHANGED_EVENT));
  }
}

function _normalizeHwTypeName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40);
}

function _normalizeKind(kind) {
  const k = String(kind || TYPE_KIND.hardware).trim().toLowerCase();
  if (k === TYPE_KIND.accessories) return TYPE_KIND.accessories;
  if (k === TYPE_KIND.consumables) return TYPE_KIND.consumables;
  return TYPE_KIND.hardware;
}

function _emptyKindBuckets() {
  return { hardware: [], accessories: [], consumables: [] };
}

/** Read custom list for category + kind (migrates legacy flat arrays → hardware). */
function _getCustomList(store, cat, kind) {
  const entry = store[cat];
  if (Array.isArray(entry)) {
    return kind === TYPE_KIND.hardware ? entry : [];
  }
  if (entry && typeof entry === "object") {
    const list = entry[kind];
    return Array.isArray(list) ? list : [];
  }
  return [];
}

function _setCustomList(store, cat, kind, list) {
  let entry = store[cat];
  if (Array.isArray(entry)) {
    entry = { ..._emptyKindBuckets(), hardware: entry };
  } else if (!entry || typeof entry !== "object") {
    entry = _emptyKindBuckets();
  } else {
    entry = {
      hardware: Array.isArray(entry.hardware) ? entry.hardware : [],
      accessories: Array.isArray(entry.accessories) ? entry.accessories : [],
      consumables: Array.isArray(entry.consumables) ? entry.consumables : [],
    };
  }
  entry[kind] = list;
  store[cat] = entry;
}

/** Built-in types for a category + kind. Use "+ Add new type…" for extras. */
export function getDefaultHwTypes(inventoryCategory, kind = TYPE_KIND.hardware) {
  const k = _normalizeKind(kind);
  const cfg = INVENTORY_CATEGORY_CONFIG[inventoryCategory] || INVENTORY_CATEGORY_CONFIG["IT Assets"];
  if (k === TYPE_KIND.accessories) {
    return [...(cfg.accessoryTypes || [])];
  }
  if (k === TYPE_KIND.consumables) {
    return [...(cfg.consumableTypes || [])];
  }
  if (inventoryCategory === "Infrastructure Assets") {
    return [...(cfg.equipmentTypes || cfg.hwTypes || [])];
  }
  return [...(cfg.hwTypes || [])];
}

/** User-added types for a category (excludes built-ins). */
export function getCustomHwTypes(inventoryCategory, kind = TYPE_KIND.hardware) {
  const cat = inventoryCategory || "IT Assets";
  const k = _normalizeKind(kind);
  const list = _getCustomList(_readCustomHwStore(), cat, k);
  return list.map(_normalizeHwTypeName).filter(Boolean);
}

/**
 * Full list for dropdowns / filters: defaults + customs (+ optional Add new).
 * @param {{ includeAddNew?: boolean, kind?: "hardware"|"accessories"|"consumables" }} opts
 */
export function getHwTypesForCategory(inventoryCategory, opts = {}) {
  const includeAddNew = Boolean(opts.includeAddNew);
  const kind = _normalizeKind(opts.kind);
  const defaults = getDefaultHwTypes(inventoryCategory, kind).filter((t) => t !== "Other");
  const custom = getCustomHwTypes(inventoryCategory, kind).filter(
    (c) => !defaults.some((d) => d.toLowerCase() === c.toLowerCase()),
  );
  const merged = [...defaults, ...custom];
  if (includeAddNew) merged.push(ADD_NEW_HW_TYPE_VALUE);
  return merged;
}

export function getAccessoryTypesForCategory(inventoryCategory, opts = {}) {
  return getHwTypesForCategory(inventoryCategory, { ...opts, kind: TYPE_KIND.accessories });
}

export function getConsumableTypesForCategory(inventoryCategory, opts = {}) {
  return getHwTypesForCategory(inventoryCategory, { ...opts, kind: TYPE_KIND.consumables });
}

/** Persist a new type; returns canonical name or null if invalid. */
export function addCustomHwType(inventoryCategory, name, kind = TYPE_KIND.hardware) {
  const cat = inventoryCategory || "IT Assets";
  const k = _normalizeKind(kind);
  const normalized = _normalizeHwTypeName(name);
  if (!normalized || normalized.toLowerCase() === "other") return null;

  const defaults = getDefaultHwTypes(cat, k).filter((t) => t !== "Other");
  const existingDefault = defaults.find((d) => d.toLowerCase() === normalized.toLowerCase());
  if (existingDefault) return existingDefault;

  const store = _readCustomHwStore();
  const list = [..._getCustomList(store, cat, k)];
  const existingCustom = list.find((d) => String(d).toLowerCase() === normalized.toLowerCase());
  if (existingCustom) return _normalizeHwTypeName(existingCustom);

  list.push(normalized);
  _setCustomList(store, cat, k, list);
  _writeCustomHwStore(store);
  return normalized;
}

export function addCustomAccessoryType(inventoryCategory, name) {
  return addCustomHwType(inventoryCategory, name, TYPE_KIND.accessories);
}

export function addCustomConsumableType(inventoryCategory, name) {
  return addCustomHwType(inventoryCategory, name, TYPE_KIND.consumables);
}

/** Subscribe to custom type list changes (same-tab + storage). Returns unsubscribe. */
export function subscribeHwTypesChange(callback) {
  if (typeof window === "undefined" || typeof callback !== "function") return () => {};
  const onCustom = () => callback();
  const onStorage = (e) => {
    if (e.key === CUSTOM_HW_TYPES_STORAGE_KEY || e.key === null) callback();
  };
  window.addEventListener(HW_TYPES_CHANGED_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(HW_TYPES_CHANGED_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/** React-friendly label for select option values. */
export function hwTypeOptionLabel(value) {
  if (value === ADD_NEW_HW_TYPE_VALUE) return ADD_NEW_HW_TYPE_LABEL;
  return value;
}
