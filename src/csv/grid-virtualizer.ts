import { renderCsvHeaderRow, type CsvPreviewGridRefs } from "../components/csv-preview-grid";
import { createGridRow, updateGridRow } from "../components/grid-row";
import {
  CSV_DEFAULT_COL_WIDTH_PX,
  CSV_ROW_HEIGHT_PX,
  CSV_VIRTUAL_SCROLL_BUFFER_PX,
  CSV_VIRTUAL_SCROLL_BUFFER_ROWS,
} from "../app/constants";

import type { CsvSession } from "./csv-session";
import { calculateColumnWindow, type CsvColumnWindow } from "./column-window";
import { CsvRowWindowStore, type FetchCsvRows } from "./row-window-store";

const MIN_COLUMN_WIDTH_PX = 64;
const MAX_AUTO_COLUMN_WIDTH_PX = 440;
const SKELETON_ROWS = 4;

export type HighlightedCell = { rowIndex: number; columnIndex: number };

export class CsvGridVirtualizer {
  private readonly refs: CsvPreviewGridRefs;
  private readonly session: CsvSession;
  private readonly rowHeightPx: number;
  private readonly gutterWidthPx: number;
  private readonly bufferRows: number;
  private readonly columnBufferPx: number;
  private readonly rowStore: CsvRowWindowStore;
  private resizeObserver: ResizeObserver | null = null;
  private rafHandle = 0;
  private refreshGeneration = 0;
  private lastScrollTop = 0;
  private rowPool: HTMLDivElement[] = [];
  private highlightedCell: HighlightedCell | null = null;
  private pendingSortColumn: number | null = null;
  private indexing = false;
  private measureCanvas: CanvasRenderingContext2D | null = null;
  private onHighlightChange: ((cell: HighlightedCell | null) => void) | null = null;
  private onColumnMenu: ((columnIndex: number, anchor: HTMLElement) => void) | null = null;
  private resizeState: { columnIndex: number; startX: number; startWidth: number } | null = null;

  constructor(options: {
    refs: CsvPreviewGridRefs;
    session: CsvSession;
    fetchRows: FetchCsvRows;
    rowHeightPx?: number;
    gutterWidthPx?: number;
    bufferRows?: number;
    columnBufferPx?: number;
    onHighlightChange?: (cell: HighlightedCell | null) => void;
    onColumnMenu?: (columnIndex: number, anchor: HTMLElement) => void;
  }) {
    this.refs = options.refs;
    this.session = options.session;
    this.rowStore = new CsvRowWindowStore({ fetchRows: options.fetchRows });
    this.rowHeightPx = options.rowHeightPx ?? CSV_ROW_HEIGHT_PX;
    this.gutterWidthPx = options.gutterWidthPx ?? 52;
    this.bufferRows = options.bufferRows ?? CSV_VIRTUAL_SCROLL_BUFFER_ROWS;
    this.columnBufferPx = options.columnBufferPx ?? CSV_VIRTUAL_SCROLL_BUFFER_PX;
    this.onHighlightChange = options.onHighlightChange ?? null;
    this.onColumnMenu = options.onColumnMenu ?? null;
  }

  bind(): void {
    const scroll = this.refs.scrollRegion;
    scroll.onscroll = () => this.scheduleRefresh();
    scroll.addEventListener("wheel", this.handleWheel, { passive: false });
    window.addEventListener("pointermove", this.handleResizeMove);
    window.addEventListener("pointerup", this.handleResizeEnd);

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.scheduleRefresh());
    this.resizeObserver.observe(scroll);
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.deltaY === 0 && event.deltaX === 0) return;
    event.preventDefault();
    const scroll = this.refs.scrollRegion;
    const dy = normalizeWheelDelta(event.deltaY, event.deltaMode, this.rowHeightPx);
    const dx = normalizeWheelDelta(event.deltaX, event.deltaMode, this.rowHeightPx);
    if (event.shiftKey && dx === 0) {
      scroll.scrollLeft += dy;
      return;
    }
    scroll.scrollTop += dy;
    scroll.scrollLeft += dx;
  };

  dispose(): void {
    if (this.rafHandle !== 0) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }
    this.refs.scrollRegion.onscroll = null;
    this.refs.scrollRegion.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("pointermove", this.handleResizeMove);
    window.removeEventListener("pointerup", this.handleResizeEnd);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.rowStore.clear();
    this.rowPool = [];
  }

  updateAria(): void {
    const { rowCount, headers } = this.session;
    this.refs.scrollRegion.setAttribute("aria-rowcount", String(rowCount));
    this.refs.scrollRegion.setAttribute("aria-colcount", String(headers.length));
  }

  reset(): void {
    this.refreshGeneration++;
    this.lastScrollTop = 0;
    this.rowStore.clear();
    this.refs.scrollRegion.scrollTop = 0;
    this.refs.scrollRegion.scrollLeft = 0;
    this.refs.headerRow.style.transform = "translateX(0px)";
    this.refs.spacerTop.style.height = "0px";
    this.refs.spacerBottom.style.height = "0px";
    this.refs.windowRows.replaceChildren();
    this.rowPool = [];
    this.setHighlightedCellInternal(null, false);
  }

  setIndexing(indexing: boolean): void {
    if (this.indexing === indexing) return;
    this.indexing = indexing;
    this.scheduleRefresh();
  }

  async scrollToCell(rowIndex: number, columnIndex: number): Promise<void> {
    if (this.session.rowCount === 0 || this.session.headers.length === 0) return;

    const safeRowIndex = Math.min(Math.max(0, Math.floor(rowIndex)), Math.max(0, this.session.scrollRowCount - 1));
    const safeColumnIndex = Math.min(Math.max(0, Math.floor(columnIndex)), Math.max(0, this.session.headers.length - 1));

    this.setHighlightedCellInternal({ rowIndex: safeRowIndex, columnIndex: safeColumnIndex }, false);
    this.refs.scrollRegion.scrollTop = this.getCenteredRowScrollTop(safeRowIndex);
    this.refs.scrollRegion.scrollLeft = this.getCenteredColumnScrollLeft(safeColumnIndex);
    this.lastScrollTop = this.refs.scrollRegion.scrollTop;

    await this.refresh();
    this.refs.scrollRegion.focus({ preventScroll: true });
  }

  /** Keep the highlighted cell visible without recentering when it already is. */
  ensureCellVisible(rowIndex: number, columnIndex: number): void {
    const scroll = this.refs.scrollRegion;
    const top = rowIndex * this.rowHeightPx;
    const bottom = top + this.rowHeightPx;
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (bottom > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = bottom - scroll.clientHeight;

    const widths = this.session.effectiveColWidths();
    const left = this.getColumnOffsetPx(columnIndex, widths);
    const right = left + (widths[columnIndex] ?? CSV_DEFAULT_COL_WIDTH_PX);
    const viewLeft = scroll.scrollLeft;
    const viewRight = viewLeft + scroll.clientWidth - this.gutterWidthPx;
    if (left < viewLeft) scroll.scrollLeft = left;
    else if (right > viewRight) scroll.scrollLeft = right - (scroll.clientWidth - this.gutterWidthPx);
  }

  scheduleRefresh(): void {
    if (this.rafHandle !== 0) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      void this.refresh();
    });
  }

  isViewportPastRow(rowCount: number): boolean {
    const firstVisibleRow = Math.max(0, Math.floor(this.refs.scrollRegion.scrollTop / this.rowHeightPx) - this.bufferRows);
    return firstVisibleRow >= rowCount;
  }

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const { spacerTop, spacerBottom, windowRows, scrollRegion } = this.refs;
    const availableRowCount = this.session.rowCount;
    const scrollRowCount = Math.max(this.session.scrollRowCount, availableRowCount === 0 ? 0 : 1);
    const rowHeight = this.rowHeightPx;
    const columnWindow = this.calculateColumnWindow();
    this.syncHorizontalLayout(columnWindow);

    const skeletonCount = this.indexing && this.session.activeFilter === null ? SKELETON_ROWS : 0;

    if (scrollRowCount === 0) {
      spacerTop.style.height = "0px";
      spacerBottom.style.height = "0px";
      windowRows.replaceChildren();
      return;
    }

    const scrollTop = scrollRegion.scrollTop;
    const viewport = scrollRegion.clientHeight;
    const buf = this.bufferRows;
    const scrollDirection = scrollTop >= this.lastScrollTop ? 1 : -1;
    this.lastScrollTop = scrollTop;

    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - buf);
    const lastExclusive = Math.min(scrollRowCount, Math.ceil((scrollTop + viewport) / rowHeight) + buf);
    const fetchLastExclusive = Math.min(lastExclusive, availableRowCount);

    spacerTop.style.height = `${first * rowHeight}px`;
    spacerBottom.style.height = `${Math.max(0, scrollRowCount - lastExclusive) * rowHeight}px`;

    const rawCount = fetchLastExclusive - first;
    if (rawCount <= 0) {
      windowRows.replaceChildren();
      return;
    }

    try {
      const columnCount = columnWindow.end - columnWindow.start;
      const batch = await this.rowStore.getRows(first, rawCount, availableRowCount, columnWindow.start, columnCount);
      if (generation !== this.refreshGeneration) return;

      const fragment = document.createDocumentFragment();
      const colWidthsPx = this.session.effectiveColWidths();
      let poolIndex = 0;

      for (let i = 0; i < batch.rows.length; i++) {
        const rowIndex = batch.start + i;
        fragment.append(
          this.getReusableRow(poolIndex++, {
            rowIndex,
            cells: batch.rows[i] ?? [],
            cellsColumnStart: batch.column_start,
            columnWindow,
            colWidthsPx,
            rowHeightPx: rowHeight,
            gutterWidthPx: this.gutterWidthPx,
            highlightedCell: this.highlightedCell,
          }),
        );
      }

      // Skeleton rows at the tail while indexing, only when the viewport reaches the end.
      const reachesEnd = batch.start + batch.rows.length >= availableRowCount;
      if (skeletonCount > 0 && reachesEnd) {
        for (let s = 0; s < skeletonCount; s++) {
          fragment.append(
            this.getReusableRow(poolIndex++, {
              rowIndex: availableRowCount + s,
              cells: [],
              cellsColumnStart: columnWindow.start,
              columnWindow,
              colWidthsPx,
              rowHeightPx: rowHeight,
              gutterWidthPx: this.gutterWidthPx,
              skeleton: true,
            }),
          );
        }
      }

      windowRows.replaceChildren(fragment);
      delete this.refs.root.dataset.stale;
      this.prefetchAdjacentRows(scrollDirection, first, lastExclusive, rawCount, availableRowCount, columnWindow);
    } catch (err) {
      if (generation === this.refreshGeneration) console.error(err);
    }
  }

  private prefetchAdjacentRows(
    scrollDirection: number,
    first: number,
    lastExclusive: number,
    count: number,
    rowCount: number,
    columnWindow: CsvColumnWindow,
  ): void {
    if (count <= 0) return;
    const prefetchStart = scrollDirection >= 0 ? lastExclusive : Math.max(0, first - count);
    this.rowStore.prefetchRows(prefetchStart, count, rowCount, columnWindow.start, columnWindow.end - columnWindow.start);
  }

  private getReusableRow(poolIndex: number, options: Parameters<typeof createGridRow>[0]): HTMLDivElement {
    const row = this.rowPool[poolIndex];
    if (!row) {
      const created = createGridRow(options);
      this.rowPool[poolIndex] = created;
      return created;
    }
    updateGridRow(row, options);
    return row;
  }

  private calculateColumnWindow(): CsvColumnWindow {
    return calculateColumnWindow({
      colWidthsPx: this.session.effectiveColWidths(),
      scrollLeftPx: this.refs.scrollRegion.scrollLeft,
      viewportWidthPx: Math.max(0, this.refs.scrollRegion.clientWidth - this.gutterWidthPx),
      bufferPx: this.columnBufferPx,
    });
  }

  setPendingSortColumn(columnIndex: number | null): void {
    this.pendingSortColumn = columnIndex;
    this.scheduleRefresh();
  }

  setHighlightedCell(cell: HighlightedCell | null): void {
    if (cell === null) {
      this.setHighlightedCellInternal(null, true);
      return;
    }
    const rowIndex = Math.min(Math.max(0, Math.floor(cell.rowIndex)), Math.max(0, this.session.scrollRowCount - 1));
    const columnIndex = Math.min(Math.max(0, Math.floor(cell.columnIndex)), Math.max(0, this.session.headers.length - 1));
    if (this.highlightedCell?.rowIndex === rowIndex && this.highlightedCell.columnIndex === columnIndex) return;
    this.setHighlightedCellInternal({ rowIndex, columnIndex }, true);
  }

  /** Move the highlight by rows/columns (keyboard navigation); skips hidden columns. */
  moveHighlight(deltaRows: number, deltaColumns: number, options: { page?: boolean } = {}): void {
    const rowCount = this.session.scrollRowCount;
    if (rowCount === 0 || this.session.headers.length === 0) return;
    const visible = this.session.visibleColumnIndices();
    const current = this.highlightedCell ?? { rowIndex: Math.floor(this.refs.scrollRegion.scrollTop / this.rowHeightPx), columnIndex: visible[0] ?? 0 };

    const pageRows = Math.max(1, Math.floor(this.refs.scrollRegion.clientHeight / this.rowHeightPx) - 1);
    const rowStep = options.page ? deltaRows * pageRows : deltaRows;
    const rowIndex = Math.min(rowCount - 1, Math.max(0, current.rowIndex + rowStep));

    let columnIndex = current.columnIndex;
    if (deltaColumns !== 0) {
      const position = Math.max(0, visible.indexOf(current.columnIndex));
      const next = Math.min(visible.length - 1, Math.max(0, position + deltaColumns));
      columnIndex = visible[next] ?? current.columnIndex;
    }

    this.setHighlightedCellInternal({ rowIndex, columnIndex }, true);
    this.ensureCellVisible(rowIndex, columnIndex);
  }

  moveHighlightToEdge(edge: "top" | "bottom" | "start" | "end"): void {
    const rowCount = this.session.scrollRowCount;
    if (rowCount === 0) return;
    const visible = this.session.visibleColumnIndices();
    const current = this.highlightedCell ?? { rowIndex: 0, columnIndex: visible[0] ?? 0 };
    const target: HighlightedCell =
      edge === "top"
        ? { rowIndex: 0, columnIndex: current.columnIndex }
        : edge === "bottom"
          ? { rowIndex: rowCount - 1, columnIndex: current.columnIndex }
          : edge === "start"
            ? { rowIndex: current.rowIndex, columnIndex: visible[0] ?? 0 }
            : { rowIndex: current.rowIndex, columnIndex: visible[visible.length - 1] ?? 0 };
    this.setHighlightedCellInternal(target, true);
    this.ensureCellVisible(target.rowIndex, target.columnIndex);
  }

  getHighlightedCell(): HighlightedCell | null {
    return this.highlightedCell;
  }

  private setHighlightedCellInternal(cell: HighlightedCell | null, refresh: boolean): void {
    this.highlightedCell = cell;
    this.onHighlightChange?.(cell);
    if (refresh) this.scheduleRefresh();
  }

  resetRowsForVisibilityChange(): void {
    this.refreshGeneration++;
    this.rowStore.clear();
    // Keep the current rows on screen, dimmed, until the new page arrives.
    // Clearing here produced a blank grid for the length of the fetch.
    this.refs.root.dataset.stale = "true";
    this.setHighlightedCellInternal(null, false);
    this.scheduleRefresh();
  }

  /** Column widths ------------------------------------------------------ */

  setColumnWidth(columnIndex: number, widthPx: number): void {
    if (columnIndex < 0 || columnIndex >= this.session.colWidths.length) return;
    this.session.colWidths[columnIndex] = Math.max(MIN_COLUMN_WIDTH_PX, Math.round(widthPx));
    this.scheduleRefresh();
  }

  /** Size every column to fit its header and a sample of rows. */
  autoFitColumns(sampleRows: string[][]): void {
    const ctx = this.getMeasureContext();
    const headers = this.session.headers;
    const widths = headers.map((header, index) => {
      let max = ctx ? ctx.measureText(header || `Column ${index + 1}`).width + 44 : CSV_DEFAULT_COL_WIDTH_PX;
      for (const row of sampleRows) {
        const text = row[index];
        if (!text) continue;
        const sample = text.length > 80 ? text.slice(0, 80) : text;
        const width = ctx ? ctx.measureText(sample).width + 26 : Math.min(sample.length * 7.2 + 26, MAX_AUTO_COLUMN_WIDTH_PX);
        if (width > max) max = width;
      }
      return Math.round(Math.min(MAX_AUTO_COLUMN_WIDTH_PX, Math.max(MIN_COLUMN_WIDTH_PX, max)));
    });
    this.session.colWidths = widths;
    this.scheduleRefresh();
  }

  autoFitColumn(columnIndex: number): void {
    const ctx = this.getMeasureContext();
    const header = this.session.headers[columnIndex] ?? "";
    let max = ctx ? ctx.measureText(header).width + 44 : CSV_DEFAULT_COL_WIDTH_PX;
    for (const row of Array.from(this.refs.windowRows.children)) {
      const cell = row.querySelector<HTMLElement>(`[data-column-index="${columnIndex}"]`);
      const text = cell?.textContent ?? "";
      if (!text) continue;
      const width = ctx ? ctx.measureText(text.slice(0, 120)).width + 26 : text.length * 7.2 + 26;
      if (width > max) max = width;
    }
    this.setColumnWidth(columnIndex, Math.min(MAX_AUTO_COLUMN_WIDTH_PX * 1.5, max));
  }

  private getMeasureContext(): CanvasRenderingContext2D | null {
    if (this.measureCanvas) return this.measureCanvas;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const probe = this.refs.windowRows.querySelector<HTMLElement>(".cr-cell") ?? this.refs.scrollRegion;
    const style = getComputedStyle(probe);
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    this.measureCanvas = ctx;
    return ctx;
  }

  private readonly handleResizeMove = (event: PointerEvent): void => {
    if (!this.resizeState) return;
    const delta = event.clientX - this.resizeState.startX;
    this.session.colWidths[this.resizeState.columnIndex] = Math.max(MIN_COLUMN_WIDTH_PX, Math.round(this.resizeState.startWidth + delta));
    this.scheduleRefresh();
  };

  private readonly handleResizeEnd = (): void => {
    if (!this.resizeState) return;
    this.resizeState = null;
    document.body.classList.remove("cr-resizing");
  };

  private syncHorizontalLayout(columnWindow: CsvColumnWindow): void {
    this.refs.inner.style.width = `${columnWindow.totalWidthPx + this.gutterWidthPx}px`;
    this.refs.headerRow.style.transform = `translateX(-${this.refs.scrollRegion.scrollLeft}px)`;

    renderCsvHeaderRow(this.refs.headerRow, this.session.headers, this.session.colWidths, this.rowHeightPx, columnWindow, {
      activeSort: this.session.activeSort,
      pendingSortColumn: this.pendingSortColumn,
      onResizeStart: (columnIndex, event) => {
        this.resizeState = {
          columnIndex,
          startX: event.clientX,
          startWidth: this.session.colWidths[columnIndex] ?? CSV_DEFAULT_COL_WIDTH_PX,
        };
        document.body.classList.add("cr-resizing");
      },
      onResizeReset: (columnIndex) => this.autoFitColumn(columnIndex),
      onMenu: this.onColumnMenu ?? undefined,
    });
  }

  private getCenteredRowScrollTop(rowIndex: number): number {
    const viewport = this.refs.scrollRegion.clientHeight;
    const targetTop = rowIndex * this.rowHeightPx;
    const centeredTop = targetTop - Math.max(0, (viewport - this.rowHeightPx) / 2);
    const maxScrollTop = Math.max(0, this.session.scrollRowCount * this.rowHeightPx - viewport);
    return Math.min(Math.max(0, centeredTop), maxScrollTop);
  }

  private getCenteredColumnScrollLeft(columnIndex: number): number {
    const widths = this.session.effectiveColWidths();
    const columnLeft = this.getColumnOffsetPx(columnIndex, widths);
    const columnWidth = widths[columnIndex] ?? CSV_DEFAULT_COL_WIDTH_PX;
    const totalWidth = widths.reduce((sum, width) => sum + width, 0);
    const viewport = this.refs.scrollRegion.clientWidth - this.gutterWidthPx;
    const centeredLeft = columnLeft - Math.max(0, (viewport - columnWidth) / 2);
    const maxScrollLeft = Math.max(0, totalWidth - viewport);
    return Math.min(Math.max(0, centeredLeft), maxScrollLeft);
  }

  private getColumnOffsetPx(columnIndex: number, widths: number[]): number {
    let offset = 0;
    for (let i = 0; i < columnIndex; i++) offset += widths[i] ?? CSV_DEFAULT_COL_WIDTH_PX;
    return offset;
  }
}

function normalizeWheelDelta(delta: number, mode: number, rowHeightPx: number): number {
  switch (mode) {
    case 1:
      return delta * rowHeightPx;
    case 2:
      return delta * rowHeightPx * 16;
    default:
      return delta;
  }
}
