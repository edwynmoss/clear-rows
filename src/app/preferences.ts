import { DEFAULT_SEARCH_LIMIT, SEARCH_LIMIT_OPTIONS } from "./constants";

const STORAGE_KEY = "clear-rows-preferences";
const LEGACY_STORAGE_KEY = "dataparser-preferences";
const MAX_RECENT_SEARCH_PATHS = 50;
const MAX_RECENT_FILES = 12;
const MAX_RECENT_FILTERS_PER_FILE = 8;
const MAX_FILES_WITH_RECENT_FILTERS = 40;

export type RecentFile = {
  path: string;
  openedAt: number;
  rows?: number;
  sizeBytes?: number;
};

type StoredPreferences = {
  searchLimit?: number;
  recentSearchPaths?: string[];
  recentFiles?: RecentFile[];
  searchMode?: "file" | "files";
  /** Recently applied filter queries, newest first, keyed by file path. */
  recentFilters?: Record<string, string[]>;
};

export function getStoredSearchLimit(): number {
  const stored = readPreferences().searchLimit;
  return isSearchLimit(stored) ? stored : DEFAULT_SEARCH_LIMIT;
}

export function storeSearchLimit(limit: number): void {
  if (!isSearchLimit(limit)) return;
  writePreferences({ ...readPreferences(), searchLimit: limit });
}

export function getRecentSearchPaths(): string[] {
  return normalizePaths(readPreferences().recentSearchPaths);
}

export function storeRecentSearchPaths(paths: string[]): void {
  const recentSearchPaths = normalizePaths(paths).slice(0, MAX_RECENT_SEARCH_PATHS);
  writePreferences({ ...readPreferences(), recentSearchPaths });
}

export function getRecentFiles(): RecentFile[] {
  return (readPreferences().recentFiles ?? []).slice(0, MAX_RECENT_FILES);
}

export function rememberRecentFile(entry: Omit<RecentFile, "openedAt">): void {
  const existing = getRecentFiles().filter((item) => item.path !== entry.path);
  const next: RecentFile[] = [{ ...entry, openedAt: Date.now() }, ...existing].slice(0, MAX_RECENT_FILES);
  writePreferences({ ...readPreferences(), recentFiles: next });
}

export function forgetRecentFile(path: string): void {
  const next = getRecentFiles().filter((item) => item.path !== path);
  writePreferences({ ...readPreferences(), recentFiles: next });
}

/** Filters applied to this file before, newest first. */
export function getRecentFilters(path: string): string[] {
  const all = readPreferences().recentFilters ?? {};
  return Array.isArray(all[path]) ? all[path].filter((q) => typeof q === "string" && q.trim().length > 0) : [];
}

export function rememberRecentFilter(path: string, query: string): void {
  const trimmed = query.trim();
  if (!trimmed) return;
  const all = { ...(readPreferences().recentFilters ?? {}) };
  const next = [trimmed, ...getRecentFilters(path).filter((q) => q !== trimmed)].slice(0, MAX_RECENT_FILTERS_PER_FILE);
  // Move this file to the front so the oldest files fall off first.
  delete all[path];
  const entries = [[path, next] as const, ...Object.entries(all)].slice(0, MAX_FILES_WITH_RECENT_FILTERS);
  writePreferences({ ...readPreferences(), recentFilters: Object.fromEntries(entries) });
}

export function forgetRecentFilter(path: string, query: string): void {
  const all = { ...(readPreferences().recentFilters ?? {}) };
  all[path] = getRecentFilters(path).filter((q) => q !== query);
  if (all[path].length === 0) delete all[path];
  writePreferences({ ...readPreferences(), recentFilters: all });
}

export function getStoredSearchMode(): "file" | "files" {
  return readPreferences().searchMode === "files" ? "files" : "file";
}

export function storeSearchMode(mode: "file" | "files"): void {
  writePreferences({ ...readPreferences(), searchMode: mode });
}

function readPreferences(): StoredPreferences {
  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    return {
      searchLimit: typeof parsed.searchLimit === "number" ? parsed.searchLimit : undefined,
      recentSearchPaths: Array.isArray(parsed.recentSearchPaths)
        ? parsed.recentSearchPaths.filter((path): path is string => typeof path === "string")
        : undefined,
      recentFiles: Array.isArray(parsed.recentFiles)
        ? parsed.recentFiles.filter(isRecentFile)
        : undefined,
      searchMode: parsed.searchMode === "files" ? "files" : parsed.searchMode === "file" ? "file" : undefined,
    };
  } catch {
    return {};
  }
}

function writePreferences(preferences: StoredPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Local storage can be unavailable in locked-down WebViews; preferences are best effort.
  }
}

function normalizePaths(paths: string[] | undefined): string[] {
  if (!paths) return [];
  return Array.from(new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0)));
}

function isSearchLimit(value: number | undefined): value is (typeof SEARCH_LIMIT_OPTIONS)[number] {
  return SEARCH_LIMIT_OPTIONS.some((limit) => limit === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRecentFile(value: unknown): value is RecentFile {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.openedAt === "number"
  );
}
