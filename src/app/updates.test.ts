import { beforeEach, describe, expect, it, vi } from "vitest";

// The updater reaches for two things at call time: whether this is the
// desktop build, and the Tauri plugin itself. Both are mocked so the three
// outcomes can be told apart without a running app.
const isDesktopRuntime = vi.fn();
const check = vi.fn();

vi.mock("../tauri/runtime", () => ({ isDesktopRuntime: () => isDesktopRuntime() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...args: unknown[]) => check(...args) }));

async function checkForUpdate() {
  const mod = await import("./updates");
  return mod.checkForUpdate();
}

describe("checkForUpdate", () => {
  beforeEach(() => {
    vi.resetModules();
    isDesktopRuntime.mockReset();
    check.mockReset();
  });

  it("reports an available update with its version and notes", async () => {
    isDesktopRuntime.mockReturnValue(true);
    check.mockResolvedValue({ version: "1.2.0", currentVersion: "1.1.1", body: "Faster opening." });
    const result = await checkForUpdate();
    expect(result.kind).toBe("update");
    if (result.kind !== "update") return;
    expect(result.info).toEqual({ version: "1.2.0", currentVersion: "1.1.1", notes: "Faster opening." });
  });

  it("reports being up to date when the manifest says so", async () => {
    isDesktopRuntime.mockReturnValue(true);
    check.mockResolvedValue(null);
    expect((await checkForUpdate()).kind).toBe("current");
  });

  // The one that matters: a check that could not happen must not be
  // mistaken for a check that found nothing. Reporting "up to date" when
  // the manifest is missing or the signature fails hides a broken update
  // path from everyone, including whoever published it.
  it("separates a failed check from being up to date", async () => {
    isDesktopRuntime.mockReturnValue(true);
    check.mockRejectedValue(new Error("Could not fetch a valid release JSON: 404 Not Found"));
    const result = await checkForUpdate();
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toContain("404");
  });

  it("gives a reason even when the failure carries no message", async () => {
    isDesktopRuntime.mockReturnValue(true);
    check.mockRejectedValue(new Error(""));
    const result = await checkForUpdate();
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("trims a very long reason so it fits under a toast", async () => {
    isDesktopRuntime.mockReturnValue(true);
    check.mockRejectedValue(new Error("x".repeat(500)));
    const result = await checkForUpdate();
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason.length).toBeLessThanOrEqual(160);
    expect(result.reason.endsWith("...")).toBe(true);
  });

  it("says nothing is checkable in the browser preview", async () => {
    isDesktopRuntime.mockReturnValue(false);
    expect((await checkForUpdate()).kind).toBe("unsupported");
    expect(check).not.toHaveBeenCalled();
  });
});
