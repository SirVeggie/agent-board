import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CodexOptions,
  McpToolCallItem,
  ModelReasoningEffort,
  SandboxMode,
  ThreadItem,
  Usage as CodexUsage,
} from "@openai/codex-sdk";
import { dataDir } from "../../config.js";
import { log } from "../../log.js";
import type { ChatImage, ModelOption, ProviderStatus, SlashCommand, Thread, ToolKind, Usage } from "../types.js";
import { isPlainRecord, noPages } from "../types.js";
import { SparePool, type AgentProvider, type ProviderSession, type RunSink, type SessionContext, type SteerInput, type TurnInput, type TurnResult } from "./provider.js";
import { CodexRpc, type RpcMessage, type RpcRecord } from "./codexRpc.js";

/**
 * Codex interactive sessions use app-server; the SDK spawns `codex exec` for summaries. Sessions resume by
 * thread id under Scribe's own CODEX_HOME (data/agent/codex), using the user's ChatGPT login by
 * copying ~/.codex/auth.json (Agent settings Log in runs the bundled `codex login`). The model
 * picker is the live ChatGPT catalog from `codex app-server` `model/list` (same list as Codex web
 * work mode), with FALLBACK_MODELS only when that call fails. Interactive sessions use a persistent
 * app-server connection for approvals and steering; SDK exec is retained for tool-free summaries.
 * The board's tools reach the agent as a Codex MCP server named `scribe`.
 */

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_URL_WAIT_MS = 15_000;
const MODELS_TTL_MS = 30 * 60 * 1000;
const APP_SERVER_TIMEOUT_MS = 20_000;

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

type AppServerCall = (method: string, params?: unknown) => Promise<unknown>;

/** One `codex app-server --stdio` process for a handful of JSON-RPC calls, then killed. */
function withAppServer<T>(env: Record<string, string>, run: (call: AppServerCall) => Promise<T>, timeoutMs = APP_SERVER_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [codexCliJs(), "app-server", "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buf = "";
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
    let settled = false;

    const finish = (err?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stopChild(child);
      for (const wait of pending.values()) wait.reject(err ?? new Error("Codex app-server closed"));
      pending.clear();
      if (err) reject(err);
      else resolve(value as T);
    };

    const timeout = setTimeout(() => finish(new Error("Codex model list timed out")), timeoutMs);
    timeout.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(buf[nl] === "\r" ? nl + 2 : nl + 1);
        if (!line.startsWith("{")) continue;
        let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id == null) continue;
        const wait = pending.get(Number(msg.id));
        if (!wait) continue;
        pending.delete(Number(msg.id));
        if (msg.error) wait.reject(new Error(msg.error.message || "Codex RPC error"));
        else wait.resolve(msg.result);
      }
    });
    child.once("error", (err) => finish(err));
    child.once("exit", () => {
      if (!settled) finish(new Error("Codex app-server exited"));
    });

    const call: AppServerCall = async (method, params) => {
      const result = await new Promise((res, rej) => {
        if (settled) {
          rej(new Error("Codex app-server closed"));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`);
      });
      if (method === "initialize") child.stdin?.write(`${JSON.stringify({ method: "initialized" })}\n`);
      return result;
    };

    run(call)
      .then((value) => finish(undefined, value))
      .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
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

function effortChoices(ids: string[]): Array<{ id: string; label: string }> {
  return ids.map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));
}

/** ChatGPT catalog rows from `model/list` → picker options. Hidden and unavailable models are dropped. */
export function mapCodexModels(rows: unknown[]): ModelOption[] {
  type Row = {
    id?: unknown;
    model?: unknown;
    displayName?: unknown;
    description?: unknown;
    hidden?: unknown;
    isDefault?: unknown;
    isCurrentlyUnavailable?: unknown;
    supportedReasoningEfforts?: unknown;
    defaultReasoningEffort?: unknown;
  };
  const parsed: Row[] = [];
  for (const row of rows) {
    if (isPlainRecord(row)) parsed.push(row);
  }
  parsed.sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    if (row.hidden || row.isCurrentlyUnavailable) continue;
    const id = String(row.model || row.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawEfforts = Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const option: ModelOption = {
      id,
      label: String(row.displayName || id).trim(),
      provider: "codex",
      efforts: rawEfforts.length ? effortChoices(rawEfforts) : EFFORTS,
      defaultEffort: typeof row.defaultReasoningEffort === "string" ? row.defaultReasoningEffort : null,
      params: [],
    };
    if (typeof row.description === "string" && row.description.trim()) option.description = row.description.trim();
    out.push(option);
  }
  return out;
}

/** Live ChatGPT catalog via experimental `codex app-server` JSON-RPC. Same list as Codex web work mode. */
export async function fetchCodexModels(): Promise<ModelOption[]> {
  const env = fs.existsSync(userAuthFile()) ? loginEnv() : cliEnv();
  return withAppServer(env, async (call) => {
    await call("initialize", {
      clientInfo: { name: "scribe", title: "Scribe", version: "1.0.0" },
      capabilities: { experimentalApi: false },
    });
    const rows: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await call("model/list", {
        includeHidden: false,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!isPlainRecord(result) || !Array.isArray(result.data)) break;
      rows.push(...result.data);
      const next = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : "";
      if (!next) break;
      cursor = next;
    }
    return mapCodexModels(rows);
  });
}

/** Ask / Plan / Pages stay read-only; Full access drops the sandbox; otherwise workspace-write. */
export function sandboxFor(thread: Pick<Thread, "mode" | "approval">): SandboxMode {
  if (thread.mode === "ask" || thread.mode === "plan" || thread.mode === "board") return "read-only";
  if (thread.approval === "full") return "danger-full-access";
  return "workspace-write";
}

export function threadOptions(thread: Pick<Thread, "model" | "effort" | "mode" | "approval" | "web">, cwd: string): RpcRecord {
  const effort = thread.effort && thread.effort in EFFORT_LABELS ? (thread.effort as ModelReasoningEffort) : undefined;
  return {
    ...(thread.model && thread.model !== "default" ? { model: thread.model } : {}),
    sandbox: sandboxFor(thread),
    cwd,
    approvalPolicy: thread.approval === "full" ? "never" : "on-request",
    // Native review only handles actions that need approval; keep the mode's sandbox.
    approvalsReviewer: thread.approval === "auto" ? "auto_review" : "user",
    config: {
      ...(effort ? { model_reasoning_effort: effort } : {}),
      web_search: thread.web === "on" ? "live" : "disabled",
      "sandbox_workspace_write.network_access": thread.web === "on" && thread.mode === "code",
    },
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
  private modelLoad: Promise<ModelOption[]> | null = null;
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
            this.modelCache = null;
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

  models(refresh = false): Promise<ModelOption[]> {
    const cached = this.modelCache?.models.length ? this.modelCache.models : null;
    const fetchedAt = this.modelCache?.at ?? 0;
    const stale = !cached || Date.now() - fetchedAt >= MODELS_TTL_MS;
    // A real fetch (at > 0) that aged out is still close enough to show; refresh behind.
    // A restart seed (at === 0) may be the old hardcoded list — wait for the live catalog.
    if (!refresh && cached && !stale) return Promise.resolve(cached);
    if (!refresh && cached && fetchedAt > 0) {
      if (!this.modelLoad) void this.models(true);
      return Promise.resolve(cached);
    }
    if (this.modelLoad) return this.modelLoad;
    this.modelLoad = this.loadModels().finally(() => {
      this.modelLoad = null;
    });
    return this.modelLoad;
  }

  cachedModels(): ModelOption[] {
    return this.modelCache?.models ?? FALLBACK_MODELS;
  }

  /** Seed from the saved list so the first turn after a restart does not wait. Marked stale. */
  setModelCache(models: ModelOption[]): void {
    if (models.length && !this.modelCache) this.modelCache = { at: 0, models };
  }

  private async loadModels(): Promise<ModelOption[]> {
    if (!hasAuthFile() && !hasApiKey()) {
      return this.modelCache?.models.length ? this.modelCache.models : FALLBACK_MODELS;
    }
    try {
      syncCodexAuth();
      const models = await fetchCodexModels();
      if (models.length) {
        this.modelCache = { at: Date.now(), models };
        return models;
      }
    } catch (err) {
      log(`Codex model list failed: ${(err as Error).message}`);
    }
    return this.modelCache?.models.length ? this.modelCache.models : FALLBACK_MODELS;
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

/** Normalize app-server v2 items into the existing Scribe tool renderer. */
export function appServerItem(item: RpcRecord): ThreadItem | null {
  const id = String(item.id ?? "");
  switch (item.type) {
    case "agentMessage": return { type: "agent_message", id, text: String(item.text ?? "") };
    case "plan": return { type: "agent_message", id, text: String(item.text ?? "") };
    case "reasoning": return { type: "reasoning", id, text: [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].join("\n") };
    case "commandExecution": return { type: "command_execution", id, command: String(item.command ?? ""), aggregated_output: String(item.aggregatedOutput ?? ""),
      ...(typeof item.exitCode === "number" ? { exit_code: item.exitCode } : {}), status: item.status === "completed" ? "completed" : item.status === "failed" || item.status === "declined" ? "failed" : "in_progress" };
    case "fileChange": return { type: "file_change", id, changes: (Array.isArray(item.changes) ? item.changes.filter(isPlainRecord) : []).map((change) => ({ path: String(change.path), kind: isPlainRecord(change.kind) ? change.kind.type === "add" ? "add" : change.kind.type === "delete" ? "delete" : "update" : "update" })), status: item.status === "failed" || item.status === "declined" ? "failed" : "completed" };
    case "mcpToolCall": return { type: "mcp_tool_call", id, server: String(item.server), tool: String(item.tool), arguments: item.arguments,
      ...(isPlainRecord(item.result) ? { result: item.result as McpToolCallItem["result"] } : {}),
      ...(isPlainRecord(item.error) ? { error: { message: String(item.error.message) } } : {}),
      status: item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : "in_progress" };
    case "webSearch": return { type: "web_search", id, query: String(item.query ?? "") };
    default: return null;
  }
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

export class CodexSession implements ProviderSession {
  private rpc: CodexRpc | null = null;
  private opening: Promise<void> | null = null;
  private activeTurn: string | null = null;
  private finishTurn: ((result: TurnResult) => void) | null = null;
  private steers = new Map<string, { input: SteerInput; state: "queued" | "sending" | "accepted"; cleanup?: () => void }>();
  private turnUsage: RpcRecord | null = null;
  private steerCleanups: Array<() => void> = [];
  private requests = new Map<string | number, AbortController>();
  private outputs = new Map<string, string>();
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
    private onDispose: () => void,
    private launch: (onMessage: (message: RpcMessage) => void, onClose: (error: Error) => void) => CodexRpc =
      (onMessage, onClose) => {
        const env = cliEnv();
        const apiKey = apiKeyOption().apiKey;
        if (apiKey) env.CODEX_API_KEY = apiKey;
        return CodexRpc.launch(codexCliJs(), env, onMessage, onClose);
      },
    private prepare: () => void = syncCodexAuth,
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
      this.rpc?.close();
      this.rpc = null;
      this.sessionKey = null;
    }
    if (this.sessionKey !== null && this.sessionKey !== this.key() && !this.running) {
      this.rpc?.close();
      this.rpc = null;
      this.sessionKey = null;
    }
    if (was.id !== thread.id) {
      this.rpc?.close();
      this.rpc = null;
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

  private async ensureHandle(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.openHandle().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async openHandle(): Promise<void> {
    const key = this.key();
    if (this.rpc?.alive && this.sessionKey === key) return;
    this.rpc?.close();
    this.prepare();
    const rpc = this.launch((message) => this.onRpc(message, rpc), (error) => {
      if (this.rpc !== rpc) return;
      this.sessionKey = null;
      this.abort?.abort();
      this.finishTurn?.({ status: this.cancelled ? "cancelled" : "error", error: error.message });
    });
    this.rpc = rpc;
    try {
      await rpc.call("initialize", { clientInfo: { name: "scribe", title: "Scribe", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      rpc.notify("initialized");
      const options = {
        ...threadOptions(this.thread, this.cwd()),
        developerInstructions: this.instructions,
        config: {
          ...mcpConfig(this.ctx, this.thread.id, !noPages(this.thread.scope)),
          ...threadOptions(this.thread, this.cwd()).config as RpcRecord,
        },
      };
      let result: unknown;
      if (this.nativeId) {
        try { result = await rpc.call("thread/resume", { ...options, threadId: this.nativeId }); }
        catch (error) {
          if (!/not found|unknown thread|no rollout/i.test((error as Error).message)) throw error;
          this.sink?.notice("warn", "Could not resume the Codex thread; this turn starts a new one without the earlier conversation.");
          this.nativeId = null;
          result = await rpc.call("thread/start", options);
        }
      } else result = await rpc.call("thread/start", options);
      if (!isPlainRecord(result) || !isPlainRecord(result.thread) || typeof result.thread.id !== "string") throw new Error("Invalid Codex thread response");
      this.nativeId = result.thread.id;
      this.sessionKey = key;
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

  async warm(instructions: string): Promise<void> {
    if (this.sink) return;
    this.instructions = instructions;
    try {
      await this.ensureHandle();
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
    if (opts?.adopt) this.steers.delete(opts.adopt);
    this.sink = sink;
    this.cancelled = false;
    this.streamed.clear();
    this.tools.clear();
    this.outputs.clear();
    this.plan = null;
    this.turnUsage = null;
    this.instructions = input.instructions;
    const images = writeImages(input.images);
    this.abort = new AbortController();
    const payload = this.turnInput(input.text, images.paths);
    try {
      return await this.streamTurn(payload, sink);
    } catch (err) {
      if (this.cancelled || (err as Error)?.name === "AbortError") return { status: "cancelled" };
      return { status: "error", error: (err as Error).message || String(err) };
    } finally {
      this.running = false;
      this.activeTurn = null;
      this.finishTurn = null;
      this.abort?.abort();
      this.abort = null;
      this.sink = null;
      for (const steer of this.steers.values()) steer.cleanup?.();
      for (const cleanup of this.steerCleanups) cleanup();
      this.steerCleanups = [];
      // The host requeues any steer not acknowledged through sink.steered.
      this.steers.clear();
      images.cleanup();
      this.armIdle();
    }
  }

  private turnInput(text: string, imagePaths: string[]): RpcRecord[] {
    return [{ type: "text", text, text_elements: [] }, ...imagePaths.map((file) => ({ type: "localImage", path: file }))];
  }

  private async streamTurn(payload: RpcRecord[], sink: RunSink): Promise<TurnResult> {
    await this.ensureHandle();
    if (this.nativeId) {
      sink.nativeId(this.nativeId);
      this.reported = this.nativeId;
    }
    if (this.cancelled) return { status: "cancelled" };
    this.running = true;
    const done = new Promise<TurnResult>((resolve) => { this.finishTurn = resolve; });
    const result = await this.rpc!.call("turn/start", {
      threadId: this.nativeId, input: payload,
      ...(this.thread.effort ? { effort: this.thread.effort } : {}),
    });
    if (!isPlainRecord(result) || !isPlainRecord(result.turn) || typeof result.turn.id !== "string") throw new Error("Invalid Codex turn response");
    // turn/started may already have arrived; turn/completed may arrive before the response.
    if (this.finishTurn) this.activeTurn = result.turn.id;
    for (const id of this.steers.keys()) this.sendSteer(id);
    if (this.cancelled && this.activeTurn) await this.interrupt();
    const outcome = await done;
    if (outcome.status === "done" && this.plan && this.thread.mode === "plan") {
      await sink.plan({ title: "Plan", text: this.plan }).catch(() => undefined);
    }
    return outcome;
  }

  steer(input: SteerInput): string {
    const id = randomUUID();
    this.steers.set(id, { input, state: "queued" });
    // The host records the returned id before delivery can be acknowledged.
    queueMicrotask(() => this.sendSteer(id));
    return id;
  }

  private sendSteer(id: string): void {
    const steer = this.steers.get(id);
    const rpc = this.rpc;
    if (!steer || steer.state !== "queued" || !this.activeTurn || !rpc?.alive || this.cancelled) return;
    const images = writeImages(steer.input.images);
    this.steerCleanups.push(images.cleanup);
    steer.cleanup = images.cleanup;
    steer.state = "sending";
    void rpc.call("turn/steer", {
      threadId: this.nativeId, expectedTurnId: this.activeTurn,
      clientUserMessageId: id, input: this.turnInput(steer.input.text, images.paths),
    }).then(() => {
      if (this.steers.get(id) === steer) steer.state = "accepted";
    }).catch((error) => {
      if (this.steers.get(id) === steer) steer.state = "queued";
      log(`Codex steer failed: ${(error as Error).message}`);
    });
  }

  dropSteer(id: string): void {
    const steer = this.steers.get(id);
    // Once sent, the server owns the input; it cannot safely be withdrawn locally.
    if (steer?.state === "queued") { steer.cleanup?.(); this.steers.delete(id); }
  }

  async withdrawSteer(id: string): Promise<boolean> {
    if (this.steers.get(id)?.state !== "queued") return false;
    this.dropSteer(id);
    return true;
  }

  private onRpc(message: RpcMessage, rpc: CodexRpc): void {
    if (this.rpc !== rpc) return;
    if (message.id !== undefined && message.method) {
      void this.onRequest(message, rpc).catch((error) => {
        rpc.reject(message.id!, (error as Error).message);
      });
      return;
    }
    const p = message.params ?? {};
    const sink = this.sink;
    if (!sink || (p.threadId && p.threadId !== this.nativeId)) return;
    if (p.turnId && this.activeTurn && p.turnId !== this.activeTurn) return;
    switch (message.method) {
      case "turn/started":
        if (isPlainRecord(p.turn) && typeof p.turn.id === "string") {
          this.activeTurn = p.turn.id;
          for (const id of this.steers.keys()) this.sendSteer(id);
        }
        break;
      case "turn/completed": {
        const turn = isPlainRecord(p.turn) ? p.turn : {};
        if (this.activeTurn && turn.id !== this.activeTurn) return;
        this.activeTurn = null;
        if (this.turnUsage) {
          const u = this.turnUsage;
          sink.usage({ inputTokens: Number(u.inputTokens) || 0, outputTokens: Number(u.outputTokens) || 0,
            cacheReadTokens: Number(u.cachedInputTokens) || 0, cacheWriteTokens: Number(u.cacheWriteInputTokens) || 0,
            reasoningTokens: Number(u.reasoningOutputTokens) || 0 });
        }
        const error = isPlainRecord(turn.error) ? String(turn.error.message || "Codex turn failed") : undefined;
        this.finishTurn?.(this.cancelled || turn.status === "interrupted" ? { status: "cancelled" }
          : turn.status === "failed" ? { status: "error", error: error || "Codex turn failed" } : { status: "done" });
        this.finishTurn = null;
        this.abort?.abort();
        break;
      }
      case "thread/tokenUsage/updated":
        if (isPlainRecord(p.tokenUsage) && isPlainRecord(p.tokenUsage.last)) this.turnUsage = p.tokenUsage.last;
        break;
      case "item/started":
      case "item/completed": {
        if (!isPlainRecord(p.item)) return;
        const item = p.item;
        if (item.type === "userMessage" && typeof item.clientId === "string" && this.steers.has(item.clientId)) {
          this.steers.delete(item.clientId);
          sink.steered?.(item.clientId);
        }
        const converted = appServerItem(item);
        if (converted) this.onItem(converted, message.method === "item/completed", sink);
        break;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const id = String(p.itemId);
        const delta = String(p.delta ?? "");
        if (!this.streamed.has(id)) sink.breakBlock();
        if (message.method.includes("reasoning")) sink.reasoning(delta);
        else sink.text(delta);
        this.streamed.set(id, (this.streamed.get(id) ?? 0) + delta.length);
        break;
      }
      case "item/commandExecution/outputDelta":
        this.outputs.set(String(p.itemId), (this.outputs.get(String(p.itemId)) ?? "") + String(p.delta ?? ""));
        sink.toolUpdate(String(p.itemId), { output: this.outputs.get(String(p.itemId)) });
        break;
      case "serverRequest/resolved":
        if (typeof p.requestId === "string" || typeof p.requestId === "number") this.requests.get(p.requestId)?.abort();
        break;
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        // CLI 0.162.0's experimental review notifications. These report the native
        // decision; they must never grant access through the host approval callback.
        const review = isPlainRecord(p.review) ? p.review : {};
        const action = isPlainRecord(p.action) ? p.action : {};
        const status = message.method.endsWith("/started") ? "inProgress" : review.status;
        const labels: Record<string, string> = {
          inProgress: "reviewing", approved: "approved", denied: "denied",
          timedOut: "timed out", aborted: "aborted",
        };
        const target = typeof p.targetItemId === "string" ? ` (item ${p.targetItemId})` : "";
        const detail = typeof action.command === "string" ? action.command
          : action.type === "applyPatch" && Array.isArray(action.files) ? action.files.join(", ")
          : action.type === "networkAccess" ? String(action.target ?? action.host ?? "network access")
          : action.type === "mcpToolCall" ? `${action.server ?? "MCP"}/${action.toolName ?? "tool"}`
          : typeof action.type === "string" ? action.type : "action";
        const rationale = typeof review.rationale === "string" && review.rationale ? `\n${review.rationale}` : "";
        sink.notice(status === "inProgress" || status === "approved" ? "info" : status === "denied" ? "warn" : "error",
          `Codex Auto-review ${labels[String(status)] ?? "failed (unknown review status)"}${target}: ${detail}${rationale}`);
        break;
      }
      case "guardianWarning":
        sink.notice("warn", `Codex Auto-review: ${typeof p.message === "string" ? p.message : "review warning"}`);
        break;
      case "turn/plan/updated":
        if (Array.isArray(p.plan)) sink.todos(p.plan.filter(isPlainRecord).map((step) => ({ content: String(step.step ?? ""), status: step.status === "completed" ? "completed" : step.status === "inProgress" ? "in_progress" : "pending" })));
        break;
      case "error":
        sink.notice("error", isPlainRecord(p.error) ? String(p.error.message) : "Codex error");
        break;
    }
  }

  private async onRequest(message: RpcMessage, rpc: CodexRpc): Promise<void> {
    const controller = new AbortController();
    this.requests.set(message.id!, controller);
    const signal = this.abort ? AbortSignal.any([controller.signal, this.abort.signal]) : controller.signal;
    try { await this.handleRequest(message, rpc, signal); }
    finally { this.requests.delete(message.id!); }
  }

  private async handleRequest(message: RpcMessage, rpc: CodexRpc, signal: AbortSignal): Promise<void> {
    const p = message.params ?? {};
    const id = message.id!;
    const sink = this.sink;
    if (!sink || (p.threadId && p.threadId !== this.nativeId) || (p.turnId && p.turnId !== this.activeTurn)) {
      rpc.reject(id, "No matching active Scribe turn");
      return;
    }
    if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
      const file = message.method.includes("fileChange");
      const decision = await sink.approval({
        toolId: String(p.itemId), tool: file ? "edit" : "execute",
        title: file ? "Edit files" : "Run command",
        detail: [p.command, p.reason, p.cwd].filter((value) => typeof value === "string").join("\n"),
        options: [{ id: "accept", label: "Allow once", kind: "allow_once" },
          { id: "acceptForSession", label: "Allow for this session", kind: "allow_always" },
          { id: "decline", label: "Decline", kind: "reject_once" }],
      }, signal).catch(() => ({ optionId: "cancel" }));
      rpc.reply(id, { decision: ["accept", "acceptForSession", "decline"].includes(decision.optionId) ? decision.optionId : "cancel" });
      return;
    }
    if (message.method === "item/tool/requestUserInput") {
      const questions = Array.isArray(p.questions) ? p.questions.filter(isPlainRecord) : [];
      const answer = await sink.question({ questions: questions.map((q) => ({ id: String(q.id), header: String(q.header ?? ""), prompt: String(q.question), multi: false,
        options: Array.isArray(q.options) ? q.options.filter(isPlainRecord).map((o) => ({ id: String(o.label), label: String(o.label), description: String(o.description ?? "") })) : [],
      })) }, signal).catch(() => ({ skipped: true as const }));
      const answers: Record<string, { answers: string[] }> = {};
      if (!("skipped" in answer)) for (const q of questions) {
        const qid = String(q.id);
        answers[qid] = { answers: [...(answer.answers[qid] ?? []), ...(answer.notes?.[qid] ? [answer.notes[qid]] : [])] };
      }
      rpc.reply(id, { answers });
      return;
    }
    // Unsupported permission grants and MCP elicitations fail closed, never silently grant access.
    if (message.method === "item/permissions/requestApproval") { rpc.reply(id, { permissions: {}, scope: "turn" }); return; }
    if (message.method === "mcpServer/elicitation/request") { rpc.reply(id, { action: "decline", content: null, _meta: null }); return; }
    rpc.reject(id, `Unsupported Codex request: ${message.method}`);
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
    if (this.activeTurn) await this.interrupt();
  }

  private async interrupt(): Promise<void> {
    try { await this.rpc?.call("turn/interrupt", { threadId: this.nativeId, turnId: this.activeTurn }, 5000); }
    catch { this.rpc?.close(); }
  }

  private stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.running) return;
    this.rpc?.close();
    this.rpc = null;
    this.sessionKey = null;
  }

  dispose(): void {
    void this.cancel();
    this.running = false;
    this.stop();
    this.onDispose();
  }
}
