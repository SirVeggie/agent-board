import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeStem } from "./boardExport.js";

/** Scratch HTML belongs to the requesting thread, never the workspace or another thread. */
export function pageCheckoutDir(threadId: string): string {
  const id = createHash("sha256").update(threadId).digest("hex");
  return path.join(os.tmpdir(), "scribe", "checkouts", id);
}

export function writeCheckout(tab: { key: string; html: string }, threadId?: string): string {
  // Standalone MCP clients have no Scribe thread/read scope; retain their checkout location.
  const dir = threadId ? pageCheckoutDir(threadId) : path.join(os.tmpdir(), "scribe");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeStem(tab.key)}.html`);
  fs.writeFileSync(file, tab.html, "utf8");
  return file;
}
