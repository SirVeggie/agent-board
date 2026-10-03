import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dataDir } from "../../config.js";
import { log } from "../../log.js";
import { authHeaders, fetchModelIds, splitModelId, type OpenAISource } from "../openaiSources.js";
import { isPlainRecord, type ModelOption, type ProviderStatus, type SlashCommand, type Thread } from "../types.js";
import type { AgentProvider, ProviderSession, RunSink, SessionContext, TurnInput, TurnResult } from "./provider.js";

/**
 * Any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, LM Studio, Ollama, vLLM, …).
 * No files or shell: the model gets Scribe's own page tools, through the board MCP server the
 * daemon runs for every thread. The conversation is kept in a JSON file per session, since these
 * endpoints keep no state of their own.
 */

const MODELS_TTL_MS = 10 * 60 * 1000;
/** Model calls in one turn, tool rounds included, before the turn stops with a notice. */
const MAX_STEPS = 40;
/** Tool output kept for the model, in characters. */
const MAX_TOOL_OUTPUT = 60_000;
const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

type ChatMessage =
  | { role: "system" | "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type FunctionTool = { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } };
type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } };

function historyDir(): string {
  return path.join(dataDir(), "agent", "openai");
}

function historyPath(id: string): string {
  return path.join(historyDir(), `${id.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
}

export class OpenAIProvider implements AgentProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI-compatible";
  private modelCache: { at: number; models: ModelOption[] } | null = null;
  private modelLoad: Promise<ModelOption[]> | null = null;
  private sessions = new Set<OpenAISession>();

  constructor(private sources: () => OpenAISource[]) {}

  source(id: string): OpenAISource | undefined {
    return this.sources().find((s) => s.id === id);
  }

  async status(): Promise<ProviderStatus> {
    const n = this.sources().length;
    if (!n) return { id: this.id, label: this.label, available: false, detail: "Add an endpoint in Chat settings → Model sources." };
    return { id: this.id, label: this.label, available: true, detail: n === 1 ? "1 source" : `${n} sources` };
  }

  /** The sources changed: list models again on the next ask. */
  invalidate(): void {
    this.modelCache = null;
  }

  models(refresh = false): Promise<ModelOption[]> {
    if (!refresh && this.modelCache && Date.now() - this.modelCache.at < MODELS_TTL_MS) return Promise.resolve(this.modelCache.models);
    if (this.modelLoad) return this.modelLoad;
    this.modelLoad = this.loadModels().finally(() => {
      this.modelLoad = null;
    });
    return this.modelLoad;
  }

  private async loadModels(): Promise<ModelOption[]> {
    const lists = await Promise.all(
      this.sources().map(async (source) => {
        let ids = source.models;
        if (!ids.length) {
          try {
            ids = await fetchModelIds(source);
          } catch (err) {
            log(`OpenAI-compatible model list failed: ${(err as Error).message}`);
            ids = [];
          }
        }
        return ids.map(
          (id): ModelOption => ({
            id: `${source.id}/${id}`,
            label: id,
            provider: "openai",
            description: source.name,
            efforts: source.reasoning ? EFFORTS : [],
            defaultEffort: null,
            params: [],
          })
        );
      })
    );
    const models = lists.flat();
    this.modelCache = { at: Date.now(), models };
    return models;
  }

  /** "default" is the first model of the first source. */
  async resolveModel(id: string): Promise<{ source: OpenAISource; model: string } | null> {
    if (id && id !== "default") {
      const parts = splitModelId(id);
      const source = parts ? this.source(parts.source) : undefined;
      return source && parts ? { source, model: parts.model } : null;
    }
    const first = (await this.models())[0];
    return first ? this.resolveModel(first.id) : null;
  }

  async complete(prompt: string, model: string, signal?: AbortSignal): Promise<string> {
    const target = await this.resolveModel(model);
    if (!target) throw new Error(`Unknown model: ${model}`);
    const res = await fetch(`${target.source.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(target.source) },
      body: JSON.stringify({ model: target.model, messages: [{ role: "user", content: prompt }] }),
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${target.source.name}: ${res.status} ${errorMessage(text) || res.statusText}`);
    const body = JSON.parse(text) as unknown;
    const choice = isPlainRecord(body) && Array.isArray(body.choices) && isPlainRecord(body.choices[0]) ? body.choices[0] : null;
    const content = choice && isPlainRecord(choice.message) ? choice.message.content : null;
    if (typeof content !== "string") throw new Error(`${target.source.name} sent no answer`);
    return content;
  }

  createSession(thread: Thread, ctx: SessionContext): ProviderSession {
    const session = new OpenAISession(this, thread, ctx, () => this.sessions.delete(session));
    this.sessions.add(session);
    return session;
  }

  prewarm(): void {
    // Nothing slow to start ahead of time: the MCP server starts with the first turn.
  }

  dispose(): void {
    for (const session of [...this.sessions]) session.dispose();
  }
}

class OpenAISession implements ProviderSession {
  private history: ChatMessage[] | null = null;
  private historyId: string | null;
  private mcp: Client | null = null;
  private mcpLoad: Promise<Client> | null = null;
  private tools: McpTool[] = [];
  private abort: AbortController | null = null;

  constructor(
    private provider: OpenAIProvider,
    private thread: Thread,
    private ctx: SessionContext,
    private onDispose: () => void
  ) {
    this.historyId = thread.nativeId;
  }

  async warm(): Promise<void> {
    try {
      await this.client();
    } catch (err) {
      log(`OpenAI-compatible: board tools failed to start: ${(err as Error).message}`);
    }
  }

  update(thread: Thread): void {
    if (thread.nativeId !== this.thread.nativeId && thread.nativeId !== this.historyId) {
      // A rewind cleared the session: the next turn starts a new conversation.
      this.history = null;
      this.historyId = thread.nativeId;
    }
    this.thread = thread;
  }

  async commands(): Promise<SlashCommand[]> {
    return [];
  }

  async cancel(): Promise<void> {
    this.abort?.abort();
  }

  dispose(): void {
    this.abort?.abort();
    void this.mcp?.close().catch(() => undefined);
    this.mcp = null;
    this.mcpLoad = null;
    this.onDispose();
  }

  private client(): Promise<Client> {
    if (this.mcp) return Promise.resolve(this.mcp);
    if (!this.mcpLoad) {
      this.mcpLoad = (async () => {
        const { command, args, env } = this.ctx.boardMcp;
        const transport = new StdioClientTransport({
          command,
          args,
          env: { ...(process.env as Record<string, string>), ...env, SCRIBE_THREAD: this.thread.id },
          stderr: "ignore",
        });
        const client = new Client({ name: "scribe-openai", version: "1.0.0" });
        await client.connect(transport);
        const listed = await client.listTools();
        this.tools = listed.tools as McpTool[];
        this.mcp = client;
        return client;
      })().catch((err) => {
        this.mcpLoad = null;
        throw err;
      });
    }
    return this.mcpLoad;
  }

  /** Page tools for this thread's mode: Ask gets the read-only ones. Chat threads don't wait on pages. */
  private functionTools(): FunctionTool[] {
    const readOnly = this.thread.mode === "ask";
    return this.tools
      .filter((t) => t.name !== "page_wait" && (!readOnly || t.annotations?.readOnlyHint === true))
      .map((t) => ({
        type: "function",
        function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.inputSchema ?? { type: "object", properties: {} } },
      }));
  }

  private loadHistory(): ChatMessage[] {
    if (this.history) return this.history;
    this.history = [];
    if (this.historyId) {
      try {
        const parsed = JSON.parse(fs.readFileSync(historyPath(this.historyId), "utf8")) as unknown;
        if (Array.isArray(parsed)) this.history = parsed as ChatMessage[];
      } catch {
        // A missing or broken file starts the conversation over.
      }
    }
    return this.history;
  }

  private saveHistory(): void {
    if (!this.historyId || !this.history) return;
    try {
      fs.mkdirSync(historyDir(), { recursive: true });
      fs.writeFileSync(historyPath(this.historyId), JSON.stringify(this.history));
    } catch (err) {
      log(`OpenAI-compatible: could not save the conversation: ${(err as Error).message}`);
    }
  }

  async run(input: TurnInput, sink: RunSink): Promise<TurnResult> {
    const target = await this.provider.resolveModel(this.thread.model);
    if (!target) return { status: "error", error: "No OpenAI-compatible model: add a source in Chat settings → Model sources, or pick a model." };
    if (!this.historyId) {
      this.historyId = `oa_${randomBytes(8).toString("hex")}`;
      this.history = [];
    }
    sink.nativeId(this.historyId);
    if (this.thread.mode === "code" || this.thread.mode === "plan") {
      sink.notice("info", "OpenAI-compatible models have no file or shell tools here; this turn runs with Scribe's page tools only.");
    }
    try {
      await this.client();
    } catch (err) {
      sink.notice("warn", `Scribe's page tools did not start (${(err as Error).message}); answering without them.`);
    }

    const history = this.loadHistory();
    const content: ContentPart[] = [{ type: "text", text: input.text }];
    for (const image of input.images) content.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
    history.push({ role: "user", content: content.length === 1 ? input.text : content });
    this.saveHistory();

    const abort = new AbortController();
    this.abort = abort;
    try {
      for (let step = 0; step < MAX_STEPS; step += 1) {
        const reply = await this.complete(target, [{ role: "system", content: input.instructions }, ...history], sink, abort.signal);
        history.push({ role: "assistant", content: reply.content || null, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}) });
        this.saveHistory();
        if (!reply.toolCalls.length) return { status: "done" };
        for (const call of reply.toolCalls) {
          if (abort.signal.aborted) break;
          history.push({ role: "tool", tool_call_id: call.id, content: await this.callTool(call, sink) });
          this.saveHistory();
        }
        if (abort.signal.aborted) return { status: "cancelled" };
        sink.breakBlock();
      }
      sink.notice("warn", `Stopped after ${MAX_STEPS} model calls in one turn. Send a message to let it go on.`);
      return { status: "done" };
    } catch (err) {
      if (abort.signal.aborted) return { status: "cancelled" };
      return { status: "error", error: (err as Error).message };
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  /** One streamed completion: text and reasoning go to the sink as they come, tool calls are collected. */
  private async complete(
    target: { source: OpenAISource; model: string },
    messages: ChatMessage[],
    sink: RunSink,
    signal: AbortSignal
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const tools = this.functionTools();
    const body: Record<string, unknown> = {
      model: target.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length ? { tools } : {}),
      ...(this.thread.effort ? { reasoning_effort: this.thread.effort } : {}),
    };
    let res = await this.post(target.source, body, signal);
    if (res.status === 400 && body.stream_options) {
      // Some servers refuse options they don't know; try once without the extras.
      delete body.stream_options;
      delete body.reasoning_effort;
      res = await this.post(target.source, body, signal);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`${target.source.name}: ${res.status} ${errorMessage(text) || res.statusText}`);
    }

    let content = "";
    const calls: Array<{ id: string; name: string; args: string }> = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (!isPlainRecord(chunk)) continue;
        if (isPlainRecord(chunk.error)) throw new Error(`${target.source.name}: ${String(chunk.error.message ?? "error")}`);
        if (isPlainRecord(chunk.usage)) {
          const u = chunk.usage;
          const input = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
          const output = typeof u.completion_tokens === "number" ? u.completion_tokens : undefined;
          const details = isPlainRecord(u.completion_tokens_details) ? u.completion_tokens_details : {};
          sink.usage({
            inputTokens: input,
            outputTokens: output,
            contextTokens: input !== undefined && output !== undefined ? input + output : undefined,
            reasoningTokens: typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : undefined,
          });
        }
        const choice = Array.isArray(chunk.choices) && isPlainRecord(chunk.choices[0]) ? chunk.choices[0] : null;
        const delta = choice && isPlainRecord(choice.delta) ? choice.delta : null;
        if (!delta) continue;
        // Reasoning models on DeepSeek, Qwen, OpenRouter and others stream their thinking beside the answer.
        const thinking = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
        if (thinking) sink.reasoning(thinking);
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          sink.text(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const raw of delta.tool_calls) {
            if (!isPlainRecord(raw)) continue;
            const index = typeof raw.index === "number" ? raw.index : calls.length;
            const call = (calls[index] ??= { id: "", name: "", args: "" });
            if (typeof raw.id === "string" && raw.id) call.id = raw.id;
            const fn = isPlainRecord(raw.function) ? raw.function : {};
            if (typeof fn.name === "string") call.name += fn.name;
            if (typeof fn.arguments === "string") call.args += fn.arguments;
          }
        }
      }
    }
    const toolCalls = calls
      .filter((c) => c && c.name)
      .map((c, i): ToolCall => ({ id: c.id || `call_${Date.now().toString(36)}_${i}`, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
    return { content, toolCalls };
  }

  private post(source: OpenAISource, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    return fetch(`${source.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...authHeaders(source) },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** Run one tool call on the board MCP server; the result text goes back to the model. */
  private async callTool(call: ToolCall, sink: RunSink): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(call.function.arguments || "{}") as unknown;
      if (isPlainRecord(parsed)) args = parsed;
    } catch {
      sink.toolStart({ toolId: call.id, name: call.function.name, tool: "mcp", title: `Scribe: ${call.function.name}`, status: "error" });
      sink.toolUpdate(call.id, { status: "error", output: "The arguments were not valid JSON." });
      return "Error: the tool arguments were not valid JSON. Send them as a JSON object.";
    }
    sink.toolStart({ toolId: call.id, name: call.function.name, tool: "mcp", title: `Scribe: ${call.function.name}`, input: args, status: "running" });
    const known = this.tools.some((t) => t.name === call.function.name) && this.functionTools().some((t) => t.function.name === call.function.name);
    if (!known || !this.mcp) {
      const msg = `Error: there is no tool named ${call.function.name} in this thread.`;
      sink.toolUpdate(call.id, { status: "error", output: msg });
      return msg;
    }
    const approval = await sink.approval({
      boardTool: true,
      toolId: call.id,
      tool: "mcp",
      title: `Scribe: ${call.function.name}`,
      options: [
        { id: "allow", label: "Allow", kind: "allow_once" },
        { id: "reject", label: "Reject", kind: "reject_once" },
      ],
    });
    if (approval.optionId !== "allow") {
      const msg = `The user declined this tool call${approval.note ? `: ${approval.note}` : "."}`;
      sink.toolUpdate(call.id, { status: "error", output: msg });
      return msg;
    }
    try {
      const result = await this.mcp.callTool({ name: call.function.name, arguments: args });
      const parts = Array.isArray(result.content) ? result.content : [];
      let text = parts
        .map((p) => (isPlainRecord(p) && p.type === "text" && typeof p.text === "string" ? p.text : isPlainRecord(p) && p.type === "image" ? "[image]" : ""))
        .filter(Boolean)
        .join("\n");
      if (text.length > MAX_TOOL_OUTPUT) text = `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (cut at ${MAX_TOOL_OUTPUT} characters)`;
      sink.toolUpdate(call.id, { status: result.isError ? "error" : "done", output: text });
      return text || "(no output)";
    } catch (err) {
      const msg = `Error: ${(err as Error).message}`;
      sink.toolUpdate(call.id, { status: "error", output: msg });
      return msg;
    }
  }
}

function errorMessage(text: string): string {
  try {
    const body = JSON.parse(text) as unknown;
    if (isPlainRecord(body) && isPlainRecord(body.error) && typeof body.error.message === "string") return body.error.message;
    if (isPlainRecord(body) && typeof body.message === "string") return body.message;
  } catch {
    // Not JSON.
  }
  return text.slice(0, 300);
}
