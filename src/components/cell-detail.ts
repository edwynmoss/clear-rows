import { formatInt } from "../app/format";

export type CellDetailOptions = {
  onClose: () => void;
  onCopy: (text: string) => void;
  onFilterToValue?: (column: string, value: string) => void;
};

export type CellDetail = {
  readonly root: HTMLElement;
  show(cell: { column: string; columnIndex: number; rowNumber: number; value: string }): void;
  hide(): void;
  isOpen(): boolean;
};

export function createCellDetail(options: CellDetailOptions): CellDetail {
  const root = document.createElement("aside");
  root.className = "cr-detail";
  root.hidden = true;
  root.setAttribute("aria-label", "Cell detail");

  const head = document.createElement("div");
  head.className = "cr-detail-head";

  const title = document.createElement("div");
  title.className = "cr-detail-title";

  const sub = document.createElement("div");
  sub.className = "cr-detail-sub";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "cr-icon-btn";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("click", options.onClose);

  const titles = document.createElement("div");
  titles.className = "cr-detail-titles";
  titles.append(title, sub);
  head.append(titles, close);

  const body = document.createElement("pre");
  body.className = "cr-detail-body";

  const foot = document.createElement("div");
  foot.className = "cr-detail-foot";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "cr-btn cr-btn-secondary";
  copy.textContent = "Copy value";

  const filterTo = document.createElement("button");
  filterTo.type = "button";
  filterTo.className = "cr-btn cr-btn-secondary";
  filterTo.textContent = "Filter to this value";
  filterTo.hidden = !options.onFilterToValue;

  const kind = document.createElement("span");
  kind.className = "cr-detail-kind";

  foot.append(copy, filterTo, kind);
  root.append(head, body, foot);

  let current: { column: string; value: string } | null = null;

  copy.addEventListener("click", () => {
    if (current) options.onCopy(current.value);
  });
  filterTo.addEventListener("click", () => {
    if (current) options.onFilterToValue?.(current.column, current.value);
  });

  return {
    root,
    show(cell) {
      current = { column: cell.column, value: cell.value };
      title.textContent = cell.column || `Column ${cell.columnIndex + 1}`;
      sub.textContent = `Row ${formatInt(cell.rowNumber)} · ${formatInt(cell.value.length)} characters`;
      const pretty = prettyJson(cell.value);
      body.textContent = pretty ?? cell.value;
      body.dataset.json = pretty ? "true" : "false";
      kind.textContent = pretty ? "JSON" : looksLikeUrl(cell.value) ? "URL" : "";
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
      current = null;
    },
    isOpen() {
      return !root.hidden;
    },
  };
}

function prettyJson(value: string): string | null {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}
