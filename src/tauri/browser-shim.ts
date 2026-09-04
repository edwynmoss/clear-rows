/**
 * In-browser stand-in for the Rust backend, used when the UI runs in a plain
 * browser (Vite dev server, web demo). It parses CSV text in JavaScript and
 * answers the same command names with the same shapes as src-tauri/src/lib.rs.
 * Progressive indexing, byte offsets and the multi-file search are simulated
 * well enough to exercise every screen; it is not the performance path.
 */

import { parseFilterQuery, type FilterTerm } from "../csv/filter-query";
import type {
  CsvFileProfile,
  CsvFileProfileResult,
  CsvSearchMatch,
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

import { detectHeader, syntheticHeaders, HEADER_SAMPLE_ROWS } from "../csv/header-detect";

type Dataset = {
  path: string;
  headers: string[];
  rows: string[][];
  delimiter: string;
  encoding: string;
  encodingSource: string;
  hasHeader: boolean;
  headerSource: string;
  sizeBytes: number;
};

const files = new Map<string, Dataset>();
let current: Dataset | null = null;
let filterMask: number[] | null = null;
let sortPerm: number[] | null = null;
let filterStatus: FilterStatus = emptyFilterStatus();
let sortStatus: SortStatus = { is_sorting: false, is_ready: false, keys: [], rows_scanned: 0, total_rows: 0, error: null };
let exportStatus: ExportStatus = { is_running: false, is_complete: false, target_path: null, rows_written: 0, total_rows: 0, error: null };
let searchProgress: CsvSearchProgress = idleSearchProgress();
let searchCancelled = false;
let pendingStartupPath: string | null = null;

export function isBrowserShimActive(): boolean {
  return true;
}

/** Register text as a virtual file so `open_csv` can find it by path. */
export function registerVirtualFile(path: string, bytes: Uint8Array | string, sizeBytes?: number): void {
  const dataset = decodeAndParse(path, bytes, sizeBytes);
  files.set(path, dataset);
}

export function setStartupPath(path: string | null): void {
  pendingStartupPath = path;
}

export async function shimInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  switch (command) {
    case "startup_csv_path": {
      const path = pendingStartupPath;
      pendingStartupPath = null;
      return path as T;
    }
    case "open_csv":
      return openCsv(String(args.path), args.delimiterOverride as string | null, args.encodingOverride as string | null, args.headerOverride as string | null) as T;
    case "get_csv_rows":
      return getRows(Number(args.start), Number(args.count), Number(args.columnStart), Number(args.columnCount)) as T;
    case "csv_index_status":
      return indexStatus() as T;
    case "start_csv_filter":
      return startFilter(String(args.query)) as T;
    case "csv_filter_status":
      return filterStatus as T;
    case "clear_csv_filter":
      filterMask = null;
      filterStatus = emptyFilterStatus();
      return filterStatus as T;
    case "start_csv_sort":
      return startSort(args.keys as SortKey[]) as T;
    case "csv_sort_status":
      return sortStatus as T;
    case "clear_csv_sort":
      sortPerm = null;
      sortStatus = { is_sorting: false, is_ready: false, keys: [], rows_scanned: 0, total_rows: 0, error: null };
      return sortStatus as T;
    case "start_csv_export":
      return startExport(String(args.targetPath), args.columnIndices as number[] | null) as T;
    case "csv_export_status":
      return exportStatus as T;
    case "cancel_csv_export":
    case "clear_csv_export":
      exportStatus = { is_running: false, is_complete: false, target_path: null, rows_written: 0, total_rows: 0, error: null };
      return exportStatus as T;
    case "profile_csv_files":
      return (args.paths as string[]).map(profileResult) as T;
    case "search_csv_files":
      return searchFiles(args.paths as string[], String(args.query), Number(args.maxMatches)) as T;
    case "csv_search_progress":
      return searchProgress as T;
    case "cancel_csv_search":
      searchCancelled = true;
      searchProgress = { ...searchProgress, cancelled: true };
      return searchProgress as T;
    default:
      throw new Error(`Browser shim: unknown command ${command}`);
  }
}

// ------------------------------------------------------------------ open

function openCsv(path: string, delimiterOverride: string | null, encodingOverride: string | null, headerOverride: string | null = null): OpenSummary {
  let dataset = files.get(path);
  if (!dataset) throw new Error(`Unsupported file: ${path} is not loaded in the browser preview`);
  if (delimiterOverride || encodingOverride || headerOverride) {
    const raw = rawBytes.get(path);
    if (raw) {
      dataset = decodeAndParse(path, raw, dataset.sizeBytes, delimiterOverride ?? undefined, encodingOverride ?? undefined, headerOverride ?? undefined);
      files.set(path, dataset);
    }
  }
  current = dataset;
  filterMask = null;
  sortPerm = null;
  filterStatus = emptyFilterStatus();
  sortStatus = { is_sorting: false, is_ready: false, keys: [], rows_scanned: 0, total_rows: 0, error: null };
  return {
    path,
    delimiter: dataset.delimiter.charCodeAt(0),
    headers: dataset.headers,
    row_count: dataset.rows.length,
    is_complete: true,
    indexed_bytes: dataset.sizeBytes,
    file_size: dataset.sizeBytes,
    error: null,
    profile: profileOf(dataset),
  };
}

function indexStatus(): IndexStatus {
  if (!current) throw new Error("No document is open");
  return {
    path: current.path,
    row_count: current.rows.length,
    is_complete: true,
    indexed_bytes: current.sizeBytes,
    file_size: current.sizeBytes,
    error: null,
  };
}

function visibleIndices(): number[] {
  if (!current) return [];
  const base = sortPerm ?? current.rows.map((_, i) => i);
  if (!filterMask) return base;
  const mask = new Set(filterMask);
  return base.filter((i) => mask.has(i));
}

function getRows(start: number, count: number, columnStart: number, columnCount: number): RowBatch {
  if (!current) throw new Error("No document is open");
  const order = visibleIndices();
  const slice = order.slice(start, start + count);
  const safeStart = Math.min(columnStart, current.headers.length);
  const rows = slice.map((i) => (current!.rows[i] ?? []).slice(safeStart, safeStart + columnCount));
  return { start, column_start: safeStart, rows };
}

// ---------------------------------------------------------------- filter

function emptyFilterStatus(): FilterStatus {
  return { is_filtering: false, is_ready: false, query: null, rows_scanned: 0, total_rows: 0, matched_rows: 0, error: null };
}

function startFilter(query: string): FilterStatus {
  if (!current) throw new Error("No document is open");
  const parsed = parseFilterQuery(query, current.headers);
  if (parsed.error) {
    filterStatus = { ...emptyFilterStatus(), error: parsed.error };
    return filterStatus;
  }
  const total = current.rows.length;
  filterStatus = { is_filtering: true, is_ready: false, query, rows_scanned: 0, total_rows: total, matched_rows: 0, error: null };
  const terms = parsed.terms.map(compileTerm(current.headers));
  const mask: number[] = [];
  const rows = current.rows;
  let i = 0;
  const step = (): void => {
    const end = Math.min(rows.length, i + 20_000);
    for (; i < end; i++) {
      if (terms.every((term) => term(rows[i]))) mask.push(i);
    }
    filterStatus = { ...filterStatus, rows_scanned: i, matched_rows: mask.length };
    if (i < rows.length) {
      setTimeout(step, 0);
      return;
    }
    filterMask = mask;
    filterStatus = { is_filtering: false, is_ready: true, query, rows_scanned: total, total_rows: total, matched_rows: mask.length, error: null };
  };
  setTimeout(step, 30);
  return filterStatus;
}

function compileTerm(headers: string[]): (term: FilterTerm) => (row: string[]) => boolean {
  return (term) => {
    const column = term.column === null ? null : headers.indexOf(term.column);
    const test = matcherFor(term);
    const evaluate = (row: string[]): boolean =>
      column === null ? row.some((cell) => test(cell)) : test(row[column] ?? "");
    return term.negated ? (row) => !evaluate(row) : evaluate;
  };
}

function matcherFor(term: FilterTerm): (cell: string) => boolean {
  if (term.operator === "regex") {
    const regex = new RegExp(term.value, "i");
    return (cell) => regex.test(cell);
  }
  const needle = term.value.toLowerCase();
  if (term.operator === "exact") return (cell) => cell.trim().toLowerCase() === needle;
  return (cell) => cell.toLowerCase().includes(needle);
}

// ------------------------------------------------------------------ sort

function startSort(keys: SortKey[]): SortStatus {
  if (!current) throw new Error("No document is open");
  const rows = current.rows;
  sortStatus = { is_sorting: true, is_ready: false, keys, rows_scanned: 0, total_rows: rows.length, error: null };
  setTimeout(() => {
    const indices = rows.map((_, i) => i);
    const numeric = keys.map((key) => rows.slice(0, 200).every((r) => r[key.column] === "" || !Number.isNaN(Number(r[key.column]))));
    indices.sort((a, b) => {
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        const av = rows[a][key.column] ?? "";
        const bv = rows[b][key.column] ?? "";
        let cmp = numeric[k] ? Number(av) - Number(bv) : av.localeCompare(bv, undefined, { sensitivity: "base", numeric: true });
        if (Number.isNaN(cmp)) cmp = av.localeCompare(bv);
        if (cmp !== 0) return key.direction === "asc" ? cmp : -cmp;
      }
      return a - b;
    });
    sortPerm = indices;
    sortStatus = { is_sorting: false, is_ready: true, keys, rows_scanned: rows.length, total_rows: rows.length, error: null };
  }, 60);
  return sortStatus;
}

// ---------------------------------------------------------------- export

function startExport(targetPath: string, columnIndices: number[] | null): ExportStatus {
  if (!current) throw new Error("No document is open");
  const order = visibleIndices();
  const columns = columnIndices ?? current.headers.map((_, i) => i);
  exportStatus = { is_running: true, is_complete: false, target_path: targetPath, rows_written: 0, total_rows: order.length, error: null };
  setTimeout(() => {
    const delimiter = current!.delimiter;
    const lines = [columns.map((c) => escapeCell(current!.headers[c] ?? "", delimiter)).join(delimiter)];
    for (const i of order) lines.push(columns.map((c) => escapeCell(current!.rows[i][c] ?? "", delimiter)).join(delimiter));
    const blob = new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = targetPath.split(/[\\/]/).pop() || "export.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    exportStatus = { is_running: false, is_complete: true, target_path: targetPath, rows_written: order.length, total_rows: order.length, error: null };
  }, 80);
  return exportStatus;
}

function escapeCell(value: string, delimiter: string): string {
  return value.includes(delimiter) || value.includes('"') || value.includes("\n") ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------- search

function idleSearchProgress(): CsvSearchProgress {
  return {
    query: "",
    total_files: 0,
    current_file_index: 0,
    completed_files: 0,
    current_file: null,
    current_path: null,
    current_row: 0,
    matches: 0,
    matched_files: 0,
    errors: 0,
    truncated: false,
    cancelled: false,
    is_running: false,
  };
}

async function searchFiles(paths: string[], query: string, maxMatches: number): Promise<CsvSearchSummary> {
  searchCancelled = false;
  const needle = query.toLowerCase();
  const matches: CsvSearchMatch[] = [];
  const schemas: CsvSearchSummary["schemas"] = [];
  const errors: CsvSearchSummary["errors"] = [];
  let matchedFiles = 0;
  let truncated = false;
  searchProgress = { ...idleSearchProgress(), query, total_files: paths.length, is_running: true };

  for (let f = 0; f < paths.length && !truncated && !searchCancelled; f++) {
    const path = paths[f];
    const dataset = files.get(path);
    const fileName = path.split(/[\\/]/).pop() || path;
    searchProgress = { ...searchProgress, current_file_index: f + 1, current_file: fileName, current_path: path, current_row: 0 };
    if (!dataset) {
      errors.push({ path, message: "Not loaded in the browser preview" });
      searchProgress = { ...searchProgress, errors: errors.length };
      continue;
    }
    schemas.push({ path, file_name: fileName, headers: dataset.headers });
    let fileHits = 0;
    for (let r = 0; r < dataset.rows.length; r++) {
      const row = dataset.rows[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c].toLowerCase().includes(needle)) {
          matches.push({ path, file_name: fileName, row_index: r + 1, column_index: c, column_name: dataset.headers[c] ?? "", value: row[c], row_values: row });
          fileHits++;
          if (matches.length >= maxMatches) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
      if (r % 2000 === 0) {
        searchProgress = { ...searchProgress, current_row: r, matches: matches.length };
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (searchCancelled) break;
      }
    }
    if (fileHits > 0) matchedFiles++;
    searchProgress = { ...searchProgress, completed_files: f + 1, matches: matches.length, matched_files: matchedFiles };
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  searchProgress = { ...searchProgress, is_running: false, truncated, cancelled: searchCancelled };
  return {
    query,
    searched_files: paths.length,
    matched_files: matchedFiles,
    schemas,
    matches,
    errors,
    truncated,
    cancelled: searchCancelled,
  };
}

// --------------------------------------------------------------- profile

function profileOf(dataset: Dataset): CsvFileProfile {
  const ext = dataset.path.split(".").pop()?.toLowerCase() ?? null;
  const kind = ext === "tsv" || dataset.delimiter === "\t" ? "tsv" : ext === "csv" ? "csv" : "delimited_text";
  return {
    extension: ext,
    detected_kind: kind,
    detected_kind_label: kind === "csv" ? "CSV" : kind === "tsv" ? "TSV" : "Delimited text",
    delimiter: dataset.delimiter.charCodeAt(0),
    delimiter_label: delimiterLabel(dataset.delimiter),
    delimiter_confidence: "high",
    encoding: dataset.encoding,
    encoding_source: dataset.encodingSource,
    sampled_rows: Math.min(256, dataset.rows.length + 1),
    likely_columns: dataset.headers.length,
    binary_like: false,
    has_header: dataset.hasHeader,
    header_source: dataset.headerSource,
    warnings: [],
  };
}

function profileResult(path: string): CsvFileProfileResult {
  const dataset = files.get(path);
  return dataset ? { path, profile: profileOf(dataset), error: null } : { path, profile: null, error: "Not loaded in the browser preview" };
}

function delimiterLabel(delimiter: string): string {
  return { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe", ":": "colon", " ": "space" }[delimiter] ?? "unknown";
}

// ---------------------------------------------------------------- parsing

const rawBytes = new Map<string, Uint8Array>();

function decodeAndParse(path: string, input: Uint8Array | string, sizeBytes?: number, delimiterOverride?: string, encodingOverride?: string, headerOverride?: string): Dataset {
  let text: string;
  let encoding = "utf-8";
  let encodingSource = "utf-8";
  if (typeof input === "string") {
    text = input;
    // Keep bytes so "reopen as" can re-parse seeded samples too.
    rawBytes.set(path, new TextEncoder().encode(input));
  } else {
    rawBytes.set(path, input);
    if (encodingOverride) {
      encoding = encodingOverride === "utf-8-bom" ? "utf-8" : encodingOverride;
      encodingSource = "user";
      text = new TextDecoder(encoding.replace("utf-16-le", "utf-16le").replace("utf-16-be", "utf-16be")).decode(input);
    } else if (input[0] === 0xff && input[1] === 0xfe) {
      encoding = "utf-16-le";
      encodingSource = "bom";
      text = new TextDecoder("utf-16le").decode(input);
    } else if (input[0] === 0xfe && input[1] === 0xff) {
      encoding = "utf-16-be";
      encodingSource = "bom";
      text = new TextDecoder("utf-16be").decode(input);
    } else {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(input);
        if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) encoding = "utf-8-bom";
      } catch {
        encoding = "windows-1252";
        encodingSource = "detected";
        text = new TextDecoder("windows-1252").decode(input);
      }
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = delimiterOverride ?? detectDelimiter(text);
  const records = parseDelimited(text, delimiter).filter((r) => !(r.length === 1 && r[0] === ""));
  const hasHeader =
    headerOverride === "header" ? true : headerOverride === "data" ? false : detectHeader(records.slice(0, HEADER_SAMPLE_ROWS));
  const headerSource = headerOverride === "header" || headerOverride === "data" ? "user" : "detected";
  const headers = hasHeader
    ? (records.shift() ?? [])
    : syntheticHeaders(Math.max(1, ...records.slice(0, HEADER_SAMPLE_ROWS).map((r) => r.length)));
  const width = headers.length;
  const rows = records.map((r) => (r.length === width ? r : [...r.slice(0, width), ...Array(Math.max(0, width - r.length)).fill("")]));
  return { path, headers, rows, delimiter, encoding, encodingSource, hasHeader, headerSource, sizeBytes: sizeBytes ?? new Blob([text]).size };
}

function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024).split(/\r?\n/).slice(0, 50).filter(Boolean);
  let best = ",";
  let bestScore = -1;
  for (const candidate of [",", ";", "\t", "|"]) {
    const counts = sample.map((line) => line.split(candidate).length);
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)] ?? 1;
    if (mode < 2) continue;
    const agreement = counts.filter((c) => c === mode).length / counts.length;
    const score = agreement * 1000 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Build a synthetic endpoint log so the preview has something to show. */
export function generateSampleCsv(rowCount: number): string {
  const procs = ["powershell.exe", "cmd.exe", "svchost.exe", "chrome.exe", "rundll32.exe", "mshta.exe", "wscript.exe", "explorer.exe", "teams.exe", "outlook.exe"];
  const severities = ["low", "low", "medium", "high", "critical"];
  const countries = ["ZA", "US", "DE", "NL", "BR"];
  // mulberry32: small, deterministic, and well distributed (the classic LCG
  // repeated hostnames and hashes every few rows).
  let seed = 0x9e3779b9;
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(list: T[]): T => list[Math.floor(rand() * list.length)];
  const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
  const lines = ["timestamp,hostname,username,process,command_line,parent,sha256,severity,country"];
  let t = Date.UTC(2026, 7, 1);
  for (let i = 0; i < rowCount; i++) {
    t += Math.floor(rand() * 40_000) + 1000;
    const p = pick(procs);
    const cmd = p === "powershell.exe" ? `${p} -enc ${hex(16)}` : `${p} /c echo ${i}`;
    lines.push([new Date(t).toISOString().slice(0, 19), `WS-${String(Math.floor(rand() * 4000)).padStart(5, "0")}`, `user${Math.floor(rand() * 900)}`, p, cmd, pick(procs), hex(64), pick(severities), pick(countries)].join(","));
  }
  return lines.join("\n") + "\n";
}
