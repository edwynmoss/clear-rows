import { CSV_DEFAULT_COL_WIDTH_PX } from "../app/constants";
import type { CsvColumnWindow } from "../csv/column-window";

export type GridRowOptions = {
  rowIndex: number;
  cells: string[];
  cellsColumnStart: number;
  columnWindow: CsvColumnWindow;
  colWidthsPx: number[];
  rowHeightPx: number;
  gutterWidthPx: number;
  highlightedCell?: { rowIndex: number; columnIndex: number } | null;
  /** Placeholder row while indexing catches up. */
  skeleton?: boolean;
};

export function createGridRow(options: GridRowOptions): HTMLDivElement {
  const rowEl = document.createElement("div");
  rowEl.role = "row";
  rowEl.className = "cr-row";
  const gutter = document.createElement("div");
  gutter.className = "cr-grid-gutter cr-row-num";
  gutter.setAttribute("aria-hidden", "true");
  rowEl.append(gutter, createSpacer(), createSpacer());
  updateGridRow(rowEl, options);
  return rowEl;
}

export function updateGridRow(rowEl: HTMLDivElement, options: GridRowOptions): void {
  const isHighlightedRow =
    !options.skeleton && options.highlightedCell?.rowIndex === options.rowIndex;

  rowEl.dataset.selected = isHighlightedRow ? "true" : "false";
  rowEl.dataset.skeleton = options.skeleton ? "true" : "false";
  rowEl.style.height = `${options.rowHeightPx}px`;
  rowEl.style.width = `${options.columnWindow.totalWidthPx + options.gutterWidthPx}px`;
  rowEl.setAttribute("aria-rowindex", String(options.rowIndex + 1));
  rowEl.dataset.rowIndex = String(options.rowIndex);

  const gutter = rowEl.firstElementChild as HTMLDivElement;
  gutter.style.width = `${options.gutterWidthPx}px`;
  gutter.style.minWidth = `${options.gutterWidthPx}px`;
  const rowNumber = options.skeleton ? "" : (options.rowIndex + 1).toLocaleString("en-US");
  if (gutter.textContent !== rowNumber) gutter.textContent = rowNumber;

  const visibleColumns: number[] = [];
  for (let i = options.columnWindow.start; i < options.columnWindow.end; i++) {
    const width = options.colWidthsPx[i] ?? CSV_DEFAULT_COL_WIDTH_PX;
    if (width > 0) visibleColumns.push(i);
  }

  ensureCellCount(rowEl, visibleColumns.length);
  // children: [gutter, leftSpacer, ...cells, rightSpacer]
  updateSpacer(rowEl.children.item(1) as HTMLDivElement, options.columnWindow.leftOffsetPx);
  updateSpacer(rowEl.lastElementChild as HTMLDivElement, options.columnWindow.rightOffsetPx);

  for (let i = 0; i < visibleColumns.length; i++) {
    const columnIndex = visibleColumns[i];
    const cell = rowEl.children.item(i + 2) as HTMLDivElement;
    const width = options.colWidthsPx[columnIndex] ?? CSV_DEFAULT_COL_WIDTH_PX;
    const text = options.skeleton ? "" : options.cells[columnIndex - options.cellsColumnStart] ?? "";
    const isHighlightedCell =
      !options.skeleton &&
      options.highlightedCell?.rowIndex === options.rowIndex &&
      options.highlightedCell.columnIndex === columnIndex;

    cell.dataset.selected = isHighlightedCell ? "true" : "false";
    cell.style.width = `${width}px`;
    cell.style.minWidth = `${width}px`;
    cell.setAttribute("aria-colindex", String(columnIndex + 1));
    cell.dataset.columnIndex = String(columnIndex);
    cell.toggleAttribute("aria-selected", isHighlightedCell);

    if (options.skeleton) {
      if (!cell.firstElementChild || cell.firstElementChild.tagName !== "I") {
        cell.replaceChildren();
        const bone = document.createElement("i");
        bone.style.width = `${30 + ((columnIndex * 37 + options.rowIndex * 11) % 50)}%`;
        cell.append(bone);
      }
    } else if (cell.firstElementChild) {
      cell.replaceChildren();
      cell.textContent = text;
    } else if (cell.textContent !== text) {
      cell.textContent = text;
    }
  }
}

function ensureCellCount(rowEl: HTMLDivElement, columnCount: number): void {
  const desiredChildCount = columnCount + 3;
  while (rowEl.children.length > desiredChildCount) {
    rowEl.children.item(rowEl.children.length - 2)?.remove();
  }
  while (rowEl.children.length < desiredChildCount) {
    rowEl.insertBefore(createGridCell(), rowEl.lastElementChild);
  }
}

function updateSpacer(spacer: HTMLDivElement, widthPx: number): void {
  spacer.style.width = `${widthPx}px`;
  spacer.style.minWidth = `${widthPx}px`;
}

function createSpacer(): HTMLDivElement {
  const spacer = document.createElement("div");
  spacer.className = "cr-spacer-cell";
  spacer.setAttribute("aria-hidden", "true");
  return spacer;
}

function createGridCell(): HTMLDivElement {
  const cell = document.createElement("div");
  cell.role = "gridcell";
  cell.className = "cr-cell";
  return cell;
}
