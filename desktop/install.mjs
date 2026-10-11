// Builds the release desktop app and copies the exe into a folder, replacing a running copy.
// Usage: npm run desktop:install -- <target folder>
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRelease } from "./install-release.mjs";

const EXE = "scribe.exe";
const PREVIOUS_EXES = ["agent-board-desktop.exe", "board.exe"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

// Cargo may use CARGO_TARGET_DIR or a configured target-dir (including in worktrees).
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", path.join(root, "desktop", "Cargo.toml"), "--format-version", "1", "--no-deps"], { cwd: root, env, encoding: "utf8" }));
const built = path.join(metadata.target_directory, "release", EXE);

console.log("Building the release app");
const build = spawnSync(process.execPath, [tauriJs, "build", "--no-bundle"], { cwd: root, stdio: "inherit", env });
if (build.status !== 0) {
  console.error("Release build failed");
  process.exit(build.status ?? 1);
}

try {
  await installRelease({ built, installed, runningApps, stop: stopApp, restart: restartApp });
} catch (error) {
  console.error("Desktop installation failed:", error);
  process.exit(1);
}
for (const name of PREVIOUS_EXES) {
  const leftover = path.join(path.dirname(installed), name);
  if (fs.existsSync(leftover)) {
    try {
      fs.unlinkSync(leftover);
    } catch (error) {
      console.warn(`Could not remove ${leftover}: ${error.message}`);
    }
  }
}
console.log(`Copied to ${installed}`);

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

// Capture the actual paths, including an older executable name or another install folder.
function runningApps() {
  const names = processNames().map((name) => `'${path.parse(name).name}'`).join(",");
  const script = `$ErrorActionPreference = 'Stop'; $apps = @(Get-Process -Name ${names} -ErrorAction SilentlyContinue); $paths = @($apps | ForEach-Object { if (!$_.Path) { throw 'Cannot read the running desktop executable path' }; $_.Path } | Select-Object -Unique); ConvertTo-Json -InputObject $paths -Compress`;
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }));
}

// Launching also points agents at this copy (it rewrites desktop.json on start).
async function restartApp(executable, recovering) {
  if (recovering && runningApps().some((app) => app.toLowerCase() === executable.toLowerCase())) return;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  console.log(recovering ? `Restarted the previous desktop app: ${executable}` : "Restarted the desktop app");
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
    throw new Error("The desktop app is still running; close it and try again");
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
