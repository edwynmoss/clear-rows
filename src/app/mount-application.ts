
import { CSV_ROW_HEIGHT_PX } from "./constants";
import { directoryOf, fileNameOf, formatBytes, formatEncoding, formatInt, formatRate, pluralize } from "./format";
import {
  forgetRecentFile,
  getRecentFiles,
  getRecentSearchPaths,
  getStoredSearchLimit,
  getStoredSearchMode,
  rememberRecentFile,
  storeRecentSearchPaths,
  storeSearchLimit,
  storeSearchMode,
} from "./preferences";
import { cycleThemeMode, getThemeMode, isDarkTheme, onThemeChange } from "./theme";

import { createAppShell } from "../components/app-shell";
import { createCellDetail } from "../components/cell-detail";
import { createColumnVisibilityControl } from "../components/column-visibility-control";
import { createCommandPalette, type Command } from "../components/command-palette";
import { createCsvEmptyState } from "../components/csv-empty-state";
import { createCsvPreviewGrid } from "../components/csv-preview-grid";
import { createErrorCard } from "../components/error-card";
import { createFilterBuilder } from "../components/filter-builder";
import { createJumpToRow } from "../components/jump-to-row";
import { createQueryBar, type QueryMode } from "../components/query-bar";
import { createReopenAsControl, ENCODING_OPTIONS } from "../components/reopen-as-control";
import { createSearchView } from "../components/search-view";
import { createStatusBar } from "../components/status-bar";
import { createToastHost } from "../components/toast";
import { createTopBar } from "../components/top-bar";

import * as csvApi from "../csv/csv-api";
import { CsvSession, type ActiveSort } from "../csv/csv-session";
import { parseFilterQuery, splitFilterTokens, type FilterTerm } from "../csv/filter-query";
import { CsvGridVirtualizer, type HighlightedCell } from "../csv/grid-virtualizer";
import { isDesktopRuntime } from "../tauri/runtime";
import { appVersion, pickFile, pickFiles, pickSavePath, wireFileDrop } from "../tauri/platform";
import { checkForUpdate, installPendingUpdate, type UpdateInfo } from "./updates";
import { columnTypeLabel } from "../csv/column-types";
import type {
  CsvFileProfileResult,
  CsvSearchMatch,
  ExportStatus,
  FilterStatus,
  OpenSummary,
  SortKey,
  SortStatus,
} from "../types/csv";

const INDEX_POLL_MS = 350;
const SEARCH_POLL_MS = 200;
const SORT_POLL_MS = 250;
const FILTER_POLL_MS = 200;
const EXPORT_POLL_MS = 250;
const JUMP_POLL_MS = 200;
const GUTTER_WIDTH_PX = 52;

export function mountApplication(host: HTMLElement): void {
  const desktop = isDesktopRuntime();
  void desktop;
  const session = new CsvSession();

  // ---------------------------------------------------------------- state
  let isOpening = false;
  let openGeneration = 0;
  let indexGeneration = 0;
  let isIndexing = false;
  let searchPaths: string[] = [];
  let searchProfiles: CsvFileProfileResult[] | null = null;
  let searchGeneration = 0;
  let isSearchRunning = false;
  let resultJumpGeneration = 0;
  let sortGeneration = 0;
  let filterGeneration = 0;
  let exportGeneration = 0;
  let activeFilterTokens: string[] = [];
  let pendingFilter: string | null = null;
  let fileSizeBytes = 0;
  let appVersionLabel = __APP_VERSION__;
  let columnMenuEl: HTMLDivElement | null = null;

  // ----------------------------------------------------------- components
  const toasts = createToastHost();
  const statusBar = createStatusBar();

  const grid = createCsvPreviewGrid({ rowHeightPx: CSV_ROW_HEIGHT_PX, gutterWidthPx: GUTTER_WIDTH_PX });
  const virtualizer = new CsvGridVirtualizer({
    refs: grid,
    session,
    fetchRows: csvApi.fetchCsvRows,
    rowHeightPx: CSV_ROW_HEIGHT_PX,
    gutterWidthPx: GUTTER_WIDTH_PX,
    onHighlightChange: (cell) => updatePositionMeta(cell),
    onColumnMenu: (columnIndex, anchor) => openColumnMenu(columnIndex, anchor),
  });

  const cellDetail = createCellDetail({
    onClose: () => {
      cellDetail.hide();
      grid.scrollRegion.focus({ preventScroll: true });
    },
    onCopy: (text) => void copyText(text, "Copied value"),
    onFilterToValue: (column, value) => {
      const needsQuotes = /[\s:"=/]/.test(value);
      const term = `${quoteColumn(column)}=${needsQuotes ? `"${value.replace(/"/g, '""')}"` : value}`;
      void applyFilter(appendTerm(term));
    },
  });

  const jumpToRow = createJumpToRow({
    onApply: (rowNumber) => void runJumpToRow(rowNumber),
  });

  const gridArea = document.createElement("div");
  gridArea.className = "cr-gridarea";
  const gridColumn = document.createElement("div");
  gridColumn.className = "cr-gridcolumn";
  gridColumn.append(jumpToRow.root, grid.root);
  gridArea.append(gridColumn, cellDetail.root);

  const emptyState = createCsvEmptyState({
    onOpenClick: () => void runOpenDialog(),
    onOpenRecent: (path) => void openPath(path),
    onForgetRecent: (path) => {
      forgetRecentFile(path);
      emptyState.setRecent(getRecentFiles());
    },
  });

  const searchView = createSearchView({
    onOpenResult: (match) => void openSearchResult(match),
    onEditFiles: () => void pickSearchFiles(),
    onBackToFile: () => showFileView(),
  });

  const errorCard = createErrorCard({
    encodings: ENCODING_OPTIONS,
    onReopen: (encoding) => {
      if (!lastOpenAttempt) return;
      errorCard.hide();
      void openPath(lastOpenAttempt, { encodingOverride: encoding });
    },
    onDismiss: () => showFileView(),
    onOpenOther: () => void runOpenDialog(),
  });
  let lastOpenAttempt: string | null = null;

  const reopenAsControl = createReopenAsControl({
    onApply: ({ delimiter, encoding, header }) => {
      if (!session.path) return;
      void openPath(session.path, {
        delimiterOverride: delimiter,
        encodingOverride: encoding,
        headerOverride: header === "auto" ? undefined : header,
      });
    },
  });

  const columnVisibilityControl = createColumnVisibilityControl({
    onChange: (hidden) => {
      session.hiddenColumns = hidden;
      virtualizer.scheduleRefresh();
    },
  });

  const themeButton = document.createElement("button");
  themeButton.type = "button";
  themeButton.className = "cr-icon-btn";
  function syncThemeButton(): void {
    const mode = getThemeMode();
    themeButton.title = `Theme: ${mode === "system" ? "follows system" : mode} · click to change`;
    themeButton.setAttribute("aria-label", themeButton.title);
    themeButton.innerHTML = isDarkTheme()
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/></svg>`;
  }
  themeButton.addEventListener("click", () => {
    const mode = cycleThemeMode();
    syncThemeButton();
    toasts.show({ title: `Theme: ${mode === "system" ? "follows system" : mode}`, duration: 1800 });
  });
  onThemeChange(() => syncThemeButton());
  syncThemeButton();

  const paletteButton = document.createElement("button");
  paletteButton.type = "button";
  paletteButton.className = "cr-btn cr-btn-secondary cr-palette-trigger";
  paletteButton.innerHTML = `<span>Commands</span><kbd>Ctrl K</kbd>`;
  paletteButton.addEventListener("click", () => palette.open());

  const topBar = createTopBar({
    onOpen: () => void runOpenDialog(),
    onExport: () => void runExport(),
    onFileChipClick: () => reopenAsControl.toggle(),
    fileChipExtras: [reopenAsControl.root],
    trailing: [columnVisibilityControl.root, paletteButton, themeButton],
  });

  const queryBar = createQueryBar({
    initialMode: getStoredSearchMode(),
    initialLimit: getStoredSearchLimit(),
    onSubmit: (mode, query, limit) => {
      if (mode === "file") {
        filterBuilder.close();
        void applyFilter(query);
      } else {
        void runSearch(query, limit);
      }
    },
    onClear: (mode) => {
      if (mode === "file") void clearFilter();
      else {
        searchGeneration++;
        searchView.clear();
      }
    },
    onCancel: () => void cancelCurrent(),
    onModeChange: (mode) => {
      storeSearchMode(mode);
      syncModeView(mode);
    },
    onLimitChange: (limit) => storeSearchLimit(limit),
    onPickFiles: () => void pickSearchFiles(),
    onRemoveTerm: (index) => {
      const next = activeFilterTokens.filter((_, i) => i !== index);
      void applyFilter(next.join(" "));
    },
    onFocusChange: (focused, mode) => {
      window.clearTimeout(builderBlurTimer);
      if (focused) {
        if (mode === "file" && session.path && !builderDismissed) filterBuilder.open(queryBar.field, queryBar.input.value);
        return;
      }
      // Leaving the field forgets an explicit close; the next visit opens again.
      builderDismissed = false;
      // Let a click inside the builder land before deciding to close.
      builderBlurTimer = window.setTimeout(() => {
        if (!filterBuilder.contains(document.activeElement)) filterBuilder.close();
      }, 120);
    },
    onInput: (text, mode) => {
      if (mode === "file") filterBuilder.setTyped(text);
    },
    onEscape: () => {
      // First Escape only closes the builder; the query and its filter stay.
      if (!filterBuilder.isOpen()) return false;
      filterBuilder.close();
      builderDismissed = true;
      return true;
    },
  });

  const sampleCache = new Map<string, Promise<string[] | null>>();
  const filterBuilder = createFilterBuilder({
    headers: () => session.headers,
    sampleValues: (columnIndex) => {
      const key = `${session.path ?? ""}#${columnIndex}`;
      let pending = sampleCache.get(key);
      if (!pending) {
        pending = sampleColumnValues(columnIndex);
        sampleCache.set(key, pending);
      }
      return pending;
    },
    onAddTerm: (term, replacesTyped) => {
      void applyFilter(composeWithTerm(term, replacesTyped));
      queryBar.focus({ caretAtEnd: true });
      filterBuilder.setTyped(queryBar.input.value);
    },
    onSearchAll: (text) => {
      const needsQuotes = /[\s:"=/]/.test(text) || text.startsWith("-");
      void applyFilter(composeWithTerm(needsQuotes ? `"${text.replace(/"/g, '""')}"` : text, true));
      queryBar.focus({ caretAtEnd: true });
      filterBuilder.setTyped(queryBar.input.value);
    },
    onClose: () => {
      builderDismissed = true;
      queryBar.focus({ caretAtEnd: true });
    },
  });
  let builderBlurTimer = 0;
  /** True after the user closed the builder while still in the field. */
  let builderDismissed = false;
  // Clicking into an already-focused field brings a closed builder back.
  queryBar.input.addEventListener("click", () => {
    if (queryBar.getMode() !== "file" || !session.path || filterBuilder.isOpen()) return;
    builderDismissed = false;
    filterBuilder.open(queryBar.field, queryBar.input.value);
  });

  async function sampleColumnValues(columnIndex: number): Promise<string[] | null> {
    if (!session.path) return null;
    const distinct = new Set<string>();
    const rowsToSample = Math.min(session.rowCount, 1024);
    for (let start = 0; start < rowsToSample; start += 256) {
      const batch = await csvApi.fetchCsvRows(start, Math.min(256, rowsToSample - start), columnIndex, 1);
      for (const row of batch.rows) {
        const value = (row[0] ?? "").trim();
        if (value.length > 0 && value.length <= 80) distinct.add(value);
        if (distinct.size > 40) return null;
      }
    }
    return Array.from(distinct).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }

  const palette = createCommandPalette({ commands: () => buildCommands() });

  const shell = createAppShell({
    topBar: topBar.root,
    queryBar: queryBar.root,
    statusBar: statusBar.root,
    toasts: toasts.root,
    overlays: [palette.root, filterBuilder.root],
  });

  shell.showView(emptyState.root);
  shell.main.append(gridArea, searchView.root, errorCard.root);
  gridArea.hidden = true;
  searchView.root.hidden = true;
  errorCard.root.hidden = true;

  emptyState.setRecent(getRecentFiles());
  statusBar.setMeta({ version: `v${appVersionLabel}` });
  statusBar.setMessage("Ready", "neutral");
  syncAvailability();
  virtualizer.bind();
  host.replaceChildren(shell.root);

  // Offer a newer release once per launch, a few seconds after start so the
  // file the user opened is on screen first. Manual checks come from the palette.
  window.setTimeout(() => void offerUpdate(false), 4_000);

  void appVersion().then((version) => {
    if (!version) return;
    appVersionLabel = version;
    statusBar.setMeta({ version: `v${version}` });
  });
  void openStartupFile();
  wireFileDrop({
    onOver: () => {
      emptyState.setDragOver(true);
      gridArea.dataset.dragOver = "true";
    },
    onLeave: () => {
      emptyState.setDragOver(false);
      delete gridArea.dataset.dragOver;
    },
    onDrop: (path) => void openPath(path),
  });

  // ------------------------------------------------------------ views
  function showFileView(): void {
    errorCard.hide();
    if (session.path) {
      shell.showView(gridArea);
    } else {
      shell.showView(emptyState.root);
    }
    searchView.root.hidden = true;
    queryBar.setMode("file");
    syncAvailability();
  }

  function showSearchView(): void {
    errorCard.hide();
    shell.showView(searchView.root);
    gridArea.hidden = true;
    emptyState.root.hidden = true;
  }

  function syncModeView(mode: QueryMode): void {
    if (mode === "files") {
      showSearchView();
      if (searchPaths.length === 0) {
        searchView.setFiles([], null);
        searchView.clear();
      }
    } else {
      showFileView();
    }
    syncAvailability();
  }

  function syncAvailability(): void {
    queryBar.setAvailability({
      hasFile: session.path !== null,
      searchFileCount: searchPaths.length,
      searchFileBytes: 0,
    });
    searchView.setHasFile(session.path !== null);
    columnVisibilityControl.setEnabled(session.path !== null);
    reopenAsControl.setEnabled(session.path !== null);
  }

  function syncFileChip(): void {
    if (!session.path || !session.profile) {
      topBar.setFile(null);
      statusBar.setMeta({ encoding: "", delimiter: "", position: "" });
      return;
    }
    const profile = session.profile;
    topBar.setFile({
      name: fileNameOf(session.path),
      rows: session.rowCount,
      columns: session.headers.length,
      sizeBytes: fileSizeBytes,
      encoding: profile.encoding,
      encodingSource: profile.encoding_source,
      delimiterLabel: profile.delimiter_label,
      isIndexing,
      hasWarning: profile.warnings.some((w) => !isSoftWarning(w)) || profile.encoding === "utf-8-lossy",
    });
    statusBar.setMeta({
      encoding: formatEncoding(profile.encoding),
      delimiter: profile.delimiter_label ?? "",
    });
    reopenAsControl.setDefaults({
      delimiterChar: typeof profile.delimiter === "number" ? String.fromCharCode(profile.delimiter) : null,
      encoding: profile.encoding,
      header: profile.has_header ? "header" : "data",
    });
  }

  function updatePositionMeta(cell: HighlightedCell | null): void {
    if (!cell || !session.path) {
      statusBar.setMeta({ position: "" });
      return;
    }
    const total = session.scrollRowCount;
    statusBar.setMeta({ position: `row ${formatInt(cell.rowIndex + 1)} of ${formatInt(total)}` });
  }

  // ------------------------------------------------------------- open
  async function runOpenDialog(): Promise<void> {
    if (isOpening) return;
    let selection: string | null;
    try {
      selection = await pickFile();
    } catch (err) {
      toasts.show({ title: "Could not open the file dialog", detail: formatError(err), tone: "negative" });
      return;
    }
    if (!selection) return;
    await openPath(selection);
  }

  async function openPath(path: string, overrides: csvApi.OpenCsvOptions = {}): Promise<void> {
    if (isOpening) return;
    isOpening = true;
    const generation = ++openGeneration;
    indexGeneration++;
    resultJumpGeneration++;
    sortGeneration++;
    filterGeneration++;
    exportGeneration++;
    pendingFilter = null;
    lastOpenAttempt = path;
    virtualizer.setPendingSortColumn(null);
    cellDetail.hide();
    closeColumnMenu();
    toasts.clear();
    statusBar.setActivity({ label: "opening", ratio: null, detail: fileNameOf(path) });
    statusBar.setMessage("", "neutral");

    let summary: OpenSummary;
    try {
      summary = await csvApi.openCsv(path, overrides);
    } catch (err) {
      isOpening = false;
      if (generation !== openGeneration) return;
      statusBar.setActivity(null);
      const message = formatError(err);
      const encodingIssue = /encoding|binary/i.test(message);
      errorCard.show({
        title: encodingIssue ? "Couldn't read this file as text" : "Couldn't open this file",
        message: encodingIssue
          ? `${fileNameOf(path)} looks binary or uses an encoding that wasn't recognised. Pick the encoding it was saved in and try again.`
          : message,
        preview: null,
        currentEncoding: overrides.encodingOverride ?? null,
        offerReopen: encodingIssue,
        isWarning: false,
      });
      shell.showView(errorCard.root);
      statusBar.setMessage(message, "negative");
      return;
    }

    if (generation !== openGeneration) {
      isOpening = false;
      return;
    }

    session.applySummary(summary);
    fileSizeBytes = summary.file_size;
    activeFilterTokens = [];
    queryBar.setChips([]);
    queryBar.setCount(null, null);
    queryBar.setError(null);
    queryBar.setValue("");
    virtualizer.reset();
    virtualizer.updateAria();
    columnVisibilityControl.setColumns(session.headers, session.hiddenColumns);
    jumpToRow.close();
    isIndexing = !summary.is_complete && !summary.error;
    virtualizer.setIndexing(isIndexing);
    syncFileChip();
    syncAvailability();
    showFileView();
    rememberRecentFile({ path, rows: summary.is_complete ? summary.row_count : undefined, sizeBytes: summary.file_size });
    emptyState.setRecent(getRecentFiles());

    // Column widths from the header and a sample of rows.
    try {
      const sampleCount = Math.min(64, summary.row_count);
      const sample = sampleCount > 0 ? await csvApi.fetchCsvRows(0, sampleCount, 0, session.headers.length) : { rows: [] as string[][] };
      if (generation === openGeneration) virtualizer.autoFitColumns(sample.rows);
    } catch {
      // Keep default widths.
    }
    await virtualizer.refresh();
    isOpening = false;

    if (summary.error) {
      statusBar.setActivity(null);
      statusBar.setMessage(summary.error, "negative");
      toasts.show({ title: "Indexing stopped", detail: summary.error, tone: "negative" });
      return;
    }

    surfaceProfileWarnings(summary);

    if (summary.is_complete) {
      statusBar.setActivity(null);
      statusBar.setMessage(`${pluralize(summary.row_count, "row")} · ${pluralize(session.headers.length, "column")}`, "neutral");
      return;
    }

    void pollIndexing(generation, summary.indexed_bytes);
  }

  function surfaceProfileWarnings(summary: OpenSummary): void {
    const profile = summary.profile;
    const warning = profile.warnings.find((w) => !isSoftWarning(w));
    if (profile.encoding === "utf-8-lossy") {
      toasts.show({
        title: "Some characters couldn't be decoded",
        detail: "The file isn't valid UTF-8. Choose the encoding it was saved in.",
        tone: "warning",
        duration: 0,
        action: { label: "Change encoding", onClick: () => reopenAsControl.toggle() },
      });
      return;
    }
    if (profile.encoding_source === "detected" && !profile.encoding.startsWith("utf-")) {
      toasts.show({
        title: `Decoded as ${formatEncoding(profile.encoding)}`,
        detail: "Detected from the file's bytes. If text looks wrong, pick another encoding.",
        tone: "neutral",
        duration: 7000,
        action: { label: "Change", onClick: () => reopenAsControl.toggle() },
      });
    }
    if (warning) {
      toasts.show({ title: warning, tone: "warning", duration: 8000 });
    }
    if (!profile.has_header && profile.header_source === "detected") {
      toasts.show({
        title: "First row looks like data, so columns are numbered",
        detail: "If that row is really the column names, change it under the file name.",
        tone: "neutral",
        duration: 9000,
        action: { label: "Change", onClick: () => reopenAsControl.toggle() },
      });
    }
  }

  async function pollIndexing(generation: number, startBytes: number): Promise<void> {
    const gen = ++indexGeneration;
    let lastBytes = startBytes;
    let lastTime = performance.now();
    let rate = 0;
    while (generation === openGeneration && gen === indexGeneration) {
      await wait(INDEX_POLL_MS);
      if (generation !== openGeneration || gen !== indexGeneration) return;
      let status;
      try {
        status = await csvApi.getCsvIndexStatus();
      } catch (err) {
        statusBar.setActivity(null);
        statusBar.setMessage(`Index status error: ${formatError(err)}`, "negative");
        return;
      }
      if (generation !== openGeneration || gen !== indexGeneration || status.path !== session.path) return;

      const change = session.applyIndexStatus(status);
      virtualizer.updateAria();
      if (change.scrollExtentChanged || virtualizer.isViewportPastRow(change.previousRowCount)) {
        virtualizer.scheduleRefresh();
      }

      const now = performance.now();
      const seconds = (now - lastTime) / 1000;
      if (seconds > 0.5) {
        const instant = (status.indexed_bytes - lastBytes) / seconds;
        rate = rate === 0 ? instant : rate * 0.6 + instant * 0.4;
        lastBytes = status.indexed_bytes;
        lastTime = now;
      }
      const ratio = status.file_size > 0 ? status.indexed_bytes / status.file_size : null;
      statusBar.setActivity({
        label: "indexing",
        ratio,
        detail: `${formatInt(status.row_count)} rows · ${formatBytes(status.indexed_bytes)} of ${formatBytes(status.file_size)}${rate > 0 ? ` · ${formatRate(rate)}` : ""}`,
      });
      syncFileChip();

      if (status.error) {
        isIndexing = false;
        virtualizer.setIndexing(false);
        statusBar.setActivity(null);
        statusBar.setMessage(status.error, "negative");
        toasts.show({ title: "Indexing stopped", detail: status.error, tone: "negative" });
        syncFileChip();
        return;
      }
      if (status.is_complete) {
        isIndexing = false;
        virtualizer.setIndexing(false);
        virtualizer.scheduleRefresh();
        statusBar.setActivity(null);
        statusBar.setMessage(`${pluralize(status.row_count, "row")} · ${pluralize(session.headers.length, "column")}`, "neutral");
        syncFileChip();
        rememberRecentFile({ path: session.path ?? "", rows: status.row_count, sizeBytes: status.file_size });
        if (pendingFilter !== null) {
          const query = pendingFilter;
          pendingFilter = null;
          void applyFilter(query);
        }
        return;
      }
    }
  }

  async function openStartupFile(): Promise<void> {
    try {
      const path = await csvApi.getStartupCsvPath();
      if (path) await openPath(path);
    } catch (err) {
      toasts.show({ title: "Startup file could not be opened", detail: formatError(err), tone: "negative" });
    }
  }

  // ------------------------------------------------------------ filter
  function quoteColumn(column: string): string {
    return /[\s:"=/]/.test(column) ? `"${column}"` : column;
  }

  function appendTerm(term: string): string {
    return [...activeFilterTokens, term].join(" ");
  }

  /**
   * Query text with `term` added to whatever is in the filter box, including
   * words typed but not yet applied. When the term was built from the word
   * being typed, that word is replaced instead of kept.
   */
  function composeWithTerm(term: string, replacesTyped: boolean): string {
    let base = queryBar.input.value.trim();
    if (replacesTyped) base = base.replace(/\S+$/, "").trim();
    return base.length > 0 ? `${base} ${term}` : term;
  }

  async function applyFilter(query: string): Promise<void> {
    if (!session.path || isOpening) return;
    const trimmed = query.trim();
    queryBar.setValue(trimmed);
    queryBar.setError(null);

    if (trimmed.length === 0) {
      await clearFilter();
      return;
    }

    const parsed = parseFilterQuery(trimmed, session.headers);
    if (parsed.error) {
      queryBar.setError(parsed.error);
      return;
    }
    if (parsed.terms.length === 0) {
      await clearFilter();
      return;
    }

    if (isIndexing) {
      pendingFilter = trimmed;
      queryBar.setChips(parsed.terms);
      statusBar.setMessage("Filter will run when indexing finishes", "busy");
      return;
    }

    const generation = ++filterGeneration;
    queryBar.setBusy(true);
    statusBar.setActivity({ label: "filtering", ratio: null, detail: "", onCancel: () => void clearFilter() });

    try {
      await csvApi.startCsvFilter(trimmed);
    } catch (err) {
      if (generation !== filterGeneration) return;
      queryBar.setBusy(false);
      statusBar.setActivity(null);
      queryBar.setError(formatError(err));
      return;
    }

    let tokens: string[] = [];
    try {
      tokens = splitFilterTokens(trimmed);
    } catch {
      tokens = [trimmed];
    }
    await pollFilter(generation, trimmed, tokens, parsed.terms);
  }

  async function pollFilter(generation: number, query: string, tokens: string[], terms: FilterTerm[]): Promise<void> {
    while (generation === filterGeneration) {
      let status: FilterStatus;
      try {
        status = await csvApi.getCsvFilterStatus();
      } catch (err) {
        if (generation !== filterGeneration) return;
        queryBar.setBusy(false);
        statusBar.setActivity(null);
        queryBar.setError(formatError(err));
        return;
      }
      if (generation !== filterGeneration) return;

      if (status.error) {
        queryBar.setBusy(false);
        statusBar.setActivity(null);
        queryBar.setError(status.error);
        return;
      }
      if (status.is_ready && !status.is_filtering) {
        session.applyActiveFilter({ query, matchedRows: status.matched_rows });
        activeFilterTokens = tokens;
        queryBar.setChips(terms);
        queryBar.setCount(status.matched_rows, status.total_rows);
        queryBar.setBusy(false);
        statusBar.setActivity(null);
        statusBar.setMessage(
          status.matched_rows === 0 ? "No rows match" : `${formatInt(status.matched_rows)} of ${formatInt(status.total_rows)} rows match`,
          status.matched_rows === 0 ? "warning" : "neutral",
        );
        virtualizer.resetRowsForVisibilityChange();
        virtualizer.updateAria();
        jumpToRow.setMaxRow(session.scrollRowCount);
        return;
      }
      if (!status.is_filtering && !status.is_ready) {
        queryBar.setBusy(false);
        statusBar.setActivity(null);
        return;
      }
      statusBar.setActivity({
        label: "filtering",
        ratio: status.total_rows > 0 ? status.rows_scanned / status.total_rows : null,
        detail: `${formatInt(status.rows_scanned)} of ${formatInt(status.total_rows)} rows · ${formatInt(status.matched_rows)} match`,
        onCancel: () => void clearFilter(),
      });
      await wait(FILTER_POLL_MS);
    }
  }

  async function clearFilter(): Promise<void> {
    if (!session.path) return;
    const generation = ++filterGeneration;
    pendingFilter = null;
    try {
      await csvApi.clearCsvFilter();
    } catch (err) {
      if (generation === filterGeneration) queryBar.setError(formatError(err));
      return;
    }
    if (generation !== filterGeneration) return;
    const hadFilter = session.activeFilter !== null;
    session.applyActiveFilter(null);
    activeFilterTokens = [];
    queryBar.setChips([]);
    queryBar.setCount(null, null);
    queryBar.setBusy(false);
    queryBar.setValue("");
    statusBar.setActivity(null);
    if (hadFilter) statusBar.setMessage(`${pluralize(session.rowCount, "row")}`, "neutral");
    virtualizer.resetRowsForVisibilityChange();
    virtualizer.updateAria();
    jumpToRow.setMaxRow(session.scrollRowCount);
  }

  // -------------------------------------------------------------- sort
  async function runSort(columnIndex: number, addToCurrent: boolean): Promise<void> {
    if (!session.path || isOpening) return;
    if (columnIndex < 0 || columnIndex >= session.headers.length) return;
    if (isIndexing) {
      toasts.show({ title: "Sorting is available once indexing finishes", tone: "neutral", duration: 2500 });
      return;
    }
    const generation = ++sortGeneration;
    const keys = nextSortKeys(session.activeSort, columnIndex, addToCurrent);
    await applySortKeys(generation, keys, columnIndex);
  }

  async function setSortDirection(columnIndex: number, direction: "asc" | "desc"): Promise<void> {
    if (!session.path || isIndexing) return;
    const generation = ++sortGeneration;
    await applySortKeys(generation, [{ column: columnIndex, direction }], columnIndex);
  }

  async function applySortKeys(generation: number, keys: SortKey[], pendingColumn: number): Promise<void> {
    if (keys.length === 0) {
      try {
        await csvApi.clearCsvSort();
        if (generation !== sortGeneration) return;
        session.activeSort = [];
        virtualizer.setPendingSortColumn(null);
        virtualizer.resetRowsForVisibilityChange();
        statusBar.setMessage("Sort cleared", "neutral");
      } catch (err) {
        if (generation === sortGeneration) toasts.show({ title: "Couldn't clear sort", detail: formatError(err), tone: "negative" });
      }
      return;
    }
    const summary = describeSortKeys(keys, session.headers);
    virtualizer.setPendingSortColumn(pendingColumn);
    statusBar.setActivity({ label: "sorting", ratio: null, detail: summary });
    try {
      await csvApi.startCsvSort(keys);
    } catch (err) {
      if (generation !== sortGeneration) return;
      virtualizer.setPendingSortColumn(null);
      statusBar.setActivity(null);
      toasts.show({ title: "Couldn't sort", detail: formatError(err), tone: "negative" });
      return;
    }
    await pollSort(generation, keys, summary);
  }

  async function pollSort(generation: number, keys: SortKey[], summary: string): Promise<void> {
    while (generation === sortGeneration) {
      let status: SortStatus;
      try {
        status = await csvApi.getCsvSortStatus();
      } catch (err) {
        if (generation !== sortGeneration) return;
        virtualizer.setPendingSortColumn(null);
        statusBar.setActivity(null);
        toasts.show({ title: "Sort status error", detail: formatError(err), tone: "negative" });
        return;
      }
      if (generation !== sortGeneration) return;
      if (status.error) {
        virtualizer.setPendingSortColumn(null);
        statusBar.setActivity(null);
        toasts.show({ title: "Couldn't sort", detail: status.error, tone: "negative" });
        return;
      }
      if (status.is_ready && !status.is_sorting) {
        session.activeSort = status.keys.length > 0 ? status.keys : keys;
        virtualizer.setPendingSortColumn(null);
        virtualizer.resetRowsForVisibilityChange();
        statusBar.setActivity(null);
        statusBar.setMessage(`Sorted ${summary}`, "neutral");
        return;
      }
      if (!status.is_sorting && !status.is_ready) {
        virtualizer.setPendingSortColumn(null);
        statusBar.setActivity(null);
        return;
      }
      statusBar.setActivity({
        label: "sorting",
        ratio: status.total_rows > 0 ? status.rows_scanned / status.total_rows : null,
        detail: `${summary} · ${formatInt(status.rows_scanned)} of ${formatInt(status.total_rows)} rows`,
      });
      await wait(SORT_POLL_MS);
    }
  }

  function nextSortKeys(activeSort: ActiveSort, columnIndex: number, addToCurrent: boolean): SortKey[] {
    if (!addToCurrent) {
      const isSoleKey = activeSort.length === 1 && activeSort[0].column === columnIndex;
      if (!isSoleKey) return [{ column: columnIndex, direction: "asc" }];
      if (activeSort[0].direction === "asc") return [{ column: columnIndex, direction: "desc" }];
      return [];
    }
    const existingIndex = activeSort.findIndex((k) => k.column === columnIndex);
    if (existingIndex < 0) return [...activeSort, { column: columnIndex, direction: "asc" }];
    const next = activeSort.slice();
    if (activeSort[existingIndex].direction === "asc") {
      next[existingIndex] = { column: columnIndex, direction: "desc" };
      return next;
    }
    next.splice(existingIndex, 1);
    return next;
  }

  function describeSortKeys(keys: SortKey[], headers: string[]): string {
    const parts = keys.map((key) => `${headers[key.column] || `column ${key.column + 1}`} ${key.direction === "asc" ? "↑" : "↓"}`);
    return parts.length === 1 ? `by ${parts[0]}` : `by ${parts.join(", then ")}`;
  }

  // ------------------------------------------------------------ export
  async function runExport(presetTarget?: string): Promise<void> {
    if (!session.path || isOpening) return;
    const defaultName = suggestExportFileName(session.path, session.activeFilter, session.activeSort);
    let target: string | null = presetTarget ?? null;
    if (!target) {
      try {
        target = await pickSavePath(defaultName);
      } catch (err) {
        toasts.show({ title: "Could not open the save dialog", detail: formatError(err), tone: "negative" });
        return;
      }
    }
    if (!target) return;

    const generation = ++exportGeneration;
    topBar.setExportBusy(true);
    statusBar.setActivity({ label: "exporting", ratio: null, detail: fileNameOf(target), onCancel: () => void csvApi.cancelCsvExport() });
    const started = Date.now();

    let initial: ExportStatus;
    try {
      initial = await csvApi.startCsvExport(target, session.visibleColumnIndices());
    } catch (err) {
      if (generation !== exportGeneration) return;
      topBar.setExportBusy(false);
      statusBar.setActivity(null);
      toasts.show({ title: "Export failed", detail: formatError(err), tone: "negative" });
      return;
    }
    if (generation !== exportGeneration) return;
    if (initial.error) {
      topBar.setExportBusy(false);
      statusBar.setActivity(null);
      toasts.show({ title: "Export failed", detail: initial.error, tone: "negative" });
      return;
    }

    while (generation === exportGeneration) {
      await wait(EXPORT_POLL_MS);
      let status: ExportStatus;
      try {
        status = await csvApi.getCsvExportStatus();
      } catch (err) {
        if (generation !== exportGeneration) return;
        topBar.setExportBusy(false);
        statusBar.setActivity(null);
        toasts.show({ title: "Export status error", detail: formatError(err), tone: "negative" });
        return;
      }
      if (generation !== exportGeneration) return;
      if (status.error) {
        topBar.setExportBusy(false);
        statusBar.setActivity(null);
        toasts.show({ title: "Export failed", detail: status.error, tone: "negative" });
        return;
      }
      if (status.is_complete && !status.is_running) {
        topBar.setExportBusy(false);
        statusBar.setActivity(null);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        toasts.show({
          title: `Exported ${pluralize(status.rows_written, "row")} → ${fileNameOf(target)}`,
          detail: `${directoryOf(target)} · ${seconds} s`,
          tone: "positive",
          duration: 8000,
        });
        statusBar.setMessage(`Exported ${pluralize(status.rows_written, "row")}`, "neutral");
        return;
      }
      if (!status.is_running && !status.is_complete) {
        topBar.setExportBusy(false);
        statusBar.setActivity(null);
        statusBar.setMessage("Export cancelled", "neutral");
        return;
      }
      statusBar.setActivity({
        label: "exporting",
        ratio: status.total_rows > 0 ? status.rows_written / status.total_rows : null,
        detail: `${formatInt(status.rows_written)} of ${formatInt(status.total_rows)} rows`,
        onCancel: () => void csvApi.cancelCsvExport(),
      });
    }
  }

  function suggestExportFileName(sourcePath: string, filter: { query: string } | null, sort: ActiveSort): string {
    const base = fileNameOf(sourcePath);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const tags: string[] = [];
    if (filter) tags.push("filtered");
    if (sort.length > 0) tags.push("sorted");
    return `${stem}${tags.length > 0 ? `-${tags.join("-")}` : "-export"}.csv`;
  }

  // ------------------------------------------------------------ search
  async function pickSearchFiles(): Promise<void> {
    let paths: string[] | null;
    try {
      paths = await pickFiles();
    } catch (err) {
      toasts.show({ title: "Could not open the file dialog", detail: formatError(err), tone: "negative" });
      return;
    }
    if (!paths || paths.length === 0) return;
    await applySearchFiles(paths, true);
  }

  async function applySearchFiles(paths: string[], persist: boolean): Promise<void> {
    searchPaths = paths;
    searchProfiles = null;
    queryBar.setMode("files");
    storeSearchMode("files");
    showSearchView();
    searchView.setFiles(paths, null);
    searchView.clear();
    syncAvailability();
    try {
      searchProfiles = await csvApi.profileCsvFiles(paths);
      searchView.setFiles(paths, searchProfiles);
      searchView.clear();
      const binary = searchProfiles.filter((p) => p.profile?.binary_like).length;
      if (binary > 0) {
        toasts.show({ title: `${pluralize(binary, "file")} look binary and will be skipped`, tone: "warning" });
      }
    } catch (err) {
      toasts.show({ title: "Couldn't profile the selected files", detail: formatError(err), tone: "negative" });
    }
    if (persist) storeRecentSearchPaths(paths);
    queryBar.focus();
  }

  async function runSearch(query: string, limit: number): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    if (searchPaths.length === 0) {
      await pickSearchFiles();
      if (searchPaths.length === 0) return;
    }
    const generation = ++searchGeneration;
    storeSearchLimit(limit);
    isSearchRunning = true;
    showSearchView();
    searchView.clear();
    queryBar.setBusy(true);
    statusBar.setActivity({ label: "searching", ratio: null, detail: `“${trimmed}”`, onCancel: () => void cancelCurrent() });
    void pollSearch(generation);

    try {
      const summary = await csvApi.searchCsvFiles(searchPaths, trimmed, limit);
      if (generation !== searchGeneration) return;
      searchView.setProgress(null);
      searchView.setSummary(summary);
      searchView.setActiveMatch(null);
      statusBar.setActivity(null);
      statusBar.setMessage(
        summary.cancelled
          ? `Search cancelled · ${pluralize(summary.matches.length, "match", "matches")} kept`
          : `${pluralize(summary.matches.length, "match", "matches")} in ${pluralize(summary.matched_files, "file")}`,
        summary.errors.length > 0 ? "warning" : "neutral",
      );
      if (summary.truncated) {
        toasts.show({ title: `Stopped at the ${formatInt(limit)} match limit`, detail: "Raise the limit or narrow the search.", tone: "neutral" });
      }
      for (const error of summary.errors.slice(0, 2)) {
        toasts.show({ title: fileNameOf(error.path), detail: error.message, tone: "warning", duration: 8000 });
      }
    } catch (err) {
      if (generation !== searchGeneration) return;
      statusBar.setActivity(null);
      toasts.show({ title: "Search failed", detail: formatError(err), tone: "negative" });
    } finally {
      if (generation === searchGeneration) {
        isSearchRunning = false;
        queryBar.setBusy(false);
      }
    }
  }

  async function pollSearch(generation: number): Promise<void> {
    while (generation === searchGeneration && isSearchRunning) {
      await wait(SEARCH_POLL_MS);
      if (generation !== searchGeneration || !isSearchRunning) return;
      try {
        const progress = await csvApi.getCsvSearchProgress();
        if (generation !== searchGeneration || !isSearchRunning) return;
        searchView.setProgress(progress);
        statusBar.setActivity({
          label: "searching",
          ratio: progress.total_files > 0 ? progress.completed_files / progress.total_files : null,
          detail: `${formatInt(progress.completed_files)} of ${formatInt(progress.total_files)} files · ${formatInt(progress.matches)} match${progress.matches === 1 ? "" : "es"}`,
          onCancel: () => void cancelCurrent(),
        });
        if (!progress.is_running) return;
      } catch {
        return;
      }
    }
  }

  async function cancelCurrent(): Promise<void> {
    if (isSearchRunning) {
      try {
        await csvApi.cancelCsvSearch();
      } catch (err) {
        toasts.show({ title: "Couldn't cancel", detail: formatError(err), tone: "negative" });
      }
      return;
    }
    if (session.activeFilter === null && filterGeneration > 0) {
      await clearFilter();
    }
  }

  async function openSearchResult(match: CsvSearchMatch): Promise<void> {
    if (isOpening) return;
    const generation = ++resultJumpGeneration;
    const targetRowIndex = Math.max(0, match.row_index - 1);
    searchView.setActiveMatch(match);

    if (session.path !== match.path) {
      await openPath(match.path);
    } else {
      showFileView();
    }
    if (generation !== resultJumpGeneration || session.path !== match.path) return;

    while (generation === resultJumpGeneration && session.path === match.path) {
      if (targetRowIndex < session.rowCount) {
        await virtualizer.scrollToCell(targetRowIndex, match.column_index);
        statusBar.setMessage(`${match.file_name} · row ${formatInt(match.row_index)} · ${match.column_name || `column ${match.column_index + 1}`}`, "neutral");
        return;
      }
      await wait(JUMP_POLL_MS);
      if (!isIndexing) {
        statusBar.setMessage(`Row ${formatInt(match.row_index)} is beyond the end of the indexed file`, "warning");
        return;
      }
    }
  }

  // ------------------------------------------------- jump, copy, detail
  async function runJumpToRow(rowNumber: number): Promise<void> {
    if (!session.path) return;
    const max = session.scrollRowCount;
    if (max === 0 || rowNumber < 1 || rowNumber > max) {
      jumpToRow.setStatus(`Row must be between 1 and ${formatInt(max)}.`, "negative");
      return;
    }
    try {
      await virtualizer.scrollToCell(rowNumber - 1, virtualizer.getHighlightedCell()?.columnIndex ?? session.visibleColumnIndices()[0] ?? 0);
      jumpToRow.close();
    } catch (err) {
      jumpToRow.setStatus(formatError(err), "negative");
    }
  }

  async function copyText(text: string, title: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toasts.show({ title, tone: "positive", duration: 1800 });
    } catch (err) {
      toasts.show({ title: "Copy failed", detail: formatError(err), tone: "negative" });
    }
  }

  async function copyHighlighted(scope: "cell" | "row"): Promise<void> {
    const sel = virtualizer.getHighlightedCell();
    if (!sel) {
      toasts.show({ title: "Select a cell first", tone: "neutral", duration: 2000 });
      return;
    }
    const visible = session.visibleColumnIndices();
    if (visible.length === 0) return;
    const colStart = scope === "cell" ? sel.columnIndex : visible[0];
    const colEnd = scope === "cell" ? sel.columnIndex : visible[visible.length - 1];
    try {
      const batch = await csvApi.fetchCsvRows(sel.rowIndex, 1, colStart, colEnd - colStart + 1);
      const row = batch.rows[0];
      if (!row) return;
      const text = scope === "cell" ? row[0] ?? "" : visible.map((c) => row[c - colStart] ?? "").join("\t");
      await copyText(text, scope === "cell" ? "Copied cell" : `Copied row ${formatInt(sel.rowIndex + 1)}`);
    } catch (err) {
      toasts.show({ title: "Copy failed", detail: formatError(err), tone: "negative" });
    }
  }

  async function openCellDetail(cell: HighlightedCell | null = virtualizer.getHighlightedCell()): Promise<void> {
    if (!cell || !session.path) return;
    try {
      const batch = await csvApi.fetchCsvRows(cell.rowIndex, 1, cell.columnIndex, 1);
      const value = batch.rows[0]?.[0] ?? "";
      cellDetail.show({
        column: session.headers[cell.columnIndex] ?? "",
        columnIndex: cell.columnIndex,
        rowNumber: cell.rowIndex + 1,
        value,
      });
    } catch (err) {
      toasts.show({ title: "Couldn't read that cell", detail: formatError(err), tone: "negative" });
    }
  }

  // -------------------------------------------------------- column menu
  function openColumnMenu(columnIndex: number, anchor: HTMLElement): void {
    closeColumnMenu();
    const header = session.headers[columnIndex] || `Column ${columnIndex + 1}`;
    const menu = document.createElement("div");
    menu.className = "cr-menu";
    menu.setAttribute("role", "menu");

    const head = document.createElement("div");
    head.className = "cr-menu-head";
    head.textContent = `${header} · ${columnTypeLabel(session.columnTypes[columnIndex]?.type)}`;
    menu.append(head);

    const items: Array<{ label: string; run: () => void; disabled?: boolean }> = [
      { label: "Sort ascending", run: () => void setSortDirection(columnIndex, "asc"), disabled: isIndexing },
      { label: "Sort descending", run: () => void setSortDirection(columnIndex, "desc"), disabled: isIndexing },
      { label: "Clear sort", run: () => void applySortKeys(++sortGeneration, [], columnIndex), disabled: session.activeSort.length === 0 },
      { label: "Filter empty cells", run: () => void applyFilter(appendTerm(`${quoteColumn(header)}=""`)) },
      { label: "Auto-fit width", run: () => virtualizer.autoFitColumn(columnIndex) },
      { label: "Hide column", run: () => hideColumn(columnIndex), disabled: session.visibleColumnIndices().length <= 1 },
      { label: "Copy column name", run: () => void copyText(header, "Copied column name") },
    ];
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cr-menu-item";
      button.setAttribute("role", "menuitem");
      button.textContent = item.label;
      button.disabled = Boolean(item.disabled);
      button.addEventListener("click", () => {
        closeColumnMenu();
        item.run();
      });
      menu.append(button);
    }

    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;
    document.body.append(menu);
    columnMenuEl = menu;
    window.setTimeout(() => document.addEventListener("pointerdown", handleMenuOutside, { capture: true, once: true }), 0);
  }

  function handleMenuOutside(event: PointerEvent): void {
    if (columnMenuEl && event.target instanceof Node && columnMenuEl.contains(event.target)) {
      document.addEventListener("pointerdown", handleMenuOutside, { capture: true, once: true });
      return;
    }
    closeColumnMenu();
  }

  function closeColumnMenu(): void {
    columnMenuEl?.remove();
    columnMenuEl = null;
  }

  function hideColumn(columnIndex: number): void {
    const next = new Set(session.hiddenColumns);
    next.add(columnIndex);
    session.hiddenColumns = next;
    columnVisibilityControl.setColumns(session.headers, next);
    virtualizer.scheduleRefresh();
    toasts.show({
      title: `Hid ${session.headers[columnIndex] || `column ${columnIndex + 1}`}`,
      tone: "neutral",
      duration: 4000,
      action: {
        label: "Undo",
        onClick: () => {
          const restored = new Set(session.hiddenColumns);
          restored.delete(columnIndex);
          session.hiddenColumns = restored;
          columnVisibilityControl.setColumns(session.headers, restored);
          virtualizer.scheduleRefresh();
        },
      },
    });
  }

  // ---------------------------------------------------------- commands
  function buildCommands(): Command[] {
    const hasFile = session.path !== null;
    return [
      { id: "open", label: "Open file…", shortcut: "Ctrl O", run: () => void runOpenDialog() },
      { id: "filter", label: "Filter rows", hint: "process:powershell -user:svc /regex/", shortcut: "Ctrl F", enabled: hasFile, run: () => { queryBar.setMode("file"); syncModeView("file"); queryBar.focus(); } },
      { id: "search", label: "Search across files", shortcut: "Ctrl Shift F", run: () => { queryBar.setMode("files"); syncModeView("files"); queryBar.focus(); } },
      { id: "files", label: "Choose files to search…", run: () => void pickSearchFiles() },
      { id: "recent-search", label: "Restore last search file set", enabled: getRecentSearchPaths().length > 0, run: () => void applySearchFiles(getRecentSearchPaths(), false) },
      { id: "jump", label: "Go to row…", shortcut: "Ctrl G", enabled: hasFile, run: () => { jumpToRow.setMaxRow(session.scrollRowCount); jumpToRow.open(); } },
      { id: "detail", label: "Show cell detail", shortcut: "Enter", enabled: hasFile && virtualizer.getHighlightedCell() !== null, run: () => void openCellDetail() },
      { id: "copy-cell", label: "Copy selected cell", shortcut: "Ctrl C", enabled: hasFile, run: () => void copyHighlighted("cell") },
      { id: "copy-row", label: "Copy selected row", shortcut: "Ctrl Shift C", enabled: hasFile, run: () => void copyHighlighted("row") },
      { id: "clear-filter", label: "Clear filter", shortcut: "Esc", enabled: session.activeFilter !== null, run: () => void clearFilter() },
      { id: "clear-sort", label: "Clear sort", enabled: session.activeSort.length > 0, run: () => void applySortKeys(++sortGeneration, [], -1) },
      { id: "columns", label: "Show or hide columns…", enabled: hasFile, run: () => columnVisibilityControl.open() },
      { id: "autofit", label: "Auto-fit all columns", enabled: hasFile, run: () => void refitColumns() },
      { id: "reopen", label: "Reopen with a different encoding or delimiter…", enabled: hasFile, run: () => reopenAsControl.toggle() },
      { id: "export", label: "Export current view…", shortcut: "Ctrl E", enabled: hasFile, run: () => void runExport() },
      { id: "theme", label: `Theme: ${getThemeMode()} → change`, run: () => { cycleThemeMode(); syncThemeButton(); } },
      { id: "update", label: "Check for updates", enabled: isDesktopRuntime(), run: () => void offerUpdate(true) },
      { id: "close", label: "Close file", enabled: hasFile, run: () => closeFile() },
    ];
  }

  let updateOffered: UpdateInfo | null = null;
  let updateInstalling = false;

  /** Ask GitHub for a newer release; show it as a toast. */
  async function offerUpdate(manual: boolean): Promise<void> {
    if (updateInstalling) return;
    if (manual) statusBar.setMessage("Checking for updates", "neutral");
    const info = await checkForUpdate();
    if (!info) {
      if (manual) {
        statusBar.setMessage("", "neutral");
        toasts.show({ title: `Clear Rows ${appVersionLabel} is up to date`, tone: "neutral", duration: 4000 });
      }
      return;
    }
    if (!manual && updateOffered?.version === info.version) return;
    updateOffered = info;
    if (manual) statusBar.setMessage("", "neutral");
    toasts.show({
      title: `Version ${info.version} is available`,
      detail: firstLine(info.notes) || `You have ${info.currentVersion}. The update installs in the background and restarts the app.`,
      tone: "neutral",
      duration: 0,
      action: { label: "Install and restart", onClick: () => void installUpdate() },
    });
  }

  async function installUpdate(): Promise<void> {
    if (updateInstalling) return;
    updateInstalling = true;
    toasts.clear();
    statusBar.setActivity({ label: "updating", ratio: null, detail: "downloading" });
    try {
      await installPendingUpdate((progress) => {
        const detail = progress.total ? `${formatBytes(progress.downloaded)} of ${formatBytes(progress.total)}` : formatBytes(progress.downloaded);
        statusBar.setActivity({ label: "updating", ratio: progress.ratio, detail });
      });
      statusBar.setActivity({ label: "restarting", ratio: 1, detail: "" });
    } catch (err) {
      updateInstalling = false;
      statusBar.setActivity(null);
      toasts.show({ title: "The update could not be installed", detail: formatError(err), tone: "warning", duration: 0 });
    }
  }

  function firstLine(text: string): string {
    return text.split(/\r?\n/).map((line) => line.replace(/^[#*\-\s]+/, "").trim()).find((line) => line.length > 0) ?? "";
  }

  async function refitColumns(): Promise<void> {
    if (!session.path) return;
    try {
      const sample = await csvApi.fetchCsvRows(0, Math.min(64, session.rowCount), 0, session.headers.length);
      virtualizer.autoFitColumns(sample.rows);
    } catch {
      /* ignore */
    }
  }

  function closeFile(): void {
    filterBuilder.close();
    sampleCache.clear();
    openGeneration++;
    indexGeneration++;
    sortGeneration++;
    filterGeneration++;
    exportGeneration++;
    session.path = null;
    session.profile = null;
    session.headers = [];
    session.rowCount = 0;
    session.scrollRowCount = 0;
    session.activeFilter = null;
    session.activeSort = [];
    isIndexing = false;
    virtualizer.reset();
    cellDetail.hide();
    columnVisibilityControl.setColumns([], new Set());
    queryBar.setChips([]);
    queryBar.setCount(null, null);
    queryBar.setValue("");
    syncFileChip();
    syncAvailability();
    showFileView();
    statusBar.setActivity(null);
    statusBar.setMessage("Ready", "neutral");
  }

  // --------------------------------------------------------- grid events
  grid.headerViewport.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest(".cr-col-resize, .cr-col-menu")) return;
    const cell = target.closest<HTMLElement>("[data-column-index]");
    if (!cell) return;
    const columnIndex = Number.parseInt(cell.dataset.columnIndex ?? "", 10);
    if (Number.isNaN(columnIndex)) return;
    void runSort(columnIndex, event.shiftKey);
  });

  grid.scrollRegion.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const cell = target.closest<HTMLElement>("[data-column-index]");
    const row = target.closest<HTMLElement>("[data-row-index]");
    if (!cell || !row || row.dataset.skeleton === "true") return;
    const columnIndex = Number.parseInt(cell.dataset.columnIndex ?? "", 10);
    const rowIndex = Number.parseInt(row.dataset.rowIndex ?? "", 10);
    if (Number.isNaN(columnIndex) || Number.isNaN(rowIndex)) return;
    virtualizer.setHighlightedCell({ rowIndex, columnIndex });
    if (cellDetail.isOpen()) void openCellDetail({ rowIndex, columnIndex });
  });

  grid.scrollRegion.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const cell = target.closest<HTMLElement>("[data-column-index]");
    const row = target.closest<HTMLElement>("[data-row-index]");
    if (!cell || !row || row.dataset.skeleton === "true") return;
    const columnIndex = Number.parseInt(cell.dataset.columnIndex ?? "", 10);
    const rowIndex = Number.parseInt(row.dataset.rowIndex ?? "", 10);
    if (Number.isNaN(columnIndex) || Number.isNaN(rowIndex)) return;
    void openCellDetail({ rowIndex, columnIndex });
  });

  grid.scrollRegion.addEventListener("keydown", (event) => {
    if (!session.path) return;
    const handled = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case "ArrowDown":
        virtualizer.moveHighlight(1, 0);
        handled();
        break;
      case "ArrowUp":
        virtualizer.moveHighlight(-1, 0);
        handled();
        break;
      case "ArrowLeft":
        virtualizer.moveHighlight(0, -1);
        handled();
        break;
      case "ArrowRight":
        virtualizer.moveHighlight(0, 1);
        handled();
        break;
      case "PageDown":
        virtualizer.moveHighlight(1, 0, { page: true });
        handled();
        break;
      case "PageUp":
        virtualizer.moveHighlight(-1, 0, { page: true });
        handled();
        break;
      case "Home":
        virtualizer.moveHighlightToEdge(event.ctrlKey ? "top" : "start");
        handled();
        break;
      case "End":
        virtualizer.moveHighlightToEdge(event.ctrlKey ? "bottom" : "end");
        handled();
        break;
      case "Enter":
        void openCellDetail();
        handled();
        break;
      case "Escape":
        if (cellDetail.isOpen()) cellDetail.hide();
        else virtualizer.setHighlightedCell(null);
        handled();
        break;
    }
  });

  // --------------------------------------------------- global shortcuts
  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    const target = event.target;
    const inEditable =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);

    if (mod && key === "k") {
      event.preventDefault();
      palette.toggle();
      return;
    }
    if (palette.isOpen()) return;
    if (mod && key === "o") {
      event.preventDefault();
      void runOpenDialog();
      return;
    }
    if (mod && key === "f") {
      event.preventDefault();
      const mode: QueryMode = event.shiftKey ? "files" : "file";
      queryBar.setMode(mode);
      syncModeView(mode);
      queryBar.focus();
      return;
    }
    if (mod && key === "g" && session.path) {
      event.preventDefault();
      jumpToRow.setMaxRow(session.scrollRowCount);
      if (jumpToRow.isOpen()) jumpToRow.close();
      else jumpToRow.open();
      return;
    }
    if (mod && key === "e" && session.path) {
      event.preventDefault();
      void runExport();
      return;
    }
    if (mod && key === "c" && session.path && !inEditable) {
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) return;
      if (virtualizer.getHighlightedCell() === null) return;
      event.preventDefault();
      void copyHighlighted(event.shiftKey ? "row" : "cell");
      return;
    }
    if (event.key === "Escape" && filterBuilder.isOpen()) {
      filterBuilder.close();
      builderDismissed = true;
      return;
    }
    if (event.key === "Escape" && !inEditable) {
      closeColumnMenu();
      if (cellDetail.isOpen()) {
        cellDetail.hide();
        return;
      }
      if (isSearchRunning) {
        void cancelCurrent();
      }
    }
  });

  if (import.meta.env.DEV) {
    // Test hooks for driving the app over the DevTools protocol in development.
    (window as unknown as { __clearRows: unknown }).__clearRows = {
      openPath,
      applyFilter,
      clearFilter,
      applySearchFiles,
      runSearch,
      runExportTo: (target: string) => runExport(target),
      closeFile,
      openCellDetail,
      session,
    };
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function isSoftWarning(warning: string): boolean {
    return warning.startsWith("Extension is CSV but detected");
  }
}
