export function formatInt(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function directoryOf(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : "";
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatInt(count)} ${count === 1 ? singular : plural}`;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString();
}

const ENCODING_LABELS: Record<string, string> = {
  "utf-8": "UTF-8",
  "utf-8-bom": "UTF-8 with BOM",
  "utf-8-lossy": "UTF-8 (lossy)",
  "utf-16-le": "UTF-16 LE",
  "utf-16-be": "UTF-16 BE",
  "windows-1252": "Windows-1252",
  "iso-8859-1": "ISO-8859-1",
  "iso-8859-15": "ISO-8859-15",
  "windows-1250": "Windows-1250",
  "windows-1251": "Windows-1251",
  "koi8-r": "KOI8-R",
  shift_jis: "Shift_JIS",
  "euc-jp": "EUC-JP",
  gbk: "GBK",
  gb18030: "GB18030",
  big5: "Big5",
  "euc-kr": "EUC-KR",
  macintosh: "Mac Roman",
};

export function formatEncoding(encoding: string): string {
  return ENCODING_LABELS[encoding] ?? encoding;
}

export function formatDelimiter(label: string | null | undefined): string {
  if (!label) return "";
  return label;
}
