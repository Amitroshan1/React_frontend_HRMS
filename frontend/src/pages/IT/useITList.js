import { useCallback, useEffect, useRef, useState } from "react";
import { fetchITListPageAPI, toastITApiFailure } from "./Data";

/** Server-paged IT lists are on unless the build sets VITE_IT_SERVER_LISTS=0. */
export const IT_SERVER_LISTS_ENABLED = import.meta.env.VITE_IT_SERVER_LISTS !== "0";

const MAX_PAGE_SIZE = 100;

export function useDebouncedValue(value, delayMs = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

const EMPTY_STATE = {
  key: null,
  items: [],
  total: 0,
  nextCursor: null,
  hasMore: false,
  meta: null,
  error: null,
  loadingMore: false,
};

/**
 * Keyset-paged list from an IT endpoint returning { items, total, next_cursor, has_more }.
 *
 * - Fetches page one whenever `params` change (compared by value) or `reload()` is called;
 *   the previous rows stay on screen until the new page arrives, stale responses are dropped.
 * - `loadMore()` appends the next page, sending `moreParams` on top of `params`.
 * - `error` stays set until a later request succeeds, so callers can fall back meanwhile.
 * `mapItem` and `moreParams` must be stable (module-level) values.
 */
export function useITList(
  path,
  params,
  { enabled = true, pageSize = 50, moreParams = null, mapItem = null } = {},
) {
  const paramsKey = JSON.stringify(params ?? {});
  const [reloadTick, setReloadTick] = useState(0);
  const requestKey = `${path}?${paramsKey}#${reloadTick}`;
  const [state, setState] = useState(EMPTY_STATE);
  const seqRef = useRef(0);
  const stateRef = useRef(state);
  const reloadLimitRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const mapRows = useCallback(
    (data) => {
      const rows = Array.isArray(data?.items) ? data.items : [];
      return mapItem ? rows.map(mapItem) : rows;
    },
    [mapItem],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const ctrl = new AbortController();
    const seq = ++seqRef.current;
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(pageSize, reloadLimitRef.current));
    reloadLimitRef.current = 0;
    fetchITListPageAPI(path, { ...JSON.parse(paramsKey), limit }, { signal: ctrl.signal })
      .then((data) => {
        if (seq !== seqRef.current) return;
        const { items: _items, ...meta } = data || {};
        const rows = mapRows(data);
        setState({
          key: requestKey,
          items: rows,
          total: Number(data?.total ?? rows.length) || 0,
          nextCursor: data?.next_cursor ?? null,
          hasMore: Boolean(data?.has_more),
          meta,
          error: null,
          loadingMore: false,
        });
      })
      .catch((err) => {
        if (ctrl.signal.aborted || seq !== seqRef.current) return;
        console.error(`[useITList] ${path} failed:`, err);
        setState((s) => ({ ...s, key: requestKey, error: err, loadingMore: false }));
      });
    return () => ctrl.abort();
  }, [enabled, path, paramsKey, pageSize, mapRows, requestKey]);

  const loadMore = useCallback(() => {
    const cur = stateRef.current;
    if (!cur.hasMore || cur.loadingMore || cur.nextCursor == null) return;
    const seq = seqRef.current;
    stateRef.current = { ...cur, loadingMore: true };
    setState((s) => ({ ...s, loadingMore: true }));
    fetchITListPageAPI(path, {
      ...JSON.parse(paramsKey),
      ...(moreParams || {}),
      limit: pageSize,
      cursor: cur.nextCursor,
    })
      .then((data) => {
        if (seq !== seqRef.current) return;
        const rows = mapRows(data);
        setState((s) => ({
          ...s,
          items: [...s.items, ...rows],
          nextCursor: data?.next_cursor ?? null,
          hasMore: Boolean(data?.has_more),
          loadingMore: false,
        }));
      })
      .catch((err) => {
        if (seq !== seqRef.current) return;
        setState((s) => ({ ...s, loadingMore: false }));
        toastITApiFailure(err, "Could not load more rows. Please try again.");
      });
  }, [path, paramsKey, moreParams, pageSize, mapRows]);

  /** Refetch after a save, keeping roughly as many rows as are loaded now. */
  const reload = useCallback(() => {
    reloadLimitRef.current = stateRef.current.items.length;
    setReloadTick((t) => t + 1);
  }, []);

  return {
    items: state.items,
    total: state.total,
    hasMore: state.hasMore,
    meta: state.meta,
    error: enabled ? state.error : null,
    loaded: state.key != null,
    loading: enabled && state.key !== requestKey,
    loadingMore: state.loadingMore,
    loadMore,
    reload,
  };
}
