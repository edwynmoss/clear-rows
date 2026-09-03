import "./styles/main.css";

import { initThemeFromStorage } from "./app/theme";
import { mountApplication } from "./app/mount-application";
import { generateSampleCsv, registerVirtualFile, setStartupPath } from "./tauri/browser-shim";
import { isDesktopRuntime } from "./tauri/runtime";

initThemeFromStorage();

const root = document.querySelector<HTMLElement>("#app");
if (!root) {
  throw new Error('Missing root element "#app"');
}

if (!isDesktopRuntime()) {
  // Browser preview / web demo: no Rust backend, so seed the in-memory shim
  // with a synthetic endpoint log and open it on start.
  const samplePath = "browser://endpoint-sample.csv";
  registerVirtualFile(samplePath, generateSampleCsv(20_000));
  setStartupPath(samplePath);
}

mountApplication(root);
