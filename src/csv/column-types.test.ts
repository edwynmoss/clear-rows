import { describe, expect, it } from "vitest";

import { columnTypeLabel, detectColumnType, parseDateTime, parseNumber } from "./column-types";

describe("parseNumber", () => {
  it("reads separators, currency marks and exponents like the Rust side", () => {
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber("1 234 567")).toBe(1_234_567);
    expect(parseNumber("R 1 200,50")).toBe(1200.5);
    expect(parseNumber("1,5")).toBe(1.5);
    expect(parseNumber("12,345")).toBe(12345);
    expect(parseNumber("$-3.25")).toBe(-3.25);
    expect(parseNumber("(42)")).toBe(-42);
    expect(parseNumber("99%")).toBe(99);
    expect(parseNumber("1e5")).toBe(100_000);
    expect(parseNumber("1.23E+15")).toBe(1.23e15);
    expect(parseNumber("10 kg")).toBe(10);
    expect(parseNumber("ZAR 500")).toBe(500);
    expect(parseNumber("$5")).toBe(5);
  });

  it("rejects identifiers, dates and words", () => {
    for (const text of ["2026-08-01", "1.2.3", "inf", "NaN", "WS-00017", "user826", "10ms", "abc", "", "e93038669ec55c98"]) {
      expect(parseNumber(text), text).toBeNull();
    }
  });
});

describe("parseDateTime", () => {
  const base = Date.UTC(2026, 7, 1);
  it("agrees across layouts", () => {
    for (const text of ["2026-08-01", "2026/08/01", "01/08/2026", "1-8-2026", "01 Aug 2026", "1 August 2026", "Aug 1, 2026", "Sat, 01 Aug 2026"]) {
      expect(parseDateTime(text, "day-first")?.millis, text).toBe(base);
    }
    expect(parseDateTime("08/01/2026", "month-first")?.millis).toBe(base);
    expect(parseDateTime("13/08/2026", "month-first")?.millis).toBe(Date.UTC(2026, 7, 13));
  });

  it("handles times, zones and fractions", () => {
    expect(parseDateTime("2026-08-01T00:00:15", "day-first")).toEqual({ millis: base + 15_000, hadTime: true });
    expect(parseDateTime("2026-08-01T10:30:00.250Z", "day-first")?.millis).toBe(base + 10 * 3_600_000 + 30 * 60_000 + 250);
    expect(parseDateTime("2026-08-01T12:00:00+02:00", "day-first")?.millis).toBe(base + 10 * 3_600_000);
    expect(parseDateTime("01/08/2026 1:05 pm", "day-first")?.millis).toBe(base + 13 * 3_600_000 + 5 * 60_000);
    expect(parseDateTime("2026-02-30", "day-first")).toBeNull();
    expect(parseDateTime("1347445", "day-first")).toBeNull();
  });
});

describe("detectColumnType", () => {
  it("types columns from samples", () => {
    expect(detectColumnType(["1", "2", "", "3"]).type).toBe("integer");
    expect(detectColumnType(["1.5", "2", "3.25"]).type).toBe("decimal");
    expect(detectColumnType(["2026-08-01", "2026-08-02"]).type).toBe("date");
    expect(detectColumnType(["2026-08-01T00:00:15", "2026-08-02T01:00:00"]).type).toBe("datetime");
    expect(detectColumnType(["cmd.exe", "1", "chrome.exe"]).type).toBe("text");
    expect(detectColumnType(["1", "2", "n/a", "4", "5"]).type).toBe("integer");
    expect(detectColumnType(["", ""]).type).toBe("empty");
    expect(detectColumnType(["03/04/2026", "04/25/2026"]).date_order).toBe("month-first");
  });

  it("labels types for people", () => {
    expect(columnTypeLabel("integer")).toBe("Number");
    expect(columnTypeLabel("datetime")).toBe("Date and time");
    expect(columnTypeLabel(undefined)).toBe("Text");
  });
});
