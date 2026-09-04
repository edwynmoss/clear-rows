// Launches the desktop app in dev mode with remote debugging, runs every
// scenario under scripts/e2e/scenarios (or the ones passed as arguments),
// and shuts the app down again.
//
//   npm run e2e                       all scenarios, synthetic sample file
//   npm run e2e -- smoke              one scenario
//   E2E_FILE=path\to\big.csv npm run e2e

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const scenariosDir = join(here, "scenarios");
const outDir = process.env.E2E_OUT ?? join(repo, "e2e-output");
const port = process.env.CDP_PORT ?? "9222";
mkdirSync(outDir, { recursive: true });

const requested = process.argv.slice(2);
const scenarios = (requested.length > 0 ? requested.map((name) => (name.endsWith(".json") ? name : `${name}.json`)) : readdirSync(scenariosDir).filter((f) => f.endsWith(".json"))).map((f) =>
  join(scenariosDir, f),
);

const sampleFile = process.env.E2E_FILE ?? ensureSampleFile();

// A leftover instance from an aborted run keeps the debugging port, and the
// driver would then talk to the old app instead of the one launched below.
stopLeftovers();
await waitForPortFree(port, 15_000);

console.log(`launching app with ${sampleFile}`);
const app = spawn("npm", ["run", "tauri", "dev"], {
  cwd: repo,
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    CLEAR_ROWS_OPEN_CSV: sampleFile,
  },
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.warn(`port ${port} is still in use; the driver may attach to the wrong app`);
  return false;
}

async function waitForDebugger(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === "page" && /localhost:1420/.test(t.url))) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

let exitCode = 1;
try {
  if (!(await waitForDebugger(10 * 60 * 1000))) {
    throw new Error("app did not expose the debugging port in time\n" + appLog.slice(-2000));
  }
  await new Promise((resolve) => setTimeout(resolve, 4000));
  let failed = 0;
  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario}`);
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(here, "cdp.mjs"), scenario], {
        cwd: repo,
        stdio: "inherit",
        env: { ...process.env, CDP_PORT: port, E2E_OUT: outDir, E2E_FILE: sampleFile },
      });
      child.on("exit", (c) => resolve(c ?? 1));
    });
    if (code !== 0) failed++;
  }
  exitCode = failed === 0 ? 0 : 1;
  console.log(`\n${scenarios.length - failed} of ${scenarios.length} scenarios passed; screenshots in ${outDir}`);
  if (failed > 0) console.log("\napp output (tail):\n" + appLog.split(/\r?\n/).slice(-40).join("\n"));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
} finally {
  stopApp();
}
process.exit(exitCode);

function stopLeftovers() {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/im", "clear-rows.exe", "/f", "/t"], { stdio: "ignore", shell: true });
  } else {
    spawnSync("pkill", ["-x", "clear-rows"], { stdio: "ignore" });
  }
}

function stopApp() {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(app.pid), "/t", "/f"], { stdio: "ignore", shell: true });
    spawn("taskkill", ["/im", "clear-rows.exe", "/f"], { stdio: "ignore", shell: true });
  } else {
    app.kill("SIGTERM");
  }
}

function ensureSampleFile() {
  const path = join(outDir, "sample-20k.csv");
  const headerless = join(outDir, "sample-headerless.csv");
  if (existsSync(path) && existsSync(headerless)) return path;
  const procs = ["powershell.exe", "cmd.exe", "svchost.exe", "chrome.exe", "rundll32.exe", "mshta.exe", "wscript.exe", "explorer.exe", "teams.exe", "outlook.exe"];
  const severities = ["low", "low", "medium", "high", "critical"];
  const countries = ["ZA", "US", "DE", "NL", "BR"];
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
  const lines = ["timestamp,hostname,username,process,command_line,parent,sha256,severity,country"];
  let t = Date.UTC(2026, 7, 1);
  for (let i = 0; i < 20_000; i++) {
    t += Math.floor(rand() * 40_000) + 1000;
    const p = pick(procs);
    const cmd = p === "powershell.exe" ? `${p} -enc ${hex(16)}` : `${p} /c echo ${i}`;
    lines.push([new Date(t).toISOString().slice(0, 19), `WS-${String(Math.floor(rand() * 4000)).padStart(5, "0")}`, `user${Math.floor(rand() * 900)}`, p, cmd, pick(procs), hex(64), pick(severities), pick(countries)].join(","));
  }
  writeFileSync(path, lines.join("\n") + "\n");
  // Same rows without the header, for the "first row is data" scenario.
  writeFileSync(headerless, lines.slice(1).join("\n") + "\n");
  return path;
}
