// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { parseFilterQuery } from "../csv/filter-query";
import { createQueryBar } from "./query-bar";

function mount() {
  const handlers = {
    onSubmit: vi.fn(),
    onClear: vi.fn(),
    onCancel: vi.fn(),
    onModeChange: vi.fn(),
    onLimitChange: vi.fn(),
    onPickFiles: vi.fn(),
    onRemoveTerm: vi.fn(),
    onFocusChange: vi.fn(),
    onInput: vi.fn(),
  };
  const bar = createQueryBar({ initialMode: "file", initialLimit: 500, ...handlers });
  document.body.append(bar.root);
  bar.setAvailability({ hasFile: true, searchFileCount: 2, searchFileBytes: 0 });
  return { bar, handlers };
}

function press(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("query bar", () => {
  it("submits the file filter on Enter and clears on Escape", () => {
    const { bar, handlers } = mount();
    bar.input.value = "severity=high";
    press(bar.input, "Enter");
    expect(handlers.onSubmit).toHaveBeenCalledWith("file", "severity=high", 500);
    press(bar.input, "Escape");
    expect(bar.input.value).toBe("");
    expect(handlers.onClear).toHaveBeenCalledWith("file");
  });

  it("keeps separate text per mode and hides filter chips in search mode", () => {
    const { bar } = mount();
    bar.setValue("process:powershell");
    bar.setChips(parseFilterQuery("process:powershell", ["process"]).terms);
    bar.setCount(10, 100);
    const chips = bar.root.querySelector<HTMLElement>(".cr-chips")!;
    const count = bar.root.querySelector<HTMLElement>(".cr-query-count")!;
    expect(chips.hidden).toBe(false);
    expect(count.textContent).toBe("10 of 100");

    bar.setMode("files");
    expect(bar.input.value).toBe("");
    expect(chips.hidden).toBe(true);
    expect(count.hidden).toBe(true);
    bar.input.value = "needle";

    bar.setMode("file");
    expect(bar.input.value).toBe("process:powershell");
    expect(chips.hidden).toBe(false);

    bar.setMode("files");
    expect(bar.input.value).toBe("needle");
  });

  it("removes a chip through its button", () => {
    const { bar, handlers } = mount();
    bar.setChips(parseFilterQuery("a b", ["x"]).terms);
    const buttons = bar.root.querySelectorAll<HTMLButtonElement>(".cr-chip-x");
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    expect(handlers.onRemoveTerm).toHaveBeenCalledWith(1);
  });

  it("disables the input until a file or search set exists", () => {
    const { bar } = mount();
    bar.setAvailability({ hasFile: false, searchFileCount: 0, searchFileBytes: 0 });
    expect(bar.input.disabled).toBe(true);
    bar.setMode("files");
    expect(bar.input.disabled).toBe(true);
    bar.setAvailability({ hasFile: false, searchFileCount: 3, searchFileBytes: 0 });
    expect(bar.input.disabled).toBe(false);
    expect(bar.root.querySelector(".cr-query-files")!.textContent).toBe("3 files");
  });

  it("reports focus and typing to the host", () => {
    const { bar, handlers } = mount();
    bar.input.dispatchEvent(new Event("focus"));
    expect(handlers.onFocusChange).toHaveBeenCalledWith(true, "file");
    bar.input.value = "pow";
    bar.input.dispatchEvent(new Event("input"));
    expect(handlers.onInput).toHaveBeenCalledWith("pow", "file");
  });
});
