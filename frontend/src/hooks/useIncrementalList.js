import { useCallback, useMemo, useState } from "react";

export const INCREMENTAL_LIST_PAGE_SIZE = 100;

/**
 * Renders a long list in pages ("Show more") so huge tables don't block the browser.
 * The visible count resets to one page whenever `resetKey` changes (e.g. filters/search),
 * but not when the same list just refreshes after a save.
 */
const EMPTY = [];

export function useIncrementalList(items, resetKey = "", pageSize = INCREMENTAL_LIST_PAGE_SIZE) {
  const list = Array.isArray(items) ? items : EMPTY;
  const [state, setState] = useState({ key: resetKey, count: pageSize });

  let count = state.count;
  if (state.key !== resetKey) {
    count = pageSize;
    setState({ key: resetKey, count: pageSize });
  }

  const visible = useMemo(
    () => (list.length > count ? list.slice(0, count) : list),
    [list, count],
  );

  const showMore = useCallback(
    () => setState((s) => ({ ...s, count: s.count + pageSize })),
    [pageSize],
  );

  const showAll = useCallback(
    () => setState((s) => ({ ...s, count: Number.MAX_SAFE_INTEGER })),
    [],
  );

  return {
    visible,
    total: list.length,
    shown: visible.length,
    hasMore: list.length > visible.length,
    showMore,
    showAll,
  };
}
