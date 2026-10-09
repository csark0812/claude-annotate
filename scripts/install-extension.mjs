#!/usr/bin/env node
// Sets up the Claude Annotate Chrome extension on this machine:
//  1. copies server/overlay.js into extension/ (the extension mounts the same overlay)
//  2. writes a launcher for the native messaging host with this node's absolute path
//     (Chrome starts hosts with a bare PATH, where `node` is often missing)
//  3. registers the host with every installed Chrome-family browser, allowed for this extension only
// Run it again after overlay.js changes, then reload the extension in chrome://extensions.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "com.claude_annotate.host";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(root, "extension");
const home = os.homedir();

// Chrome derives an unpacked extension's id from the manifest key: sha256 of the DER public key,
// first 32 hex digits, each mapped 0-f → a-p.
function extensionId() {
  const { key } = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  const hex = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

// The `node` on PATH (e.g. /opt/homebrew/bin/node) survives upgrades; process.execPath may be a
// versioned Cellar path that does not.
function stableNode() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "node");
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  return process.execPath;
}

function browserDirs() {
  const mac = path.join(home, "Library", "Application Support");
  const linux = path.join(home, ".config");
  const candidates = process.platform === "darwin"
    ? ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Arc/User Data"].map((d) => path.join(mac, d))
    : ["google-chrome", "google-chrome-beta", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"].map((d) => path.join(linux, d));
  return candidates.filter((d) => fs.existsSync(d));
}

fs.copyFileSync(path.join(root, "server", "overlay.js"), path.join(extDir, "overlay.js"));

const launcherDir = path.join(home, ".cache", "claude-annotate");
fs.mkdirSync(launcherDir, { recursive: true });
const launcher = path.join(launcherDir, "native-host");
fs.writeFileSync(launcher, `#!/bin/sh\nexec "${stableNode()}" "${path.join(extDir, "host", "host.mjs")}" "$@"\n`, { mode: 0o755 });

const id = extensionId();
const manifest = { name: HOST, description: "Lists Claude Code annotate sessions for the Claude Annotate extension", path: launcher, type: "stdio", allowed_origins: [`chrome-extension://${id}/`] };
const dirs = browserDirs();
for (const dir of dirs) {
  const hostsDir = path.join(dir, "NativeMessagingHosts");
  fs.mkdirSync(hostsDir, { recursive: true });
  fs.writeFileSync(path.join(hostsDir, `${HOST}.json`), JSON.stringify(manifest, null, 2) + "\n");
}

console.log(`overlay copied to extension/overlay.js
native host launcher: ${launcher}
host registered for: ${dirs.length ? dirs.map((d) => path.relative(home, d)).join(", ") : "no Chrome-family browser found"}
extension id: ${id}

Next, once: chrome://extensions → Developer mode on → Load unpacked → ${extDir}
After later runs: click the reload icon on the Claude Annotate card.`);
