/**
 * Host-specific services: file dialogs, drag-and-drop, app version. The
 * desktop implementation uses Tauri; the browser implementation uses
 * <input type="file"> and HTML5 drop events and registers the chosen files
 * with the in-memory shim so `open_csv` can read them.
 */

import { open as tauriOpen, save as tauriSave } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion } from "@tauri-apps/api/app";

import { registerVirtualFile } from "./browser-shim";
import { isDesktopRuntime } from "./runtime";

const FILE_FILTERS = [
  { name: "Delimited text", extensions: ["csv", "tsv", "txt", "tab", "dat", "log", "gz"] },
  { name: "Compressed (gzip)", extensions: ["gz"] },
];

export type DropHandler = {
  onOver: () => void;
  onLeave: () => void;
  onDrop: (path: string) => void;
};

export async function pickFile(): Promise<string | null> {
  if (isDesktopRuntime()) {
    const selection = await tauriOpen({ multiple: false, filters: FILE_FILTERS });
    return !selection || Array.isArray(selection) ? null : selection;
  }
  const chosen = await browserPick(false);
  return chosen[0] ?? null;
}

export async function pickFiles(): Promise<string[] | null> {
  if (isDesktopRuntime()) {
    const selection = await tauriOpen({ multiple: true, filters: FILE_FILTERS });
    if (!selection) return null;
    return Array.isArray(selection) ? selection : [selection];
  }
  const chosen = await browserPick(true);
  return chosen.length > 0 ? chosen : null;
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (isDesktopRuntime()) {
    return tauriSave({ defaultPath: defaultName, filters: [{ name: "CSV", extensions: ["csv"] }] });
  }
  // Browser downloads go through the shim's blob link; the "path" is just a name.
  return defaultName;
}

export async function appVersion(): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  try {
    return await getVersion();
  } catch {
    return null;
  }
}

export function wireFileDrop(handler: DropHandler): void {
  if (isDesktopRuntime()) {
    void getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "over" || payload.type === "enter") {
        handler.onOver();
        return;
      }
      handler.onLeave();
      if (payload.type !== "drop") return;
      const path = payload.paths.find((candidate) => candidate.length > 0);
      if (path) handler.onDrop(path);
    });
    return;
  }

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    handler.onOver();
  });
  window.addEventListener("dragleave", (event) => {
    if (event.relatedTarget === null) handler.onLeave();
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    handler.onLeave();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    void registerBrowserFile(file).then((path) => handler.onDrop(path));
  });
}

async function browserPick(multiple: boolean): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.accept = ".csv,.tsv,.txt,.tab,.dat,.log,.gz,text/csv,text/plain,application/gzip";
    input.style.display = "none";
    document.body.append(input);
    input.addEventListener("change", async () => {
      const chosen = Array.from(input.files ?? []);
      input.remove();
      const paths: string[] = [];
      for (const file of chosen) paths.push(await registerBrowserFile(file));
      resolve(paths);
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve([]);
    });
    input.click();
  });
}

async function registerBrowserFile(file: File): Promise<string> {
  let bytes = new Uint8Array(await file.arrayBuffer());
  const path = `browser://${file.name}`;
  // gzip in the browser: the same magic check the Rust side makes.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b && typeof DecompressionStream === "function") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    registerVirtualFile(path, bytes, file.size, "gzip");
    return path;
  }
  registerVirtualFile(path, bytes, file.size);
  return path;
}
