import { createButton } from "./primary-button";

export type AppHeaderOptions = {
  title: string;
  subtitle: string;
  openLabel?: string;
  onOpenCsv?: () => void;
  /** Extra controls after the primary action (e.g. theme toggle). */
  trailingWidgets?: HTMLElement[];
};

export type AppHeader = {
  readonly root: HTMLElement;
  readonly openButton: HTMLButtonElement;
};

export function createAppHeader(options: AppHeaderOptions): AppHeader {
  const header = document.createElement("header");
  header.className = "dp-header";

  const inner = document.createElement("div");
  inner.className = "dp-header-inner";

  const brandBlock = document.createElement("div");
  brandBlock.className = "dp-brand";

  const mark = document.createElement("div");
  mark.className = "dp-brand-mark";
  mark.setAttribute("aria-hidden", "true");

  const logo = document.createElement("img");
  logo.className = "dp-brand-logo";
  logo.src = "/clear-rows-logo.png";
  logo.alt = "";
  logo.decoding = "async";

  mark.append(logo);

  const titles = document.createElement("div");
  titles.className = "flex min-w-0 flex-col gap-0.5";

  const titleEl = document.createElement("div");
  titleEl.className = "dp-title truncate";
  titleEl.textContent = options.title;

  const subtitleEl = document.createElement("div");
  subtitleEl.className = "dp-subtitle max-w-xl";
  subtitleEl.textContent = options.subtitle;

  titles.append(titleEl, subtitleEl);
  brandBlock.append(mark, titles);

  const actions = document.createElement("div");
  actions.className = "dp-actions";

  const shortcuts = document.createElement("div");
  shortcuts.className =
    "hidden items-center gap-1 sm:flex text-[10px] font-medium text-muted";
  shortcuts.innerHTML =
    "<kbd class=\"rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-foreground\">Ctrl</kbd><span class=\"opacity-50\">+</span><kbd class=\"rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-foreground\">O</kbd>";

  const openButton = createButton({
    label: options.openLabel ?? "Open file",
    variant: "primary",
    onClick: options.onOpenCsv,
  });

  actions.append(shortcuts, openButton);

  if (options.trailingWidgets?.length) {
    const extras = document.createElement("div");
    extras.className = "ml-1 flex items-center gap-1 border-l border-border pl-2";
    extras.append(...options.trailingWidgets);
    actions.append(extras);
  }

  inner.append(brandBlock, actions);
  header.append(inner);

  return { root: header, openButton };
}
