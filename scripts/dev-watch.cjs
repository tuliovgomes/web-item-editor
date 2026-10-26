/* Development supervisor: runs the editor server with DEV_RELOAD=1 and restarts it when a file under src/
   changes. Files are polled (stat only) instead of watched, because file-change events from a Windows host do
   not reach a Docker Desktop bind mount. A server that crashes on start is left down until the next change. */
"use strict";
const { spawn } = require("node:child_process");
const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const WATCHED = ["src"];
const INTERVAL_MS = 500;
const TSX_CLI = require.resolve("tsx/cli");

function snapshot() {
  const parts = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && path.endsWith(".ts")) {
        const info = statSync(path);
        parts.push(`${path}:${info.size}:${info.mtimeMs}`);
      }
    }
  };
  for (const directory of WATCHED) walk(directory);
  return parts.sort().join("|");
}

let child = null;
let stopping = false;

function start() {
  child = spawn(process.execPath, [TSX_CLI, "src/server.ts"], {
    stdio: "inherit",
    env: { ...process.env, DEV_RELOAD: "1" },
  });
  child.on("exit", () => { child = null; });
}

function restart() {
  if (!child) return start();
  const current = child;
  const force = setTimeout(() => current.kill("SIGKILL"), 3000);
  current.once("exit", () => {
    clearTimeout(force);
    if (!stopping) start();
  });
  current.kill("SIGTERM");
}

let known = snapshot();
let pending = null;
setInterval(() => {
  let next;
  try {
    next = snapshot();
  } catch {
    return; // a file replaced mid-scan; the next poll sees the settled state
  }
  if (next === known) return;
  // Restart only once the change has settled for one interval (editors often write a file in several steps).
  if (next !== pending) {
    pending = next;
    return;
  }
  known = next;
  pending = null;
  console.log("[dev] código do servidor alterado; reiniciando…");
  restart();
}, INTERVAL_MS);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    if (child) child.once("exit", () => process.exit(0)).kill(signal);
    else process.exit(0);
  });
}

start();
