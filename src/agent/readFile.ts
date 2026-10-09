import fs from "node:fs/promises";
import path from "node:path";
import { threadFilesDir } from "./attachments.js";
import type { Thread } from "./types.js";

export const READ_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const READ_FILE_MAX_CHARS = 32_000;
type ReadScope = Pick<Thread, "cwd" | "mode" | "approval"> & Partial<Pick<Thread, "id" | "worktree">>;

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

async function existingRealPath(root: string): Promise<string | null> {
  try { return await fs.realpath(root); }
  catch (err) {
    if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) return null;
    throw err;
  }
}

async function readRoots(thread: ReadScope): Promise<Array<{ lexical: string; real: string }>> {
  const roots: Array<{ lexical: string; real: string }> = [];
  const add = async (root: string) => {
    const real = await existingRealPath(root);
    if (real) roots.push({ lexical: path.resolve(root), real });
  };
  if (thread.cwd) await add(thread.cwd);
  if (thread.id) await add(threadFilesDir(thread.id));
  const wt = thread.worktree;
  if (wt && !wt.closed) {
    for (const rel of wt.links) {
      if (!rel || path.isAbsolute(rel)) continue;
      const link = path.resolve(wt.path, rel);
      const source = path.resolve(wt.repo, rel);
      if (!inside(path.resolve(wt.path), link) || !inside(path.resolve(wt.repo), source)) continue;
      const [real, expected] = await Promise.all([existingRealPath(link), existingRealPath(source)]);
      // A recorded link cannot grant an arbitrary destination after being retargeted.
      if (real && expected && path.relative(expected, real) === "") roots.push({ lexical: link, real });
    }
  }
  return roots;
}

/** Host-side gate: MCP tools run outside Codex's shell sandbox. Never trust a caller-supplied scope. */
export async function readScopedFile(thread: ReadScope | null, input: { path?: unknown; offset?: unknown; limit?: unknown }) {
  if (!thread || thread.mode === "board") throw new Error("File reads are unavailable in this thread's mode.");
  if (typeof input.path !== "string" || !input.path.trim() || input.path.includes("\0")) throw new Error("path must be a nonempty local file path.");
  const offset = input.offset ?? 1;
  const limit = input.limit ?? 200;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1) throw new Error("offset must be a positive line number.");
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be between 1 and 1000 lines.");
  const full = thread.mode === "code" && thread.approval === "full";
  if (!thread.cwd && !path.isAbsolute(input.path)) throw new Error("No workspace is available for this relative file read.");
  const target = path.resolve(thread.cwd ?? process.cwd(), input.path);
  const roots = full ? [] : await readRoots(thread);
  const matching = roots.filter((root) => inside(root.lexical, target) || inside(root.real, target));
  if (!full && !matching.length) throw new Error("File read denied: path is outside the workspace scope and this thread's read roots.");
  const real = await fs.realpath(target);
  if (!full && !matching.some((root) => inside(root.real, real))) throw new Error("File read denied: link target is outside this thread's read roots.");
  const handle = await fs.open(real, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("File reads require a regular text file.");
    if (stat.size > READ_FILE_MAX_BYTES) throw new Error("Text file exceeds the 8 MiB read limit.");
    // A bounded read also handles a file growing after stat, without allocating its new size.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, READ_FILE_MAX_BYTES + 1));
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > stat.size) throw new Error("File changed during read; retry.");
    const raw = bytes.subarray(0, used);
    if (raw.includes(0)) throw new Error("Binary files are not supported; read_file accepts UTF-8 text.");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
    catch { throw new Error("read_file accepts UTF-8 text only."); }
    const lines = text ? text.split(/\r\n|\n|\r/) : [];
    if (lines.at(-1) === "") lines.pop();
    const selected: string[] = [];
    let chars = 0;
    let next = offset;
    for (; next <= lines.length && selected.length < limit; next++) {
      const numbered = `${next}\t${lines[next - 1]}`;
      if (chars + numbered.length + 1 > READ_FILE_MAX_CHARS) {
        if (!selected.length) throw new Error(`Line ${next} exceeds the 32000 character output limit.`);
        break;
      }
      selected.push(numbered);
      chars += numbered.length + 1;
    }
    const truncated = next <= lines.length;
    return { path: target, offset, linesReturned: selected.length, totalLines: lines.length,
      truncated, nextOffset: truncated ? next : null, content: selected.join("\n"),
      note: truncated ? `Continue with offset: ${next}.` : "End of file." };
  } finally { await handle.close(); }
}
