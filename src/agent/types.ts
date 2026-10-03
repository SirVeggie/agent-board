/** Agent chat: threads, turns, and the display transcript shared by every provider. */

export type ProviderId = "claude" | "cursor";

/** What the agent may touch. Chosen per thread; the provider maps it onto its own tools and modes. */
export type ThreadMode = "code" | "ask" | "plan" | "board";

/** How tool calls that need permission are answered. */
export type ApprovalPolicy = "ask" | "edits" | "auto" | "full";

export type ScopeKind = "global" | "workspace" | "folder" | "page";

export type ThreadScope = {
  kind: ScopeKind;
  /** Page id, folder id, or absolute workspace path. Null for global. */
  ref: string | null;
};

export type Thread = {
  id: string;
  title: string;
  /** The user renamed it; provider title suggestions are ignored. */
  titleLocked: boolean;
  provider: ProviderId;
  model: string;
  /** Reasoning level (Claude effort, Cursor thought_level option). Null means the model default. */
  effort: string | null;
  /** Extra model parameters, e.g. Cursor's { fast: "false", context: "300k" }. */
  modelParams: Record<string, string>;
  mode: ThreadMode;
  approval: ApprovalPolicy;
  /** Web search and fetch tools. */
  web: boolean;
  scope: ThreadScope;
  /** Working directory for file and shell tools. While the thread has an open worktree, a folder inside it. */
  cwd: string | null;
  /** Work in a git worktree of its own. The worktree is made on the first message. */
  useWorktree?: boolean;
  worktree?: ThreadWorktree | null;
  /** Provider session id used to resume. */
  nativeId: string | null;
  /**
   * Set by a rewind until the next turn ends. at: the provider transcript entry the next turn
   * continues from (Claude forks its session there); null starts a fresh session. recap: the kept
   * conversation, sent ahead of the next message when the provider cannot fork.
   */
  rewind?: { at: string | null; recap?: string };
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  /** Last user message or finished turn; drives list order. */
  activityAt: number;
};

/** A git worktree the board made for a thread, on a branch of its own. */
export type ThreadWorktree = {
  /** The folder the user picked, in the main checkout. The thread goes back to it when the worktree closes. */
  home: string;
  /** Top level of the main checkout. */
  repo: string;
  /** Top level of the worktree. */
  path: string;
  branch: string;
  /** Branch the worktree started from; null when the main checkout was on a detached HEAD. */
  base: string | null;
  baseCommit: string;
  /** Repo-relative folders linked in from the main checkout (node_modules and the like). */
  links: string[];
  createdAt: number;
  /** As of the last turn: commits not in the base yet, and uncommitted changes. */
  ahead?: number;
  dirty?: boolean;
  closed?: { how: "merged" | "left" | "removed"; at: number };
};

export type RunStatus = "idle" | "running" | "waiting";

/** How much of a subscription's usage windows is used, as the provider last reported it. */
export type PlanLimits = {
  /** When the provider reported it. */
  at: number;
  /** "allowed", "allowed_warning" or "rejected" (Claude). */
  status?: string;
  windows: Array<{ id: string; label: string; utilization: number; resetsAt?: number }>;
  /** Requests are being billed as extra usage beyond the plan. */
  overage?: boolean;
};

/** Thread plus runtime fields the UI needs in lists. */
export type ThreadView = Thread & {
  status: RunStatus;
  unread: boolean;
  queued: number;
  /** Subagents and commands still working in the background, after or beside the current turn. */
  background: number;
  stats: { turns: number; files: number; added: number; removed: number };
};

export type FileChange = {
  path: string;
  status: "A" | "M" | "D" | "R";
  added: number;
  removed: number;
  oldPath?: string;
  binary?: boolean;
};

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** How much of each subscription window this turn used (0–1 of that window). Claude only. */
  plan?: Array<{ id: string; label: string; used: number }>;
};

export type TurnStatus = "running" | "done" | "error" | "cancelled";

export type Turn = {
  id: string;
  threadId: string;
  seq: number;
  status: TurnStatus;
  model: string;
  effort: string | null;
  mode: ThreadMode;
  startedAt: number;
  endedAt?: number;
  /** Git tree of the working copy before and after the turn (temp index, untracked included). */
  repo?: string;
  beforeTree?: string;
  afterTree?: string;
  /** HEAD before and after, for worktree turns, so a revert also undoes the turn's commits. */
  beforeHead?: string;
  afterHead?: string;
  files?: FileChange[];
  usage?: Usage;
  error?: string;
  reverted?: boolean;
  /** This turn's last entry in the provider's own transcript (Claude's chain uuid): where a rewind to after this turn forks. */
  nativeEnd?: string;
  /** The board page this turn could edit, by HTML revision before and after. The old HTML is kept as a checkpoint. */
  page?: { id: string; title: string; before: number; after?: number; reverted?: boolean };
};

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "fetch" | "think" | "mcp" | "task" | "todo" | "other";

export type ToolStatus = "pending" | "running" | "done" | "error";

export type ApprovalOption = {
  id: string;
  label: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

export type QuestionSpec = {
  id: string;
  prompt: string;
  header?: string;
  multi: boolean;
  options: Array<{ id: string; label: string; description?: string }>;
};

/** A file sent with a message, as base64. Images go to the model as images; other files see attachments.ts. */
export type ChatFile = { name: string; mimeType: string; data: string };
export type ChatImage = ChatFile;
/** A sent file as the transcript keeps it: saved under the data folder, served by id. */
export type FileRef = { id: string; name: string; mimeType: string; size: number; path?: string };

export type ContextChip =
  | { kind: "page"; id: string; key: string; title: string }
  | { kind: "folder"; id: string; path: string }
  | { kind: "file"; path: string }
  | { kind: "selection"; text: string; source?: string };

/** A provider task (Claude's subagents and background commands), as the tool that started it shows it. */
export type TaskInfo = {
  id: string;
  /** "agent" for subagents, "command" for background shell commands, or the provider's own type. */
  type: string;
  status: "running" | "done" | "error" | "stopped";
  /** Runs without blocking the turn; it may still be working after the turn ends. */
  background?: boolean;
  /** One line on what it is doing now, or how it ended. */
  summary?: string;
  lastTool?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  endedAt?: number;
};

type ItemBase = {
  id: string;
  threadId: string;
  turnId: string | null;
  seq: number;
  createdAt: number;
};

export type ItemBody =
  | {
      kind: "user";
      text: string;
      /** id and size are missing on messages from before files were saved. */
      images?: Array<{ name: string; mimeType: string; id?: string; size?: number }>;
      files?: FileRef[];
      context?: ContextChip[];
      /** Queued, then dropped by Stop. */
      dropped?: boolean;
      /** Sent into a running turn: "waiting" until the agent takes it in, then "folded" (it belongs to that turn). */
      steer?: "waiting" | "folded";
      /** Sent by the code of the thread's page (board.agent), not typed by the user. */
      from?: "page";
    }
  | { kind: "text"; text: string; parentToolId?: string }
  | { kind: "reasoning"; text: string; startedAt: number; endedAt?: number; parentToolId?: string }
  | {
      kind: "tool";
      toolId: string;
      name: string;
      tool: ToolKind;
      title: string;
      detail?: string;
      input?: unknown;
      status: ToolStatus;
      output?: string;
      paths?: string[];
      files?: Array<{ path: string; added: number; removed: number; status?: "A" | "M" | "D" }>;
      diff?: string;
      exitCode?: number;
      parentToolId?: string;
      /** A subagent or background command this tool started; it can outlive the tool call and the turn. */
      task?: TaskInfo;
      startedAt: number;
      endedAt?: number;
    }
  | {
      kind: "approval";
      requestId: string;
      toolId?: string;
      tool: ToolKind;
      title: string;
      detail?: string;
      options: ApprovalOption[];
      status: "pending" | "resolved" | "expired";
      decision?: string;
      note?: string;
    }
  | {
      kind: "question";
      requestId: string;
      title?: string;
      questions: QuestionSpec[];
      status: "pending" | "answered" | "skipped" | "expired";
      answers?: Record<string, string[]>;
      notes?: Record<string, string>;
    }
  | {
      kind: "plan";
      requestId?: string;
      title?: string;
      text: string;
      status: "pending" | "accepted" | "rejected" | "shown";
      note?: string;
    }
  | { kind: "todos"; todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string };

export type Item = ItemBase & ItemBody;

export type AgentEvent =
  | { type: "agent_thread"; thread: ThreadView }
  | { type: "agent_thread_deleted"; id: string }
  | { type: "agent_item"; item: Item }
  | { type: "agent_item_deleted"; threadId: string; id: string }
  | { type: "agent_limits"; limits: Partial<Record<ProviderId, PlanLimits>> }
  | { type: "agent_delta"; threadId: string; itemId: string; append: string }
  | { type: "agent_turn"; turn: Turn }
  | { type: "agent_turn_deleted"; threadId: string; id: string };

export type ModelOption = {
  id: string;
  label: string;
  provider: ProviderId;
  description?: string;
  /** Reasoning levels; empty when the model has no control. */
  efforts: Array<{ id: string; label: string }>;
  defaultEffort?: string | null;
  /** Provider parameter id the effort maps onto (Cursor: effort, reasoning_effort, reasoning, thinking). */
  effortParam?: string;
  /** Other selectable parameters (Cursor: fast, context, thinking). */
  params: Array<{ id: string; label: string; description?: string; options: Array<{ id: string; label: string }>; default: string }>;
};

export type SlashCommand = { name: string; description?: string; hint?: string };

export type ProviderStatus = {
  id: ProviderId;
  label: string;
  available: boolean;
  detail?: string;
};

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
