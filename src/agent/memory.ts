import crypto from "node:crypto";
import { workspaceKey } from "./prefs.js";

/**
 * Shared agent memory (#104): short notes that every Scribe chat gets in its instructions, whatever
 * its provider, so a correction given to one agent reaches the next. A memory is global, or belongs
 * to a workspace folder (and the folders below it). Agents save them with memory_save; the user
 * reads and edits them under Agent settings. Kept as one list under the "memories" setting.
 */
export type Memory = {
  id: string;
  scope: "global" | "workspace";
  /** The workspace folder, for scope "workspace". */
  workspace?: string;
  text: string;
  /** "user", or the provider of the agent that saved it. */
  by: string;
  /** The thread that saved it. */
  thread?: string;
  createdAt: number;
  updatedAt: number;
};

export const MEMORY_MAX_CHARS = 1500;
export const MEMORY_MAX_COUNT = 300;
/** Room the memories may take in a thread's instructions; older ones beyond it are only counted. */
export const MEMORY_PROMPT_CHARS = 12_000;

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The saved list, without entries that do not parse. */
export function cleanMemories(raw: unknown): Memory[] {
  if (!Array.isArray(raw)) return [];
  const out: Memory[] = [];
  for (const m of raw) {
    if (!isRecord(m) || typeof m.id !== "string" || typeof m.text !== "string" || !m.text.trim()) continue;
    const workspace = m.scope === "workspace" && typeof m.workspace === "string" && m.workspace ? m.workspace : null;
    const at = typeof m.updatedAt === "number" ? m.updatedAt : 0;
    out.push({
      id: m.id,
      scope: workspace ? "workspace" : "global",
      ...(workspace ? { workspace } : {}),
      text: m.text,
      by: typeof m.by === "string" && m.by ? m.by : "user",
      ...(typeof m.thread === "string" ? { thread: m.thread } : {}),
      createdAt: typeof m.createdAt === "number" ? m.createdAt : at,
      updatedAt: at,
    });
  }
  return out;
}

/** Whether a memory applies in a workspace folder: global ones always, a workspace's in it and below it. */
export function memoryApplies(memory: Memory, workspace: string | null): boolean {
  if (memory.scope === "global") return true;
  if (!workspace || !memory.workspace) return false;
  const at = workspaceKey(workspace);
  const home = workspaceKey(memory.workspace);
  return at === home || at.startsWith(`${home}/`);
}

/** The memories for a workspace folder (null: global ones only), newest first. */
export function memoriesFor(memories: Memory[], workspace: string | null): Memory[] {
  return memories.filter((m) => memoryApplies(m, workspace)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export type MemoryInput = { id?: string; text: string; scope: "global" | "workspace"; workspace?: string | null; by: string; thread?: string };

/**
 * Add a memory, or replace the text (and scope) of the one with input.id. Returns the new list and
 * the saved memory. A text that is already saved in the same scope updates that memory instead.
 */
export function saveMemory(memories: Memory[], input: MemoryInput, now = Date.now()): { memories: Memory[]; memory: Memory; created: boolean } {
  const text = input.text.replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("A memory needs text.");
  if (text.length > MEMORY_MAX_CHARS) throw new Error(`A memory is at most ${MEMORY_MAX_CHARS} characters (this one has ${text.length}). Keep it to one fact, or split it.`);
  if (input.scope === "workspace" && !input.workspace) throw new Error("A workspace memory needs a workspace folder.");
  const place = input.scope === "workspace" ? { scope: "workspace" as const, workspace: input.workspace! } : { scope: "global" as const };
  const samePlace = (m: Memory) => m.scope === place.scope && (place.scope === "global" || workspaceKey(m.workspace ?? "") === workspaceKey(place.workspace));
  let existing = input.id ? memories.find((m) => m.id === input.id) : undefined;
  if (input.id && !existing) throw new Error(`No memory ${input.id}.`);
  existing ??= memories.find((m) => samePlace(m) && m.text === text);
  if (existing) {
    const { workspace: _old, ...rest } = existing;
    const memory: Memory = { ...rest, ...place, text, by: input.by, ...(input.thread ? { thread: input.thread } : {}), updatedAt: now };
    return { memories: memories.map((m) => (m.id === memory.id ? memory : m)), memory, created: false };
  }
  if (memories.length >= MEMORY_MAX_COUNT) throw new Error(`There are already ${MEMORY_MAX_COUNT} memories. Delete or merge some first.`);
  const memory: Memory = { id: `m_${crypto.randomBytes(4).toString("hex")}`, ...place, text, by: input.by, ...(input.thread ? { thread: input.thread } : {}), createdAt: now, updatedAt: now };
  return { memories: [...memories, memory], memory, created: true };
}

/** The memories as the block a thread's instructions carry, newest first, within the room they may take. */
export function memoryBlock(memories: Memory[], max = MEMORY_PROMPT_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  let left = 0;
  for (const m of memories) {
    const line = `- [${m.id}] (${m.scope === "global" ? "global" : "workspace"}) ${m.text.replaceAll("</memories>", "</ memories>").replace(/\n+/g, "\n  ")}`;
    if (lines.length && used + line.length > max) {
      left += 1;
      continue;
    }
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return "<memories>\nNone saved yet.\n</memories>";
  if (left) lines.push(`(${left} older ${left === 1 ? "memory is" : "memories are"} not shown; memory_list has them.)`);
  return `<memories>\n${lines.join("\n")}\n</memories>`;
}
