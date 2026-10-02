import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, dataDir } from "../config.js";
import { log } from "../log.js";
import { store } from "../store.js";
import { AgentDb } from "./db.js";
import { diffPatch, diffTrees, fileAtTree, findRepo, repoRelative, revertTrees, snapshotTree } from "./git.js";
import { contextBlock, threadInstructions, type ScopeInfo } from "./prompt.js";
import { ClaudeProvider } from "./providers/claude.js";
import { CursorProvider } from "./providers/cursor.js";
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
import type {
  AgentEvent,
  ApprovalPolicy,
  ChatImage,
  ContextChip,
  FileChange,
  Item,
  ItemBody,
  ModelOption,
  ProviderId,
  ProviderStatus,
  RunStatus,
  SlashCommand,
  Thread,
  ThreadMode,
  ThreadScope,
  ThreadView,
  Turn,
  Usage,
} from "./types.js";

const FLUSH_MS = 700;
const DELTA_MS = 50;
const MAX_TOOL_OUTPUT = 20_000;
const MAX_TOOL_DIFF = 200_000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export type Prefs = {
  provider: ProviderId;
  models: Partial<Record<ProviderId, string>>;
  efforts: Partial<Record<ProviderId, string | null>>;
  modelParams: Partial<Record<ProviderId, Record<string, string>>>;
  mode: ThreadMode;
  approval: ApprovalPolicy;
  web: boolean;
  recentWorkspaces: string[];
  /** Last workspace used for a scope ("page:<id>", "folder:<id>"), so new threads there start in it. */
  scopeWorkspaces: Record<string, string>;
  /** Starred models as "provider:modelId", in the order they were starred. Ctrl+' cycles them. */
  favoriteModels: string[];
};

const DEFAULT_PREFS: Prefs = {
  provider: "cursor",
  models: { cursor: "composer-2.5", claude: "default" },
  efforts: {},
  modelParams: { cursor: { fast: "false" } },
  mode: "code",
  approval: "ask",
  web: true,
  recentWorkspaces: [],
  scopeWorkspaces: {},
  favoriteModels: [],
};

type Pending =
  | { kind: "approval"; threadId: string; itemId: string; resolve: (d: ApprovalDecision) => void; reject: (err: Error) => void }
  | { kind: "question"; threadId: string; itemId: string; resolve: (a: QuestionAnswer) => void; reject: (err: Error) => void }
  | { kind: "plan"; threadId: string; itemId: string; resolve: (d: PlanDecision) => void; reject: (err: Error) => void };

type QueuedMessage = { text: string; images: ChatImage[]; context: ContextChip[]; from?: "page" };

/** What the model reads for a message: where it came from, its context chips, then the text. */
function promptText(msg: QueuedMessage): string {
  const origin = msg.from === "page" ? "<context>\nSent by the code of the board page this thread belongs to (board.agent, after a click or key press on it), not typed by the user.\n</context>\n\n" : "";
  return origin + contextBlock(msg.context) + msg.text;
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
};

export type SendInput = { text: string; images?: ChatImage[]; context?: ContextChip[]; from?: "page" };

export class AgentHost {
  readonly db: AgentDb;
  private providers: Record<ProviderId, AgentProvider>;
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
  private commandCache = new Map<string, SlashCommand[]>();
  private deltaBuf = new Map<string, { threadId: string; text: string }>();
  private deltaTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private ctx: SessionContext;

  constructor(private emit: (event: AgentEvent) => void) {
    this.db = new AgentDb();
    this.providers = { claude: new ClaudeProvider(), cursor: new CursorProvider() };
    const claudeModels = this.db.getSetting<ModelOption[]>("models.claude", []);
    (this.providers.claude as ClaudeProvider).setModelCache(claudeModels);
    (this.providers.cursor as CursorProvider).setModelCache(this.db.getSetting<ModelOption[]>("models.cursor", []));
    for (const thread of this.db.listThreads()) {
      this.threads.set(thread.id, thread);
      // A turn cannot survive a daemon restart: mark leftovers as cancelled.
      const turns = this.db.listTurns(thread.id);
      for (const turn of turns) {
        if (turn.status === "running") {
          turn.status = "cancelled";
          turn.endedAt = turn.endedAt ?? Date.now();
          this.db.saveTurn(turn);
        }
      }
    }
    const scratchDir = path.join(dataDir(), "agent", "scratch");
    fs.mkdirSync(scratchDir, { recursive: true });
    const entry = fileURLToPath(new URL("../index.js", import.meta.url));
    const env: Record<string, string> = { AGENT_BOARD_PORT: String(PORT) };
    if (process.env.AGENT_BOARD_HOME) env.AGENT_BOARD_HOME = process.env.AGENT_BOARD_HOME;
    this.ctx = { boardMcp: { command: process.execPath, args: [entry], env }, scratchDir };
  }

  dispose(): void {
    this.flushNow();
    for (const session of this.sessions.values()) session.dispose();
    for (const provider of Object.values(this.providers)) provider.dispose();
    this.db.close();
  }

  // ---------- prefs, providers, models ----------

  prefs(): Prefs {
    const saved = this.db.getSetting<Partial<Prefs>>("prefs", {});
    return { ...DEFAULT_PREFS, ...saved, models: { ...DEFAULT_PREFS.models, ...saved.models }, modelParams: { ...DEFAULT_PREFS.modelParams, ...saved.modelParams } };
  }

  setPrefs(patch: Partial<Prefs>): Prefs {
    const next = { ...this.prefs(), ...patch };
    this.db.setSetting("prefs", next);
    return next;
  }

  async providerStatus(): Promise<ProviderStatus[]> {
    return Promise.all(Object.values(this.providers).map((provider) => provider.status()));
  }

  async models(provider: ProviderId, refresh = false): Promise<ModelOption[]> {
    const models = await this.providers[provider].models(refresh);
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
    if (thread.mode !== "board" && thread.mode !== "ask" && !thread.cwd) return;
    const session = this.session(thread);
    session.update(thread);
    await session.warm(threadInstructions(thread, this.scopeInfo(thread)));
  }

  /** Warm a spare session for a thread the user is about to start with these settings. */
  warmDraft(input: Partial<Thread> & { scope?: ThreadScope }): void {
    const draft = this.draftThread(input);
    if (draft.mode !== "board" && draft.mode !== "ask" && !draft.cwd) return;
    this.providers[draft.provider].prewarm(draft, threadInstructions(draft, this.scopeInfo(draft)), this.ctx);
  }

  createThread(input: Partial<Thread> & { scope?: ThreadScope }): ThreadView {
    const thread = this.draftThread(input);
    this.threads.set(thread.id, thread);
    this.items.set(thread.id, []);
    this.turns.set(thread.id, []);
    this.seq.set(thread.id, 0);
    this.db.saveThread(thread);
    const view = this.view(thread);
    this.emit({ type: "agent_thread", thread: view });
    return view;
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
          : prefs.scopeWorkspaces[scopeKey] ?? prefs.recentWorkspaces[0] ?? null;
    const now = Date.now();
    const thread: Thread = {
      id: `th_${crypto.randomBytes(6).toString("hex")}`,
      title: input.title?.trim() || "New thread",
      titleLocked: Boolean(input.title?.trim()),
      provider,
      model: input.model ?? prefs.models[provider] ?? "default",
      effort: input.effort !== undefined ? input.effort : prefs.efforts[provider] ?? null,
      modelParams: input.modelParams ?? prefs.modelParams[provider] ?? {},
      mode: input.mode ?? (scope.kind === "page" || scope.kind === "folder" ? "board" : prefs.mode),
      approval: input.approval ?? prefs.approval,
      web: input.web ?? prefs.web,
      scope,
      cwd: cwd ?? null,
      nativeId: null,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      activityAt: now,
    };
    return thread;
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
      next.effort = prefs.efforts[patch.provider] ?? null;
      next.modelParams = prefs.modelParams[patch.provider] ?? {};
      next.nativeId = null;
      this.sessions.get(id)?.dispose();
      this.sessions.delete(id);
    }
    if (typeof patch.model === "string") next.model = patch.model;
    if (patch.effort !== undefined) next.effort = patch.effort;
    if (patch.modelParams && typeof patch.modelParams === "object") next.modelParams = { ...next.modelParams, ...patch.modelParams };
    if (patch.mode) next.mode = patch.mode;
    if (patch.approval) next.approval = patch.approval;
    if (typeof patch.web === "boolean") next.web = patch.web;
    if (patch.cwd !== undefined) {
      const cwd = patch.cwd ? path.normalize(patch.cwd) : null;
      if (cwd !== thread.cwd && this.runs.has(id)) throw new Error("Stop the running turn before changing the workspace.");
      next.cwd = cwd;
    }
    if (patch.scope) next.scope = patch.scope;
    if (typeof patch.pinned === "boolean") next.pinned = patch.pinned;
    if (typeof patch.archived === "boolean") next.archived = patch.archived;
    next.updatedAt = Date.now();
    this.threads.set(id, next);
    this.db.saveThread(next);
    this.sessions.get(id)?.update(next);
    this.rememberChoices(next, patch);
    const view = this.view(next);
    this.emit({ type: "agent_thread", thread: view });
    return view;
  }

  /** Model, effort, mode, and workspace picks become the defaults for new threads. */
  private rememberChoices(thread: Thread, patch: Partial<Thread>): void {
    const prefs = this.prefs();
    const next: Partial<Prefs> = {};
    if (patch.model || patch.provider) {
      next.provider = thread.provider;
      next.models = { ...prefs.models, [thread.provider]: thread.model };
    }
    if (patch.effort !== undefined) next.efforts = { ...prefs.efforts, [thread.provider]: thread.effort };
    if (patch.modelParams) next.modelParams = { ...prefs.modelParams, [thread.provider]: thread.modelParams };
    if (patch.mode && thread.scope.kind !== "page" && thread.scope.kind !== "folder") next.mode = thread.mode;
    if (patch.approval) next.approval = thread.approval;
    if (typeof patch.web === "boolean") next.web = thread.web;
    if (patch.cwd && thread.cwd) {
      next.recentWorkspaces = [thread.cwd, ...prefs.recentWorkspaces.filter((dir) => path.normalize(dir) !== path.normalize(thread.cwd!))].slice(0, 12);
      if (thread.scope.kind !== "global") {
        next.scopeWorkspaces = { ...prefs.scopeWorkspaces, [`${thread.scope.kind}:${thread.scope.ref}`]: thread.cwd };
      }
    }
    if (Object.keys(next).length) this.setPrefs(next);
  }

  async deleteThread(id: string): Promise<void> {
    this.requireThread(id);
    await this.cancel(id);
    this.sessions.get(id)?.dispose();
    this.sessions.delete(id);
    this.threads.delete(id);
    this.items.delete(id);
    this.turns.delete(id);
    this.queues.delete(id);
    this.unread.delete(id);
    for (const [key, item] of this.dirty) {
      if (item.threadId === id) this.dirty.delete(key);
    }
    this.db.deleteThread(id);
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
    for (const turn of turns) {
      if (turn.reverted) continue;
      for (const file of turn.files ?? []) {
        files.add(file.path);
        added += file.added;
        removed += file.removed;
      }
    }
    return {
      ...thread,
      status: this.status.get(thread.id) ?? "idle",
      unread: this.unread.has(thread.id),
      queued: this.queues.get(thread.id)?.length ?? 0,
      stats: { turns: turns.length, files: files.size, added, removed },
    };
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
      const tab = store.get(thread.scope.ref, "agent");
      return tab ? { page: { id: tab.id, key: tab.key, title: tab.title, folder: store.folderPath(tab.folderId) } } : { page: null };
    }
    if (thread.scope.kind === "folder" && thread.scope.ref) {
      const folderPath = store.folderPath(thread.scope.ref);
      return folderPath ? { folder: { id: thread.scope.ref, path: folderPath } } : { folder: null };
    }
    return {};
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
  }

  private appendText(item: Item & { text: string }, delta: string): void {
    item.text += delta;
    this.dirty.set(item.id, item);
    const buf = this.deltaBuf.get(item.id);
    if (buf) buf.text += delta;
    else this.deltaBuf.set(item.id, { threadId: item.threadId, text: delta });
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

  send(threadId: string, input: SendInput): { queued: boolean; item: Item } {
    const thread = this.requireThread(threadId);
    const text = input.text.trim();
    if (!text && !input.images?.length) throw new Error("Empty message");
    const msg: QueuedMessage = { text, images: input.images ?? [], context: input.context ?? [], ...(input.from === "page" ? { from: "page" as const } : {}) };
    if (thread.mode !== "board" && thread.mode !== "ask" && !thread.cwd) {
      // Code and plan work on files; without a workspace the agent would work in a scratch folder.
      throw new Error("Pick a workspace folder for this thread first, or switch it to Board mode.");
    }
    if (this.runs.has(threadId)) {
      const queue = this.queues.get(threadId) ?? [];
      queue.push(msg);
      this.queues.set(threadId, queue);
      const item = this.addItem(threadId, null, {
        kind: "user",
        text,
        ...(msg.images.length ? { images: msg.images.map((img) => ({ name: img.name, mimeType: img.mimeType })) } : {}),
        ...(msg.context.length ? { context: msg.context } : {}),
        ...(msg.from ? { from: msg.from } : {}),
      });
      this.emitThread(threadId);
      return { queued: true, item };
    }
    const item = this.addItem(threadId, null, {
      kind: "user",
      text,
      ...(msg.images.length ? { images: msg.images.map((img) => ({ name: img.name, mimeType: img.mimeType })) } : {}),
      ...(msg.context.length ? { context: msg.context } : {}),
      ...(msg.from ? { from: msg.from } : {}),
    });
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
  async steer(threadId: string): Promise<{ steered: boolean }> {
    const run = this.runs.get(threadId);
    const queue = this.queues.get(threadId);
    const session = this.sessions.get(threadId);
    if (!run) throw new Error("No turn is running");
    if (run.steer || !session?.steer) {
      await this.sendNow(threadId);
      return { steered: false };
    }
    if (!queue?.length) throw new Error("Nothing is queued");
    const msg = queue.shift()!;
    if (!queue.length) this.queues.delete(threadId);
    const item = this.queuedItems(threadId)[0];
    const id = session.steer({ text: promptText(msg), images: msg.images });
    run.steer = { id, msg, itemId: item?.id };
    if (item && item.kind === "user") {
      item.steer = "waiting";
      this.touch(item);
    }
    this.emitThread(threadId);
    return { steered: true };
  }

  /**
   * Take the latest queued message back, or the waiting steered one when nothing else is queued, and
   * remove it from the transcript so it can be edited and sent again.
   */
  async withdraw(threadId: string): Promise<{ text: string; images: ChatImage[]; context: ContextChip[] }> {
    const queue = this.queues.get(threadId);
    const queued = this.queuedItems(threadId);
    if (queue?.length) {
      const msg = queue.pop()!;
      if (!queue.length) this.queues.delete(threadId);
      const item = queued[queued.length - 1];
      if (item) this.removeItem(item);
      this.emitThread(threadId);
      return { text: msg.text, images: msg.images, context: msg.context };
    }
    const run = this.runs.get(threadId);
    const steer = run?.steer;
    if (!run || !steer) throw new Error("Nothing is queued");
    const session = this.sessions.get(threadId);
    if (!(await session?.withdrawSteer?.(steer.id)) || run.steer !== steer) throw new Error("The agent has already read that message");
    run.steer = null;
    const item = steer.itemId ? this.loadItems(threadId).find((it) => it.id === steer.itemId) : undefined;
    if (item) this.removeItem(item);
    this.emitThread(threadId);
    return { text: steer.msg.text, images: steer.msg.images, context: steer.msg.context };
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
  async sendNow(threadId: string): Promise<void> {
    const run = this.runs.get(threadId);
    if (!run || (!run.steer && !this.queues.get(threadId)?.length)) return;
    await this.cancel(threadId, { keepQueue: true });
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
          this.touch(item);
        }
      }
      this.emitThread(threadId);
    }
    if (!run) return;
    run.cancelled = true;
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
      session = this.providers[thread.provider].createSession(thread, this.ctx);
      this.sessions.set(thread.id, session);
    }
    return session;
  }

  private async runTurn(threadId: string, msg: QueuedMessage, userItem: Item, opts?: { adopt?: string }): Promise<void> {
    const thread = this.requireThread(threadId);
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
    userItem.turnId = turn.id;
    if (userItem.kind === "user") delete userItem.steer;
    this.touch(userItem);
    const run: RunState = { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null };
    this.runs.set(threadId, run);
    this.status.set(threadId, "running");
    thread.activityAt = Date.now();
    if (!thread.titleLocked && thread.title === "New thread") {
      thread.title = titleFrom(msg.text);
    }
    this.db.saveThread(thread);
    this.saveTurn(turn);
    this.emitThread(threadId);

    // Checkpoint the page this turn is about, so an agent edit to it can be reverted.
    const pageId = thread.scope.kind === "page" && thread.scope.ref ? thread.scope.ref : msg.context.find((c) => c.kind === "page")?.id;
    const pageTab = pageId ? store.get(pageId, "agent") : undefined;
    if (pageTab && !pageTab.templateId) {
      turn.page = { id: pageTab.id, title: pageTab.title, before: pageTab.revision };
      this.db.setSetting(`checkpoint:${turn.id}`, { html: pageTab.html, revision: pageTab.revision });
    }

    if (thread.mode !== "board" && thread.cwd) {
      run.repo = await findRepo(thread.cwd);
      if (run.repo) {
        turn.repo = run.repo;
        turn.beforeTree = (await snapshotTree(run.repo)) ?? undefined;
      }
    }

    const sink = this.makeSink(threadId, run);
    let result: TurnResult = { status: "cancelled" };
    // Stop can arrive while the snapshot above runs, before the provider has anything to cancel.
    if (!run.cancelled) {
      try {
        const session = this.session(thread);
        session.update(thread);
        result = await session.run(
          {
            text: promptText(msg),
            images: msg.images,
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
    turn.status = result.status;
    turn.endedAt = Date.now();
    turn.usage = run.usage;
    if (result.error) turn.error = result.error;
    this.saveTurn(turn);
    this.flushNow();
    this.runs.delete(threadId);
    this.status.set(threadId, "idle");
    const latest = this.threads.get(threadId);
    if (latest) {
      latest.activityAt = Date.now();
      this.db.saveThread(latest);
      this.unread.add(threadId);
    }
    this.emitThread(threadId);

    if (carried && latest) {
      const item = carried.itemId ? this.loadItems(threadId).find((it) => it.id === carried.itemId) : undefined;
      void this.runTurn(threadId, carried.msg, item ?? this.addItem(threadId, null, { kind: "user", text: carried.msg.text }), { adopt: carried.id });
      return;
    }
    const queue = this.queues.get(threadId);
    const next = queue?.shift();
    if (queue && !queue.length) this.queues.delete(threadId);
    if (next && latest) {
      const pendingUser = this.queuedItems(threadId)[0];
      void this.runTurn(threadId, next, pendingUser ?? this.addItem(threadId, null, { kind: "user", text: next.text }));
    }
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

  private makeSink(threadId: string, run: RunState): RunSink {
    const turnId = run.turn.id;
    const host = this;
    const thread = () => host.threads.get(threadId);
    const waitFor = <T>(kind: Pending["kind"], itemId: string, signal?: AbortSignal): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const requestId = itemId;
        host.pending.set(requestId, { kind, threadId, itemId, resolve: resolve as never, reject } as Pending);
        host.setStatus(threadId, "waiting");
        signal?.addEventListener("abort", () => {
          const pending = host.pending.get(requestId);
          if (pending) {
            host.pending.delete(requestId);
            host.expireInteraction(pending);
            reject(new Error("aborted"));
          }
        });
      }).finally(() => {
        if (host.runs.get(threadId) === run && ![...host.pending.values()].some((p) => p.threadId === threadId)) {
          host.setStatus(threadId, "running");
        }
      });

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
        if (parentToolId) {
          const tool = run.tools.get(parentToolId);
          if (tool && tool.kind === "tool") {
            tool.output = ((tool.output ?? "") + delta).slice(-MAX_TOOL_OUTPUT);
            host.touch(tool);
          }
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
      reasoning(delta) {
        if (!delta) return;
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
      toolStart(tool: ToolStart) {
        if (run.tools.has(tool.toolId)) return;
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
        const t = thread();
        const allow = req.options.find((o) => o.kind === "allow_once") ?? req.options.find((o) => o.kind === "allow_always");
        const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind === "reject_always");
        if (req.boardTool && allow) {
          return Promise.resolve({ optionId: allow.id });
        }
        if (t?.mode === "board" && req.tool !== "mcp" && req.tool !== "fetch" && req.tool !== "todo") {
          // Board mode never runs file or shell tools, whatever the approval setting.
          if (reject) return Promise.resolve({ optionId: reject.id, note: "Board mode has no file or shell access." });
          return Promise.reject(new Error("Board mode has no file or shell access."));
        }
        if (t?.approval === "full" && allow) {
          return Promise.resolve({ optionId: allow.id });
        }
        if (t?.approval === "edits" && allow && (req.tool === "edit" || req.tool === "delete" || req.tool === "move")) {
          return Promise.resolve({ optionId: allow.id });
        }
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
    if (decision.accepted && planThread?.provider === "cursor" && planThread.mode === "plan") {
      // Cursor ends the turn after an accepted plan; continue in Code mode with a follow-up turn.
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

  // ---------- changes ----------

  /** Files changed by one turn, or by the whole thread when turnId is omitted. */
  async changes(threadId: string, turnId?: string): Promise<{ repo: string | null; from?: string; to?: string; files: FileChange[] }> {
    const turns = this.loadTurns(threadId).filter((turn) => !turnId || turn.id === turnId);
    if (!turns.length) return { repo: null, files: [] };
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

  async revertTurn(threadId: string, turnId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.runs.has(threadId)) return { ok: false, error: "Stop the running turn first." };
    const turn = this.loadTurns(threadId).find((t) => t.id === turnId);
    if (!turn) return { ok: false, error: "Turn not found" };
    if (!turn.repo || !turn.beforeTree || !turn.afterTree) return { ok: false, error: "This turn has no git snapshot, so it cannot be reverted automatically." };
    const result = await revertTrees(turn.repo, turn.beforeTree, turn.afterTree);
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
