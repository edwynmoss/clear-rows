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

/** Check once; resolves to null when up to date, not on desktop, or offline. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isDesktopRuntime()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: 8_000 });
    if (!update) return null;
    pending = update;
    return { version: update.version, currentVersion: update.currentVersion, notes: update.body ?? "" };
  } catch {
    // No network, no manifest yet, or a signature mismatch: never bother the user.
    return null;
  }
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
