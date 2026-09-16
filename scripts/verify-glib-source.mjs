// Ensure the Linux application resolves the same GLib source tested by the security job.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(execFileSync("cargo", [
  "metadata", "--manifest-path", "src-tauri/Cargo.toml", "--locked",
  "--format-version", "1", "--filter-platform", "x86_64-unknown-linux-gnu",
], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));

const glib = metadata.packages.filter((pkg) => pkg.name === "glib");
assert.equal(glib.length, 1, "Expected exactly one GLib version in the Linux dependency graph");
assert.equal(glib[0].source, null, "Linux must not resolve the vulnerable registry GLib crate");
assert.equal(resolve(glib[0].manifest_path), resolve(root, "src-tauri/vendor/glib/Cargo.toml"));
assert.ok(metadata.resolve.nodes.some((node) => node.id === glib[0].id), "Patched GLib must be in the resolved graph");
console.log(`Linux resolves GLib ${glib[0].version} from the maintained local security backport.`);
