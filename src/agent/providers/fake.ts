import fs from "node:fs";
import path from "node:path";
import type { ActionCaller, ThreadRunInfo } from "../../actions/types.js";
import { git } from "../git.js";
import type { ModelOption, ProviderId, ProviderStatus, SlashCommand, Thread } from "../types.js";
import type { AgentProvider, ProviderSession, RunSink, TurnInput, TurnResult } from "./provider.js";

/**
 * Fake agents for testing board workers end to end (SCRIBE_FAKE_AGENTS=1). Every provider's
 * threads get a session that runs no model, tools or MCP: a turn waits a while and ends. When the
 * message is a board worker's prompt, it claims its card, waits, and finishes it through the
 * action layer, so the board sees real thread status changes, claims and hand-ins.
 *
 * Directives in the message (a card title works, since the worker prompt quotes it) change a turn:
 * [fake:delay=5000] waits that long, [fake:error] ends the turn with an error, [fake:hang] runs
 * until cancelled, [fake:nofinish] leaves the card claimed, [fake:commit] commits a file in the
 * thread's worktree (never outside one), so the board has a branch to merge. [fake:stream] (or
 * stream=N steps, default 12) streams thinking, tool calls and text first, to try the transcript's motion.
 */

export const FAKE_AGENTS = process.env.SCRIBE_FAKE_AGENTS === "1";

const DEFAULT_DELAY_MS = 2000;

export type FakePlan = {
  delayMs: number;
  error: boolean;
  hang: boolean;
  finish: boolean;
  commit: boolean;
  /** Steps of streamed thinking, tools and text before the wait; 0 for none. */
  stream: number;
  /** The board page and card, when the message is a board worker's prompt. */
  board: { page: string; card: number } | null;
};

/** What a fake turn does with this message. */
export function fakePlan(text: string, defaultDelayMs = DEFAULT_DELAY_MS): FakePlan {
  const flags = new Set<string>();
  let delayMs = defaultDelayMs;
  let stream = 0;
  for (const match of text.matchAll(/\[fake:([^\]]*)\]/gi)) {
    for (const part of match[1].split(/[\s,]+/)) {
      const [name, value] = part.toLowerCase().split("=");
      if (name === "delay" && value && Number.isFinite(Number(value))) delayMs = Math.max(0, Number(value));
      else if (name === "stream") stream = value && Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 12;
      else if (name) flags.add(name);
    }
  }
  const page = /Scribe page id (t_[a-z0-9]+)/i.exec(text)?.[1];
  const card = /Your card: #(\d+)/.exec(text)?.[1];
  return {
    delayMs,
    error: flags.has("error"),
    hang: flags.has("hang"),
    finish: !flags.has("nofinish"),
    commit: flags.has("commit"),
    stream,
    board: page && card ? { page, card: Number(card) } : null,
  };
}

export type FakeDeps = {
  runAction(page: string, name: string, args: Record<string, unknown>, caller: ActionCaller): unknown;
  runInfo(threadId: string): ThreadRunInfo;
  /** Turn delay when the message names none. */
  delayMs?: number;
};

export class FakeProvider implements AgentProvider {
  readonly label: string;

  constructor(
    readonly id: ProviderId,
    label: string,
    private deps: FakeDeps
  ) {
    this.label = label;
  }

  async status(): Promise<ProviderStatus> {
    return { id: this.id, label: this.label, available: true, detail: "Fake agents (SCRIBE_FAKE_AGENTS=1)" };
  }

  /** None: the host falls back to the models it cached, so the pickers still show real names. */
  async models(): Promise<ModelOption[]> {
    return [];
  }

  async complete(prompt: string): Promise<string> {
    return `Fake summary of ${prompt.length} characters.`;
  }

  createSession(thread: Thread): ProviderSession {
    return new FakeSession(thread, this.deps);
  }

  prewarm(): void {}

  dispose(): void {}
}

class FakeSession implements ProviderSession {
  private abort: AbortController | null = null;
  private turns = 0;

  constructor(
    private thread: Thread,
    private deps: FakeDeps
  ) {}

  async warm(): Promise<void> {}

  async run(input: TurnInput, sink: RunSink): Promise<TurnResult> {
    const abort = new AbortController();
    this.abort = abort;
    this.turns += 1;
    const plan = fakePlan(input.text, this.deps.delayMs);
    sink.nativeId(`fake-${this.thread.id}`);
    try {
      sink.text(`Fake agent, turn ${this.turns}.`);
      if (plan.board) this.act(sink, "claim", { card: plan.board.card, text: "Fake agent working" }, plan.board.page);
      if (plan.stream) await this.stream(sink, plan.stream, abort.signal);
      if (plan.hang) await wait(abort.signal);
      else await wait(abort.signal, plan.delayMs);
      if (plan.error) return { status: "error", error: "Fake agent error ([fake:error])" };
      if (plan.commit) await this.commit(sink);
      if (plan.board && plan.finish) this.act(sink, "finish", { card: plan.board.card, summary: "Fake agent: done." }, plan.board.page);
      sink.breakBlock();
      sink.text("Done.");
      return { status: "done" };
    } catch (err) {
      if (abort.signal.aborted) return { status: "cancelled" };
      return { status: "error", error: (err as Error).message };
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  /** A board action as this thread, shown as a tool call so the transcript reads like a real run. */
  private act(sink: RunSink, name: string, args: Record<string, unknown>, page: string): void {
    const toolId = `fake-${name}-${Date.now().toString(36)}`;
    sink.toolStart({ toolId, name: "page_action", tool: "mcp", title: `Board: ${name} #${args.card}`, input: { id: page, action: name, args }, status: "running" });
    const caller: ActionCaller = { by: "agent", label: `Scribe chat: ${this.thread.title}`, provider: this.thread.provider, thread: this.thread.id };
    try {
      const result = this.deps.runAction(page, name, args, caller);
      sink.toolUpdate(toolId, { status: "done", output: JSON.stringify(result ?? null) });
    } catch (err) {
      sink.toolUpdate(toolId, { status: "error", output: (err as Error).message });
    }
  }

  /** Thinking, a few tool calls and a streamed paragraph, step by step, like a real run's transcript. */
  private async stream(sink: RunSink, steps: number, signal: AbortSignal): Promise<void> {
    const words = async (text: string, put: (delta: string) => void) => {
      for (const word of text.split(" ")) {
        put(`${word} `);
        await wait(signal, 45);
      }
      sink.breakBlock();
    };
    for (let i = 0; i < steps; i++) {
      const kind = i % 5;
      if (kind === 0) {
        sink.breakBlock();
        await words("Looking at what this step needs and which files it touches before going on.", (d) => sink.reasoning(d));
      } else if (kind === 4) {
        await words(
          `Step ${i + 1}: the change reads the new rows, keeps the queued messages where they are, and glides the view down to the latest line without a jump.`,
          (d) => sink.text(d)
        );
      } else {
        const toolId = `fake-tool-${i}-${Date.now().toString(36)}`;
        const run = kind === 3;
        sink.toolStart({
          toolId,
          name: run ? "Bash" : "Read",
          tool: run ? "execute" : "read",
          title: run ? `npm test (step ${i + 1})` : `Read src/fake/step${i + 1}.ts`,
          input: run ? { command: "npm test" } : { path: `src/fake/step${i + 1}.ts` },
          status: "running",
        });
        await wait(signal, 300);
        sink.toolUpdate(toolId, { status: "done", output: run ? "ok" : `// step ${i + 1}` });
      }
      await wait(signal, 350);
    }
  }

  /** Commit a file in the thread's own worktree. Never anywhere else: a fake must not touch a real checkout. */
  private async commit(sink: RunSink): Promise<void> {
    const tree = this.thread.worktree && !this.thread.worktree.closed ? this.thread.worktree.path : null;
    if (!tree) {
      sink.notice("warn", "[fake:commit] needs a worktree thread; nothing committed.");
      return;
    }
    const rel = `.fake-agent/${this.thread.id}-${this.turns}.txt`;
    fs.mkdirSync(path.join(tree, ".fake-agent"), { recursive: true });
    fs.writeFileSync(path.join(tree, rel), `Fake agent turn ${this.turns} of ${this.thread.id}\n`);
    const env = { GIT_AUTHOR_NAME: "Fake agent", GIT_AUTHOR_EMAIL: "fake@scribe.local", GIT_COMMITTER_NAME: "Fake agent", GIT_COMMITTER_EMAIL: "fake@scribe.local" };
    const add = await git(["add", "--", rel], tree);
    const res = add.code === 0 ? await git(["commit", "--no-verify", "-m", `Fake agent: ${rel}`, "--", rel], tree, { env }) : add;
    if (res.code !== 0) sink.notice("warn", `[fake:commit] failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }

  async cancel(): Promise<void> {
    this.abort?.abort();
  }

  update(thread: Thread): void {
    this.thread = thread;
  }

  async commands(): Promise<SlashCommand[]> {
    return [];
  }

  dispose(): void {
    this.abort?.abort();
  }
}

/** Resolves after ms (or never, without ms); rejects when the signal aborts. */
function wait(signal: AbortSignal, ms?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const timer = ms === undefined ? null : setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        if (timer) clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true }
    );
  });
}
