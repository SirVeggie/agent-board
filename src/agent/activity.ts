/** A compact summary of what a thread is doing, for the activity flyout and toasts (no transcript needed). */

import type { Item, RunStatus, ThreadView } from "./types.js";

const LINE_MAX = 160;
const TEXT_MAX = 240;

/** Markdown down to one line of plain text. */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\n+/);
  return clip(plainText(lines[lines.length - 1] || ""), LINE_MAX);
}

/** A helper thread's title and model, by thread id. */
export type HelperLookup = (id: string) => { title: string; model?: string | null } | undefined;

/** An agent_run call names the helper and its model, not the tool. Keep in sync with helperLine in public/agent.js */
function helperLine(item: Item & { kind: "tool" }, helperOf?: HelperLookup): string {
  const input = item.input && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const helper = helperOf?.(item.helper || text(input.thread));
  const name = helper ? helper.title.replace(/^Helper:\s*/, "") : text(input.task).split("\n")[0];
  const model = helper?.model || text(input.model) || text(input.provider);
  return ["Helper", clip(plainText(name), 120), model].filter(Boolean).join(" · ");
}

/** The step a top-level item shows as the live line, or null when it has none. */
function stepLine(item: Item, helperOf?: HelperLookup): string | null {
  if (item.kind === "tool") {
    if (/agent_run$/.test(item.name) || /agent_run$/.test(item.title)) return clip(helperLine(item, helperOf), LINE_MAX);
    if (item.tool === "execute" && item.detail) return clip(`$ ${item.detail}`, LINE_MAX);
    return clip(item.title, LINE_MAX);
  }
  if (item.kind === "text") return lastLine(item.text) || null;
  if (item.kind === "reasoning") return "Thinking…";
  return null;
}

/**
 * Running threads: the latest step (tool, text or thinking) as `line`. Every thread with a reply:
 * the latest agent message as `lastText`. Idle threads the user has read get nothing.
 */
export function threadActivity(items: Item[], status: RunStatus, unread: boolean, helperOf?: HelperLookup): ThreadView["activity"] {
  if (status === "idle" && !unread) return undefined;
  let line: string | null = null;
  let lastText: string | undefined;
  for (let i = items.length - 1; i >= 0 && (line === null || lastText === undefined); i--) {
    const item = items[i];
    if ("parentToolId" in item && item.parentToolId) continue;
    if (line === null && status !== "idle") line = stepLine(item, helperOf);
    if (lastText === undefined && item.kind === "text" && item.text.trim()) lastText = clip(plainText(item.text), TEXT_MAX);
    if (item.kind === "user" && !item.steer && line === null && status !== "idle") line = "Working…";
  }
  if (line === null) line = status === "idle" ? "Reply ready" : "Working…";
  return { line, ...(lastText ? { lastText } : {}) };
}

/** Compares two activities, to skip resending a thread whose live step did not change. */
export function activityKey(activity: NonNullable<ThreadView["activity"]>): string {
  return `${activity.line}\n${activity.lastText ?? ""}`;
}
