export type ColumnVisibilityControlOptions = {
  /** Called when the user toggles, hides-all-but-one, or resets columns. */
  onChange: (hidden: Set<number>) => void;
};

export type ColumnVisibilityControl = {
  readonly root: HTMLDivElement;
  setEnabled(enabled: boolean): void;
  /** Sync the popover with the current dataset and hidden state. */
  setColumns(headers: string[], hidden: Set<number>): void;
};

export function createColumnVisibilityControl(
  options: ColumnVisibilityControlOptions,
): ColumnVisibilityControl {
  const root = document.createElement("div");
  root.className = "dp-colvis";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "dp-button dp-button-secondary dp-colvis-trigger";
  button.textContent = "Columns";
  button.title = "Show or hide individual columns";
  button.disabled = true;
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-haspopup", "dialog");

  const panel = document.createElement("div");
  panel.className = "dp-colvis-panel hidden";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Column visibility");

  const header = document.createElement("div");
  header.className = "dp-colvis-header";

  const title = document.createElement("span");
  title.className = "dp-colvis-title";
  title.textContent = "Show columns";

  const actions = document.createElement("div");
  actions.className = "dp-colvis-quick-actions";

  const showAll = document.createElement("button");
  showAll.type = "button";
  showAll.className = "dp-colvis-link";
  showAll.textContent = "Show all";

  const hideAll = document.createElement("button");
  hideAll.type = "button";
  hideAll.className = "dp-colvis-link";
  hideAll.textContent = "Hide all";

  actions.append(showAll, hideAll);
  header.append(title, actions);

  const list = document.createElement("div");
  list.className = "dp-colvis-list";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "Column toggles");

  panel.append(header, list);
  root.append(button, panel);

  let isOpen = false;
  let currentHeaders: string[] = [];
  let currentHidden: Set<number> = new Set();

  function emit(next: Set<number>): void {
    currentHidden = next;
    renderList();
    options.onChange(new Set(next));
  }

  function renderList(): void {
    list.replaceChildren();
    if (currentHeaders.length === 0) {
      const note = document.createElement("div");
      note.className = "dp-colvis-empty";
      note.textContent = "No columns to configure.";
      list.append(note);
      return;
    }

    currentHeaders.forEach((header, index) => {
      const row = document.createElement("label");
      row.className = "dp-colvis-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "dp-colvis-checkbox";
      checkbox.checked = !currentHidden.has(index);
      checkbox.addEventListener("change", () => {
        const next = new Set(currentHidden);
        if (checkbox.checked) {
          next.delete(index);
        } else {
          // Refuse to hide the very last visible column — leaving zero visible
          // makes the grid empty in a way that's hard to recover from
          // visually. Re-tick instead.
          if (next.size + 1 >= currentHeaders.length) {
            checkbox.checked = true;
            return;
          }
          next.add(index);
        }
        emit(next);
      });

      const label = document.createElement("span");
      label.className = "dp-colvis-label";
      label.textContent = header || `Column ${index + 1}`;
      label.title = label.textContent;

      row.append(checkbox, label);
      list.append(row);
    });
  }

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

  showAll.addEventListener("click", () => {
    emit(new Set());
  });

  hideAll.addEventListener("click", () => {
    if (currentHeaders.length <= 1) {
      return;
    }
    // Keep the first column visible — see refusal logic above.
    const next = new Set<number>();
    for (let i = 1; i < currentHeaders.length; i++) {
      next.add(i);
    }
    emit(next);
  });

  return {
    root,
    setEnabled(enabled: boolean) {
      button.disabled = !enabled;
      if (!enabled) {
        close();
      }
    },
    setColumns(headers: string[], hidden: Set<number>) {
      currentHeaders = headers;
      currentHidden = new Set(hidden);
      renderList();
    },
  };
}
