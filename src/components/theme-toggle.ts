import { toggleStoredTheme } from "../app/theme";

function moonSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
}

function sunSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
}

function syncIcon(btn: HTMLButtonElement): void {
  const dark = document.documentElement.classList.contains("dark");
  btn.innerHTML = dark ? sunSvg() : moonSvg();
}

export function createThemeToggle(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = "Toggle color theme";
  btn.setAttribute(
    "aria-label",
    "Toggle between light and dark theme",
  );
  btn.className = "dp-icon-button shrink-0";

  syncIcon(btn);

  btn.addEventListener("click", () => {
    toggleStoredTheme();
    syncIcon(btn);
  });

  return btn;
}
