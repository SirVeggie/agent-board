import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { dataDir } from "./config.js";
import { log } from "./log.js";

const CHECK_MS = 60_000;
const STEP_MB = 1024;

/**
 * Leave a trail when the daemon's memory runs away: a log line each time the heap first passes
 * another GB, and a diagnostic report (heap spaces, handles, resource use) if V8 dies of it. An
 * out-of-memory report has no JS stack, so the log lines are what show when the growth started.
 */
export function watchMemory(): void {
  const dir = path.join(dataDir(), "reports");
  try {
    fs.mkdirSync(dir, { recursive: true });
    process.report.directory = dir;
    process.report.reportOnFatalError = true;
  } catch (err) {
    log(`Memory watch: could not set up crash reports: ${(err as Error).message}`);
  }
  let logged = 0;
  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const step = Math.floor(mem.heapUsed / 1048576 / STEP_MB);
    if (step <= logged) return;
    logged = step;
    const mb = (n: number) => Math.round(n / 1048576);
    const spaces = v8
      .getHeapSpaceStatistics()
      .filter((s) => s.space_used_size >= 64 * 1048576)
      .map((s) => `${s.space_name} ${mb(s.space_used_size)}`)
      .join(", ");
    log(`Memory: heap ${mb(mem.heapUsed)} of ${mb(mem.heapTotal)} MB (${spaces}), rss ${mb(mem.rss)} MB, external ${mb(mem.external)} MB after ${Math.round(process.uptime() / 60)} min`);
  }, CHECK_MS);
  timer.unref();
}
