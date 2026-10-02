// Builds the release desktop app and copies the exe into a folder, replacing a running copy.
// Usage: npm run desktop:install -- <target folder>
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXE = "scribe.exe";
const PREVIOUS_EXES = ["agent-board-desktop.exe", "board.exe"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = path.join(root, "desktop", "target", "release", EXE);
const tauriJs = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const cargoBin = path.join(os.homedir(), ".cargo", "bin");

const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run desktop:install -- <target folder>");
  process.exit(1);
}
const installed = path.join(path.resolve(target), EXE);

const env = envWithCargo();
if (!fs.existsSync(tauriJs)) {
  console.error("The Tauri CLI is not installed (missing node_modules/@tauri-apps/cli).");
  console.error("Run npm install in this repo, then retry.");
  process.exit(1);
}
if (!commandExists("cargo", env)) {
  console.error("cargo was not found. The desktop app is a Rust/Tauri binary; npm install does not install Rust.");
  console.error("Install a toolchain from https://rustup.rs/ (Windows: MSVC, plus Visual Studio C++ build tools), then retry.");
  process.exit(1);
}

const wasRunning = isRunning();
if (wasRunning) {
  stopApp();
}

console.log("Building the release app");
const build = spawnSync(process.execPath, [tauriJs, "build", "--no-bundle"], { cwd: root, stdio: "inherit", env });
if (build.status !== 0) {
  console.error("Release build failed");
  process.exit(build.status ?? 1);
}

fs.mkdirSync(path.dirname(installed), { recursive: true });
fs.copyFileSync(built, installed);
for (const name of PREVIOUS_EXES) {
  const leftover = path.join(path.dirname(installed), name);
  if (fs.existsSync(leftover)) {
    fs.unlinkSync(leftover);
  }
}
console.log(`Copied to ${installed}`);

// Launching also points agents at this copy (it rewrites desktop.json on start).
if (wasRunning) {
  spawn(installed, [], { detached: true, stdio: "ignore" }).unref();
  console.log("Restarted the desktop app");
}

function envWithCargo() {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const current = env[key] ?? "";
  if (fs.existsSync(cargoBin) && !current.split(path.delimiter).includes(cargoBin)) {
    env[key] = `${cargoBin}${path.delimiter}${current}`;
  }
  return env;
}

function commandExists(name, env) {
  const file = process.platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name;
  const key = Object.keys(env).find((n) => n.toLowerCase() === "path");
  const dirs = key ? env[key].split(path.delimiter) : [];
  return dirs.some((dir) => dir && fs.existsSync(path.join(dir, file)));
}

function processNames() {
  return [EXE, ...PREVIOUS_EXES];
}

function isImageRunning(name) {
  const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH"], { encoding: "utf8" });
  return out.toLowerCase().includes(name.toLowerCase());
}

function isRunning() {
  return processNames().some(isImageRunning);
}

/** Ask the window to close first so it saves its layout; force it only if that does not work. */
function stopApp() {
  console.log("Closing the desktop app");
  for (const name of processNames().filter(isImageRunning)) {
    spawnSync("taskkill", ["/IM", name], { stdio: "ignore" });
  }
  if (waitForExit(5000)) {
    return;
  }
  for (const name of processNames().filter(isImageRunning)) {
    spawnSync("taskkill", ["/IM", name, "/F"], { stdio: "ignore" });
  }
  if (!waitForExit(5000)) {
    console.error("The desktop app is still running; close it and try again");
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
