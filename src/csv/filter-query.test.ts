import { describe, expect, it } from "vitest";

import { describeTerm, parseFilterQuery, resolveColumn, splitFilterTokens } from "./filter-query";

const headers = ["timestamp", "hostname", "process", "command_line", "severity"];

describe("parseFilterQuery", () => {
  it("parses bare words as any-column contains", () => {
    const parsed = parseFilterQuery("powershell", headers);
    expect(parsed.error).toBeNull();
    expect(parsed.terms).toEqual([
      { negated: false, column: null, columnInput: null, operator: "contains", value: "powershell" },
    ]);
  });

  it("parses column scoped, exact, regex and negated terms", () => {
    const parsed = parseFilterQuery('process:powershell severity=high -user:svc command_line:/-enc\\s+[a-z]+/ "a phrase"', [
      ...headers,
      "user",
    ]);
    expect(parsed.error).toBeNull();
    expect(parsed.terms.map((t) => [t.negated, t.column, t.operator, t.value])).toEqual([
      [false, "process", "contains", "powershell"],
      [false, "severity", "exact", "high"],
      [true, "user", "contains", "svc"],
      [false, "command_line", "regex", "-enc\\s+[a-z]+"],
      [false, null, "contains", "a phrase"],
    ]);
  });

  it("resolves forgiving column names and positions", () => {
    expect(resolveColumn("Command Line", headers).header).toBe("command_line");
    expect(resolveColumn("command-line", headers).header).toBe("command_line");
    expect(resolveColumn("host", headers).header).toBe("hostname");
    expect(resolveColumn("#5", headers).header).toBe("severity");
    expect(resolveColumn("#9", headers).error).toMatch(/no column/);
    expect(resolveColumn("nope", headers).error).toMatch(/Unknown column/);
  });

  it("reports the first problem as a sentence", () => {
    expect(parseFilterQuery("nope:x", headers).error).toMatch(/Unknown column 'nope'/);
    expect(parseFilterQuery('"unclosed', headers).error).toMatch(/Unclosed quote/);
    expect(parseFilterQuery("/[/", headers).error).toMatch(/Invalid regex/);
    expect(parseFilterQuery("severity=", headers).error).toMatch(/needs a value/);
  });

  it("ignores empty terms and whitespace", () => {
    expect(parseFilterQuery("   ", headers).terms).toEqual([]);
    expect(parseFilterQuery("process:", headers).terms).toEqual([]);
  });
});

describe("splitFilterTokens", () => {
  it("keeps quoted phrases and regexes intact", () => {
    expect(splitFilterTokens('a "b c" d:/x y/ -e')).toEqual(["a", '"b c"', "d:/x y/", "-e"]);
  });
});

describe("describeTerm", () => {
  it("renders a readable label", () => {
    const parsed = parseFilterQuery("-severity=low", headers);
    expect(describeTerm(parsed.terms[0])).toBe("not severity = low");
  });
});
