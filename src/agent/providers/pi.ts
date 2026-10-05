import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ModelRuntime, ToolCallEvent, ToolCallEventResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, ImageContent, Model as PiModel, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dataDir } from "../../config.js";
import { log } from "../../log.js";
import { fetchModelIds, type OpenAISource } from "../openaiSources.js";
import { isPlainRecord, type ModelOption, type ProviderStatus, type QuestionSpec, type SlashCommand, type Thread, type ToolKind, type Usage } from "../types.js";
import { gatedFetchText, webCallAllowed } from "../webAccess.js";
import { SparePool, type AgentProvider, type ApprovalRequest, type ProviderSession, type RunSink, type SessionContext, type SteerInput, type TurnInput, type TurnResult } from "./provider.js";

type Model = PiModel<Api>;

/**
 * Pi (@earendil-works/pi-coding-agent) through its SDK, in this process: any model Pi can reach,
 * local ones included. Scribe keeps its own Pi folder (data/agent/pi), so the user's ~/.pi
 * extensions, keys and settings stay out. Models come from the "Model sources" in Agent settings
 * (compatible endpoints, registered as Pi providers) and from Pi's built-in providers that have a
 * key in the environment or in Scribe's Pi auth.json.
 *
 * Pi ships no approvals, questions, plan review, todos or web tools. Scribe adds them: a tool_call
 * hook asks the user before edits and commands (by the thread's approval level), and custom tools
 * stand in for the rest. The board's tools reach the model as custom tools that call this daemon's
 * board MCP server, as with Cursor.
 */

const IDLE_CLOSE_MS = 15 * 60 * 1000;
const MODELS_TTL_MS = 10 * 60 * 1000;
/** Pi's built-in tools by mode. Pages gets none: only the board tools. */
const READ_TOOLS = ["read", "grep", "find", "ls"];
const CODE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const EFFORT_LABELS: Record<string, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
/** Defaults for a compatible endpoint's models, which say nothing about their limits. */
const SOURCE_CONTEXT = 128_000;
const SOURCE_MAX_TOKENS = 16_384;

type Sdk = typeof import("@earendil-works/pi-coding-agent");
type Ai = typeof import("@earendil-works/pi-ai");
let sdkLoad: Promise<{ sdk: Sdk; ai: Ai }> | null = null;
/** Pi is large; load it on first use instead of with the daemon. */
function pi(): Promise<{ sdk: Sdk; ai: Ai }> {
  sdkLoad ??= Promise.all([import("@earendil-works/pi-coding-agent"), import("@earendil-works/pi-ai")]).then(([sdk, ai]) => ({ sdk, ai }));
  sdkLoad.catch(() => {
    sdkLoad = null;
  });
  return sdkLoad;
}

function piDir(): string {
  return path.join(dataDir(), "agent", "pi");
}
/** Pi's agent dir (auth.json, models.json, skills, prompts), Scribe's own instead of ~/.pi/agent. */
function agentDir(): string {
  return path.join(piDir(), "agent");
}
function sessionDir(): string {
  return path.join(piDir(), "sessions");
}

/** The Pi provider id a model source is registered under. */
export function sourceProviderId(sourceId: string): string {
  return `src-${sourceId}`;
}

/** "<pi provider>/<model id>" → its parts. Model ids may contain slashes themselves (OpenRouter). */
export function splitPiModel(id: string): { provider: string; model: string } | null {
  const at = id.indexOf("/");
  if (at <= 0 || at === id.length - 1) return null;
  return { provider: id.slice(0, at), model: id.slice(at + 1) };
}

/** Pi's built-in tools for a thread's mode; Plan starts read-only and gets the rest when its plan is accepted. */
export function builtinTools(mode: Thread["mode"]): string[] {
  if (mode === "board") return [];
  if (mode === "ask" || mode === "plan") return READ_TOOLS;
  return CODE_TOOLS;
}

/** Programs (with their first argument where it matters) that only read, for the "auto" approval level. */
const READ_ONLY_COMMANDS = [
  "ls",
  "dir",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "echo",
  "grep",
  "rg",
  "which",
  "where",
  "type",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "sort",
  "uniq",
  "cut",
  "diff",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "git blame",
  "git remote",
  "git worktree list",
  "node --version",
  "npm --version",
  "npm ls",
  "npm view",
  "npm test",
  "npm run test",
  "npm run build",
  "npx tsc",
  "pnpm test",
  "yarn test",
  "cargo check",
  "cargo test",
  "go test",
  "go vet",
  "pytest",
  "python -m pytest",
];

/**
 * Whether a shell command only reads (or runs the project's tests or build), so the "auto" level
 * runs it without asking. Strict: no redirection or substitution, and every part of a pipe or
 * chain has to be on the list.
 */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || /[<>`]|\$\(/.test(cmd)) return false;
  const parts = cmd.split(/&&|\|\||;|\|/).map((part) => part.trim().replace(/\s+/g, " "));
  return parts.every((part) => {
    if (!part) return false;
    if (/^find\b/.test(part)) return !/\s-(exec|execdir|delete|ok|fprint)/.test(part);
    if (/^sed\b/.test(part)) return /^sed -n\b/.test(part) && !/\s-i/.test(part);
    if (/^git branch\b/.test(part)) return !/\s-(d|D|m|M|c|C|f)\b|--delete|--move|--force/.test(part);
    if (/^git remote\b/.test(part)) return /^git remote( -v| show\b|$)/.test(part);
    return READ_ONLY_COMMANDS.some((prefix) => part === prefix || part.startsWith(`${prefix} `));
  });
}

/** Whether `target` is inside `root` (both absolute). */
function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function toolKind(name: string): ToolKind {
  switch (name) {
    case "bash":
    case "powershell":
      return "execute";
    case "read":
    case "ls":
      return "read";
    case "grep":
    case "find":
      return "search";
    case "edit":
    case "write":
      return "edit";
    case "web_fetch":
      return "fetch";
    case "todo_write":
      return "todo";
    default:
      return "mcp";
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isPlainRecord)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : block.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

export class PiProvider implements AgentProvider {
  readonly id = "pi" as const;
  readonly label = "Pi";
  private runtimeLoad: Promise<ModelRuntime> | null = null;
  private modelCache: { at: number; models: ModelOption[] } | null = null;
  private modelLoad: Promise<ModelOption[]> | null = null;
  /** Source providers registered with the runtime, so a removed source is unregistered. */
  private registered = new Set<string>();
  private sessions = new Set<PiSession>();
  private spares = new SparePool<PiSession>();

  constructor(private sources: () => OpenAISource[]) {}

  /** Pi's model and key runtime, on Scribe's own auth.json and models.json. */
  runtime(): Promise<ModelRuntime> {
    this.runtimeLoad ??= (async () => {
      const { sdk } = await pi();
      fs.mkdirSync(agentDir(), { recursive: true });
      return sdk.ModelRuntime.create({ authPath: path.join(agentDir(), "auth.json"), modelsPath: path.join(agentDir(), "models.json") });
    })().catch((err) => {
      this.runtimeLoad = null;
      throw err;
    });
    return this.runtimeLoad;
  }

  async status(): Promise<ProviderStatus> {
    try {
      const models = await this.models();
      if (!models.length) return { id: this.id, label: this.label, available: false, detail: "No models: add a model source in Agent settings, or set a provider's API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, …)." };
      return { id: this.id, label: this.label, available: true, detail: models.length === 1 ? "1 model" : `${models.length} models` };
    } catch (err) {
      return { id: this.id, label: this.label, available: false, detail: `Pi failed to load: ${(err as Error).message}` };
    }
  }

  /** The sources changed: register them again and list models on the next ask. */
  invalidate(): void {
    this.modelCache = null;
  }

  cachedModels(): ModelOption[] {
    return this.modelCache?.models ?? [];
  }

  models(refresh = false): Promise<ModelOption[]> {
    if (!refresh && this.modelCache && Date.now() - this.modelCache.at < MODELS_TTL_MS) return Promise.resolve(this.modelCache.models);
    this.modelLoad ??= this.loadModels().finally(() => {
      this.modelLoad = null;
    });
    return this.modelLoad;
  }

  /** Register every model source as a Pi provider speaking OpenAI Chat Completions. */
  private async registerSources(runtime: ModelRuntime): Promise<void> {
    const sources = this.sources();
    const wanted = new Set(sources.map((s) => sourceProviderId(s.id)));
    for (const id of this.registered) {
      if (!wanted.has(id)) runtime.unregisterProvider(id);
    }
    this.registered.clear();
    await Promise.all(
      sources.map(async (source) => {
        let ids = source.models;
        if (!ids.length) {
          try {
            ids = await fetchModelIds(source);
          } catch (err) {
            log(`Pi: model list of ${source.name} failed: ${(err as Error).message}`);
            ids = [];
          }
        }
        const id = sourceProviderId(source.id);
        runtime.registerProvider(id, {
          name: source.name,
          baseUrl: source.baseUrl,
          // Local servers take no key, but Pi lists only providers that have one.
          apiKey: source.apiKey || "none",
          api: "openai-completions",
          models: ids.map((model) => ({
            id: model,
            name: model,
            reasoning: Boolean(source.reasoning),
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: SOURCE_CONTEXT,
            maxTokens: SOURCE_MAX_TOKENS,
          })),
        });
        this.registered.add(id);
      })
    );
  }

  private async loadModels(): Promise<ModelOption[]> {
    const { ai } = await pi();
    const runtime = await this.runtime();
    await this.registerSources(runtime);
    const available = await runtime.getAvailable().catch((err) => {
      log(`Pi model list failed: ${(err as Error).message}`);
      return [] as Model[];
    });
    const sourceIds = new Set(this.registered);
    const names = new Map(this.sources().map((s) => [sourceProviderId(s.id), s.name]));
    const option = (m: Model): ModelOption => {
      const levels = ai.getSupportedThinkingLevels(m).filter((level) => level !== "off");
      return {
        id: `${m.provider}/${m.id}`,
        label: m.name || m.id,
        provider: "pi",
        description: names.get(m.provider) ?? runtime.getProvider(m.provider)?.name ?? m.provider,
        efforts: levels.map((level) => ({ id: level, label: EFFORT_LABELS[level] ?? level })),
        defaultEffort: null,
        params: [],
      };
    };
    // The user's own sources first: they are why Pi is here.
    const models = [...available.filter((m) => sourceIds.has(m.provider)), ...available.filter((m) => !sourceIds.has(m.provider))].map(option);
    this.modelCache = { at: Date.now(), models };
    return models;
  }

  /** The Pi model for a thread's model id; "default" (or an unknown id) is the first model. */
  async resolveModel(id: string): Promise<Model | null> {
    const runtime = await this.runtime();
    const models = this.cachedModels().length ? this.cachedModels() : await this.models();
    const parts = id && id !== "default" ? splitPiModel(id) : null;
    const found = parts ? runtime.getModel(parts.provider, parts.model) : undefined;
    if (found) return found;
    const first = models[0] ? splitPiModel(models[0].id) : null;
    return first ? (runtime.getModel(first.provider, first.model) ?? null) : null;
  }

  async complete(prompt: string, model: string, signal?: AbortSignal): Promise<string> {
    const runtime = await this.runtime();
    const target = await this.resolveModel(model);
    if (!target) throw new Error(`Unknown model: ${model}`);
    const reply = await runtime.completeSimple(target, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { signal });
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || "Pi: the model failed");
    return reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  }

  createSession(thread: Thread, ctx: SessionContext): ProviderSession {
    const spare = thread.nativeId ? null : this.spares.take(spareKey(thread, ctx), thread.id);
    if (spare) {
      spare.update(thread);
      return spare;
    }
    return this.newSession(thread, ctx);
  }

  private newSession(thread: Thread, ctx: SessionContext): PiSession {
    const session = new PiSession(this, thread, ctx, () => this.sessions.delete(session));
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

/** A spare is bound to what its session was opened with. */
function spareKey(thread: Thread, ctx: SessionContext): string {
  const where = thread.mode === "board" || !thread.cwd ? `board:${ctx.scratchDir}` : `cwd:${path.normalize(thread.cwd).toLowerCase()}`;
  return JSON.stringify([where, thread.mode, thread.web]);
}

/** The board MCP server's tools as Pi custom tools: one MCP client per session, started with the thread's id so card claims point at it. */
class BoardTools {
  private client: Client | null = null;
  private opening: Promise<ToolDefinition[]> | null = null;

  constructor(
    private spec: SessionContext["boardMcp"],
    readonly threadId: string
  ) {}

  tools(): Promise<ToolDefinition[]> {
    this.opening ??= this.open().catch((err) => {
      this.opening = null;
      throw err;
    });
    return this.opening;
  }

  private async open(): Promise<ToolDefinition[]> {
    const client = new Client({ name: "scribe-pi", version: "1" });
    const env = { ...(process.env as Record<string, string>), ...this.spec.env, SCRIBE_THREAD: this.threadId };
    await client.connect(new StdioClientTransport({ command: this.spec.command, args: this.spec.args, env, stderr: "ignore" }));
    this.client = client;
    const { tools } = await client.listTools();
    return tools.map(
      (tool): ToolDefinition => ({
        name: tool.name,
        label: `Scribe: ${tool.name}`,
        description: tool.description ?? "",
        // Pi takes plain JSON Schema, as its own MCP extension does.
        parameters: { ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} } as unknown as ToolDefinition["parameters"],
        execute: async (_id, params, signal) => {
          const result = await client.callTool({ name: tool.name, arguments: isPlainRecord(params) ? params : {} }, undefined, { signal, timeout: 24 * 60 * 60 * 1000 });
          const content = mcpContent(result.content);
          if (result.isError === true) throw new Error(textOf(content) || "The tool failed.");
          return { content, details: undefined };
        },
      })
    );
  }

  close(): void {
    void this.client?.close().catch(() => undefined);
    this.client = null;
    this.opening = null;
  }
}

function mcpContent(content: unknown): Array<TextContent | ImageContent> {
  if (!Array.isArray(content)) return [];
  return content.filter(isPlainRecord).map((block): TextContent | ImageContent => {
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block.type === "image" && typeof block.data === "string") return { type: "image", data: block.data, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" };
    return { type: "text", text: JSON.stringify(block) };
  });
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

type Steer = { text: string; state: "queued" | "delivered" | "dropped" };

class PiSession implements ProviderSession {
  private session: AgentSession | null = null;
  /** What the open session was created with; a change reopens it before the next turn. */
  private sessionKey: string | null = null;
  private opening: Promise<AgentSession> | null = null;
  /** The session file; Thread.nativeId. */
  private file: string | null;
  private reported: string | null = null;
  private board: BoardTools | null = null;
  private sink: RunSink | null = null;
  private running = false;
  private cancelled = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private warming: Promise<void> | null = null;
  private instructions = "";
  private steers = new Map<string, Steer>();
  private carry: string | null = null;
  private usage: Usage = {};
  /** Text and reasoning blocks of the message streaming now, so a new block breaks the chat item. */
  private lastBlock: number | null = null;
  /** Plan mode's exit_plan was accepted: the session has the Code tools now. */
  private planAccepted = false;

  constructor(
    private provider: PiProvider,
    private thread: Thread,
    private ctx: SessionContext,
    private onDispose: () => void
  ) {
    this.file = thread.nativeId && fs.existsSync(thread.nativeId) ? thread.nativeId : null;
  }

  scribeThreadId(): string {
    return this.thread.id;
  }

  update(thread: Thread): void {
    const was = this.thread;
    this.thread = thread;
    if (this.reported && thread.nativeId !== this.reported && !this.running) {
      // The host dropped the session (a rewind): start a new one.
      this.reported = null;
      this.file = thread.nativeId && fs.existsSync(thread.nativeId) ? thread.nativeId : null;
      this.closeSession();
    }
    if (was.mode !== thread.mode) this.planAccepted = false;
    if (this.sessionKey !== null && this.sessionKey !== this.key() && !this.running) this.closeSession();
  }

  async commands(): Promise<SlashCommand[]> {
    const session = this.session;
    if (!session) return [];
    return session.resourceLoader
      .getPrompts()
      .prompts.map((p) => ({ name: p.name, ...(p.description ? { description: p.description } : {}) }))
      .concat(session.resourceLoader.getSkills().skills.map((s) => ({ name: `skill:${s.name}`, ...(s.description ? { description: s.description } : {}) })));
  }

  private cwd(): string {
    if (this.thread.mode === "board" || !this.thread.cwd) return this.ctx.scratchDir;
    return this.thread.cwd;
  }

  private key(): string {
    const t = this.thread;
    return JSON.stringify([t.id, t.mode, t.web, this.cwd(), this.instructions]);
  }

  private async gateFetch(url: string): Promise<{ allowed: boolean; message?: string }> {
    const call = { kind: "fetch" as const, url };
    const allowlist = this.thread.web === "limited" ? this.ctx.webAllowlist() : [];
    if (webCallAllowed(call, this.thread.web, allowlist, this.thread.webGrants)) return { allowed: true };
    if (!this.ctx.webRequest) return { allowed: false, message: "web access is off for this thread." };
    return this.ctx.webRequest(this.thread.id, call);
  }

  /** The tools Scribe adds to Pi: the board's, the web fetch, questions, todos, and Plan mode's exit_plan. */
  private async customTools(): Promise<ToolDefinition[]> {
    this.board ??= new BoardTools(this.ctx.boardMcp, this.thread.id);
    const tools = [...(await this.board.tools())];
    tools.push({
      name: "web_fetch",
      label: "Fetch",
      description:
        this.thread.web === "on"
          ? "Fetch a web page or file over HTTP(S) and return its text. Web search is not available."
          : "Fetch a web page or file over HTTP(S) and return its text. Sites the user has not allowed ask the user first, who may refuse. Web search is not available.",
      parameters: { type: "object", properties: { url: { type: "string", description: "Absolute http(s) URL" } }, required: ["url"] } as unknown as ToolDefinition["parameters"],
      execute: async (_id, params) => {
        const result = await gatedFetchText(isPlainRecord(params) ? params.url : undefined, (url) => this.gateFetch(url));
        if (result.isError) throw new Error(result.text);
        return text(result.text);
      },
    });
    tools.push({
      name: "ask_user",
      label: "Question",
      description:
        "Ask the user one or more multiple-choice questions and wait for the answers. Use it when you need a decision you cannot make yourself. The user can also answer in their own words or skip.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The full question." },
                header: { type: "string", description: "A short label (a few words)." },
                multiSelect: { type: "boolean", description: "Allow more than one answer." },
                options: {
                  type: "array",
                  minItems: 2,
                  maxItems: 4,
                  items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
                },
              },
              required: ["question", "options"],
            },
          },
        },
        required: ["questions"],
      } as unknown as ToolDefinition["parameters"],
      execute: async (_id, params, signal) => this.askUser(params, signal),
    });
    tools.push({
      name: "todo_write",
      label: "Todos",
      description: "Write the task list for this work, replacing the previous one. Use it for work with several steps, and keep exactly one item in_progress while you work.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      } as unknown as ToolDefinition["parameters"],
      execute: async (_id, params) => {
        const list = isPlainRecord(params) && Array.isArray(params.todos) ? params.todos.filter(isPlainRecord) : [];
        this.sink?.todos(
          list.map((todo) => ({
            content: String(todo.content ?? ""),
            status: todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in_progress" : "pending",
          }))
        );
        return text("Todos updated.");
      },
    });
    if (this.thread.mode === "plan") {
      tools.push({
        name: "exit_plan",
        label: "Plan",
        description: "Present your plan to the user for approval once you have investigated enough. If they accept, you get the editing tools and carry on implementing it in this turn; if not, revise it from their note.",
        parameters: { type: "object", properties: { plan: { type: "string", description: "The plan, in Markdown." } }, required: ["plan"] } as unknown as ToolDefinition["parameters"],
        execute: async (_id, params, signal) => this.exitPlan(isPlainRecord(params) ? str(params.plan) : undefined, signal),
      });
    }
    return tools;
  }

  private async askUser(params: unknown, signal: AbortSignal | undefined) {
    const sink = this.sink;
    if (!sink) throw new Error("No active turn: nobody is there to answer.");
    const raw = isPlainRecord(params) && Array.isArray(params.questions) ? params.questions.filter(isPlainRecord) : [];
    const questions: QuestionSpec[] = raw.map((q, i) => ({
      id: `q${i + 1}`,
      prompt: String(q.question ?? ""),
      ...(str(q.header) ? { header: str(q.header) } : {}),
      multi: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options.filter(isPlainRecord) : []).map((o, j) => ({
        id: `o${j + 1}`,
        label: String(o.label ?? ""),
        ...(str(o.description) ? { description: str(o.description) } : {}),
      })),
    }));
    if (!questions.length) throw new Error("No questions given.");
    const answer = await sink.question({ questions }, signal);
    if ("skipped" in answer) return text(`The user skipped the questions${answer.reason ? `: ${answer.reason}` : "."} Carry on with your best judgment.`);
    const lines = questions.map((q) => {
      const picked = (answer.answers[q.id] ?? []).map((id) => q.options.find((o) => o.id === id)?.label ?? id);
      const note = answer.notes?.[q.id];
      return `${q.prompt}\n→ ${picked.length ? picked.join(", ") : "(no choice)"}${note ? `\nNote: ${note}` : ""}`;
    });
    return text(lines.join("\n\n"));
  }

  private async exitPlan(plan: string | undefined, signal: AbortSignal | undefined) {
    const sink = this.sink;
    if (!sink) throw new Error("No active turn: nobody is there to review the plan.");
    if (!plan) throw new Error("Send the plan text.");
    const decision = await sink.plan({ title: "Plan", text: plan }, signal);
    if (!decision.accepted) return text(`The user did not accept the plan${decision.note ? `: ${decision.note}` : "."} Revise it and present it again with exit_plan.`);
    this.planAccepted = true;
    const session = this.session;
    if (session) session.setActiveToolsByName([...new Set([...session.getActiveToolNames().filter((n) => n !== "exit_plan"), ...CODE_TOOLS])]);
    sink.modeChanged?.("code");
    return text(`The user accepted the plan${decision.note ? ` with a note: ${decision.note}` : ""}. You can edit files and run commands now: implement it.`);
  }

  /** Approvals for Pi's own tools, from the tool_call hook. Scribe's custom tools gate themselves. */
  private async gate(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    const name = event.toolName;
    if (READ_TOOLS.includes(name)) return undefined;
    if (name !== "bash" && name !== "powershell" && name !== "edit" && name !== "write") return undefined;
    const sink = this.sink;
    const input = event.input as Record<string, unknown>;
    let req: ApprovalRequest;
    if (name === "edit" || name === "write") {
      const target = path.resolve(this.cwd(), str(input.path) ?? "");
      if (sink) await sink.beforeWrite(event.toolCallId, target).catch(() => undefined);
      const within = inside(this.cwd(), target);
      if (this.thread.approval === "auto" && within) return undefined;
      const rel = within ? path.relative(this.cwd(), target) || target : target;
      req = {
        toolId: event.toolCallId,
        // Outside the workspace it is not a plain edit: "edits" does not cover it.
        tool: within ? "edit" : "other",
        title: within ? `${name === "write" ? "Write" : "Edit"} ${rel}` : `${name === "write" ? "Write" : "Edit"} outside the workspace: ${target}`,
        options: [
          { id: "allow", label: "Allow", kind: "allow_once" },
          { id: "reject", label: "Reject", kind: "reject_once" },
        ],
      };
    } else {
      const command = str(input.command) ?? "";
      if (this.thread.approval === "auto" && isReadOnlyCommand(command)) return undefined;
      req = {
        toolId: event.toolCallId,
        tool: "execute",
        title: "Run command",
        detail: command,
        options: [
          { id: "allow", label: "Allow", kind: "allow_once" },
          { id: "reject", label: "Deny", kind: "reject_once" },
        ],
      };
    }
    const ask: ((req: ApprovalRequest) => Promise<{ optionId: string; note?: string }>) | undefined = sink
      ? (r) => sink.approval(r)
      : this.ctx.approval
        ? (r) => this.ctx.approval!(this.thread.id, r)
        : undefined;
    if (!ask) return { block: true, reason: "No active turn: nobody is there to approve this." };
    try {
      const decision = await ask(req);
      if (decision.optionId === "allow") return undefined;
      return { block: true, reason: `The user declined this${decision.note ? `: ${decision.note}` : "."}` };
    } catch (err) {
      return { block: true, reason: (err as Error).message || "Not allowed." };
    }
  }

  private async ensureSession(): Promise<AgentSession> {
    const key = this.key();
    if (this.session && this.sessionKey === key) return this.session;
    if (this.opening) return this.opening;
    this.opening = this.open(key).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(key: string): Promise<AgentSession> {
    this.closeSession();
    if (this.board && this.board.threadId !== this.thread.id) {
      this.board.close();
      this.board = null;
    }
    const { sdk } = await pi();
    const runtime = await this.provider.runtime();
    const cwd = this.cwd();
    const model = await this.provider.resolveModel(this.thread.model);
    if (!model) throw new Error("No Pi model: add a model source in Agent settings, or set a provider's API key, then pick a model.");
    fs.mkdirSync(sessionDir(), { recursive: true });
    const settingsManager = sdk.SettingsManager.inMemory({});
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: agentDir(),
      settingsManager,
      // Scribe's hooks only; no extension files from the workspace or Scribe's Pi folder.
      noExtensions: true,
      noThemes: true,
      ...(this.instructions ? { appendSystemPrompt: [this.instructions] } : {}),
      extensionFactories: [{ name: "scribe", hidden: true, factory: (api: ExtensionAPI) => void api.on("tool_call", (event) => this.gate(event)) }],
    });
    await resourceLoader.reload();
    let sessionManager = null;
    if (this.file) {
      try {
        sessionManager = sdk.SessionManager.open(this.file, sessionDir(), cwd);
      } catch (err) {
        log(`Pi session resume failed, starting a new session: ${(err as Error).message}`);
        this.sink?.notice("warn", "Could not resume the Pi session; this turn starts a new one without the earlier conversation.");
        this.file = null;
      }
    }
    sessionManager ??= sdk.SessionManager.create(cwd, sessionDir());
    const plan = this.thread.mode === "plan" && !this.planAccepted;
    const custom = await this.customTools();
    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir: agentDir(),
      modelRuntime: runtime,
      model,
      thinkingLevel: this.thinking(model),
      settingsManager,
      resourceLoader,
      sessionManager,
      // Pi's tools list is an allowlist: Plan mode needs the Code tools in it to switch them on when its plan is accepted.
      tools: [...builtinTools(plan ? "code" : this.thread.mode), ...custom.map((t) => t.name)],
      customTools: custom,
    });
    if (plan) session.setActiveToolsByName([...READ_TOOLS, ...custom.map((t) => t.name)]);
    await session.bindExtensions({});
    session.subscribe((event) => this.onEvent(event));
    this.file = session.sessionFile ?? null;
    this.session = session;
    this.sessionKey = key;
    return session;
  }

  private thinking(model: Model): ModelThinkingLevel {
    if (!model.reasoning) return "off";
    return (this.thread.effort as ModelThinkingLevel | null) ?? "medium";
  }

  private closeSession(): void {
    this.session?.dispose();
    this.session = null;
    this.sessionKey = null;
  }

  async warm(instructions: string): Promise<void> {
    if (this.sink) return;
    this.instructions = instructions;
    this.warming ??= this.ensureSession()
      .then(() => undefined)
      .catch((err) => log(`Pi warm-up failed: ${(err as Error).message}`))
      .finally(() => {
        this.warming = null;
      });
    this.armIdle();
    return this.warming;
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  steer(input: SteerInput): string {
    const id = randomUUID();
    this.steers.set(id, { text: input.text, state: "queued" });
    const session = this.session;
    if (this.running && session) {
      const images = input.images.map((image): ImageContent => ({ type: "image", data: image.data, mimeType: image.mimeType }));
      void session.steer(input.text, images.length ? images : undefined, { source: "rpc" }).catch((err) => log(`Pi steer failed: ${(err as Error).message}`));
    }
    return id;
  }

  dropSteer(steerId: string): void {
    const steer = this.steers.get(steerId);
    if (!steer || steer.state !== "queued") return;
    steer.state = "dropped";
    this.requeue();
  }

  async withdrawSteer(steerId: string): Promise<boolean> {
    const steer = this.steers.get(steerId);
    if (!steer || steer.state !== "queued") return false;
    this.steers.delete(steerId);
    this.requeue();
    return true;
  }

  /** Pi can only clear its whole queue: clear it and steer the messages still wanted again. */
  private requeue(): void {
    const session = this.session;
    if (!session || !this.running) return;
    session.clearQueue();
    for (const steer of this.steers.values()) {
      if (steer.state === "queued") void session.steer(steer.text, undefined, { source: "rpc" }).catch(() => undefined);
    }
  }

  async run(input: TurnInput, sink: RunSink, opts?: { adopt?: string }): Promise<TurnResult> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.sink = sink;
    this.cancelled = false;
    this.usage = {};
    this.lastBlock = null;
    try {
      if (this.warming) await this.warming;
      let prompt = input.text;
      let images = input.images;
      if (opts?.adopt) {
        if (this.carry !== opts.adopt) return { status: "error", error: "The steered message was lost." };
        prompt = this.steers.get(opts.adopt)?.text ?? prompt;
        this.steers.delete(opts.adopt);
        this.carry = null;
        images = [];
      }
      this.instructions = input.instructions;
      const session = await this.ensureSession();
      if (this.file) {
        sink.nativeId(this.file);
        this.reported = this.file;
      }
      const model = await this.provider.resolveModel(this.thread.model);
      if (model && (session.model?.provider !== model.provider || session.model?.id !== model.id)) await session.setModel(model);
      if (session.model) session.setThinkingLevel(this.thinking(session.model));
      if (this.cancelled) return this.endTurn({ status: "cancelled" });
      this.running = true;
      for (const [id, steer] of this.steers) {
        if (steer.state === "queued" && id !== opts?.adopt) void session.steer(steer.text, undefined, { source: "rpc" }).catch(() => undefined);
      }
      await session.prompt(prompt, {
        ...(images.length ? { images: images.map((image): ImageContent => ({ type: "image", data: image.data, mimeType: image.mimeType })) } : {}),
        source: "rpc",
      });
      if (this.cancelled) return this.endTurn({ status: "cancelled" });
      const last = [...session.messages].reverse().find((m) => m.role === "assistant") as AssistantMessage | undefined;
      if (last?.stopReason === "aborted") return this.endTurn({ status: "cancelled" });
      if (last?.stopReason === "error") return this.endTurn({ status: "error", error: last.errorMessage || "Pi: the model failed" });
      return this.endTurn({ status: "done" });
    } catch (err) {
      if (this.cancelled) return this.endTurn({ status: "cancelled" });
      return this.endTurn({ status: "error", error: (err as Error).message || String(err) });
    } finally {
      this.running = false;
      this.sink = null;
      this.armIdle();
    }
  }

  /** A steered message the turn did not take in runs as its own turn next; the host adopts it. */
  private endTurn(result: TurnResult): TurnResult {
    this.session?.clearQueue();
    for (const [id, steer] of this.steers) {
      if (steer.state !== "queued") this.steers.delete(id);
    }
    const waiting = [...this.steers.keys()][0];
    if (waiting) {
      this.carry = waiting;
      return { ...result, next: waiting };
    }
    return result;
  }

  private onEvent(event: AgentSessionEvent): void {
    const sink = this.sink;
    if (!sink) return;
    switch (event.type) {
      case "message_start": {
        const message = event.message as { role?: string; content?: unknown };
        if (message.role === "user") {
          // A steered message reached the model.
          const said = textOf(message.content);
          const hit = [...this.steers].find(([, s]) => s.state === "queued" && s.text === said);
          if (hit) {
            hit[1].state = "delivered";
            sink.steered?.(hit[0]);
          }
        }
        if (message.role === "assistant") this.lastBlock = null;
        return;
      }
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta" || e.type === "thinking_delta") {
          if (this.lastBlock !== null && this.lastBlock !== e.contentIndex) sink.breakBlock();
          this.lastBlock = e.contentIndex;
          if (e.type === "text_delta") sink.text(e.delta);
          else sink.reasoning(e.delta);
        }
        return;
      }
      case "message_end": {
        const message = event.message as AssistantMessage;
        if (message.role !== "assistant" || !message.usage) return;
        const u = message.usage;
        const prev = this.usage;
        this.usage = {
          inputTokens: (prev.inputTokens ?? 0) + u.input,
          outputTokens: (prev.outputTokens ?? 0) + u.output,
          cacheReadTokens: (prev.cacheReadTokens ?? 0) + u.cacheRead,
          cacheWriteTokens: (prev.cacheWriteTokens ?? 0) + u.cacheWrite,
          ...(u.reasoning !== undefined ? { reasoningTokens: (prev.reasoningTokens ?? 0) + u.reasoning } : {}),
          ...(u.cost?.total ? { costUsd: (prev.costUsd ?? 0) + u.cost.total } : {}),
        };
        const context = this.session?.getContextUsage();
        sink.usage({ ...this.usage, ...(context?.tokens != null ? { contextTokens: context.tokens } : {}), ...(context ? { contextWindow: context.contextWindow } : {}) });
        return;
      }
      case "tool_execution_start": {
        if (event.toolName === "todo_write" || event.toolName === "ask_user" || event.toolName === "exit_plan") return;
        sink.breakBlock();
        this.lastBlock = null;
        const args = isPlainRecord(event.args) ? event.args : {};
        const filePath = str(args.path);
        sink.toolStart({
          toolId: event.toolCallId,
          name: event.toolName,
          tool: toolKind(event.toolName),
          title: this.toolTitle(event.toolName, args),
          ...(event.toolName === "bash" || event.toolName === "powershell" ? { detail: str(args.command) } : {}),
          input: args,
          ...(filePath ? { paths: [path.resolve(this.cwd(), filePath)] } : {}),
          ...(event.parentToolCallId ? { parentToolId: event.parentToolCallId } : {}),
          status: "running",
        });
        return;
      }
      case "tool_execution_update": {
        if (event.toolName !== "bash" && event.toolName !== "powershell") return;
        const partial = textOf(isPlainRecord(event.partialResult) ? event.partialResult.content : undefined);
        if (partial) sink.toolUpdate(event.toolCallId, { output: partial });
        return;
      }
      case "tool_execution_end": {
        if (event.toolName === "todo_write" || event.toolName === "ask_user" || event.toolName === "exit_plan") return;
        const result = isPlainRecord(event.result) ? event.result : {};
        // Reads, edits and writes: the file and the host's diff say it better than the tool's echo.
        const quiet = !event.isError && (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write");
        const output = quiet ? undefined : textOf(result.content);
        sink.toolUpdate(event.toolCallId, { status: event.isError ? "error" : "done", ...(output ? { output } : {}) });
        return;
      }
      case "compaction_end":
        if (!event.aborted && event.result) sink.notice("info", "Pi summarized the conversation to make room.");
        else if (event.errorMessage) sink.notice("warn", `Pi could not summarize the conversation: ${event.errorMessage}`);
        return;
      case "auto_retry_start":
        sink.notice("info", `The model failed (${event.errorMessage}); retrying (${event.attempt}/${event.maxAttempts}).`);
        return;
      default:
        return;
    }
  }

  private toolTitle(name: string, args: Record<string, unknown>): string {
    const rel = (p: unknown) => (typeof p === "string" ? path.relative(this.cwd(), path.resolve(this.cwd(), p)) || p : "");
    switch (name) {
      case "bash":
        return "Shell";
      case "powershell":
        return "PowerShell";
      case "read":
        return `Read ${rel(args.path)}`;
      case "edit":
        return `Edit ${rel(args.path)}`;
      case "write":
        return `Write ${rel(args.path)}`;
      case "ls":
        return `List ${rel(args.path) || "."}`;
      case "grep":
        return `Grep ${str(args.pattern) ?? ""}`.trim();
      case "find":
        return `Find ${str(args.pattern) ?? ""}`.trim();
      case "web_fetch":
        return `Fetch ${str(args.url) ?? ""}`.trim();
      default:
        return `Scribe: ${name}`;
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.session?.abort().catch(() => undefined);
  }

  private stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.running) return;
    this.closeSession();
    this.board?.close();
    this.board = null;
  }

  dispose(): void {
    void this.cancel();
    this.steers.clear();
    this.carry = null;
    this.running = false;
    this.stop();
    this.onDispose();
  }
}
