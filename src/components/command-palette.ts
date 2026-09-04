export type Command = {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  /** Hidden from the list when false; still keyboard-invocable elsewhere. */
  enabled?: boolean;
  run: () => void;
};

export type CommandPaletteOptions = {
  commands: () => Command[];
};

export type CommandPalette = {
  readonly root: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
};

export function createCommandPalette(options: CommandPaletteOptions): CommandPalette {
  const root = document.createElement("div");
  root.className = "cr-palette-backdrop";
  root.hidden = true;

  const panel = document.createElement("div");
  panel.className = "cr-palette";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Commands");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "cr-palette-input";
  input.placeholder = "Type a command…";
  input.autocomplete = "off";
  input.spellcheck = false;

  const list = document.createElement("div");
  list.className = "cr-palette-list";
  list.setAttribute("role", "listbox");

  panel.append(input, list);
  root.append(panel);

  let items: Command[] = [];
  let active = 0;

  function render(): void {
    const needle = input.value.trim().toLowerCase();
    items = options
      .commands()
      .filter((command) => command.enabled !== false)
      .filter((command) => needle.length === 0 || fuzzy(needle, `${command.label} ${command.hint ?? ""}`));
    active = Math.min(active, Math.max(0, items.length - 1));
    list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cr-palette-empty";
      empty.textContent = "No matching command";
      list.append(empty);
      return;
    }
    items.forEach((command, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cr-palette-item";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === active));
      const label = document.createElement("span");
      label.className = "cr-palette-label";
      label.textContent = command.label;
      row.append(label);
      if (command.hint) {
        const hint = document.createElement("span");
        hint.className = "cr-palette-hint";
        hint.textContent = command.hint;
        row.append(hint);
      }
      if (command.shortcut) {
        const kbd = document.createElement("kbd");
        kbd.textContent = command.shortcut;
        row.append(kbd);
      }
      row.addEventListener("mouseenter", () => {
        active = index;
        updateActive();
      });
      row.addEventListener("click", () => run(index));
      list.append(row);
    });
  }

  function updateActive(): void {
    list.querySelectorAll<HTMLElement>(".cr-palette-item").forEach((el, index) => {
      el.setAttribute("aria-selected", String(index === active));
    });
    list.children.item(active)?.scrollIntoView({ block: "nearest" });
  }

  function run(index: number): void {
    const command = items[index];
    close();
    command?.run();
  }

  function open(): void {
    root.hidden = false;
    input.value = "";
    active = 0;
    render();
    requestAnimationFrame(() => input.focus());
  }

  function close(): void {
    root.hidden = true;
  }

  input.addEventListener("input", () => {
    active = 0;
    render();
  });
  input.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        active = Math.min(items.length - 1, active + 1);
        updateActive();
        break;
      case "ArrowUp":
        event.preventDefault();
        active = Math.max(0, active - 1);
        updateActive();
        break;
      case "Enter":
        event.preventDefault();
        run(active);
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
    }
  });
  root.addEventListener("mousedown", (event) => {
    if (event.target === root) close();
  });

  return {
    root,
    open,
    close,
    toggle() {
      if (root.hidden) open();
      else close();
    },
    isOpen: () => !root.hidden,
  };
}

function fuzzy(needle: string, haystack: string): boolean {
  const text = haystack.toLowerCase();
  if (text.includes(needle)) return true;
  let position = 0;
  for (const ch of needle) {
    position = text.indexOf(ch, position);
    if (position < 0) return false;
    position++;
  }
  return true;
}
