export type AppFooterOptions = {
  version: string;
  tagline?: string;
  statusElement?: HTMLElement;
};

export function createAppFooter(options: AppFooterOptions): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "dp-footer";

  const statusSlot = document.createElement("div");
  statusSlot.className = "dp-footer-status";
  if (options.statusElement) {
    statusSlot.append(options.statusElement);
  }

  const metaGroup = document.createElement("div");
  metaGroup.className = "dp-footer-meta";

  const versionSpan = document.createElement("span");
  versionSpan.className = "tabular-nums font-medium text-foreground/75";
  versionSpan.textContent = `Version ${options.version}`;

  const sep = document.createElement("span");
  sep.className = "mx-2 opacity-40";
  sep.textContent = "·";

  const meta = document.createElement("span");
  meta.textContent = options.tagline ?? "Rust · Tauri";

  metaGroup.append(versionSpan, sep, meta);
  footer.append(statusSlot, metaGroup);
  return footer;
}
