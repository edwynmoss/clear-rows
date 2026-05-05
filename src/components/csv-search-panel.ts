import { DEFAULT_SEARCH_LIMIT, SEARCH_LIMIT_OPTIONS } from "../app/constants";
import type { CsvFileProfileResult } from "../types/csv";

export type CsvSearchPanelOptions = {
  initialLimit?: number;
  hasRecentSearchSet?: boolean;
  onPickFiles: () => void;
  onRestoreRecentSearchSet?: () => void;
  onSearch: (query: string, limit: number) => void;
  onLimitChange?: (limit: number) => void;
  onCancelSearch?: () => void;
};

export type CsvSearchPanel = {
  readonly root: HTMLElement;
  readonly queryInput: HTMLInputElement;
  readonly limitSelect: HTMLSelectElement;
  setSelectedFiles(paths: string[], profiles?: CsvFileProfileResult[]): void;
  setRecentSearchSetAvailable(available: boolean): void;
  setBusy(busy: boolean): void;
  setMessage(text: string): void;
};

export function createCsvSearchPanel(options: CsvSearchPanelOptions): CsvSearchPanel {
  const root = document.createElement("section");
  root.className = "dp-command-panel";

  const form = document.createElement("form");
  form.className = "dp-search-form";

  const label = document.createElement("label");
  label.className = "sr-only";
  label.htmlFor = "csv-search-query";
  label.textContent = "Search text";

  const queryInput = document.createElement("input");
  queryInput.id = "csv-search-query";
  queryInput.type = "search";
  queryInput.placeholder = "Search selected files";
  queryInput.className = "dp-search-input";
  queryInput.autocomplete = "off";
  queryInput.spellcheck = false;
  queryInput.setAttribute("autocapitalize", "none");

  const limitWrap = document.createElement("div");
  limitWrap.className = "dp-limit-control";

  const limitText = document.createElement("span");
  limitText.textContent = "Limit";

  const limitSelect = document.createElement("select");
  limitSelect.hidden = true;
  limitSelect.tabIndex = -1;
  limitSelect.setAttribute("aria-hidden", "true");
  limitSelect.setAttribute("aria-label", "Search result limit");

  const selectedLimit = options.initialLimit ?? DEFAULT_SEARCH_LIMIT;
  for (const limit of SEARCH_LIMIT_OPTIONS) {
    const option = document.createElement("option");
    option.value = String(limit);
    option.textContent = limit.toLocaleString();
    option.selected = limit === selectedLimit;
    limitSelect.append(option);
  }

  const limitMenuId = "csv-search-limit-menu";
  const limitButton = document.createElement("button");
  limitButton.type = "button";
  limitButton.className = "dp-limit-trigger";
  limitButton.setAttribute("aria-haspopup", "listbox");
  limitButton.setAttribute("aria-expanded", "false");
  limitButton.setAttribute("aria-controls", limitMenuId);

  const limitValue = document.createElement("span");
  limitValue.className = "dp-limit-value";
  limitValue.textContent = selectedLimit.toLocaleString();

  const limitChevron = document.createElement("span");
  limitChevron.className = "dp-limit-chevron";
  limitChevron.setAttribute("aria-hidden", "true");

  limitButton.append(limitValue, limitChevron);

  const limitMenu = document.createElement("div");
  limitMenu.id = limitMenuId;
  limitMenu.className = "dp-limit-menu hidden";
  limitMenu.role = "listbox";
  limitMenu.tabIndex = -1;
  limitMenu.setAttribute("aria-label", "Search result limit");

  const limitOptions = SEARCH_LIMIT_OPTIONS.map((limit) => {
    const item = document.createElement("div");
    item.className = "dp-limit-option";
    item.role = "option";
    item.tabIndex = -1;
    item.dataset.value = String(limit);
    item.textContent = limit.toLocaleString();
    item.setAttribute("aria-selected", String(limit === selectedLimit));
    item.addEventListener("click", () => {
      setLimit(limit, { notify: true });
      closeLimitMenu({ restoreFocus: true });
    });
    limitMenu.append(item);
    return item;
  });

  limitWrap.append(limitText, limitSelect, limitButton, limitMenu);

  const pickButton = document.createElement("button");
  pickButton.type = "button";
  pickButton.className = "dp-button dp-button-secondary";
  pickButton.textContent = "Files";

  const recentButton = document.createElement("button");
  recentButton.type = "button";
  recentButton.className = "dp-button dp-button-secondary";
  recentButton.textContent = "Recent";
  recentButton.disabled = !options.hasRecentSearchSet;
  recentButton.title = "Restore recent search files";

  const searchButton = document.createElement("button");
  searchButton.type = "submit";
  searchButton.className = "dp-button dp-button-primary px-5";
  searchButton.textContent = "Search";

  const meta = document.createElement("div");
  meta.className = "dp-search-meta";
  renderSelectedFiles([], undefined);

  const feedback = document.createElement("div");
  feedback.className = "dp-search-feedback hidden";
  let isBusy = false;
  let hasRecentSearchSet = Boolean(options.hasRecentSearchSet);

  pickButton.addEventListener("click", options.onPickFiles);
  recentButton.addEventListener("click", () => {
    options.onRestoreRecentSearchSet?.();
  });
  limitButton.addEventListener("click", () => {
    if (limitButton.disabled) {
      return;
    }

    toggleLimitMenu();
  });
  limitButton.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "Enter", " "].includes(event.key)) {
      return;
    }

    event.preventDefault();
    openLimitMenu();
  });
  limitMenu.addEventListener("keydown", handleLimitMenuKeydown);
  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (target instanceof Node && !limitWrap.contains(target)) {
      closeLimitMenu({ restoreFocus: false });
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (isBusy) {
      options.onCancelSearch?.();
      return;
    }

    options.onSearch(queryInput.value.trim(), Number(limitSelect.value));
  });

  const commandRow = document.createElement("div");
  commandRow.className = "dp-search-command-row";
  commandRow.append(queryInput, limitWrap, pickButton, recentButton, searchButton);

  const contextRow = document.createElement("div");
  contextRow.className = "dp-search-context-row";
  contextRow.append(meta, feedback);

  form.append(label, commandRow, contextRow);
  root.append(form);

  return {
    root,
    queryInput,
    limitSelect,
    setSelectedFiles(paths: string[], profiles?: CsvFileProfileResult[]) {
      renderSelectedFiles(paths, profiles);
    },
    setRecentSearchSetAvailable(available: boolean) {
      hasRecentSearchSet = available;
      recentButton.disabled = !available || isBusy;
    },
    setBusy(busy: boolean) {
      isBusy = busy;
      limitSelect.disabled = busy;
      limitButton.disabled = busy;
      if (busy) {
        closeLimitMenu({ restoreFocus: false });
      }
      pickButton.disabled = busy;
      recentButton.disabled = busy || !hasRecentSearchSet;
      searchButton.disabled = busy && options.onCancelSearch === undefined;
      searchButton.textContent = busy ? "Cancel" : "Search";
      searchButton.setAttribute("aria-label", busy ? "Cancel search" : "Search");
    },
    setMessage(text: string) {
      feedback.classList.toggle("hidden", text.length === 0);
      feedback.textContent = text;
    },
  };

  function renderSelectedFiles(paths: string[], profiles?: CsvFileProfileResult[]): void {
    if (paths.length === 0) {
      const empty = document.createElement("span");
      empty.className = "dp-selected-empty";
      empty.textContent = "No files selected.";
      meta.replaceChildren(empty);
      return;
    }

    const profileByPath = new Map((profiles ?? []).map((result) => [result.path, result]));
    const stats = getSelectionStats(paths, profiles);

    const wrap = document.createElement("div");
    wrap.className = "dp-selected-files";

    const summary = document.createElement("div");
    summary.className = "dp-selected-summary";

    const title = document.createElement("span");
    title.className = "dp-selected-title";
    title.textContent = `${paths.length.toLocaleString()} file${
      paths.length === 1 ? "" : "s"
    } selected`;

    const detail = document.createElement("span");
    detail.className = "dp-selected-detail";
    detail.textContent = stats;

    summary.append(title, detail);

    const list = document.createElement("ul");
    list.className = "dp-selected-file-list";

    for (const path of paths.slice(0, 3)) {
      list.append(createSelectedFileItem(path, profileByPath.get(path)));
    }

    if (paths.length > 3) {
      const overflow = document.createElement("li");
      overflow.className = "dp-selected-file-more";
      overflow.textContent = `+ ${(paths.length - 3).toLocaleString()} more`;
      list.append(overflow);
    }

    wrap.append(summary, list);
    meta.replaceChildren(wrap);
  }

  function getSelectionStats(paths: string[], profiles?: CsvFileProfileResult[]): string {
    if (!profiles || profiles.length === 0) {
      return "Pending profile";
    }

    const profiled = profiles.filter((result) => result.profile !== null);
    const warnings = profiled.reduce(
      (sum, result) => sum + (result.profile?.warnings.length ?? 0),
      0,
    );
    const errors = profiles.length - profiled.length;
    const kinds = new Map<string, number>();

    for (const result of profiled) {
      const label = result.profile?.detected_kind_label ?? "Text";
      kinds.set(label, (kinds.get(label) ?? 0) + 1);
    }

    const kindText = Array.from(kinds.entries())
      .map(([label, count]) => formatKindCount(label, count))
      .join(", ");
    const warningText =
      warnings > 0
        ? ` · ${warnings.toLocaleString()} warning${warnings === 1 ? "" : "s"}`
        : "";
    const errorText =
      errors > 0 ? ` · ${errors.toLocaleString()} profile error${errors === 1 ? "" : "s"}` : "";

    return `${kindText || `${paths.length.toLocaleString()} profiled`}${warningText}${errorText}`;
  }

  function createSelectedFileItem(
    path: string,
    result?: CsvFileProfileResult,
  ): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "dp-selected-file";
    item.title = path;

    const name = document.createElement("span");
    name.className = "dp-selected-file-name";
    name.textContent = getFileName(path);

    const meta = document.createElement("span");
    meta.className = "dp-selected-file-kind";
    meta.textContent = formatFileKind(result);

    item.append(name, meta);
    return item;
  }

  function formatFileKind(result?: CsvFileProfileResult): string {
    if (!result) {
      return "Pending";
    }

    if (result.error) {
      return "Profile error";
    }

    return result.profile?.detected_kind_label ?? "Text";
  }

  function formatKindCount(label: string, count: number): string {
    return `${count.toLocaleString()} ${label} file${count === 1 ? "" : "s"}`;
  }

  function getFileName(path: string): string {
    return path.split(/[\\/]/).pop() || path;
  }

  function setLimit(limit: number, change: { notify: boolean }): void {
    limitSelect.value = String(limit);
    limitValue.textContent = limit.toLocaleString();

    for (const item of limitOptions) {
      item.setAttribute("aria-selected", String(item.dataset.value === String(limit)));
    }

    if (change.notify) {
      options.onLimitChange?.(limit);
    }
  }

  function toggleLimitMenu(): void {
    if (limitMenu.classList.contains("hidden")) {
      openLimitMenu();
      return;
    }

    closeLimitMenu({ restoreFocus: true });
  }

  function openLimitMenu(): void {
    limitMenu.classList.remove("hidden");
    limitButton.setAttribute("aria-expanded", "true");
    focusSelectedLimitOption();
  }

  function closeLimitMenu(options: { restoreFocus: boolean }): void {
    if (limitMenu.classList.contains("hidden")) {
      return;
    }

    limitMenu.classList.add("hidden");
    limitButton.setAttribute("aria-expanded", "false");

    if (options.restoreFocus) {
      limitButton.focus({ preventScroll: true });
    }
  }

  function focusSelectedLimitOption(): void {
    const selected = limitOptions.find(
      (item) => item.dataset.value === limitSelect.value,
    );
    (selected ?? limitOptions[0])?.focus({ preventScroll: true });
  }

  function handleLimitMenuKeydown(event: KeyboardEvent): void {
    const currentIndex = limitOptions.findIndex((item) => item === document.activeElement);

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        closeLimitMenu({ restoreFocus: true });
        return;
      case "ArrowDown":
        event.preventDefault();
        focusLimitOption(currentIndex + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusLimitOption(currentIndex - 1);
        return;
      case "Home":
        event.preventDefault();
        focusLimitOption(0);
        return;
      case "End":
        event.preventDefault();
        focusLimitOption(limitOptions.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        selectFocusedLimitOption();
        return;
      default:
        return;
    }
  }

  function focusLimitOption(index: number): void {
    const safeIndex = Math.min(Math.max(0, index), limitOptions.length - 1);
    limitOptions[safeIndex]?.focus({ preventScroll: true });
  }

  function selectFocusedLimitOption(): void {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) {
      return;
    }

    const limit = Number(focused.dataset.value);
    if (!SEARCH_LIMIT_OPTIONS.some((option) => option === limit)) {
      return;
    }

    setLimit(limit, { notify: true });
    closeLimitMenu({ restoreFocus: true });
  }
}
