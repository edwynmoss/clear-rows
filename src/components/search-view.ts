import { fileNameOf, formatInt } from "../app/format";
import type {
  CsvFileProfileResult,
  CsvSearchMatch,
  CsvSearchProgress,
  CsvSearchSummary,
} from "../types/csv";
import { createSearchResultsTable } from "./search-results-table";

export type SearchViewOptions = {
  onOpenResult: (match: CsvSearchMatch) => void;
  onEditFiles: () => void;
  onBackToFile: () => void;
};

export type SearchView = {
  readonly root: HTMLElement;
  setFiles(paths: string[], profiles: CsvFileProfileResult[] | null): void;
  setProgress(progress: CsvSearchProgress | null): void;
  setSummary(summary: CsvSearchSummary): void;
  setActiveMatch(match: CsvSearchMatch | null): void;
  setHasFile(hasFile: boolean): void;
  clear(): void;
};

type FileRowState = "queued" | "running" | "done" | "error";

export function createSearchView(options: SearchViewOptions): SearchView {
  const root = document.createElement("div");
  root.className = "cr-search";
  root.hidden = true;

  const filesCard = document.createElement("section");
  filesCard.className = "cr-card cr-search-files";
  const filesHead = document.createElement("header");
  filesHead.className = "cr-card-head";
  const filesTitle = document.createElement("span");
  filesTitle.textContent = "Files";
  const editFiles = document.createElement("button");
  editFiles.type = "button";
  editFiles.className = "cr-link";
  editFiles.textContent = "edit set";
  editFiles.addEventListener("click", options.onEditFiles);
  filesHead.append(filesTitle, editFiles);
  const filesList = document.createElement("div");
  filesList.className = "cr-search-filelist";
  const filesFoot = document.createElement("div");
  filesFoot.className = "cr-search-filefoot";
  filesCard.append(filesHead, filesList, filesFoot);

  const resultsCard = document.createElement("section");
  resultsCard.className = "cr-card cr-search-results";
  const resultsHead = document.createElement("header");
  resultsHead.className = "cr-card-head";
  const resultsTitle = document.createElement("span");
  resultsTitle.textContent = "Results";
  const resultsMeta = document.createElement("span");
  resultsMeta.className = "cr-card-meta";
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "cr-link";
  backButton.textContent = "back to file";
  backButton.hidden = true;
  backButton.addEventListener("click", options.onBackToFile);
  resultsHead.append(resultsTitle, resultsMeta, backButton);

  const table = createSearchResultsTable({
    onOpenResult: options.onOpenResult,
  });
  table.root.classList.remove("hidden");

  const resultsEmpty = document.createElement("div");
  resultsEmpty.className = "cr-search-empty";
  resultsEmpty.textContent = "Choose files and type what to find.";

  resultsCard.append(resultsHead, resultsEmpty, table.root);
  root.append(filesCard, resultsCard);

  let paths: string[] = [];
  let profiles = new Map<string, CsvFileProfileResult>();
  let states = new Map<string, FileRowState>();
  let hits = new Map<string, number>();
  let progress: CsvSearchProgress | null = null;
  let hasSummary = false;

  function renderFiles(): void {
    filesList.replaceChildren();
    if (paths.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cr-search-empty";
      empty.textContent = "No files selected.";
      filesList.append(empty);
      filesFoot.textContent = "";
      return;
    }
    for (const path of paths) {
      const row = document.createElement("div");
      row.className = "cr-search-file";
      const state = states.get(path) ?? "queued";
      row.dataset.state = state;

      const name = document.createElement("span");
      name.className = "cr-search-file-name";
      name.textContent = fileNameOf(path);
      name.title = path;

      const bar = document.createElement("span");
      bar.className = "cr-mini-bar";
      const fill = document.createElement("i");
      fill.style.width = state === "done" ? "100%" : state === "running" ? "60%" : "0%";
      bar.dataset.indeterminate = state === "running" ? "true" : "false";
      bar.append(fill);

      const status = document.createElement("span");
      status.className = "cr-search-file-status";
      const profile = profiles.get(path);
      if (state === "error" || profile?.error) {
        status.textContent = "error";
        status.dataset.tone = "negative";
      } else if (state === "done" || hasSummary) {
        const n = hits.get(path) ?? 0;
        status.textContent = n === 0 ? "no hits" : `${formatInt(n)} hit${n === 1 ? "" : "s"}`;
        status.dataset.tone = n === 0 ? "dim" : "positive";
      } else if (state === "running") {
        const rowText = progress?.current_row ? `row ${formatInt(progress.current_row)}` : "scanning";
        status.textContent = rowText;
        status.dataset.tone = "normal";
      } else {
        status.textContent = profile?.profile?.detected_kind_label ?? "queued";
        status.dataset.tone = "dim";
      }

      row.append(name, bar, status);
      filesList.append(row);
    }
    const kinds = new Map<string, number>();
    for (const path of paths) {
      const label = profiles.get(path)?.profile?.detected_kind_label ?? "file";
      kinds.set(label, (kinds.get(label) ?? 0) + 1);
    }
    filesFoot.textContent = Array.from(kinds.entries())
      .map(([label, count]) => `${formatInt(count)} ${label}${count === 1 ? "" : "s"}`)
      .join(" · ");
  }

  return {
    root,
    setFiles(nextPaths, nextProfiles) {
      paths = nextPaths;
      profiles = new Map((nextProfiles ?? []).map((result) => [result.path, result]));
      states = new Map();
      hits = new Map();
      hasSummary = false;
      renderFiles();
      root.hidden = false;
    },
    setProgress(next) {
      progress = next;
      if (!next) {
        renderFiles();
        return;
      }
      resultsEmpty.hidden = true;
      states = new Map();
      paths.forEach((path, index) => {
        if (index < next.completed_files) states.set(path, "done");
        else if (next.is_running && path === next.current_path) states.set(path, "running");
        else if (next.is_running && index === next.completed_files && !next.current_path) states.set(path, "running");
        else states.set(path, "queued");
      });
      resultsMeta.textContent = next.is_running
        ? `${formatInt(next.matches)} so far · ${formatInt(next.completed_files)} of ${formatInt(next.total_files)} files done`
        : "";
      renderFiles();
    },
    setSummary(summary) {
      hasSummary = true;
      hits = new Map();
      for (const match of summary.matches) {
        hits.set(match.path, (hits.get(match.path) ?? 0) + 1);
      }
      const errored = new Set(summary.errors.map((e) => e.path));
      states = new Map(paths.map((path) => [path, errored.has(path) ? "error" : "done"]));
      const parts = [
        `${formatInt(summary.matches.length)} match${summary.matches.length === 1 ? "" : "es"}`,
        `${formatInt(summary.matched_files)} of ${formatInt(summary.searched_files)} files`,
        summary.truncated ? "limit reached" : "",
        summary.cancelled ? "cancelled" : "",
        summary.errors.length > 0 ? `${formatInt(summary.errors.length)} error${summary.errors.length === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      resultsMeta.textContent = parts.join(" · ");
      resultsEmpty.hidden = summary.matches.length > 0;
      resultsEmpty.textContent = summary.matches.length === 0 ? `Nothing matched “${summary.query}”.` : "";
      table.renderSummary(summary);
      table.root.classList.toggle("hidden", summary.matches.length === 0);
      renderFiles();
    },
    setActiveMatch(match) {
      table.setActiveMatch(match);
    },
    setHasFile(hasFile) {
      backButton.hidden = !hasFile;
    },
    clear() {
      table.clear();
      table.root.classList.add("hidden");
      resultsEmpty.hidden = false;
      resultsEmpty.textContent = paths.length === 0 ? "Choose files and type what to find." : "Type what to find and press Enter.";
      resultsMeta.textContent = "";
      hits = new Map();
      hasSummary = false;
      states = new Map();
      renderFiles();
    },
  };
}
