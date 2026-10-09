import type { ThreadRunInfo } from "../actions/types.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, dataDir } from "../config.js";
import { closeThreadBrowser } from "../browser.js";
import { log } from "../log.js";
import type { ActionCaller } from "../actions/types.js";
import { store } from "../store.js";
import { waitForEvents } from "../wait.js";
import { isBlankPage, type PageEvent } from "../types.js";
import { AgentDb } from "./db.js";
import { diffPatch, diffTrees, fileAtTree, findRepo, repoRelative, revertTrees, snapshotTree } from "./git.js";
import { syncDependencies } from "./deps.js";
import { commitAll, createWorktree, dropBranchIfEmpty, headCommit, mergeWorktree, removeWorktree, reopenWorktree, resetHead, unlinkOrphanedWorktrees, worktreeProgress, worktreeStatus, type WorktreeStatus } from "./worktree.js";
import { lastSeenPages, pageEditsBlock, pageEditsSince, rememberPages, writePageRefs, type PageSnapshot } from "./pageEdits.js";
import { contextBlock, freshContext, guidesBlock, pageKeysIn, threadInstructions, type PageGuide, type ScopeInfo } from "./prompt.js";
import { forgetGuides, guideSent, markGuideSent } from "../guideMemory.js";
import { filePath, filesBlock, removeFiles, removeThreadFiles, saveFiles } from "./attachments.js";
import { ClaudeProvider } from "./providers/claude.js";
import { CodexProvider, fetchCodexPlanUsage } from "./providers/codex.js";
import { CursorProvider, isSdkAgentId } from "./providers/cursor.js";
import { FAKE_AGENTS, FakeProvider } from "./providers/fake.js";
import { PiProvider } from "./providers/pi.js";
import { migrateOpenaiPrefs, migrateOpenaiThread } from "./legacyOpenai.js";
import { normalizeSource, sourceView, type OpenAISource, type OpenAISourceView } from "./openaiSources.js";
import type {
  AgentProvider,
  ApprovalDecision,
  ApprovalRequest,
  PlanDecision,
  PlanRequest,
  ProviderSession,
  QuestionAnswer,
  QuestionRequest,
  RunSink,
  SessionContext,
  ToolPatch,
  ToolStart,
  TurnResult,
} from "./providers/provider.js";
import { unifiedDiff } from "./textDiff.js";
import { MAX_FORK_MESSAGE, MAX_FORK_MIDDLE, clip, forkBlock, summaryPrompt, type ForkMaterial } from "./fork.js";
import { applyExpiredWindows, codexUsageRecoveryAllowed, livePlanLimits, nextRefreshAt, planLimitsFromCodexRateLimits, planLimitsFromCursorUsage, planLimitsFromRateLimitInfo, planLimitsFromUsageReport, usageLimitResetsAt } from "./planLimits.js";
import { pageThreadWorkspace, type PageChatThread } from "./pageChat.js";
import { serversForThread } from "./mcpConfig.js";
import { cleanDisabledModes, DEFAULT_PREFS, modelChoice, prefsPatchFromChoices, seedModelSettings, settingPatch, workspaceKey, type Prefs } from "./prefs.js";
import { pageOwned } from "./threadList.js";
import { activityKey, threadActivity } from "./activity.js";
import { allowedGrants, canReadThread, grantScopes, itemMatches, itemText, queryWords, requestableScopes, scopeLabel, scopesGranted, threadScopeLabel, type AccessScope, type ScopeLookup } from "./threadAccess.js";
import { grantRows, revokeGrant } from "./grants.js";
import { WEB_IMPORTANCE_WAIT_MS, cleanAllowlist, grantWeb, parseWebAccess, webCallAllowed, webCallDomains, webPassCovers, type WebCall, type WebImportance } from "./webAccess.js";
import type {
  AgentEvent,
  ApprovalOption,
  ApprovalPolicy,
  ChatFile,
  ChatImage,
  ContextChip,
  FileChange,
  FileRef,
  Item,
  ItemBody,
  ModelOption,
  PlanLimits,
  ProviderId,
  ProviderStatus,
  RunStatus,
  SlashCommand,
  Thread,
  ThreadMode,
  ThreadScope,
  ThreadView,
  ThreadWorktree,
  TaskInfo,
  Turn,
  Usage,
} from "./types.js";

export type { Prefs } from "./prefs.js";
export { workspaceKey } from "./prefs.js";

const FLUSH_MS = 700;
/** Cursor's usage comes from a private API call, so refresh it at most this often (after turns). */
const CURSOR_USAGE_TTL_MS = 10 * 60 * 1000;
/** Characters of earlier conversation sent after a rewind to a provider that cannot fork. */
const MAX_RECAP = 24_000;
/** Providers drop the saved sessions no thread uses a few minutes after start, then every few hours. */
const PRUNE_FIRST_MS = 5 * 60 * 1000;
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
const DELTA_MS = 50;
/** At most this often, a running thread is sent again because its live step changed. */
const ACTIVITY_MS = 1000;
const MAX_TOOL_OUTPUT = 20_000;
const MAX_TOOL_DIFF = 200_000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** How long an "Allow once" from web_request waits for the call it allowed. */
const WEB_PASS_MS = 10 * 60 * 1000;

/** The thread's worktree while it is open. */
export function openWorktree(thread: Thread): ThreadWorktree | null {
  return thread.worktree && !thread.worktree.closed ? thread.worktree : null;
}

/** Code and Plan threads in a workspace can have a worktree; Pages and Ask never edit files. */
function wantsWorktree(thread: Thread): boolean {
  return Boolean(thread.useWorktree && thread.cwd && (thread.mode === "code" || thread.mode === "plan") && !openWorktree(thread));
}

type Pending =
  | { kind: "approval"; threadId: string; itemId: string; resolve: (d: ApprovalDecision) => void; reject: (err: Error) => void }
  | { kind: "question"; threadId: string; itemId: string; resolve: (a: QuestionAnswer) => void; reject: (err: Error) => void }
  | { kind: "plan"; threadId: string; itemId: string; resolve: (d: PlanDecision) => void; reject: (err: Error) => void };

function approvalFor(prefs: Prefs, provider: ProviderId): ApprovalPolicy {
  return prefs.approvals[provider] ?? prefs.approval;
}

function snapshotWindows(limits?: PlanLimits): PlanLimits["windows"] {
  return (limits?.windows ?? []).map((w) => ({ ...w }));
}

/** How much of each window this turn used, from the snapshot taken when it started. */
function planUsed(before: PlanLimits["windows"], after: PlanLimits["windows"]): NonNullable<Usage["plan"]> {
  return after
    .map((w) => {
      const prev = before.find((x) => x.id === w.id);
      const used = prev ? Math.max(0, w.utilization - prev.utilization) : 0;
      return { id: w.id, label: w.label, used };
    })
    .filter((w) => w.used >= 0.0005);
}

type QueuedMessage = {
  itemId?: string;
  edit?: { token: string; steer: boolean; withdrawal?: Promise<boolean> };
  text: string;
  images: ChatImage[];
  /** Attached files other than images. */
  files: ChatFile[];
  /** Where the images and files were saved, in the same order. */
  saved: { images: FileRef[]; files: FileRef[] };
  context: ContextChip[];
  from?: "page" | "scribe";
  /** A Kanban card the board sent this about (a comment on it, or Continue). */
  card?: CardRef;
};

/** The Kanban card a board message is about: its number and the board page it is on. */
export type CardRef = { num: number; title?: string; board: string; boardKey?: string; resume?: boolean };

/** Where a board message about a card came from; the host words it, so a page cannot pass one off as the user's. */
function cardOrigin(card: CardRef): string {
  const board = card.board ? `the Kanban board "${card.board}"${card.boardKey ? ` (${card.boardKey})` : ""}` : "its Kanban board";
  const name = `card #${card.num}${card.title ? ` "${card.title}"` : ""}`;
  const why = card.resume
    ? `The user pressed Continue on ${name} of ${board}, which you worked on before. The board sent this, not the user in this chat.`
    : `A new comment on ${name} of ${board}, which you are working on. The board passed it on: it was posted on the card, not typed in this chat. Take it into account in your work on the card, and answer it on the card if it asks something.`;
  return `<context>\n${why}\n</context>\n\n`;
}

/** How many restarts in a row may cut off a thread's turns before Scribe stops sending it on (a turn that crashes Scribe would loop). */
const MAX_RESUMES = 3;

/** The turns at the end that a restart cut off, in a row. */
function interruptedRun(turns: Turn[]): number {
  let n = 0;
  for (let i = turns.length - 1; i >= 0 && turns[i].interrupted; i--) n++;
  return n;
}

const RESUME_NOTE =
  "Scribe restarted while you were working, and your last turn was cut off. Anything you were waiting on in it (a question, an approval, a background command) is gone. Check where you left off (files, git status, the pages or card you were working on) and go on from there to finish the task. If you were waiting for the user's answer, ask again.";

/** What the model reads for a message: where it came from, its context chips, the guides of the pages it brings up, its files, then the text. */
function promptText(msg: QueuedMessage, thread: Thread, guides: string, pageEdits = ""): string {
  const origin = msg.card
    ? cardOrigin(msg.card)
    : msg.from === "page"
      ? "<context>\nSent by the code of the Scribe page this thread belongs to (scribe.agent), not typed by the user.\n</context>\n\n"
      : msg.from === "scribe"
        ? "<context>\nSent by Scribe itself, not typed by the user.\n</context>\n\n"
        : "";
  const text = msg.card && !msg.card.resume ? `<card_comment>\n${msg.text}\n</card_comment>` : msg.text;
  const files = filesBlock(msg.files, msg.saved.files, { nativePdf: thread.provider === "claude", canReadFiles: thread.mode !== "board" });
  const recap = !thread.rewind?.recap
    ? ""
    : thread.rewind.migrated
      ? `<earlier_conversation>\nThis conversation moved to a new session, so you don't have its history. This is what was said so far, for context:\n\n${thread.rewind.recap}\n</earlier_conversation>\n\n`
      : `<earlier_conversation>\nThe user rewound this conversation and started a new session. This is what was said before the point they went back to, for context:\n\n${thread.rewind.recap}\n</earlier_conversation>\n\n`;
  return recap + origin + pageEdits + contextBlock(msg.context) + guides + files + text;
}

/**
 * Approvals the thread's settings answer without asking: Scribe's own board tools, Pages mode's
 * refusals, and the "full" and "edits" approval levels. Null when the user has to decide.
 * Codex Auto-review runs in the native app-server, before this callback. Do not
 * turn "auto" into an unconditional host grant; any fallback request still asks.
 */
function autoApproval(t: Thread | undefined, req: ApprovalRequest): Promise<ApprovalDecision> | null {
  const allow = req.options.find((o) => o.kind === "allow_once") ?? req.options.find((o) => o.kind === "allow_always");
  const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind === "reject_always");
  if (req.boardTool && allow) {
    return Promise.resolve({ optionId: allow.id });
  }
  if (t?.mode === "board" && req.tool !== "mcp" && req.tool !== "fetch" && req.tool !== "todo") {
    // Pages mode never runs file or shell tools, whatever the approval setting.
    if (reject) return Promise.resolve({ optionId: reject.id, note: "Pages mode has no file or shell access." });
    return Promise.reject(new Error("Pages mode has no file or shell access."));
  }
  if (t?.approval === "full" && allow) {
    return Promise.resolve({ optionId: allow.id });
  }
  if (t?.approval === "edits" && allow && (req.tool === "edit" || req.tool === "delete" || req.tool === "move")) {
    return Promise.resolve({ optionId: allow.id });
  }
  return null;
}

/** PDFs, for providers that read them as documents beside the text that names them. */
function pdfs(msg: QueuedMessage): ChatFile[] {
  return msg.files.filter((file) => file.mimeType === "application/pdf");
}

/** A saved file as the transcript keeps it: without its local path. */
function fileEntry(ref: FileRef): FileRef {
  return { id: ref.id, name: ref.name, mimeType: ref.mimeType, size: ref.size };
}

function userBody(msg: QueuedMessage): Extract<ItemBody, { kind: "user" }> {
  return {
    kind: "user",
    text: msg.text,
    ...(msg.saved.images.length ? { images: msg.saved.images.map(fileEntry) } : {}),
    ...(msg.saved.files.length ? { files: msg.saved.files.map(fileEntry) } : {}),
    ...(msg.context.length ? { context: msg.context } : {}),
    ...(msg.from ? { from: msg.from } : {}),
    ...(msg.card ? { card: { num: msg.card.num, ...(msg.card.title ? { title: msg.card.title } : {}), ...(msg.card.resume ? { resume: true } : {}) } } : {}),
  };
}

type RunState = {
  turn: Turn;
  textItem: Item | null;
  reasoningItem: Item | null;
  tools: Map<string, Item>;
  /** Last known content per absolute path this turn, for per-tool diffs. */
  known: Map<string, string | null>;
  repo: string | null;
  cancelled: boolean;
  usage: Usage;
  /** A queued message handed to this turn with steer, until the agent takes it in. */
  steer: { id: string; msg: QueuedMessage; itemId: string | undefined } | null;
  /** Stops the summary a fork's first turn waits for. */
  abort?: AbortController;
};

/** What page_ask hands back to the agent. */
export type PageAskResult =
  | { answered: true; page: { id: string; key: string }; events: PageEvent[]; cursor: number; state: unknown; stateRevision: number }
  | { answered: false; page: { id: string; key: string }; cursor: number; closed: boolean; deleted: boolean; timedOut: boolean }
  | { skipped: true; note?: string; page: { id: string; key: string } }
  | { cancelled: true; page: { id: string; key: string } };

export type SendInput = { text: string; images?: ChatImage[]; files?: ChatFile[]; context?: ContextChip[]; from?: "page" | "scribe"; card?: CardRef };

export class AgentHost {
  readonly db: AgentDb;
  private providers: Record<ProviderId, AgentProvider>;
  /** With SCRIBE_FAKE_AGENTS=1: what runs every provider's threads, so tests start no real agent. */
  private fakes: Record<ProviderId, AgentProvider> | null = null;
  private threads = new Map<string, Thread>();
  private sessions = new Map<string, ProviderSession>();
  private runs = new Map<string, RunState>();
  private status = new Map<string, RunStatus>();
  private unread = new Set<string>();
  private queues = new Map<string, QueuedMessage[]>();
  private items = new Map<string, Item[]>();
  private turns = new Map<string, Turn[]>();
  private seq = new Map<string, number>();
  private dirty = new Map<string, Item>();
  private pending = new Map<string, Pending>();
  /** "Allow once" answers to web_request, per thread, until a web call uses them. */
  private webPasses = new Map<string, Array<{ call: WebCall; at: number }>>();
  private commandCache = new Map<string, SlashCommand[]>();
  private deltaBuf = new Map<string, { threadId: string; text: string }>();
  private deltaTimer: NodeJS.Timeout | null = null;
  /** Per thread: the activity last sent with it, and a pending resend after a live step changed. */
  private activitySent = new Map<string, string>();
  private activityTimers = new Map<string, NodeJS.Timeout>();
  private flushTimer: NodeJS.Timeout | null = null;
  /** Threads whose turn a restart cut off, until resumeInterrupted sends them on. They count as running meanwhile. */
  private resuming = new Set<string>();
  private ctx: SessionContext;
  /** Last turn that should receive the next plan-usage report for its provider. Survives the run ending. */
  private limitTurn: { provider: ProviderId; threadId: string; turnId: string; before: PlanLimits["windows"] } | null = null;

  constructor(private emit: (event: AgentEvent) => void, private readCodexUsage: () => Promise<unknown> = fetchCodexPlanUsage) {
    this.db = new AgentDb();
    this.providers = { claude: new ClaudeProvider(), cursor: new CursorProvider(), codex: new CodexProvider(), pi: new PiProvider(() => this.modelSources()) };
    if (FAKE_AGENTS) {
      const deps = {
        runAction: (page: string, name: string, args: Record<string, unknown>, caller: ActionCaller) => store.runAction(page, name, args, caller, (id) => this.runInfo(id)).result,
        runInfo: (id: string) => this.runInfo(id),
        delayMs: Number(process.env.SCRIBE_FAKE_AGENT_DELAY) || undefined,
      };
      this.fakes = { claude: new FakeProvider("claude", "Claude", deps), cursor: new FakeProvider("cursor", "Cursor", deps), codex: new FakeProvider("codex", "Codex", deps), pi: new FakeProvider("pi", "Native", deps) };
      log("SCRIBE_FAKE_AGENTS=1: chats run fake agents (no model, tools or MCP)");
    }
    const claudeModels = this.db.getSetting<ModelOption[]>("models.claude", []);
    (this.providers.claude as ClaudeProvider).setModelCache(claudeModels);
    (this.providers.cursor as CursorProvider).setModelCache(this.db.getSetting<ModelOption[]>("models.cursor", []));
    (this.providers.codex as CodexProvider).setModelCache(this.db.getSetting<ModelOption[]>("models.codex", []));
    for (const thread of this.db.listThreads()) {
      if (migrateOpenaiThread(thread)) this.db.saveThread(thread);
      this.threads.set(thread.id, thread);
      // A turn cannot survive a daemon restart: mark leftovers as cancelled, and send the thread on once Scribe is up.
      const turns = this.db.listTurns(thread.id);
      for (const turn of turns) {
        if (turn.status === "running") {
          turn.status = "cancelled";
          turn.interrupted = true;
          turn.endedAt = turn.endedAt ?? Date.now();
          this.db.saveTurn(turn);
        }
      }
      if (turns.at(-1)?.interrupted && interruptedRun(turns) <= MAX_RESUMES) this.resuming.add(thread.id);
    }
    // Worktrees left behind by a crash or a lost thread: cut their node_modules links, so removing them by hand is safe.
    const openWorktrees = [...this.threads.values()].flatMap((t) => openWorktree(t)?.path ?? []);
    for (const link of unlinkOrphanedWorktrees(openWorktrees)) log(`Unlinked ${link} from a worktree no thread uses`);
    const scratchDir = path.join(dataDir(), "agent", "scratch");
    fs.mkdirSync(scratchDir, { recursive: true });
    const entry = fileURLToPath(new URL("../index.js", import.meta.url));
    const env: Record<string, string> = { SCRIBE_PORT: String(PORT) };
    if (process.env.SCRIBE_HOME) env.SCRIBE_HOME = process.env.SCRIBE_HOME;
    this.ctx = {
      boardMcp: { command: process.execPath, args: [entry], env },
      scratchDir,
      webAllowlist: () => this.prefs().webAllowlist,
      claudeHooks: () => this.prefs().claudeHooks,
      mcpServers: (thread) => serversForThread(thread),
      // Not for board workers: nobody watches their threads to approve commands.
      cursorHostShell: (threadId) => this.prefs().cursorHostShell && !pageOwned(this.loadItems(threadId)),
      limits: (provider, info) => this.recordLimits(provider, info),
      task: (threadId, toolId, patch) => this.patchTask(threadId, toolId, patch),
      followUp: (threadId, id) => this.followUp(threadId, id),
      approval: (threadId, req) => this.approveBetweenTurns(threadId, req),
      webRequest: (threadId, call, opts) => this.requestWeb(threadId, call, opts),
    };
    this.planLimits = this.db.getSetting<Partial<Record<ProviderId, PlanLimits>>>("limits", {});
    this.scheduleClaudeUsageRefresh();
    if (!this.fakes) {
      this.codexUsageTimer = setTimeout(() => void this.refreshCodexUsage(), 1000);
      this.codexUsageTimer.unref?.();
    }
    this.pruneTimer = setTimeout(() => this.pruneSessions(), PRUNE_FIRST_MS);
    this.pruneTimer.unref?.();
  }

  private pruneTimer: NodeJS.Timeout | null = null;

  /** Let providers drop saved sessions of deleted and rewound threads (#214), then again every few hours. */
  private pruneSessions(): void {
    const keep = new Set<string>();
    for (const t of this.threads.values()) {
      if (t.nativeId) keep.add(t.nativeId);
      if (t.fork?.nativeId) keep.add(t.fork.nativeId);
    }
    void (async () => {
      for (const provider of Object.values(this.providers)) {
        await provider.prune?.(keep).catch((err) => log(`Pruning ${provider.label} sessions failed: ${(err as Error).message}`));
      }
    })().finally(() => {
      if (this.closed) return;
      this.pruneTimer = setTimeout(() => this.pruneSessions(), PRUNE_EVERY_MS);
      this.pruneTimer.unref?.();
    });
  }

  private planLimits: Partial<Record<ProviderId, PlanLimits>> = {};
  private usageTimer: NodeJS.Timeout | null = null;
  private usageFetch: Promise<void> | null = null;
  private lastUsageFetchAt = 0;
  private cursorUsageFetchAt = 0;
  private codexUsageTimer: NodeJS.Timeout | null = null;
  private codexUsageFetch: Promise<void> | null = null;
  private codexUsageFetchAt = 0;
  private closed = false;

  /** Last reported plan usage per provider. Expired windows read as 0% until a fetch or turn updates them. */
  limits(): Partial<Record<ProviderId, PlanLimits>> {
    return this.liveLimits();
  }

  private liveLimits(): Partial<Record<ProviderId, PlanLimits>> {
    let out = this.planLimits;
    for (const [provider, limits] of Object.entries(this.planLimits) as Array<[ProviderId, PlanLimits]>) {
      const live = livePlanLimits(limits);
      if (live !== limits) out = { ...out, [provider]: live };
    }
    return out;
  }

  /** After a Cursor turn, pull its plan usage, at most once per CURSOR_USAGE_TTL_MS. */
  private refreshCursorUsage(): void {
    if (this.closed || this.fakes || Date.now() - this.cursorUsageFetchAt < CURSOR_USAGE_TTL_MS) return;
    this.cursorUsageFetchAt = Date.now();
    void (this.providers.cursor as CursorProvider).fetchPlanUsage().then((resp) => {
      if (this.closed || !resp) return;
      const parsed = planLimitsFromCursorUsage(resp, Date.now());
      if (parsed) this.commitLimits("cursor", parsed, false);
    });
  }

  private recordLimits(provider: ProviderId, info: unknown): void {
    const next = provider === "codex" ? planLimitsFromCodexRateLimits(info, Date.now(), this.planLimits.codex, true)
      : planLimitsFromRateLimitInfo(info, Date.now(), this.planLimits[provider]);
    if (!next) return;
    this.commitLimits(provider, next, true);
    if (provider === "codex") void this.refreshCodexUsage();
  }

  /** Poll without a model turn, including after a reset or a rolling notification. */
  private refreshCodexUsage(): Promise<void> {
    if (this.closed || this.fakes) return Promise.resolve();
    if (this.codexUsageFetch) return this.codexUsageFetch;
    if (Date.now() - this.codexUsageFetchAt < 60_000) return Promise.resolve();
    this.codexUsageFetchAt = Date.now();
    if (this.codexUsageTimer) clearTimeout(this.codexUsageTimer);
    const beforeRead = this.planLimits.codex;
    this.codexUsageFetch = (async () => {
      try {
        const report = await this.readCodexUsage();
        if (this.closed) return;
        const parsed = planLimitsFromCodexRateLimits(report, Date.now());
        if (!parsed) throw new Error("Invalid Codex quota response");
        this.commitLimits("codex", parsed, false);
      } catch (error) {
        if (this.closed) return;
        // A session reported quota while the background read was in flight.
        // Keep that newer evidence rather than replacing it with a probe error.
        if (this.planLimits.codex !== beforeRead && this.planLimits.codex?.availability === "available") return;
        const auth = /authentication required|unauthorized|401|expired|refresh.token|not logged|sign.in/i.test((error as Error).message);
        this.commitLimits("codex", { at: Date.now(), source: "codex", windows: [], ordinaryUsageAllowed: null,
          availability: auth ? "authentication_required" : "unavailable",
          detail: auth ? "Codex login is missing or expired. Log in again in Agent settings." : "Codex subscription quota is unavailable. It requires a ChatGPT login and a reachable app-server.",
        }, false);
      }
    })().finally(() => {
      this.codexUsageFetch = null;
      if (this.closed) return;
      const reset = nextRefreshAt(this.planLimits.codex);
      const delay = reset == null ? 5 * 60_000 : Math.min(5 * 60_000, Math.max(60_000, reset - Date.now() + 2000));
      this.codexUsageTimer = setTimeout(() => void this.refreshCodexUsage(), delay);
      this.codexUsageTimer.unref?.();
    });
    return this.codexUsageFetch;
  }

  private commitLimits(provider: ProviderId, next: PlanLimits, fromTurn: boolean): void {
    this.planLimits = { ...this.planLimits, [provider]: next };
    this.db.setSetting("limits", this.planLimits);
    this.emit({ type: "agent_limits", limits: this.liveLimits() });
    if (fromTurn) this.applyPlanCost(provider, next);
    this.scheduleClaudeUsageRefresh();
  }

  /** After a window resets, pull plan usage from Claude without sending a model message. */
  private scheduleClaudeUsageRefresh(): void {
    if (this.usageTimer) {
      clearTimeout(this.usageTimer);
      this.usageTimer = null;
    }
    if (this.closed) return;
    const at = nextRefreshAt(this.planLimits.claude);
    if (at == null) return;
    const delay = Math.max(0, at - Date.now() + 2000);
    this.usageTimer = setTimeout(() => void this.refreshClaudeUsage(), Math.min(delay, 7 * 24 * 60 * 60 * 1000));
    this.usageTimer.unref?.();
  }

  private claudeTurnRunning(): boolean {
    for (const [id] of this.runs) {
      if (this.threads.get(id)?.provider === "claude") return true;
    }
    return false;
  }

  private refreshClaudeUsage(): Promise<void> {
    if (this.usageFetch) return this.usageFetch;
    this.usageFetch = this.doRefreshClaudeUsage().finally(() => {
      this.usageFetch = null;
    });
    return this.usageFetch;
  }

  private async doRefreshClaudeUsage(): Promise<void> {
    if (this.closed) return;
    if (this.claudeTurnRunning()) {
      this.usageTimer = setTimeout(() => void this.refreshClaudeUsage(), 30_000);
      this.usageTimer.unref?.();
      return;
    }
    const prev = this.planLimits.claude;
    if (prev) {
      const overlaid = applyExpiredWindows(prev);
      if (overlaid !== prev) this.commitLimits("claude", overlaid, false);
    }
    if (Date.now() - this.lastUsageFetchAt < 60_000) {
      this.scheduleClaudeUsageRefresh();
      return;
    }
    this.lastUsageFetchAt = Date.now();
    try {
      const report = await (this.providers.claude as ClaudeProvider).fetchPlanUsage();
      if (this.closed) return;
      const parsed = planLimitsFromUsageReport(report, Date.now());
      if (parsed) this.commitLimits("claude", applyExpiredWindows(parsed), false);
    } catch {
      /* overlay already applied; the next turn still reports */
    }
    this.scheduleClaudeUsageRefresh();
  }

  /** Attach this report's window deltas to the turn that was running when it started. */
  private applyPlanCost(provider: ProviderId, next: PlanLimits): void {
    const slot = this.limitTurn;
    if (!slot || slot.provider !== provider || !slot.before.length) return;
    const plan = planUsed(slot.before, next.windows);
    if (!plan.length) return;
    const turn = this.loadTurns(slot.threadId).find((t) => t.id === slot.turnId);
    if (!turn) return;
    const usage = { ...(this.runs.get(slot.threadId)?.usage ?? turn.usage ?? {}), plan };
    const run = this.runs.get(slot.threadId);
    if (run && run.turn.id === slot.turnId) {
      run.usage = usage;
      run.turn.usage = usage;
    }
    turn.usage = usage;
    this.saveTurn(turn);
  }

  dispose(): void {
    this.closed = true;
    if (this.codexUsageTimer) clearTimeout(this.codexUsageTimer);
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    if (this.usageTimer) {
      clearTimeout(this.usageTimer);
      this.usageTimer = null;
    }
    this.flushNow();
    for (const session of this.sessions.values()) session.dispose();
    for (const provider of Object.values(this.providers)) provider.dispose();
    this.db.close();
  }

  // ---------- prefs, providers, models ----------

  prefs(): Prefs {
    const saved = migrateOpenaiPrefs(this.db.getSetting<Partial<Prefs>>("prefs", {}));
    return {
      ...DEFAULT_PREFS,
      ...saved,
      models: { ...DEFAULT_PREFS.models, ...saved.models },
      modelParams: { ...DEFAULT_PREFS.modelParams, ...saved.modelParams },
      modelSettings: seedModelSettings(saved),
      approvals: { ...DEFAULT_PREFS.approvals, ...saved.approvals },
      // Older prefs kept web as a boolean.
      web: parseWebAccess(saved.web) ?? DEFAULT_PREFS.web,
      webAllowlist: Array.isArray(saved.webAllowlist) ? cleanAllowlist(saved.webAllowlist) : DEFAULT_PREFS.webAllowlist,
      claudeHooks: saved.claudeHooks === true,
      cursorHostShell: saved.cursorHostShell === true,
      disabledModes: cleanDisabledModes(saved.disabledModes),
    };
  }

  setPrefs(patch: Partial<Prefs>): Prefs {
    const next = { ...this.prefs(), ...patch };
    next.web = parseWebAccess(patch.web) ?? this.prefs().web;
    // null puts back the starting list.
    if (patch.claudeHooks !== undefined) next.claudeHooks = patch.claudeHooks === true;
    if (patch.cursorHostShell !== undefined) next.cursorHostShell = patch.cursorHostShell === true;
    if (patch.disabledModes !== undefined) next.disabledModes = cleanDisabledModes(patch.disabledModes);
    if (patch.webAllowlist !== undefined) next.webAllowlist = patch.webAllowlist === null ? DEFAULT_PREFS.webAllowlist : cleanAllowlist(patch.webAllowlist);
    this.db.setSetting("prefs", next);
    return next;
  }

  // ---------- Native harness model sources ----------

  /** OpenAI-compatible endpoints for the native harness (Pi). Kept under the setting the old openai provider used. */
  private modelSources(): OpenAISource[] {
    return this.db.getSetting<OpenAISource[]>("openai.sources", []);
  }

  /** The sources as the board sees them: never the API keys. */
  modelSourceViews(): OpenAISourceView[] {
    return this.modelSources().map(sourceView);
  }

  /** Add a source (no id) or change one. The key stays unless the form sends a new one. */
  saveModelSource(id: string | null, body: unknown): OpenAISourceView {
    const sources = this.modelSources();
    const previous = id ? sources.find((s) => s.id === id) : undefined;
    if (id && !previous) throw new Error(`source not found: ${id}`);
    const source = normalizeSource(body, previous, new Set(sources.map((s) => s.id)));
    const next = previous ? sources.map((s) => (s.id === id ? source : s)) : [...sources, source];
    this.db.setSetting("openai.sources", next);
    (this.providers.pi as PiProvider).invalidate();
    return sourceView(source);
  }

  deleteModelSource(id: string): void {
    const sources = this.modelSources();
    if (!sources.some((s) => s.id === id)) throw new Error(`source not found: ${id}`);
    this.db.setSetting("openai.sources", sources.filter((s) => s.id !== id));
    (this.providers.pi as PiProvider).invalidate();
  }

  /** Start Cursor's browser login; resolves with the login URL. */
  cursorLogin(): Promise<{ url: string | null }> {
    return (this.providers.cursor as CursorProvider).startLogin();
  }

  /** Start Codex's ChatGPT login (`codex login`); resolves with the login URL when the CLI prints one. */
  codexLogin(): Promise<{ url: string | null }> {
    return (this.providers.codex as CodexProvider).startLogin();
  }

  async providerStatus(): Promise<ProviderStatus[]> {
    return Promise.all(Object.values(this.fakes ?? this.providers).map((provider) => provider.status()));
  }

  /** The provider that runs a thread: the real one, or its fake under SCRIBE_FAKE_AGENTS=1. */
  private agent(id: ProviderId): AgentProvider {
    return this.fakes?.[id] ?? this.providers[id];
  }

  async models(provider: ProviderId, refresh = false): Promise<ModelOption[]> {
    const models = await this.agent(provider).models(refresh);
    if (models.length) this.db.setSetting(`models.${provider}`, models);
    return models.length ? models : this.db.getSetting<ModelOption[]>(`models.${provider}`, []);
  }

  cachedModels(provider: ProviderId): ModelOption[] {
    return this.db.getSetting<ModelOption[]>(`models.${provider}`, []);
  }

  // ---------- threads ----------

  listThreads(): ThreadView[] {
    return [...this.threads.values()].sort((a, b) => b.activityAt - a.activityAt).map((thread) => this.view(thread));
  }

  /** Whether a thread is still working, and how its last turn ended. Pages use it to release claims. */
  runInfo(id: string): ThreadRunInfo {
    const thread = this.threads.get(id);
    if (!thread) return { exists: false };
    const status = this.status.get(id) ?? "idle";
    const last = this.db.listTurns(id).at(-1);
    const outputAt = this.runs.get(id)?.turn.outputAt ?? last?.outputAt;
    const recovery = thread.provider === "codex" && last?.limitResetsAt
      ? codexUsageRecoveryAllowed(this.planLimits.codex, last.endedAt ?? last.startedAt) : undefined;
    if (recovery === false) void this.refreshCodexUsage();
    const asking = status === "waiting" ? this.asking(id) : undefined;
    return {
      exists: true,
      running: status !== "idle" || this.resuming.has(id),
      title: thread.title,
      ...(outputAt !== undefined ? { outputAt } : {}),
      ...(asking ? { asking: { kind: asking.kind, title: asking.title, ...(asking.page ? { page: { key: asking.page.key, title: asking.page.title } } : {}) } } : {}),
      ...(last ? { lastTurn: { status: last.status, ...(last.endedAt ? { endedAt: last.endedAt } : {}), ...(last.error ? { error: last.error } : {}), ...(last.limitResetsAt ? { limitResetsAt: last.limitResetsAt } : {}), ...(recovery !== undefined ? { usageRecoveryAllowed: recovery } : {}) } } : {}),
    };
  }

  /**
   * Send on the threads whose turn the last restart cut off: a note from Scribe starts a turn in the
   * same session, and messages that were queued behind the cut-off turn queue again behind it (ones
   * with attachments stay in the transcript as not sent). Call once Scribe is listening, so the
   * agents' MCP servers can reach it.
   */
  resumeInterrupted(): string[] {
    const resumed: string[] = [];
    for (const threadId of [...this.resuming]) {
      this.resuming.delete(threadId);
      if (!this.threads.has(threadId) || this.runs.has(threadId)) continue;
      const leftovers = this.loadItems(threadId).filter((item): item is Item & { kind: "user" } => item.kind === "user" && item.turnId === null && !item.dropped);
      try {
        this.send(threadId, { text: RESUME_NOTE, from: "scribe" });
      } catch (err) {
        log(`Could not resume thread ${threadId} after the restart: ${(err as Error).message}`);
        this.addItem(threadId, null, { kind: "notice", level: "error", text: `Scribe restarted during this thread's turn and could not send it on: ${(err as Error).message}` });
        this.emitThread(threadId);
        continue;
      }
      resumed.push(threadId);
      const queue: QueuedMessage[] = [];
      for (const item of leftovers) {
        delete item.steer;
        delete item.editing;
        if (item.images?.length || item.files?.length) {
          item.dropped = true;
        } else {
          queue.push({
            itemId: item.id,
            text: item.text,
            images: [],
            files: [],
            saved: { images: [], files: [] },
            context: item.context ?? [],
            ...(item.from ? { from: item.from } : {}),
            // The board's name went with the message, not the transcript: the agent finds the board from the card.
            ...(item.card ? { card: { ...item.card, board: "" } } : {}),
          });
        }
        this.touch(item);
      }
      if (queue.length) this.queues.set(threadId, queue);
      if (leftovers.length) this.emitThread(threadId);
    }
    if (resumed.length) log(`Resumed ${resumed.length} thread(s) whose turn a restart cut off`);
    return resumed;
  }

  getThread(id: string): Thread | null {
    return this.threads.get(id) ?? null;
  }

  threadDetail(id: string): { thread: ThreadView; turns: Turn[]; items: Item[] } | null {
    const thread = this.threads.get(id);
    if (!thread) return null;
    return { thread: this.view(thread), turns: this.loadTurns(id), items: this.loadItems(id) };
  }

  /** Start a thread's provider session ahead of a message. Nothing happens while it runs. */
  async warm(id: string): Promise<void> {
    const thread = this.requireThread(id);
    if (this.runs.has(id) || thread.archived) return;
    // Its session is set up on the first turn, from the thread it was forked from.
    if (thread.fork) return;
    // The session would start in the main checkout and restart once the worktree is made.
    if (wantsWorktree(thread)) return;
    const session = this.session(thread);
    session.update(thread);
    await session.warm(threadInstructions(thread, this.scopeInfo(thread)));
  }

  /** Warm a spare session for a thread the user is about to start with these settings. */
  warmDraft(input: Partial<Thread> & { scope?: ThreadScope }): void {
    const draft = this.draftThread(input);
    if (wantsWorktree(draft)) return;
    this.agent(draft.provider).prewarm(draft, threadInstructions(draft, this.scopeInfo(draft)), this.ctx);
  }

  /** remember: false for threads a page starts (board workers), so they leave the user's defaults alone. */
  createThread(input: Partial<Thread> & { scope?: ThreadScope }, { remember = true }: { remember?: boolean } = {}): ThreadView {
    const thread = this.draftThread(input);
    // Prewarm starts MCP with the draft's id. Reuse it so claims from that process map to this thread.
    // A draft thread (saved unsent) leaves the spare for the thread the user goes on to start.
    const spareId = input.draft ? null : this.agent(thread.provider).spareThreadId?.(thread, this.ctx);
    // The spare is taken on the first message; a second thread made before that gets its own id.
    // createSession also refuses that spare: its MCP still reports this id.
    if (spareId && !this.threads.has(spareId)) thread.id = spareId;
    if (input.draft) thread.draft = input.draft;
    // A New page becomes a real page once it has a thread, even one that has not sent anything.
    if (thread.scope.kind === "page" && thread.scope.ref) store.promoteDraft(thread.scope.ref);
    this.threads.set(thread.id, thread);
    this.items.set(thread.id, []);
    this.turns.set(thread.id, []);
    this.seq.set(thread.id, 0);
    this.db.saveThread(thread);
    if (remember) this.rememberChoices(thread, settingPatch(thread));
    const view = this.view(thread);
    this.emit({ type: "agent_thread", thread: view });
    return view;
  }

  /** Persist a draft's visible settings as the defaults for the next new thread. */
  rememberDraft(input: Partial<Thread> & { scope?: ThreadScope }): Prefs {
    const thread = this.draftThread(input);
    this.rememberChoices(thread, settingPatch(thread));
    return this.prefs();
  }

  /** A thread with defaults filled in, not stored. createThread and warmDraft agree on it, so a warmed spare matches. */
  private draftThread(input: Partial<Thread> & { scope?: ThreadScope }): Thread {
    const prefs = this.prefs();
    const provider = input.provider ?? prefs.provider;
    const scope: ThreadScope = input.scope ?? { kind: "global", ref: null };
    const scopeKey = scope.kind === "global" ? "global" : `${scope.kind}:${scope.ref}`;
    const cwd =
      input.cwd !== undefined
        ? input.cwd
        : scope.kind === "workspace"
          ? scope.ref
          : scope.kind === "page" && scope.ref
            ? this.pageWorkspace(scope.ref)
            : prefs.scopeWorkspaces[scopeKey] ?? prefs.recentWorkspaces[0] ?? null;
    const model = input.model ?? prefs.models[provider] ?? "default";
    const choice = modelChoice(prefs, provider, model);
    const now = Date.now();
    const thread: Thread = {
      id: `th_${crypto.randomBytes(6).toString("hex")}`,
      title: input.title?.trim() || "New thread",
      titleLocked: Boolean(input.title?.trim()),
      provider,
      model,
      effort: input.effort !== undefined ? input.effort : choice.effort,
      modelParams: input.modelParams ?? choice.modelParams,
      mode: input.mode ?? (scope.kind === "page" || scope.kind === "folder" ? "board" : prefs.mode),
      approval: input.approval ?? approvalFor(prefs, provider),
      web: input.web ?? prefs.web,
      scope,
      cwd: cwd ?? null,
      useWorktree: input.useWorktree ?? (cwd ? prefs.worktrees[workspaceKey(cwd)] ?? false : false),
      nativeId: null,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      activityAt: now,
    };
    return thread;
  }

  /** Workspace a new thread on this page should start in: latest AI reply there, else none. */
  private pageWorkspace(pageId: string): string | null {
    const rows: PageChatThread[] = [];
    for (const t of this.threads.values()) {
      if (t.archived || t.scope.kind !== "page" || t.scope.ref !== pageId) continue;
      let finishedAt: number | undefined;
      for (const turn of this.loadTurns(t.id)) {
        if (turn.endedAt) finishedAt = turn.endedAt;
      }
      rows.push({
        id: t.id,
        archived: t.archived,
        scope: t.scope,
        cwd: t.cwd,
        worktree: t.worktree,
        finishedAt,
        activityAt: t.activityAt,
        status: this.status.get(t.id) ?? "idle",
      });
    }
    return pageThreadWorkspace(rows, pageId);
  }

  updateThread(id: string, patch: Partial<Thread>): ThreadView {
    const thread = this.requireThread(id);
    const next: Thread = { ...thread };
    if (typeof patch.title === "string" && patch.title.trim()) {
      next.title = patch.title.trim().slice(0, 200);
      next.titleLocked = true;
    }
    if (patch.provider && patch.provider !== thread.provider) {
      if (this.loadTurns(id).length) {
        throw new Error("A thread keeps its provider once it has messages. Start a new thread to switch.");
      }
      next.provider = patch.provider;
      const prefs = this.prefs();
      next.model = patch.model ?? prefs.models[patch.provider] ?? "default";
      next.approval = patch.approval ?? approvalFor(prefs, patch.provider);
      next.nativeId = null;
      this.sessions.get(id)?.dispose();
      this.sessions.delete(id);
      forgetGuides(id);
    }
    if (typeof patch.model === "string") next.model = patch.model;
    if (next.provider !== thread.provider || next.model !== thread.model) {
      // A new model starts with the effort and params last picked for it.
      const choice = modelChoice(this.prefs(), next.provider, next.model);
      next.effort = choice.effort;
      next.modelParams = choice.modelParams;
    }
    if (patch.effort !== undefined) next.effort = patch.effort;
    if (patch.modelParams && typeof patch.modelParams === "object") next.modelParams = { ...next.modelParams, ...patch.modelParams };
    if (patch.mode) next.mode = patch.mode;
    if (patch.approval) next.approval = patch.approval;
    if (patch.web) next.web = patch.web;
    if (patch.cwd !== undefined) {
      const cwd = patch.cwd ? path.normalize(patch.cwd) : null;
      if (cwd !== thread.cwd && this.runs.has(id)) throw new Error("Stop the running turn before changing the workspace.");
      if (cwd !== thread.cwd && openWorktree(thread)) throw new Error("This thread works in its own worktree. Merge or leave it before changing the workspace.");
      next.cwd = cwd;
    }
    if (typeof patch.useWorktree === "boolean" && patch.useWorktree !== Boolean(thread.useWorktree)) {
      if (openWorktree(thread)) throw new Error("This thread already has a worktree. Merge or leave it from the branch menu.");
      if (this.loadTurns(id).length) throw new Error("A worktree can only be turned on before the first message. Start a new thread to use one.");
      next.useWorktree = patch.useWorktree;
    }
    if (patch.scope) next.scope = patch.scope;
    if (patch.scope?.kind === "page" && patch.scope.ref) store.promoteDraft(patch.scope.ref, { activate: false });
    if (typeof patch.pinned === "boolean") next.pinned = patch.pinned;
    if (typeof patch.archived === "boolean") next.archived = patch.archived;
    if (patch.draft !== undefined) next.draft = patch.draft;
    // An archived thread is done with its agent browser.
    if (next.archived && !thread.archived) void closeThreadBrowser(id);
    next.updatedAt = Date.now();
    this.threads.set(id, next);
    this.db.saveThread(next);
    this.sessions.get(id)?.update(next);
    this.rememberChoices(next, patch);
    const view = this.view(next);
    this.emit({ type: "agent_thread", thread: view });
    return view;
  }

  /**
   * Bind this chat to a page it just opened for the user, so the floating dock stays with the
   * conversation. Board-owned threads (a page started them) stay on that page.
   */
  followToPage(threadId: string, pageId: string): boolean {
    const thread = this.threads.get(threadId);
    if (!thread || thread.archived) return false;
    if (!store.get(pageId)) return false;
    if (pageOwned(this.loadItems(threadId))) return false;
    if (thread.scope.kind === "page" && thread.scope.ref === pageId) return false;
    this.updateThread(threadId, { scope: { kind: "page", ref: pageId } });
    return true;
  }

  /** Take back a permission the user granted the thread (a web domain, any website, or a readable thread scope). key comes from the view's grants. */
  revokeGrant(id: string, key: string): ThreadView {
    const thread = this.requireThread(id);
    const next = revokeGrant(thread, key);
    if (!next) throw new Error("This thread has no such permission.");
    thread.webGrants = next.webGrants;
    thread.threadGrants = next.threadGrants;
    this.db.saveThread(thread);
    this.sessions.get(id)?.update(thread);
    const view = this.view(thread);
    this.emit({ type: "agent_thread", thread: view });
    return view;
  }

  /** Model, effort, mode, and workspace picks become the defaults for new threads. */
  private rememberChoices(thread: Thread, patch: Partial<Thread>): void {
    const next = prefsPatchFromChoices(this.prefs(), thread, patch);
    if (Object.keys(next).length) this.setPrefs(next);
  }

  async deleteThread(id: string): Promise<void> {
    const thread = this.requireThread(id);
    await this.cancel(id);
    this.sessions.get(id)?.dispose();
    this.sessions.delete(id);
    forgetGuides(id);
    void closeThreadBrowser(id);
    const wt = openWorktree(thread);
    // A fork shares its worktree: the folder stays while another thread still works in it.
    if (wt && !this.sharers(id, wt).length) {
      // The folder goes; any work stays on the branch, so deleting a thread never loses it.
      try {
        await commitAll(wt, `WIP: ${thread.title}`);
        await removeWorktree(wt);
        await dropBranchIfEmpty(wt);
      } catch (err) {
        log(`Removing the worktree of ${id} failed: ${(err as Error).message}`);
      }
    }
    this.threads.delete(id);
    this.items.delete(id);
    this.turns.delete(id);
    this.queues.delete(id);
    this.unread.delete(id);
    for (const [key, item] of this.dirty) {
      if (item.threadId === id) this.dirty.delete(key);
    }
    this.db.deleteThread(id);
    this.db.deleteSetting(`fork:${id}`);
    try {
      removeThreadFiles(id);
    } catch (err) {
      log(`Removing the files of ${id} failed: ${(err as Error).message}`);
    }
    this.emit({ type: "agent_thread_deleted", id });
  }

  markRead(id: string): void {
    if (this.unread.delete(id)) {
      const thread = this.threads.get(id);
      if (thread) this.emit({ type: "agent_thread", thread: this.view(thread) });
    }
  }

  async commands(id: string): Promise<SlashCommand[]> {
    const thread = this.requireThread(id);
    const session = this.sessions.get(id);
    if (session) {
      const list = await session.commands();
      if (list.length) {
        this.rememberCommands(thread.provider, list);
        return list;
      }
    }
    return this.providerCommands(thread.provider);
  }

  /** The last slash command list a provider reported, kept across restarts for new threads. */
  providerCommands(provider: ProviderId): SlashCommand[] {
    let list = this.commandCache.get(provider);
    if (!list) {
      list = this.db.getSetting<SlashCommand[]>(`commands.${provider}`, []);
      this.commandCache.set(provider, list);
    }
    return list;
  }

  private rememberCommands(provider: ProviderId, list: SlashCommand[]): void {
    const prev = this.commandCache.get(provider);
    this.commandCache.set(provider, list);
    if (JSON.stringify(prev) !== JSON.stringify(list)) this.db.setSetting(`commands.${provider}`, list);
  }

  private requireThread(id: string): Thread {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`thread not found: ${id}`);
    return thread;
  }

  private view(thread: Thread): ThreadView {
    const turns = this.loadTurns(thread.id);
    const files = new Set<string>();
    let added = 0;
    let removed = 0;
    let finishedAt: number | undefined;
    for (const turn of turns) {
      if (turn.endedAt) finishedAt = turn.endedAt;
      if (turn.reverted) continue;
      for (const file of turn.files ?? []) {
        files.add(file.path);
        added += file.added;
        removed += file.removed;
      }
    }
    const items = this.loadItems(thread.id);
    const fromPage = pageOwned(items);
    const asking = this.asking(thread.id);
    const status = this.status.get(thread.id) ?? "idle";
    const unread = this.unread.has(thread.id) && !fromPage;
    const activity = threadActivity(items, status, unread);
    if (activity) this.activitySent.set(thread.id, activityKey(activity));
    else this.activitySent.delete(thread.id);
    const grants = grantRows(thread, this.scopeLookup());
    return {
      ...thread,
      status,
      unread,
      queued: this.queues.get(thread.id)?.length ?? 0,
      background: this.backgroundTasks(thread.id),
      stats: { turns: turns.length, files: files.size, added, removed },
      fromPage,
      ...(finishedAt ? { finishedAt } : {}),
      ...(thread.fork ? { carry: this.forkCarry(thread, thread.fork) } : {}),
      ...(asking ? { asking } : {}),
      ...(activity ? { activity } : {}),
      ...(grants.length ? { grants } : {}),
    };
  }

  /** A running thread's live step changed: send the thread again, at most every ACTIVITY_MS. */
  private activityChanged(threadId: string): void {
    if (this.activityTimers.has(threadId) || (this.status.get(threadId) ?? "idle") === "idle") return;
    const timer = setTimeout(() => {
      this.activityTimers.delete(threadId);
      const thread = this.threads.get(threadId);
      if (!thread) return;
      const status = this.status.get(threadId) ?? "idle";
      const activity = threadActivity(this.loadItems(threadId), status, false);
      if (activity && activityKey(activity) !== this.activitySent.get(threadId)) this.emitThread(threadId);
    }, ACTIVITY_MS);
    timer.unref?.();
    this.activityTimers.set(threadId, timer);
  }

  /** The thread's oldest unanswered interaction, for the tab strip, Library and palette. */
  private asking(threadId: string): ThreadView["asking"] {
    for (const pending of this.pending.values()) {
      if (pending.threadId !== threadId) continue;
      const item = this.loadItems(threadId).find((it) => it.id === pending.itemId);
      if (!item) continue;
      if (item.kind === "approval") {
        return { kind: "approval", itemId: item.id, title: item.title, ...(item.detail ? { detail: item.detail } : {}), options: item.options };
      }
      if (item.kind === "question") {
        const title = item.title || item.questions[0]?.prompt || item.page?.title || "Question";
        return { kind: "question", itemId: item.id, title, ...(item.page ? { page: item.page } : {}) };
      }
      if (item.kind === "plan") return { kind: "plan", itemId: item.id, title: item.title || "Plan to review" };
    }
    return undefined;
  }

  private emitThread(id: string): void {
    const thread = this.threads.get(id);
    if (thread) this.emit({ type: "agent_thread", thread: this.view(thread) });
  }

  private loadItems(id: string): Item[] {
    let items = this.items.get(id);
    if (!items) {
      items = this.db.listItems(id);
      this.items.set(id, items);
      this.seq.set(id, items.length ? items[items.length - 1].seq : 0);
      // Loaded once per daemon run, before any session exists: tasks still marked running died with the last one.
      const stale = items.filter((item) => item.kind === "tool" && item.task?.status === "running");
      for (const item of stale) {
        if (item.kind === "tool" && item.task) item.task = { ...item.task, status: "stopped", summary: "Stopped: Scribe restarted", endedAt: item.task.endedAt ?? Date.now() };
      }
      if (stale.length) this.db.saveItems(stale);
    }
    return items;
  }

  private loadTurns(id: string): Turn[] {
    let turns = this.turns.get(id);
    if (!turns) {
      turns = this.db.listTurns(id);
      this.turns.set(id, turns);
    }
    return turns;
  }

  private scopeInfo(thread: Thread): ScopeInfo {
    if (thread.scope.kind === "page" && thread.scope.ref) {
      // A warmed spare for a New page sees the draft; the thread that takes it makes the page real.
      const tab = store.get(thread.scope.ref, "agent") ?? store.getDraft(thread.scope.ref);
      if (!tab) return { page: null };
      return {
        page: { id: tab.id, key: tab.key, title: tab.title, folder: store.folderPath(tab.folderId), ...(isBlankPage(tab) ? { blank: true } : {}) },
        folderInstructions: store.folderInstructionsFor(tab.folderId ?? null),
      };
    }
    if (thread.scope.kind === "folder" && thread.scope.ref) {
      const folderPath = store.folderPath(thread.scope.ref);
      if (!folderPath) return { folder: null };
      return {
        folder: { id: thread.scope.ref, path: folderPath },
        folderInstructions: store.folderInstructionsFor(thread.scope.ref),
      };
    }
    return {};
  }

  /**
   * The agent guides for the pages a message brings up: the thread's own page, page chips, and
   * scribe: keys in the text. A guide goes in once per conversation (the MCP checks the same
   * memory, so its tool results skip it too); after that a chip or link only names it.
   */
  private pageGuides(thread: Thread, msg: QueuedMessage): string {
    const ids: Array<{ ref: string; own?: boolean }> = [];
    if (thread.scope.kind === "page" && thread.scope.ref) ids.push({ ref: thread.scope.ref, own: true });
    for (const chip of msg.context) {
      if (chip.kind === "page") ids.push({ ref: chip.id });
      // A selection names the page it came from.
      else if (chip.kind === "selection" && chip.source) for (const key of pageKeysIn(chip.source).slice(0, 1)) ids.push({ ref: key });
    }
    // Pasted text can hold many keys; a few is what "look at this page" looks like.
    for (const key of pageKeysIn(msg.text).slice(0, 8)) ids.push({ ref: key });
    const pages: PageGuide[] = [];
    const seen = new Set<string>();
    for (const { ref, own } of ids) {
      const tab = store.get(ref, "agent");
      if (!tab?.templateId || seen.has(tab.id)) continue;
      seen.add(tab.id);
      const guide = store.templateGuide(tab.templateId);
      if (!guide) continue;
      const given = guideSent(thread.id, guide);
      // The thread's own page is named in its instructions; it only needs the guide the first time.
      if (given && own) continue;
      pages.push({ key: tab.key, guide, given });
    }
    for (const page of pages) markGuideSent(thread.id, page.guide);
    return guidesBlock(pages);
  }

  /**
   * When a watched page changed since this thread last saw it, a short note so the next turn
   * re-reads instead of overwriting the user's edit.
   */
  private pageEditPrefix(thread: Thread, currentTurnId: string): string {
    const prior = this.loadTurns(thread.id).filter((t) => t.id !== currentTurnId);
    const seen = lastSeenPages(prior);
    if (!seen.length) return "";
    return pageEditsBlock(pageEditsSince(seen, this.pageSnapshots(seen.map((page) => page.id))));
  }

  private pageSnapshots(refs: string[]): PageSnapshot[] {
    const out: PageSnapshot[] = [];
    const ids = new Set<string>();
    for (const ref of refs) {
      const tab = store.get(ref, "agent");
      if (!tab || ids.has(tab.id)) continue;
      ids.add(tab.id);
      out.push({ id: tab.id, key: tab.key, title: tab.title, revision: tab.revision, stateRevision: tab.stateRevision });
    }
    return out;
  }

  /** Record the thread's page, attached pages, and pages this turn wrote, as of now. */
  private rememberTurnPages(thread: Thread, msg: QueuedMessage | null, turn: Turn, extraRefs: string[]): void {
    const prior = this.loadTurns(thread.id).filter((t) => t.id !== turn.id);
    const watch = [...extraRefs];
    if (thread.scope.kind === "page" && thread.scope.ref) watch.push(thread.scope.ref);
    if (msg) {
      for (const chip of msg.context) {
        if (chip.kind === "page") watch.push(chip.id);
      }
    }
    watch.push(...writePageRefs(this.loadItems(thread.id).filter((item) => item.turnId === turn.id)));
    const seen = rememberPages(this.pageSnapshots(watch), this.pageSnapshots(lastSeenPages(prior).map((page) => page.id)));
    if (seen.length) turn.seenPages = seen;
    else delete turn.seenPages;
  }

  // ---------- items ----------

  private addItem(threadId: string, turnId: string | null, body: ItemBody): Item {
    if (!this.threads.has(threadId)) {
      // A turn still finishing after its thread was deleted: nothing to store or show.
      return { id: "", threadId, turnId, seq: 0, createdAt: Date.now(), ...body } as Item;
    }
    const items = this.loadItems(threadId);
    const seq = (this.seq.get(threadId) ?? 0) + 1;
    this.seq.set(threadId, seq);
    const id = `it_${crypto.randomBytes(6).toString("hex")}`;
    const item = { id, threadId, turnId, seq, createdAt: Date.now(), ...body } as Item;
    // Interactions are answered by their item id.
    if ("requestId" in item && item.requestId === "") item.requestId = id;
    items.push(item);
    this.touch(item);
    return item;
  }

  /** Marks an item changed: broadcast now, save on the next flush. */
  private touch(item: Item): void {
    if (!this.threads.has(item.threadId)) return;
    this.flushDelta(item.id);
    this.dirty.set(item.id, item);
    this.emit({ type: "agent_item", item });
    this.scheduleFlush();
    if (item.kind === "tool" || item.kind === "text" || item.kind === "reasoning") this.activityChanged(item.threadId);
  }

  private appendText(item: Item & { text: string }, delta: string): void {
    item.text += delta;
    this.dirty.set(item.id, item);
    const buf = this.deltaBuf.get(item.id);
    if (buf) buf.text += delta;
    else this.deltaBuf.set(item.id, { threadId: item.threadId, text: delta });
    if (item.kind === "text") this.activityChanged(item.threadId);
    if (!this.deltaTimer) {
      this.deltaTimer = setTimeout(() => this.flushDeltas(), DELTA_MS);
    }
    this.scheduleFlush();
  }

  private flushDelta(itemId: string): void {
    const buf = this.deltaBuf.get(itemId);
    if (!buf) return;
    this.deltaBuf.delete(itemId);
    this.emit({ type: "agent_delta", threadId: buf.threadId, itemId, append: buf.text });
  }

  private flushDeltas(): void {
    this.deltaTimer = null;
    for (const itemId of [...this.deltaBuf.keys()]) this.flushDelta(itemId);
  }

  private scheduleFlush(): void {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushNow(), FLUSH_MS);
    }
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const items = [...this.dirty.values()].filter((item) => this.threads.has(item.threadId));
    this.dirty.clear();
    try {
      this.db.saveItems(items);
    } catch (err) {
      log(`Agent item save failed: ${(err as Error).message}`);
    }
  }

  private saveTurn(turn: Turn): void {
    if (!this.threads.has(turn.threadId)) return;
    this.db.saveTurn(turn);
    this.emit({ type: "agent_turn", turn });
  }

  private setStatus(threadId: string, status: RunStatus): void {
    if ((this.status.get(threadId) ?? "idle") === status) return;
    this.status.set(threadId, status);
    this.emitThread(threadId);
  }

  // ---------- running ----------

  /** Pages, folders and files this thread has already been told about. */
  private knownContext(threadId: string, thread: Thread): ContextChip[] {
    const already: ContextChip[] = [];
    if (thread.scope.kind === "page" && thread.scope.ref) {
      already.push({ kind: "page", id: thread.scope.ref, key: "", title: "" });
    }
    for (const item of this.loadItems(threadId)) {
      if (item.kind === "user" && !item.dropped && item.context?.length) already.push(...item.context);
    }
    return already;
  }

  send(threadId: string, input: SendInput): { queued: boolean; item: Item } {
    const thread = this.requireThread(threadId);
    // Also protects existing boards whose saved HTML predates the worker recovery check.
    if (input.from === "page" && !input.card?.resume && thread.provider === "codex" && !this.runs.has(threadId)) {
      const last = this.db.listTurns(threadId).at(-1);
      if (last?.limitResetsAt && !codexUsageRecoveryAllowed(this.planLimits.codex, last.endedAt ?? last.startedAt)) {
        void this.refreshCodexUsage();
        throw new Error("Codex has not confirmed that included usage is available again. Waiting for a fresh quota read.");
      }
    }
    const text = input.text.trim();
    if (!text && !input.images?.length && !input.files?.length) throw new Error("Empty message");
    const context = freshContext(input.context, this.knownContext(threadId, thread));
    const wt = openWorktree(thread);
    if (wt && !fs.existsSync(wt.path)) {
      throw new Error(`This thread's worktree is gone (${wt.path}). Use Leave branch in the branch menu to go back to the main checkout; the branch ${wt.branch} keeps its commits.`);
    }
    const images = input.images ?? [];
    const files = input.files ?? [];
    const msg: QueuedMessage = {
      text,
      images,
      files,
      saved: { images: saveFiles(threadId, images), files: saveFiles(threadId, files) },
      context,
      ...(input.from ? { from: input.from } : {}),
      ...(input.card ? { card: input.card } : {}),
    };
    if (!input.from && thread.draft) {
      // The user sent what they had left in the composer.
      thread.draft = null;
      this.db.saveThread(thread);
    }
    if (this.runs.has(threadId) || this.queues.get(threadId)?.length) {
      const queue = this.queues.get(threadId) ?? [];
      queue.push(msg);
      this.queues.set(threadId, queue);
      const item = this.addItem(threadId, null, userBody(msg));
      msg.itemId = item.id;
      this.emitThread(threadId);
      this.drainQueue(threadId);
      return { queued: true, item };
    }
    const item = this.addItem(threadId, null, userBody(msg));
    void this.runTurn(threadId, msg, item);
    return { queued: false, item };
  }

  /** Queued messages that have not run yet, oldest first, in the same order as the queue. */
  private queuedItems(threadId: string): Item[] {
    return this.loadItems(threadId).filter((item) => item.kind === "user" && item.turnId === null && !item.dropped && !item.steer);
  }

  /**
   * Hand the first queued message to the running turn, which takes it in at its next step. When a
   * steered message is already waiting, or the provider cannot steer, send it now instead.
   */
  async steer(threadId: string, itemId?: string): Promise<{ steered: boolean }> {
    const run = this.runs.get(threadId);
    const session = this.sessions.get(threadId);
    if (!run) throw new Error("No turn is running");
    if (itemId) {
      const waiting = this.loadItems(threadId).find((it) => it.id === itemId && it.kind === "user" && it.steer === "waiting");
      if (waiting) {
        await this.sendNow(threadId);
        return { steered: false };
      }
      if (!this.preferQueued(threadId, itemId)) throw new Error("That message is not queued");
    }
    if (run.steer || !session?.steer) {
      await this.sendNow(threadId);
      return { steered: false };
    }
    const queue = this.queues.get(threadId);
    if (!queue?.length) throw new Error("Nothing is queued");
    if (!this.steerFirst(threadId)) throw new Error("Finish editing the queued message first");
    return { steered: true };
  }

  /**
   * A Kanban card's board sends a comment to the thread working on the card, or Continue to the one
   * that worked on it before. A comment goes into the running turn (steered in, or queued behind it
   * when the provider cannot steer) and is not sent when the thread is idle: the board offers
   * Continue instead. Continue sends the host's own note telling the agent to read the card again.
   */
  cardMessage(threadId: string, card: CardRef, text: string): { delivered: "steered" | "queued" | "started" | null } {
    if (!card.resume) {
      if (!this.runs.has(threadId)) return { delivered: null };
      if (!text.trim()) throw new Error("Empty comment");
    }
    const body = card.resume
      ? `Continue the work on card #${card.num}. Its description, checklist, or comments may have changed since you last worked on it: get the card again and read it in full before you go on. The board has claimed it for you again and moved it to the working column, so don't claim it; finish it when you are done.`
      : text;
    const { queued } = this.send(threadId, { text: body, from: "page", card });
    if (!queued) return { delivered: "started" };
    // Steer only when it is the one queued message: steering takes the queue's first.
    if (!card.resume && this.queues.get(threadId)?.length === 1 && this.steerFirst(threadId)) return { delivered: "steered" };
    return { delivered: "queued" };
  }

  /** Put this queued item first so steer / send-now acts on it. */
  private preferQueued(threadId: string, itemId: string): boolean {
    const queue = this.queues.get(threadId);
    const i = queue?.findIndex((msg) => msg.itemId === itemId) ?? -1;
    if (i < 0 || !queue || i >= queue.length) return false;
    if (queue.slice(0, i + 1).some((msg) => msg.edit)) throw new Error("Finish editing the queued message first");
    if (i > 0) {
      const [msg] = queue.splice(i, 1);
      queue.unshift(msg);
    }
    return true;
  }

  /** Hand the first queued message to the running turn. False when there is nothing to hand, or the provider cannot take it now. */
  private steerFirst(threadId: string): boolean {
    const run = this.runs.get(threadId);
    const queue = this.queues.get(threadId);
    const session = this.sessions.get(threadId);
    if (!run || run.steer || !session?.steer || !queue?.length) return false;
    if (queue[0].edit) return false;
    const msg = queue.shift()!;
    if (!queue.length) this.queues.delete(threadId);
    const item = this.loadItems(threadId).find((it) => it.id === msg.itemId);
    const thread = this.requireThread(threadId);
    const id = session.steer({ text: promptText(msg, thread, this.pageGuides(thread, msg)), images: msg.images, documents: pdfs(msg) });
    run.steer = { id, msg, itemId: item?.id };
    if (item && item.kind === "user") {
      item.steer = "waiting";
      this.touch(item);
    }
    this.emitThread(threadId);
    return true;
  }

  private pendingMessage(threadId: string, itemId?: string): QueuedMessage {
    const queue = this.queues.get(threadId) ?? [];
    const waiting = this.runs.get(threadId)?.steer;
    const msg = itemId
      ? queue.find((msg) => msg.itemId === itemId) ?? (waiting?.itemId === itemId ? waiting.msg : undefined)
      : queue[queue.length - 1] ?? waiting?.msg;
    if (!msg) throw new Error("That message is no longer pending");
    return msg;
  }

  /** Hold before awaiting withdrawal so turn completion cannot drain this message meanwhile. */
  async beginQueuedEdit(threadId: string, itemId: string, recover = false): Promise<{ token: string }> {
    const msg = this.pendingMessage(threadId, itemId);
    if (msg.edit) {
      if (!recover || msg.edit.withdrawal) throw new Error("That message is already being edited");
      // A reloaded view can reopen a stranded edit; stale popup tokens cannot save or release it.
      msg.edit.token = crypto.randomBytes(12).toString("hex");
      return { token: msg.edit.token };
    }
    const run = this.runs.get(threadId);
    const waiting = run?.steer;
    const wasSteered = waiting?.msg === msg;
    const token = crypto.randomBytes(12).toString("hex");
    msg.edit = { token, steer: wasSteered };
    if (wasSteered && waiting) {
      msg.edit.withdrawal = this.sessions.get(threadId)?.withdrawSteer?.(waiting.id).catch(() => false) ?? Promise.resolve(false);
      const withdrawn = await msg.edit.withdrawal;
      if (!withdrawn) {
        delete msg.edit;
        this.drainQueue(threadId);
        throw new Error("That message has already been handed to the agent");
      }
      if (run?.steer === waiting) {
        run.steer = null;
        const queue = this.queues.get(threadId) ?? [];
        queue.unshift(msg);
        this.queues.set(threadId, queue);
      }
      delete msg.edit?.withdrawal;
    }
    const item = this.loadItems(threadId).find((it) => it.id === itemId);
    if (!item || item.kind !== "user" || item.turnId || item.dropped) {
      delete msg.edit;
      throw new Error("That message is no longer pending");
    }
    delete item.steer;
    item.editing = true;
    this.touch(item);
    this.emitThread(threadId);
    return { token };
  }

  finishQueuedEdit(threadId: string, itemId: string, token: string, text?: string): void {
    const msg = this.pendingMessage(threadId, itemId);
    if (!msg.edit || msg.edit.token !== token) throw new Error("That edit is no longer active");
    if (text !== undefined && !text.trim() && !msg.images.length && !msg.files.length) throw new Error("Empty message");
    const steer = msg.edit.steer;
    const item = this.loadItems(threadId).find((it) => it.id === itemId);
    if (text !== undefined) msg.text = text;
    delete msg.edit;
    if (item?.kind === "user") {
      item.text = msg.text;
      delete item.editing;
      this.touch(item);
    }
    if (steer && this.queues.get(threadId)?.[0] === msg) this.steerFirst(threadId);
    this.emitThread(threadId);
    this.drainQueue(threadId);
  }

  async withdraw(threadId: string, itemId?: string): Promise<{ text: string; images: ChatImage[]; files: ChatFile[]; context: ContextChip[] }> {
    const msg = this.pendingMessage(threadId, itemId);
    const id = msg.itemId;
    if (!id) throw new Error("That message is no longer pending");
    await this.beginQueuedEdit(threadId, id);
    const queue = this.queues.get(threadId);
    const at = queue?.indexOf(msg) ?? -1;
    if (at < 0 || !queue) throw new Error("That message is no longer pending");
    queue.splice(at, 1);
    if (!queue.length) this.queues.delete(threadId);
    const item = this.loadItems(threadId).find((it) => it.id === id);
    if (item) this.removeItem(item);
    this.forgetFiles(threadId, msg);
    this.emitThread(threadId);
    this.drainQueue(threadId);
    return { text: msg.text, images: msg.images, files: msg.files, context: msg.context };
  }

  /** Never pass an edited head of the queue, even when the preceding turn has ended. */
  private drainQueue(threadId: string): void {
    if (this.runs.has(threadId) || !this.threads.has(threadId)) return;
    const queue = this.queues.get(threadId);
    if (!queue?.length || queue[0].edit) return;
    const next = queue.shift()!;
    if (!queue.length) this.queues.delete(threadId);
    const item = this.loadItems(threadId).find((it) => it.id === next.itemId);
    void this.runTurn(threadId, next, item ?? this.addItem(threadId, null, userBody(next)));
  }

  /** A withdrawn message's saved files: the composer has them again and saves them anew on send. */
  private forgetFiles(threadId: string, msg: QueuedMessage): void {
    try {
      removeFiles(threadId, [...msg.saved.images, ...msg.saved.files].map((ref) => ref.id));
    } catch (err) {
      log(`Removing withdrawn files failed: ${(err as Error).message}`);
    }
  }

  private removeItem(item: Item): void {
    const items = this.loadItems(item.threadId);
    const at = items.indexOf(item);
    if (at >= 0) items.splice(at, 1);
    this.dirty.delete(item.id);
    this.deltaBuf.delete(item.id);
    this.db.deleteItem(item.id);
    this.emit({ type: "agent_item_deleted", threadId: item.threadId, id: item.id });
  }

  /**
   * Stop the running turn and run the waiting steered message, or else the first queued one, as the
   * next turn. Unlike cancel, the rest of the queue stays.
   */
  async sendNow(threadId: string, itemId?: string): Promise<void> {
    const run = this.runs.get(threadId);
    if (itemId) {
      const waiting = this.loadItems(threadId).find((it) => it.kind === "user" && it.steer === "waiting");
      if (waiting) {
        if (waiting.id !== itemId) return;
      } else if (!this.preferQueued(threadId, itemId)) return;
    }
    if (this.queues.get(threadId)?.[0]?.edit) throw new Error("Finish editing the queued message first");
    if (!run) { this.drainQueue(threadId); return; }
    if (!run.steer && !this.queues.get(threadId)?.length) return;
    await this.cancel(threadId, { keepQueue: true });
  }

  /**
   * A background agent asked for approval between turns. The thread's own rules still apply; past
   * those, nobody is there to answer, so it is refused with a note the agent can act on.
   */
  private approveBetweenTurns(threadId: string, req: ApprovalRequest): Promise<ApprovalDecision> {
    const auto = autoApproval(this.threads.get(threadId), req);
    if (auto) return auto;
    const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind === "reject_always");
    const note = "The user was not asked: this ran in the background after the turn ended. Leave it out, and mention it in your result.";
    return reject ? Promise.resolve({ optionId: reject.id, note }) : Promise.reject(new Error(note));
  }

  /**
   * A web call the thread's web setting does not cover (off, or off the limited allowlist): ask the
   * user to allow it once, for its domain or for the rest of the thread. In a board worker's thread
   * nobody may be watching, so an unanswered request is refused after its importance's wait and the
   * agent carries on without it.
   */
  async requestWeb(threadId: string, call: WebCall, opts: { importance?: WebImportance; reason?: string; signal?: AbortSignal } = {}): Promise<{ allowed: boolean; message?: string }> {
    const thread = this.threads.get(threadId);
    if (!thread) return { allowed: false, message: "Unknown thread." };
    if (webCallAllowed(call, thread.web, this.prefs().webAllowlist, thread.webGrants)) return { allowed: true };
    if (this.takeWebPass(threadId, call)) return { allowed: true };
    const run = this.runs.get(threadId);
    if (!run) return { allowed: false, message: "Web access is off for this thread, and with no turn running the user cannot be asked. Carry on without it." };
    const importance = opts.importance ?? "useful";
    const waitMs = pageOwned(this.loadItems(threadId)) ? WEB_IMPORTANCE_WAIT_MS[importance] : null;
    const domains = webCallDomains(call);
    const title = call.kind === "fetch" ? `Web access: fetch ${call.url}` : `Web access: search${call.query ? ` “${call.query}”` : ""}${domains.length ? ` on ${domains.join(", ")}` : ""}`;
    const detail = [
      `Web access for this thread is ${thread.web === "limited" ? "limited to the allowlist" : "off"}. Importance: ${importance}.`,
      opts.reason?.trim(),
      waitMs !== null ? `Refused if not answered by ${new Date(Date.now() + waitMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; the agent then goes on without it.` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    const options: ApprovalOption[] = [
      { id: "once", label: "Allow once", kind: "allow_once" },
      ...(domains.length ? [{ id: "domain", label: domains.length === 1 ? `Allow ${domains[0]}` : "Allow these domains", kind: "allow_always" as const }] : []),
      { id: "session", label: "Allow for this thread", kind: "allow_always" },
      { id: "deny", label: "Deny", kind: "reject_once" },
    ];
    this.closeBlocks(run);
    const item = this.addItem(threadId, run.turn.id, { kind: "approval", requestId: "", tool: "fetch", title: title.slice(0, 300), detail, options, status: "pending" });
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    opts.signal?.addEventListener("abort", onAbort);
    let timedOut = false;
    const timer =
      waitMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, waitMs);
    try {
      const decision = await this.waitPending<ApprovalDecision>(threadId, run, "approval", item.id, abort.signal);
      if (decision.optionId === "deny") return { allowed: false, message: decision.note ? `The user denied this web request: ${decision.note}` : "The user denied this web request. Carry on without it." };
      if (decision.optionId === "domain" || decision.optionId === "session") {
        const t = this.threads.get(threadId);
        if (t) {
          t.webGrants = grantWeb(t.webGrants, decision.optionId, call);
          this.db.saveThread(t);
          this.emitThread(threadId);
        }
      }
      return { allowed: true };
    } catch {
      return {
        allowed: false,
        message: timedOut ? "Nobody answered the web request in time. Carry on without web access and do what you can; mention what you could not check." : "The web request was cancelled.",
      };
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * web_request from the thread's MCP: ask ahead of the call, with the agent's importance and reason.
   * "Allow once" leaves a pass the next matching web call uses up.
   */
  async preRequestWeb(threadId: string, call: WebCall, opts: { importance?: WebImportance; reason?: string; signal?: AbortSignal }): Promise<{ allowed: boolean; message: string }> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("web_request only works in Scribe chat threads.");
    if (webCallAllowed(call, thread.web, this.prefs().webAllowlist, thread.webGrants)) return { allowed: true, message: "Already allowed: make the call." };
    const result = await this.requestWeb(threadId, call, opts);
    if (!result.allowed) return { allowed: false, message: result.message ?? "Not allowed." };
    const t = this.threads.get(threadId);
    if (t && !webCallAllowed(call, t.web, this.prefs().webAllowlist, t.webGrants)) {
      const passes = (this.webPasses.get(threadId) ?? []).filter((p) => Date.now() - p.at < WEB_PASS_MS);
      passes.push({ call, at: Date.now() });
      this.webPasses.set(threadId, passes);
      return { allowed: true, message: `Allowed once: make the ${call.kind === "fetch" ? "fetch" : "search"} now.` };
    }
    return { allowed: true, message: "Allowed: make the call." };
  }

  /** The store's folder and page lookups, for thread access scopes. */
  private scopeLookup(): ScopeLookup {
    return {
      pageFolder: (id) => store.get(id, "agent")?.folderId ?? null,
      folderInside: (folderId, rootId) => store.folderInside(folderId, rootId),
      pageTitle: (id) => store.get(id, "agent")?.title ?? null,
      folderPath: (id) => store.folderPath(id),
    };
  }

  /**
   * Ask the user to let a thread read other threads in its scopes (its workspace, its page or folder;
   * any thread for a global thread). Grants last for the rest of the thread; only narrows the ask to
   * some of those scopes. Like web requests, a board worker's chat stops waiting after the importance's wait.
   */
  async requestThreadAccess(
    threadId: string,
    opts: { only?: Array<AccessScope["kind"]>; importance?: WebImportance; reason?: string; signal?: AbortSignal } = {}
  ): Promise<{ allowed: boolean; message: string; scopes: string[] }> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Reading other threads only works in Scribe chat threads.");
    const lookup = this.scopeLookup();
    const labels = (scopes: AccessScope[]) => scopes.map((s) => scopeLabel(s, lookup));
    const granted = () => {
      const t = this.threads.get(threadId) ?? thread;
      return allowedGrants(t, t.threadGrants ?? []);
    };
    let want = requestableScopes(thread);
    if (opts.only?.length) want = want.filter((s) => opts.only!.includes(s.kind));
    if (!want.length) return { allowed: false, message: "This thread has no such scope to ask for: it can ask for its workspace, its page or folder, or (a global thread) all threads.", scopes: labels(granted()) };
    if (scopesGranted(granted(), want)) return { allowed: true, message: "Already allowed.", scopes: labels(granted()) };
    const run = this.runs.get(threadId);
    if (!run) return { allowed: false, message: "With no turn running the user cannot be asked.", scopes: labels(granted()) };
    const importance = opts.importance ?? "useful";
    const waitMs = pageOwned(this.loadItems(threadId)) ? WEB_IMPORTANCE_WAIT_MS[importance] : null;
    const detail = [
      `The agent asks to read the transcripts of other threads: ${labels(want).join("; ")}. Importance: ${importance}.`,
      opts.reason?.trim(),
      waitMs !== null ? `Refused if not answered by ${new Date(Date.now() + waitMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; the agent then goes on without it.` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    const short: Record<AccessScope["kind"], string> = { workspace: "workspace", page: "page", folder: "folder", all: "all threads" };
    const options: ApprovalOption[] = [
      { id: "all", label: want.length === 1 ? "Allow for this thread" : "Allow all of these", kind: "allow_always" },
      ...(want.length > 1 ? want.map((s, i) => ({ id: `s${i}`, label: `Only ${short[s.kind]}`, kind: "allow_always" as const })) : []),
      { id: "deny", label: "Deny", kind: "reject_once" },
    ];
    this.closeBlocks(run);
    const title = `Read other threads: ${labels(want).join("; ")}`;
    const item = this.addItem(threadId, run.turn.id, { kind: "approval", requestId: "", tool: "read", title: title.slice(0, 300), detail, options, status: "pending" });
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    opts.signal?.addEventListener("abort", onAbort);
    let timedOut = false;
    const timer =
      waitMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, waitMs);
    try {
      const decision = await this.waitPending<ApprovalDecision>(threadId, run, "approval", item.id, abort.signal);
      if (decision.optionId === "deny") {
        return { allowed: false, message: decision.note ? `The user denied reading other threads: ${decision.note}` : "The user denied reading other threads. Carry on without them.", scopes: labels(granted()) };
      }
      const picked = decision.optionId === "all" ? want : want.filter((_, i) => decision.optionId === `s${i}`);
      const t = this.threads.get(threadId);
      if (t) {
        t.threadGrants = grantScopes(t.threadGrants, picked);
        this.db.saveThread(t);
        this.emitThread(threadId);
      }
      return { allowed: true, message: `Allowed: ${labels(picked).join("; ")}.`, scopes: labels(granted()) };
    } catch {
      return {
        allowed: false,
        message: timedOut ? "Nobody answered in time. Carry on without reading other threads." : "The request was cancelled.",
        scopes: labels(granted()),
      };
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** A thread's items without caching them, so a search over many threads does not keep them all in memory. */
  private peekItems(threadId: string): Item[] {
    return this.items.get(threadId) ?? this.db.listItems(threadId);
  }

  /** A thread's turns, from the cache when loaded, else straight from the database. */
  private peekTurns(threadId: string): Turn[] {
    return this.turns.get(threadId) ?? this.db.listTurns(threadId);
  }

  /** Threads reader may read, asking for access first when it has none yet. */
  private async readableThreads(readerId: string, opts: { importance?: WebImportance; signal?: AbortSignal }): Promise<{ reader: Thread; threads: Thread[]; lookup: ScopeLookup }> {
    let reader = this.threads.get(readerId);
    if (!reader) throw new Error("Reading other threads only works in Scribe chat threads.");
    if (!allowedGrants(reader, reader.threadGrants ?? []).length) {
      const asked = await this.requestThreadAccess(readerId, { importance: opts.importance, signal: opts.signal });
      if (!asked.allowed) throw new Error(asked.message);
      reader = this.threads.get(readerId) ?? reader;
    }
    const lookup = this.scopeLookup();
    const threads = [...this.threads.values()].filter((t) => canReadThread(reader, t, lookup));
    return { reader, threads, lookup };
  }

  private threadStatus(t: Thread, turns: Turn[]): string {
    return this.runs.has(t.id) ? "running" : turns.at(-1)?.status ?? "new";
  }

  /** thread_list: threads this one may read, newest first; q searches titles and transcripts. */
  async listReadableThreads(
    readerId: string,
    opts: { q?: string; limit?: number; archived?: boolean; importance?: WebImportance; signal?: AbortSignal } = {}
  ): Promise<{ scopes: string[]; threads: Array<Record<string, unknown>>; more: number }> {
    const { reader, threads, lookup } = await this.readableThreads(readerId, opts);
    const words = queryWords(opts.q);
    const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20)));
    const rows: Array<Record<string, unknown>> = [];
    let more = 0;
    const sorted = threads.filter((t) => opts.archived || !t.archived).sort((a, b) => b.activityAt - a.activityAt);
    for (const t of sorted) {
      let hits: number | undefined;
      let match: string | undefined;
      if (words.length) {
        const titleHit = words.every((w) => t.title.toLowerCase().includes(w));
        const found = this.peekItems(t.id).filter((it) => itemMatches(it, words));
        if (!titleHit && !found.length) continue;
        hits = found.length;
        const first = found[0] ? itemText(found[0]) : null;
        if (first) match = first.length > 300 ? `${first.slice(0, 300)}…` : first;
      }
      if (rows.length >= limit) {
        more += 1;
        continue;
      }
      const turns = this.peekTurns(t.id);
      const wt = t.worktree;
      rows.push({
        id: t.id,
        title: t.title,
        provider: t.provider,
        model: t.model,
        mode: t.mode,
        scope: threadScopeLabel(t, lookup),
        ...(t.cwd ? { cwd: t.cwd } : {}),
        ...(wt ? { branch: wt.branch, ...(wt.closed ? { worktree: wt.closed.how } : {}) } : {}),
        status: this.threadStatus(t, turns),
        turns: turns.length,
        createdAt: new Date(t.createdAt).toISOString(),
        activityAt: new Date(t.activityAt).toISOString(),
        ...(t.archived ? { archived: true } : {}),
        ...(hits !== undefined ? { hits } : {}),
        ...(match ? { match } : {}),
      });
    }
    return { scopes: allowedGrants(reader, reader.threadGrants ?? []).map((s) => scopeLabel(s, lookup)), threads: rows, more };
  }

  /**
   * thread_read: one readable thread's transcript as compact text. Without from, the last limit
   * items; q keeps items that mention every word; kinds keeps only those item kinds (user, text, tool, …).
   */
  async readOtherThread(
    readerId: string,
    opts: { thread: string; from?: number; limit?: number; q?: string; kinds?: string[]; full?: boolean; importance?: WebImportance; signal?: AbortSignal }
  ): Promise<Record<string, unknown>> {
    const { threads, lookup } = await this.readableThreads(readerId, opts);
    const target = threads.find((t) => t.id === opts.thread);
    if (!target) {
      const outside = this.threads.has(opts.thread) && opts.thread !== readerId;
      throw new Error(outside ? "That thread is outside the scopes this thread may read; thread_access asks for the rest of its scopes." : `No readable thread ${opts.thread}. thread_list shows the ones you can read.`);
    }
    const words = queryWords(opts.q);
    const kinds = opts.kinds?.length ? new Set(opts.kinds) : null;
    const pool = this.peekItems(target.id).filter((it) => (!kinds || kinds.has(it.kind)) && itemMatches(it, words) && itemText(it) !== null);
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 40)));
    const start = opts.from !== undefined ? pool.findIndex((it) => it.seq >= opts.from!) : Math.max(0, pool.length - limit);
    const page = start < 0 ? [] : pool.slice(start, start + limit);
    const turns = this.peekTurns(target.id);
    const turnNo = new Map(turns.map((t, i) => [t.id, i + 1]));
    const wt = target.worktree;
    return {
      thread: {
        id: target.id,
        title: target.title,
        provider: target.provider,
        model: target.model,
        scope: threadScopeLabel(target, lookup),
        ...(target.cwd ? { cwd: target.cwd } : {}),
        ...(wt ? { branch: wt.branch, base: wt.base, ...(wt.closed ? { worktree: wt.closed.how } : {}) } : {}),
        status: this.threadStatus(target, turns),
        turns: turns.length,
      },
      total: pool.length,
      items: page.map((it) => ({
        seq: it.seq,
        ...(it.turnId && turnNo.has(it.turnId) ? { turn: turnNo.get(it.turnId) } : {}),
        at: new Date(it.createdAt).toISOString(),
        text: itemText(it, { full: opts.full }),
      })),
      ...(start > 0 && page.length ? { earlier: { from: pool[Math.max(0, start - limit)].seq } } : {}),
      ...(start >= 0 && start + limit < pool.length ? { later: { from: pool[start + limit].seq } } : {}),
    };
  }

  /** Use up an "Allow once" pass from web_request that covers this call. */
  private takeWebPass(threadId: string, call: WebCall): boolean {
    const passes = (this.webPasses.get(threadId) ?? []).filter((p) => Date.now() - p.at < WEB_PASS_MS);
    const index = passes.findIndex((p) => webPassCovers(p.call, call));
    if (index >= 0) passes.splice(index, 1);
    if (passes.length) this.webPasses.set(threadId, passes);
    else this.webPasses.delete(threadId);
    return index >= 0;
  }

  /** A subagent or background command changed; its tool item can be from an earlier turn. */
  private patchTask(threadId: string, toolId: string, patch: Partial<TaskInfo>): void {
    if (!this.threads.has(threadId)) return;
    const items = this.loadItems(threadId);
    let item: Item | undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "tool" && it.toolId === toolId) {
        item = it;
        break;
      }
    }
    if (!item || item.kind !== "tool") return;
    // A finished task stays finished: late progress frames do not bring it back.
    if (item.task && item.task.status !== "running" && patch.status === undefined) return;
    item.task = { id: "", type: "agent", status: "running", ...item.task, ...patch };
    this.touch(item);
    this.emitThread(threadId);
  }

  /** Background tasks still working in this thread. */
  backgroundTasks(threadId: string): number {
    const items = this.items.get(threadId);
    if (!items) return 0;
    return items.filter((it) => it.kind === "tool" && it.task?.status === "running" && (it.task.background || it.turnId !== this.runs.get(threadId)?.turn.id)).length;
  }

  private taskItem(threadId: string, itemId: string): Item & { kind: "tool" } {
    const item = this.loadItems(threadId).find((it) => it.id === itemId);
    if (!item || item.kind !== "tool" || !item.task) throw new Error("Task not found");
    return item;
  }

  async stopTask(threadId: string, itemId: string): Promise<void> {
    const item = this.taskItem(threadId, itemId);
    if (item.task!.status !== "running") return;
    const session = this.sessions.get(threadId);
    if (!session?.stopTask) throw new Error("This agent cannot stop a single task");
    await session.stopTask(item.task!.id);
  }

  async backgroundTask(threadId: string, itemId: string): Promise<{ moved: boolean }> {
    const item = this.taskItem(threadId, itemId);
    const session = this.sessions.get(threadId);
    if (!session?.backgroundTask) throw new Error("This agent cannot move a task to the background");
    return { moved: await session.backgroundTask(item.toolId) };
  }

  /**
   * The agent started a turn of its own (a background agent finished and it reacts). Runs it as a
   * turn with no user message, unless one of the user's is running or about to.
   */
  private followUp(threadId: string, id: string): boolean {
    if (!this.threads.has(threadId) || this.runs.has(threadId) || this.queues.get(threadId)?.length) return false;
    void this.runTurn(threadId, null, null, { adopt: id });
    return true;
  }

  async cancel(threadId: string, { keepQueue = false }: { keepQueue?: boolean } = {}): Promise<void> {
    const run = this.runs.get(threadId);
    if (!keepQueue && run?.steer) {
      this.sessions.get(threadId)?.dropSteer?.(run.steer.id);
      const item = run.steer.itemId ? this.loadItems(threadId).find((it) => it.id === run.steer!.itemId) : undefined;
      if (item && item.kind === "user") {
        delete item.steer;
        item.dropped = true;
        this.touch(item);
      }
      run.steer = null;
      this.emitThread(threadId);
    }
    if (!keepQueue && this.queues.delete(threadId)) {
      // Stop drops queued messages; they stay in the transcript as not sent.
      for (const item of this.queuedItems(threadId)) {
        if (item.kind === "user") {
          item.dropped = true;
          delete item.editing;
          this.touch(item);
        }
      }
      this.emitThread(threadId);
    }
    if (!run) return;
    run.cancelled = true;
    run.abort?.abort();
    for (const [id, pending] of this.pending) {
      if (pending.threadId === threadId) {
        this.pending.delete(id);
        pending.reject(new Error("cancelled"));
        this.expireInteraction(pending);
      }
    }
    await this.sessions.get(threadId)?.cancel();
  }

  private session(thread: Thread): ProviderSession {
    let session = this.sessions.get(thread.id);
    if (!session) {
      session = this.agent(thread.provider).createSession(thread, this.ctx);
      this.sessions.set(thread.id, session);
    }
    return session;
  }

  /** Run one turn. Without msg and userItem it is a turn the agent started itself (see followUp). */
  private async runTurn(threadId: string, msg: QueuedMessage | null, userItem: Item | null, opts?: { adopt?: string }): Promise<void> {
    let thread = this.requireThread(threadId);
    const turns = this.loadTurns(threadId);
    const turn: Turn = {
      id: `tu_${crypto.randomBytes(6).toString("hex")}`,
      threadId,
      seq: turns.length + 1,
      status: "running",
      model: thread.model,
      effort: thread.effort,
      mode: thread.mode,
      startedAt: Date.now(),
    };
    turns.push(turn);
    if (userItem) {
      userItem.turnId = turn.id;
      if (userItem.kind === "user") delete userItem.steer;
      this.touch(userItem);
    } else {
      this.addItem(threadId, turn.id, { kind: "notice", level: "info", text: "A background task finished; the agent picked it up." });
    }
    const run: RunState = { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null };
    this.runs.set(threadId, run);
    this.status.set(threadId, "running");
    this.limitTurn = { provider: thread.provider, threadId, turnId: turn.id, before: snapshotWindows(this.planLimits[thread.provider]) };
    thread.activityAt = Date.now();
    if (msg && !thread.titleLocked && thread.title === "New thread") {
      thread.title = titleFrom(msg.text);
    }
    this.db.saveThread(thread);
    this.saveTurn(turn);
    this.emitThread(threadId);

    // Checkpoint the page this turn is about, so an agent edit to it can be reverted.
    const pageId = thread.scope.kind === "page" && thread.scope.ref ? thread.scope.ref : msg?.context.find((c) => c.kind === "page")?.id;
    const pageTab = pageId ? store.get(pageId, "agent") : undefined;
    if (pageTab && !pageTab.templateId) {
      turn.page = { id: pageTab.id, title: pageTab.title, before: pageTab.revision };
      this.db.setSetting(`checkpoint:${turn.id}`, { html: pageTab.html, revision: pageTab.revision });
    }

    let setupError: string | null = null;
    let reopened = "";
    if (wantsWorktree(thread) && !run.cancelled) {
      try {
        ({ thread, reopened } = await this.makeWorktree(threadId, turn.id));
      } catch (err) {
        setupError = `Could not make the worktree: ${(err as Error).message}`;
      }
    }

    const worktree = openWorktree(thread);
    if (thread.mode !== "board" && thread.cwd && !setupError) {
      run.repo = await findRepo(thread.cwd);
      if (run.repo) {
        turn.repo = run.repo;
        turn.beforeTree = (await snapshotTree(run.repo)) ?? undefined;
        if (worktree) turn.beforeHead = (await headCommit(run.repo)) ?? undefined;
      }
    }

    let earlier = "";
    if (thread.fork && msg && !run.cancelled && !setupError) {
      try {
        earlier = await this.startFork(thread, thread.fork, run);
        thread = this.requireThread(threadId);
      } catch (err) {
        if (!run.cancelled) setupError = `Could not carry over the earlier thread: ${(err as Error).message}`;
      }
    }

    if (msg && thread.nativeId && !thread.rewind && !setupError && !(await this.canResume(thread))) {
      thread = this.startOverWithRecap(thread, turn.id);
    }

    const sink = this.makeSink(threadId, run);
    let result: TurnResult = setupError ? { status: "error", error: setupError } : { status: "cancelled" };
    // Stop can arrive while the snapshot above runs, before the provider has anything to cancel.
    if (!run.cancelled && !setupError) {
      try {
        const session = this.session(thread);
        session.update(thread);
        const pageEdits = this.pageEditPrefix(thread, turn.id);
        result = await session.run(
          {
            text: msg ? earlier + reopened + promptText(msg, thread, this.pageGuides(thread, msg), pageEdits) : reopened + pageEdits,
            images: msg?.images ?? [],
            documents: msg ? pdfs(msg) : [],
            instructions: threadInstructions(thread, this.scopeInfo(thread)),
          },
          sink,
          opts
        );
      } catch (err) {
        result = { status: "error", error: (err as Error).message };
      }
    }
    if (run.cancelled && result.status !== "error") result = { status: "cancelled", next: result.next };
    // An edit's withdrawal must settle before deciding whether to adopt or requeue a steer.
    await run.steer?.msg.edit?.withdrawal;
    // A steered message the turn did not take in: the provider runs it next (adopted below), or it lost it and it goes back to the front of the queue.
    const carried = run.steer && result.next === run.steer.id ? run.steer : null;
    if (run.steer && !carried) {
      const queue = this.queues.get(threadId) ?? [];
      queue.unshift(run.steer.msg);
      this.queues.set(threadId, queue);
      const item = run.steer.itemId ? this.loadItems(threadId).find((it) => it.id === run.steer!.itemId) : undefined;
      if (item && item.kind === "user") {
        delete item.steer;
        this.touch(item);
      }
    }
    run.steer = null;

    this.closeBlocks(run);
    for (const item of run.tools.values()) {
      if (item.kind === "tool" && (item.status === "running" || item.status === "pending")) {
        item.status = result.status === "done" ? "done" : "error";
        item.endedAt = Date.now();
        this.touch(item);
      }
    }
    for (const [id, pending] of this.pending) {
      if (pending.threadId === threadId) {
        this.pending.delete(id);
        pending.reject(new Error("turn ended"));
        this.expireInteraction(pending);
      }
    }
    if (result.error) {
      this.addItem(threadId, turn.id, { kind: "notice", level: "error", text: result.error });
    }

    if (run.repo && turn.beforeTree) {
      turn.afterTree = (await snapshotTree(run.repo)) ?? undefined;
      if (turn.afterTree) {
        turn.files = await diffTrees(run.repo, turn.beforeTree, turn.afterTree).catch(() => []);
      }
      if (turn.beforeHead) turn.afterHead = (await headCommit(run.repo)) ?? undefined;
    } else {
      turn.files = this.toolFiles(run);
    }
    if (turn.page) {
      const tab = store.get(turn.page.id, "agent");
      if (tab && tab.revision !== turn.page.before) {
        turn.page.after = tab.revision;
        turn.page.title = tab.title;
      } else {
        delete turn.page;
        this.db.deleteSetting(`checkpoint:${turn.id}`);
      }
    }
    this.rememberTurnPages(thread, msg, turn, pageId ? [pageId] : []);
    turn.status = result.status;
    turn.endedAt = Date.now();
    const rewound = this.threads.get(threadId);
    if (rewound?.rewind && result.status !== "cancelled") {
      delete rewound.rewind;
      this.db.saveThread(rewound);
    }
    if (rewound?.fork && result.status !== "cancelled") {
      delete rewound.fork;
      this.db.deleteSetting(`fork:${threadId}`);
      this.db.saveThread(rewound);
    }
    turn.usage = run.usage;
    if (result.error) turn.error = result.error;
    if (thread.provider === "cursor") this.refreshCursorUsage();
    if (thread.provider === "codex") void this.refreshCodexUsage();
    if (result.status === "error") {
      const resetsAt = usageLimitResetsAt(result.error, this.planLimits[thread.provider], turn.startedAt, turn.endedAt);
      if (resetsAt) turn.limitResetsAt = resetsAt;
    }
    this.saveTurn(turn);
    this.flushNow();
    this.runs.delete(threadId);
    this.status.set(threadId, "idle");
    const latest = this.threads.get(threadId);
    const latestWt = latest ? openWorktree(latest) : null;
    if (latest && latestWt) {
      const progress = await worktreeProgress(latestWt).catch(() => null);
      if (progress) latest.worktree = { ...latestWt, ...progress };
    }
    if (latest) {
      latest.activityAt = Date.now();
      this.db.saveThread(latest);
      if (!pageOwned(this.loadItems(threadId))) this.unread.add(threadId);
    }
    this.emitThread(threadId);

    if (carried && latest) {
      const item = carried.itemId ? this.loadItems(threadId).find((it) => it.id === carried.itemId) : undefined;
      void this.runTurn(threadId, carried.msg, item ?? this.addItem(threadId, null, { kind: "user", text: carried.msg.text }), { adopt: carried.id });
      return;
    }
    this.drainQueue(threadId);
  }

  private toolFiles(run: RunState): FileChange[] {
    const byPath = new Map<string, FileChange>();
    for (const item of run.tools.values()) {
      if (item.kind !== "tool" || !item.files) continue;
      for (const file of item.files) {
        const prev = byPath.get(file.path);
        byPath.set(file.path, {
          path: file.path,
          status: prev?.status === "A" ? "A" : file.status ?? "M",
          added: (prev?.added ?? 0) + file.added,
          removed: (prev?.removed ?? 0) + file.removed,
        });
      }
    }
    return [...byPath.values()];
  }

  private closeBlocks(run: RunState): void {
    if (run.reasoningItem && run.reasoningItem.kind === "reasoning" && !run.reasoningItem.endedAt) {
      run.reasoningItem.endedAt = Date.now();
      this.touch(run.reasoningItem);
    }
    run.reasoningItem = null;
    if (run.textItem) this.flushDelta(run.textItem.id);
    run.textItem = null;
  }

  private expireInteraction(pending: Pending): void {
    const item = this.loadItems(pending.threadId).find((it) => it.id === pending.itemId);
    if (!item) return;
    if ((item.kind === "approval" || item.kind === "question") && item.status === "pending") {
      item.status = "expired";
      this.touch(item);
    } else if (item.kind === "plan" && item.status === "pending") {
      item.status = "shown";
      this.touch(item);
    }
  }

  /** Wait for the user to answer an interaction item; the thread shows as waiting meanwhile. */
  private waitPending<T>(threadId: string, run: RunState, kind: Pending["kind"], itemId: string, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = itemId;
      this.pending.set(requestId, { kind, threadId, itemId, resolve: resolve as never, reject } as Pending);
      if (this.status.get(threadId) === "waiting") this.emitThread(threadId);
      else this.setStatus(threadId, "waiting");
      const onAbort = () => {
        const pending = this.pending.get(requestId);
        if (pending) {
          this.pending.delete(requestId);
          this.expireInteraction(pending);
          reject(new Error("aborted"));
        }
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort);
    }).finally(() => {
      if (this.runs.get(threadId) !== run) return;
      if (![...this.pending.values()].some((p) => p.threadId === threadId)) this.setStatus(threadId, "running");
      else this.emitThread(threadId);
    });
  }

  /**
   * page_ask: show a page as a question in the thread's running turn and wait until the page logs
   * one of `events` (its submit), the user skips it in the chat, or the turn ends. Returns what the
   * agent needs to carry on, including the page's state after the answer.
   */
  async askPage(threadId: string, opts: { page: string; prompt?: string; events: string[]; after?: number; timeoutMs: number; signal: AbortSignal }): Promise<PageAskResult> {
    const run = this.runs.get(threadId);
    if (!run) throw new Error("page_ask only works while this chat thread has a turn running.");
    const tab = store.get(opts.page, "agent");
    if (!tab) throw new Error(`tab not found: ${opts.page}`);
    const after = typeof opts.after === "number" && opts.after >= 0 ? Math.floor(opts.after) : tab.eventSeq;
    this.closeBlocks(run);
    const item = this.addItem(threadId, run.turn.id, {
      kind: "question",
      requestId: "",
      ...(opts.prompt ? { title: opts.prompt.slice(0, 300) } : {}),
      questions: [],
      page: { id: tab.id, key: tab.key, title: tab.title },
      status: "pending",
    });
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, opts.signal]);
    const chat = this.waitPending<QuestionAnswer>(threadId, run, "question", item.id, signal);
    chat.catch(() => {});
    const page = waitForEvents({ idOrKey: tab.id, names: opts.events, after, timeoutMs: opts.timeoutMs, viewer: "agent", abort: signal });
    try {
      const first = await Promise.race([chat.then((answer) => ({ answer }) as const), page.then((wait) => ({ wait }) as const)]);
      if ("answer" in first) {
        const reason = "skipped" in first.answer ? first.answer.reason : undefined;
        return { skipped: true, ...(reason ? { note: reason } : {}), page: { id: tab.id, key: tab.key } };
      }
      const wait = first.wait;
      const base = { page: { id: wait.id, key: wait.key }, cursor: wait.cursor };
      if (!wait.events.length) {
        // Closed, deleted, timed out, or the call was cancelled; the abort below expires the card.
        return { ...base, answered: false, closed: wait.closed, deleted: wait.deleted, timedOut: wait.timedOut && !opts.signal.aborted };
      }
      if (this.pending.has(item.id)) this.resolveQuestion(item.id, { answers: {} });
      if (item.kind === "question") {
        item.event = wait.events[wait.events.length - 1].name;
        this.touch(item);
      }
      const now = store.get(tab.id, "agent");
      return { ...base, answered: true, events: wait.events, stateRevision: now?.stateRevision ?? wait.stateRevision, state: now?.state ?? null };
    } catch {
      return { cancelled: true, page: { id: tab.id, key: tab.key } };
    } finally {
      stop.abort();
    }
  }

  private makeSink(threadId: string, run: RunState): RunSink {
    const turnId = run.turn.id;
    const host = this;
    const thread = () => host.threads.get(threadId);
    const waitFor = <T>(kind: Pending["kind"], itemId: string, signal?: AbortSignal): Promise<T> => host.waitPending<T>(threadId, run, kind, itemId, signal);

    return {
      nativeId(id) {
        const t = thread();
        if (t && t.nativeId !== id) {
          t.nativeId = id;
          host.db.saveThread(t);
        }
      },
      text(delta, parentToolId) {
        if (!delta) return;
        run.turn.outputAt = Date.now();
        if (parentToolId) {
          // A subagent's message, whole: one nested item each, shown under the tool call that started it.
          if (run.tools.has(parentToolId)) host.addItem(threadId, turnId, { kind: "text", text: delta, parentToolId });
          return;
        }
        if (run.reasoningItem) {
          if (run.reasoningItem.kind === "reasoning") run.reasoningItem.endedAt = Date.now();
          host.touch(run.reasoningItem);
          run.reasoningItem = null;
        }
        if (!run.textItem) {
          run.textItem = host.addItem(threadId, turnId, { kind: "text", text: "" });
        }
        host.appendText(run.textItem as Item & { text: string }, delta);
      },
      reasoning(delta, parentToolId) {
        if (!delta) return;
        run.turn.outputAt = Date.now();
        if (parentToolId) {
          const now = Date.now();
          if (run.tools.has(parentToolId)) host.addItem(threadId, turnId, { kind: "reasoning", text: delta, startedAt: now, endedAt: now, parentToolId });
          return;
        }
        if (run.textItem) {
          host.flushDelta(run.textItem.id);
          run.textItem = null;
        }
        if (!run.reasoningItem) {
          run.reasoningItem = host.addItem(threadId, turnId, { kind: "reasoning", text: "", startedAt: Date.now() });
        }
        host.appendText(run.reasoningItem as Item & { text: string }, delta);
      },
      breakBlock() {
        host.closeBlocks(run);
      },
      checkpoint(id) {
        run.turn.nativeEnd = id;
      },
      toolStart(tool: ToolStart) {
        if (run.tools.has(tool.toolId)) return;
        run.turn.outputAt = Date.now();
        host.closeBlocks(run);
        const item = host.addItem(threadId, turnId, {
          kind: "tool",
          toolId: tool.toolId,
          name: tool.name,
          tool: tool.tool,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.input !== undefined ? { input: tool.input } : {}),
          ...(tool.paths ? { paths: tool.paths } : {}),
          ...(tool.parentToolId ? { parentToolId: tool.parentToolId } : {}),
          status: tool.status ?? "pending",
          startedAt: Date.now(),
        });
        run.tools.set(tool.toolId, item);
        if (tool.paths && (tool.tool === "edit" || tool.tool === "delete")) {
          for (const file of tool.paths) void host.rememberBefore(run, thread(), file);
        }
      },
      toolUpdate(toolId: string, patch: ToolPatch) {
        const item = run.tools.get(toolId);
        if (!item || item.kind !== "tool") return;
        if (patch.title) item.title = patch.title;
        if (patch.detail) item.detail = patch.detail;
        if (patch.input !== undefined) item.input = patch.input;
        if (patch.paths) {
          item.paths = patch.paths;
          if (item.tool === "edit" || item.tool === "delete") {
            for (const file of patch.paths) void host.rememberBefore(run, thread(), file);
          }
        }
        if (patch.output !== undefined) item.output = patch.output.length > MAX_TOOL_OUTPUT ? `${patch.output.slice(0, MAX_TOOL_OUTPUT)}\n…` : patch.output;
        if (patch.exitCode !== undefined) item.exitCode = patch.exitCode;
        const finished = patch.status === "done" || patch.status === "error";
        if (patch.status) item.status = patch.status;
        if (finished) item.endedAt = Date.now();
        host.touch(item);
        if (finished && (item.tool === "edit" || item.tool === "delete" || item.tool === "move") && item.paths?.length) {
          void host.computeToolDiff(run, thread(), item, patch.providerDiff);
        } else if (patch.providerDiff?.length && finished) {
          void host.computeToolDiff(run, thread(), item, patch.providerDiff);
        }
      },
      async beforeWrite(_toolId, file) {
        await host.rememberBefore(run, thread(), file, true);
      },
      approval(req: ApprovalRequest, signal) {
        const auto = autoApproval(thread(), req);
        if (auto) return auto;
        const item = host.addItem(threadId, turnId, {
          kind: "approval",
          requestId: "",
          ...(req.toolId ? { toolId: req.toolId } : {}),
          tool: req.tool,
          title: req.title,
          ...(req.detail ? { detail: req.detail } : {}),
          options: req.options,
          status: "pending",
        });
        return waitFor<ApprovalDecision>("approval", item.id, signal);
      },
      question(req: QuestionRequest, signal) {
        const item = host.addItem(threadId, turnId, { kind: "question", requestId: "", ...(req.title ? { title: req.title } : {}), questions: req.questions, status: "pending" });
        return waitFor<QuestionAnswer>("question", item.id, signal);
      },
      plan(req: PlanRequest, signal) {
        const item = host.addItem(threadId, turnId, { kind: "plan", requestId: "", ...(req.title ? { title: req.title } : {}), text: req.text, status: "pending" });
        return waitFor<PlanDecision>("plan", item.id, signal);
      },
      todos(todos) {
        const existing = [...host.loadItems(threadId)].reverse().find((item) => item.turnId === turnId && item.kind === "todos");
        if (existing && existing.kind === "todos") {
          existing.todos = todos;
          host.touch(existing);
        } else {
          host.closeBlocks(run);
          host.addItem(threadId, turnId, { kind: "todos", todos });
        }
      },
      usage(usage) {
        run.usage = { ...run.usage, ...Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined)) };
        run.turn.usage = run.usage;
        host.emit({ type: "agent_turn", turn: run.turn });
      },
      notice(level, text) {
        host.closeBlocks(run);
        host.addItem(threadId, turnId, { kind: "notice", level, text });
      },
      commands(list) {
        const t = thread();
        if (t && list.length) host.rememberCommands(t.provider, list);
      },
      title(title) {
        const t = thread();
        if (t && !t.titleLocked && title && title !== t.title) {
          t.title = title.slice(0, 120);
          host.db.saveThread(t);
          host.emitThread(threadId);
        }
      },
      modeChanged(mode) {
        const t = thread();
        if (t && t.mode !== mode) {
          t.mode = mode;
          host.db.saveThread(t);
          host.emitThread(threadId);
        }
      },
      steered(steerId) {
        if (run.steer?.id !== steerId) return;
        const itemId = run.steer.itemId;
        run.steer = null;
        const item = itemId ? host.loadItems(threadId).find((it) => it.id === itemId) : undefined;
        if (item && item.kind === "user") {
          // It now belongs to this turn, at the point the agent read it.
          host.closeBlocks(run);
          const seq = (host.seq.get(threadId) ?? 0) + 1;
          host.seq.set(threadId, seq);
          item.seq = seq;
          const items = host.loadItems(threadId);
          items.splice(items.indexOf(item), 1);
          items.push(item);
          item.turnId = turnId;
          item.steer = "folded";
          host.touch(item);
        }
        host.emitThread(threadId);
      },
    };
  }

  private resolvePath(thread: Thread | undefined, file: string): string {
    const base = thread?.mode === "board" || !thread?.cwd ? this.ctx.scratchDir : thread.cwd;
    return path.resolve(base, file);
  }

  /** Remember a file's content before a tool writes it. `fresh` (from a pre-tool hook) always re-reads. */
  private async rememberBefore(run: RunState, thread: Thread | undefined, file: string, fresh = false): Promise<void> {
    const abs = this.resolvePath(thread, file);
    if (!fresh && run.known.has(abs)) return;
    if (!fresh && run.repo && run.turn.beforeTree) {
      const rel = repoRelative(run.repo, abs);
      if (rel) {
        run.known.set(abs, await fileAtTree(run.repo, run.turn.beforeTree, rel));
        return;
      }
    }
    run.known.set(abs, readText(abs));
  }

  private async computeToolDiff(
    run: RunState,
    thread: Thread | undefined,
    item: Item,
    providerDiff?: Array<{ path: string; oldText: string | null; newText: string | null }>
  ): Promise<void> {
    if (item.kind !== "tool") return;
    const paths = new Set([...(item.paths ?? []), ...(providerDiff?.map((d) => d.path) ?? [])]);
    const files: NonNullable<typeof item.files> = [];
    const patches: string[] = [];
    for (const file of paths) {
      const abs = this.resolvePath(thread, file);
      const reported = providerDiff?.find((d) => this.resolvePath(thread, d.path) === abs);
      let before: string | null | undefined = run.known.get(abs);
      if (before === undefined && run.repo && run.turn.beforeTree) {
        const rel = repoRelative(run.repo, abs);
        if (rel) before = await fileAtTree(run.repo, run.turn.beforeTree, rel);
      }
      if (before === undefined) before = reported ? reported.oldText : null;
      const after = fs.existsSync(abs) ? readText(abs) : reported?.newText ?? null;
      run.known.set(abs, after);
      const display = run.repo ? repoRelative(run.repo, abs) ?? abs : thread?.cwd ? path.relative(thread.cwd, abs).replaceAll("\\", "/") : abs;
      const diff = unifiedDiff(before, after, display);
      if (!diff.patch) continue;
      files.push({ path: display, added: diff.added, removed: diff.removed, status: before === null ? "A" : after === null ? "D" : "M" });
      patches.push(diff.patch);
    }
    if (!files.length) return;
    item.files = files;
    const patch = patches.join("");
    item.diff = patch.length > MAX_TOOL_DIFF ? `${patch.slice(0, MAX_TOOL_DIFF)}\n… (diff truncated)\n` : patch;
    this.touch(item);
  }

  // ---------- interactions ----------

  resolveApproval(requestId: string, optionId: string, note?: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.kind !== "approval") throw new Error("This approval is no longer waiting.");
    this.pending.delete(requestId);
    const item = this.loadItems(pending.threadId).find((it) => it.id === pending.itemId);
    if (item && item.kind === "approval") {
      item.status = "resolved";
      item.decision = optionId;
      if (note) item.note = note;
      this.touch(item);
    }
    pending.resolve({ optionId, note });
  }

  resolveQuestion(requestId: string, answer: QuestionAnswer): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.kind !== "question") throw new Error("This question is no longer waiting.");
    this.pending.delete(requestId);
    const item = this.loadItems(pending.threadId).find((it) => it.id === pending.itemId);
    if (item && item.kind === "question") {
      if ("skipped" in answer) {
        item.status = "skipped";
      } else {
        item.status = "answered";
        item.answers = answer.answers;
        if (answer.notes) item.notes = answer.notes;
      }
      this.touch(item);
    }
    pending.resolve(answer);
  }

  resolvePlan(requestId: string, decision: PlanDecision): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.kind !== "plan") throw new Error("This plan is no longer waiting.");
    this.pending.delete(requestId);
    const planThread = this.threads.get(pending.threadId);
    if (decision.accepted && planThread?.mode === "plan" && (planThread.provider === "cursor" || planThread.provider === "codex")) {
      // Cursor and Codex end the turn after an accepted plan; continue in Code mode with a follow-up turn.
      this.updateThread(planThread.id, { mode: "code" });
      this.send(planThread.id, { text: "Implement the plan." });
    }
    const item = this.loadItems(pending.threadId).find((it) => it.id === pending.itemId);
    if (item && item.kind === "plan") {
      item.status = decision.accepted ? "accepted" : "rejected";
      if (decision.note) item.note = decision.note;
      this.touch(item);
    }
    pending.resolve(decision);
  }

  // ---------- worktrees ----------

  /**
   * Make the thread's worktree and move the thread into it. Runs at the start of its first turn, and
   * of the next turn after its branch was merged. reopened is a note for the agent in that case.
   */
  private async makeWorktree(threadId: string, turnId: string): Promise<{ thread: Thread; reopened: string }> {
    const home = this.requireThread(threadId).cwd!;
    const repo = await findRepo(home);
    let thread = this.requireThread(threadId);
    if (!repo) {
      thread = { ...thread, useWorktree: false };
      this.threads.set(threadId, thread);
      this.db.saveThread(thread);
      this.addItem(threadId, turnId, { kind: "notice", level: "info", text: "This folder is not in a git repository, so the thread works in it directly." });
      this.emitThread(threadId);
      return { thread, reopened: "" };
    }
    // A merged thread goes on in a worktree again, in the same folder when it can so its session resumes there.
    const merged = thread.worktree?.closed?.how === "merged" ? thread.worktree : null;
    const made = merged ? await reopenWorktree(merged, thread.title) : { ...(await createWorktree(home, repo, thread.title)), sameFolder: false };
    // Re-read: settings can change while git runs.
    thread = { ...this.requireThread(threadId), worktree: made.worktree, cwd: made.cwd };
    if (merged && thread.nativeId && !made.sameFolder) {
      // The session belongs to the old folder: start a new one with a recap, as after a rewind.
      const kept = this.loadTurns(threadId).filter((t) => t.id !== turnId && t.status !== "running");
      const recap = kept.length ? this.recap(this.loadItems(threadId), kept) : "";
      thread = { ...thread, nativeId: null, ...(recap ? { rewind: { at: null, recap, migrated: true } } : {}) };
    }
    this.threads.set(threadId, thread);
    this.db.saveThread(thread);
    const from = made.worktree.base ?? made.worktree.baseCommit.slice(0, 8);
    this.addItem(threadId, turnId, {
      kind: "notice",
      level: "info",
      text: `${merged ? "New worktree" : "Worktree"} on ${made.worktree.branch}, from ${from}${merged ? " as it is now" : ""}.`,
    });
    for (const note of made.notes) this.addItem(threadId, turnId, { kind: "notice", level: "warn", text: note });
    this.emitThread(threadId);
    const reopened = merged
      ? `<context>\nYour earlier work on branch ${merged.branch} was merged into ${from}, and its worktree was removed. This thread now works in a new worktree${made.sameFolder ? " in the same folder" : ` at ${made.worktree.path}`}, on branch ${made.worktree.branch} from ${from} as it is now, which may hold other work merged since. Files may have changed since you last read them: read them again before you edit them.\n</context>\n\n`
      : "";
    return { thread, reopened };
  }

  async worktreeInfo(threadId: string): Promise<{ worktree: ThreadWorktree | null; status: WorktreeStatus | null }> {
    const thread = this.requireThread(threadId);
    const wt = openWorktree(thread);
    return { worktree: thread.worktree ?? null, status: wt ? await worktreeStatus(wt) : null };
  }

  /**
   * Merge the worktree's branch into its base, or leave the branch for later. Either way the folder
   * goes. A merged thread keeps its session, and its next message opens a worktree again from the
   * base as it is then (in the same folder when it can, where the session resumes). A left one goes
   * back to the main checkout with a new session.
   */
  async finishWorktree(threadId: string, how: "merge" | "leave"): Promise<{ ok: true; message: string }> {
    if (this.runs.has(threadId)) throw new Error("Stop the running turn first.");
    const thread = this.requireThread(threadId);
    const wt = openWorktree(thread);
    if (!wt) throw new Error("This thread has no open worktree.");
    const sharers = this.sharers(threadId, wt);
    const busy = sharers.find((t) => this.runs.has(t.id));
    if (busy) throw new Error(`“${busy.title}” works in this worktree too and is running. Stop it first.`);
    let message: string;
    if (how === "merge") {
      const { commits } = await mergeWorktree(wt);
      message = commits
        ? `Merged ${commits} commit${commits === 1 ? "" : "s"} from ${wt.branch} into ${wt.base}.`
        : `${wt.branch} had no new commits, so there was nothing to merge.`;
      // Worktrees link the main checkout's node_modules, so a merged dependency change has to be installed there.
      if (commits) {
        const synced = await syncDependencies(wt.repo).catch((err) => `Checking node_modules after the merge failed: ${(err as Error).message}`);
        if (synced) message += ` ${synced}`;
      }
    } else {
      const committed = await commitAll(wt, `WIP: ${thread.title}`);
      message = `Left the work on branch ${wt.branch}${committed ? "; its uncommitted changes were committed there as WIP" : ""}.`;
    }
    // The provider process runs in the worktree folder; Windows will not remove a folder in use.
    for (const id of [threadId, ...sharers.map((t) => t.id)]) {
      this.sessions.get(id)?.dispose();
      this.sessions.delete(id);
      forgetGuides(id);
    }
    await removeWorktree(wt);
    if (how === "merge") await dropBranchIfEmpty(wt);
    // Agent sessions are tied to their folder. Forks that shared the worktree can't all reopen its
    // folder, so only the thread itself keeps its session; the others start over in the main checkout.
    const closed = { how: how === "merge" ? ("merged" as const) : ("left" as const), at: Date.now() };
    for (const id of [threadId, ...sharers.map((t) => t.id)]) {
      const reopen = how === "merge" && id === threadId;
      const cur = this.requireThread(id);
      const next: Thread = {
        ...cur,
        cwd: wt.home,
        useWorktree: reopen,
        worktree: { ...wt, ahead: 0, dirty: false, closed: reopen ? closed : { ...closed, how: "left" } },
        nativeId: reopen ? cur.nativeId : null,
        updatedAt: Date.now(),
      };
      this.threads.set(id, next);
      this.db.saveThread(next);
      const by = id === threadId ? "" : ` (from “${thread.title}”, which shared it)`;
      // A merged thread goes on as before (the next message opens a new worktree); say only what changes.
      const after = reopen ? "" : " The next message starts a new agent session in the folder.";
      this.addItem(id, null, { kind: "notice", level: "info", text: `${message}${by} Worktree removed.${after}` });
      this.emitThread(id);
    }
    this.flushNow();
    return { ok: true, message };
  }

  /** Other threads with the same worktree open: forks share it. */
  private sharers(threadId: string, wt: ThreadWorktree): Thread[] {
    const key = workspaceKey(wt.path);
    return [...this.threads.values()].filter((t) => t.id !== threadId && openWorktree(t) && workspaceKey(openWorktree(t)!.path) === key);
  }

  // ---------- changes ----------

  /** Files changed by one turn, or by the whole thread when turnId is omitted. */
  async changes(threadId: string, turnId?: string): Promise<{ repo: string | null; from?: string; to?: string; files: FileChange[] }> {
    let turns = this.loadTurns(threadId).filter((turn) => !turnId || turn.id === turnId);
    if (!turns.length) return { repo: null, files: [] };
    // The running turn has no after snapshot yet: take one now, so its changes so far show.
    const running = this.runs.get(threadId)?.turn;
    const live = running && turns.find((turn) => turn.id === running.id && turn.repo && turn.beforeTree && !turn.afterTree);
    if (live) {
      const afterTree = await snapshotTree(live.repo!);
      if (afterTree) {
        const files = await diffTrees(live.repo!, live.beforeTree!, afterTree).catch(() => []);
        turns = turns.map((turn) => (turn === live ? { ...turn, afterTree, files } : turn));
      }
    }
    const withTrees = turns.filter((turn) => turn.repo && turn.beforeTree && turn.afterTree);
    if (withTrees.length && withTrees.every((turn) => turn.repo === withTrees[0].repo)) {
      const first = withTrees[0];
      const last = withTrees[withTrees.length - 1];
      const files = turnId ? first.files ?? [] : await diffTrees(first.repo!, first.beforeTree!, last.afterTree!);
      return { repo: first.repo!, from: first.beforeTree, to: last.afterTree, files };
    }
    const byPath = new Map<string, FileChange>();
    for (const turn of turns) {
      for (const file of turn.files ?? []) {
        const prev = byPath.get(file.path);
        byPath.set(file.path, { ...file, added: (prev?.added ?? 0) + file.added, removed: (prev?.removed ?? 0) + file.removed });
      }
    }
    return { repo: null, files: [...byPath.values()] };
  }

  /** Patch for a turn or thread; without git, the per-tool diffs recorded during the turns. */
  async patch(threadId: string, turnId?: string, file?: string): Promise<{ patch: string; truncated: boolean }> {
    const info = await this.changes(threadId, turnId);
    if (info.repo && info.from && info.to) {
      return diffPatch(info.repo, info.from, info.to, file ? [file] : []);
    }
    const turnIds = new Set(this.loadTurns(threadId).filter((turn) => !turnId || turn.id === turnId).map((turn) => turn.id));
    const patches = this.loadItems(threadId)
      .filter((item) => item.kind === "tool" && item.turnId && turnIds.has(item.turnId) && item.diff)
      .filter((item) => !file || (item.kind === "tool" && item.files?.some((f) => f.path === file)))
      .map((item) => (item.kind === "tool" ? item.diff ?? "" : ""));
    return { patch: patches.join(""), truncated: false };
  }

  /** Put the turn's page back to its HTML from before the turn. */
  revertPage(threadId: string, turnId: string): { ok: boolean; error?: string } {
    const turn = this.loadTurns(threadId).find((t) => t.id === turnId);
    if (!turn?.page?.after) return { ok: false, error: "This turn did not change a page." };
    const saved = this.db.getSetting<{ html: string; revision: number } | null>(`checkpoint:${turn.id}`, null);
    if (!saved) return { ok: false, error: "The checkpoint for this page is gone." };
    try {
      store.update(turn.page.id, { html: saved.html, viewer: "user" });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    turn.page.reverted = true;
    this.saveTurn(turn);
    this.addItem(threadId, turn.id, { kind: "notice", level: "info", text: `Reverted “${turn.page.title}” to how it was before turn ${turn.seq}.` });
    this.flushNow();
    return { ok: true };
  }

  /**
   * Take the thread back to just before a message of the user's: later turns leave the transcript,
   * their file and page changes are undone (unless keepChanges), and the provider continues from
   * the turn before it. Returns the message, so the chat can edit it or send it again.
   */
  async rewind(threadId: string, itemId: string, opts: { keepChanges?: boolean } = {}): Promise<{ text: string; images: ChatImage[]; files: ChatFile[]; context: ContextChip[] }> {
    const thread = this.requireThread(threadId);
    if (this.runs.has(threadId) || this.queues.get(threadId)?.length) throw new Error("Stop the running turn first.");
    if (this.backgroundTasks(threadId)) throw new Error("Background tasks are still running in this thread. Stop them first.");
    const items = this.loadItems(threadId);
    const user = items.find((it) => it.id === itemId);
    if (!user || user.kind !== "user") throw new Error("Message not found");
    const turns = this.loadTurns(threadId);
    const from = turns.find((t) => t.id === user.turnId);
    if (!from) throw new Error("This message has not run yet.");
    const dropped = turns.filter((t) => t.seq >= from.seq);
    const kept = turns.filter((t) => t.seq < from.seq);

    if (!opts.keepChanges) {
      // Newest first, so each revert applies on top of the state the next one left.
      for (const turn of [...dropped].reverse()) {
        if (turn.reverted || !turn.files?.length || !turn.beforeTree) continue;
        const result = await this.revertTurn(threadId, turn.id);
        if (!result.ok) throw new Error(`Could not undo the file changes of turn ${turn.seq}: ${result.error ?? "unknown error"}. Turns after it were undone; nothing was removed from the chat.`);
      }
      const page = dropped.find((t) => t.page?.after && !t.page.reverted);
      if (page) {
        const result = this.revertPage(threadId, page.id);
        if (!result.ok) throw new Error(`Could not restore the page: ${result.error ?? "unknown error"}`);
      }
    }

    // What the message carried, read back before its files go.
    const savedFiles = (refs: Array<{ id?: string; name: string; mimeType: string }> | undefined): ChatFile[] =>
      (refs ?? []).flatMap((ref) => {
        const full = ref.id ? filePath(threadId, ref.id) : null;
        if (!full) return [];
        try {
          return [{ name: ref.name, mimeType: ref.mimeType, data: fs.readFileSync(full).toString("base64") }];
        } catch {
          return [];
        }
      });
    const message = { text: user.text, images: savedFiles(user.images), files: savedFiles(user.files), context: user.context ?? [] };

    // Where the provider continues from: its transcript at the end of the last kept turn.
    const last = kept.at(-1);
    const forks = this.agent(thread.provider).forks === true;
    const at = forks && last?.nativeEnd ? last.nativeEnd : null;
    const recap = kept.length && !at ? this.recap(items, kept) : "";
    this.sessions.get(threadId)?.dispose();
    this.sessions.delete(threadId);
    forgetGuides(threadId);
    thread.rewind = { at, ...(recap ? { recap } : {}) };
    if (!at) thread.nativeId = null;

    const droppedIds = new Set(dropped.map((t) => t.id));
    const gone = items.filter((it) => it.turnId && droppedIds.has(it.turnId));
    for (const item of gone) {
      if (item.kind === "user") removeFiles(threadId, [...(item.images ?? []), ...(item.files ?? [])].flatMap((f) => (f.id ? [f.id] : [])));
      this.removeItem(item);
    }
    for (const turn of dropped) {
      turns.splice(turns.indexOf(turn), 1);
      this.db.deleteTurn(turn.id);
      this.db.deleteSetting(`checkpoint:${turn.id}`);
      this.emit({ type: "agent_turn_deleted", threadId, id: turn.id });
    }
    thread.activityAt = Date.now();
    this.db.saveThread(thread);
    this.flushNow();
    this.emitThread(threadId);
    return message;
  }

  /** Whether the provider can still resume the thread's session; on doubt, let it try. */
  private async canResume(thread: Thread): Promise<boolean> {
    if (!thread.nativeId) return true;
    try {
      return (await this.agent(thread.provider).resumable?.(thread.nativeId)) ?? true;
    } catch (err) {
      log(`Checking the session of ${thread.id} failed: ${(err as Error).message}`);
      return true;
    }
  }

  /**
   * A session the provider cannot resume (a Cursor thread's old ACP session id, or an agent whose
   * checkpoints were pruned after days idle): the turn starts a new one with a recap of the
   * conversation, like a rewind to the end.
   */
  private startOverWithRecap(thread: Thread, turnId: string): Thread {
    // Stopped and failed turns count too: the user's message in them is still part of the conversation.
    const kept = this.loadTurns(thread.id).filter((t) => t.id !== turnId && t.status !== "running");
    const recap = kept.length ? this.recap(this.loadItems(thread.id), kept) : "";
    const next: Thread = { ...thread, nativeId: null, ...(recap ? { rewind: { at: null, recap, migrated: true } } : {}) };
    this.threads.set(thread.id, next);
    this.db.saveThread(next);
    if (thread.provider === "cursor" && isSdkAgentId(thread.nativeId)) {
      const text = recap
        ? "Cursor could not reopen this thread's agent (its saved context is gone), so this turn starts a new agent with a recap of the conversation."
        : "Cursor could not reopen this thread's agent (its saved context is gone), so this turn starts a new agent.";
      this.addItem(thread.id, turnId, { kind: "notice", level: "info", text });
    }
    return next;
  }

  /** The kept conversation in short, for a provider that starts over after a rewind: each message and the reply to it. */
  private recap(items: Item[], kept: Turn[]): string {
    const parts: string[] = [];
    for (const turn of kept) {
      const ofTurn = items.filter((it) => it.turnId === turn.id && !("parentToolId" in it && it.parentToolId));
      const asked = ofTurn.filter((it) => it.kind === "user").map((it) => (it.kind === "user" ? it.text : "")).join("\n\n");
      const texts = ofTurn.filter((it) => it.kind === "text");
      const reply = texts.at(-1)?.kind === "text" ? (texts.at(-1) as { text: string }).text : "";
      const stopped = turn.status === "cancelled" ? " (stopped before it finished)" : turn.status === "error" ? " (failed before it finished)" : "";
      if (asked) parts.push(`User: ${asked}`);
      if (reply || stopped) parts.push(`You${stopped}: ${reply || "(no reply)"}`);
    }
    const text = parts.join("\n\n");
    // The latest part matters most; keep the prompt a sensible size.
    return text.length > MAX_RECAP ? `…${text.slice(-MAX_RECAP)}` : text;
  }

  // ---------- forks ----------

  /**
   * A new thread that goes on from this one's finished turns, with the same settings and folder (an
   * open worktree is shared). Its first turn continues this thread's provider session when it can,
   * or starts fresh with a summary; the provider can still be changed until then.
   */
  fork(threadId: string, to: { provider?: ProviderId; model?: string; mode?: ThreadMode } = {}): ThreadView {
    const source = this.requireThread(threadId);
    const turns = this.loadTurns(threadId).filter((t) => t.status !== "running");
    if (!turns.length) throw new Error("This thread has no finished turns to fork from.");
    const items = this.loadItems(threadId);
    const last = turns.at(-1)!;
    const wt = openWorktree(source);
    const thread = this.draftThread({
      title: `${source.title} (fork)`,
      provider: source.provider,
      model: source.model,
      effort: source.effort,
      modelParams: source.modelParams,
      mode: source.mode,
      approval: source.approval,
      web: source.web,
      scope: source.scope,
      cwd: source.cwd,
      useWorktree: Boolean(wt),
    });
    if (wt) thread.worktree = { ...wt };
    if (to.provider && to.provider !== source.provider) {
      // The other provider's own last-used settings, as when a new thread switches provider.
      const prefs = this.prefs();
      thread.provider = to.provider;
      thread.model = to.model ?? prefs.models[to.provider] ?? "default";
      thread.effort = prefs.efforts[to.provider] ?? null;
      thread.modelParams = prefs.modelParams[to.provider] ?? {};
      thread.approval = approvalFor(prefs, to.provider);
    } else if (to.model) {
      thread.model = to.model;
    }
    if (to.mode) thread.mode = to.mode;
    // A merged thread's session belongs to its removed worktree folder, not the folder a fork starts in.
    const native = this.agent(source.provider).forks === true && source.nativeId && last.nativeEnd && !source.worktree?.closed;
    thread.fork = {
      from: source.id,
      title: source.title,
      provider: source.provider,
      cwd: source.cwd,
      nativeId: native ? source.nativeId : null,
      at: native ? last.nativeEnd! : null,
      turns: turns.length,
    };
    const firstAsked = this.turnText(items, turns[0], false);
    const lastTurn = turns.length > 1 ? this.turnText(items, last, false) : null;
    const material: ForkMaterial = {
      first: clip(firstAsked.asked, MAX_FORK_MESSAGE),
      middle: turns
        .slice(1, -1)
        .map((turn) => this.turnText(items, turn, true).text)
        .join("\n\n"),
      last: lastTurn ? clip(lastTurn.asked, MAX_FORK_MESSAGE) : "",
      reply: clip((lastTurn ?? firstAsked).reply, MAX_FORK_MESSAGE),
    };
    this.threads.set(thread.id, thread);
    this.items.set(thread.id, []);
    this.turns.set(thread.id, []);
    this.seq.set(thread.id, 0);
    this.db.setSetting(`fork:${thread.id}`, material);
    this.db.saveThread(thread);
    const view = this.view(thread);
    this.emit({ type: "agent_thread", thread: view });
    return view;
  }

  /** One turn as text: what the user asked and the final reply, or (full) every reply, tool and changed file in order. */
  private turnText(items: Item[], turn: Turn, full: boolean): { asked: string; reply: string; text: string } {
    const ofTurn = items.filter((it) => it.turnId === turn.id && !("parentToolId" in it && it.parentToolId));
    const asked = ofTurn.flatMap((it) => (it.kind === "user" ? [it.text] : [])).join("\n\n");
    const texts = ofTurn.flatMap((it) => (it.kind === "text" ? [it.text] : []));
    const reply = texts.at(-1) ?? "";
    if (!full) return { asked, reply, text: "" };
    const lines: string[] = [];
    for (const it of ofTurn) {
      if (it.kind === "user") lines.push(`User: ${it.text}`);
      else if (it.kind === "text") lines.push(`Agent: ${it.text}`);
      else if (it.kind === "tool") lines.push(`[tool: ${it.title}${it.status === "error" ? " (failed)" : ""}]`);
      else if (it.kind === "plan") lines.push(`[plan, ${it.status}]\n${it.text}`);
    }
    const files = turn.reverted ? [] : (turn.files ?? []).map((f) => f.path);
    if (files.length) lines.push(`[files changed: ${files.join(", ")}]`);
    return { asked, reply, text: lines.join("\n") };
  }

  /** Whether a fork's first turn can continue the other thread's own provider session. */
  private forksNatively(thread: Thread, fork: NonNullable<Thread["fork"]>): boolean {
    return Boolean(fork.nativeId && fork.at && thread.provider === fork.provider && this.agent(thread.provider).forks && (thread.cwd ?? null) === (fork.cwd ?? null));
  }

  private forkCarry(thread: Thread, fork: NonNullable<Thread["fork"]>): ThreadView["carry"] {
    if (this.forksNatively(thread, fork)) return { how: "native" };
    return { how: "summary", ...(fork.turns > 2 ? { summarizer: this.summarizerLabel() } : {}) };
  }

  private summarizerLabel(): string {
    const { provider, model } = this.prefs().summarizer;
    const label = this.cachedModels(provider).find((m) => m.id === model)?.label ?? model;
    return `${label} (${this.providers[provider].label})`;
  }

  /**
   * Set up a fork's first turn: point the session at the other thread's session, or build the
   * earlier conversation to send ahead of the message, summarizing its middle turns.
   */
  private async startFork(thread: Thread, fork: NonNullable<Thread["fork"]>, run: RunState): Promise<string> {
    const threadId = thread.id;
    if (this.forksNatively(thread, fork)) {
      this.sessions.get(threadId)?.dispose();
      this.sessions.delete(threadId);
      const next: Thread = { ...thread, nativeId: fork.nativeId, rewind: { at: fork.at } };
      this.threads.set(threadId, next);
      this.db.saveThread(next);
      return "";
    }
    // A fresh session, wherever this thread had one going.
    if (thread.nativeId) {
      this.sessions.get(threadId)?.dispose();
      this.sessions.delete(threadId);
      const next: Thread = { ...thread, nativeId: null };
      this.threads.set(threadId, next);
      this.db.saveThread(next);
    }
    const material = this.db.getSetting<ForkMaterial | null>(`fork:${threadId}`, null);
    if (!material) return "";
    if (material.middle && !material.summary) {
      const { provider, model } = this.prefs().summarizer;
      const label = this.summarizerLabel();
      const notice = this.addItem(threadId, run.turn.id, { kind: "notice", level: "info", text: `Summarizing “${fork.title}” with ${label}…` });
      run.abort = new AbortController();
      try {
        const middle = material.middle.length > MAX_FORK_MIDDLE ? `…${material.middle.slice(-MAX_FORK_MIDDLE)}` : material.middle;
        const summary = (await this.agent(provider).complete(summaryPrompt(middle), model, run.abort.signal)).trim();
        if (!summary) throw new Error("the summary came back empty");
        material.summary = summary;
        this.db.setSetting(`fork:${threadId}`, material);
        if (notice.kind === "notice") notice.text = `Summarized “${fork.title}” with ${label}.`;
      } catch (err) {
        if (run.cancelled) throw err;
        if (notice.kind === "notice") {
          notice.level = "warn";
          notice.text = `Summarizing with ${label} failed (${(err as Error).message}), so the turns in between go along as they were, cut to the latest part.`;
        }
      } finally {
        run.abort = undefined;
        this.touch(notice);
        this.flushNow();
      }
    }
    return forkBlock(fork.title, this.providers[fork.provider].label, material);
  }

  async revertTurn(threadId: string, turnId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.runs.has(threadId)) return { ok: false, error: "Stop the running turn first." };
    const turn = this.loadTurns(threadId).find((t) => t.id === turnId);
    if (!turn) return { ok: false, error: "Turn not found" };
    if (!turn.repo || !turn.beforeTree || !turn.afterTree) return { ok: false, error: "This turn has no git snapshot, so it cannot be reverted automatically." };
    // In a worktree the agent commits as it goes: move the branch back too, but only if nothing was committed after this turn.
    const moveHead = turn.beforeHead && turn.afterHead && turn.beforeHead !== turn.afterHead;
    if (moveHead && (await headCommit(turn.repo)) !== turn.afterHead) {
      return { ok: false, error: "The branch has commits from after this turn. Revert the later turns first." };
    }
    const result = await revertTrees(turn.repo, turn.beforeTree, turn.afterTree);
    if (result.ok && moveHead) {
      const reset = await resetHead(turn.repo, turn.beforeHead!);
      if (!reset.ok) return { ok: false, error: `The files were reverted, but moving the branch back failed: ${reset.error}` };
    }
    if (result.ok) {
      turn.reverted = true;
      this.saveTurn(turn);
      this.addItem(threadId, turn.id, { kind: "notice", level: "info", text: `Reverted the changes from turn ${turn.seq}.` });
      this.flushNow();
      this.emitThread(threadId);
    }
    return result;
  }
}

function readText(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "New thread";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}
