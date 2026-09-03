// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { parseFilterQuery } from "../csv/filter-query";
import { buildTerm, createFilterBuilder } from "./filter-builder";

const headers = ["process", "Command Line", "severity"];

describe("buildTerm", () => {
  it("writes the same syntax the grammar reads", () => {
    const cases: Array<[string | null, Parameters<typeof buildTerm>[1], string, string]> = [
      ["process", "contains", "powershell", "process:powershell"],
      ["process", "not-contains", "chrome", "-process:chrome"],
      ["severity", "is", "high", "severity=high"],
      ["severity", "is-not", "low", "-severity=low"],
      ["Command Line", "contains", "-enc AAAA", '"Command Line":"-enc AAAA"'],
      ["process", "regex", "^power", "process:/^power/"],
      ["severity", "empty", "", 'severity=""'],
      ["severity", "not-empty", "", '-severity=""'],
      [null, "contains", "hello world", '"hello world"'],
      [null, "regex", "^WS-00", "/^WS-00/"],
    ];
    for (const [column, condition, value, expected] of cases) {
      const term = buildTerm(column, condition, value);
      expect(term).toBe(expected);
      const parsed = parseFilterQuery(term, headers);
      expect(parsed.error, `grammar rejected ${term}`).toBeNull();
      expect(parsed.terms).toHaveLength(1);
    }
  });

  it("escapes quotes inside values", () => {
    const term = buildTerm("process", "contains", 'say "hi"');
    expect(term).toBe('process:"say ""hi"""');
    expect(parseFilterQuery(term, headers).terms[0].value).toBe('say "hi"');
  });
});

describe("createFilterBuilder", () => {
  function mount() {
    const onAddTerm = vi.fn();
    const onSearchAll = vi.fn();
    const builder = createFilterBuilder({
      headers: () => headers,
      sampleValues: async (index) => (index === 2 ? ["critical", "high", "low"] : null),
      onAddTerm,
      onSearchAll,
    });
    document.body.append(builder.root);
    const anchor = document.createElement("div");
    document.body.append(anchor);
    return { builder, onAddTerm, onSearchAll, anchor };
  }

  it("offers columns and hides column-only conditions for any column", async () => {
    const { builder, anchor } = mount();
    builder.open(anchor, "");
    const columns = builder.root.querySelector<HTMLSelectElement>(".cr-builder-column")!;
    expect(Array.from(columns.options).map((o) => o.textContent)).toEqual(["Any column", ...headers]);
    const conditions = builder.root.querySelector<HTMLSelectElement>(".cr-builder-condition")!;
    const hidden = Array.from(conditions.options).filter((o) => o.disabled).map((o) => o.value);
    expect(hidden).toEqual(["is", "is-not", "empty", "not-empty"]);
    columns.value = "2";
    columns.dispatchEvent(new Event("change"));
    expect(Array.from(conditions.options).every((o) => !o.disabled)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(builder.root.querySelectorAll("datalist option")).toHaveLength(3);
  });

  it("adds a term from the structured row", () => {
    const { builder, onAddTerm, anchor } = mount();
    builder.open(anchor, "");
    const columns = builder.root.querySelector<HTMLSelectElement>(".cr-builder-column")!;
    const conditions = builder.root.querySelector<HTMLSelectElement>(".cr-builder-condition")!;
    const value = builder.root.querySelector<HTMLInputElement>(".cr-builder-value")!;
    columns.value = "2";
    columns.dispatchEvent(new Event("change"));
    conditions.value = "is";
    conditions.dispatchEvent(new Event("change"));
    value.value = "high";
    builder.root.querySelector<HTMLButtonElement>(".cr-btn-primary")!.click();
    expect(onAddTerm).toHaveBeenCalledWith("severity=high", false);
  });

  it("suggests searching everywhere or in one column for typed text", () => {
    const { builder, onAddTerm, onSearchAll, anchor } = mount();
    builder.open(anchor, "mshta");
    const suggestion = builder.root.querySelector<HTMLButtonElement>(".cr-builder-suggestion")!;
    expect(suggestion.textContent).toContain("mshta");
    suggestion.click();
    expect(onSearchAll).toHaveBeenCalledWith("mshta");
    const chip = builder.root.querySelectorAll<HTMLButtonElement>(".cr-builder-colchip")[1];
    chip.click();
    expect(onAddTerm).toHaveBeenCalledWith('"Command Line":mshta', true);
    builder.setTyped("severity=high");
    expect(builder.root.querySelector<HTMLElement>(".cr-builder-suggest")!.hidden).toBe(true);
    // Only the word being typed is offered, earlier words stay as written.
    builder.setTyped("severity=high wsc");
    expect(builder.root.querySelector<HTMLElement>(".cr-builder-suggest")!.hidden).toBe(false);
    expect(builder.root.querySelector<HTMLButtonElement>(".cr-builder-suggestion")!.textContent).toContain("wsc");
  });
});
