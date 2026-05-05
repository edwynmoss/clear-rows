import "./styles/main.css";

import { initThemeFromStorage } from "./app/theme";
import { mountApplication } from "./app/mount-application";

initThemeFromStorage();

const root = document.querySelector<HTMLElement>("#app");
if (!root) {
  throw new Error('Missing root element "#app"');
}

mountApplication(root);
