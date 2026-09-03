import { formatBytes, formatEncoding, formatInt } from "../app/format";

export type FileChipInfo = {
  name: string;
  rows: number;
  columns: number;
  sizeBytes: number;
  encoding: string;
  encodingSource: string;
  delimiterLabel: string | null;
  isIndexing: boolean;
  hasWarning: boolean;
};

export type TopBarOptions = {
  onOpen: () => void;
  onExport: () => void;
  onFileChipClick: () => void;
  /** Rendered after the file chip: reopen-as popover host. */
  fileChipExtras?: HTMLElement[];
  /** Rendered at the end: columns control, theme toggle, palette trigger. */
  trailing?: HTMLElement[];
};

export type TopBar = {
  readonly root: HTMLElement;
  readonly fileChip: HTMLButtonElement;
  readonly exportButton: HTMLButtonElement;
  setFile(info: FileChipInfo | null): void;
  setExportBusy(busy: boolean): void;
};

function logoSvg(): string {
  return `<svg viewBox="0 0 1301 1579" aria-hidden="true"><path d="M1230 70H590L70 500" stroke="currentColor" stroke-width="140" stroke-linecap="round" fill="none"/><path d="M1230 1509H590L70 1079" stroke="currentColor" stroke-width="140" stroke-linecap="round" fill="none"/><path d="M40 470L905 785L40 1100" class="cr-logo-accent" stroke-width="150" fill="none"/></svg>`;
}

export function createTopBar(options: TopBarOptions): TopBar {
  const root = document.createElement("header");
  root.className = "cr-top";

  const brand = document.createElement("div");
  brand.className = "cr-brand";
  const mark = document.createElement("span");
  mark.className = "cr-logo";
  mark.innerHTML = logoSvg();
  const word = document.createElement("span");
  word.className = "cr-wordmark";
  word.textContent = "Clear Rows";
  brand.append(mark, word);

  const fileChip = document.createElement("button");
  fileChip.type = "button";
  fileChip.className = "cr-filechip";
  fileChip.hidden = true;
  fileChip.title = "Encoding and delimiter · click to reopen with different settings";
  fileChip.addEventListener("click", options.onFileChipClick);

  const chipWrap = document.createElement("div");
  chipWrap.className = "cr-filechip-wrap";
  chipWrap.append(fileChip, ...(options.fileChipExtras ?? []));

  const spacer = document.createElement("div");
  spacer.className = "cr-spacer";

  const actions = document.createElement("div");
  actions.className = "cr-top-actions";

  const exportButton = button("Export", "secondary");
  exportButton.disabled = true;
  exportButton.addEventListener("click", options.onExport);

  const openButton = button("Open", "primary");
  const kbd = document.createElement("kbd");
  kbd.textContent = "Ctrl O";
  openButton.append(kbd);
  openButton.addEventListener("click", options.onOpen);

  actions.append(...(options.trailing ?? []), exportButton, openButton);

  root.append(brand, chipWrap, spacer, actions);

  return {
    root,
    fileChip,
    exportButton,
    setFile(info) {
      if (!info) {
        fileChip.hidden = true;
        fileChip.replaceChildren();
        exportButton.disabled = true;
        return;
      }
      fileChip.hidden = false;
      fileChip.replaceChildren();
      const name = document.createElement("span");
      name.className = "cr-filechip-name";
      name.textContent = info.name;

      const meta = document.createElement("span");
      meta.className = "cr-filechip-meta";
      const rows = `${formatInt(info.rows)} rows${info.isIndexing ? "…" : ""}`;
      meta.textContent = [rows, `${formatInt(info.columns)} columns`, formatBytes(info.sizeBytes)]
        .filter(Boolean)
        .join(" · ");

      const enc = document.createElement("span");
      enc.className = "cr-filechip-enc";
      enc.dataset.warning = info.hasWarning ? "true" : "false";
      enc.textContent = formatEncoding(info.encoding);
      if (info.delimiterLabel) {
        const delim = document.createElement("small");
        delim.textContent = ` · ${info.delimiterLabel}`;
        enc.append(delim);
      }
      if (info.encodingSource === "detected") {
        const src = document.createElement("small");
        src.textContent = " · detected";
        enc.append(src);
      }

      fileChip.append(name, meta, enc);
      exportButton.disabled = false;
    },
    setExportBusy(busy) {
      exportButton.disabled = busy;
      exportButton.firstChild!.textContent = busy ? "Exporting…" : "Export";
    },
  };
}

function button(label: string, variant: "primary" | "secondary"): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `cr-btn cr-btn-${variant}`;
  const text = document.createElement("span");
  text.textContent = label;
  el.append(text);
  return el;
}
