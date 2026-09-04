// Drives the running Clear Rows window over the Chrome DevTools Protocol.
//
// The app must have been launched with WebView2 remote debugging enabled:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
// (scripts/e2e/run.mjs does this for you).
//
// A scenario is a JSON array of steps:
//   {"eval": "js"}                     evaluate in the page; result printed
//   {"expect": "js", "equals": value}  evaluate and assert deep equality
//   {"expect": "js", "matches": "re"}  evaluate and assert the string matches
//   {"keys": "text"}                   insert text at the focused element
//   {"key": "Enter", "mods": 2}        press a key (mods: 1 alt, 2 ctrl, 4 meta, 8 shift)
//   {"click": "css selector"}          click the element's centre
//   {"clickAt": [x, y]}                click page coordinates (CSS px)
//   {"drag": [x1, y1, x2, y2]}         press, move, release
//   {"wait": 800}                      sleep milliseconds
//   {"waitFor": "js", "timeout": 30000} poll until the expression is truthy
//   {"shot": "name"}                   save <outDir>/<name>.png
//   {"open": "file.csv"}               open <outDir>/file.csv through the dev hooks
//
// Console errors and uncaught exceptions are collected and fail the run.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = process.env.CDP_PORT ?? "9222";
const OUT_DIR = process.env.E2E_OUT ?? "e2e-output";
const scenarioPath = process.argv[2];
if (!scenarioPath) {
  console.error("usage: node scripts/e2e/cdp.mjs <scenario.json>");
  process.exit(2);
}
const steps = JSON.parse(readFileSync(scenarioPath, "utf8"));
mkdirSync(OUT_DIR, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === "page" && /localhost:1420/.test(t.url)) ?? targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target on the debugging port");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (message) => {
  const msg = JSON.parse(message.data);
  if (msg.method === "Runtime.exceptionThrown") {
    problems.push("exception: " + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    problems.push("console.error: " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ error: "timeout", method });
      }
    }, 120_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.error) throw new Error(`evaluate timed out: ${expression.slice(0, 80)}`);
  if (res.result?.exceptionDetails) {
    throw new Error("page threw: " + (res.result.exceptionDetails.exception?.description ?? JSON.stringify(res.result.exceptionDetails)));
  }
  return res.result?.result?.value;
}

async function clickAt(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

const KEYS = {
  Enter: { code: "Enter", key: "Enter", windowsVirtualKeyCode: 13 },
  Escape: { code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { code: "Tab", key: "Tab", windowsVirtualKeyCode: 9 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", windowsVirtualKeyCode: 39 },
  PageDown: { code: "PageDown", key: "PageDown", windowsVirtualKeyCode: 34 },
  PageUp: { code: "PageUp", key: "PageUp", windowsVirtualKeyCode: 33 },
};

async function pressKey(name, modifiers = 0) {
  const key = KEYS[name] ?? { code: `Key${name.toUpperCase()}`, key: name, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) };
  await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...key });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...key });
}

async function screenshot(name) {
  const metrics = await send("Page.getLayoutMetrics");
  const size = metrics.result?.cssLayoutViewport ?? { clientWidth: 1280, clientHeight: 800 };
  const res = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: size.clientWidth, height: size.clientHeight, scale: 1 },
    captureBeyondViewport: true,
  });
  writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(res.result.data, "base64"));
}

await send("Page.enable");
await send("Runtime.enable");

// Every scenario starts on the same file, whatever the previous one left open.
if (process.env.E2E_FILE) {
  const file = process.env.E2E_FILE;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await evaluate(
      `(() => { const h = window.__clearRows; if (!h) return "booting"; return h.session.path === ${JSON.stringify(file)} && h.session.rowCount > 0 ? "ready" : "other"; })()`,
    );
    if (state === "ready") break;
    if (state === "other") {
      await evaluate(`window.__clearRows.openPath(${JSON.stringify(file)}).then(() => "opened")`);
    }
    await sleep(500);
  }
}

let failures = 0;
for (const [index, step] of steps.entries()) {
  const label = `step ${index + 1}`;
  try {
    if (step.eval !== undefined) {
      console.log(`${label}: ${JSON.stringify(await evaluate(step.eval))}`);
    } else if (step.expect !== undefined) {
      const value = await evaluate(step.expect);
      if ("equals" in step && JSON.stringify(value) !== JSON.stringify(step.equals)) {
        throw new Error(`expected ${JSON.stringify(step.equals)}, got ${JSON.stringify(value)}`);
      }
      if ("matches" in step && !new RegExp(step.matches).test(String(value))) {
        throw new Error(`expected /${step.matches}/, got ${JSON.stringify(value)}`);
      }
      console.log(`${label}: ok ${JSON.stringify(value).slice(0, 120)}`);
    } else if (step.keys !== undefined) {
      await send("Input.insertText", { text: step.keys });
    } else if (step.key !== undefined) {
      await pressKey(step.key, step.mods ?? 0);
    } else if (step.click !== undefined) {
      const rect = await evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(step.click)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      if (!rect) throw new Error(`no element for ${step.click}`);
      await clickAt(rect.x, rect.y);
    } else if (step.clickAt !== undefined) {
      await clickAt(step.clickAt[0], step.clickAt[1]);
    } else if (step.drag !== undefined) {
      const [x1, y1, x2, y2] = step.drag;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8; i++) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * i) / 8, y: y1 + ((y2 - y1) * i) / 8, button: "left", buttons: 1 });
      }
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 });
    } else if (step.wait !== undefined) {
      await sleep(step.wait);
    } else if (step.waitFor !== undefined) {
      const deadline = Date.now() + (step.timeout ?? 30_000);
      let ok = false;
      while (Date.now() < deadline) {
        if (await evaluate(step.waitFor)) {
          ok = true;
          break;
        }
        await sleep(100);
      }
      if (!ok) throw new Error(`timed out waiting for ${step.waitFor.slice(0, 80)}`);
      console.log(`${label}: ready`);
    } else if (step.shot !== undefined) {
      await screenshot(step.shot);
      console.log(`${label}: shot ${step.shot}`);
    } else if (step.open !== undefined) {
      const target = join(OUT_DIR, step.open);
      await evaluate(`window.__clearRows.openPath(${JSON.stringify(target)}).then(() => 'opened')`);
      console.log(`${label}: opened ${step.open}`);
    }
  } catch (err) {
    failures++;
    console.log(`${label}: FAIL ${err instanceof Error ? err.message : String(err)}`);
    if (step.stopOnFail !== false) break;
  }
}

ws.close();
if (problems.length > 0) {
  console.log("page problems:\n  " + problems.join("\n  "));
}
const ok = failures === 0 && problems.length === 0;
console.log(ok ? "e2e: PASS" : "e2e: FAIL");
process.exit(ok ? 0 : 1);
