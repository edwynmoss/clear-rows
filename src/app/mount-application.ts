import type { AppShell } from "../components/app-shell";
import { CSV_ROW_HEIGHT_PX } from "./constants";
import { createAppShell } from "../components/app-shell";
import { createCsvEmptyState } from "../components/csv-empty-state";
import { createCsvPreviewGrid } from "../components/csv-preview-grid";
import { createCsvSearchPanel } from "../components/csv-search-panel";
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
import type { CsvFileProfileResult, CsvSearchMatch, CsvSearchProgress } from "../types/csv";
import { getCurrentWebview } from "@tauri-apps/api/webview";

const JUMP_POLL_INTERVAL_MS = 200;
const SEARCH_PROGRESS_POLL_INTERVAL_MS = 200;

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

  async function runReopenAs(delimiter: string, encoding: string): Promise<void> {
    if (!session.path || isOpening) {
      return;
    }

    resultJumpGeneration++;
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
      return;
    }

    grid.root.classList.add("hidden");
    empty.root.classList.remove("hidden");
    shell.setSubtitleVisible(true);
    reopenAsControl.setEnabled(false);
  }

  function revealSearchResults(): void {
    empty.root.classList.add("hidden");
    grid.root.classList.add("hidden");
    searchResults.root.classList.remove("hidden");
  }

  async function runOpenFlow(): Promise<void> {
    if (isOpening) {
      return;
    }

    resultJumpGeneration++;
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
    headerExtras: [reopenAsControl.root, createThemeToggle()],
    onOpenCsv: () => {
      void runOpenFlow();
    },
  });

  workspace.append(empty.root, grid.root, searchResults.root);
  shell.gridHost.append(searchPanel.root, workspace);
  virtualizer.bind();

  host.replaceChildren(shell.root);

  if (hasDesktopRuntime) {
    void openStartupCsvIfConfigured();
    wireFileDrop();
  }

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void runOpenFlow();
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
