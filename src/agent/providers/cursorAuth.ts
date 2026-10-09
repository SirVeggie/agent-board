import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The Cursor app's session token, for the private dashboard API behind /usage. The Cursor IDE keeps
 * its login in a VS Code state database (ItemTable, key cursorAuth/accessToken) and refreshes the
 * token there as it expires, so it is read again for every fetch rather than cached. CURSOR_ACCESS_TOKEN
 * in the daemon's environment wins when set. Brittle by nature: a Cursor update can move it.
 */
const TOKEN_KEY = "cursorAuth/accessToken";

/** Where the Cursor IDE keeps state.vscdb on this platform. */
export function cursorStateDbPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const base =
    platform === "win32"
      ? env.APPDATA || path.join(home, "AppData", "Roaming")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "Cursor", "User", "globalStorage", "state.vscdb");
}

/** The token stored in a state database, or null when the file, table or key is missing. */
export function readCursorStateToken(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    // Read-only, so the running IDE's writes and locks are left alone.
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(TOKEN_KEY) as { value?: unknown } | undefined;
    const raw = row?.value instanceof Uint8Array ? Buffer.from(row.value).toString("utf8") : row?.value;
    if (typeof raw !== "string") return null;
    let token = raw.trim();
    // Some versions store the value JSON-encoded.
    if (token.startsWith('"')) {
      try {
        token = String(JSON.parse(token)).trim();
      } catch {
        // Not JSON after all: use it as is.
      }
    }
    return token || null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** The token to use now and where it came from, or null when there is none. */
export function cursorAccessToken(env: NodeJS.ProcessEnv = process.env, dbPath = cursorStateDbPath()): { token: string; source: "env" | "app" } | null {
  const fromEnv = env.CURSOR_ACCESS_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };
  const fromApp = readCursorStateToken(dbPath);
  return fromApp ? { token: fromApp, source: "app" } : null;
}
