import "./ShowMoreRows.css";

/**
 * Table footer row for useIncrementalList (or a server-paged list): "Showing X of Y · Show more · Show all".
 * Renders nothing when every row is already visible. "Show all" is omitted when `list.showAll` is absent.
 */
export default function ShowMoreRows({ list, colSpan = 1, pageSize = 100 }) {
  if (!list?.hasMore) return null;
  const remaining = Math.max(0, list.total - list.shown);
  return (
    <tr className="show-more-rows">
      <td colSpan={colSpan}>
        <div className="show-more-rows__inner">
          <span className="show-more-rows__info">
            Showing {list.shown} of {list.total}
          </span>
          <button
            type="button"
            className="show-more-rows__btn"
            onClick={list.showMore}
            disabled={Boolean(list.loading)}
          >
            {list.loading ? "Loading…" : `Show ${Math.min(pageSize, remaining) || pageSize} more`}
          </button>
          {list.showAll ? (
            <button
              type="button"
              className="show-more-rows__btn show-more-rows__btn--ghost"
              onClick={list.showAll}
            >
              Show all
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
