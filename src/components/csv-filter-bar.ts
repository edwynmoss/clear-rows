export type CsvFilterBarOptions = {
  onApply: (query: string) => void;
  onClear: () => void;
};

export type CsvFilterBar = {
  readonly root: HTMLDivElement;
  readonly input: HTMLInputElement;
  setVisible(visible: boolean): void;
  setBusy(busy: boolean): void;
  setStatus(text: string, tone?: "neutral" | "negative"): void;
  setActiveQuery(query: string | null): void;
  focus(): void;
};

/**
 * Toolbar above the grid: input + Apply/Clear + status. Submission is on
 * Enter; an empty submit clears the filter via the same backend command.
 */
export function createCsvFilterBar(options: CsvFilterBarOptions): CsvFilterBar {
  const root = document.createElement("div");
  root.className = "dp-filter-bar hidden";
  root.setAttribute("role", "search");
  root.setAttribute("aria-label", "Filter rows");

  const label = document.createElement("label");
  label.className = "dp-filter-label";
  label.textContent = "Filter";

  const input = document.createElement("input");
  input.type = "search";
  input.className = "dp-filter-input";
  input.placeholder = "Type to filter rows…";
  input.spellcheck = false;
  input.autocomplete = "off";
  const inputId = "dp-filter-input";
  input.id = inputId;
  label.htmlFor = inputId;

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "dp-button dp-button-primary";
  apply.textContent = "Apply";

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "dp-button dp-button-secondary";
  clear.textContent = "Clear";
  clear.disabled = true;

  const status = document.createElement("span");
  status.className = "dp-filter-status";
  status.dataset.tone = "neutral";
  status.setAttribute("aria-live", "polite");

  root.append(label, input, apply, clear, status);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      options.onApply(input.value);
    } else if (event.key === "Escape" && input.value.length > 0) {
      event.preventDefault();
      input.value = "";
      options.onClear();
    }
  });

  apply.addEventListener("click", () => {
    options.onApply(input.value);
  });

  clear.addEventListener("click", () => {
    input.value = "";
    options.onClear();
  });

  return {
    root,
    input,
    setVisible(visible) {
      root.classList.toggle("hidden", !visible);
    },
    setBusy(busy) {
      apply.disabled = busy;
      input.disabled = busy;
      root.dataset.busy = busy ? "true" : "false";
    },
    setStatus(text, tone = "neutral") {
      status.textContent = text;
      status.dataset.tone = tone;
    },
    setActiveQuery(query) {
      const hasQuery = query !== null && query.length > 0;
      clear.disabled = !hasQuery;
      if (hasQuery) {
        input.value = query!;
      }
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
