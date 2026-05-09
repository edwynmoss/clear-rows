import { invoke } from "@tauri-apps/api/core";

import { CSV_MAX_ROWS_PER_BATCH } from "../app/constants";
import { isDesktopRuntime, requireDesktopRuntime } from "../tauri/runtime";
import type {
  CsvFileProfileResult,
  CsvSearchProgress,
  CsvSearchSummary,
  ExportStatus,
  FilterStatus,
  IndexStatus,
  OpenSummary,
  RowBatch,
  SortDirection,
  SortStatus,
} from "../types/csv";

export type OpenCsvOptions = {
  delimiterOverride?: string;
  encodingOverride?: string;
};

export async function openCsv(path: string, options: OpenCsvOptions = {}): Promise<OpenSummary> {
  requireDesktopRuntime("Opening local CSV files requires the desktop runtime");
  return invoke<OpenSummary>("open_csv", {
    path,
    delimiterOverride: options.delimiterOverride ?? null,
    encodingOverride: options.encodingOverride ?? null,
  });
}

export async function fetchCsvRows(
  start: number,
  count: number,
  columnStart: number,
  columnCount: number,
): Promise<RowBatch> {
  const safeCount = Math.min(Math.max(0, Math.floor(count)), CSV_MAX_ROWS_PER_BATCH);
  const safeColumnStart = Math.max(0, Math.floor(columnStart));
  const safeColumnCount = Math.max(0, Math.floor(columnCount));

  requireDesktopRuntime("Reading CSV rows requires the desktop runtime");
  return invoke<RowBatch>("get_csv_rows", {
    start,
    count: safeCount,
    columnStart: safeColumnStart,
    columnCount: safeColumnCount,
  });
}

export async function getStartupCsvPath(): Promise<string | null> {
  if (!isDesktopRuntime()) {
    return null;
  }

  return invoke<string | null>("startup_csv_path");
}

export async function getCsvIndexStatus(): Promise<IndexStatus> {
  requireDesktopRuntime("Checking CSV indexing progress requires the desktop runtime");
  return invoke<IndexStatus>("csv_index_status");
}

export async function searchCsvFiles(
  paths: string[],
  query: string,
  maxMatches = 500,
): Promise<CsvSearchSummary> {
  requireDesktopRuntime("Searching local CSV files requires the desktop runtime");
  return invoke<CsvSearchSummary>("search_csv_files", {
    paths,
    query,
    maxMatches,
  });
}

export async function profileCsvFiles(paths: string[]): Promise<CsvFileProfileResult[]> {
  requireDesktopRuntime("Profiling local files requires the desktop runtime");
  return invoke<CsvFileProfileResult[]>("profile_csv_files", { paths });
}

export async function getCsvSearchProgress(): Promise<CsvSearchProgress> {
  requireDesktopRuntime("Reading search progress requires the desktop runtime");
  return invoke<CsvSearchProgress>("csv_search_progress");
}

export async function cancelCsvSearch(): Promise<CsvSearchProgress> {
  requireDesktopRuntime("Cancelling CSV search requires the desktop runtime");
  return invoke<CsvSearchProgress>("cancel_csv_search");
}

export async function startCsvSort(
  columnIndex: number,
  direction: SortDirection,
): Promise<SortStatus> {
  requireDesktopRuntime("Sorting CSV rows requires the desktop runtime");
  return invoke<SortStatus>("start_csv_sort", {
    columnIndex,
    direction,
  });
}

export async function getCsvSortStatus(): Promise<SortStatus> {
  requireDesktopRuntime("Reading sort status requires the desktop runtime");
  return invoke<SortStatus>("csv_sort_status");
}

export async function clearCsvSort(): Promise<SortStatus> {
  requireDesktopRuntime("Clearing sort requires the desktop runtime");
  return invoke<SortStatus>("clear_csv_sort");
}

export async function startCsvFilter(query: string): Promise<FilterStatus> {
  requireDesktopRuntime("Filtering CSV rows requires the desktop runtime");
  return invoke<FilterStatus>("start_csv_filter", { query });
}

export async function getCsvFilterStatus(): Promise<FilterStatus> {
  requireDesktopRuntime("Reading filter status requires the desktop runtime");
  return invoke<FilterStatus>("csv_filter_status");
}

export async function clearCsvFilter(): Promise<FilterStatus> {
  requireDesktopRuntime("Clearing filter requires the desktop runtime");
  return invoke<FilterStatus>("clear_csv_filter");
}

export async function startCsvExport(
  targetPath: string,
  columnIndices: number[] | null,
): Promise<ExportStatus> {
  requireDesktopRuntime("Exporting CSV rows requires the desktop runtime");
  return invoke<ExportStatus>("start_csv_export", {
    targetPath,
    columnIndices,
  });
}

export async function getCsvExportStatus(): Promise<ExportStatus> {
  requireDesktopRuntime("Reading export status requires the desktop runtime");
  return invoke<ExportStatus>("csv_export_status");
}

export async function cancelCsvExport(): Promise<ExportStatus> {
  requireDesktopRuntime("Cancelling export requires the desktop runtime");
  return invoke<ExportStatus>("cancel_csv_export");
}

export async function clearCsvExport(): Promise<ExportStatus> {
  requireDesktopRuntime("Clearing export requires the desktop runtime");
  return invoke<ExportStatus>("clear_csv_export");
}
