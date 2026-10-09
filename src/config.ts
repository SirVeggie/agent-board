import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Daemon/UI protocol version. Bump with any API or event change; public/app.js BOARD_VERSION must match. */
export const VERSION = "3.0.1";
export const HOST = "127.0.0.1";
/** Loopback origin for tab pages so they get localStorage without sharing the chrome origin. */
export const CONTENT_HOST = "127.0.0.2";
export const PORT = Number(process.env.SCRIBE_PORT || 4747);
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_STATE_BYTES = 4 * 1024 * 1024;
/** Events each page keeps for waits to read; older ones drop off. */
export const MAX_PAGE_EVENTS = 500;
export const MAX_EVENT_DATA_BYTES = 4096;
/** Per-viewer page state (board.local): filters, open panels, drafts. */
export const MAX_LOCAL_STATE_BYTES = 64 * 1024;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_ASSETS_PER_TAB = 16;
export const MAX_ASSETS_TOTAL_BYTES = 32 * 1024 * 1024;
/** Blobs a page saves from its own code (board.saveAsset), stored in scribe.sqlite. */
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
/** Long on purpose: the user can interrupt the agent at any time, and a review page may take a while. */
export const DEFAULT_WAIT_MS = 2 * 60 * 60 * 1000;
/** Not a policy limit (the harness owns that): setTimeout's ~24.8-day ceiling, less room for the socket margins added on top. */
export const MAX_WAIT_MS = 2 ** 31 - 1 - 60_000;
/** How often page_wait reports progress, so the MCP client does not take the long silence for a hung server. */
export const WAIT_HEARTBEAT_MS = 60_000;
/** How long the server gives a client to send a whole request. */
export const REQUEST_TIMEOUT_MS = 10 * 60 * 1000 + 30_000;
/** The MCP marks its requests with this header so tabs hidden from the agent stay invisible to them. */
export const CLIENT_HEADER = "x-scribe-client";
export const AGENT_CLIENT = "agent";
/** One MCP server process; claims it holds stay live while it keeps calling. */
export const SESSION_HEADER = "x-scribe-session";
/** The Scribe chat thread an MCP server was started for (SCRIBE_THREAD in its environment). */
export const THREAD_HEADER = "x-scribe-thread";
/** The MCP client's name, shown as the holder of a claim. */
export const AGENT_LABEL_HEADER = "x-scribe-agent";

export function baseUrl(): string {
  return `http://${HOST}:${PORT}`;
}

export function contentBaseUrl(): string {
  return `http://${CONTENT_HOST}:${PORT}`;
}

export function dataDir(): string {
  if (process.env.SCRIBE_HOME) {
    return process.env.SCRIBE_HOME;
  }
  const root = process.env.LOCALAPPDATA || process.env.HOME || process.cwd();
  return path.join(root, "scribe");
}

/** Where data lived before the app was renamed from Agent Board to Scribe. */
function legacyDataDir(): string | null {
  if (process.env.SCRIBE_HOME) {
    return null;
  }
  const root = process.env.LOCALAPPDATA || process.env.HOME || process.cwd();
  return path.join(root, "agent-board");
}

/**
 * One-time move of an Agent Board data folder to Scribe's, run by the daemon before it opens
 * anything. The new folder may already exist (an MCP process writes its log there first), so
 * entries move one by one and nothing already in the new folder is overwritten. board.sqlite
 * (and its -wal / -shm files) becomes scribe.sqlite.
 */
export function migrateLegacyData(log: (line: string) => void): void {
  const dir = dataDir();
  const legacy = legacyDataDir();
  if (legacy && fs.existsSync(legacy) && !fs.existsSync(dbPath())) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(legacy)) {
      const from = path.join(legacy, name);
      const to = path.join(dir, name);
      if (fs.existsSync(to)) {
        continue;
      }
      try {
        fs.renameSync(from, to);
      } catch (err) {
        // Something still holds it open (a leftover process in the scratch folder): copy instead,
        // so Scribe starts with the data and the old copy stays behind.
        log(`Could not move ${from} (${(err as Error).message}); copying it instead`);
        fs.cpSync(from, to, { recursive: true });
      }
    }
    if (!fs.readdirSync(legacy).length) {
      fs.rmdirSync(legacy);
    }
    log(`Moved data from ${legacy} to ${dir}`);
    // Claude Code keys its sessions by working folder, so Pages-mode threads (which run in the
    // scratch folder) resume only if their session folder is copied to the new path's name.
    const projects = path.join(os.homedir(), ".claude", "projects");
    const encode = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-");
    const from = path.join(projects, encode(path.join(legacy, "agent", "scratch")));
    const to = path.join(projects, encode(path.join(dir, "agent", "scratch")));
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.cpSync(from, to, { recursive: true });
    }
  }
  if (!fs.existsSync(dbPath()) && fs.existsSync(path.join(dir, "board.sqlite"))) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const from = path.join(dir, `board.sqlite${suffix}`);
      if (fs.existsSync(from)) {
        fs.renameSync(from, `${dbPath()}${suffix}`);
      }
    }
    log("Renamed board.sqlite to scribe.sqlite");
  }
}

export function statePath(): string {
  return path.join(dataDir(), "state.json");
}

export function dbPath(): string {
  return path.join(dataDir(), "scribe.sqlite");
}

export function logPath(): string {
  return path.join(dataDir(), "daemon.log");
}
