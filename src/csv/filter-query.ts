/**
 * Display-side mirror of the Rust filter grammar (src-tauri/src/csv/filter/query.rs).
 * Used to render chips for the active filter and to validate column names
 * before a round trip. The Rust side stays the source of truth for matching.
 */

export type FilterOperator = "contains" | "exact" | "regex";

export type FilterTerm = {
  negated: boolean;
  /** Header text the term resolved to, or null for "any column". */
  column: string | null;
  /** Raw column text the user typed (for error messages). */
  columnInput: string | null;
  operator: FilterOperator;
  value: string;
};

export type ParsedFilter = {
  terms: FilterTerm[];
  /** First problem found, as a user-facing sentence, or null. */
  error: string | null;
};

export function parseFilterQuery(input: string, headers: string[]): ParsedFilter {
  let tokens: string[];
  try {
    tokens = tokenize(input);
  } catch (err) {
    return { terms: [], error: err instanceof Error ? err.message : String(err) };
  }

  const terms: FilterTerm[] = [];
  for (const token of tokens) {
    const negated = token.startsWith("-") && token.length > 1;
    const body = negated ? token.slice(1) : token;
    const { column, op, value } = splitColumn(body);

    let resolved: string | null = null;
    if (column !== null) {
      const match = resolveColumn(unquote(column), headers);
      if (match.error) {
        return { terms, error: match.error };
      }
      resolved = match.header;
    }

    if (op === "=") {
      const literal = unquote(value).trim();
      if (literal.length === 0) {
        return { terms, error: "Exact match needs a value after '='." };
      }
      terms.push({ negated, column: resolved, columnInput: column, operator: "exact", value: literal });
      continue;
    }

    const regex = regexBody(value);
    if (regex !== null) {
      try {
        new RegExp(regex, "i");
      } catch (err) {
        return { terms, error: `Invalid regex /${regex}/.` };
      }
      terms.push({ negated, column: resolved, columnInput: column, operator: "regex", value: regex });
      continue;
    }

    const literal = unquote(value);
    if (literal.length === 0) {
      continue;
    }
    terms.push({ negated, column: resolved, columnInput: column, operator: "contains", value: literal });
  }

  return { terms, error: null };
}

export function describeTerm(term: FilterTerm): string {
  const op = term.operator === "exact" ? "=" : term.operator === "regex" ? "~" : "∋";
  const value = term.operator === "regex" ? `/${term.value}/` : term.value;
  const scope = term.column ?? "any";
  return `${term.negated ? "not " : ""}${scope} ${op} ${value}`;
}

/** Raw tokens of a query (quotes and /regex/ kept intact). Throws on unclosed groups. */
export function splitFilterTokens(input: string): string[] {
  return tokenize(input);
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
      continue;
    }
    if (ch === '"') {
      const close = input.indexOf('"', i + 1);
      if (close < 0) throw new Error("Unclosed quote in filter.");
      current += input.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (ch === "/" && (current.length === 0 || current.endsWith(":") || current === "-")) {
      let j = i + 1;
      let escaped = false;
      let closed = false;
      while (j < input.length) {
        const c = input[j];
        if (escaped) {
          escaped = false;
        } else if (c === "\\") {
          escaped = true;
        } else if (c === "/") {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) throw new Error("Unclosed /regex/ in filter.");
      current += input.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function splitColumn(body: string): { column: string | null; op: ":" | "=" | null; value: string } {
  if (body.startsWith('"')) {
    const close = body.indexOf('"', 1);
    if (close > 0) {
      const op = body[close + 1];
      if (op === ":" || op === "=") {
        return { column: body.slice(0, close + 1), op, value: body.slice(close + 2) };
      }
    }
    return { column: null, op: null, value: body };
  }
  if (body.startsWith("/")) {
    return { column: null, op: null, value: body };
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === ":" || ch === "=") {
      if (i === 0) return { column: null, op: null, value: body };
      return { column: body.slice(0, i), op: ch, value: body.slice(i + 1) };
    }
  }
  return { column: null, op: null, value: body };
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function regexBody(value: string): string | null {
  return value.length >= 2 && value.startsWith("/") && value.endsWith("/")
    ? value.slice(1, -1)
    : null;
}

export function normalizeColumnName(name: string): string {
  return name
    .trim()
    .replace(/[\s_-]/g, "")
    .toLowerCase();
}

export function resolveColumn(
  name: string,
  headers: string[],
): { header: string | null; error: string | null } {
  if (name.startsWith("#")) {
    const index = Number.parseInt(name.slice(1), 10);
    if (Number.isInteger(index) && index >= 1 && index <= headers.length) {
      return { header: headers[index - 1], error: null };
    }
    return { header: null, error: `There is no column ${name}; the file has ${headers.length} columns.` };
  }
  const wanted = normalizeColumnName(name);
  if (wanted.length === 0) return { header: null, error: "Column name is empty." };
  const exact = headers.find((h) => normalizeColumnName(h) === wanted);
  if (exact !== undefined) return { header: exact, error: null };
  const prefixed = headers.filter((h) => normalizeColumnName(h).startsWith(wanted));
  if (prefixed.length === 1) return { header: prefixed[0], error: null };
  if (prefixed.length === 0) {
    return { header: null, error: `Unknown column '${name}'.` };
  }
  return { header: null, error: `'${name}' matches several columns: ${prefixed.join(", ")}.` };
}
