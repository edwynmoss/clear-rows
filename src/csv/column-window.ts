import { CSV_DEFAULT_COL_WIDTH_PX } from "../app/constants";

export type CsvColumnWindow = {
  readonly start: number;
  readonly end: number;
  readonly leftOffsetPx: number;
  readonly rightOffsetPx: number;
  readonly totalWidthPx: number;
};

export function calculateColumnWindow(options: {
  colWidthsPx: number[];
  scrollLeftPx: number;
  viewportWidthPx: number;
  bufferPx: number;
}): CsvColumnWindow {
  const colWidths = options.colWidthsPx.map(normalizeColumnWidth);
  const totalWidthPx = colWidths.reduce((sum, width) => sum + width, 0);

  if (colWidths.length === 0 || totalWidthPx === 0) {
    return {
      start: 0,
      end: 0,
      leftOffsetPx: 0,
      rightOffsetPx: 0,
      totalWidthPx: 0,
    };
  }

  const viewportStart = Math.max(0, options.scrollLeftPx - options.bufferPx);
  const viewportEnd = Math.min(
    totalWidthPx,
    options.scrollLeftPx + options.viewportWidthPx + options.bufferPx,
  );

  let start = 0;
  let leftOffsetPx = 0;
  while (
    start < colWidths.length - 1 &&
    leftOffsetPx + colWidths[start] <= viewportStart
  ) {
    leftOffsetPx += colWidths[start];
    start++;
  }

  let end = start;
  let visibleEndPx = leftOffsetPx;
  while (end < colWidths.length && visibleEndPx < viewportEnd) {
    visibleEndPx += colWidths[end];
    end++;
  }

  const rightOffsetPx = Math.max(0, totalWidthPx - visibleEndPx);

  return {
    start,
    end,
    leftOffsetPx,
    rightOffsetPx,
    totalWidthPx,
  };
}

function normalizeColumnWidth(width: number | undefined): number {
  if (!Number.isFinite(width) || width === undefined || width <= 0) {
    return CSV_DEFAULT_COL_WIDTH_PX;
  }

  return width;
}
