import { DEFAULT_SEARCH_LIMIT, SEARCH_LIMIT_OPTIONS } from "../app/constants";
import { formatBytes, formatInt } from "../app/format";
import { describeTerm, type FilterTerm } from "../csv/filter-query";

export type QueryMode = "file" | "files";

export type QueryBarOptions = {
  initialMode: QueryMode;
  initialLimit: number;
  onSubmit: (mode: QueryMode, query: string, limit: number) => void;
  onClear: (mode: QueryMode) => void;
  onCancel: () => void;
  onModeChange: (mode: QueryMode) => void;
  onLimitChange: (limit: number) => void;
  onPickFiles: () => void;
  onRemoveTerm: (index: number) => void;
  /** Focus entered/left the text field. */
  onFocusChange?: (focused: boolean, mode: QueryMode) => void;
  /** Text changed while typing. */
  onInput?: (text: string, mode: QueryMode) => void;
  /** Escape pressed in the field; return true when something else consumed it (e.g. a popover closed). */
  onEscape?: (mode: QueryMode) => boolean;
};

export type QueryBar = {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  /** The bordered field around the input; anchor popovers to this. */
  readonly field: HTMLDivElement;
  getMode(): QueryMode;
  setMode(mode: QueryMode): void;
  /** Whether a file is open (enables "This file") and whether search files exist. */
  setAvailability(state: { hasFile: boolean; searchFileCount: number; searchFileBytes: number }): void;
  setBusy(busy: boolean): void;
  setChips(terms: FilterTerm[]): void;
  setCount(matched: number | null, total: number | null): void;
  setError(message: string | null): void;
  setValue(value: string): void;
  /** Focus the input; selects everything unless `caretAtEnd` is set. */
  focus(options?: { caretAtEnd?: boolean }): void;
};

export function createQueryBar(options: QueryBarOptions): QueryBar {
  const root = document.createElement("section");
  root.className = "cr-query";
  root.setAttribute("role", "search");

  const field = document.createElement("div");
  field.className = "cr-query-field";

  const icon = document.createElement("span");
  icon.className = "cr-query-icon";
  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "cr-query-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "none");

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "cr-query-clear";
  clear.setAttribute("aria-label", "Clear");
  clear.textContent = "×";
  clear.hidden = true;

  field.append(icon, input, clear);

  const seg = document.createElement("div");
  seg.className = "cr-seg";
  seg.setAttribute("role", "tablist");
  const segFile = segButton("This file", "file");
  const segFiles = segButton("Across files", "files");
  seg.append(segFile, segFiles);

  const filesButton = document.createElement("button");
  filesButton.type = "button";
  filesButton.className = "cr-btn cr-btn-secondary cr-query-files";
  filesButton.textContent = "Files…";
  filesButton.addEventListener("click", options.onPickFiles);

  const limitWrap = document.createElement("label");
  limitWrap.className = "cr-limit";
  const limitLabel = document.createElement("span");
  limitLabel.textContent = "Limit";
  const limitSelect = document.createElement("select");
  limitSelect.className = "cr-limit-select";
  for (const limit of SEARCH_LIMIT_OPTIONS) {
    const option = document.createElement("option");
    option.value = String(limit);
    option.textContent = formatInt(limit);
    option.selected = limit === (options.initialLimit ?? DEFAULT_SEARCH_LIMIT);
    limitSelect.append(option);
  }
  limitSelect.addEventListener("change", () => options.onLimitChange(Number(limitSelect.value)));
  limitWrap.append(limitLabel, limitSelect);

  const chips = document.createElement("div");
  chips.className = "cr-chips";

  const count = document.createElement("span");
  count.className = "cr-query-count";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "cr-btn cr-btn-secondary";
  cancel.hidden = true;
  cancel.append(document.createTextNode("Cancel "));
  const cancelKbd = document.createElement("kbd");
  cancelKbd.textContent = "Esc";
  cancel.append(cancelKbd);
  cancel.addEventListener("click", options.onCancel);

  const error = document.createElement("div");
  error.className = "cr-query-error";
  error.hidden = true;

  const row = document.createElement("div");
  row.className = "cr-query-row";
  row.append(field, seg, filesButton, limitWrap, chips, count, cancel);

  root.append(row, error);

  let mode: QueryMode = options.initialMode;
  const values: Record<QueryMode, string> = { file: "", files: "" };
  let hasFile = false;
  let searchFileCount = 0;
  let searchFileBytes = 0;
  let busy = false;

  function segButton(label: string, value: QueryMode): HTMLButtonElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "cr-seg-item";
    el.dataset.value = value;
    el.textContent = label;
    el.setAttribute("role", "tab");
    el.addEventListener("click", () => {
      if (mode === value) return;
      setMode(value);
      options.onModeChange(value);
      input.focus();
    });
    return el;
  }

  function setMode(next: QueryMode): void {
    if (next !== mode) {
      values[mode] = input.value;
      mode = next;
      input.value = values[mode];
    }
    segFile.setAttribute("aria-selected", String(mode === "file"));
    segFiles.setAttribute("aria-selected", String(mode === "files"));
    render();
  }

  function render(): void {
    const fileMode = mode === "file";
    filesButton.hidden = fileMode;
    limitWrap.hidden = fileMode;
    chips.hidden = !fileMode;
    count.hidden = !fileMode;
    if (fileMode) {
      input.placeholder = hasFile
        ? "Filter rows… try  process:powershell  severity=high  -user:svc  /regex/"
        : "Open a file to filter its rows";
      input.disabled = !hasFile;
    } else {
      input.placeholder =
        searchFileCount > 0
          ? `Search ${formatInt(searchFileCount)} file${searchFileCount === 1 ? "" : "s"}…`
          : "Choose files, then type what to find";
      input.disabled = searchFileCount === 0;
    }
    filesButton.replaceChildren();
    if (searchFileCount > 0) {
      filesButton.append(document.createTextNode(`${formatInt(searchFileCount)} file${searchFileCount === 1 ? "" : "s"}`));
      if (searchFileBytes > 0) {
        const size = document.createElement("small");
        size.textContent = ` ${formatBytes(searchFileBytes)}`;
        filesButton.append(size);
      }
    } else {
      filesButton.textContent = "Files…";
    }
    // Read-only rather than disabled while busy so the field keeps focus
    // (a disabled input blurs, which would close the filter builder).
    input.readOnly = busy;
    clear.hidden = input.value.length === 0;
    cancel.hidden = !busy;
    root.dataset.busy = busy ? "true" : "false";
  }

  input.addEventListener("input", () => {
    clear.hidden = input.value.length === 0;
    if (!error.hidden) {
      error.hidden = true;
    }
    options.onInput?.(input.value, mode);
  });
  input.addEventListener("focus", () => options.onFocusChange?.(true, mode));
  input.addEventListener("blur", () => options.onFocusChange?.(false, mode));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (busy) return;
      options.onSubmit(mode, input.value, Number(limitSelect.value));
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (options.onEscape?.(mode)) return;
      if (busy) {
        options.onCancel();
      } else if (input.value.length > 0) {
        input.value = "";
        clear.hidden = true;
        options.onClear(mode);
      } else {
        input.blur();
      }
    }
  });
  clear.addEventListener("click", () => {
    input.value = "";
    clear.hidden = true;
    options.onClear(mode);
    input.focus();
  });

  setMode(mode);

  return {
    root,
    input,
    field,
    getMode: () => mode,
    setMode,
    setAvailability(state) {
      hasFile = state.hasFile;
      searchFileCount = state.searchFileCount;
      searchFileBytes = state.searchFileBytes;
      render();
    },
    setBusy(next) {
      busy = next;
      render();
    },
    setChips(terms) {
      chips.replaceChildren();
      terms.forEach((term, index) => {
        const chip = document.createElement("span");
        chip.className = "cr-chip";
        chip.dataset.negated = String(term.negated);
        chip.title = describeTerm(term);
        const text = document.createElement("span");
        const op = term.operator === "exact" ? " = " : term.operator === "regex" ? " ~ " : " : ";
        const value = term.operator === "regex" ? `/${term.value}/` : term.value;
        text.textContent = `${term.negated ? "not " : ""}${term.column ?? "any"}${op}${value}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "cr-chip-x";
        remove.setAttribute("aria-label", `Remove ${describeTerm(term)}`);
        remove.textContent = "×";
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          options.onRemoveTerm(index);
        });
        chip.append(text, remove);
        chips.append(chip);
      });
    },
    setCount(matched, total) {
      count.replaceChildren();
      if (matched === null || total === null) return;
      const strong = document.createElement("b");
      strong.textContent = formatInt(matched);
      count.append(strong, document.createTextNode(` of ${formatInt(total)}`));
    },
    setError(message) {
      error.hidden = !message;
      error.textContent = message ?? "";
    },
    setValue(value) {
      values.file = value;
      if (mode === "file") {
        input.value = value;
        clear.hidden = value.length === 0;
      }
    },
    focus(options) {
      input.focus();
      if (options?.caretAtEnd) {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      } else {
        input.select();
      }
    },
  };
}
