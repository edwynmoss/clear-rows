export type AppShellOptions = {
  topBar: HTMLElement;
  queryBar: HTMLElement;
  statusBar: HTMLElement;
  toasts: HTMLElement;
  overlays?: HTMLElement[];
};

export type AppShell = {
  readonly root: HTMLDivElement;
  /** Main view host: exactly one view is visible at a time. */
  readonly main: HTMLDivElement;
  showView(view: HTMLElement): void;
};

export function createAppShell(options: AppShellOptions): AppShell {
  const root = document.createElement("div");
  root.className = "cr-app";

  const main = document.createElement("main");
  main.className = "cr-main";

  const mainHost = main as unknown as HTMLDivElement;

  root.append(options.topBar, options.queryBar, main, options.statusBar, options.toasts, ...(options.overlays ?? []));

  const views = new Set<HTMLElement>();

  return {
    root,
    main: mainHost,
    showView(view) {
      views.add(view);
      if (!main.contains(view)) main.append(view);
      for (const candidate of views) {
        candidate.hidden = candidate !== view;
      }
    },
  };
}
