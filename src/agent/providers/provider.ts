import type {
  ApprovalOption,
  ChatImage,
  ModelOption,
  ProviderId,
  ProviderStatus,
  QuestionSpec,
  SlashCommand,
  Thread,
  ToolKind,
  ToolStatus,
  Usage,
} from "../types.js";

/** What the host hands a provider for one turn. */
export type TurnInput = {
  /** Text sent to the model, with context blocks already prepended. */
  text: string;
  images: ChatImage[];
  /** Extra system instructions for this thread (board context, link syntax). */
  instructions: string;
};

export type ToolStart = {
  toolId: string;
  name: string;
  tool: ToolKind;
  title: string;
  detail?: string;
  input?: unknown;
  paths?: string[];
  parentToolId?: string;
  status?: ToolStatus;
};

export type ToolPatch = {
  title?: string;
  detail?: string;
  input?: unknown;
  status?: ToolStatus;
  output?: string;
  paths?: string[];
  exitCode?: number;
  /** Diff the provider reported; the host prefers its own before/after snapshot when it has one. */
  providerDiff?: Array<{ path: string; oldText: string | null; newText: string | null }>;
};

export type ApprovalRequest = {
  toolId?: string;
  tool: ToolKind;
  title: string;
  detail?: string;
  options: ApprovalOption[];
};

export type ApprovalDecision = { optionId: string; note?: string };

export type QuestionRequest = { title?: string; questions: QuestionSpec[] };

export type QuestionAnswer = { answers: Record<string, string[]>; notes?: Record<string, string> } | { skipped: true; reason?: string };

export type PlanRequest = { title?: string; text: string };

export type PlanDecision = { accepted: boolean; note?: string };

/** Callbacks a provider uses to report a run. All of them are cheap and synchronous except the ones that wait on the user. */
export type RunSink = {
  nativeId(id: string): void;
  text(delta: string, parentToolId?: string): void;
  reasoning(delta: string, parentToolId?: string): void;
  /** Ends the current text or reasoning block so the next delta starts a new one. */
  breakBlock(): void;
  toolStart(tool: ToolStart): void;
  toolUpdate(toolId: string, patch: ToolPatch): void;
  /** Called by a provider right before a tool writes `path` (Claude's PreToolUse hook), so the host can keep the old content. */
  beforeWrite(toolId: string, path: string): Promise<void>;
  approval(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  question(req: QuestionRequest, signal?: AbortSignal): Promise<QuestionAnswer>;
  plan(req: PlanRequest, signal?: AbortSignal): Promise<PlanDecision>;
  todos(todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>): void;
  usage(usage: Usage): void;
  notice(level: "info" | "warn" | "error", text: string): void;
  commands(commands: SlashCommand[]): void;
  title(title: string): void;
  /** The provider switched its own mode (plan accepted, etc.). */
  modeChanged?(mode: Thread["mode"]): void;
};

export type TurnResult = { status: "done" | "error" | "cancelled"; error?: string };

/** One live conversation with a provider, bound to a thread. */
export interface ProviderSession {
  run(input: TurnInput, sink: RunSink): Promise<TurnResult>;
  cancel(): Promise<void>;
  /** The thread's settings changed; apply them live or restart before the next turn. */
  update(thread: Thread): void;
  commands(): Promise<SlashCommand[]>;
  dispose(): void;
}

export type SessionContext = {
  /** The daemon's own board MCP command, so the agent's board tools reach this board. */
  boardMcp: { command: string; args: string[]; env: Record<string, string> };
  /** Scratch working directory for threads without a workspace. */
  scratchDir: string;
};

export interface AgentProvider {
  readonly id: ProviderId;
  readonly label: string;
  status(): Promise<ProviderStatus>;
  models(refresh?: boolean): Promise<ModelOption[]>;
  createSession(thread: Thread, ctx: SessionContext): ProviderSession;
  dispose(): void;
}
