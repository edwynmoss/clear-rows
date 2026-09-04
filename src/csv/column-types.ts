/**
 * Column typing for the browser preview, mirroring src-tauri/src/csv/types.rs
 * closely enough that the demo behaves like the app: lenient numbers, the
 * common date layouts, 80% agreement to earn a type.
 */

export type ColumnType = "text" | "integer" | "decimal" | "date" | "datetime" | "empty";
export type DateOrder = "day-first" | "month-first";
export type ColumnProfile = { type: ColumnType; date_order: DateOrder };

const TYPE_RATIO = 0.8;

/** User-facing name for a column type. */
export function columnTypeLabel(type: ColumnType | undefined): string {
  switch (type) {
    case "integer":
      return "Number";
    case "decimal":
      return "Decimal";
    case "date":
      return "Date";
    case "datetime":
      return "Date and time";
    case "empty":
      return "Empty";
    default:
      return "Text";
  }
}

export function detectColumnType(values: Iterable<string>): ColumnProfile {
  let nonEmpty = 0;
  let integers = 0;
  let decimals = 0;
  let dates = 0;
  let dateTimes = 0;
  let dayFirst = 0;
  let monthFirst = 0;
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    nonEmpty++;
    const number = parseNumber(value);
    if (number !== null) {
      if (Number.isInteger(number) && !/[.eE]/.test(value)) integers++;
      else decimals++;
      continue;
    }
    const date = parseDateTime(value, "day-first");
    if (date) {
      if (date.hadTime) dateTimes++;
      else dates++;
      const pair = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{4}/.exec(value);
      if (pair) {
        if (Number(pair[1]) > 12) dayFirst++;
        else if (Number(pair[2]) > 12) monthFirst++;
      }
    }
  }
  const date_order: DateOrder = monthFirst > dayFirst ? "month-first" : "day-first";
  if (nonEmpty === 0) return { type: "empty", date_order };
  const threshold = nonEmpty * TYPE_RATIO;
  let type: ColumnType = "text";
  if (integers + decimals >= threshold) type = decimals === 0 ? "integer" : "decimal";
  else if (dates + dateTimes >= threshold) type = dateTimes > 0 ? "datetime" : "date";
  return { type, date_order };
}

export function parseNumber(value: string): number | null {
  let s = value.trim();
  if (!s || s.length > 64) return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Currency or unit marks on either side: anything that is not part of a number.
  const keep = (c: string) => /[0-9.,+-]/.test(c);
  let start = 0;
  let end = s.length;
  while (start < end && !keep(s[start])) start++;
  while (end > start && !keep(s[end - 1])) end--;
  let core = s.slice(start, end).replace(/[+-]+$/, "");
  if (!core || !/\d/.test(core)) return null;
  const prefix = s.slice(0, start);
  const suffix = s.slice(start + core.length);
  // Letters glued to the digits make an identifier (user826, 10ms); a unit or
  // currency word needs a space (R 1 200, 10 kg). Symbols may touch ($5, 5%).
  if (/[A-Za-z0-9]$/.test(prefix) || /^[A-Za-z0-9]/.test(suffix)) return null;
  // Unit or currency marks are short; a long word around a number is a label.
  if (prefix.trim().length > 4 || suffix.trim().length > 4) return null;

  const hasDot = core.includes(".");
  const commas = (core.match(/,/g) ?? []).length;
  const after = core.slice(core.lastIndexOf(",") + 1);
  const commaIsDecimal = !hasDot && commas === 1 && !/^\d{3}$/.test(after);
  let cleaned = "";
  let previous = "";
  for (let i = 0; i < core.length; i++) {
    const c = core[i];
    if (/[0-9.]/.test(c)) cleaned += c;
    else if ((c === "+" || c === "-") && (i === 0 || previous === "e")) cleaned += c;
    else if ((c === "e" || c === "E") && cleaned && !cleaned.includes("e")) cleaned += "e";
    else if (c === "-") return null;
    else if (c === ",") cleaned += commaIsDecimal ? "." : "";
    else if (c === " " || c === "\u00a0" || c === "'" || c === "_") continue;
    else return null;
    previous = c === "E" ? "e" : c;
  }
  if (!/\d/.test(cleaned) || (cleaned.match(/\./g) ?? []).length > 1) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthFromName(name: string): number | null {
  const lower = name.toLowerCase();
  const index = MONTHS.findIndex((full) => full.startsWith(lower) && (lower.length === 3 || full === lower));
  return index >= 0 ? index + 1 : null;
}

/** Milliseconds since the epoch, or null. */
export function parseDateTime(value: string, order: DateOrder): { millis: number; hadTime: boolean } | null {
  let s = value.trim();
  if (s.length < 6 || s.length > 40) return null;
  s = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*[,\s]+/i, "");

  let year: number;
  let month: number;
  let day: number;
  let rest: string;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(.*)$/.exec(s))) {
    year = Number(m[1]);
    month = Number(m[3]);
    day = Number(m[4]);
    rest = m[5];
  } else if ((m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})(.*)$/.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    year = Number(m[4]);
    [day, month] = order === "day-first" ? [a, b] : [b, a];
    if (month > 12 && day <= 12) [day, month] = [month, day];
    rest = m[5];
  } else if ((m = /^(\d{1,2}) ([A-Za-z]{3,})\.?[,\s]+(\d{4})(.*)$/.exec(s))) {
    day = Number(m[1]);
    const named = monthFromName(m[2]);
    if (!named) return null;
    month = named;
    year = Number(m[3]);
    rest = m[4];
  } else if ((m = /^([A-Za-z]{3,})\.? (\d{1,2})[,\s]+(\d{4})(.*)$/.exec(s))) {
    const named = monthFromName(m[1]);
    if (!named) return null;
    month = named;
    day = Number(m[2]);
    year = Number(m[3]);
    rest = m[4];
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;

  rest = rest.replace(/^[Tt ,]+/, "");
  let hour = 0;
  let minute = 0;
  let second = 0;
  let millis = 0;
  let offset = 0;
  let hadTime = false;
  if (rest) {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(am|pm)?\s*(z|utc|gmt|[+-]\d{2}:?\d{2}|[+-]\d{1,2})?$/i.exec(rest);
    if (!t) return null;
    hadTime = true;
    hour = Number(t[1]);
    minute = Number(t[2]);
    second = t[3] ? Number(t[3]) : 0;
    millis = t[4] ? Number(t[4].slice(0, 3).padEnd(3, "0")) : 0;
    const ampm = t[5]?.toLowerCase();
    if (ampm === "am" && hour === 12) hour = 0;
    if (ampm === "pm" && hour < 12) hour += 12;
    const zone = t[6]?.toLowerCase();
    if (zone && !["z", "utc", "gmt"].includes(zone)) {
      const sign = zone.startsWith("-") ? -1 : 1;
      const digits = zone.slice(1).replace(":", "");
      const oh = Number(digits.length > 2 ? digits.slice(0, 2) : digits);
      const om = digits.length > 2 ? Number(digits.slice(2)) : 0;
      offset = sign * (oh * 60 + om);
    }
    if (hour > 23 || minute > 59 || second > 60) return null;
  }
  const base = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  return { millis: base - offset * 60_000, hadTime };
}
