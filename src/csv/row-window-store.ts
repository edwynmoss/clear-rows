import { CSV_MAX_ROWS_PER_BATCH } from "../app/constants";
import type { RowBatch } from "../types/csv";

const DEFAULT_MAX_CACHED_PAGES = 48;

export type FetchCsvRows = (
  start: number,
  count: number,
  columnStart: number,
  columnCount: number,
) => Promise<RowBatch>;

type CachedPage = {
  readonly start: number;
  readonly columnStart: number;
  readonly rows: string[][];
};

export class CsvRowWindowStore {
  private readonly fetchRows: FetchCsvRows;
  private readonly pageSize: number;
  private readonly maxCachedPages: number;
  private readonly pages = new Map<string, CachedPage>();
  private readonly inFlight = new Map<string, Promise<CachedPage>>();
  private generation = 0;

  constructor(options: {
    fetchRows: FetchCsvRows;
    pageSize?: number;
    maxCachedPages?: number;
  }) {
    this.fetchRows = options.fetchRows;
    this.pageSize = options.pageSize ?? CSV_MAX_ROWS_PER_BATCH;
    this.maxCachedPages = options.maxCachedPages ?? DEFAULT_MAX_CACHED_PAGES;
  }

  clear(): void {
    this.generation++;
    this.pages.clear();
    this.inFlight.clear();
  }

  async getRows(
    start: number,
    count: number,
    rowCount: number,
    columnStart: number,
    columnCount: number,
  ): Promise<RowBatch> {
    const window = this.normalizeWindow(start, count, rowCount);
    const columns = this.normalizeColumns(columnStart, columnCount);

    if (window.count === 0 || columns.count === 0) {
      return { start: window.start, column_start: columns.start, rows: [] };
    }

    const pages = await Promise.all(
      this.pageStartsForWindow(window.start, window.count).map((pageStart) =>
        this.getPage(pageStart, rowCount, columns.start, columns.count),
      ),
    );

    return {
      start: window.start,
      column_start: pages[0]?.columnStart ?? columns.start,
      rows: this.slicePages(pages, window.start, window.start + window.count),
    };
  }

  prefetchRows(
    start: number,
    count: number,
    rowCount: number,
    columnStart: number,
    columnCount: number,
  ): void {
    const window = this.normalizeWindow(start, count, rowCount);
    const columns = this.normalizeColumns(columnStart, columnCount);

    if (window.count === 0 || columns.count === 0) {
      return;
    }

    for (const pageStart of this.pageStartsForWindow(window.start, window.count)) {
      void this.getPage(pageStart, rowCount, columns.start, columns.count).catch((err) => {
        console.error(err);
      });
    }
  }

  private normalizeWindow(
    start: number,
    count: number,
    rowCount: number,
  ): { start: number; count: number } {
    const safeRowCount = Math.max(0, Math.floor(rowCount));
    const safeStart = Math.max(0, Math.floor(start));
    const safeCount = Math.max(0, Math.floor(count));

    if (safeRowCount === 0 || safeCount === 0 || safeStart >= safeRowCount) {
      return { start: safeStart, count: 0 };
    }

    const end = Math.min(safeRowCount, safeStart + safeCount);
    return { start: safeStart, count: end - safeStart };
  }

  private normalizeColumns(
    columnStart: number,
    columnCount: number,
  ): { start: number; count: number } {
    return {
      start: Math.max(0, Math.floor(columnStart)),
      count: Math.max(0, Math.floor(columnCount)),
    };
  }

  private pageStartsForWindow(start: number, count: number): number[] {
    if (count <= 0) {
      return [];
    }

    const firstPage = this.pageStartForRow(start);
    const lastPage = this.pageStartForRow(start + count - 1);
    const starts: number[] = [];

    for (let pageStart = firstPage; pageStart <= lastPage; pageStart += this.pageSize) {
      starts.push(pageStart);
    }

    return starts;
  }

  private async getPage(
    pageStart: number,
    rowCount: number,
    columnStart: number,
    columnCount: number,
  ): Promise<CachedPage> {
    const cacheKey = this.createPageKey(pageStart, columnStart, columnCount);
    const cached = this.pages.get(cacheKey);
    if (cached) {
      this.touchPage(cacheKey, cached);
      return cached;
    }

    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      return pending;
    }

    const pageCount = Math.min(this.pageSize, Math.max(0, rowCount - pageStart));
    const generation = this.generation;
    const request = this.fetchRows(pageStart, pageCount, columnStart, columnCount)
      .then((batch) => {
        const page: CachedPage = {
          start: batch.start,
          columnStart: batch.column_start,
          rows: batch.rows,
        };

        if (generation === this.generation) {
          this.pages.set(cacheKey, page);
          this.evictOldestPages();
        }

        return page;
      })
      .finally(() => {
        if (this.inFlight.get(cacheKey) === request) {
          this.inFlight.delete(cacheKey);
        }
      });

    this.inFlight.set(cacheKey, request);
    return request;
  }

  private touchPage(cacheKey: string, page: CachedPage): void {
    this.pages.delete(cacheKey);
    this.pages.set(cacheKey, page);
  }

  private evictOldestPages(): void {
    while (this.pages.size > this.maxCachedPages) {
      const oldest = this.pages.keys().next().value;
      if (oldest === undefined) {
        return;
      }

      this.pages.delete(oldest);
    }
  }

  private pageStartForRow(row: number): number {
    return Math.floor(row / this.pageSize) * this.pageSize;
  }

  private createPageKey(pageStart: number, columnStart: number, columnCount: number): string {
    return `${pageStart}:${columnStart}:${columnCount}`;
  }

  private slicePages(pages: CachedPage[], start: number, end: number): string[][] {
    const rows: string[][] = [];

    for (const page of pages) {
      const pageStart = page.start;
      const pageEnd = pageStart + page.rows.length;
      const sliceStart = Math.max(start, pageStart);
      const sliceEnd = Math.min(end, pageEnd);

      if (sliceStart >= sliceEnd) {
        continue;
      }

      rows.push(...page.rows.slice(sliceStart - pageStart, sliceEnd - pageStart));
    }

    return rows;
  }
}
