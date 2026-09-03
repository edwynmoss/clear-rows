import { fileNameOf, formatBytes, formatInt, relativeTime } from "../app/format";
import type { RecentFile } from "../app/preferences";

export type CsvEmptyStateOptions = {
  onOpenClick: () => void;
  onOpenRecent: (path: string) => void;
  onForgetRecent: (path: string) => void;
};

export type CsvEmptyState = {
  readonly root: HTMLDivElement;
  setRecent(files: RecentFile[]): void;
  setDragOver(over: boolean): void;
};

export function createCsvEmptyState(options: CsvEmptyStateOptions): CsvEmptyState {
  const root = document.createElement("div");
  root.className = "cr-empty";

  const inner = document.createElement("div");
  inner.className = "cr-empty-inner";

  const drop = document.createElement("div");
  drop.className = "cr-drop";

  const heading = document.createElement("h2");
  heading.textContent = "Drop a CSV, TSV or delimited export here";

  const blurb = document.createElement("p");
  blurb.textContent =
    "Files stay on this machine. Large files open progressively and never freeze the grid.";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "cr-btn cr-btn-secondary";
  button.textContent = "Choose a file…";
  button.addEventListener("click", options.onOpenClick);

  drop.append(heading, blurb, button);

  const recent = document.createElement("div");
  recent.className = "cr-recent";
  recent.hidden = true;

  const recentTitle = document.createElement("h3");
  recentTitle.textContent = "Recent";
  const recentList = document.createElement("div");
  recentList.className = "cr-recent-list";
  recent.append(recentTitle, recentList);

  inner.append(drop, recent);
  root.append(inner);

  return {
    root,
    setRecent(files) {
      recentList.replaceChildren();
      recent.hidden = files.length === 0;
      for (const file of files) {
        const row = document.createElement("div");
        row.className = "cr-recent-row";

        const open = document.createElement("button");
        open.type = "button";
        open.className = "cr-recent-open";
        open.title = file.path;
        const name = document.createElement("span");
        name.className = "cr-recent-name";
        name.textContent = fileNameOf(file.path);
        const meta = document.createElement("span");
        meta.className = "cr-recent-meta";
        meta.textContent = [
          file.rows !== undefined ? `${formatInt(file.rows)} rows` : "",
          file.sizeBytes !== undefined ? formatBytes(file.sizeBytes) : "",
          relativeTime(file.openedAt),
        ]
          .filter(Boolean)
          .join(" · ");
        open.append(name, meta);
        open.addEventListener("click", () => options.onOpenRecent(file.path));

        const forget = document.createElement("button");
        forget.type = "button";
        forget.className = "cr-recent-forget";
        forget.setAttribute("aria-label", `Remove ${fileNameOf(file.path)} from recent`);
        forget.textContent = "×";
        forget.addEventListener("click", (event) => {
          event.stopPropagation();
          options.onForgetRecent(file.path);
        });

        row.append(open, forget);
        recentList.append(row);
      }
    },
    setDragOver(over) {
      root.dataset.dragOver = over ? "true" : "false";
    },
  };
}
