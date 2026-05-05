import { createAppFooter } from "./app-footer";
import { createAppHeader } from "./app-header";
import { createStatusBanner, type StatusBanner } from "./status-banner";

export type AppShellOptions = {
  title: string;
  subtitle: string;
  version: string;
  footerTagline?: string;
  onOpenCsv?: () => void;
  headerExtras?: HTMLElement[];
};

export type AppShell = {
  readonly root: HTMLDivElement;
  readonly status: StatusBanner;
  readonly gridHost: HTMLDivElement;
};

export function createAppShell(options: AppShellOptions): AppShell {
  const root = document.createElement("div");
  root.className =
    "flex h-dvh min-h-0 overflow-hidden flex-col bg-background text-foreground";

  const header = createAppHeader({
    title: options.title,
    subtitle: options.subtitle,
    onOpenCsv: options.onOpenCsv,
    trailingWidgets: options.headerExtras,
  });

  const main = document.createElement("main");
  main.className = "dp-shell-main";

  const status = createStatusBanner("", "neutral");
  status.element.dataset.placement = "footer";

  const gridHost = document.createElement("div");
  gridHost.className = "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden";

  main.append(gridHost);

  const footer = createAppFooter({
    version: options.version,
    tagline: options.footerTagline,
    statusElement: status.element,
  });
  root.append(header.root, main, footer);

  return { root, status, gridHost };
}
