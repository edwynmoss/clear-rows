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

  applySummary(summary: OpenSummary, colWidthPx: number = CSV_DEFAULT_COL_WIDTH_PX): void {
    this.path = summary.path;
    this.profile = summary.profile;
    this.headers = summary.headers;
    this.rowCount = summary.row_count;
    this.scrollRowCount = summary.row_count;
    this.colWidths = summary.headers.map(() => colWidthPx);
    // Opening a new file invalidates any prior sort state on the backend; mirror that.
    this.activeSort = null;
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
    this.scrollRowCount = status.row_count;

    return {
      previousRowCount,
      rowCountChanged: previousRowCount !== this.rowCount,
      scrollExtentChanged: previousScrollRowCount !== this.scrollRowCount,
    };
  }
}

