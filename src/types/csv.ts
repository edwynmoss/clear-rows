export type OpenSummary = {
  path: string;
  delimiter: number;
  headers: string[];
  row_count: number;
  is_complete: boolean;
  indexed_bytes: number;
  file_size: number;
  error: string | null;
  profile: CsvFileProfile;
};

export type CsvFileProfile = {
  extension: string | null;
  detected_kind: string;
  detected_kind_label: string;
  delimiter: number | null;
  delimiter_label: string | null;
  delimiter_confidence: string;
  encoding: string;
  sampled_rows: number;
  likely_columns: number;
  binary_like: boolean;
  warnings: string[];
};

export type CsvFileProfileResult = {
  path: string;
  profile: CsvFileProfile | null;
  error: string | null;
};

export type IndexStatus = {
  path: string;
  row_count: number;
  is_complete: boolean;
  indexed_bytes: number;
  file_size: number;
  error: string | null;
};

export type RowBatch = {
  start: number;
  column_start: number;
  rows: string[][];
};

export type CsvSearchSummary = {
  query: string;
  searched_files: number;
  matched_files: number;
  schemas: CsvSearchFileSchema[];
  matches: CsvSearchMatch[];
  errors: CsvSearchFileError[];
  truncated: boolean;
  cancelled: boolean;
};

export type CsvSearchProgress = {
  query: string;
  total_files: number;
  current_file_index: number;
  completed_files: number;
  current_file: string | null;
  current_path: string | null;
  current_row: number;
  matches: number;
  matched_files: number;
  errors: number;
  truncated: boolean;
  cancelled: boolean;
  is_running: boolean;
};

export type CsvSearchMatch = {
  path: string;
  file_name: string;
  row_index: number;
  column_index: number;
  column_name: string;
  value: string;
  row_values: string[];
};

export type CsvSearchFileSchema = {
  path: string;
  file_name: string;
  headers: string[];
};

export type CsvSearchFileError = {
  path: string;
  message: string;
};

export type SortDirection = "asc" | "desc";

export type SortStatus = {
  is_sorting: boolean;
  is_ready: boolean;
  column: number | null;
  direction: SortDirection | null;
  rows_scanned: number;
  total_rows: number;
  error: string | null;
};

export type FilterStatus = {
  is_filtering: boolean;
  is_ready: boolean;
  query: string | null;
  rows_scanned: number;
  total_rows: number;
  matched_rows: number;
  error: string | null;
};

export type ExportStatus = {
  is_running: boolean;
  is_complete: boolean;
  target_path: string | null;
  rows_written: number;
  total_rows: number;
  error: string | null;
};
