import { createAppFooter } from "./app-footer";
import { createAppHeader } from "./app-header";
import { createProgressStrip, type ProgressStrip } from "./progress-strip";
import {
  createStatusBanner,
  type StatusBanner,
  type StatusTone,
} from "./status-banner";

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
  readonly progress: ProgressStrip;
  readonly gridHost: HTMLDivElement;
  setSubtitleVisible(visible: boolean): void;
};

export function createAppShell(options: AppShellOptions): AppShell {
  const root = document.createElement("div");
  root.className =
    "flex h-screen min-h-0 overflow-hidden flex-col bg-background text-foreground";

  const header = createAppHeader({
    title: options.title,
    subtitle: options.subtitle,
    onOpenCsv: options.onOpenCsv,
    trailingWidgets: options.headerExtras,
  });

  const progress = createProgressStrip();

  const main = document.createElement("main");
  main.className = "dp-shell-main";

  const footerStatus = createStatusBanner("", "neutral");
  footerStatus.element.dataset.placement = "footer";

  const inlineStatus = createStatusBanner("", "neutral");
  inlineStatus.element.dataset.placement = "inline";

  const gridHost = document.createElement("div");
  gridHost.className = "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden";

  main.append(inlineStatus.element, gridHost);

  const footer = createAppFooter({
    version: options.version,
    tagline: options.footerTagline,
    statusElement: footerStatus.element,
  });
  root.append(header.root, progress.element, main, footer);

  // Router: footer always reflects the latest text. Inline banner mirrors the
  // text only for transient `busy` / `negative` states so users see them
  // without scanning to the bottom edge.
  const status: StatusBanner = {
    element: footerStatus.element,
    setText(text: string, tone: StatusTone = "neutral") {
      footerStatus.setText(text, tone);
      const showsInline = tone === "busy" || tone === "negative";
      inlineStatus.setText(showsInline ? text : "", tone);
    },
  };

  return {
    root,
    status,
    progress,
    gridHost,
    setSubtitleVisible(visible: boolean) {
      header.setSubtitleVisible(visible);
    },
  };
}
