export type CsvEmptyStateOptions = {
  onOpenClick?: () => void;
};

export type CsvEmptyState = {
  readonly root: HTMLDivElement;
};

export function createCsvEmptyState(options: CsvEmptyStateOptions): CsvEmptyState {
  const root = document.createElement("div");
  root.className = "dp-workspace dp-empty-state";

  const content = document.createElement("div");
  content.className = "dp-empty-content";

  const label = document.createElement("div");
  label.className = "dp-empty-label";
  label.textContent = "Workspace";

  const heading = document.createElement("h2");
  heading.className = "dp-empty-title";
  heading.textContent = "Ready for data";

  const blurb = document.createElement("p");
  blurb.className = "dp-empty-copy";
  blurb.textContent = "Open a delimited file, or select a search set above.";

  const actions = document.createElement("div");
  actions.className = "flex flex-wrap items-center justify-center gap-2 pt-1";

  const primary = document.createElement("button");
  primary.type = "button";
  primary.textContent = "Open file";
  primary.className = "dp-button dp-button-primary px-5";

  if (options.onOpenClick) {
    primary.addEventListener("click", options.onOpenClick);
  }

  actions.append(primary);
  content.append(label, heading, blurb, actions);
  root.append(content);

  return { root };
}
