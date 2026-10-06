import { startHttp } from "./http.js";
import { startMcp } from "./mcp.js";
import { api, ensureDaemon, health } from "./daemon.js";
import { log } from "./log.js";
import { migrateLegacyData } from "./config.js";
import { watchMemory } from "./memoryWatch.js";

const args = new Set(process.argv.slice(2));

async function main(): Promise<void> {
  if (args.has("--stop")) {
    const info = await health();
    if (!info) {
      log("Scribe is not running");
      return;
    }
    await api("POST", "/api/shutdown");
    log("Stop requested");
    return;
  }

  if (args.has("--daemon")) {
    migrateLegacyData(log);
    watchMemory();
    await startHttp();
    return;
  }

  // The desktop app starts (or replaces) the daemon this way before loading the board.
  if (args.has("--ensure")) {
    await ensureDaemon();
    return;
  }

  await startMcp();
}

main().catch((err) => {
  log(`Fatal: ${(err as Error).stack || err}`);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err.stack || err}`);
});

process.on("unhandledRejection", (err) => {
  log(`unhandledRejection: ${String(err)}`);
});
