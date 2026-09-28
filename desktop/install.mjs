// Builds the release desktop app and copies the exe into a folder, replacing a running copy.
// Usage: npm run desktop:install -- <target folder>
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXE = "agent-board-desktop.exe";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = path.join(root, "desktop", "target", "release", EXE);

const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run desktop:install -- <target folder>");
  process.exit(1);
}
const installed = path.join(path.resolve(target), EXE);

const wasRunning = isRunning();
if (wasRunning) {
  stopApp();
}

console.log("Building the release app");
const build = spawnSync("npx tauri build --no-bundle", { cwd: root, stdio: "inherit", shell: true });
if (build.status !== 0) {
  console.error("Release build failed");
  process.exit(build.status ?? 1);
}

fs.mkdirSync(path.dirname(installed), { recursive: true });
fs.copyFileSync(built, installed);
console.log(`Copied to ${installed}`);

// Launching also points agents at this copy (it rewrites desktop.json on start).
if (wasRunning) {
  spawn(installed, [], { detached: true, stdio: "ignore" }).unref();
  console.log("Restarted the desktop app");
}

function isRunning() {
  const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${EXE}`, "/NH"], { encoding: "utf8" });
  return out.toLowerCase().includes(EXE);
}

/** Ask the window to close first so it saves its layout; force it only if that does not work. */
function stopApp() {
  console.log("Closing the desktop app");
  spawnSync("taskkill", ["/IM", EXE], { stdio: "ignore" });
  if (waitForExit(5000)) {
    return;
  }
  spawnSync("taskkill", ["/IM", EXE, "/F"], { stdio: "ignore" });
  if (!waitForExit(5000)) {
    console.error(`${EXE} is still running; close it and try again`);
    process.exit(1);
  }
}

function waitForExit(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isRunning()) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return !isRunning();
}
