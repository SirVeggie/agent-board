import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaceKey } from "./prefs.js";

/**
 * Finding a workspace folder again after it was renamed or moved (#338). A folder keeps its file id
 * (NTFS file index, inode elsewhere) through a rename on the same drive, so Scribe saves that id for
 * the folders threads work in and looks for it when the path is gone.
 */

/** A workspace folder and the file id it had when Scribe last saw it. */
export type KnownWorkspace = { path: string; dev: string; ino: string };

/** Most folders one search looks at. */
const MAX_SCAN = 4000;
/** Never a workspace, and large. */
const SKIP = new Set(["node_modules", ".git", "$recycle.bin", "system volume information"]);

/** The folder's file id; null when it is missing, not a folder, or on a drive that has no ids. */
export function folderId(dir: string): { dev: string; ino: string } | null {
  try {
    const stat = fs.statSync(dir, { bigint: true });
    if (!stat.isDirectory() || stat.ino === 0n) return null;
    return { dev: String(stat.dev), ino: String(stat.ino) };
  } catch {
    return null;
  }
}

export function folderExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** value with its leading `from` folder replaced by `to`; null when value is not `from` or inside it. */
export function movePath(value: string, from: string, to: string): string | null {
  const key = workspaceKey(value);
  const fromKey = workspaceKey(from);
  if (!fromKey || (key !== fromKey && !key.startsWith(`${fromKey}/`))) return null;
  const rest = value.replace(/[\\/]+$/, "").slice(from.replace(/[\\/]+$/, "").length);
  return to.replace(/[\\/]+$/, "") + rest;
}

function subfolders(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIP.has(entry.name.toLowerCase()))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Where a missing workspace went. Looks under the nearest folder of its old path that still exists,
 * as deep as the part that is gone (so a renamed parent folder is followed too), then directly
 * inside the `others` folders (parents of other workspaces). null when nothing has its id.
 */
export function findMoved(known: KnownWorkspace, others: string[] = []): string | null {
  let root = path.dirname(known.path);
  let depth = 1;
  while (!folderExists(root)) {
    const up = path.dirname(root);
    if (up === root) return null;
    root = up;
    depth += 1;
  }
  let budget = MAX_SCAN;
  const matches = (dir: string): boolean => {
    const id = folderId(dir);
    return Boolean(id && id.ino === known.ino && id.dev === known.dev);
  };
  let level = [root];
  for (let d = 0; d < depth && level.length; d++) {
    const next: string[] = [];
    for (const dir of level) {
      for (const child of subfolders(dir)) {
        if (budget-- <= 0) return null;
        if (matches(child)) return child;
        next.push(child);
      }
    }
    level = next;
  }
  const seen = new Set([workspaceKey(root)]);
  for (const dir of others) {
    if (seen.has(workspaceKey(dir))) continue;
    seen.add(workspaceKey(dir));
    for (const child of subfolders(dir)) {
      if (budget-- <= 0) return null;
      if (matches(child)) return child;
    }
  }
  return null;
}

/** Claude Code's folder for a working directory's sessions and memory, under ~/.claude/projects. */
export function claudeProjectDir(cwd: string, home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")): string {
  return path.join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * Move Claude Code's sessions and memory for a working directory to the name its new path gets, so
 * its threads resume there. With sessions already at the new path, only what is not there yet moves.
 * Returns how many entries moved.
 */
export function moveClaudeProject(from: string, to: string, home?: string): number {
  const src = claudeProjectDir(from, home);
  const dst = claudeProjectDir(to, home);
  if (src === dst || !folderExists(src)) return 0;
  if (!fs.existsSync(dst)) {
    const count = fs.readdirSync(src).length;
    fs.renameSync(src, dst);
    return count;
  }
  let moved = 0;
  for (const name of fs.readdirSync(src)) {
    if (fs.existsSync(path.join(dst, name))) continue;
    fs.renameSync(path.join(src, name), path.join(dst, name));
    moved += 1;
  }
  return moved;
}
