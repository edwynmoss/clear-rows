// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { createCsvPreviewGrid } from "../components/csv-preview-grid";
import { CsvSession } from "./csv-session";
import { CsvGridVirtualizer } from "./grid-virtualizer";
import type { RowBatch } from "../types/csv";

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
});

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
      compression: null,
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
  cleanups.push(() => {
    release?.();
    virtualizer.dispose();
  });
  return { session, refs, virtualizer, releaseFetch: () => release?.(), fetchCount: () => fetches };
}

describe("grid virtualizer", () => {
  it.each([1, 100, 20_000, 0])("starts a new filter with %i matches at the top without moving columns or focus", async (matchedRows) => {
    const { session, refs, virtualizer, releaseFetch } = setup(20_000);
    releaseFetch();
    session.colWidths = [800, 800];
    refs.scrollRegion.scrollTop = 20_000 * 28 - 280;
    refs.scrollRegion.scrollLeft = 120;
    await virtualizer.refresh();
    expect(refs.windowRows.children.length).toBeGreaterThan(0);
    virtualizer.setHighlightedCell({ rowIndex: 19_999, columnIndex: 1 });
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    session.applyActiveFilter({ query: "match", matchedRows });
    virtualizer.resetRowsForVisibilityChange({ scroll: "top" });
    await virtualizer.refresh();

    expect(refs.scrollRegion.scrollTop).toBe(0);
    expect(refs.scrollRegion.scrollLeft).toBe(120);
    expect(document.activeElement).toBe(input);
    expect(virtualizer.getHighlightedCell()).toBeNull();
    expect(refs.root.dataset.stale).toBeUndefined();
    expect(refs.spacerTop.style.height).toBe("0px");
    if (matchedRows === 0) {
      expect(refs.windowRows.children).toHaveLength(0);
      expect(refs.spacerBottom.style.height).toBe("0px");
    } else {
      expect(refs.windowRows.children.length).toBeLessThanOrEqual(matchedRows);
      expect(refs.windowRows.querySelector(".cr-row-num")?.textContent).toBe("1");
    }
  });

  it("preserves the viewport when refreshing a sort or clearing a filter", async () => {
    const { session, refs, virtualizer, releaseFetch } = setup(1_000);
    releaseFetch();
    session.applyActiveFilter({ query: "match", matchedRows: 500 });
    refs.scrollRegion.scrollTop = 280;
    await virtualizer.refresh();

    for (const filter of [session.activeFilter, null]) {
      session.applyActiveFilter(filter);
      virtualizer.resetRowsForVisibilityChange();
      await virtualizer.refresh();
      expect(refs.scrollRegion.scrollTop).toBe(280);
      expect(refs.windowRows.children.length).toBeGreaterThan(0);
      expect(refs.root.dataset.stale).toBeUndefined();
    }
  });

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
