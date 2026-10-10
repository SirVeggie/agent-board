// Launches the installed Chromium (Edge, Chrome or Brave), like src/chromium.ts does for the daemon.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const RELS = [
  ["Microsoft", "Edge", "Application", "msedge.exe"],
  ["Google", "Chrome", "Application", "chrome.exe"],
  ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
];

export async function launch(options = {}) {
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(Boolean);
  const exes = roots.flatMap((root) => RELS.map((rel) => path.join(root, ...rel))).filter((exe) => fs.existsSync(exe));
  const tries = [{ channel: "msedge" }, { channel: "chrome" }, ...exes.map((executablePath) => ({ executablePath }))];
  const errors = [];
  for (const how of tries) {
    try {
      const browser = await chromium.launch({ headless: true, ...options, ...how });
      return { browser, name: how.channel ?? path.basename(how.executablePath) };
    } catch (err) {
      errors.push(String(err.message).split("\n")[0]);
    }
  }
  throw new Error(`No Chromium browser could start: ${errors.join("; ")}`);
}
