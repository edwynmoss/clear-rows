import type {
  CsvSearchFileSchema,
  CsvSearchMatch,
  CsvSearchSummary,
} from "../types/csv";

const RESULT_ROW_HEIGHT_PX = 42;
const RESULT_BUFFER_ROWS = 10;
const RESULT_COLUMN_MIN_WIDTH_PX = 144;
const RESULT_FILE_COLUMN_WIDTH_PX = 176;
const RESULT_ROW_COLUMN_WIDTH_PX = 84;

type ResultScope = {
  readonly id: string;
  readonly label: string;
  readonly headers: string[];
  readonly matches: CsvSearchMatch[];
  readonly showFileColumn: boolean;
};

export type SearchResultsTableOptions = {
  onOpenResult?: (match: CsvSearchMatch) => void;
  onViewDataset?: () => void;
};

export type SearchResultsTable = {
  readonly root: HTMLDivElement;
  clear(): void;
  renderSummary(summary: CsvSearchSummary): void;
  setActiveMatch(match: CsvSearchMatch | null): void;
  dispose(): void;
};

export function createSearchResultsTable(
  options: SearchResultsTableOptions = {},
): SearchResultsTable {
  const root = document.createElement("div");
  root.className = "dp-results-surface hidden";
  root.setAttribute("aria-label", "Search results");

  const toolbar = document.createElement("div");
  toolbar.className = "dp-results-toolbar";

  const summaryText = document.createElement("div");
  summaryText.className = "dp-results-summary";

  const summaryTitle = document.createElement("span");
  summaryTitle.className = "dp-results-summary-title";

  const summaryMeta = document.createElement("span");
  summaryMeta.className = "dp-results-summary-meta";

  summaryText.append(summaryTitle, summaryMeta);

  const actions = document.createElement("div");
  actions.className = "dp-results-actions";

  const scopeSelect = document.createElement("select");
  scopeSelect.className = "dp-results-file-select hidden";
  scopeSelect.setAttribute("aria-label", "Search result file");
  scopeSelect.addEventListener("change", () => {
    activeScopeIndex = Math.max(0, Number(scopeSelect.value));
    renderActiveScope();
  });

  const viewDatasetButton = document.createElement("button");
  viewDatasetButton.type = "button";
  viewDatasetButton.className = "dp-results-back";
  viewDatasetButton.textContent = "View dataset";
  viewDatasetButton.addEventListener("click", () => {
    options.onViewDataset?.();
  });

  actions.append(scopeSelect, viewDatasetButton);
  toolbar.append(summaryText, actions);

  const header = document.createElement("div");
  header.className = "dp-results-grid dp-results-header";
  header.setAttribute("role", "row");

  const viewport = document.createElement("div");
  viewport.className = "dp-results-scroll";
  viewport.role = "grid";
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", "Matched rows");
  viewport.setAttribute("aria-colcount", "0");
  viewport.setAttribute("aria-rowcount", "0");

  const rows = document.createElement("div");
  rows.className = "dp-results-rows";
  viewport.append(header, rows);

  root.append(toolbar, viewport);

  let scopes: ResultScope[] = [];
  let activeScopeIndex = 0;
  let visibleMatches: CsvSearchMatch[] = [];
  let activeKey = "";
  let rafHandle = 0;
  let lastFirst = -1;
  let lastLast = -1;

  const scheduleRender = () => {
    if (rafHandle !== 0) {
      return;
    }

    rafHandle = window.requestAnimationFrame(() => {
      rafHandle = 0;
      renderWindow();
    });
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const nextIndex = getKeyboardTargetIndex(event);
    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    focusIndex(nextIndex);
  };

  viewport.addEventListener("scroll", scheduleRender, { passive: true });
  viewport.addEventListener("keydown", handleKeyDown);

  return {
    root,
    clear() {
      scopes = [];
      activeScopeIndex = 0;
      visibleMatches = [];
      activeKey = "";
      lastFirst = -1;
      lastLast = -1;
      header.replaceChildren();
      rows.replaceChildren();
      rows.style.height = "0px";
      viewport.scrollTop = 0;
      viewport.setAttribute("aria-colcount", "0");
      viewport.setAttribute("aria-rowcount", "0");
      root.classList.add("hidden");
    },
    renderSummary(nextSummary: CsvSearchSummary) {
      scopes = createResultScopes(nextSummary);
      activeScopeIndex = 0;
      activeKey = "";
      renderSummaryText(nextSummary);
      renderScopeSelect();
      root.classList.remove("hidden");
      renderActiveScope();
    },
    setActiveMatch(match: CsvSearchMatch | null) {
      activeKey = match === null ? "" : createResultKey(match);
      updateActiveRows();
    },
    dispose() {
      if (rafHandle !== 0) {
        window.cancelAnimationFrame(rafHandle);
        rafHandle = 0;
      }

      viewport.removeEventListener("scroll", scheduleRender);
      viewport.removeEventListener("keydown", handleKeyDown);
    },
  };

  function renderSummaryText(nextSummary: CsvSearchSummary): void {
    summaryTitle.textContent = `${nextSummary.matches.length.toLocaleString()} match${
      nextSummary.matches.length === 1 ? "" : "es"
    }`;

    const meta = [
      `${nextSummary.matched_files.toLocaleString()} matched file${
        nextSummary.matched_files === 1 ? "" : "s"
      }`,
      `${nextSummary.searched_files.toLocaleString()} scanned`,
      nextSummary.truncated ? "Result limit reached" : "",
      nextSummary.cancelled ? "Cancelled" : "",
      nextSummary.errors.length > 0
        ? `${nextSummary.errors.length.toLocaleString()} error${
            nextSummary.errors.length === 1 ? "" : "s"
          }`
        : "",
    ].filter(Boolean);

    summaryMeta.textContent = meta.join(" · ");
  }

  function renderScopeSelect(): void {
    scopeSelect.replaceChildren();
    scopeSelect.classList.toggle("hidden", scopes.length <= 1);

    for (const [index, scope] of scopes.entries()) {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = scope.label;
      scopeSelect.append(option);
    }
  }

  function renderActiveScope(): void {
    const scope = scopes[activeScopeIndex];
    visibleMatches = scope?.matches ?? [];
    lastFirst = -1;
    lastLast = -1;
    viewport.scrollTop = 0;

    renderHeader(scope);
    rows.style.height =
      visibleMatches.length === 0
        ? "auto"
        : `${visibleMatches.length * RESULT_ROW_HEIGHT_PX}px`;
    viewport.setAttribute(
      "aria-colcount",
      String(scope ? getColumnLabels(scope).length : 0),
    );
    viewport.setAttribute("aria-rowcount", String(visibleMatches.length));
    renderWindow();
  }

  function renderHeader(scope: ResultScope | undefined): void {
    header.replaceChildren();

    if (!scope) {
      return;
    }

    applyColumnLayout(header, scope);

    for (const label of getColumnLabels(scope)) {
      const cell = document.createElement("div");
      cell.role = "columnheader";
      cell.textContent = label;
      cell.title = label;
      header.append(cell);
    }
  }

  function renderWindow(): void {
    if (visibleMatches.length === 0) {
      rows.replaceChildren(createEmptyState());
      return;
    }

    const viewportHeight = viewport.clientHeight || RESULT_ROW_HEIGHT_PX * 8;
    const first = Math.max(
      0,
      Math.floor(viewport.scrollTop / RESULT_ROW_HEIGHT_PX) - RESULT_BUFFER_ROWS,
    );
    const last = Math.min(
      visibleMatches.length,
      Math.ceil((viewport.scrollTop + viewportHeight) / RESULT_ROW_HEIGHT_PX) +
        RESULT_BUFFER_ROWS,
    );

    if (first === lastFirst && last === lastLast) {
      updateActiveRows();
      return;
    }

    lastFirst = first;
    lastLast = last;

    const fragment = document.createDocumentFragment();
    const scope = scopes[activeScopeIndex];
    for (let index = first; index < last; index++) {
      fragment.append(createResultRow(visibleMatches[index], index, scope));
    }

    rows.replaceChildren(fragment);
  }

  function createResultRow(
    match: CsvSearchMatch,
    index: number,
    scope: ResultScope | undefined,
  ): HTMLButtonElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dp-results-grid dp-results-row";
    row.dataset.resultKey = createResultKey(match);
    row.dataset.resultIndex = String(index);
    row.style.top = `${index * RESULT_ROW_HEIGHT_PX}px`;
    row.style.height = `${RESULT_ROW_HEIGHT_PX}px`;
    row.title = `Open ${match.file_name} at row ${match.row_index.toLocaleString()}`;
    row.setAttribute("role", "row");
    row.setAttribute("aria-rowindex", String(index + 1));
    setRowActive(row, row.dataset.resultKey === activeKey);

    if (scope) {
      applyColumnLayout(row, scope);
    }

    row.addEventListener("click", () => {
      options.onOpenResult?.(match);
    });

    if (scope?.showFileColumn) {
      row.append(createCell(match.file_name, match.path, "file"));
    }

    row.append(createCell(match.row_index.toLocaleString(), "Row", "row"));

    const headers = scope?.headers ?? [];
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex++) {
      const value = match.row_values[columnIndex] ?? "";
      const cell = createCell(value, headers[columnIndex] ?? "", "value");
      cell.dataset.match = String(columnIndex === match.column_index);
      row.append(cell);
    }

    return row;
  }

  function createCell(
    text: string,
    title: string,
    kind: "file" | "row" | "value",
  ): HTMLSpanElement {
    const cell = document.createElement("span");
    cell.role = "gridcell";
    cell.dataset.cellKind = kind;
    cell.textContent = text;
    cell.title = title ? `${title}: ${text}` : text;
    return cell;
  }

  function createEmptyState(): HTMLDivElement {
    const empty = document.createElement("div");
    empty.className = "dp-results-empty";
    empty.textContent = "No matches found.";
    return empty;
  }

  function updateActiveRows(): void {
    for (const row of rows.querySelectorAll<HTMLButtonElement>("[data-result-key]")) {
      setRowActive(row, row.dataset.resultKey === activeKey);
    }
  }

  function setRowActive(row: HTMLButtonElement, isActive: boolean): void {
    row.dataset.active = String(isActive);

    if (isActive) {
      row.setAttribute("aria-current", "true");
      return;
    }

    row.removeAttribute("aria-current");
  }

  function focusIndex(index: number): void {
    const safeIndex = clampIndex(index);
    scrollIndexIntoView(safeIndex);
    lastFirst = -1;
    lastLast = -1;
    renderWindow();

    window.requestAnimationFrame(() => {
      rows
        .querySelector<HTMLButtonElement>(`[data-result-index="${safeIndex}"]`)
        ?.focus({ preventScroll: true });
    });
  }

  function scrollIndexIntoView(index: number): void {
    const rowTop = index * RESULT_ROW_HEIGHT_PX;
    const rowBottom = rowTop + RESULT_ROW_HEIGHT_PX;
    const viewportTop = viewport.scrollTop;
    const viewportBottom = viewportTop + viewport.clientHeight;

    if (rowTop < viewportTop) {
      viewport.scrollTop = rowTop;
      return;
    }

    if (rowBottom > viewportBottom) {
      viewport.scrollTop = rowBottom - viewport.clientHeight;
    }
  }

  function getKeyboardTargetIndex(event: KeyboardEvent): number | null {
    const currentIndex = getFocusedResultIndex();

    switch (event.key) {
      case "ArrowDown":
        return clampIndex(currentIndex + 1);
      case "ArrowUp":
        return clampIndex(currentIndex - 1);
      case "Home":
        return 0;
      case "End":
        return Math.max(0, visibleMatches.length - 1);
      default:
        return null;
    }
  }

  function getFocusedResultIndex(): number {
    const focused = document.activeElement as HTMLElement | null;
    const indexValue = focused?.closest<HTMLElement>("[data-result-index]")?.dataset
      .resultIndex;
    const parsed = Number(indexValue);

    if (Number.isInteger(parsed)) {
      return parsed;
    }

    return Math.max(0, Math.floor(viewport.scrollTop / RESULT_ROW_HEIGHT_PX));
  }

  function clampIndex(index: number): number {
    return Math.min(Math.max(0, index), Math.max(0, visibleMatches.length - 1));
  }

  function getColumnLabels(scope: ResultScope): string[] {
    return [
      ...(scope.showFileColumn ? ["File"] : []),
      "Row",
      ...scope.headers,
    ];
  }

  function applyColumnLayout(element: HTMLElement, scope: ResultScope): void {
    const template = [
      ...(scope.showFileColumn ? [`${RESULT_FILE_COLUMN_WIDTH_PX}px`] : []),
      `${RESULT_ROW_COLUMN_WIDTH_PX}px`,
      ...scope.headers.map(() => `minmax(${RESULT_COLUMN_MIN_WIDTH_PX}px, 1fr)`),
    ].join(" ");
    const minWidth =
      (scope.showFileColumn ? RESULT_FILE_COLUMN_WIDTH_PX : 0) +
      RESULT_ROW_COLUMN_WIDTH_PX +
      Math.max(1, scope.headers.length) * RESULT_COLUMN_MIN_WIDTH_PX;

    element.style.gridTemplateColumns = template;
    element.style.minWidth = `${minWidth}px`;
  }

  function createResultKey(match: CsvSearchMatch): string {
    return `${match.path}:${match.row_index}:${match.column_index}`;
  }
}

function createResultScopes(summary: CsvSearchSummary): ResultScope[] {
  if (summary.matches.length === 0) {
    return [];
  }

  const schemasByPath = new Map(summary.schemas.map((schema) => [schema.path, schema]));
  const matchesByPath = new Map<string, CsvSearchMatch[]>();

  for (const match of summary.matches) {
    const matches = matchesByPath.get(match.path) ?? [];
    matches.push(match);
    matchesByPath.set(match.path, matches);
  }

  const paths = Array.from(matchesByPath.keys());
  const schemas = paths.map((path) =>
    schemasByPath.get(path) ?? inferSchema(path, matchesByPath.get(path) ?? []),
  );
  const firstHeaders = schemas[0]?.headers ?? [];
  const hasSharedSchema = schemas.every((schema) => sameHeaders(schema.headers, firstHeaders));

  if (hasSharedSchema) {
    return [
      {
        id: "all",
        label: paths.length === 1 ? schemas[0].file_name : "All matched files",
        headers: firstHeaders,
        matches: summary.matches,
        showFileColumn: paths.length > 1,
      },
      ...createPerFileScopes(schemas, matchesByPath),
    ].filter((_scope, index) => index === 0 || paths.length > 1);
  }

  return createPerFileScopes(schemas, matchesByPath);
}

function createPerFileScopes(
  schemas: CsvSearchFileSchema[],
  matchesByPath: Map<string, CsvSearchMatch[]>,
): ResultScope[] {
  return schemas.map((schema) => ({
    id: schema.path,
    label: `${schema.file_name} (${(matchesByPath.get(schema.path) ?? []).length.toLocaleString()})`,
    headers: schema.headers,
    matches: matchesByPath.get(schema.path) ?? [],
    showFileColumn: false,
  }));
}

function inferSchema(path: string, matches: CsvSearchMatch[]): CsvSearchFileSchema {
  const first = matches[0];
  const columnCount = Math.max(
    first?.row_values.length ?? 0,
    first ? first.column_index + 1 : 0,
  );

  return {
    path,
    file_name: first?.file_name ?? (path.replace(/^.*[/\\]/, "") || path),
    headers: Array.from({ length: columnCount }, (_value, index) => `Column ${index + 1}`),
  };
}

function sameHeaders(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
