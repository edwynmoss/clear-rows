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

export class CsvGridVirtualizer {
  private readonly refs: CsvPreviewGridRefs;
  private readonly session: CsvSession;
  private readonly rowHeightPx: number;
  private readonly bufferRows: number;
  private readonly columnBufferPx: number;
  private readonly rowStore: CsvRowWindowStore;
  private resizeObserver: ResizeObserver | null = null;
  /** Coalesce scroll/resize storms to one paint-bound refresh. */
  private rafHandle = 0;
  /** Ignore stale IPC results when the user scrolls again before the round-trip finishes. */
  private refreshGeneration = 0;
  private lastScrollTop = 0;
  private rowPool: HTMLDivElement[] = [];
  private highlightedCell: { rowIndex: number; columnIndex: number } | null = null;
  /** Column whose sort is currently being computed; rendered with a busy hint. */
  private pendingSortColumn: number | null = null;

  constructor(options: {
    refs: CsvPreviewGridRefs;
    session: CsvSession;
    fetchRows: FetchCsvRows;
    rowHeightPx?: number;
    bufferRows?: number;
    columnBufferPx?: number;
  }) {
    this.refs = options.refs;
    this.session = options.session;
    this.rowStore = new CsvRowWindowStore({ fetchRows: options.fetchRows });
    this.rowHeightPx = options.rowHeightPx ?? CSV_ROW_HEIGHT_PX;
    this.bufferRows = options.bufferRows ?? CSV_VIRTUAL_SCROLL_BUFFER_ROWS;
    this.columnBufferPx = options.columnBufferPx ?? CSV_VIRTUAL_SCROLL_BUFFER_PX;
  }

  bind(): void {
    const scroll = this.refs.scrollRegion;
    scroll.onscroll = () => {
      this.scheduleRefresh();
    };
    scroll.addEventListener("wheel", this.handleWheel, { passive: false });

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleRefresh();
    });
    this.resizeObserver.observe(scroll);
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) {
      return;
    }
    if (event.deltaY === 0 && event.deltaX === 0) return;

    event.preventDefault();
    const scroll = this.refs.scrollRegion;
    const dy = normalizeWheelDelta(event.deltaY, event.deltaMode, this.rowHeightPx);
    const dx = normalizeWheelDelta(event.deltaX, event.deltaMode, this.rowHeightPx);
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
    this.highlightedCell = null;
  }

  async scrollToCell(rowIndex: number, columnIndex: number): Promise<void> {
    if (this.session.rowCount === 0 || this.session.headers.length === 0) {
      return;
    }

    const safeRowIndex = Math.min(
      Math.max(0, Math.floor(rowIndex)),
      Math.max(0, this.session.rowCount - 1),
    );
    const safeColumnIndex = Math.min(
      Math.max(0, Math.floor(columnIndex)),
      Math.max(0, this.session.headers.length - 1),
    );

    this.highlightedCell = {
      rowIndex: safeRowIndex,
      columnIndex: safeColumnIndex,
    };

    this.refs.scrollRegion.scrollTop = this.getCenteredRowScrollTop(safeRowIndex);
    this.refs.scrollRegion.scrollLeft = this.getCenteredColumnScrollLeft(safeColumnIndex);
    this.lastScrollTop = this.refs.scrollRegion.scrollTop;

    await this.refresh();
    this.refs.scrollRegion.focus({ preventScroll: true });
  }

  scheduleRefresh(): void {
    if (this.rafHandle !== 0) {
      return;
    }

    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      void this.refresh();
    });
  }

  isViewportPastRow(rowCount: number): boolean {
    const firstVisibleRow = Math.max(
      0,
      Math.floor(this.refs.scrollRegion.scrollTop / this.rowHeightPx) - this.bufferRows,
    );

    return firstVisibleRow >= rowCount;
  }

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;

    const { spacerTop, spacerBottom, windowRows, scrollRegion } = this.refs;
    const availableRowCount = this.session.rowCount;
    const scrollRowCount = Math.max(
      this.session.scrollRowCount,
      availableRowCount === 0 ? 0 : 1,
    );
    const rowHeight = this.rowHeightPx;
    const columnWindow = this.calculateColumnWindow();
    this.syncHorizontalLayout(columnWindow);

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
    const lastExclusive = Math.min(
      scrollRowCount,
      Math.ceil((scrollTop + viewport) / rowHeight) + buf,
    );
    const fetchLastExclusive = Math.min(lastExclusive, availableRowCount);

    spacerTop.style.height = `${first * rowHeight}px`;
    spacerBottom.style.height = `${(scrollRowCount - lastExclusive) * rowHeight}px`;

    const rawCount = fetchLastExclusive - first;
    if (rawCount <= 0) {
      windowRows.replaceChildren();
      return;
    }

    try {
      const columnCount = columnWindow.end - columnWindow.start;
      const batch = await this.rowStore.getRows(
        first,
        rawCount,
        availableRowCount,
        columnWindow.start,
        columnCount,
      );
      if (generation !== this.refreshGeneration) {
        return;
      }

      const fragment = document.createDocumentFragment();
      const colWidthsPx = this.session.effectiveColWidths();

      for (let i = 0; i < batch.rows.length; i++) {
        const rowIndex = batch.start + i;
        const row = this.getReusableRow(i, {
          rowIndex,
          cells: batch.rows[i] ?? [],
          cellsColumnStart: batch.column_start,
          columnWindow,
          colWidthsPx,
          rowHeightPx: rowHeight,
          highlightedCell: this.highlightedCell,
        });

        fragment.append(row);
      }

      windowRows.replaceChildren(fragment);
      this.prefetchAdjacentRows(
        scrollDirection,
        first,
        lastExclusive,
        rawCount,
        availableRowCount,
        columnWindow,
      );
    } catch (err) {
      if (generation === this.refreshGeneration) {
        console.error(err);
      }
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
    if (count <= 0) {
      return;
    }

    const prefetchStart =
      scrollDirection >= 0 ? lastExclusive : Math.max(0, first - count);

    this.rowStore.prefetchRows(
      prefetchStart,
      count,
      rowCount,
      columnWindow.start,
      columnWindow.end - columnWindow.start,
    );
  }

  private getReusableRow(
    poolIndex: number,
    options: Parameters<typeof createGridRow>[0],
  ): HTMLDivElement {
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
      viewportWidthPx: this.refs.scrollRegion.clientWidth,
      bufferPx: this.columnBufferPx,
    });
  }

  setPendingSortColumn(columnIndex: number | null): void {
    this.pendingSortColumn = columnIndex;
    this.scheduleRefresh();
  }

  /**
   * Update the click-driven highlighted cell. Used by the host to wire
   * pointer selection to the same highlight visuals as `scrollToCell`.
   * Pass `null` to clear the selection.
   */
  setHighlightedCell(cell: { rowIndex: number; columnIndex: number } | null): void {
    if (cell === null) {
      if (this.highlightedCell === null) return;
      this.highlightedCell = null;
      this.scheduleRefresh();
      return;
    }

    const rowIndex = Math.min(
      Math.max(0, Math.floor(cell.rowIndex)),
      Math.max(0, this.session.rowCount - 1),
    );
    const columnIndex = Math.min(
      Math.max(0, Math.floor(cell.columnIndex)),
      Math.max(0, this.session.headers.length - 1),
    );

    if (
      this.highlightedCell !== null &&
      this.highlightedCell.rowIndex === rowIndex &&
      this.highlightedCell.columnIndex === columnIndex
    ) {
      return;
    }

    this.highlightedCell = { rowIndex, columnIndex };
    this.scheduleRefresh();
  }

  getHighlightedCell(): { rowIndex: number; columnIndex: number } | null {
    return this.highlightedCell;
  }

  /**
   * Reset cached row pages and rendered rows after the visible-row mapping
   * changes (sort applied/cleared, filter applied/cleared). The row store's
   * keys mix page start with column window, so the same key now points at
   * different physical rows; we have to drop everything.
   */
  resetRowsForVisibilityChange(): void {
    this.refreshGeneration++;
    this.rowStore.clear();
    this.refs.windowRows.replaceChildren();
    this.rowPool = [];
    // The same scroll-row index now points at a different physical row, so
    // a stale cell highlight would mislead the user about what they copy.
    this.highlightedCell = null;
    this.scheduleRefresh();
  }

  private syncHorizontalLayout(columnWindow: CsvColumnWindow): void {
    const width = `${columnWindow.totalWidthPx}px`;
    this.refs.inner.style.width = width;
    this.refs.headerRow.style.transform = `translateX(-${this.refs.scrollRegion.scrollLeft}px)`;

    renderCsvHeaderRow(
      this.refs.headerRow,
      this.session.headers,
      this.session.colWidths,
      this.rowHeightPx,
      columnWindow,
      {
        activeSort: this.session.activeSort,
        pendingSortColumn: this.pendingSortColumn,
      },
    );
  }

  private getCenteredRowScrollTop(rowIndex: number): number {
    const viewport = this.refs.scrollRegion.clientHeight;
    const targetTop = rowIndex * this.rowHeightPx;
    const centeredTop = targetTop - Math.max(0, (viewport - this.rowHeightPx) / 2);
    const maxScrollTop = Math.max(0, this.session.rowCount * this.rowHeightPx - viewport);

    return Math.min(Math.max(0, centeredTop), maxScrollTop);
  }

  private getCenteredColumnScrollLeft(columnIndex: number): number {
    const widths = this.session.effectiveColWidths();
    const columnLeft = this.getColumnOffsetPx(columnIndex, widths);
    const columnWidth = widths[columnIndex] ?? CSV_DEFAULT_COL_WIDTH_PX;
    const totalWidth = widths.reduce(
      (sum, width) => sum + width,
      0,
    );
    const viewport = this.refs.scrollRegion.clientWidth;
    const centeredLeft = columnLeft - Math.max(0, (viewport - columnWidth) / 2);
    const maxScrollLeft = Math.max(0, totalWidth - viewport);

    return Math.min(Math.max(0, centeredLeft), maxScrollLeft);
  }

  private getColumnOffsetPx(columnIndex: number, widths: number[]): number {
    let offset = 0;

    for (let i = 0; i < columnIndex; i++) {
      offset += widths[i] ?? CSV_DEFAULT_COL_WIDTH_PX;
    }

    return offset;
  }
}

/**
 * Convert a WheelEvent delta to pixels. WheelEvent.deltaMode reports the unit:
 * 0 = pixel, 1 = line, 2 = page. Most modern browsers send pixel mode, but
 * older Firefox / some custom drivers still emit line mode.
 */
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
