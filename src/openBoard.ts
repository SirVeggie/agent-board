import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

/** Written by the desktop app on every launch; its setting decides where agents open the board. */
type DesktopRegistration = { exe?: unknown; openFromAgents?: unknown };

/** Open the board at `url` in the desktop app when it is set up for that, else in the default browser. */
export function openBoard(url: string): void {
  const exe = desktopExe();
  if (exe) {
    spawn(exe, ["--open", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  openBrowser(url);
}

function desktopExe(): string | null {
  let registration: DesktopRegistration;
  try {
    registration = JSON.parse(fs.readFileSync(path.join(dataDir(), "desktop.json"), "utf8")) as DesktopRegistration;
  } catch {
    return null;
  }
  if (registration.openFromAgents === false || typeof registration.exe !== "string") {
    return null;
  }
  return fs.existsSync(registration.exe) ? registration.exe : null;
}

function openBrowser(url: string): void {
  spawn("cmd", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}
