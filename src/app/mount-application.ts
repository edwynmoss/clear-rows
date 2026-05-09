import type { AppShell } from "../components/app-shell";
import { CSV_ROW_HEIGHT_PX } from "./constants";
import { createAppShell } from "../components/app-shell";
import { createCsvEmptyState } from "../components/csv-empty-state";
import { createCsvFilterBar } from "../components/csv-filter-bar";
import { createCsvPreviewGrid } from "../components/csv-preview-grid";
import { createColumnVisibilityControl } from "../components/column-visibility-control";
import { createCsvSearchPanel } from "../components/csv-search-panel";
import { createExportButton } from "../components/export-button";
import { createJumpToRow } from "../components/jump-to-row";
import { createReopenAsControl } from "../components/reopen-as-control";
import { createSearchResultsTable } from "../components/search-results-table";
import { createThemeToggle } from "../components/theme-toggle";
import {
  getRecentSearchPaths,
  getStoredSearchLimit,
  storeRecentSearchPaths,
  storeSearchLimit,
} from "./preferences";
import { CsvGridVirtualizer } from "../csv/grid-virtualizer";
import { openCsvFromDialog, openCsvFromPath } from "../csv/open-csv-flow";
import { pickCsvSearchPaths } from "../csv/search-csv-flow";
import { CsvSession } from "../csv/csv-session";
import * as csvApi from "../csv/csv-api";
import { isDesktopRuntime } from "../tauri/runtime";
import type {
  CsvFileProfileResult,
  CsvSearchMatch,
  CsvSearchProgress,
  ExportStatus,
  FilterStatus,
  SortKey,
  SortStatus,
} from "../types/csv";
import type { ActiveSort } from "../csv/csv-session";
import { save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

const JUMP_POLL_INTERVAL_MS = 200;
const SEARCH_PROGRESS_POLL_INTERVAL_MS = 200;
const SORT_PROGRESS_POLL_INTERVAL_MS = 250;
const FILTER_PROGRESS_POLL_INTERVAL_MS = 250;
const EXPORT_PROGRESS_POLL_INTERVAL_MS = 250;

export function mountApplication(host: HTMLElement): void {
  const hasDesktopRuntime = isDesktopRuntime();
  const session = new CsvSession();

  const grid = createCsvPreviewGrid({ rowHeightPx: CSV_ROW_HEIGHT_PX });
  const virtualizer = new CsvGridVirtualizer({
    refs: grid,
    session,
    fetchRows: csvApi.fetchCsvRows,
    rowHeightPx: CSV_ROW_HEIGHT_PX,
  });

  const workspace = document.createElement("div");
  workspace.className = "flex min-h-0 flex-1 flex-col gap-2 overflow-hidden";

  grid.root.classList.add("hidden", "min-h-0", "flex-1");

  const empty = createCsvEmptyState({
    onOpenClick: () => {
      void runOpenFlow();
    },
  });

  const searchResults = createSearchResultsTable({
    onOpenResult: (match) => {
      void openSearchResult(match);
    },
    onViewDataset: () => {
      revealDataset();
    },
  });

  let shell!: AppShell;
  let isOpening = false;
  let searchPaths: string[] = [];
  let searchGeneration = 0;
  let isSearchRunning = false;
  let isSearchCancelling = false;
  let resultJumpGeneration = 0;
  let sortGeneration = 0;
  let filterGeneration = 0;
  let exportGeneration = 0;

  const searchPanel = createCsvSearchPanel({
    initialLimit: getStoredSearchLimit(),
    hasRecentSearchSet: getRecentSearchPaths().length > 0,
    onPickFiles: () => {
      void pickSearchFiles();
    },
    onRestoreRecentSearchSet: () => {
      void restoreRecentSearchSet();
    },
    onSearch: (query, limit) => {
      void runSearch(query, limit);
    },
    onLimitChange: (limit) => {
      storeSearchLimit(limit);
    },
    onCancelSearch: () => {
      void cancelSearch();
    },
  });

  const reopenAsControl = createReopenAsControl({
    onApply: ({ delimiter, encoding }) => {
      void runReopenAs(delimiter, encoding);
    },
  });

  const exportButton = createExportButton({
    onClick: () => {
      void runExportFlow();
    },
  });

  const columnVisibilityControl = createColumnVisibilityControl({
    onChange: (hidden) => {
      session.hiddenColumns = hidden;
      virtualizer.scheduleRefresh();
    },
  });

  const filterBar = createCsvFilterBar({
    onApply: (query) => {
      void runFilterFlow(query);
    },
    onClear: () => {
      void runClearFilter();
    },
  });

  const jumpToRow = createJumpToRow({
    onApply: (rowNumber) => {
      void runJumpToRow(rowNumber);
    },
  });

  async function runJumpToRow(rowNumber: number): Promise<void> {
    if (!session.path) {
      return;
    }

    const max = Math.max(0, session.scrollRowCount);
    if (max === 0) {
      jumpToRow.setStatus("No rows to jump to.", "negative");
      return;
    }

    if (rowNumber < 1 || rowNumber > max) {
      jumpToRow.setStatus(
        `Row ${rowNumber.toLocaleString()} is out of range (1–${max.toLocaleString()}).`,
        "negative",
      );
      return;
    }

    try {
      // 1-indexed in the UI; scrollToCell takes a 0-indexed scroll-row position.
      await virtualizer.scrollToCell(rowNumber - 1, 0);
      shell.status.setText(`Jumped to row ${rowNumber.toLocaleString()}.`, "positive");
      jumpToRow.close();
    } catch (err) {
      jumpToRow.setStatus(formatError(err), "negative");
    }
  }

  async function runFilterFlow(query: string): Promise<void> {
    if (!session.path || isOpening) {
      return;
    }

    const trimmed = query.trim();
    const generation = ++filterGeneration;

    if (trimmed.length === 0) {
      await runClearFilter();
      return;
    }

    filterBar.setBusy(true);
    filterBar.setStatus("Scanning…");
    shell.status.setText(`Filtering rows containing “${trimmed}”…`, "busy");

    try {
      await csvApi.startCsvFilter(trimmed);
    } catch (err) {
      if (generation === filterGeneration) {
        filterBar.setBusy(false);
        const message = formatError(err);
        filterBar.setStatus(message, "negative");
        shell.status.setText(`Filter error: ${message}`, "negative");
      }
      return;
    }

    await pollFilterStatus(generation, trimmed);
  }

  async function runClearFilter(): Promise<void> {
    if (!session.path) {
      return;
    }
    const generation = ++filterGeneration;

    try {
      await csvApi.clearCsvFilter();
    } catch (err) {
      if (generation === filterGeneration) {
        const message = formatError(err);
        filterBar.setStatus(message, "negative");
        shell.status.setText(`Clear filter error: ${message}`, "negative");
      }
      return;
    }

    if (generation !== filterGeneration) {
      return;
    }
    session.applyActiveFilter(null);
    filterBar.setActiveQuery(null);
    filterBar.setBusy(false);
    filterBar.setStatus("");
    virtualizer.resetRowsForVisibilityChange();
    virtualizer.updateAria();
    shell.status.setText("Filter cleared.", "neutral");
  }

  async function pollFilterStatus(generation: number, query: string): Promise<void> {
    while (generation === filterGeneration) {
      let status: FilterStatus;
      try {
        status = await csvApi.getCsvFilterStatus();
      } catch (err) {
        if (generation === filterGeneration) {
          const message = formatError(err);
          filterBar.setBusy(false);
          filterBar.setStatus(message, "negative");
          shell.status.setText(`Filter status error: ${message}`, "negative");
        }
        return;
      }

      if (generation !== filterGeneration) {
        return;
      }

      if (status.error) {
        filterBar.setBusy(false);
        filterBar.setStatus(status.error, "negative");
        shell.status.setText(`Filter error: ${status.error}`, "negative");
        return;
      }

      if (status.is_ready && !status.is_filtering) {
        const matched = status.matched_rows;
        const total = status.total_rows;
        session.applyActiveFilter({ query, matchedRows: matched });
        filterBar.setActiveQuery(query);
        filterBar.setBusy(false);
        filterBar.setStatus(formatFilterMatches(matched, total));
        virtualizer.resetRowsForVisibilityChange();
        virtualizer.updateAria();
        shell.status.setText(
          `Filter applied · ${matched.toLocaleString()} of ${total.toLocaleString()} rows match.`,
          matched === 0 ? "neutral" : "positive",
        );
        return;
      }

      if (!status.is_filtering && !status.is_ready) {
        // Cancelled or never started.
        filterBar.setBusy(false);
        filterBar.setStatus("");
        return;
      }

      filterBar.setStatus(formatFilterProgress(status));
      shell.status.setText(formatFilterProgress(status), "busy");
      await wait(FILTER_PROGRESS_POLL_INTERVAL_MS);
    }
  }

  function formatFilterProgress(status: FilterStatus): string {
    const scanned = status.rows_scanned.toLocaleString();
    const matched = status.matched_rows.toLocaleString();
    if (status.total_rows > 0) {
      const total = status.total_rows.toLocaleString();
      return `Scanning ${scanned} of ${total} rows · ${matched} match${
        status.matched_rows === 1 ? "" : "es"
      }…`;
    }
    return `Scanning ${scanned} rows · ${matched} match${
      status.matched_rows === 1 ? "" : "es"
    }…`;
  }

  function formatFilterMatches(matched: number, total: number): string {
    return `${matched.toLocaleString()} of ${total.toLocaleString()} rows match`;
  }

  async function runSortFlow(columnIndex: number, addToCurrent: boolean): Promise<void> {
    if (!session.path || isOpening) {
      return;
    }

    if (columnIndex < 0 || columnIndex >= session.headers.length) {
      return;
    }

    const generation = ++sortGeneration;
    const nextKeys = nextSortKeys(session.activeSort, columnIndex, addToCurrent);

    if (nextKeys.length === 0) {
      try {
        await csvApi.clearCsvSort();
        if (generation !== sortGeneration) {
          return;
        }
        session.activeSort = [];
        virtualizer.setPendingSortColumn(null);
        virtualizer.resetRowsForVisibilityChange();
        shell.status.setText("Sort cleared.", "neutral");
      } catch (err) {
        if (generation === sortGeneration) {
          console.error(err);
          shell.status.setText(`Clear sort error: ${formatError(err)}`, "negative");
        }
      }
      return;
    }

    const summary = describeSortKeys(nextKeys, session.headers);
    // The pending indicator only marks the column the user just clicked, even
    // when the sort is multi-key — the others retain their existing arrows.
    virtualizer.setPendingSortColumn(columnIndex);
    shell.status.setText(`Sorting ${summary}…`, "busy");

    try {
      await csvApi.startCsvSort(nextKeys);
    } catch (err) {
      if (generation === sortGeneration) {
        virtualizer.setPendingSortColumn(null);
        console.error(err);
        shell.status.setText(`Sort error: ${formatError(err)}`, "negative");
      }
      return;
    }

    await pollSortStatus(generation, nextKeys);
  }

  async function pollSortStatus(
    generation: number,
    keys: SortKey[],
  ): Promise<void> {
    const summary = describeSortKeys(keys, session.headers);
    while (generation === sortGeneration) {
      let status: SortStatus;
      try {
        status = await csvApi.getCsvSortStatus();
      } catch (err) {
        if (generation === sortGeneration) {
          console.error(err);
          shell.status.setText(`Sort status error: ${formatError(err)}`, "negative");
          virtualizer.setPendingSortColumn(null);
        }
        return;
      }

      if (generation !== sortGeneration) {
        return;
      }

      if (status.error) {
        virtualizer.setPendingSortColumn(null);
        shell.status.setText(`Sort error: ${status.error}`, "negative");
        return;
      }

      if (status.is_ready && !status.is_sorting) {
        session.activeSort = status.keys.length > 0 ? status.keys : keys;
        virtualizer.setPendingSortColumn(null);
        virtualizer.resetRowsForVisibilityChange();
        shell.status.setText(
          `Sorted ${summary} · ${status.total_rows.toLocaleString()} rows.`,
          "positive",
        );
        return;
      }

      if (!status.is_sorting && !status.is_ready) {
        // Sort was cleared or never started. Drop the pending indicator.
        virtualizer.setPendingSortColumn(null);
        return;
      }

      shell.status.setText(formatSortProgress(status, summary), "busy");
      await wait(SORT_PROGRESS_POLL_INTERVAL_MS);
    }
  }

  /**
   * Compute the next sort key list given the current active keys, the clicked
   * column, and whether shift was held.
   *
   * - Plain click: replaces the entire sort with that column. If the column is
   *   already the sole primary key, cycles asc → desc → cleared.
   * - Shift+click: adds the column as a secondary key (or cycles its direction
   *   if it's already in the list). Removing the only remaining key clears.
   */
  function nextSortKeys(
    activeSort: ActiveSort,
    columnIndex: number,
    addToCurrent: boolean,
  ): SortKey[] {
    if (!addToCurrent) {
      const isSoleKey =
        activeSort.length === 1 && activeSort[0].column === columnIndex;
      if (!isSoleKey) {
        return [{ column: columnIndex, direction: "asc" }];
      }
      // Sole primary: cycle asc → desc → cleared.
      if (activeSort[0].direction === "asc") {
        return [{ column: columnIndex, direction: "desc" }];
      }
      return [];
    }

    // Shift+click: cycle direction or remove if already at end of cycle.
    const existingIndex = activeSort.findIndex((k) => k.column === columnIndex);
    if (existingIndex < 0) {
      return [...activeSort, { column: columnIndex, direction: "asc" }];
    }
    const existing = activeSort[existingIndex];
    const next = activeSort.slice();
    if (existing.direction === "asc") {
      next[existingIndex] = { column: columnIndex, direction: "desc" };
      return next;
    }
    // Remove this key — its direction cycle has wrapped.
    next.splice(existingIndex, 1);
    return next;
  }

  function describeSortKeys(keys: SortKey[], headers: string[]): string {
    if (keys.length === 0) {
      return "no columns";
    }
    const parts = keys.map((key) => {
      const name = headers[key.column] || `column ${key.column + 1}`;
      return `${name} (${key.direction})`;
    });
    if (parts.length === 1) {
      return `by ${parts[0]}`;
    }
    return `by ${parts.join(", then ")}`;
  }

  function formatSortProgress(status: SortStatus, summary: string): string {
    const rows = status.rows_scanned.toLocaleString();
    const total = status.total_rows > 0 ? status.total_rows.toLocaleString() : null;
    if (total !== null) {
      return `Sorting ${summary} · ${rows} of ${total} rows scanned…`;
    }
    return `Sorting ${summary} · ${rows} rows scanned…`;
  }

  async function runExportFlow(): Promise<void> {
    if (!session.path || isOpening) {
      return;
    }

    const defaultName = suggestExportFileName(session.path, session.activeFilter, session.activeSort);
    let target: string | null;
    try {
      target = await save({
        defaultPath: defaultName,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
    } catch (err) {
      shell.status.setText(`Export dialog error: ${formatError(err)}`, "negative");
      return;
    }
    if (!target) {
      return;
    }

    const generation = ++exportGeneration;
    exportButton.setBusy(true);
    shell.status.setText("Preparing export…", "busy");

    // Always pass the explicit column subset (in display order) so hidden
    // columns are dropped at export time. The backend treats `null` as
    // "all columns", but we'd rather always be explicit from the UI side.
    const columnIndices = session.visibleColumnIndices();

    let initial: ExportStatus;
    try {
      initial = await csvApi.startCsvExport(target, columnIndices);
    } catch (err) {
      if (generation === exportGeneration) {
        exportButton.setBusy(false);
        shell.status.setText(`Export error: ${formatError(err)}`, "negative");
      }
      return;
    }

    if (generation !== exportGeneration) {
      return;
    }

    if (initial.error) {
      exportButton.setBusy(false);
      shell.status.setText(`Export error: ${initial.error}`, "negative");
      return;
    }

    shell.status.setText(formatExportProgress(initial), "busy");
    await pollExportStatus(generation, target);
  }

  async function pollExportStatus(generation: number, target: string): Promise<void> {
    while (generation === exportGeneration) {
      await wait(EXPORT_PROGRESS_POLL_INTERVAL_MS);

      let status: ExportStatus;
      try {
        status = await csvApi.getCsvExportStatus();
      } catch (err) {
        if (generation === exportGeneration) {
          exportButton.setBusy(false);
          shell.status.setText(`Export status error: ${formatError(err)}`, "negative");
        }
        return;
      }

      if (generation !== exportGeneration) {
        return;
      }

      if (status.error) {
        exportButton.setBusy(false);
        shell.status.setText(`Export error: ${status.error}`, "negative");
        return;
      }

      if (status.is_complete && !status.is_running) {
        exportButton.setBusy(false);
        const rows = status.rows_written.toLocaleString();
        shell.status.setText(`Exported ${rows} rows to ${target}.`, "positive");
        return;
      }

      if (!status.is_running && !status.is_complete) {
        // Cancelled or never started.
        exportButton.setBusy(false);
        shell.status.setText("Export cancelled.", "neutral");
        return;
      }

      shell.status.setText(formatExportProgress(status), "busy");
    }
  }

  function formatExportProgress(status: ExportStatus): string {
    const written = status.rows_written.toLocaleString();
    if (status.total_rows > 0) {
      const total = status.total_rows.toLocaleString();
      const pct = Math.min(100, Math.floor((status.rows_written / status.total_rows) * 100));
      return `Exporting · ${written} of ${total} rows (${pct}%)…`;
    }
    return `Exporting · ${written} rows…`;
  }

  function suggestExportFileName(
    sourcePath: string,
    filter: { query: string } | null,
    sort: ActiveSort,
  ): string {
    const sep = sourcePath.includes("\\") ? "\\" : "/";
    const base = sourcePath.split(sep).pop() ?? "export.csv";
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const tags: string[] = [];
    if (filter) tags.push("filtered");
    if (sort.length === 1) {
      tags.push(`sorted-${sort[0].direction}`);
    } else if (sort.length > 1) {
      tags.push("sorted");
    }
    const suffix = tags.length > 0 ? `-${tags.join("-")}` : "-export";
    return `${stem}${suffix}.csv`;
  }

  async function runReopenAs(delimiter: string, encoding: string): Promise<void> {
    if (!session.path || isOpening) {
      return;
    }

    resultJumpGeneration++;
    sortGeneration++;
    filterGeneration++;
    exportGeneration++;
    virtualizer.setPendingSortColumn(null);
    isOpening = true;
    try {
      await openCsvFromPath(
        session.path,
        shell.status,
        session,
        virtualizer,
        {
          onDatasetOpened: revealDataset,
          onProgress: (ratio) => shell.progress.setProgress(ratio),
        },
        { delimiterOverride: delimiter, encodingOverride: encoding },
      );
    } finally {
      isOpening = false;
    }
  }

  function syncReopenAsControl(): void {
    if (!session.path || !session.profile) {
      reopenAsControl.setEnabled(false);
      return;
    }

    const delimiterChar =
      typeof session.profile.delimiter === "number"
        ? String.fromCharCode(session.profile.delimiter)
        : null;
    reopenAsControl.setDefaults({
      delimiterChar,
      encoding: session.profile.encoding,
    });
    reopenAsControl.setEnabled(true);
  }

  function revealDataset(): void {
    searchResults.root.classList.add("hidden");

    if (session.path) {
      empty.root.classList.add("hidden");
      grid.root.classList.remove("hidden");
      shell.setSubtitleVisible(false);
      syncReopenAsControl();
      // Reset the filter bar to its empty state — opening a new file clears
      // any prior filter on the backend, so the UI must mirror that.
      filterBar.input.value = "";
      filterBar.setBusy(false);
      filterBar.setStatus("");
      filterBar.setActiveQuery(null);
      filterBar.setVisible(true);
      exportButton.setBusy(false);
      exportButton.setEnabled(true);
      columnVisibilityControl.setColumns(session.headers, session.hiddenColumns);
      columnVisibilityControl.setEnabled(true);
      jumpToRow.close();
      jumpToRow.setMaxRow(session.scrollRowCount);
      return;
    }

    grid.root.classList.add("hidden");
    empty.root.classList.remove("hidden");
    shell.setSubtitleVisible(true);
    reopenAsControl.setEnabled(false);
    filterBar.setVisible(false);
    exportButton.setEnabled(false);
    columnVisibilityControl.setEnabled(false);
    jumpToRow.close();
  }

  function revealSearchResults(): void {
    empty.root.classList.add("hidden");
    grid.root.classList.add("hidden");
    searchResults.root.classList.remove("hidden");
    filterBar.setVisible(false);
    exportButton.setEnabled(false);
    columnVisibilityControl.setEnabled(false);
    jumpToRow.close();
  }

  async function runOpenFlow(): Promise<void> {
    if (isOpening) {
      return;
    }

    resultJumpGeneration++;
    sortGeneration++;
    filterGeneration++;
    exportGeneration++;
    virtualizer.setPendingSortColumn(null);
    isOpening = true;
    try {
      await openCsvFromDialog(shell.status, session, virtualizer, {
        onDatasetOpened: revealDataset,
        onProgress: (ratio) => shell.progress.setProgress(ratio),
      });
    } finally {
      isOpening = false;
    }
  }

  async function openStartupCsvIfConfigured(): Promise<void> {
    try {
      const path = await csvApi.getStartupCsvPath();
      if (!path || isOpening) {
        return;
      }

      sortGeneration++;
      filterGeneration++;
      exportGeneration++;
      virtualizer.setPendingSortColumn(null);
      isOpening = true;
      try {
        await openCsvFromPath(path, shell.status, session, virtualizer, {
          onDatasetOpened: revealDataset,
          onProgress: (ratio) => shell.progress.setProgress(ratio),
        });
      } finally {
        isOpening = false;
      }
    } catch (err) {
      console.error(err);
      shell.status.setText(`Startup error: ${String(err)}`, "negative");
    }
  }

  async function pickSearchFiles(): Promise<void> {
    try {
      const paths = await pickCsvSearchPaths();
      if (paths === null) {
        return;
      }

      await applySearchFiles(paths, { persist: true });
    } catch (err) {
      console.error(err);
      searchPanel.setMessage(`File selection error: ${String(err)}`);
    }
  }

  async function restoreRecentSearchSet(): Promise<void> {
    const paths = getRecentSearchPaths();
    if (paths.length === 0) {
      searchPanel.setMessage("No recent search files saved.");
      searchPanel.setRecentSearchSetAvailable(false);
      return;
    }

    try {
      await applySearchFiles(paths, { persist: false });
    } catch (err) {
      console.error(err);
      searchPanel.setMessage(`Recent file restore error: ${formatError(err)}`);
    }
  }

  async function applySearchFiles(
    paths: string[],
    options: { persist: boolean },
  ): Promise<void> {
    searchPanel.setMessage("Profiling selected files...");
    const profiles = await csvApi.profileCsvFiles(paths);
    searchPaths = paths;
    searchPanel.setSelectedFiles(paths, profiles);
    searchPanel.setMessage(formatProfileIssues(profiles));

    if (options.persist) {
      storeRecentSearchPaths(paths);
      searchPanel.setRecentSearchSetAvailable(paths.length > 0);
    }
  }

  async function runSearch(query: string, limit: number): Promise<void> {
    const generation = ++searchGeneration;
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      searchPanel.setMessage("Enter search text.");
      return;
    }

    if (searchPaths.length === 0) {
      searchPanel.setMessage("Choose files to search.");
      return;
    }

    storeSearchLimit(limit);
    isSearchRunning = true;
    isSearchCancelling = false;
    searchResults.clear();
    searchPanel.setBusy(true);
    searchPanel.setMessage("Searching...");
    void pollSearchProgress(generation);

    try {
      const summary = await csvApi.searchCsvFiles(searchPaths, trimmed, limit);
      if (generation !== searchGeneration) {
        return;
      }

      searchPanel.setMessage("");
      searchResults.setActiveMatch(null);
      searchResults.renderSummary(summary);
      revealSearchResults();
      shell.status.setText(
        summary.cancelled
          ? `Search cancelled: ${summary.matches.length.toLocaleString()} matches kept.`
          : `Search complete: ${summary.matches.length.toLocaleString()} matches across ${summary.matched_files.toLocaleString()} files.`,
        summary.errors.length > 0 ? "negative" : summary.cancelled ? "neutral" : "positive",
      );
    } catch (err) {
      if (generation !== searchGeneration) {
        return;
      }

      console.error(err);
      searchPanel.setMessage(`Search error: ${String(err)}`);
      shell.status.setText(`Search error: ${String(err)}`, "negative");
    } finally {
      if (generation === searchGeneration) {
        isSearchRunning = false;
        isSearchCancelling = false;
        searchPanel.setBusy(false);
      }
    }
  }

  async function cancelSearch(): Promise<void> {
    if (!isSearchRunning || isSearchCancelling) {
      return;
    }

    isSearchCancelling = true;
    searchPanel.setMessage("Cancelling search...");

    try {
      const progress = await csvApi.cancelCsvSearch();
      searchPanel.setMessage(formatSearchProgress(progress));
    } catch (err) {
      console.error(err);
      searchPanel.setMessage(`Cancel error: ${formatError(err)}`);
    }
  }

  async function pollSearchProgress(generation: number): Promise<void> {
    while (generation === searchGeneration) {
      await wait(SEARCH_PROGRESS_POLL_INTERVAL_MS);

      if (generation !== searchGeneration || !isSearchRunning) {
        return;
      }

      try {
        const progress = await csvApi.getCsvSearchProgress();
        if (generation !== searchGeneration || !isSearchRunning) {
          return;
        }

        const message = formatSearchProgress(progress);
        if (message.length > 0) {
          searchPanel.setMessage(message);
        }

        if (!progress.is_running) {
          return;
        }
      } catch (err) {
        if (generation === searchGeneration && isSearchRunning) {
          console.error(err);
        }
        return;
      }
    }
  }

  async function openSearchResult(match: CsvSearchMatch): Promise<void> {
    if (isOpening) {
      return;
    }

    const generation = ++resultJumpGeneration;
    const targetRowIndex = Math.max(0, match.row_index - 1);
    searchResults.setActiveMatch(match);

    try {
      if (session.path !== match.path) {
        sortGeneration++;
        filterGeneration++;
        exportGeneration++;
        virtualizer.setPendingSortColumn(null);
        isOpening = true;
        shell.status.setText(
          `Opening ${match.file_name} at row ${match.row_index.toLocaleString()}…`,
          "busy",
        );

        try {
          await openCsvFromPath(match.path, shell.status, session, virtualizer, {
            onDatasetOpened: revealDataset,
            onProgress: (ratio) => shell.progress.setProgress(ratio),
          });
        } finally {
          isOpening = false;
        }
      }

      if (generation !== resultJumpGeneration || session.path !== match.path) {
        return;
      }

      await jumpToSearchMatch(match, targetRowIndex, generation);
    } catch (err) {
      if (generation === resultJumpGeneration) {
        console.error(err);
        shell.status.setText(`Open result error: ${formatError(err)}`, "negative");
      }
    } finally {
      if (generation === resultJumpGeneration && isOpening) {
        isOpening = false;
      }
    }
  }

  async function jumpToSearchMatch(
    match: CsvSearchMatch,
    targetRowIndex: number,
    generation: number,
  ): Promise<void> {
    while (generation === resultJumpGeneration) {
      if (session.path !== match.path) {
        return;
      }

      if (targetRowIndex < session.rowCount) {
        await virtualizer.scrollToCell(targetRowIndex, match.column_index);
        shell.status.setText(
          `Opened ${match.file_name} · row ${match.row_index.toLocaleString()} · ${
            match.column_name || `column ${match.column_index + 1}`
          }`,
          "positive",
        );
        return;
      }

      shell.status.setText(
        `Indexing ${match.file_name} to row ${match.row_index.toLocaleString()}…`,
        "busy",
      );

      await wait(JUMP_POLL_INTERVAL_MS);

      if (generation !== resultJumpGeneration) {
        return;
      }

      const status = await csvApi.getCsvIndexStatus();
      if (generation !== resultJumpGeneration || status.path !== match.path) {
        return;
      }

      session.applyIndexStatus(status);
      virtualizer.updateAria();
      virtualizer.scheduleRefresh();

      if ((status.is_complete || status.error) && targetRowIndex >= session.rowCount) {
        shell.status.setText(
          `${match.file_name} finished indexing before row ${match.row_index.toLocaleString()} was available.`,
          status.error ? "negative" : "neutral",
        );
        return;
      }
    }
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function formatSearchProgress(progress: CsvSearchProgress): string {
    const matches = `${progress.matches.toLocaleString()} match${
      progress.matches === 1 ? "" : "es"
    }`;

    if (progress.cancelled) {
      return `Search cancelled · ${matches}`;
    }

    if (!progress.is_running) {
      return "";
    }

    const fileIndex =
      progress.current_file_index > 0 ? progress.current_file_index : progress.completed_files + 1;
    const filePart =
      progress.total_files > 0
        ? `File ${fileIndex.toLocaleString()} of ${progress.total_files.toLocaleString()}`
        : "Searching";
    const fileName = progress.current_file ? ` · ${progress.current_file}` : "";
    const rowPart =
      progress.current_row > 0 ? ` · row ${progress.current_row.toLocaleString()}` : "";
    const errorPart =
      progress.errors > 0
        ? ` · ${progress.errors.toLocaleString()} file error${progress.errors === 1 ? "" : "s"}`
        : "";

    return `${filePart}${fileName}${rowPart} · ${matches}${errorPart}`;
  }

  function formatProfileIssues(profiles: CsvFileProfileResult[]): string {
    const errors = profiles.filter((result) => result.error !== null);
    const binaryLike = profiles.filter((result) => result.profile?.binary_like);
    const warnings = profiles.flatMap((result) => result.profile?.warnings ?? []);

    if (errors.length === 0 && binaryLike.length === 0 && warnings.length === 0) {
      return "";
    }

    if (binaryLike.length > 0) {
      return `${binaryLike.length.toLocaleString()} file${
        binaryLike.length === 1 ? "" : "s"
      } look binary and will be skipped by search.`;
    }

    if (errors.length > 0) {
      return `${errors.length.toLocaleString()} file${
        errors.length === 1 ? "" : "s"
      } could not be profiled.`;
    }

    return warnings[0] ?? "";
  }

  function formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  shell = createAppShell({
    title: "Clear Rows",
    subtitle: "Large-file preview and search",
    version: __APP_VERSION__,
    footerTagline: "Local desktop",
    headerExtras: [
      reopenAsControl.root,
      columnVisibilityControl.root,
      exportButton.root,
      createThemeToggle(),
    ],
    onOpenCsv: () => {
      void runOpenFlow();
    },
  });

  workspace.append(empty.root, filterBar.root, jumpToRow.root, grid.root, searchResults.root);
  shell.gridHost.append(searchPanel.root, workspace);
  virtualizer.bind();

  grid.headerViewport.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const cell = target.closest<HTMLElement>("[data-column-index]");
    if (!cell) {
      return;
    }
    const columnIndex = Number.parseInt(cell.dataset.columnIndex ?? "", 10);
    if (Number.isNaN(columnIndex)) {
      return;
    }
    void runSortFlow(columnIndex, event.shiftKey);
  });

  host.replaceChildren(shell.root);

  if (hasDesktopRuntime) {
    void openStartupCsvIfConfigured();
    wireFileDrop();
  }

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void runOpenFlow();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      // Only intercept Ctrl/Cmd-F when a CSV is open, otherwise let the
      // browser-default in-page find apply (no-op in WebView2 either way).
      if (session.path) {
        e.preventDefault();
        filterBar.focus();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
      if (session.path) {
        e.preventDefault();
        jumpToRow.setMaxRow(session.scrollRowCount);
        if (jumpToRow.isOpen()) {
          jumpToRow.close();
        } else {
          jumpToRow.open();
        }
      }
    }
  });

  function wireFileDrop(): void {
    void getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "over" || payload.type === "enter") {
        empty.root.dataset.dragOver = "true";
        return;
      }

      empty.root.removeAttribute("data-drag-over");

      if (payload.type !== "drop" || isOpening) {
        return;
      }

      const path = payload.paths.find((candidate) => candidate.length > 0);
      if (!path) {
        return;
      }

      resultJumpGeneration++;
      sortGeneration++;
      filterGeneration++;
      exportGeneration++;
      virtualizer.setPendingSortColumn(null);
      isOpening = true;
      (async () => {
        try {
          await openCsvFromPath(path, shell.status, session, virtualizer, {
            onDatasetOpened: revealDataset,
            onProgress: (ratio) => shell.progress.setProgress(ratio),
          });
        } finally {
          isOpening = false;
        }
      })();
    });
  }
}
