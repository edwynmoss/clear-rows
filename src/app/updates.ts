/**
 * In-app updates. The desktop build asks GitHub Releases for `latest.json`
 * (published by the release workflow, signed with the project key), offers
 * the new version in a toast, downloads it with progress in the status bar
 * and restarts into it. The browser preview has no updater and stays quiet.
 */
import { isDesktopRuntime } from "../tauri/runtime";

export type UpdateInfo = {
  version: string;
  currentVersion: string;
  /** Release notes as published, may be empty. */
  notes: string;
};

export type UpdateProgress = {
  /** 0..1 when the total size is known, otherwise null. */
  ratio: number | null;
  downloaded: number;
  total: number | null;
};

type Update = {
  version: string;
  currentVersion: string;
  body?: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
};

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

let pending: Update | null = null;

/**
 * The outcome of one check. Being up to date and being unable to ask are
 * different things: for a while both were reported the same way, and asking
 * for updates while the manifest was unreachable answered "you are up to
 * date", which is a claim the app had not established. A check that could
 * not happen now says so.
 */
export type UpdateCheck =
  | { kind: "update"; info: UpdateInfo }
  | { kind: "current" }
  | { kind: "unavailable"; reason: string }
  /** Not the desktop build, so there is nothing to check. */
  | { kind: "unsupported" };

/** Check once. Never throws: the caller decides what is worth saying. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!isDesktopRuntime()) return { kind: "unsupported" };
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: 8_000 });
    if (!update) return { kind: "current" };
    pending = update;
    return { kind: "update", info: { version: update.version, currentVersion: update.currentVersion, notes: update.body ?? "" } };
  } catch (err) {
    // Offline, no manifest published, or a signature that did not verify.
    return { kind: "unavailable", reason: describe(err) };
  }
}

/** A short reason, for the line under a toast. */
function describe(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? "");
  const trimmed = text.trim();
  if (!trimmed) return "The update service could not be reached.";
  return trimmed.length > 160 ? `${trimmed.slice(0, 157).trimEnd()}...` : trimmed;
}

/** Download the pending update, then relaunch into it. Rejects on failure. */
export async function installPendingUpdate(onProgress: (progress: UpdateProgress) => void): Promise<void> {
  if (!pending) throw new Error("No update is pending");
  let total: number | null = null;
  let downloaded = 0;
  await pending.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      downloaded = 0;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
    }
    onProgress({ ratio: total ? Math.min(1, downloaded / total) : null, downloaded, total });
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
