import fs from "node:fs";
import { dataDir, logPath } from "./config.js";

function ensureDir(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
}

export function log(message: string, extra?: unknown): void {
  const line =
    extra === undefined
      ? `${new Date().toISOString()} ${message}`
      : `${new Date().toISOString()} ${message} ${safeJson(extra)}`;
  console.error(line);
  try {
    ensureDir();
    fs.appendFileSync(logPath(), line + "\n");
  } catch {
    // Logging must never crash the process.
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
