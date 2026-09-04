export type ReopenAsValues = {
  delimiter: string;
  encoding: string;
  /** "auto" | "header" | "data" */
  header: string;
};

export type ReopenAsControlOptions = {
  onApply: (values: ReopenAsValues) => void;
};

export type ReopenAsControl = {
  /** Popover host; anchor it next to the trigger (the file chip). */
  readonly root: HTMLDivElement;
  setEnabled(enabled: boolean): void;
  setDefaults(values: { delimiterChar: string | null; encoding: string | null; header?: string | null }): void;
  open(): void;
  close(): void;
  toggle(): void;
};

export const DELIMITER_OPTIONS: Array<{ label: string; char: string }> = [
  { label: "Comma  ,", char: "," },
  { label: "Semicolon  ;", char: ";" },
  { label: "Tab", char: "\t" },
  { label: "Pipe  |", char: "|" },
  { label: "Colon  :", char: ":" },
  { label: "Space", char: " " },
];

// Values are labels the Rust side resolves: our four fixed ones, then WHATWG
// encoding labels understood by encoding_rs.
export const ENCODING_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "UTF-8", value: "utf-8" },
  { label: "UTF-8 with BOM", value: "utf-8-bom" },
  { label: "UTF-16 LE", value: "utf-16-le" },
  { label: "UTF-16 BE", value: "utf-16-be" },
  { label: "Windows-1252 (Western, Excel default)", value: "windows-1252" },
  { label: "ISO-8859-1 (Latin-1)", value: "iso-8859-1" },
  { label: "ISO-8859-15 (Latin-9)", value: "iso-8859-15" },
  { label: "Windows-1250 (Central European)", value: "windows-1250" },
  { label: "Windows-1251 (Cyrillic)", value: "windows-1251" },
  { label: "KOI8-R (Cyrillic)", value: "koi8-r" },
  { label: "Windows-1253 (Greek)", value: "windows-1253" },
  { label: "Windows-1254 (Turkish)", value: "windows-1254" },
  { label: "Windows-1255 (Hebrew)", value: "windows-1255" },
  { label: "Windows-1256 (Arabic)", value: "windows-1256" },
  { label: "Windows-1257 (Baltic)", value: "windows-1257" },
  { label: "Windows-1258 (Vietnamese)", value: "windows-1258" },
  { label: "Mac Roman", value: "macintosh" },
  { label: "Shift_JIS (Japanese)", value: "shift_jis" },
  { label: "EUC-JP (Japanese)", value: "euc-jp" },
  { label: "GBK (Simplified Chinese)", value: "gbk" },
  { label: "GB18030 (Simplified Chinese)", value: "gb18030" },
  { label: "Big5 (Traditional Chinese)", value: "big5" },
  { label: "EUC-KR (Korean)", value: "euc-kr" },
];

export const HEADER_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "Decide from the file", value: "auto" },
  { label: "Column names", value: "header" },
  { label: "Data (number the columns)", value: "data" },
];

export function createReopenAsControl(options: ReopenAsControlOptions): ReopenAsControl {
  const root = document.createElement("div");
  root.className = "cr-popover cr-reopen";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Reopen with different settings");

  const title = document.createElement("div");
  title.className = "cr-popover-title";
  title.textContent = "Reopen this file as";

  const delimiterField = createField("Delimiter", "cr-reopen-delim");
  for (const option of DELIMITER_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = option.char;
    opt.textContent = option.label;
    delimiterField.select.append(opt);
  }

  const encodingField = createField("Encoding", "cr-reopen-enc");
  for (const option of ENCODING_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    encodingField.select.append(opt);
  }

  const headerField = createField("First row", "cr-reopen-header");
  for (const option of HEADER_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    headerField.select.append(opt);
  }

  const actions = document.createElement("div");
  actions.className = "cr-popover-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "cr-btn cr-btn-secondary";
  cancel.textContent = "Cancel";

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "cr-btn cr-btn-primary";
  apply.textContent = "Reopen";

  actions.append(cancel, apply);
  root.append(title, delimiterField.root, encodingField.root, headerField.root, actions);

  let enabled = false;
  let isOpen = false;

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    root.hidden = true;
    document.removeEventListener("mousedown", handleOutsideClick, true);
    document.removeEventListener("keydown", handleEscape);
  }

  function open(): void {
    if (isOpen || !enabled) return;
    isOpen = true;
    root.hidden = false;
    document.addEventListener("mousedown", handleOutsideClick, true);
    document.addEventListener("keydown", handleEscape);
    encodingField.select.focus({ preventScroll: true });
  }

  function handleOutsideClick(event: MouseEvent): void {
    if (!(event.target instanceof Node)) return;
    if (root.contains(event.target)) return;
    // Clicking the chip that opened us toggles; let that handler run.
    if (event.target instanceof Element && event.target.closest(".cr-filechip")) return;
    close();
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }

  cancel.addEventListener("click", close);
  apply.addEventListener("click", () => {
    options.onApply({ delimiter: delimiterField.select.value, encoding: encodingField.select.value, header: headerField.select.value });
    close();
  });

  return {
    root,
    setEnabled(next) {
      enabled = next;
      if (!next) close();
    },
    setDefaults(values) {
      if (values.delimiterChar) {
        const match = DELIMITER_OPTIONS.find((option) => option.char === values.delimiterChar);
        if (match) delimiterField.select.value = match.char;
      }
      if (values.encoding) {
        const match = ENCODING_OPTIONS.find((option) => option.value === values.encoding);
        if (match) encodingField.select.value = match.value;
      }
      if (values.header) {
        const match = HEADER_OPTIONS.find((option) => option.value === values.header);
        if (match) headerField.select.value = match.value;
      }
    },
    open,
    close,
    toggle() {
      if (isOpen) close();
      else open();
    },
  };
}

function createField(label: string, id: string): { root: HTMLLabelElement; select: HTMLSelectElement } {
  const root = document.createElement("label");
  root.className = "cr-field";
  root.htmlFor = id;

  const text = document.createElement("span");
  text.className = "cr-field-label";
  text.textContent = label;

  const select = document.createElement("select");
  select.id = id;
  select.className = "cr-select";

  root.append(text, select);
  return { root, select };
}
