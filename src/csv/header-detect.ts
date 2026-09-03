/**
 * Browser-shim mirror of src-tauri/src/csv/header.rs: decide whether the
 * first row of a file names the columns or is already data. Same votes,
 * same tie-break (keep the header), so the web demo behaves like the app.
 */

export type HeaderMode = "auto" | "header" | "data";

export function syntheticHeaders(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Column ${i + 1}`);
}

export const HEADER_SAMPLE_ROWS = 32;

export function detectHeader(rows: string[][]): boolean {
  const first = rows[0];
  if (!first) return true;
  const sample = rows.slice(1);
  if (sample.length === 0) return true;

  let headerVotes = 0;
  let dataVotes = 0;

  first.forEach((raw, column) => {
    const cell = raw.trim();
    const columnCells = sample
      .map((row) => row[column])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (cell.length === 0) {
      if (columnCells.length > 0) dataVotes += 1;
      return;
    }
    if (isNumeric(cell) || isDateLike(cell) || isEmailLike(cell)) {
      dataVotes += 2;
      return;
    }
    if (columnCells.length === 0) return;

    const numeric = columnCells.filter(isNumeric).length;
    if (numeric * 5 >= columnCells.length * 4) {
      headerVotes += 2;
      return;
    }

    const widths = columnCells.map((value) => [...value].length);
    const fixedWidth = widths.length >= 3 && widths.every((w) => w === widths[0]);
    if (fixedWidth) {
      if ([...cell].length === widths[0]) dataVotes += 1;
      else headerVotes += 1;
    }
  });

  const seen = new Set<string>();
  const duplicated = first
    .map((cell) => cell.trim().toLowerCase())
    .filter((cell) => cell.length > 0)
    .some((cell) => {
      if (seen.has(cell)) return true;
      seen.add(cell);
      return false;
    });
  if (duplicated) dataVotes += 2;

  return headerVotes >= dataVotes;
}

function isNumeric(value: string): boolean {
  const cleaned = value.replace(/[\s,_ ]/g, "");
  if (cleaned.length === 0) return false;
  const body = cleaned.replace(/^[+-]/, "");
  if (body.length === 0) return false;
  return /^[0-9.]+$/.test(body) && /[0-9]/.test(body) && (body.match(/\./g)?.length ?? 0) <= 1;
}

function isDateLike(value: string): boolean {
  return /^\d{4}[-/.]\d{2}[-/.]\d{2}/.test(value) || /^\d{2}[-/.]\d{2}[-/.]\d{4}/.test(value);
}

function isEmailLike(value: string): boolean {
  const at = value.indexOf("@");
  return at > 0 && value.slice(at + 1).includes(".") && !value.includes(" ");
}
