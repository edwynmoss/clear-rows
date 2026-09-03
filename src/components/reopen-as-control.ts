export type ReopenAsValues = {
  delimiter: string;
  encoding: string;
};

export type ReopenAsControlOptions = {
  onApply: (values: ReopenAsValues) => void;
};

export type ReopenAsControl = {
  readonly root: HTMLDivElement;
  setEnabled(enabled: boolean): void;
  /** Pre-fill the popover with the current detected values. */
  setDefaults(values: { delimiterChar: string | null; encoding: string | null }): void;
};

const DELIMITER_OPTIONS: Array<{ label: string; char: string }> = [
  { label: "Comma (,)", char: "," },
  { label: "Semicolon (;)", char: ";" },
  { label: "Tab (\\t)", char: "\t" },
  { label: "Pipe (|)", char: "|" },
  { label: "Colon (:)", char: ":" },
  { label: "Space ( )", char: " " },
];

// Values are labels the Rust side resolves: our four fixed ones, then WHATWG
// encoding labels understood by encoding_rs.
const ENCODING_OPTIONS: Array<{ label: string; value: string }> = [
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

export function createReopenAsControl(options: ReopenAsControlOptions): ReopenAsControl {
  const root = document.createElement("div");
  root.className = "dp-reopen";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "dp-button dp-button-secondary dp-reopen-trigger";
  button.textContent = "Reopen as…";
  button.disabled = true;
  button.setAttribute("aria-expanded", "false");

  const panel = document.createElement("div");
  panel.className = "dp-reopen-panel hidden";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Reopen with overrides");

  const delimiterField = createField("Delimiter", "dp-reopen-delim");
  const delimiterSelect = delimiterField.select;
  for (const option of DELIMITER_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = option.char;
    opt.textContent = option.label;
    delimiterSelect.append(opt);
  }

  const encodingField = createField("Encoding", "dp-reopen-enc");
  const encodingSelect = encodingField.select;
  for (const option of ENCODING_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    encodingSelect.append(opt);
  }

  const actions = document.createElement("div");
  actions.className = "dp-reopen-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "dp-button dp-button-secondary";
  cancel.textContent = "Cancel";

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "dp-button dp-button-primary";
  apply.textContent = "Reopen";

  actions.append(cancel, apply);
  panel.append(delimiterField.root, encodingField.root, actions);
  root.append(button, panel);

  let isOpen = false;

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    panel.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", handleOutsideClick, true);
    document.removeEventListener("keydown", handleEscape);
  }

  function open(): void {
    if (isOpen || button.disabled) return;
    isOpen = true;
    panel.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", handleOutsideClick, true);
    document.addEventListener("keydown", handleEscape);
  }

  function handleOutsideClick(event: MouseEvent): void {
    if (!(event.target instanceof Node)) return;
    if (root.contains(event.target)) return;
    close();
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      close();
      button.focus();
    }
  }

  button.addEventListener("click", () => {
    if (isOpen) {
      close();
    } else {
      open();
    }
  });

  cancel.addEventListener("click", () => {
    close();
  });

  apply.addEventListener("click", () => {
    options.onApply({
      delimiter: delimiterSelect.value,
      encoding: encodingSelect.value,
    });
    close();
  });

  return {
    root,
    setEnabled(enabled: boolean) {
      button.disabled = !enabled;
      if (!enabled) {
        close();
      }
    },
    setDefaults(values) {
      if (values.delimiterChar) {
        const match = DELIMITER_OPTIONS.find((option) => option.char === values.delimiterChar);
        if (match) {
          delimiterSelect.value = match.char;
        }
      }
      if (values.encoding) {
        const match = ENCODING_OPTIONS.find((option) => option.value === values.encoding);
        if (match) {
          encodingSelect.value = match.value;
        }
      }
    },
  };
}

function createField(
  label: string,
  id: string,
): { root: HTMLLabelElement; select: HTMLSelectElement } {
  const root = document.createElement("label");
  root.className = "dp-reopen-field";
  root.htmlFor = id;

  const text = document.createElement("span");
  text.className = "dp-reopen-field-label";
  text.textContent = label;

  const select = document.createElement("select");
  select.id = id;
  select.className = "dp-reopen-select";

  root.append(text, select);
  return { root, select };
}
