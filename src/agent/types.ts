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
  /** Working directory for file and shell tools. */
  cwd: string | null;
  /** Provider session id used to resume. */
  nativeId: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  /** Last user message or finished turn; drives list order. */
  activityAt: number;
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
  files?: FileChange[];
  usage?: Usage;
  error?: string;
  reverted?: boolean;
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

export type ChatImage = { name: string; mimeType: string; data: string };

export type ContextChip =
  | { kind: "page"; id: string; key: string; title: string }
  | { kind: "folder"; id: string; path: string }
  | { kind: "file"; path: string }
  | { kind: "selection"; text: string; source?: string };

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
      images?: Array<{ name: string; mimeType: string }>;
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
  | { type: "agent_turn"; turn: Turn };

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
