import { formatInt } from "../app/format";
import { columnTypeLabel, type ColumnProfile } from "../csv/column-types";
import type { ColumnStats } from "../types/csv";

/**
 * The "Inspect column" pane: what is in this column, for the rows in view.
 * Sits where the cell detail sits. Every value listed is a filter waiting to
 * happen: click to keep only those rows, or exclude them.
 */

export type ColumnPanelOptions = {
  onClose: () => void;
  /** Keep rows where the column equals the value. */
  onFilterToValue: (columnIndex: number, value: string) => void;
  /** Drop rows where the column equals the value. */
  onExcludeValue: (columnIndex: number, value: string) => void;
  onFilterEmpty: (columnIndex: number) => void;
  onSort: (columnIndex: number, direction: "asc" | "desc") => void;
  onHide: (columnIndex: number) => void;
  onCopy: (text: string, label: string) => void;
  /** The user picked another column from the switcher. */
  onSwitch: (columnIndex: number) => void;
};

export type ColumnPanel = {
  readonly root: HTMLElement;
  /** Show the pane for a column and mark it loading. */
  open(column: { index: number; name: string; profile: ColumnProfile | undefined; viewLabel: string; columns: string[] }): void;
  /** Fill in the numbers once they arrive (ignored if the pane moved on). */
  setStats(index: number, stats: ColumnStats): void;
  setError(index: number, message: string): void;
  currentColumn(): number | null;
  hide(): void;
  isOpen(): boolean;
};

export function createColumnPanel(options: ColumnPanelOptions): ColumnPanel {
  const root = document.createElement("aside");
  root.className = "cr-detail cr-colpanel";
  root.hidden = true;
  root.setAttribute("aria-label", "Column detail");

  const head = document.createElement("div");
  head.className = "cr-detail-head";
  const titles = document.createElement("div");
  titles.className = "cr-detail-titles";
  // The title is a switcher: inspecting one column leads to the next.
  const title = document.createElement("select");
  title.className = "cr-select cr-colpanel-switch";
  title.setAttribute("aria-label", "Column to inspect");
  title.addEventListener("change", () => options.onSwitch(Number(title.value)));
  const sub = document.createElement("div");
  sub.className = "cr-detail-sub";
  titles.append(title, sub);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "cr-icon-btn";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("click", options.onClose);
  head.append(titles, close);

  const body = document.createElement("div");
  body.className = "cr-colpanel-body";

  const facts = document.createElement("dl");
  facts.className = "cr-facts";

  const valuesTitle = document.createElement("h3");
  valuesTitle.className = "cr-colpanel-h";
  valuesTitle.textContent = "Most common values";
  const values = document.createElement("div");
  values.className = "cr-values";
  const valuesNote = document.createElement("p");
  valuesNote.className = "cr-colpanel-note";

  const status = document.createElement("p");
  status.className = "cr-colpanel-status";

  body.append(status, facts, valuesTitle, values, valuesNote);

  const foot = document.createElement("div");
  foot.className = "cr-detail-foot cr-colpanel-foot";
  const sortAsc = button("Sort ascending", () => current && options.onSort(current.index, "asc"));
  const sortDesc = button("Sort descending", () => current && options.onSort(current.index, "desc"));
  const hide = button("Hide column", () => current && options.onHide(current.index));
  const copy = button("Copy values", () => {
    if (!current || !currentStats) return;
    const lines = currentStats.top.map((entry) => `${entry.value}\t${entry.count}`);
    options.onCopy(lines.join("\n"), "Copied top values");
  });
  foot.append(sortAsc, sortDesc, hide, copy);

  root.append(head, body, foot);

  let current: { index: number; name: string; profile: ColumnProfile | undefined } | null = null;
  let currentStats: ColumnStats | null = null;

  function button(label: string, run: () => void): HTMLButtonElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "cr-btn cr-btn-secondary";
    el.textContent = label;
    el.addEventListener("click", run);
    return el;
  }

  function fact(term: string, detail: string, tone?: string): void {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = detail;
    if (tone) dd.dataset.tone = tone;
    facts.append(dt, dd);
  }

  function renderStats(stats: ColumnStats): void {
    if (!current) return;
    facts.replaceChildren();
    values.replaceChildren();
    status.hidden = true;
    root.dataset.loading = "false";

    const rows = stats.rows;
    const nonEmpty = rows - stats.empty;
    fact("Rows in view", formatInt(rows));
    fact("Empty", stats.empty === 0 ? "none" : `${formatInt(stats.empty)} (${percent(stats.empty, rows)})`, stats.empty > 0 ? "muted" : undefined);
    fact("Distinct values", `${formatInt(stats.distinct)}${stats.distinct_is_lower_bound ? "+" : ""}${nonEmpty > 0 && stats.distinct === nonEmpty ? " (all unique)" : ""}`);
    if (stats.numeric) {
      fact("Smallest", formatNumber(stats.numeric.min));
      fact("Largest", formatNumber(stats.numeric.max));
      fact("Average", formatNumber(stats.numeric.mean));
      fact("Sum", formatNumber(stats.numeric.sum));
      if (stats.numeric.parsed < nonEmpty) fact("Not numeric", formatInt(nonEmpty - stats.numeric.parsed), "muted");
    } else if (stats.temporal) {
      fact("Earliest", stats.temporal.earliest);
      fact("Latest", stats.temporal.latest);
      if (stats.temporal.parsed < nonEmpty) fact("Not a date", formatInt(nonEmpty - stats.temporal.parsed), "muted");
    } else if (stats.text) {
      fact("Length", stats.text.shortest === stats.text.longest ? `${formatInt(stats.text.longest)} characters` : `${formatInt(stats.text.shortest)} to ${formatInt(stats.text.longest)} characters`);
    }

    const unique = nonEmpty > 0 && stats.distinct >= nonEmpty;
    valuesTitle.hidden = unique || stats.top.length === 0;
    values.hidden = valuesTitle.hidden;
    valuesNote.hidden = false;
    if (unique) {
      valuesNote.textContent = "Every value is different, so there is nothing to rank.";
    } else if (stats.top.length === 0) {
      valuesNote.textContent = "No values in view.";
    } else {
      const shown = stats.top.reduce((sum, entry) => sum + entry.count, 0);
      valuesNote.textContent =
        stats.distinct > stats.top.length
          ? `Top ${formatInt(stats.top.length)} of ${formatInt(stats.distinct)}${stats.distinct_is_lower_bound ? "+" : ""} values, covering ${percent(shown, nonEmpty)} of rows. Click a value to keep only those rows.`
          : "Click a value to keep only those rows.";
    }

    const max = stats.top[0]?.count ?? 1;
    for (const entry of stats.top) {
      const row = document.createElement("div");
      row.className = "cr-value";
      const keep = document.createElement("button");
      keep.type = "button";
      keep.className = "cr-value-keep";
      keep.title = "Keep only rows with this value";
      const bar = document.createElement("span");
      bar.className = "cr-value-bar";
      bar.style.width = `${Math.max(2, Math.round((entry.count / max) * 100))}%`;
      const label = document.createElement("span");
      label.className = "cr-value-label";
      label.textContent = entry.value;
      label.title = entry.value;
      const count = document.createElement("span");
      count.className = "cr-value-count";
      count.textContent = `${formatInt(entry.count)} · ${percent(entry.count, nonEmpty)}`;
      keep.append(bar, label, count);
      keep.addEventListener("click", () => current && options.onFilterToValue(current.index, entry.value));
      const exclude = document.createElement("button");
      exclude.type = "button";
      exclude.className = "cr-value-exclude";
      exclude.title = "Exclude rows with this value";
      exclude.setAttribute("aria-label", `Exclude ${entry.value}`);
      exclude.textContent = "−";
      exclude.addEventListener("click", () => current && options.onExcludeValue(current.index, entry.value));
      row.append(keep, exclude);
      values.append(row);
    }
    if (stats.empty > 0) {
      const emptyRow = document.createElement("button");
      emptyRow.type = "button";
      emptyRow.className = "cr-value-empty";
      emptyRow.textContent = `Show the ${formatInt(stats.empty)} empty ${stats.empty === 1 ? "cell" : "cells"}`;
      emptyRow.addEventListener("click", () => current && options.onFilterEmpty(current.index));
      values.append(emptyRow);
      values.hidden = false;
    }
  }

  return {
    root,
    open(column) {
      current = { index: column.index, name: column.name, profile: column.profile };
      currentStats = null;
      title.replaceChildren(
        ...column.columns.map((name, index) => {
          const option = document.createElement("option");
          option.value = String(index);
          option.textContent = name || `Column ${index + 1}`;
          return option;
        }),
      );
      title.value = String(column.index);
      sub.textContent = `${columnTypeLabel(column.profile?.type)} · ${column.viewLabel}`;
      facts.replaceChildren();
      values.replaceChildren();
      valuesTitle.hidden = true;
      values.hidden = true;
      valuesNote.hidden = true;
      status.hidden = false;
      status.textContent = "Counting values";
      root.dataset.loading = "true";
      root.hidden = false;
    },
    setStats(index, stats) {
      if (!current || current.index !== index) return;
      currentStats = stats;
      renderStats(stats);
    },
    setError(index, message) {
      if (!current || current.index !== index) return;
      root.dataset.loading = "false";
      status.hidden = false;
      status.textContent = message;
    },
    currentColumn: () => (root.hidden ? null : current?.index ?? null),
    hide() {
      root.hidden = true;
      current = null;
      currentStats = null;
    },
    isOpen: () => !root.hidden,
  };
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const value = (part / whole) * 100;
  return value >= 10 || value === 0 ? `${Math.round(value)}%` : value >= 1 ? `${value.toFixed(1)}%` : "<1%";
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return formatInt(value);
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}
