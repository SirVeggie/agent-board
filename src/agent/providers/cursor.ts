import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../../log.js";
import type { ModelOption, ProviderStatus, SlashCommand, Thread, ThreadMode, ToolKind, ToolStatus, Usage } from "../types.js";
import { isPlainRecord } from "../types.js";
import { AcpConnection, RpcError } from "./acp.js";
import { SparePool, type AgentProvider, type ProviderSession, type RunSink, type SessionContext, type SteerInput, type TurnInput, type TurnResult } from "./provider.js";

/**
 * Cursor through its CLI's Agent Client Protocol server (`agent acp`). The SDK has no approval
 * callback; ACP does (session/request_permission), plus Cursor's own question and plan requests.
 *
 * The CLI keeps one current model per process and applies it to every session in that process,
 * so each thread gets its own process.
 *
 * Cursor's interactive CLI can steer a running turn, but ACP does not: there is no inject method,
 * and a second session/prompt cancels the first. Steer here holds the message until the current
 * prompt returns, then the host adopts it as the next turn.
 */

const IDLE_KILL_MS = 15 * 60 * 1000;
/** Name of the board MCP server this daemon hands each Cursor session. */
export const BOARD_MCP = "scribe-chat";
const MODELS_TTL_MS = 30 * 60 * 1000;

type AgentBinary = { node: string; entry: string; version: string };

type ConfigOption = {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string }>;
};

/** Finds the newest installed Cursor agent CLI. CURSOR_AGENT_HOME can point at the install folder. */
export function locateCursorAgent(): AgentBinary | null {
  const roots = [
    process.env.CURSOR_AGENT_HOME,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "cursor-agent") : null,
    path.join(os.homedir(), ".local", "share", "cursor-agent"),
  ].filter(Boolean) as string[];
  for (const root of roots) {
    const versionsDir = path.join(root, "versions");
    if (!fs.existsSync(versionsDir)) continue;
    const versions = fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersion)
      .reverse();
    for (const version of versions) {
      const dir = path.join(versionsDir, version);
      const node = [path.join(dir, "node.exe"), path.join(dir, "node")].find((file) => fs.existsSync(file));
      const entry = path.join(dir, "index.js");
      if (node && fs.existsSync(entry)) {
        return { node, entry, version };
      }
    }
  }
  return null;
}

function compareVersion(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .split("-")[0]
      .split(".")
      .map((part) => Number(part) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return a.localeCompare(b);
}

function spawnAcp(bin: AgentBinary, cwd: string): AcpConnection {
  return new AcpConnection(bin.node, [bin.entry, "acp"], {
    cwd,
    env: {
      ...process.env,
      CURSOR_INVOKED_AS: "agent",
      NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "cursor-compile-cache") : undefined),
    },
  });
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    _meta: { parameterizedModelPicker: true },
  },
  clientInfo: { name: "scribe", version: "1" },
};

function mapModels(raw: unknown): ModelOption[] {
  const models = isPlainRecord(raw) && Array.isArray(raw.models) ? (raw.models as Array<{ value: string; name?: string; configOptions?: ConfigOption[] }>) : [];
  return models.map((model) => {
    const options = Array.isArray(model.configOptions) ? model.configOptions : [];
    const effort = options.find((option) => option.category === "thought_level");
    return {
      id: model.value,
      label: model.name || model.value,
      provider: "cursor",
      efforts: (effort?.options ?? []).map((option) => ({ id: option.value, label: option.name || option.value })),
      defaultEffort: effort?.currentValue ?? null,
      ...(effort ? { effortParam: effort.id } : {}),
      params: options
        .filter((option) => option !== effort)
        .map((option) => ({
          id: option.id,
          label: option.name || option.id,
          description: option.description,
          options: (option.options ?? []).map((choice) => ({ id: choice.value, label: (choice.name || choice.value).replace(/[​-‍]/g, "") })),
          default: option.currentValue ?? option.options?.[0]?.value ?? "",
        })),
    } satisfies ModelOption;
  });
}

export class CursorProvider implements AgentProvider {
  readonly id = "cursor" as const;
  readonly label = "Cursor";
  private modelCache: { at: number; models: ModelOption[] } | null = null;
  private modelLoad: Promise<ModelOption[]> | null = null;
  private sessions = new Set<CursorSession>();
  private spares = new SparePool<CursorSession>();

  async status(): Promise<ProviderStatus> {
    const bin = locateCursorAgent();
    if (!bin) {
      return { id: this.id, label: this.label, available: false, detail: "Cursor agent CLI not found. Install it and run `agent login`." };
    }
    return { id: this.id, label: this.label, available: true, detail: `agent ${bin.version}` };
  }

  models(refresh = false): Promise<ModelOption[]> {
    if (!refresh && this.modelCache) {
      // A stale list is still right for nearly every model; refresh behind the caller.
      if (Date.now() - this.modelCache.at >= MODELS_TTL_MS && !this.modelLoad) void this.models(true);
      return Promise.resolve(this.modelCache.models);
    }
    if (this.modelLoad) {
      return this.modelLoad;
    }
    this.modelLoad = this.loadModels().finally(() => {
      this.modelLoad = null;
    });
    return this.modelLoad;
  }

  cachedModels(): ModelOption[] {
    return this.modelCache?.models ?? [];
  }

  /** Seed from the saved list so the first turn after a restart does not wait for a model list. Marked stale. */
  setModelCache(models: ModelOption[]): void {
    if (models.length && !this.modelCache) this.modelCache = { at: 0, models };
  }

  private async loadModels(): Promise<ModelOption[]> {
    const bin = locateCursorAgent();
    if (!bin) {
      return [];
    }
    const conn = spawnAcp(bin, os.tmpdir());
    try {
      await conn.request("initialize", INIT_PARAMS, 30_000);
      const raw = await conn.request("cursor/list_available_models", {}, 60_000);
      const models = mapModels(raw);
      if (models.length) {
        this.modelCache = { at: Date.now(), models };
      }
      return models;
    } catch (err) {
      log(`Cursor model list failed: ${(err as Error).message}`);
      return this.modelCache?.models ?? [];
    } finally {
      conn.kill();
    }
  }

  createSession(thread: Thread, ctx: SessionContext): ProviderSession {
    const spare = thread.nativeId ? null : this.spares.take(spareKey(thread, ctx));
    if (spare) {
      spare.update(thread);
      return spare;
    }
    const session = new CursorSession(this, thread, ctx, () => this.sessions.delete(session));
    this.sessions.add(session);
    return session;
  }

  spareThreadId(thread: Thread, ctx: SessionContext): string | null {
    return this.spares.get(spareKey(thread, ctx))?.scribeThreadId() ?? null;
  }

  prewarm(draft: Thread, instructions: string, ctx: SessionContext): void {
    const key = spareKey(draft, ctx);
    let spare = this.spares.get(key);
    if (spare) {
      spare.update(draft);
    } else {
      const session = new CursorSession(this, draft, ctx, () => this.sessions.delete(session));
      this.sessions.add(session);
      this.spares.put(key, session);
      spare = session;
    }
    void spare.warm(instructions);
  }

  dispose(): void {
    this.spares.dispose();
    for (const session of this.sessions) {
      session.dispose();
    }
  }
}

/** A Cursor session is bound to its working directory; everything else can be set on it later. */
function spareKey(thread: Thread, ctx: SessionContext): string {
  return thread.mode === "board" || !thread.cwd ? `board:${ctx.scratchDir}` : `cwd:${path.normalize(thread.cwd).toLowerCase()}`;
}

function cursorMode(mode: ThreadMode): string {
  switch (mode) {
    case "code":
    case "board":
      return "agent";
    case "plan":
      return "plan";
    case "ask":
      return "ask";
    default: {
      const never: never = mode;
      return never;
    }
  }
}

function mapToolKind(kind: unknown, title: string): ToolKind {
  switch (kind) {
    case "read":
    case "edit":
    case "delete":
    case "move":
    case "search":
    case "execute":
    case "think":
    case "fetch":
      return kind;
    default:
      if (/^mcp\b|mcp[:_]/i.test(title)) return "mcp";
      return "other";
  }
}

function mapStatus(status: unknown): ToolStatus | undefined {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "error";
    default:
      return undefined;
  }
}

/** Cursor reports new files as oldText "-- /dev/null" and newText "++ b/<path>\n<content>". */
function normalizeDiff(entry: { path?: string; oldText?: string | null; newText?: string | null }): { path: string; oldText: string | null; newText: string | null } | null {
  if (!entry.path) return null;
  let oldText = entry.oldText ?? null;
  let newText = entry.newText ?? null;
  if (oldText !== null && /^-- (\/dev\/null|a\/)/.test(oldText)) {
    oldText = oldText.startsWith("-- /dev/null") ? null : oldText.replace(/^-- a\/[^\n]*\n?/, "");
  }
  if (newText !== null && /^\+\+ (\/dev\/null|b\/)/.test(newText)) {
    newText = newText.startsWith("++ /dev/null") ? null : newText.replace(/^\+\+ b\/[^\n]*\n?/, "");
  }
  return { path: entry.path, oldText, newText };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isPlainRecord(block)) continue;
    if (block.type === "content" && isPlainRecord(block.content) && typeof block.content.text === "string") {
      parts.push(block.content.text);
    } else if (block.type === "terminal") {
      parts.push("[terminal]");
    }
  }
  return parts.join("\n");
}

function outputText(raw: unknown): { output?: string; exitCode?: number } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") return { output: raw };
  if (isPlainRecord(raw)) {
    const stdout = typeof raw.stdout === "string" ? raw.stdout : "";
    const stderr = typeof raw.stderr === "string" ? raw.stderr : "";
    const exitCode = typeof raw.exitCode === "number" ? raw.exitCode : undefined;
    if (stdout || stderr || exitCode !== undefined) {
      return { output: [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : ""), exitCode };
    }
    if (typeof raw.content === "string") return { output: raw.content };
  }
  try {
    return { output: JSON.stringify(raw, null, 2) };
  } catch {
    return {};
  }
}

function asNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function pathsFrom(update: Record<string, unknown>): string[] | undefined {
  const paths = new Set<string>();
  if (Array.isArray(update.locations)) {
    for (const loc of update.locations) {
      if (isPlainRecord(loc) && typeof loc.path === "string") paths.add(loc.path);
    }
  }
  if (isPlainRecord(update.rawInput)) {
    for (const key of ["path", "file_path", "filePath", "target_file"]) {
      const value = update.rawInput[key];
      if (typeof value === "string") paths.add(value);
    }
  }
  return paths.size ? [...paths] : undefined;
}

class CursorSession implements ProviderSession {
  private conn: AcpConnection | null = null;
  private starting: Promise<AcpConnection> | null = null;
  private sessionId: string | null;
  private applied: Record<string, string> = {};
  private sink: RunSink | null = null;
  private loading = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private knownCommands: SlashCommand[] = [];
  private startedTools = new Set<string>();
  private sentInstructions = false;
  private warming: Promise<void> | null = null;
  private steers = new Map<string, "pending" | "dropped">();
  /** Steered message the last prompt did not take in; the host adopts it as the next turn. */
  private carry: string | null = null;
  /** Latest context usage, including updates that arrive with no turn running. */
  private lastUsage: Usage | null = null;

  constructor(
    private provider: CursorProvider,
    private thread: Thread,
    private ctx: SessionContext,
    private onDispose: () => void
  ) {
    this.sessionId = thread.nativeId;
  }

  scribeThreadId(): string {
    return this.thread.id;
  }

  update(thread: Thread): void {
    const idChanged = thread.id !== this.thread.id;
    const cwdChanged = (thread.cwd ?? null) !== (this.thread.cwd ?? null) || (thread.mode === "board") !== (this.thread.mode === "board");
    this.thread = thread;
    if ((cwdChanged || idChanged) && !this.sink) {
      // The session is tied to its cwd; a new cwd needs a fresh process and session load.
      // MCP is started with SCRIBE_THREAD from this.thread.id, so a new id needs a new process too.
      this.stopProcess();
    }
  }

  async commands(): Promise<SlashCommand[]> {
    return this.knownCommands;
  }

  private cwd(): string {
    if (this.thread.mode === "board" || !this.thread.cwd) {
      return this.ctx.scratchDir;
    }
    return this.thread.cwd;
  }

  private mcpServers(): unknown[] {
    const { command, args } = this.ctx.boardMcp;
    // The thread id lets Scribe tie claims on cards to this thread and release them if it stops.
    const env = { ...this.ctx.boardMcp.env, SCRIBE_THREAD: this.thread.id };
    // Not "scribe": a session server with the same name as one in ~/.cursor/mcp.json gets its calls rejected.
    return [{ name: BOARD_MCP, command, args, env: Object.entries(env).map(([name, value]) => ({ name, value })) }];
  }

  private async ensureConnection(): Promise<AcpConnection> {
    if (this.conn?.alive) {
      return this.conn;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<AcpConnection> {
    const bin = locateCursorAgent();
    if (!bin) {
      throw new Error("Cursor agent CLI not found. Install it and run `agent login`.");
    }
    const cwd = this.cwd();
    const conn = spawnAcp(bin, cwd);
    conn.onNotification = (method, params) => this.onNotification(method, params);
    conn.onRequest = (method, params) => this.onRequest(method, params);
    conn.onExit = () => {
      if (this.conn === conn) {
        this.conn = null;
        this.applied = {};
      }
    };
    await conn.request("initialize", INIT_PARAMS, 60_000);
    let result: unknown = null;
    if (this.sessionId) {
      this.loading = true;
      try {
        result = await conn.request("session/load", { sessionId: this.sessionId, cwd, mcpServers: this.mcpServers() }, 120_000);
      } catch (err) {
        log(`Cursor session/load failed, starting a new session: ${(err as Error).message}`);
        this.sessionId = null;
      } finally {
        this.loading = false;
      }
    }
    if (!this.sessionId) {
      result = await conn.request("session/new", { cwd, mcpServers: this.mcpServers() }, 120_000);
      const id = isPlainRecord(result) && typeof result.sessionId === "string" ? result.sessionId : null;
      if (!id) {
        conn.kill();
        throw new Error("Cursor did not return a session id");
      }
      this.sessionId = id;
      this.sentInstructions = false;
    } else {
      this.sentInstructions = true;
    }
    this.syncOptions(result);
    this.conn = conn;
    return conn;
  }

  private syncOptions(result: unknown): void {
    if (!isPlainRecord(result) || !Array.isArray(result.configOptions)) return;
    for (const option of result.configOptions as ConfigOption[]) {
      if (option.id && typeof option.currentValue === "string") {
        this.applied[option.id] = option.currentValue;
      }
    }
  }

  private async setOption(conn: AcpConnection, configId: string, value: string): Promise<boolean> {
    if (this.applied[configId] === value) return true;
    try {
      const result = await conn.request("session/set_config_option", { sessionId: this.sessionId, configId, value }, 30_000);
      this.syncOptions(result);
      this.applied[configId] = value;
      return true;
    } catch (err) {
      this.sink?.notice("warn", `Cursor rejected ${configId} = ${value}: ${(err as Error).message}`);
      return false;
    }
  }

  async warm(_instructions: string): Promise<void> {
    if (this.sink) return;
    this.warming ??= (async () => {
      const conn = await this.ensureConnection();
      await this.applyThread(conn);
    })()
      .catch((err) => log(`Cursor warm-up failed: ${(err as Error).message}`))
      .finally(() => {
        this.warming = null;
      });
    this.armIdle();
    return this.warming;
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopProcess(), IDLE_KILL_MS);
  }

  private async applyThread(conn: AcpConnection): Promise<void> {
    await this.setOption(conn, "mode", cursorMode(this.thread.mode));
    const models = this.provider.cachedModels().length ? this.provider.cachedModels() : await this.provider.models();
    const model = models.find((item) => item.id === this.thread.model);
    if (this.applied.model !== this.thread.model) {
      await this.setOption(conn, "model", this.thread.model);
    }
    if (model) {
      const wanted: Record<string, string> = {};
      for (const param of model.params) {
        const value = this.thread.modelParams[param.id];
        if (value !== undefined) wanted[param.id] = value;
      }
      if (model.effortParam && this.thread.effort) {
        wanted[model.effortParam] = this.thread.effort;
      }
      for (const [id, value] of Object.entries(wanted)) {
        await this.setOption(conn, id, value);
      }
    }
  }

  /**
   * Hold a message until the current session/prompt returns. A second prompt on this connection
   * cancels the turn instead of injecting at a tool boundary.
   */
  steer(_input: SteerInput): string {
    const id = randomUUID();
    this.steers.set(id, "pending");
    return id;
  }

  dropSteer(steerId: string): void {
    if (this.steers.get(steerId) !== "pending") return;
    this.steers.set(steerId, "dropped");
  }

  async withdrawSteer(steerId: string): Promise<boolean> {
    if (this.steers.get(steerId) !== "pending") return false;
    this.steers.delete(steerId);
    return true;
  }

  async run(input: TurnInput, sink: RunSink, opts?: { adopt?: string }): Promise<TurnResult> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.sink = sink;
    this.abort = new AbortController();
    this.startedTools.clear();
    if (this.lastUsage) sink.usage(this.lastUsage);
    try {
      // A warm-up still in flight already holds the process start; join it instead of racing it.
      if (this.warming) await this.warming;
      const conn = await this.ensureConnection();
      if (this.sessionId) sink.nativeId(this.sessionId);
      await this.applyThread(conn);
      if (opts?.adopt) {
        if (this.carry !== opts.adopt) return { status: "error", error: "The steered message was lost." };
        this.carry = null;
      }
      const prompt: unknown[] = [];
      const text = !this.sentInstructions && input.instructions ? `<instructions>\n${input.instructions}\n</instructions>\n\n${input.text}` : input.text;
      prompt.push({ type: "text", text });
      for (const image of input.images) {
        prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
      }
      const result = await conn.request<{ stopReason?: string }>("session/prompt", { sessionId: this.sessionId, prompt });
      this.sentInstructions = true;
      const stop = result?.stopReason;
      if (stop === "cancelled") return this.endTurn({ status: "cancelled" });
      if (stop === "refusal") return this.endTurn({ status: "error", error: "The model refused to continue." });
      if (stop === "max_tokens" || stop === "max_turn_requests") {
        sink.notice("warn", stop === "max_tokens" ? "Stopped: output token limit reached." : "Stopped: turn request limit reached.");
      }
      return this.endTurn({ status: "done" });
    } catch (err) {
      if (this.abort?.signal.aborted) {
        return this.endTurn({ status: "cancelled" });
      }
      return this.endTurn({ status: "error", error: (err as Error).message });
    } finally {
      this.abort?.abort();
      this.abort = null;
      this.sink = null;
      this.armIdle();
    }
  }

  /** A pending steer the turn did not take in runs as its own turn next; the host adopts it. */
  private endTurn(result: TurnResult): TurnResult {
    const waiting = [...this.steers].find(([, state]) => state === "pending")?.[0];
    if (waiting) {
      this.steers.delete(waiting);
      this.carry = waiting;
      return { ...result, next: waiting };
    }
    return result;
  }

  async cancel(): Promise<void> {
    this.abort?.abort();
    if (this.conn?.alive && this.sessionId) {
      this.conn.notify("session/cancel", { sessionId: this.sessionId });
    }
  }

  private stopProcess(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.conn?.kill();
    this.conn = null;
    this.applied = {};
  }

  dispose(): void {
    void this.cancel();
    this.steers.clear();
    this.carry = null;
    this.stopProcess();
    this.onDispose();
  }

  private onNotification(method: string, params: unknown): void {
    if (!isPlainRecord(params)) return;
    if (method === "session/update") {
      const update = params.update;
      if (!isPlainRecord(update)) return;
      // usage_update is session-level: keep it even while loading or between turns.
      if (this.loading && update.sessionUpdate !== "usage_update") return;
      this.onUpdate(update);
      return;
    }
    const sink = this.sink;
    if (!sink) return;
    if (method === "cursor/update_todos") {
      const todos = Array.isArray(params.todos) ? params.todos : [];
      sink.todos(
        todos.filter(isPlainRecord).map((todo) => ({
          content: String(todo.content ?? ""),
          status: todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in_progress" : "pending",
        }))
      );
      return;
    }
    if (method === "cursor/task") {
      const description = typeof params.description === "string" ? params.description : typeof params.title === "string" ? params.title : "";
      if (description) sink.notice("info", `Subagent: ${description}`);
    }
  }

  private onUpdate(update: Record<string, unknown>): void {
    const kind = update.sessionUpdate;
    if (kind === "available_commands_update") {
      const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      this.knownCommands = commands.filter(isPlainRecord).map((cmd) => ({
        name: String(cmd.name ?? ""),
        description: typeof cmd.description === "string" ? cmd.description : undefined,
        hint: isPlainRecord(cmd.input) && typeof cmd.input.hint === "string" ? cmd.input.hint : undefined,
      }));
      this.sink?.commands(this.knownCommands);
      return;
    }
    if (kind === "usage_update") {
      this.takeUsage(update);
      return;
    }
    const sink = this.sink;
    if (!sink) return;
    switch (kind) {
      case "agent_message_chunk": {
        const content = update.content;
        if (isPlainRecord(content) && content.type === "text" && typeof content.text === "string") sink.text(content.text);
        return;
      }
      case "agent_thought_chunk": {
        const content = update.content;
        if (isPlainRecord(content) && content.type === "text" && typeof content.text === "string") sink.reasoning(content.text);
        return;
      }
      case "tool_call":
      case "tool_call_update":
        this.onTool(update, sink);
        return;
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        sink.todos(
          entries.filter(isPlainRecord).map((entry) => ({
            content: String(entry.content ?? ""),
            status: entry.status === "completed" ? "completed" : entry.status === "in_progress" ? "in_progress" : "pending",
          }))
        );
        return;
      }
      case "session_info_update":
        if (typeof update.title === "string" && update.title.trim()) sink.title(update.title.trim());
        return;
      case "current_mode_update": {
        const mode = update.currentModeId;
        if (this.thread.mode !== "board" && sink.modeChanged && (mode === "agent" || mode === "plan" || mode === "ask")) {
          this.applied.mode = String(mode);
          const mapped: ThreadMode = mode === "agent" ? "code" : mode;
          if (mapped !== this.thread.mode) sink.modeChanged(mapped);
        }
        return;
      }
      default:
        return;
    }
  }

  private takeUsage(update: Record<string, unknown>): void {
    const used = asNum(update.used);
    const size = asNum(update.size);
    if (used === undefined && size === undefined) return;
    this.lastUsage = {
      ...(this.lastUsage ?? {}),
      ...(used !== undefined ? { contextTokens: used } : {}),
      ...(size !== undefined ? { contextWindow: size } : {}),
    };
    this.sink?.usage(this.lastUsage);
  }

  private onTool(update: Record<string, unknown>, sink: RunSink): void {
    const toolId = String(update.toolCallId ?? "");
    if (!toolId) return;
    // The plan card shows Cursor's plan; its tool row would repeat it.
    if (typeof update.title === "string" && update.title.startsWith("Create Plan")) return;
    const rawTitle = typeof update.title === "string" ? this.shortenPaths(update.title) : undefined;
    const title = rawTitle?.startsWith(`${BOARD_MCP}: `) ? `Scribe: ${rawTitle.slice(BOARD_MCP.length + 2)}` : rawTitle;
    const status = mapStatus(update.status);
    const paths = pathsFrom(update);
    const rawInput = update.rawInput;
    const detail = isPlainRecord(rawInput) && typeof rawInput.command === "string" ? rawInput.command : undefined;
    if (!this.startedTools.has(toolId)) {
      this.startedTools.add(toolId);
      const name = title ?? String(update.kind ?? "tool");
      sink.toolStart({
        toolId,
        name,
        tool: mapToolKind(update.kind, name),
        title: name,
        detail,
        input: rawInput && isPlainRecord(rawInput) && Object.keys(rawInput).length ? rawInput : undefined,
        paths,
        status: status ?? "pending",
      });
      if (update.sessionUpdate === "tool_call" && !update.content && update.rawOutput === undefined) return;
    }
    const diffs: Array<{ path: string; oldText: string | null; newText: string | null }> = [];
    if (Array.isArray(update.content)) {
      for (const block of update.content) {
        if (isPlainRecord(block) && block.type === "diff") {
          const normalized = normalizeDiff(block as { path?: string; oldText?: string; newText?: string });
          if (normalized) diffs.push(normalized);
        }
      }
    }
    const text = contentText(update.content);
    const out = outputText(update.rawOutput);
    sink.toolUpdate(toolId, {
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
      ...(rawInput && isPlainRecord(rawInput) && Object.keys(rawInput).length ? { input: rawInput } : {}),
      ...(status ? { status } : {}),
      ...(paths ? { paths } : {}),
      ...(out.output !== undefined ? { output: out.output } : text ? { output: text } : {}),
      ...(out.exitCode !== undefined ? { exitCode: out.exitCode } : {}),
      ...(diffs.length ? { providerDiff: diffs } : {}),
    });
  }

  /** Tool titles carry absolute paths; show them relative to the workspace. */
  private shortenPaths(text: string): string {
    const root = this.cwd().replaceAll("\\", "/").replace(/\/$/, "");
    if (!root) return text;
    let out = text;
    for (const prefix of [root + "/", root.replaceAll("/", "\\") + "\\"]) {
      let at = out.toLowerCase().indexOf(prefix.toLowerCase());
      while (at >= 0) {
        out = out.slice(0, at) + out.slice(at + prefix.length);
        at = out.toLowerCase().indexOf(prefix.toLowerCase());
      }
    }
    return out;
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    const sink = this.sink;
    const signal = this.abort?.signal;
    if (!isPlainRecord(params)) throw new Error("bad params");
    if (method === "session/request_permission") {
      if (!sink) return { outcome: { outcome: "cancelled" } };
      const toolCall = isPlainRecord(params.toolCall) ? params.toolCall : {};
      const toolId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined;
      const options = (Array.isArray(params.options) ? params.options : []).filter(isPlainRecord).map((option) => ({
        id: String(option.optionId),
        label: String(option.name ?? option.optionId),
        kind: (["allow_once", "allow_always", "reject_once", "reject_always"].includes(String(option.kind)) ? option.kind : "allow_once") as
          | "allow_once"
          | "allow_always"
          | "reject_once"
          | "reject_always",
      }));
      let title = typeof toolCall.title === "string" ? toolCall.title : "Tool call";
      // MCP permission titles look like "<server>-<tool>: <tool>".
      // The server name may contain dashes, so strip the known "-<tool>" suffix instead of splitting.
      const titleMatch = /^([\w.-]+): ([\w.-]+)$/.exec(title);
      const mcp = titleMatch && titleMatch[1].endsWith(`-${titleMatch[2]}`) ? [title, titleMatch[1].slice(0, -titleMatch[2].length - 1), titleMatch[2]] : null;
      const isBoard = Boolean(mcp && mcp[1] === BOARD_MCP);
      if (mcp) title = isBoard ? `Scribe: ${mcp[2]}` : `${mcp[1]}: ${mcp[2]}`;
      const rawInput = isPlainRecord(toolCall.rawInput) ? toolCall.rawInput : null;
      const reason = contentText(toolCall.content);
      try {
        const decision = await sink.approval(
          {
            toolId,
            tool: mcp ? "mcp" : mapToolKind(toolCall.kind, title),
            boardTool: isBoard,
            title,
            detail: [rawInput && typeof rawInput.command === "string" ? rawInput.command : "", reason].filter(Boolean).join("\n"),
            options,
          },
          signal
        );
        return { outcome: { outcome: "selected", optionId: decision.optionId } };
      } catch {
        return { outcome: { outcome: "cancelled" } };
      }
    }
    if (method === "cursor/ask_question") {
      if (!sink) return { outcome: { outcome: "cancelled" } };
      const questions = (Array.isArray(params.questions) ? params.questions : []).filter(isPlainRecord).map((q) => ({
        id: String(q.id),
        prompt: String(q.prompt ?? ""),
        multi: q.allowMultiple === true,
        options: (Array.isArray(q.options) ? q.options : []).filter(isPlainRecord).map((o) => ({ id: String(o.id), label: String(o.label ?? o.id) })),
      }));
      try {
        const answer = await sink.question({ title: typeof params.title === "string" ? params.title : undefined, questions }, signal);
        if ("skipped" in answer) {
          return { outcome: { outcome: "skipped", reason: answer.reason ?? "User skipped the questions" } };
        }
        return {
          outcome: {
            outcome: "answered",
            answers: Object.entries(answer.answers).map(([questionId, selectedOptionIds]) => ({ questionId, selectedOptionIds })),
          },
        };
      } catch {
        return { outcome: { outcome: "cancelled" } };
      }
    }
    if (method === "cursor/create_plan") {
      if (!sink) return { outcome: { outcome: "cancelled" } };
      const overview = typeof params.overview === "string" ? params.overview : "";
      const plan = typeof params.plan === "string" ? params.plan : "";
      const todos = (Array.isArray(params.todos) ? params.todos : []).filter(isPlainRecord).map((todo) => `- [ ] ${String(todo.content ?? "")}`);
      const text = [overview, plan, todos.length ? `\n**Todos**\n${todos.join("\n")}` : ""].filter(Boolean).join("\n\n");
      try {
        const decision = await sink.plan({ title: typeof params.name === "string" ? params.name : "Plan", text }, signal);
        if (decision.accepted) {
          return { outcome: { outcome: "accepted" } };
        }
        return { outcome: { outcome: "rejected", reason: decision.note || "The user wants changes to the plan." } };
      } catch {
        return { outcome: { outcome: "cancelled" } };
      }
    }
    throw new RpcError(`Method not supported: ${method}`, -32601);
  }
}
