export type JumpToRowOptions = {
  onApply: (rowNumber: number) => void;
};

export type JumpToRow = {
  readonly root: HTMLDivElement;
  setVisible(visible: boolean): void;
  setMaxRow(max: number): void;
  setStatus(text: string, tone?: "neutral" | "negative"): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
};

/**
 * A small overlay row above the grid that asks for a 1-indexed row number
 * and scrolls to it. Hidden by default; toggled with Ctrl+G from
 * mount-application.
 */
export function createJumpToRow(options: JumpToRowOptions): JumpToRow {
  const root = document.createElement("div");
  root.className = "dp-jump-bar hidden";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Jump to row");

  const label = document.createElement("label");
  label.className = "dp-jump-label";
  label.textContent = "Go to row";

  const input = document.createElement("input");
  input.type = "number";
  input.inputMode = "numeric";
  input.min = "1";
  input.step = "1";
  input.className = "dp-jump-input";
  input.placeholder = "1";
  input.autocomplete = "off";
  const inputId = "dp-jump-input";
  input.id = inputId;
  label.htmlFor = inputId;

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "dp-button dp-button-primary";
  apply.textContent = "Go";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "dp-button dp-button-secondary";
  close.textContent = "Close";
  close.setAttribute("aria-label", "Close jump-to-row");

  const status = document.createElement("span");
  status.className = "dp-jump-status";
  status.dataset.tone = "neutral";
  status.setAttribute("aria-live", "polite");

  root.append(label, input, apply, close, status);

  let maxRow = 0;
  let visible = false;

  function submit(): void {
    const raw = input.value.trim();
    if (raw.length === 0) {
      status.textContent = "Enter a row number.";
      status.dataset.tone = "negative";
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      status.textContent = "Row must be ≥ 1.";
      status.dataset.tone = "negative";
      return;
    }
    if (maxRow > 0 && parsed > maxRow) {
      status.textContent = `Row must be ≤ ${maxRow.toLocaleString()}.`;
      status.dataset.tone = "negative";
      return;
    }
    options.onApply(parsed);
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      doClose();
    }
  });

  apply.addEventListener("click", () => {
    submit();
  });

  close.addEventListener("click", () => {
    doClose();
  });

  function doClose(): void {
    visible = false;
    root.classList.add("hidden");
    status.textContent = "";
    status.dataset.tone = "neutral";
  }

  return {
    root,
    setVisible(next) {
      visible = next;
      root.classList.toggle("hidden", !next);
    },
    setMaxRow(next) {
      maxRow = Math.max(0, Math.floor(next));
      input.max = maxRow > 0 ? String(maxRow) : "";
    },
    setStatus(text, tone = "neutral") {
      status.textContent = text;
      status.dataset.tone = tone;
    },
    open() {
      visible = true;
      root.classList.remove("hidden");
      status.textContent = "";
      status.dataset.tone = "neutral";
      input.value = "";
      input.focus();
    },
    close() {
      doClose();
    },
    isOpen() {
      return visible;
    },
  };
}
