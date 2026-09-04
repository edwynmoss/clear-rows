import { CSV_DEFAULT_COL_WIDTH_PX } from "../app/constants";
import { columnTypeLabel, type ColumnType } from "../csv/column-types";
import type { CsvColumnWindow } from "../csv/column-window";
import type { ActiveSort } from "../csv/csv-session";

export type CsvPreviewGridRefs = {
  readonly root: HTMLDivElement;
  readonly headerViewport: HTMLDivElement;
  readonly gutterHeader: HTMLDivElement;
  readonly headerRow: HTMLDivElement;
  readonly scrollRegion: HTMLDivElement;
  readonly inner: HTMLDivElement;
  readonly spacerTop: HTMLDivElement;
  readonly windowRows: HTMLDivElement;
  readonly spacerBottom: HTMLDivElement;
};

export type CsvPreviewGridOptions = {
  rowHeightPx?: number;
  gutterWidthPx?: number;
  gridLabel?: string;
};

/**
 * Grid shell: a sticky header strip (row-number gutter + horizontally
 * translated column headers) over a scroll body with spacer slots for
 * virtualization.
 */
export function createCsvPreviewGrid(options: CsvPreviewGridOptions = {}): CsvPreviewGridRefs {
  const gutterWidth = options.gutterWidthPx ?? 52;

  const root = document.createElement("div");
  root.className = "cr-grid";

  const headerViewport = document.createElement("div");
  headerViewport.className = "cr-grid-head";

  const gutterHeader = document.createElement("div");
  gutterHeader.className = "cr-grid-gutter cr-grid-gutter-head";
  gutterHeader.style.width = `${gutterWidth}px`;
  gutterHeader.style.minWidth = `${gutterWidth}px`;
  gutterHeader.textContent = "#";
  gutterHeader.setAttribute("aria-hidden", "true");

  const headerClip = document.createElement("div");
  headerClip.className = "cr-grid-head-clip";

  const headerRow = document.createElement("div");
  headerRow.className = "cr-grid-head-row";
  headerRow.setAttribute("role", "row");

  headerClip.append(headerRow);
  headerViewport.append(gutterHeader, headerClip);

  const scrollRegion = document.createElement("div");
  scrollRegion.className = "cr-grid-scroll";
  scrollRegion.tabIndex = 0;
  scrollRegion.role = "grid";
  scrollRegion.setAttribute("aria-label", options.gridLabel ?? "Rows");
  scrollRegion.setAttribute("aria-rowcount", "0");
  scrollRegion.setAttribute("aria-colcount", "0");

  const inner = document.createElement("div");
  inner.className = "cr-grid-inner";

  const spacerTop = document.createElement("div");
  spacerTop.style.height = "0px";

  const windowRows = document.createElement("div");
  windowRows.className = "cr-grid-rows";

  const spacerBottom = document.createElement("div");
  spacerBottom.style.height = "0px";

  inner.append(spacerTop, windowRows, spacerBottom);
  scrollRegion.append(inner);
  root.append(headerViewport, scrollRegion);

  return {
    root,
    headerViewport,
    gutterHeader,
    headerRow,
    scrollRegion,
    inner,
    spacerTop,
    windowRows,
    spacerBottom,
  };
}

export type RenderHeaderOptions = {
  activeSort?: ActiveSort;
  /** Detected type per column ("integer", "date", ...) for alignment and tooltips. */
  columnTypes?: string[];
  pendingSortColumn?: number | null;
  onResizeStart?: (columnIndex: number, event: PointerEvent) => void;
  onResizeReset?: (columnIndex: number) => void;
  onMenu?: (columnIndex: number, anchor: HTMLElement) => void;
};

export function renderCsvHeaderRow(
  headerRow: HTMLDivElement,
  headers: string[],
  colWidthsPx: number[],
  rowHeightPx: number,
  columnWindow: CsvColumnWindow,
  options: RenderHeaderOptions = {},
): void {
  headerRow.replaceChildren();
  headerRow.style.width = `${columnWindow.totalWidthPx}px`;
  headerRow.append(createHeaderSpacer(columnWindow.leftOffsetPx));

  for (let i = columnWindow.start; i < columnWindow.end; i++) {
    const w = colWidthsPx[i] ?? CSV_DEFAULT_COL_WIDTH_PX;
    if (w <= 0) continue;

    const cell = document.createElement("div");
    cell.role = "columnheader";
    cell.setAttribute("aria-colindex", String(i + 1));
    cell.className = "cr-col";
    cell.dataset.columnIndex = String(i);
    cell.style.width = `${w}px`;
    cell.style.minWidth = `${w}px`;
    cell.style.height = `${rowHeightPx}px`;
    const type = options.columnTypes?.[i] ?? "";
    cell.dataset.type = type;
    cell.title = type ? `${headers[i] || `Column ${i + 1}`} · ${columnTypeLabel(type as ColumnType)}` : (headers[i] ?? "");

    const label = document.createElement("span");
    label.className = "cr-col-label";
    label.textContent = headers[i] || `Column ${i + 1}`;
    cell.append(label);

    const isPending = options.pendingSortColumn === i;
    const sortKeys = options.activeSort ?? [];
    const sortKeyIndex = isPending ? -1 : sortKeys.findIndex((key) => key.column === i);
    const direction = sortKeyIndex >= 0 ? sortKeys[sortKeyIndex].direction : null;

    if (isPending || direction !== null) {
      const indicator = document.createElement("span");
      indicator.className = "cr-col-sort";
      indicator.setAttribute("aria-hidden", "true");
      if (isPending) {
        indicator.dataset.state = "pending";
        indicator.textContent = "…";
      } else {
        indicator.dataset.state = direction ?? "";
        indicator.textContent = direction === "asc" ? "↑" : "↓";
        if (sortKeys.length > 1) {
          const badge = document.createElement("sup");
          badge.textContent = String(sortKeyIndex + 1);
          indicator.append(badge);
        }
      }
      cell.append(indicator);
    }

    if (options.onMenu) {
      const menu = document.createElement("button");
      menu.type = "button";
      menu.className = "cr-col-menu";
      menu.setAttribute("aria-label", `Column options for ${headers[i] || `column ${i + 1}`}`);
      menu.textContent = "⋯";
      menu.addEventListener("click", (event) => {
        event.stopPropagation();
        options.onMenu?.(i, menu);
      });
      cell.append(menu);
    }

    const handle = document.createElement("div");
    handle.className = "cr-col-resize";
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      event.preventDefault();
      options.onResizeStart?.(i, event);
    });
    handle.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      options.onResizeReset?.(i);
    });
    handle.addEventListener("click", (event) => event.stopPropagation());
    cell.append(handle);

    cell.setAttribute(
      "aria-sort",
      isPending ? "other" : direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none",
    );

    headerRow.append(cell);
  }

  headerRow.append(createHeaderSpacer(columnWindow.rightOffsetPx));
}

function createHeaderSpacer(widthPx: number): HTMLDivElement {
  const spacer = document.createElement("div");
  spacer.className = "cr-spacer-cell";
  spacer.setAttribute("aria-hidden", "true");
  spacer.style.width = `${widthPx}px`;
  spacer.style.minWidth = `${widthPx}px`;
  return spacer;
}
