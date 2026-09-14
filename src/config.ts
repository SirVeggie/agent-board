import path from "node:path";

export const VERSION = "1.2.0";
export const HOST = "127.0.0.1";
/** Loopback origin for tab pages so they get localStorage without sharing the chrome origin. */
export const CONTENT_HOST = "127.0.0.2";
export const PORT = Number(process.env.AGENT_BOARD_PORT || 4747);
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_STATE_BYTES = 256 * 1024;
export const DEFAULT_WAIT_MS = 10 * 60 * 1000;
export const MAX_WAIT_MS = 10 * 60 * 1000;

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

export function logPath(): string {
  return path.join(dataDir(), "daemon.log");
}
