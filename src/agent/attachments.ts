import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import type { ChatFile, FileRef } from "./types.js";

/**
 * Files pasted or dropped into the chat. Each one is saved under the data folder, one folder per
 * thread, so the transcript can show it again and agents with file tools can open it by path. The
 * prompt gets text files inline, PDFs as documents where the provider reads them, and a path for
 * everything else.
 */

export const MAX_FILES_PER_MESSAGE = 10;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** All of one message's files together; the JSON body limit in routes.ts allows for base64 on top. */
export const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
/** Text files up to this size go into the prompt as they are; bigger ones are passed by path. */
export const MAX_INLINE_TEXT_BYTES = 100 * 1024;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "rst", "log", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml",
  "html", "htm", "css", "scss", "less", "svg", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h",
  "cc", "cpp", "hpp", "cs", "fs", "php", "pl", "lua", "r", "sql", "sh", "bash", "zsh", "ps1", "psm1", "bat", "cmd", "gradle", "vue", "svelte", "dart",
  "scala", "clj", "ex", "exs", "erl", "hs", "ml", "tex", "diff", "patch", "graphql", "gql", "proto", "dockerfile", "gitignore", "editorconfig",
]);

export function extensionOf(name: string): string {
  const base = name.toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : base;
}

/** Text the agent can read inline: text/* types, the usual structured-text types, or a known source extension. */
export function isTextFile(name: string, mimeType: string): boolean {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (/^application\/(json|.*\+json|xml|.*\+xml|javascript|typescript|x-sh|x-yaml|yaml|toml|sql|x-httpd-php)$/.test(mime)) return true;
  return TEXT_EXTENSIONS.has(extensionOf(name));
}

/** Browsers often send an empty type for source files; fill in the one the extension implies. */
export function guessMimeType(name: string, mimeType: string): string {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  const ext = extensionOf(name);
  if (ext === "pdf") return "application/pdf";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "csv") return "text/csv";
  if (ext === "json") return "application/json";
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain";
  return mimeType || "application/octet-stream";
}

/** A file name safe on every platform, keeping its extension. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120);
  return cleaned || "file";
}

function threadDir(threadId: string): string {
  return path.join(dataDir(), "attachments", threadId.replace(/[^\w-]/g, "_"));
}

/** Read scope for files explicitly attached to this thread. Does not create a directory. */
export function threadFilesDir(threadId: string): string {
  return threadDir(threadId);
}

/** Save one message's files. Each gets an id and a folder of its own, so names never collide. */
export function saveFiles(threadId: string, files: ChatFile[]): FileRef[] {
  return files.map((file) => {
    const id = randomUUID().slice(0, 12);
    const dir = path.join(threadDir(threadId), id);
    fs.mkdirSync(dir, { recursive: true });
    const name = safeFileName(file.name);
    const bytes = Buffer.from(file.data, "base64");
    const full = path.join(dir, name);
    fs.writeFileSync(full, bytes);
    return { id, name, mimeType: file.mimeType, size: bytes.length, path: full };
  });
}

/** The saved file for a transcript entry, or null when it is gone. */
export function filePath(threadId: string, id: string): string | null {
  if (!/^[\w-]+$/.test(id)) return null;
  const dir = path.join(threadDir(threadId), id);
  try {
    const name = fs.readdirSync(dir)[0];
    return name ? path.join(dir, name) : null;
  } catch {
    return null;
  }
}

export function removeFiles(threadId: string, ids: string[]): void {
  for (const id of ids) {
    if (!/^[\w-]+$/.test(id)) continue;
    fs.rmSync(path.join(threadDir(threadId), id), { recursive: true, force: true });
  }
}

export function removeThreadFiles(threadId: string): void {
  fs.rmSync(threadDir(threadId), { recursive: true, force: true });
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The block ahead of the user's message that tells the agent about attached files. Text files are
 * inlined; PDFs are said to be attached when the provider gets them as documents; anything else is
 * named with its saved path, for agents that can read files.
 */
export function filesBlock(files: ChatFile[], refs: FileRef[], opts: { nativePdf: boolean; canReadFiles: boolean }): string {
  if (!files.length) return "";
  const parts: string[] = [];
  files.forEach((file, index) => {
    const ref = refs[index];
    const where = ref?.path ? ` path="${ref.path}"` : "";
    const head = `name="${file.name}" type="${file.mimeType}" size="${sizeLabel(ref?.size ?? 0)}"${where}`;
    if (isTextFile(file.name, file.mimeType) && (ref?.size ?? 0) <= MAX_INLINE_TEXT_BYTES) {
      const text = Buffer.from(file.data, "base64").toString("utf8");
      parts.push(`<attached_file ${head}>\n${text}\n</attached_file>`);
    } else if (file.mimeType === "application/pdf" && opts.nativePdf) {
      parts.push(`<attached_file ${head}>(attached below as a PDF document)</attached_file>`);
    } else if (opts.canReadFiles) {
      parts.push(`<attached_file ${head}>(not inlined: open it from the path with your file tools)</attached_file>`);
    } else {
      parts.push(`<attached_file ${head}>(not inlined, and this thread has no file access: tell the user if you need its contents)</attached_file>`);
    }
  });
  return `${parts.join("\n\n")}\n\n`;
}
