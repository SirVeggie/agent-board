import os from "node:os";
import path from "node:path";
import type { Chunk, Detector, Hit } from "./hooks.js";

/**
 * Page-creation intent (docs/intent-detection-hooks-design.md, "First feature"): detectors that tell
 * the shell a floating chat is about to write a new page, so its creating screen starts before the
 * page_show call does. Each one signals `page_create` with a stage:
 *
 * - hint: the classifier's guess from the user's message. The shell shows a light hint and the page
 *   stays usable.
 * - confirmed: the agent said so itself (the page_intent tool), or wrote an HTML file outside its
 *   workspace. The shell shows the creating screen. No classifier is involved.
 *
 * A page_show call for a new page is still read by the chat itself (newPageCall in public/agent.js),
 * which knows whether the key exists and sees the call while Claude streams it.
 */

export const PAGE_INTENT_SIGNAL = "page_create";
/** The Classifier feature switch for the hint (Settings, Classifier). */
export const PAGE_INTENT_FEATURE = "page-intent";
export const PAGE_INTENT_QUESTION = "Will answering this message require creating a new Scribe page?";
/**
 * How sure the classifier must be before the hint shows. Not measured on real traffic yet: run
 * tools/replay-page-intent.ts over your own floating-chat turns and set it from its table.
 */
export const PAGE_HINT_THRESHOLD = 0.75;

/** What the agent is told with a message from the floating chat (promptText in host.ts). */
export const PAGE_INTENT_NOTE =
  "Sent from the floating chat over the page the user is looking at. If you are going to create a new page for them to look at (page_show or template_open, not in the background), call page_intent with its title first, in the same step as your first other tool call, so Scribe can show its creating screen while you write. Skip it when you only answer, change an existing page, or make a background page.";

function signal(stage: "hint" | "confirmed", title?: string, confidence?: number): Hit {
  return { actions: [{ kind: "signal", name: PAGE_INTENT_SIGNAL, stage, ...(title ? { title } : {}) }], ...(confidence !== undefined ? { confidence } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Claude names the call mcp__scribe__page_intent; Cursor and Pi title it "Scribe: page_intent"; Codex names the tool in its title. */
function isPageIntentCall(tool: NonNullable<Chunk["tool"]>): boolean {
  return [tool.name, tool.title].some((name) => /(^|[^a-z])page_intent\b/i.test(name ?? ""));
}

function intentTitle(input: unknown): string {
  if (!isRecord(input)) return "";
  const args = isRecord(input.arguments) ? input.arguments : input;
  return typeof args.title === "string" ? args.title.trim().slice(0, 200) : "";
}

function inside(folder: string, file: string): boolean {
  const rel = path.relative(folder, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * An HTML file the agent writes: outside its workspace (a temp or scratch file) it is a page on its
 * way to page_show's htmlPath; inside the workspace it may as well be the project's own file.
 */
export function htmlWriteStage(chunk: Chunk, tmp = os.tmpdir()): "hint" | "confirmed" | null {
  const tool = chunk.tool;
  if (!tool || tool.kind !== "edit") return null;
  const files = (tool.paths ?? []).filter((file) => /\.html?$/i.test(file));
  if (!files.length) return null;
  const cwd = chunk.cwd;
  const scratch = (file: string) => {
    const full = path.resolve(cwd ?? tmp, file);
    return inside(tmp, full) || !cwd || !inside(cwd, full);
  };
  return files.some(scratch) ? "confirmed" : "hint";
}

/** The detectors the agent host adds beside the user's rules. They watch floating-chat turns only. */
export function pageIntentDetectors(): Detector[] {
  const where = { dock: true, worker: false };
  const base = { label: "Page intent", observing: true, where };
  return [
    {
      ...base,
      id: "page-intent:message",
      on: ["prompt"],
      feature: PAGE_INTENT_FEATURE,
      ask: () => ({ page: { type: "yesno", instructions: PAGE_INTENT_QUESTION } }),
      decide: (answers) => {
        const answer = answers.page;
        return answer?.type === "yesno" && answer.yes >= PAGE_HINT_THRESHOLD ? signal("hint", undefined, answer.yes) : null;
      },
    },
    {
      ...base,
      id: "page-intent:announce",
      on: ["tool_call"],
      rule: (chunk) => (chunk.tool && isPageIntentCall(chunk.tool) ? signal("confirmed", intentTitle(chunk.tool.input)) : "pass"),
    },
    {
      ...base,
      id: "page-intent:html",
      on: ["tool_call"],
      rule: (chunk) => {
        const stage = htmlWriteStage(chunk);
        return stage ? signal(stage) : "pass";
      },
    },
  ];
}
