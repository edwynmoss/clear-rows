import { CSV_DEFAULT_COL_WIDTH_PX } from "../app/constants";
import type { CsvColumnWindow } from "../csv/column-window";

const ROW_CLASS =
  "group flex border-b border-border/60 bg-surface transition-colors hover:bg-surface-elevated";
const HIGHLIGHTED_ROW_CLASS =
  "group flex border-b border-accent/35 bg-accent/10 transition-colors hover:bg-accent/15";
const CELL_CLASS =
  "truncate border-r border-border/50 px-3 py-1 font-mono text-[11px] tabular-nums leading-normal text-foreground/90";
const HIGHLIGHTED_CELL_CLASS =
  "truncate border-r border-accent/40 bg-accent/25 px-3 py-1 font-mono text-[11px] font-semibold tabular-nums leading-normal text-foreground ring-1 ring-inset ring-accent/45";

export type GridRowOptions = {
  rowIndex: number;
  cells: string[];
  cellsColumnStart: number;
  columnWindow: CsvColumnWindow;
  colWidthsPx: number[];
  rowHeightPx: number;
  highlightedCell?: {
    rowIndex: number;
    columnIndex: number;
  } | null;
};

export function createGridRow(options: GridRowOptions): HTMLDivElement {
  const rowEl = document.createElement("div");
  rowEl.role = "row";

  updateGridRow(rowEl, options);
  return rowEl;
}

export function updateGridRow(rowEl: HTMLDivElement, options: GridRowOptions): void {
  const isHighlightedRow = options.highlightedCell?.rowIndex === options.rowIndex;

  rowEl.className = isHighlightedRow ? HIGHLIGHTED_ROW_CLASS : ROW_CLASS;
  rowEl.style.height = `${options.rowHeightPx}px`;
  rowEl.style.width = `${options.columnWindow.totalWidthPx}px`;
  rowEl.setAttribute("aria-rowindex", String(options.rowIndex + 1));
  rowEl.dataset.rowIndex = String(options.rowIndex);

  // Build the list of physical column indices to render: every column inside
  // the window with non-zero width (hidden columns fold to width 0).
  const visibleColumns: number[] = [];
  for (let i = options.columnWindow.start; i < options.columnWindow.end; i++) {
    const width = options.colWidthsPx[i] ?? CSV_DEFAULT_COL_WIDTH_PX;
    if (width > 0) {
      visibleColumns.push(i);
    }
  }

  ensureCellCount(rowEl, visibleColumns.length);
  updateSpacer(rowEl.firstElementChild as HTMLDivElement, options.columnWindow.leftOffsetPx);
  updateSpacer(rowEl.lastElementChild as HTMLDivElement, options.columnWindow.rightOffsetPx);

  for (let i = 0; i < visibleColumns.length; i++) {
    const columnIndex = visibleColumns[i];
    const cell = rowEl.children.item(i + 1) as HTMLDivElement;
    const width = options.colWidthsPx[columnIndex] ?? CSV_DEFAULT_COL_WIDTH_PX;
    const text = options.cells[columnIndex - options.cellsColumnStart] ?? "";
    const isHighlightedCell =
      options.highlightedCell?.rowIndex === options.rowIndex &&
      options.highlightedCell.columnIndex === columnIndex;

    cell.className = isHighlightedCell ? HIGHLIGHTED_CELL_CLASS : CELL_CLASS;
    cell.style.width = `${width}px`;
    cell.style.minWidth = `${width}px`;
    cell.setAttribute("aria-colindex", String(columnIndex + 1));
    cell.toggleAttribute("aria-selected", isHighlightedCell);

    if (cell.textContent !== text) {
      cell.textContent = text;
    }
  }
}

function ensureCellCount(rowEl: HTMLDivElement, columnCount: number): void {
  if (rowEl.children.length === 0) {
    rowEl.append(createSpacer(), createSpacer());
  }

  const desiredChildCount = columnCount + 2;

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
  spacer.className = "shrink-0";
  spacer.setAttribute("aria-hidden", "true");
  return spacer;
}

function createGridCell(): HTMLDivElement {
  const cell = document.createElement("div");
  cell.role = "gridcell";
  cell.className = CELL_CLASS;

  return cell;
}
