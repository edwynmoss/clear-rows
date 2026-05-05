const STORAGE_KEY = "clear-rows-theme";
const LEGACY_STORAGE_KEY = "dataparser-theme";

function applyDarkClass(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
}

/** Apply saved preference before first paint; Clear Rows defaults to dark. */
export function initThemeFromStorage(): void {
  const stored =
    localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);

  const dark = stored === "light" ? false : true;

  applyDarkClass(dark);
}

export function setStoredTheme(dark: boolean): void {
  localStorage.setItem(STORAGE_KEY, dark ? "dark" : "light");
  applyDarkClass(dark);
}

export function toggleStoredTheme(): boolean {
  const next = !document.documentElement.classList.contains("dark");
  setStoredTheme(next);
  return next;
}
