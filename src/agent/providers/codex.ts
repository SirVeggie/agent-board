import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type {
  Codex as CodexClient,
  CodexOptions,
  Input,
  McpToolCallItem,
  ModelReasoningEffort,
  SandboxMode,
  Thread as CodexThread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  Usage as CodexUsage,
} from "@openai/codex-sdk";
import { dataDir } from "../../config.js";
import { log } from "../../log.js";
import type { ChatImage, ModelOption, ProviderStatus, SlashCommand, Thread, ToolKind, Usage } from "../types.js";
import { isPlainRecord, noPages } from "../types.js";
import { SparePool, type AgentProvider, type ProviderSession, type RunSink, type SessionContext, type TurnInput, type TurnResult } from "./provider.js";

/**
 * Codex through @openai/codex-sdk, which spawns `codex exec` for each turn. Sessions resume by
 * thread id under Scribe's own CODEX_HOME (data/agent/codex), using the user's ChatGPT login by
 * copying ~/.codex/auth.json (Agent settings Log in runs the bundled `codex login`). The SDK has
 * no approval callback or steer, so Ask / Auto-edit / Auto review all run with approval_policy=never
 * and a sandbox from the thread's mode; Full access is danger-full-access. The board's tools reach
 * the agent as a Codex MCP server named `scribe`.
 */

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_URL_WAIT_MS = 15_000;

const IDLE_CLOSE_MS = 15 * 60 * 1000;
const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  persistent: "Persistent",
};
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"].map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));

type Sdk = typeof import("@openai/codex-sdk");
let sdkLoad: Promise<Sdk> | null = null;
/** The SDK pulls a large native binary; load it on first use instead of with the daemon. */
function sdk(): Promise<Sdk> {
  sdkLoad ??= import("@openai/codex-sdk");
  sdkLoad.catch(() => {
    sdkLoad = null;
  });
  return sdkLoad;
}

export function scribeCodexHome(): string {
  return path.join(dataDir(), "agent", "codex");
}

function userAuthFile(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

/** Copy the user's Codex login into Scribe's CODEX_HOME so ChatGPT auth works without mixing sessions. */
export function syncCodexAuth(): void {
  const home = scribeCodexHome();
  fs.mkdirSync(home, { recursive: true });
  const src = userAuthFile();
  const dst = path.join(home, "auth.json");
  if (fs.existsSync(src)) fs.copyFileSync(src, dst);
}

export function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.CODEX_HOME = scribeCodexHome();
  return env;
}

/** Login writes ~/.codex/auth.json; sessions still use Scribe's CODEX_HOME. */
export function loginEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key !== "CODEX_HOME") out[key] = value;
  }
  return out;
}

/** HTTPS login page from `codex login` stdout; skip localhost (the OAuth callback). */
export function loginUrlFromOutput(text: string): string | null {
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const matches = plain.match(/https:\/\/[^\s<>"'\\]+/g) ?? [];
  let fallback: string | null = null;
  for (const raw of matches) {
    const href = raw.replace(/[.,);]+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") continue;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") continue;
    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "auth.openai.com" || host.endsWith(".openai.com")) {
      return parsed.href;
    }
    fallback ??= parsed.href;
  }
  return fallback;
}

function codexCliJs(): string {
  return createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
}

function stopChild(child: ChildProcess): void {
  if (!child.pid || child.exitCode != null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

function hasApiKey(): string | null {
  if (process.env.CODEX_API_KEY?.trim()) return "CODEX_API_KEY";
  if (process.env.OPENAI_API_KEY?.trim()) return "OPENAI_API_KEY";
  return null;
}

function hasAuthFile(): boolean {
  return fs.existsSync(path.join(scribeCodexHome(), "auth.json")) || fs.existsSync(userAuthFile());
}

export const FALLBACK_MODELS: ModelOption[] = [
  { id: "default", label: "Default", provider: "codex", description: "Codex CLI default", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5.2", label: "GPT-5.2", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5-codex", label: "GPT-5 Codex", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5.1-codex", label: "GPT-5.1 Codex", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5.1", label: "GPT-5.1", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "gpt-5", label: "GPT-5", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
  { id: "o3", label: "o3", provider: "codex", efforts: EFFORTS, defaultEffort: null, params: [] },
];

/** Ask / Plan / Pages stay read-only; Full access drops the sandbox; otherwise workspace-write. */
export function sandboxFor(thread: Pick<Thread, "mode" | "approval">): SandboxMode {
  if (thread.mode === "ask" || thread.mode === "plan" || thread.mode === "board") return "read-only";
  if (thread.approval === "full") return "danger-full-access";
  return "workspace-write";
}

export function threadOptions(thread: Pick<Thread, "model" | "effort" | "mode" | "approval" | "web">, cwd: string): ThreadOptions {
  const effort = thread.effort && thread.effort in EFFORT_LABELS ? (thread.effort as ModelReasoningEffort) : undefined;
  return {
    ...(thread.model && thread.model !== "default" ? { model: thread.model } : {}),
    sandboxMode: sandboxFor(thread),
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    ...(effort ? { modelReasoningEffort: effort } : {}),
    approvalPolicy: "never",
    webSearchEnabled: thread.web === "on",
    networkAccessEnabled: thread.web === "on" && thread.mode === "code",
  };
}

/** The board MCP server, registered as Codex MCP server `scribe`. */
export function mcpConfig(ctx: Pick<SessionContext, "boardMcp">, threadId: string, pages: boolean): NonNullable<CodexOptions["config"]> {
  return {
    mcp_servers: {
      scribe: {
        command: ctx.boardMcp.command,
        args: ctx.boardMcp.args,
        env: {
          ...ctx.boardMcp.env,
          SCRIBE_THREAD: threadId,
          ...(pages ? {} : { SCRIBE_PAGES: "off" }),
        },
      },
    },
  };
}

export function mapUsage(usage: CodexUsage): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cached_input_tokens,
    cacheWriteTokens: usage.cache_write_input_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
  };
}

export class CodexProvider implements AgentProvider {
  readonly id = "codex" as const;
  readonly label = "Codex";
  private modelCache: { at: number; models: ModelOption[] } | null = null;
  private sessions = new Set<CodexSession>();
  private spares = new SparePool<CodexSession>();
  private login: { url: string | null; done: Promise<void> } | null = null;

  async status(): Promise<ProviderStatus> {
    try {
      await sdk();
    } catch (err) {
      return { id: this.id, label: this.label, available: false, detail: `Codex SDK failed to load: ${(err as Error).message}` };
    }
    const key = hasApiKey();
    if (key) return { id: this.id, label: this.label, available: true, detail: key };
    if (hasAuthFile()) return { id: this.id, label: this.label, available: true, detail: "codex login" };
    return {
      id: this.id,
      label: this.label,
      available: false,
      detail: this.login ? "Finish the login in your browser" : "Not logged in",
      login: true,
    };
  }

  /**
   * Start ChatGPT login via the bundled `codex login`. The CLI opens a browser and prints a URL;
   * Scribe's settings also open that URL. Auth lands in ~/.codex/auth.json, then is copied into
   * Scribe's CODEX_HOME. Resolves with the URL as soon as there is one; the wait goes on in the
   * background.
   */
  async startLogin(): Promise<{ url: string | null }> {
    if (!this.login) {
      let gotUrl: (url: string) => void = () => {};
      const urlReady = new Promise<string>((resolve) => (gotUrl = resolve));
      const entry: { url: string | null; done: Promise<void> } = { url: null, done: Promise.resolve() };
      let output = "";
      const child = spawn(process.execPath, [codexCliJs(), "login"], {
        env: loginEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const take = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > 32_000) output = output.slice(-16_000);
        if (entry.url) return;
        const url = loginUrlFromOutput(output);
        if (url) {
          entry.url = url;
          gotUrl(url);
        }
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
      const timeout = setTimeout(() => stopChild(child), LOGIN_TIMEOUT_MS);
      timeout.unref?.();
      entry.done = new Promise<void>((resolve) => {
        child.once("error", (err) => {
          clearTimeout(timeout);
          log(`Codex login failed: ${err.message}`);
          resolve();
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            syncCodexAuth();
            log("Codex login done");
          } else {
            const tail = output.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(" ");
            log(`Codex login failed (exit ${code ?? "null"})${tail ? `: ${tail}` : ""}`);
          }
          resolve();
        });
      }).finally(() => {
        if (this.login === entry) this.login = null;
      });
      this.login = entry;
      await Promise.race([urlReady, entry.done, new Promise((resolve) => setTimeout(resolve, LOGIN_URL_WAIT_MS))]);
    }
    return { url: this.login?.url ?? null };
  }

  models(_refresh = false): Promise<ModelOption[]> {
    const models = this.modelCache?.models?.length ? this.modelCache.models : FALLBACK_MODELS;
    this.modelCache = { at: Date.now(), models };
    return Promise.resolve(models);
  }

  cachedModels(): ModelOption[] {
    return this.modelCache?.models ?? FALLBACK_MODELS;
  }

  setModelCache(models: ModelOption[]): void {
    if (models.length) this.modelCache = { at: Date.now(), models };
  }

  async complete(prompt: string, model: string, signal?: AbortSignal): Promise<string> {
    syncCodexAuth();
    const { Codex } = await sdk();
    const client = new Codex({ env: cliEnv(), ...(apiKeyOption()) });
    const handle = client.startThread({
      ...(model && model !== "default" ? { model } : {}),
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      webSearchEnabled: false,
      workingDirectory: os.tmpdir(),
    });
    const turn = await handle.run(prompt, { signal });
    return turn.finalResponse;
  }

  createSession(thread: Thread, ctx: SessionContext): ProviderSession {
    const spare = thread.nativeId ? null : this.spares.take(spareKey(thread, ctx), thread.id);
    if (spare) {
      spare.update(thread);
      return spare;
    }
    return this.newSession(thread, ctx);
  }

  private newSession(thread: Thread, ctx: SessionContext): CodexSession {
    const session = new CodexSession(thread, ctx, () => this.sessions.delete(session));
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
      spare = this.newSession(draft, ctx);
      this.spares.put(key, spare);
    }
    void spare.warm(instructions);
  }

  dispose(): void {
    this.spares.dispose();
    for (const session of [...this.sessions]) session.dispose();
  }
}

function apiKeyOption(): Pick<CodexOptions, "apiKey"> {
  const key = process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  return key ? { apiKey: key } : {};
}

function spareKey(thread: Thread, ctx: SessionContext): string {
  const where = thread.mode === "board" || !thread.cwd ? `board:${ctx.scratchDir}` : `cwd:${path.normalize(thread.cwd).toLowerCase()}`;
  return JSON.stringify([where, thread.mode, thread.web, thread.approval, noPages(thread.scope)]);
}

function toolKind(item: ThreadItem): ToolKind {
  switch (item.type) {
    case "command_execution":
      return "execute";
    case "file_change":
      return "edit";
    case "mcp_tool_call":
      return "mcp";
    case "web_search":
      return "fetch";
    case "todo_list":
      return "todo";
    default:
      return "other";
  }
}

function mcpText(item: McpToolCallItem): string {
  if (item.error?.message) return item.error.message;
  const content = item.result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isPlainRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function writeImages(images: ChatImage[]): { paths: string[]; cleanup: () => void } {
  if (!images.length) return { paths: [], cleanup: () => undefined };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-codex-"));
  const paths = images.map((image, i) => {
    const mime = image.mimeType.toLowerCase();
    const ext = mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : mime.includes("gif") ? ".gif" : ".jpg";
    const file = path.join(dir, `img-${i}${ext}`);
    fs.writeFileSync(file, Buffer.from(image.data, "base64"));
    return file;
  });
  return {
    paths,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

class CodexSession implements ProviderSession {
  private client: CodexClient | null = null;
  private handle: CodexThread | null = null;
  private sessionKey: string | null = null;
  private nativeId: string | null;
  private reported: string | null = null;
  private sink: RunSink | null = null;
  private running = false;
  private cancelled = false;
  private abort: AbortController | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private instructions = "";
  /** How much of each streaming item we already sent, so updates become deltas. */
  private streamed = new Map<string, number>();
  private tools = new Set<string>();
  private plan: string | null = null;

  constructor(
    private thread: Thread,
    private ctx: SessionContext,
    private onDispose: () => void
  ) {
    this.nativeId = thread.nativeId;
  }

  scribeThreadId(): string {
    return this.thread.id;
  }

  update(thread: Thread): void {
    const was = this.thread;
    this.thread = thread;
    if (this.reported && thread.nativeId !== this.reported && !this.running) {
      this.reported = null;
      this.nativeId = thread.nativeId;
      this.handle = null;
      this.sessionKey = null;
    }
    if (this.sessionKey !== null && this.sessionKey !== this.key() && !this.running) {
      this.handle = null;
      this.sessionKey = null;
    }
    if (was.id !== thread.id) {
      this.handle = null;
      this.sessionKey = null;
    }
  }

  async commands(): Promise<SlashCommand[]> {
    return [];
  }

  private cwd(): string {
    if (this.thread.mode === "board" || !this.thread.cwd) return this.ctx.scratchDir;
    return this.thread.cwd;
  }

  private key(): string {
    const t = this.thread;
    return JSON.stringify([t.id, t.mode, t.web, t.approval, this.cwd(), noPages(t.scope), this.instructions]);
  }

  private async ensureHandle(): Promise<CodexThread> {
    const key = this.key();
    if (this.handle && this.sessionKey === key) return this.handle;
    syncCodexAuth();
    const { Codex } = await sdk();
    this.client = new Codex({
      env: cliEnv(),
      config: mcpConfig(this.ctx, this.thread.id, !noPages(this.thread.scope)),
      ...apiKeyOption(),
    });
    const options = threadOptions(this.thread, this.cwd());
    if (this.nativeId) {
      this.handle = this.client.resumeThread(this.nativeId, options);
    } else {
      this.handle = this.client.startThread(options);
    }
    this.sessionKey = key;
    return this.handle;
  }

  async warm(instructions: string): Promise<void> {
    if (this.sink) return;
    this.instructions = instructions;
    try {
      syncCodexAuth();
      await sdk();
    } catch (err) {
      log(`Codex warm-up failed: ${(err as Error).message}`);
    }
    this.armIdle();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  async run(input: TurnInput, sink: RunSink, opts?: { adopt?: string }): Promise<TurnResult> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (opts?.adopt) {
      // Codex exec cannot steer; a leftover adopt is a host bug.
      return { status: "error", error: "Codex cannot take a steered message into a running turn." };
    }
    this.sink = sink;
    this.cancelled = false;
    this.streamed.clear();
    this.tools.clear();
    this.plan = null;
    this.instructions = input.instructions;
    const images = writeImages(input.images);
    this.abort = new AbortController();
    const payload = this.turnInput(input.text, images.paths);
    try {
      try {
        return await this.streamTurn(payload, sink);
      } catch (err) {
        if (this.cancelled || (err as Error)?.name === "AbortError") return { status: "cancelled" };
        const message = (err as Error).message || String(err);
        if (!this.nativeId || !/resume|not found|unknown thread/i.test(message)) {
          return { status: "error", error: message };
        }
        log(`Codex resume failed, starting a new thread: ${message}`);
        sink.notice("warn", "Could not resume the Codex thread; this turn starts a new one without the earlier conversation.");
        this.nativeId = null;
        this.handle = null;
        this.sessionKey = null;
        this.reported = null;
        return await this.streamTurn(payload, sink);
      }
    } catch (err) {
      if (this.cancelled || (err as Error)?.name === "AbortError") return { status: "cancelled" };
      return { status: "error", error: (err as Error).message || String(err) };
    } finally {
      this.running = false;
      this.abort = null;
      this.sink = null;
      images.cleanup();
      this.armIdle();
    }
  }

  private turnInput(text: string, imagePaths: string[]): Input {
    const prompt = this.instructions ? `<instructions>\n${this.instructions}\n</instructions>\n\n${text}` : text;
    if (!imagePaths.length) return prompt;
    return [{ type: "text", text: prompt }, ...imagePaths.map((file) => ({ type: "local_image" as const, path: file }))];
  }

  private async streamTurn(payload: Input, sink: RunSink): Promise<TurnResult> {
    const handle = await this.ensureHandle();
    if (this.nativeId) {
      sink.nativeId(this.nativeId);
      this.reported = this.nativeId;
    }
    if (this.cancelled) return { status: "cancelled" };
    this.running = true;
    const { events } = await handle.runStreamed(payload, { signal: this.abort?.signal });
    let failed: string | null = null;
    for await (const event of events) {
      if (this.cancelled) break;
      this.onEvent(event, sink);
      if (event.type === "turn.failed") failed = event.error.message;
    }
    if (this.cancelled) return { status: "cancelled" };
    if (failed) return { status: "error", error: failed };
    if (this.plan && this.thread.mode === "plan") {
      await sink.plan({ title: "Plan", text: this.plan }).catch(() => undefined);
    }
    return { status: "done" };
  }

  private onEvent(event: ThreadEvent, sink: RunSink): void {
    switch (event.type) {
      case "thread.started":
        this.nativeId = event.thread_id;
        this.reported = event.thread_id;
        sink.nativeId(event.thread_id);
        return;
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.onItem(event.item, event.type === "item.completed", sink);
        return;
      case "turn.completed":
        sink.usage(mapUsage(event.usage));
        return;
      case "error":
        sink.notice("error", event.message);
        return;
      default:
        return;
    }
  }

  private stream(id: string, text: string, kind: "text" | "reasoning", sink: RunSink): void {
    const prev = this.streamed.get(id) ?? 0;
    const next = text.slice(prev);
    if (!next) {
      this.streamed.set(id, text.length);
      return;
    }
    if (kind === "text") sink.text(next);
    else sink.reasoning(next);
    this.streamed.set(id, text.length);
  }

  private onItem(item: ThreadItem, finished: boolean, sink: RunSink): void {
    switch (item.type) {
      case "agent_message":
        if (!this.streamed.has(item.id)) sink.breakBlock();
        this.stream(item.id, item.text, "text", sink);
        if (finished && this.thread.mode === "plan" && item.text.trim()) this.plan = item.text;
        return;
      case "reasoning":
        if (!this.streamed.has(item.id)) sink.breakBlock();
        this.stream(item.id, item.text, "reasoning", sink);
        if (finished) sink.breakBlock();
        return;
      case "todo_list":
        sink.todos(item.items.map((todo) => ({ content: todo.text, status: todo.completed ? "completed" : "pending" })));
        return;
      case "error":
        sink.notice("error", item.message);
        return;
      case "command_execution":
      case "file_change":
      case "mcp_tool_call":
      case "web_search":
        this.onTool(item, finished, sink);
        return;
      default:
        return;
    }
  }

  private onTool(item: Extract<ThreadItem, { type: "command_execution" | "file_change" | "mcp_tool_call" | "web_search" }>, finished: boolean, sink: RunSink): void {
    const title = this.toolTitle(item);
    const detail = item.type === "command_execution" ? item.command : item.type === "web_search" ? item.query : undefined;
    const paths = item.type === "file_change" ? item.changes.map((change) => change.path) : undefined;
    const input = item.type === "mcp_tool_call" ? item.arguments : undefined;
    if (!this.tools.has(item.id)) {
      this.tools.add(item.id);
      sink.breakBlock();
      sink.toolStart({
        toolId: item.id,
        name: item.type,
        tool: toolKind(item),
        title,
        ...(detail ? { detail } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(paths?.length ? { paths } : {}),
        status: "running",
      });
    } else if (!finished) {
      const output = item.type === "command_execution" ? item.aggregated_output : undefined;
      sink.toolUpdate(item.id, {
        title,
        ...(detail ? { detail } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(paths?.length ? { paths } : {}),
        ...(output ? { output } : {}),
      });
    }
    if (!finished) return;
    const failed =
      (item.type === "command_execution" && item.status === "failed") ||
      (item.type === "file_change" && item.status === "failed") ||
      (item.type === "mcp_tool_call" && item.status === "failed");
    const output =
      item.type === "command_execution"
        ? item.aggregated_output
        : item.type === "mcp_tool_call"
          ? mcpText(item)
          : undefined;
    const quiet = item.type === "file_change" && !failed;
    sink.toolUpdate(item.id, {
      title,
      ...(paths?.length ? { paths } : {}),
      status: failed ? "error" : "done",
      ...(!quiet && output ? { output } : {}),
      ...(item.type === "command_execution" && item.exit_code !== undefined ? { exitCode: item.exit_code } : {}),
    });
  }

  private toolTitle(item: ThreadItem): string {
    switch (item.type) {
      case "command_execution":
        return "Shell";
      case "file_change":
        return item.changes.length === 1 ? `Edit ${item.changes[0]?.path ?? "file"}` : `Edit ${item.changes.length} files`;
      case "mcp_tool_call":
        return item.server === "scribe" ? `Scribe: ${item.tool}` : `${item.server}: ${item.tool}`;
      case "web_search":
        return `Search ${item.query}`.trim();
      default:
        return item.type;
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.abort?.abort();
  }

  private stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.running) return;
    this.handle = null;
    this.client = null;
    this.sessionKey = null;
  }

  dispose(): void {
    void this.cancel();
    this.running = false;
    this.stop();
    this.onDispose();
  }
}
