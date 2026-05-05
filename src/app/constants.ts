/** Pixel height of one data row (must match header row). */
export const CSV_ROW_HEIGHT_PX = 28;

/** Default column width until auto-sizing exists. */
export const CSV_DEFAULT_COL_WIDTH_PX = 160;

/** Extra rows rendered above/below the viewport. */
export const CSV_VIRTUAL_SCROLL_BUFFER_ROWS = 14;

/** Extra horizontal pixels rendered to each side of the viewport. */
export const CSV_VIRTUAL_SCROLL_BUFFER_PX = 320;

/** Must stay in sync with `MAX_ROWS_PER_BATCH` in `src-tauri/src/csv/document.rs`. */
export const CSV_MAX_ROWS_PER_BATCH = 256;

export const SEARCH_LIMIT_OPTIONS = [100, 500, 1_000, 5_000] as const;
export const DEFAULT_SEARCH_LIMIT = 500;
