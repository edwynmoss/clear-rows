export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "clear-rows-theme";
const LEGACY_STORAGE_KEY = "dataparser-theme";

const listeners = new Set<(dark: boolean) => void>();
let mediaQuery: MediaQueryList | null = null;

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

function applyDark(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  for (const listener of listeners) listener(dark);
}

export function getThemeMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function isDarkTheme(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** Apply the saved mode before first paint. "system" follows the OS live. */
export function initThemeFromStorage(): void {
  mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  mediaQuery?.addEventListener("change", () => {
    if (getThemeMode() === "system") applyDark(systemPrefersDark());
  });
  setThemeMode(getThemeMode(), { persist: false });
}

export function setThemeMode(mode: ThemeMode, options: { persist?: boolean } = {}): void {
  if (options.persist !== false) {
    if (mode === "system") {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, mode);
    }
  }
  applyDark(mode === "system" ? systemPrefersDark() : mode === "dark");
}

/** Cycle light → dark → system. Returns the new mode. */
export function cycleThemeMode(): ThemeMode {
  const next: ThemeMode =
    getThemeMode() === "light" ? "dark" : getThemeMode() === "dark" ? "system" : "light";
  setThemeMode(next);
  return next;
}

export function onThemeChange(listener: (dark: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
