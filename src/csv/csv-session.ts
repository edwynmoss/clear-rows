import type { CsvFileProfile, IndexStatus, OpenSummary } from "../types/csv";

import { CSV_DEFAULT_COL_WIDTH_PX } from "../app/constants";

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
  /** Rows exposed to the virtual scrollbar; updated less often to avoid thumb jitter. */
  scrollRowCount = 0;
  colWidths: number[] = [];

  applySummary(summary: OpenSummary, colWidthPx: number = CSV_DEFAULT_COL_WIDTH_PX): void {
    this.path = summary.path;
    this.profile = summary.profile;
    this.headers = summary.headers;
    this.rowCount = summary.row_count;
    this.scrollRowCount = estimateScrollRowCount(summary);
    this.colWidths = summary.headers.map(() => colWidthPx);
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

    if (status.is_complete || status.error || status.row_count > this.scrollRowCount) {
      this.scrollRowCount = status.row_count;
    }

    return {
      previousRowCount,
      rowCountChanged: previousRowCount !== this.rowCount,
      scrollExtentChanged: previousScrollRowCount !== this.scrollRowCount,
    };
  }
}

function estimateScrollRowCount(summary: OpenSummary): number {
  if (summary.is_complete || summary.indexed_bytes <= 0 || summary.file_size <= 0) {
    return summary.row_count;
  }

  const indexedRatio = summary.file_size / summary.indexed_bytes;
  const estimatedRows = Math.ceil(summary.row_count * indexedRatio);

  return Math.max(summary.row_count, estimatedRows);
}
