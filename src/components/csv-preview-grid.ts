import { CSV_DEFAULT_COL_WIDTH_PX } from "../app/constants";
import type { CsvColumnWindow } from "../csv/column-window";
import type { ActiveSort } from "../csv/csv-session";

export type CsvPreviewGridRefs = {
  readonly root: HTMLDivElement;
  readonly headerViewport: HTMLDivElement;
  readonly headerRow: HTMLDivElement;
  readonly scrollRegion: HTMLDivElement;
  readonly inner: HTMLDivElement;
  readonly spacerTop: HTMLDivElement;
  readonly windowRows: HTMLDivElement;
  readonly spacerBottom: HTMLDivElement;
};

export type CsvPreviewGridOptions = {
  rowHeightPx?: number;
  gridLabel?: string;
};

/**
 * Accessible CSV preview shell: sticky column headers + scroll body with spacer slots for virtualization.
 */
export function createCsvPreviewGrid(options: CsvPreviewGridOptions = {}): CsvPreviewGridRefs {
  const root = document.createElement("div");
  root.className = "dp-data-surface flex min-h-0 flex-1 flex-col";

  const headerViewport = document.createElement("div");
  headerViewport.className = "dp-grid-header shrink-0 overflow-hidden";

  const headerRow = document.createElement("div");
  headerRow.className = "flex shrink-0 will-change-transform";

  const scrollRegion = document.createElement("div");
  scrollRegion.className = "dp-grid-scroll min-h-0 flex-1 overflow-auto outline-none";
  scrollRegion.tabIndex = 0;
  scrollRegion.role = "grid";
  scrollRegion.setAttribute("aria-label", options.gridLabel ?? "CSV rows");
  scrollRegion.setAttribute("aria-rowcount", "0");
  scrollRegion.setAttribute("aria-colcount", "0");

  const inner = document.createElement("div");
  inner.className = "inline-block min-w-full";

  const spacerTop = document.createElement("div");
  spacerTop.style.height = "0px";

  const windowRows = document.createElement("div");
  windowRows.className = "flex flex-col";

  const spacerBottom = document.createElement("div");
  spacerBottom.style.height = "0px";

  inner.append(spacerTop, windowRows, spacerBottom);
  scrollRegion.append(inner);
  headerViewport.append(headerRow);
  root.append(headerViewport, scrollRegion);

  return {
    root,
    headerViewport,
    headerRow,
    scrollRegion,
    inner,
    spacerTop,
    windowRows,
    spacerBottom,
  };
}

export type RenderHeaderOptions = {
  /** Active sort state to render as an arrow indicator on the matching column. */
  activeSort?: ActiveSort | null;
  /** Column whose sort is currently being computed. Rendered with a busy hint. */
  pendingSortColumn?: number | null;
};

export function renderCsvHeaderRow(
  headerRow: HTMLDivElement,
  headers: string[],
  colWidthsPx: number[],
  rowHeightPx: number,
  columnWindow: CsvColumnWindow = {
    start: 0,
    end: headers.length,
    leftOffsetPx: 0,
    rightOffsetPx: 0,
    totalWidthPx: headers.reduce(
      (sum, _header, index) => sum + (colWidthsPx[index] ?? CSV_DEFAULT_COL_WIDTH_PX),
      0,
    ),
  },
  options: RenderHeaderOptions = {},
): void {
  headerRow.replaceChildren();
  headerRow.style.width = `${columnWindow.totalWidthPx}px`;

  headerRow.append(createHeaderSpacer(columnWindow.leftOffsetPx));

  for (let i = columnWindow.start; i < columnWindow.end; i++) {
    const cell = document.createElement("div");
    cell.role = "columnheader";
    cell.setAttribute("aria-colindex", String(i + 1));
    cell.className = "dp-grid-header-cell";
    cell.dataset.columnIndex = String(i);
    const w = colWidthsPx[i] ?? CSV_DEFAULT_COL_WIDTH_PX;
    cell.style.width = `${w}px`;
    cell.style.minWidth = `${w}px`;
    cell.style.height = `${rowHeightPx}px`;

    const label = document.createElement("span");
    label.className = "dp-grid-header-label";
    label.textContent = headers[i] ?? "";
    cell.append(label);

    const isPending = options.pendingSortColumn === i;
    const direction =
      options.activeSort?.column === i && !isPending ? options.activeSort.direction : null;

    if (isPending || direction !== null) {
      const indicator = document.createElement("span");
      indicator.className = "dp-grid-header-sort";
      indicator.setAttribute("aria-hidden", "true");
      if (isPending) {
        indicator.dataset.state = "pending";
        indicator.textContent = "…";
      } else {
        indicator.dataset.state = direction ?? "";
        indicator.textContent = direction === "asc" ? "▲" : "▼";
      }
      cell.append(indicator);
    }

    if (isPending) {
      cell.setAttribute("aria-sort", "other");
    } else if (direction === "asc") {
      cell.setAttribute("aria-sort", "ascending");
    } else if (direction === "desc") {
      cell.setAttribute("aria-sort", "descending");
    } else {
      cell.setAttribute("aria-sort", "none");
    }

    headerRow.append(cell);
  }

  headerRow.append(createHeaderSpacer(columnWindow.rightOffsetPx));
}

function createHeaderSpacer(widthPx: number): HTMLDivElement {
  const spacer = document.createElement("div");
  spacer.className = "shrink-0";
  spacer.setAttribute("aria-hidden", "true");
  spacer.style.width = `${widthPx}px`;
  spacer.style.minWidth = `${widthPx}px`;
  return spacer;
}
