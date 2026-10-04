import fs from "node:fs";
import path from "node:path";
import { findRepo, git } from "./git.js";

export const FILE_SEARCH_DEFAULT = 40;
export const FILE_SEARCH_MAX = 80;
/** How many paths to collect before ranking; keeps huge trees from blocking the picker. */
const FILE_SEARCH_SCAN = 8000;
const WALK_MS = 2000;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".turbo",
  "coverage",
  ".cursor",
]);

export type WorkspaceFileHit = { path: string; name: string };

/** Rank cwd-relative paths for the @-mention picker. Empty query prefers shallower files. */
export function rankWorkspaceFiles(paths: string[], query: string, limit: number): WorkspaceFileHit[] {
  const lim = Math.min(FILE_SEARCH_MAX, Math.max(1, Math.floor(limit) || FILE_SEARCH_DEFAULT));
  const q = query.trim().toLowerCase();
  const parts = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ path: string; name: string; score: number; depth: number }> = [];
  for (const raw of paths) {
    const file = raw.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!file || file.endsWith("/")) continue;
    const name = file.slice(file.lastIndexOf("/") + 1);
    const p = file.toLowerCase();
    const n = name.toLowerCase();
    if (parts.length && !parts.every((part) => p.includes(part))) continue;
    let score = 5;
    if (q) {
      if (n === q) score = 0;
      else if (n.startsWith(q)) score = 1;
      else if (n.includes(q)) score = 2;
      else if (p.includes(`/${q}`) || p.startsWith(`${q}/`) || p.startsWith(q)) score = 3;
      else score = 4;
    }
    scored.push({ path: file, name, score, depth: file.split("/").length });
  }
  scored.sort((a, b) => a.score - b.score || a.depth - b.depth || a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  return scored.slice(0, lim).map(({ path: file, name }) => ({ path: file, name }));
}

/** Files under `cwd` for the composer mention picker. Missing folders yield []. */
export async function searchWorkspaceFiles(cwd: string, query: string, limit = FILE_SEARCH_DEFAULT): Promise<WorkspaceFileHit[]> {
  const root = typeof cwd === "string" ? cwd.trim() : "";
  if (!root) return [];
  const abs = path.resolve(root);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  const listed = await listWorkspaceFiles(abs);
  return rankWorkspaceFiles(listed, query, limit);
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const fromGit = await gitLsFiles(root);
  if (fromGit) return fromGit.filter((rel) => isFile(path.join(root, rel)));
  return walkFiles(root);
}

async function gitLsFiles(root: string): Promise<string[] | null> {
  const repo = await findRepo(root);
  if (!repo) return null;
  const res = await git(["ls-files", "-co", "--exclude-standard", "-z"], root, { timeoutMs: 8000, maxBuffer: 16 * 1024 * 1024 });
  if (res.code !== 0) return null;
  const out: string[] = [];
  for (const rel of res.stdout.split("\0")) {
    if (!rel) continue;
    const norm = rel.replaceAll("\\", "/");
    if (norm.startsWith("../") || path.isAbsolute(norm)) continue;
    out.push(norm);
    if (out.length >= FILE_SEARCH_SCAN) break;
  }
  return out;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const deadline = Date.now() + WALK_MS;
  const visit = (dir: string, rel: string) => {
    if (out.length >= FILE_SEARCH_SCAN || Date.now() > deadline) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= FILE_SEARCH_SCAN || Date.now() > deadline) return;
      if (entry.isSymbolicLink()) continue;
      const name = entry.name;
      const childRel = rel ? `${rel}/${name}` : name;
      const abs = path.join(dir, name);
      if (entry.isDirectory()) {
        if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
        visit(abs, childRel);
      } else if (entry.isFile()) {
        out.push(childRel.replaceAll("\\", "/"));
      }
    }
  };
  visit(root, "");
  return out;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
