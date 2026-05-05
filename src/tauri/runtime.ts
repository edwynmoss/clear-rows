import { isTauri } from "@tauri-apps/api/core";

const DESKTOP_RUNTIME_MESSAGE =
  "This action is available when Clear Rows is running as the desktop app.";

export function isDesktopRuntime(): boolean {
  return isTauri();
}

export function requireDesktopRuntime(action: string): void {
  if (isDesktopRuntime()) {
    return;
  }

  throw new Error(`${action}. ${DESKTOP_RUNTIME_MESSAGE}`);
}
