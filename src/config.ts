import path from "node:path";

/** Daemon/UI protocol version. Bump with any API or event change; public/app.js BOARD_VERSION must match. */
export const VERSION = "2.4.0";
export const HOST = "127.0.0.1";
/** Loopback origin for tab pages so they get localStorage without sharing the chrome origin. */
export const CONTENT_HOST = "127.0.0.2";
export const PORT = Number(process.env.AGENT_BOARD_PORT || 4747);
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_STATE_BYTES = 256 * 1024;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_ASSETS_PER_TAB = 16;
export const MAX_ASSETS_TOTAL_BYTES = 32 * 1024 * 1024;
/** Blobs a page saves from its own code (board.saveAsset), stored in board.sqlite. */
export const MAX_PAGE_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_PAGE_ASSETS_PER_TAB = 2000;
export const MAX_PAGE_ASSETS_TOTAL_BYTES = 256 * 1024 * 1024;
/** Share of either page asset limit at which the page and the board UI are warned. */
export const PAGE_ASSET_WARN_RATIO = 0.8;
/** How long a page asset may go unreferenced by the page's state and HTML before it is deleted. */
export const PAGE_ASSET_ORPHAN_GRACE_MS = 10 * 60 * 1000;
/** Safety-net sweep for orphaned assets, on top of the checks after each save. */
export const ASSET_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Kept under V8's ~512 MiB string cap, since the file is parsed as one JSON string. */
export const MAX_IMPORT_BYTES = 400 * 1024 * 1024;
export const DEFAULT_WAIT_MS = 10 * 60 * 1000;
export const MAX_WAIT_MS = 10 * 60 * 1000;
/** The MCP marks its requests with this header so tabs hidden from the agent stay invisible to them. */
export const CLIENT_HEADER = "x-agent-board-client";
export const AGENT_CLIENT = "agent";

export function baseUrl(): string {
  return `http://${HOST}:${PORT}`;
}

export function contentBaseUrl(): string {
  return `http://${CONTENT_HOST}:${PORT}`;
}

export function dataDir(): string {
  if (process.env.AGENT_BOARD_HOME) {
    return process.env.AGENT_BOARD_HOME;
  }
  const root = process.env.LOCALAPPDATA || process.env.HOME || process.cwd();
  return path.join(root, "agent-board");
}

export function statePath(): string {
  return path.join(dataDir(), "state.json");
}

export function dbPath(): string {
  return path.join(dataDir(), "board.sqlite");
}

export function logPath(): string {
  return path.join(dataDir(), "daemon.log");
}
