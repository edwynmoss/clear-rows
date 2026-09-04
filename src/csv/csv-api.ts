import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { CSV_MAX_ROWS_PER_BATCH } from "../app/constants";
import { isDesktopRuntime } from "../tauri/runtime";
import { shimInvoke } from "../tauri/browser-shim";
import type {
  ColumnStats,
  CsvFileProfileResult,
  CsvSearchProgress,
  CsvSearchSummary,
  ExportStatus,
  FilterStatus,
  IndexStatus,
  OpenSummary,
  RowBatch,
  SortKey,
  SortStatus,
} from "../types/csv";

export type OpenCsvOptions = {
  delimiterOverride?: string;
  encodingOverride?: string;
  /** "header" | "data"; omit for auto-detection. */
  headerOverride?: string;
};

/** Desktop: Tauri commands backed by Rust. Browser: the in-memory shim. */
function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return isDesktopRuntime() ? tauriInvoke<T>(command, args) : shimInvoke<T>(command, args);
}

export async function openCsv(path: string, options: OpenCsvOptions = {}): Promise<OpenSummary> {
  return invoke<OpenSummary>("open_csv", {
    path,
    delimiterOverride: options.delimiterOverride ?? null,
    encodingOverride: options.encodingOverride ?? null,
    headerOverride: options.headerOverride ?? null,
  });
}

export async function fetchCsvRows(
  start: number,
  count: number,
  columnStart: number,
  columnCount: number,
): Promise<RowBatch> {
  const safeCount = Math.min(Math.max(0, Math.floor(count)), CSV_MAX_ROWS_PER_BATCH);
  return invoke<RowBatch>("get_csv_rows", {
    start,
    count: safeCount,
    columnStart: Math.max(0, Math.floor(columnStart)),
    columnCount: Math.max(0, Math.floor(columnCount)),
  });
}

/** Statistics for one column over the rows in view. */
export async function fetchColumnStats(column: number, topN = 12): Promise<ColumnStats> {
  return invoke<ColumnStats>("column_stats", { column, topN });
}

export async function getStartupCsvPath(): Promise<string | null> {
  return invoke<string | null>("startup_csv_path");
}

export async function getCsvIndexStatus(): Promise<IndexStatus> {
  return invoke<IndexStatus>("csv_index_status");
}

export async function searchCsvFiles(paths: string[], query: string, maxMatches = 500): Promise<CsvSearchSummary> {
  return invoke<CsvSearchSummary>("search_csv_files", { paths, query, maxMatches });
}

export async function profileCsvFiles(paths: string[]): Promise<CsvFileProfileResult[]> {
  return invoke<CsvFileProfileResult[]>("profile_csv_files", { paths });
}

export async function getCsvSearchProgress(): Promise<CsvSearchProgress> {
  return invoke<CsvSearchProgress>("csv_search_progress");
}

export async function cancelCsvSearch(): Promise<CsvSearchProgress> {
  return invoke<CsvSearchProgress>("cancel_csv_search");
}

export async function startCsvSort(keys: SortKey[]): Promise<SortStatus> {
  return invoke<SortStatus>("start_csv_sort", { keys });
}

export async function getCsvSortStatus(): Promise<SortStatus> {
  return invoke<SortStatus>("csv_sort_status");
}

export async function clearCsvSort(): Promise<SortStatus> {
  return invoke<SortStatus>("clear_csv_sort");
}

export async function startCsvFilter(query: string): Promise<FilterStatus> {
  return invoke<FilterStatus>("start_csv_filter", { query });
}

export async function getCsvFilterStatus(): Promise<FilterStatus> {
  return invoke<FilterStatus>("csv_filter_status");
}

export async function clearCsvFilter(): Promise<FilterStatus> {
  return invoke<FilterStatus>("clear_csv_filter");
}

export async function startCsvExport(targetPath: string, columnIndices: number[] | null): Promise<ExportStatus> {
  return invoke<ExportStatus>("start_csv_export", { targetPath, columnIndices });
}

export async function getCsvExportStatus(): Promise<ExportStatus> {
  return invoke<ExportStatus>("csv_export_status");
}

export async function cancelCsvExport(): Promise<ExportStatus> {
  return invoke<ExportStatus>("cancel_csv_export");
}

export async function clearCsvExport(): Promise<ExportStatus> {
  return invoke<ExportStatus>("clear_csv_export");
}
