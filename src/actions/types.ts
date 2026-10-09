import type { PageRunView, RunNote } from "../agent/pageRuns.js";
import type { BoardState, TemplateValues } from "../types.js";

/** Who runs an action. Agents carry their MCP session, and the chat thread when Scribe started them. */
export type ActionCaller = {
  by: "user" | "agent";
  /** Short name for the holder of a claim, e.g. "Claude Code" or a thread title. */
  label?: string;
  /** In-app chat provider id (`claude` | `cursor` | `codex` | `pi`), when Scribe started the agent. */
  provider?: string;
  /** One MCP server process. Every call it makes counts as a sign of life for its claims. */
  session?: string;
  /** Scribe chat thread the agent runs in. */
  thread?: string;
};

export type ActionContext = {
  caller: ActionCaller;
  now: number;
  /** The page's template form values. */
  values: TemplateValues;
  /** How a chat thread is doing, when the daemon runs agents. */
  thread?(id: string): ThreadRunInfo;
};

export type ActionEvent = { name: string; data?: unknown };

export type ActionOutcome = {
  /** Applied strictly to the state the action read: all or nothing. */
  ops: unknown[];
  /** Returned to the caller. */
  result: unknown;
  /** Logged on the page after the ops. */
  events?: ActionEvent[];
};

export type ActionDef = {
  description: string;
  /** Argument summary for the guide and tool errors, e.g. "{ card, to, position? }". */
  args: string;
  run(state: BoardState, args: Record<string, unknown>, ctx: ActionContext): ActionOutcome;
};

/** How a chat thread is doing, for releasing claims of agents that stopped. */
export type ThreadRunInfo =
  | { exists: false }
  | {
      exists: true;
      running: boolean;
      title: string;
      /** Latest text, reasoning, or tool call received in the current or most recent turn. */
      outputAt?: number;
      lastTurn?: { status: string; endedAt?: number; error?: string; limitResetsAt?: number; usageRecoveryAllowed?: boolean };
      /** Token totals across the thread's non-reverted turns, so a board can log them when the chat ends. */
      usage?: {
        turns: number;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        reasoningTokens?: number;
        costUsd?: number;
      };
      /** While the page has handed the thread to Scribe as a run: its phase, limit wait, and outcome once ended. */
      run?: PageRunView;
      /** While the turn waits on the user: the question (a page_ask page too), approval or plan. */
      asking?: { kind: "approval" | "question" | "plan"; title: string; page?: { key: string; title: string } };
    };

export type SweepContext = {
  now: number;
  thread(id: string): ThreadRunInfo;
  /** Last request from an MCP session, if this daemon has seen one. */
  sessionSeenAt(session: string): number | undefined;
};

export type ActionSet = {
  actions: Record<string, ActionDef>;
  /** Periodic check, e.g. for claims whose agent stopped. Returns null when nothing changes. */
  sweep?(state: BoardState, ctx: SweepContext): ActionOutcome | null;
  /** A run of this page's (see agent/pageRuns.ts) is done and would merge: a reason to keep its branch unmerged, or null. */
  runHold?(state: BoardState, threadId: string): string | null;
  /** Scribe moved one of the page's runs on (a limit wait, a resume, a merge fix, its end), e.g. to log it on the page. */
  runEvent?(state: BoardState, event: RunEvent, now: number): ActionOutcome | null;
};

export type RunEvent = RunNote & { thread: string; run: PageRunView };

export class ActionError extends Error {}

export function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function arr<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
