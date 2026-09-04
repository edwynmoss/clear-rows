import { formatInt } from "../app/format";

/**
 * Point-and-click filter builder shown under the query field. Produces the
 * same term syntax the grammar accepts (column:value, column=value, /regex/,
 * -negation), so chips, the input and the backend all agree.
 */

export type BuilderCondition =
  | "contains"
  | "not-contains"
  | "is"
  | "is-not"
  | "regex"
  | "empty"
  | "not-empty";

const CONDITIONS: Array<{ value: BuilderCondition; label: string; needsValue: boolean }> = [
  { value: "contains", label: "contains", needsValue: true },
  { value: "not-contains", label: "doesn't contain", needsValue: true },
  { value: "is", label: "is exactly", needsValue: true },
  { value: "is-not", label: "is not", needsValue: true },
  { value: "regex", label: "matches regex", needsValue: true },
  { value: "empty", label: "is empty", needsValue: false },
  { value: "not-empty", label: "is not empty", needsValue: false },
];

export type FilterBuilderOptions = {
  /** Current headers; called when the popover opens. */
  headers: () => string[];
  /** Distinct sample values for a column, or null when the column is free-text. */
  sampleValues: (columnIndex: number) => Promise<string[] | null>;
  /**
   * Called with a ready-to-apply term, e.g. `severity=high`. `replacesTyped`
   * is true when the term was built from the word being typed in the main
   * input, so the caller should swap that word out rather than append.
   */
  onAddTerm: (term: string, replacesTyped: boolean) => void;
  /** Called when the user chooses "search everywhere" for the word being typed. */
  onSearchAll: (text: string) => void;
  /** Called when the user closes the popover with its button or Escape. */
  onClose?: () => void;
};

export type FilterBuilder = {
  readonly root: HTMLElement;
  open(anchor: HTMLElement, typed: string): void;
  close(): void;
  isOpen(): boolean;
  /** Update suggestions as the user types in the main input. */
  setTyped(text: string): void;
  /** Whether a pointer event originated inside the builder. */
  contains(node: Node | null): boolean;
};

export function buildTerm(column: string | null, condition: BuilderCondition, value: string): string {
  const col = column === null ? null : quoteColumn(column);
  const val = quoteValue(value);
  switch (condition) {
    case "contains":
      return col ? `${col}:${val}` : val;
    case "not-contains":
      return col ? `-${col}:${val}` : `-${val}`;
    case "is":
      return `${col ?? '"any"'}=${val}`;
    case "is-not":
      return `-${col ?? '"any"'}=${val}`;
    case "regex":
      return col ? `${col}:/${value}/` : `/${value}/`;
    case "empty":
      return `${col ?? '"any"'}=""`;
    case "not-empty":
      return `-${col ?? '"any"'}=""`;
  }
}

function quoteColumn(column: string): string {
  return /[\s:"=/#-]/.test(column) || column.length === 0 ? `"${column.replace(/"/g, '""')}"` : column;
}

function quoteValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '""';
  return /[\s:"=/]/.test(trimmed) || trimmed.startsWith("-") ? `"${trimmed.replace(/"/g, '""')}"` : trimmed;
}

export function createFilterBuilder(options: FilterBuilderOptions): FilterBuilder {
  const root = document.createElement("div");
  root.className = "cr-builder";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Build a filter");

  // --- header: what this is, and a way out ---------------------------
  const head = document.createElement("div");
  head.className = "cr-builder-head";
  const title = document.createElement("span");
  title.className = "cr-builder-title";
  title.textContent = "Filter builder";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "cr-builder-close";
  closeButton.setAttribute("aria-label", "Close filter builder");
  closeButton.title = "Close (Esc)";
  closeButton.textContent = "\u00d7";
  head.append(title, closeButton);

  // --- typed-text suggestions ---------------------------------------
  const suggest = document.createElement("div");
  suggest.className = "cr-builder-suggest";

  // --- structured row -----------------------------------------------
  const row = document.createElement("div");
  row.className = "cr-builder-row";

  const columnSelect = document.createElement("select");
  columnSelect.className = "cr-select cr-builder-column";
  columnSelect.setAttribute("aria-label", "Column");

  const conditionSelect = document.createElement("select");
  conditionSelect.className = "cr-select cr-builder-condition";
  conditionSelect.setAttribute("aria-label", "Condition");
  for (const condition of CONDITIONS) {
    const option = document.createElement("option");
    option.value = condition.value;
    option.textContent = condition.label;
    conditionSelect.append(option);
  }

  const valueWrap = document.createElement("div");
  valueWrap.className = "cr-builder-valuewrap";
  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.className = "cr-builder-value";
  valueInput.placeholder = "value";
  valueInput.autocomplete = "off";
  valueInput.spellcheck = false;
  const valueList = document.createElement("datalist");
  valueList.id = "cr-builder-values";
  valueInput.setAttribute("list", valueList.id);
  valueWrap.append(valueInput, valueList);

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "cr-btn cr-btn-primary";
  addButton.textContent = "Add";

  row.append(columnSelect, conditionSelect, valueWrap, addButton);

  const hint = document.createElement("div");
  hint.className = "cr-builder-hint";
  hint.textContent = "Conditions combine with AND. You can also type them: severity=high  -user:svc  /regex/";

  root.append(head, suggest, row, hint);

  let anchor: HTMLElement | null = null;
  let typed = "";
  let sampleToken = 0;

  function currentCondition(): { value: BuilderCondition; needsValue: boolean } {
    return CONDITIONS.find((c) => c.value === conditionSelect.value) ?? CONDITIONS[0];
  }

  function syncConditionOptions(): void {
    // Exact/empty checks need a column; "any column" only supports substring and regex.
    const anyColumn = columnSelect.value === "*";
    for (const option of Array.from(conditionSelect.options)) {
      const needsColumn = ["is", "is-not", "empty", "not-empty"].includes(option.value);
      option.hidden = anyColumn && needsColumn;
      option.disabled = option.hidden;
    }
    if (conditionSelect.selectedOptions[0]?.disabled) conditionSelect.value = "contains";
  }

  function syncValueField(): void {
    const condition = currentCondition();
    valueInput.disabled = !condition.needsValue;
    valueInput.placeholder = condition.value === "regex" ? "pattern, e.g. ^WS-00" : condition.needsValue ? "value" : "";
    if (!condition.needsValue) valueInput.value = "";
  }

  function selectedColumn(): { index: number | null; name: string | null } {
    const raw = columnSelect.value;
    if (raw === "*") return { index: null, name: null };
    const index = Number.parseInt(raw, 10);
    const name = options.headers()[index] ?? null;
    return { index: Number.isNaN(index) ? null : index, name };
  }

  async function refreshSamples(): Promise<void> {
    const token = ++sampleToken;
    valueList.replaceChildren();
    const { index } = selectedColumn();
    if (index === null) return;
    const values = await options.sampleValues(index);
    if (token !== sampleToken || !values) return;
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      valueList.append(option);
    }
  }

  function renderSuggestions(): void {
    suggest.replaceChildren();
    // Only the word being typed gets suggestions; earlier words are
    // treated as terms the user already knows how to write.
    const text = typed.trimEnd().split(/\s+/).pop() ?? "";
    if (text.length === 0 || /[:="]|^\/|^-/.test(text)) {
      suggest.hidden = true;
      return;
    }
    suggest.hidden = false;
    const all = suggestion(`Search everywhere for “${text}”`, () => options.onSearchAll(text));
    all.classList.add("is-primary");
    suggest.append(all);

    const headers = options.headers();
    const scoped = document.createElement("div");
    scoped.className = "cr-builder-scoped";
    const label = document.createElement("span");
    label.textContent = "or only in";
    scoped.append(label);
    for (const [index, header] of headers.slice(0, 12).entries()) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "cr-builder-colchip";
      chip.textContent = header || `Column ${index + 1}`;
      chip.addEventListener("mousedown", (event) => event.preventDefault());
      chip.addEventListener("click", () => options.onAddTerm(buildTerm(header, "contains", text), true));
      scoped.append(chip);
    }
    if (headers.length > 12) {
      const more = document.createElement("span");
      more.className = "cr-builder-more";
      more.textContent = `+${formatInt(headers.length - 12)} more in the column list below`;
      scoped.append(more);
    }
    suggest.append(scoped);
  }

  function suggestion(label: string, run: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cr-builder-suggestion";
    button.textContent = label;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", run);
    return button;
  }

  function submit(): void {
    const condition = currentCondition();
    const { name } = selectedColumn();
    const value = valueInput.value;
    if (condition.needsValue && value.trim().length === 0) {
      valueInput.focus();
      return;
    }
    options.onAddTerm(buildTerm(name, condition.value, value), false);
    valueInput.value = "";
  }

  function position(): void {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    // Wide enough for the condition row even when chips have squeezed the
    // input, but never past the right edge of the window.
    const margin = 12;
    const available = Math.max(320, window.innerWidth - margin * 2);
    const width = Math.min(Math.max(640, rect.width), 900, available);
    const left = Math.min(rect.left, window.innerWidth - margin - width);
    root.style.left = `${Math.max(margin, left)}px`;
    root.style.top = `${rect.bottom + 6}px`;
    root.style.width = `${width}px`;
  }

  columnSelect.addEventListener("change", () => {
    syncConditionOptions();
    syncValueField();
    void refreshSamples();
  });
  conditionSelect.addEventListener("change", syncValueField);
  addButton.addEventListener("click", submit);
  closeButton.addEventListener("click", () => {
    root.hidden = true;
    anchor = null;
    options.onClose?.();
  });
  valueInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  // Keep the main input's focus when clicking around the popover.
  root.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && (target.tagName === "SELECT" || target.tagName === "INPUT" || target.tagName === "OPTION")) return;
    event.preventDefault();
  });
  window.addEventListener("resize", position);

  return {
    root,
    open(nextAnchor, nextTyped) {
      anchor = nextAnchor;
      typed = nextTyped;
      const headers = options.headers();
      columnSelect.replaceChildren();
      const any = document.createElement("option");
      any.value = "*";
      any.textContent = "Any column";
      columnSelect.append(any);
      headers.forEach((header, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = header || `Column ${index + 1}`;
        columnSelect.append(option);
      });
      syncConditionOptions();
      syncValueField();
      renderSuggestions();
      root.hidden = false;
      position();
      void refreshSamples();
    },
    close() {
      root.hidden = true;
      anchor = null;
    },
    isOpen: () => !root.hidden,
    setTyped(text) {
      typed = text;
      if (!root.hidden) renderSuggestions();
    },
    contains: (node) => node !== null && root.contains(node),
  };
}
