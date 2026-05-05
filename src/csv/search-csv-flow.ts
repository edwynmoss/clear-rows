import { open } from "@tauri-apps/plugin-dialog";

import { requireDesktopRuntime } from "../tauri/runtime";

export async function pickCsvSearchPaths(): Promise<string[] | null> {
  requireDesktopRuntime("Selecting search files requires the desktop runtime");

  const selection = await open({
    multiple: true,
    filters: [{ name: "Delimited text", extensions: ["csv", "tsv", "txt"] }],
  });

  if (selection === null) {
    return null;
  }

  if (Array.isArray(selection)) {
    return selection;
  }

  return [selection];
}
