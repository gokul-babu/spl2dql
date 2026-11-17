/**
 * Lists whose length comes from a file or a search are shown up to a limit, so a file with 60,000
 * searches does not put half a million nodes on the page. Counts, downloads and copies always use
 * the whole list; the line under a shortened list says how much is shown.
 */
export const LIMIT = {
  /** Rows of the Batch table. */
  batch: 2_000,
  /** Notes of one translation on the Translate view, and stages in the marker strip. */
  notes: 500,
  stages: 500,
  /** Converted dashboards, and tiles of one dashboard. */
  dashboards: 500,
  tiles: 500,
  /** Everything else: variables, notes of a tile, names, definitions, problems. */
  list: 200,
} as const;

export function cap<T>(items: readonly T[], limit: number): readonly T[] {
  return items.length > limit ? items.slice(0, limit) : items;
}

const n = (x: number) => x.toLocaleString('en-US');

/** "Showing the first 2,000 of 60,000 searches." — only when the list was shortened. */
export function MoreLine(props: { total: number; limit: number; noun: string; download?: boolean; className?: string }) {
  if (props.total <= props.limit) return null;
  return (
    <p className={`text-sm text-muted ${props.className ?? ''}`} data-testid="more-line">
      Showing the first {n(props.limit)} of {n(props.total)} {props.noun}.{props.download ? ' All of them are in the download.' : ''}
    </p>
  );
}
