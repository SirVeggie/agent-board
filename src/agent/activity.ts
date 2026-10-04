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

/** The step a top-level item shows as the live line, or null when it has none. */
function stepLine(item: Item): string | null {
  if (item.kind === "tool") {
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
export function threadActivity(items: Item[], status: RunStatus, unread: boolean): ThreadView["activity"] {
  if (status === "idle" && !unread) return undefined;
  let line: string | null = null;
  let lastText: string | undefined;
  for (let i = items.length - 1; i >= 0 && (line === null || lastText === undefined); i--) {
    const item = items[i];
    if ("parentToolId" in item && item.parentToolId) continue;
    if (line === null && status !== "idle") line = stepLine(item);
    if (lastText === undefined && item.kind === "text" && item.text.trim()) lastText = clip(plainText(item.text), TEXT_MAX);
    if (item.kind === "user" && !item.steer && line === null) line = "Working…";
  }
  if (line === null) line = status === "idle" ? "Reply ready" : "Working…";
  return { line, ...(lastText ? { lastText } : {}) };
}

/** Compares two activities, to skip resending a thread whose live step did not change. */
export function activityKey(activity: NonNullable<ThreadView["activity"]>): string {
  return `${activity.line}\n${activity.lastText ?? ""}`;
}
