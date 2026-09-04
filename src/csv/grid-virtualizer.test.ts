// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { createCsvPreviewGrid } from "../components/csv-preview-grid";
import { CsvSession } from "./csv-session";
import { CsvGridVirtualizer } from "./grid-virtualizer";
import type { RowBatch } from "../types/csv";

function setup(rowCount: number) {
  const session = new CsvSession();
  session.applySummary({
    path: "test.csv",
    delimiter: 44,
    headers: ["a", "b"],
    row_count: rowCount,
    is_complete: true,
    indexed_bytes: 1,
    file_size: 1,
    error: null,
    column_types: [],
    profile: {
      extension: "csv",
      detected_kind: "csv",
      detected_kind_label: "CSV",
      delimiter: 44,
      delimiter_label: "comma",
      delimiter_confidence: "high",
      encoding: "utf-8",
      encoding_source: "utf-8",
      sampled_rows: 1,
      likely_columns: 2,
      binary_like: false,
      has_header: true,
      header_source: "detected",
      warnings: [],
    },
  });
  const refs = createCsvPreviewGrid();
  document.body.append(refs.root);
  // jsdom has no layout; give the scroll region a fake viewport.
  Object.defineProperty(refs.scrollRegion, "clientHeight", { value: 280, configurable: true });
  Object.defineProperty(refs.scrollRegion, "clientWidth", { value: 800, configurable: true });

  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let fetches = 0;
  const fetchRows = async (start: number, count: number, columnStart: number, columnCount: number): Promise<RowBatch> => {
    fetches++;
    if (fetches > 1) await gate;
    const rows = Array.from({ length: count }, (_, i) => Array.from({ length: columnCount }, (_, c) => `r${start + i}c${columnStart + c}`));
    return { start, column_start: columnStart, rows };
  };
  const virtualizer = new CsvGridVirtualizer({ refs, session, fetchRows, rowHeightPx: 28 });
  return { session, refs, virtualizer, releaseFetch: () => release?.(), fetchCount: () => fetches };
}

describe("grid virtualizer", () => {
  it("keeps the previous rows visible and dimmed while a refetch is pending", async () => {
    const { refs, virtualizer, releaseFetch } = setup(100);
    await virtualizer.refresh();
    const before = refs.windowRows.children.length;
    expect(before).toBeGreaterThan(0);

    virtualizer.resetRowsForVisibilityChange();
    expect(refs.root.dataset.stale).toBe("true");
    expect(refs.windowRows.children.length).toBe(before);

    releaseFetch();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(refs.root.dataset.stale).toBeUndefined();
    expect(refs.windowRows.children.length).toBeGreaterThan(0);
  });

  it("renders row numbers in the gutter and skeleton rows while indexing", async () => {
    const { refs, virtualizer } = setup(5);
    await virtualizer.refresh();
    const gutters = Array.from(refs.windowRows.querySelectorAll<HTMLElement>(".cr-row-num")).map((el) => el.textContent);
    expect(gutters.slice(0, 5)).toEqual(["1", "2", "3", "4", "5"]);
    expect(refs.windowRows.querySelectorAll('[data-skeleton="true"]')).toHaveLength(0);

    virtualizer.setIndexing(true);
    await virtualizer.refresh();
    expect(refs.windowRows.querySelectorAll('[data-skeleton="true"]').length).toBeGreaterThan(0);
  });

  it("moves the highlight with the keyboard and skips hidden columns", async () => {
    const { session, virtualizer } = setup(20);
    await virtualizer.refresh();
    virtualizer.setHighlightedCell({ rowIndex: 0, columnIndex: 0 });
    session.hiddenColumns = new Set([1]);
    virtualizer.moveHighlight(1, 1);
    expect(virtualizer.getHighlightedCell()).toEqual({ rowIndex: 1, columnIndex: 0 });
    session.hiddenColumns = new Set();
    virtualizer.moveHighlight(0, 1);
    expect(virtualizer.getHighlightedCell()).toEqual({ rowIndex: 1, columnIndex: 1 });
    virtualizer.moveHighlightToEdge("bottom");
    expect(virtualizer.getHighlightedCell()?.rowIndex).toBe(19);
  });
});
