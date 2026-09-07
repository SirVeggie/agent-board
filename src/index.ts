import { startHttp } from "./http.js";
import { startMcp } from "./mcp.js";
import { api, health } from "./daemon.js";
import { log } from "./log.js";

const args = new Set(process.argv.slice(2));

async function main(): Promise<void> {
  if (args.has("--stop")) {
    const info = await health();
    if (!info) {
      log("Agent Board is not running");
      return;
    }
    await api("POST", "/api/shutdown");
    log("Stop requested");
    return;
  }

  if (args.has("--daemon")) {
    await startHttp();
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
