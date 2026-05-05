import { open } from "@tauri-apps/plugin-dialog";

import type { StatusBanner } from "../components/status-banner";

import { isDesktopRuntime } from "../tauri/runtime";
import * as csvApi from "./csv-api";
import type { CsvGridVirtualizer } from "./grid-virtualizer";
import type { CsvSession } from "./csv-session";
import type { CsvFileProfile, IndexStatus, OpenSummary } from "../types/csv";

const INDEX_POLL_INTERVAL_MS = 600;

let openGeneration = 0;

async function pickCsvPath(): Promise<string | null> {
  const selection = await open({
    multiple: false,
    filters: [{ name: "Delimited text", extensions: ["csv", "tsv", "txt"] }],
  });

  if (selection === null || Array.isArray(selection)) {
    return null;
  }

  return selection;
}

export type OpenCsvCallbacks = {
  onDatasetOpened?: () => void;
};

export async function openCsvFromDialog(
  status: StatusBanner,
  session: CsvSession,
  virtualizer: CsvGridVirtualizer,
  callbacks?: OpenCsvCallbacks,
): Promise<void> {
  if (!isDesktopRuntime()) {
    status.setText("Open CSV is available in the Clear Rows desktop app.", "neutral");
    return;
  }

  status.setText("Choose a UTF-8 CSV file…", "neutral");

  try {
    const path = await pickCsvPath();
    if (path === null) {
      status.setText("Cancelled.", "neutral");
      return;
    }

    await openCsvFromPath(path, status, session, virtualizer, callbacks);
  } catch (err) {
    console.error(err);
    status.setText(`Error: ${formatError(err)}`, "negative");
  }
}

export async function openCsvFromPath(
  path: string,
  status: StatusBanner,
  session: CsvSession,
  virtualizer: CsvGridVirtualizer,
  callbacks?: OpenCsvCallbacks,
): Promise<void> {
  const generation = ++openGeneration;
  status.setText("Indexing… this may take a moment on large files.", "busy");

  try {
    const summary = await csvApi.openCsv(path);
    if (generation !== openGeneration) {
      return;
    }

    session.applySummary(summary);
    virtualizer.reset();

    virtualizer.updateAria();
    await virtualizer.refresh();

    callbacks?.onDatasetOpened?.();

    status.setText(formatOpenStatus(summary, session.headers.length), "busy");

    if (summary.is_complete || summary.error) {
      status.setText(formatOpenStatus(summary, session.headers.length), getOpenStatusTone(summary));
      return;
    }

    void pollIndexStatus(generation, status, session, virtualizer);
  } catch (err) {
    if (generation !== openGeneration) {
      return;
    }

    console.error(err);
    status.setText(`Error: ${formatError(err)}`, "negative");
  }
}

async function pollIndexStatus(
  generation: number,
  status: StatusBanner,
  session: CsvSession,
  virtualizer: CsvGridVirtualizer,
): Promise<void> {
  while (generation === openGeneration) {
    await wait(INDEX_POLL_INTERVAL_MS);

    if (generation !== openGeneration) {
      return;
    }

    try {
      const indexStatus = await csvApi.getCsvIndexStatus();
      if (generation !== openGeneration) {
        return;
      }

      const indexChange = session.applyIndexStatus(indexStatus);
      virtualizer.updateAria();

      if (
        indexChange.scrollExtentChanged ||
        virtualizer.isViewportPastRow(indexChange.previousRowCount)
      ) {
        virtualizer.scheduleRefresh();
      }

      status.setText(
        formatIndexStatus(indexStatus, session.headers.length, session.profile),
        getIndexStatusTone(indexStatus, session.profile),
      );

      if (indexStatus.is_complete || indexStatus.error) {
        return;
      }
    } catch (err) {
      if (generation === openGeneration) {
        console.error(err);
        status.setText(`Index status error: ${formatError(err)}`, "negative");
      }
      return;
    }
  }
}

function formatOpenStatus(summary: OpenSummary, columnCount: number): string {
  return formatIndexDetails({
    path: summary.path,
    rowCount: summary.row_count,
    isComplete: summary.is_complete,
    indexedBytes: summary.indexed_bytes,
    fileSize: summary.file_size,
    columnCount,
    delimiter: summary.delimiter,
    profile: summary.profile,
    error: summary.error,
  });
}

function formatIndexStatus(
  status: IndexStatus,
  columnCount: number,
  profile: CsvFileProfile | null,
): string {
  return formatIndexDetails({
    path: status.path,
    rowCount: status.row_count,
    isComplete: status.is_complete,
    indexedBytes: status.indexed_bytes,
    fileSize: status.file_size,
    columnCount,
    profile: profile ?? undefined,
    error: status.error,
  });
}

function formatIndexDetails(options: {
  path: string;
  rowCount: number;
  isComplete: boolean;
  indexedBytes: number;
  fileSize: number;
  columnCount: number;
  delimiter?: number;
  profile?: CsvFileProfile;
  error: string | null;
}): string {
  const pathTail = options.path.replace(/^.*[/\\]/, "") || options.path;
  const indexed = options.rowCount.toLocaleString();
  const progress = formatProgress(options.indexedBytes, options.fileSize);

  if (options.error) {
    return [
      pathTail,
      `Indexed ${indexed} rows before error`,
      options.error,
    ].join("\n");
  }

  const details = formatFileProfile(options.profile, options.delimiter);
  const warning = formatProfileWarning(options.profile);

  if (options.isComplete) {
    return [
      `${pathTail} · ${indexed} rows · ${options.columnCount.toLocaleString()} columns`,
      details,
      warning,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `${pathTail} · indexing ${indexed} rows · ${progress} · ${options.columnCount.toLocaleString()} columns`,
    details,
    warning,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatFileProfile(
  profile: CsvFileProfile | undefined,
  delimiter: number | undefined,
): string {
  if (!profile) {
    return formatDelimiterCode(delimiter);
  }

  const kind = profile.detected_kind_label;
  const delimiterLabel = profile.delimiter_label
    ? `${formatLabel(profile.delimiter_label)}-delimited`
    : "";
  const parts = [
    delimiterLabel ? `${delimiterLabel} ${kind}` : kind,
    profile.delimiter_confidence !== "high"
      ? `${formatLabel(profile.delimiter_confidence)} confidence`
      : "",
    formatEncoding(profile.encoding),
  ].filter((part): part is string => Boolean(part));

  return parts.join(" · ");
}

function formatProfileWarning(profile: CsvFileProfile | undefined): string {
  const warning = profile?.warnings.find((item) => !isSoftProfileWarning(item));

  return warning ? `Check: ${warning}` : "";
}

function isSoftProfileWarning(warning: string): boolean {
  return warning.startsWith("Extension is CSV but detected");
}

function formatDelimiterCode(delimiter: number | undefined): string {
  if (delimiter === undefined) {
    return "";
  }

  return `Delimiter U+${delimiter.toString(16).toUpperCase().padStart(2, "0")}`;
}

function getOpenStatusTone(summary: OpenSummary): "positive" | "warning" | "negative" {
  if (summary.error) {
    return "negative";
  }

  return hasActionableProfileWarning(summary.profile) ? "warning" : "positive";
}

function getIndexStatusTone(
  status: IndexStatus,
  profile: CsvFileProfile | null,
): "busy" | "positive" | "warning" | "negative" {
  if (status.error) {
    return "negative";
  }

  if (!status.is_complete) {
    return "busy";
  }

  return profile && hasActionableProfileWarning(profile) ? "warning" : "positive";
}

function hasActionableProfileWarning(profile: CsvFileProfile): boolean {
  return profile.warnings.some((warning) => !isSoftProfileWarning(warning));
}

function formatEncoding(encoding: string): string {
  const labels: Record<string, string> = {
    "utf-8": "UTF-8",
    "utf-8-bom": "UTF-8 BOM",
    "utf-8-lossy": "UTF-8 lossy",
  };

  return labels[encoding] ?? encoding.toUpperCase();
}

function formatLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatProgress(indexedBytes: number, fileSize: number): string {
  if (fileSize <= 0) {
    return "scanning";
  }

  const percent = Math.min(100, Math.max(0, (indexedBytes / fileSize) * 100));
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
