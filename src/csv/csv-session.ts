import type {
  CsvFileProfile,
  IndexStatus,
  OpenSummary,
  SortDirection,
} from "../types/csv";

import { CSV_DEFAULT_COL_WIDTH_PX } from "../app/constants";

export type ActiveSort = {
  column: number;
  direction: SortDirection;
};

export type ActiveFilter = {
  query: string;
  matchedRows: number;
};

/**
 * Client-side snapshot of the opened CSV (column layout + row count).
 * Rust remains source of truth for cell data.
 */
export class CsvSession {
  path: string | null = null;
  profile: CsvFileProfile | null = null;
  headers: string[] = [];
  /** Rows currently available from the Rust indexer. */
  rowCount = 0;
  /**
   * Rows exposed to the virtual scrollbar. Equal to the actual indexed row
   * count — projecting toward an estimated final size made wheel ticks feel
   * runaway on partially-indexed huge files because the scrollable extent was
   * orders of magnitude larger than the rendered content.
   */
  scrollRowCount = 0;
  colWidths: number[] = [];
  /**
   * The currently-applied sort, or `null` when rows are shown in their natural
   * order. Mirrored from the Rust sort engine after each sort completes.
   */
  activeSort: ActiveSort | null = null;
  /**
   * The currently-applied row filter, or `null` when every row is visible.
   * When set, `scrollRowCount` reflects `matchedRows` instead of the full
   * physical row count so the virtual scrollbar sizes to the visible rows.
   */
  activeFilter: ActiveFilter | null = null;
  /**
   * Physical column indices the user has explicitly hidden. Hidden columns
   * are not rendered in the grid and are skipped by export. Cleared on every
   * new file open.
   */
  hiddenColumns: Set<number> = new Set();

  applySummary(summary: OpenSummary, colWidthPx: number = CSV_DEFAULT_COL_WIDTH_PX): void {
    this.path = summary.path;
    this.profile = summary.profile;
    this.headers = summary.headers;
    this.rowCount = summary.row_count;
    this.scrollRowCount = summary.row_count;
    this.colWidths = summary.headers.map(() => colWidthPx);
    // Opening a new file invalidates any prior sort/filter state on the backend; mirror that.
    this.activeSort = null;
    this.activeFilter = null;
    this.hiddenColumns = new Set();
  }

  /** Effective column widths with hidden columns folded to zero. */
  effectiveColWidths(): number[] {
    if (this.hiddenColumns.size === 0) {
      return this.colWidths;
    }
    return this.colWidths.map((w, i) => (this.hiddenColumns.has(i) ? 0 : w));
  }

  /** Physical column indices that are currently visible, in original order. */
  visibleColumnIndices(): number[] {
    if (this.hiddenColumns.size === 0) {
      return this.headers.map((_, i) => i);
    }
    const out: number[] = [];
    for (let i = 0; i < this.headers.length; i++) {
      if (!this.hiddenColumns.has(i)) {
        out.push(i);
      }
    }
    return out;
  }

  applyIndexStatus(status: IndexStatus): {
    readonly previousRowCount: number;
    readonly rowCountChanged: boolean;
    readonly scrollExtentChanged: boolean;
  } {
    const previousRowCount = this.rowCount;
    const previousScrollRowCount = this.scrollRowCount;

    this.path = status.path;
    this.rowCount = status.row_count;
    // While a filter is active the virtual scrollbar sizes to matched rows,
    // not the full indexed count — leaving scrollRowCount alone here keeps
    // the visible extent stable while indexing finishes in the background.
    if (this.activeFilter === null) {
      this.scrollRowCount = status.row_count;
    }

    return {
      previousRowCount,
      rowCountChanged: previousRowCount !== this.rowCount,
      scrollExtentChanged: previousScrollRowCount !== this.scrollRowCount,
    };
  }

  applyActiveFilter(filter: ActiveFilter | null): {
    readonly scrollExtentChanged: boolean;
  } {
    const previousScrollRowCount = this.scrollRowCount;
    this.activeFilter = filter;
    this.scrollRowCount = filter ? filter.matchedRows : this.rowCount;
    return {
      scrollExtentChanged: previousScrollRowCount !== this.scrollRowCount,
    };
  }
}

