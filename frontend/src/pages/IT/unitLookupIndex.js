/**
 * One-pass lookup index over hardware units, replacing per-row `units.filter(...)` scans.
 *
 * Matching rules (same as the original per-row filters):
 *   1. units whose String(inventoryId) equals String(inventoryId)
 *   2. else units whose assetName/name === assetName AND same hwType (only when hwType given)
 *   3. else units whose assetName/name === assetName
 * Lists keep the original unit order. Build a fresh index per render/build — the units
 * cache array is mutated in place elsewhere, so indexes must not be cached across calls.
 */
export function buildUnitLookupIndex(units, include = null) {
  const byInventoryId = new Map();
  const byName = new Map();
  const push = (map, key, unit) => {
    const list = map.get(key);
    if (list) list.push(unit);
    else map.set(key, [unit]);
  };
  for (const u of units || []) {
    if (!u || (include && !include(u))) continue;
    push(byInventoryId, String(u.inventoryId), u);
    push(byName, u.assetName, u);
    if (u.name !== u.assetName) push(byName, u.name, u);
  }
  return { byInventoryId, byName };
}

export function lookupUnitsForAsset(index, inventoryId, assetName, hwType, sameHwType) {
  const byId = index.byInventoryId.get(String(inventoryId));
  if (byId && byId.length > 0) return byId.slice();
  const byName = index.byName.get(assetName) || [];
  if (hwType) {
    const byNameAndType = byName.filter((u) => sameHwType(u, hwType));
    if (byNameAndType.length > 0) return byNameAndType;
  }
  return byName.slice();
}
