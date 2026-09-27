import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
  spawn("cmd", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}
