import type { DecideOptions, DecideResult, MlAnswers, MlQuestions, SendKind } from "../ml/types.js";
import type { ProviderId, ThreadMode, ToolKind } from "./types.js";

/**
 * Thread hooks (docs/intent-detection-hooks-design.md): a detector plus actions, run by the agent
 * host at fixed points of a turn, the same for every provider. The host's transcript items are the
 * chunks. A detection may only tighten (ask, block, flag); nothing here grants anything.
 */

export const HOOK_EVENTS = ["prompt", "text", "reasoning", "tool_call", "tool_result", "turn_end"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_ACTIONS = ["signal", "flag", "context", "ask", "block"] as const;
export type HookActionKind = (typeof HOOK_ACTIONS)[number];

/** How long a held tool call waits for the classifier before it goes ahead (fail open). */
export const GATE_BUDGET_MS = 500;
/** An observing hook's classifier answer is dropped when it takes longer than this. */
export const OBSERVE_DEADLINE_MS = 10_000;
/** The hook's ML feature switch (Settings, Classifier). */
export const HOOKS_FEATURE = "hooks";

const MAX_CHUNK_TEXT = 20_000;
const MAX_RULES = 100;

export type Chunk = {
  event: HookEvent;
  threadId: string;
  turnId: string | null;
  /** The transcript item the chunk is, when there is one (a flag lands on it). */
  itemId?: string;
  /** What detectors match: the message, the block's text, or the call's name, title, detail and input. */
  text: string;
  tool?: { toolId?: string; name: string; kind: ToolKind; title?: string; paths?: string[]; input?: unknown };
  /** A text block's opening, before the block has closed. Only detectors with `early` see it. */
  early?: boolean;
  provider: ProviderId;
  mode: ThreadMode;
  /** An unattended board worker's thread. */
  worker: boolean;
  /** The user's last message, as context for classifier questions. */
  lastUser?: string;
  /** The turn's message was sent from the floating chat over a page. */
  dock?: boolean;
  /** The title of the page the thread belongs to, as context for classifier questions. */
  page?: string;
  /** The thread's workspace folder, when it has one. */
  cwd?: string;
};

export type Action =
  /** Tell the UI (the agent_intent event); the agent is unaffected. */
  | { kind: "signal"; name: string; stage?: string; title?: string }
  /** A badge on the transcript item. */
  | { kind: "flag"; label?: string }
  /** Tell the agent, by steering the text into the running turn. */
  | { kind: "context"; text: string }
  /** The tool call needs the user's approval, whatever the thread's approval level. */
  | { kind: "ask" }
  /** Deny the tool call, or stop the turn where the call cannot be held. */
  | { kind: "block"; reason: string };

export type Hit = { actions: Action[]; reason?: string; confidence?: number };

export type Detector = {
  id: string;
  /** Shown on flags and in notices. */
  label?: string;
  on: readonly HookEvent[];
  /** Also runs on a text block's opening (see Chunk.early). */
  early?: boolean;
  /** Only ever signals or flags, so no tool call is held for it. */
  observing?: boolean;
  where?: { worker?: boolean; dock?: boolean; modes?: ThreadMode[]; providers?: ProviderId[] };
  /** The Classifier feature switch its questions go under (Settings, Classifier). Default: Hook questions. */
  feature?: string;
  /** Synchronous: keyword, regex, tool name. A Hit or "pass" settles it; null leaves it to `ask`. */
  rule?: (chunk: Chunk) => Hit | "pass" | null;
  /** Questions for the decision service, asked only when the rule did not settle it. */
  ask?: (chunk: Chunk) => MlQuestions | null;
  /** Thresholds live here, in code. */
  decide?: (answers: MlAnswers, chunk: Chunk) => Hit | null;
};

/** One action a detector asked for on a chunk. */
export type Finding = { detector: string; label: string; action: Action; reason?: string; confidence?: number };

export type HookDecide = (state: unknown, questions: MlQuestions, options: DecideOptions) => Promise<DecideResult>;

export type HookDeps = {
  /** Read on every chunk, so a settings change applies at once. */
  detectors(): Detector[];
  /** The decision service; without it only rules run. */
  decide?: HookDecide;
  /** Whether this kind of thread content may go to the classifier ("what may be sent"). */
  maySend?(kind: SendKind): boolean;
  log?(message: string): void;
};

const SEND_KIND: Record<HookEvent, SendKind> = {
  prompt: "messages",
  text: "agentText",
  reasoning: "agentText",
  turn_end: "agentText",
  tool_call: "toolCalls",
  tool_result: "toolResults",
};

function applies(detector: Detector, chunk: Chunk): boolean {
  if (!detector.on.includes(chunk.event)) return false;
  if (chunk.early && !detector.early) return false;
  const where = detector.where;
  if (!where) return true;
  if (where.worker !== undefined && where.worker !== chunk.worker) return false;
  if (where.dock !== undefined && where.dock !== Boolean(chunk.dock)) return false;
  if (where.modes && !where.modes.includes(chunk.mode)) return false;
  if (where.providers && !where.providers.includes(chunk.provider)) return false;
  return true;
}

function findings(detector: Detector, hit: Hit): Finding[] {
  return hit.actions.map((action) => ({
    detector: detector.id,
    label: detector.label ?? detector.id,
    action,
    ...(hit.reason ? { reason: hit.reason } : {}),
    ...(hit.confidence !== undefined ? { confidence: hit.confidence } : {}),
  }));
}

export function isGating(finding: Finding): boolean {
  return finding.action.kind === "ask" || finding.action.kind === "block";
}

/** The strongest gating outcome among the findings: block over ask. */
export function verdict(found: Finding[]): { kind: "block"; finding: Finding } | { kind: "ask"; finding: Finding } | null {
  const block = found.find((f) => f.action.kind === "block");
  if (block) return { kind: "block", finding: block };
  const ask = found.find((f) => f.action.kind === "ask");
  return ask ? { kind: "ask", finding: ask } : null;
}

export class HookPipeline {
  constructor(private deps: HookDeps) {}

  /** True when no detector could match this event, so the host can skip building a chunk. `gating`: none that could hold a call. */
  idle(event: HookEvent, gating = false): boolean {
    return !this.deps.detectors().some((d) => d.on.includes(event) && !(gating && d.observing));
  }

  /** True when some detector wants a text block's opening (Chunk.early). */
  early(): boolean {
    return this.deps.detectors().some((d) => d.early && d.on.includes("text"));
  }

  /**
   * The synchronous half: every matching detector's rule. `open` are the detectors whose rule did
   * not settle it and that have questions for the classifier.
   */
  rules(chunk: Chunk, gating = false): { found: Finding[]; open: Detector[] } {
    const found: Finding[] = [];
    const open: Detector[] = [];
    for (const detector of this.deps.detectors()) {
      if (!applies(detector, chunk) || (gating && detector.observing)) continue;
      let settled: Hit | "pass" | null = null;
      if (detector.rule) {
        try {
          settled = detector.rule(chunk);
        } catch (err) {
          this.deps.log?.(`Hook ${detector.id} failed: ${(err as Error).message}`);
        }
      }
      if (settled && settled !== "pass") found.push(...findings(detector, settled));
      else if (!settled && detector.ask && detector.decide) open.push(detector);
    }
    return { found, open };
  }

  /**
   * The asynchronous half: the open detectors' questions, one request per Classifier feature. Never
   * throws; a timeout, a switched-off service or a failing backend gives no findings (fail open).
   */
  async classify(chunk: Chunk, open: Detector[], budgetMs: number): Promise<Finding[]> {
    const kind = SEND_KIND[chunk.event];
    if (!this.deps.decide || !open.length || !chunk.text.trim() || this.deps.maySend?.(kind) === false) return [];
    const features = new Map<string, Detector[]>();
    for (const detector of open) {
      const feature = detector.feature ?? HOOKS_FEATURE;
      features.set(feature, [...(features.get(feature) ?? []), detector]);
    }
    const found = await Promise.all([...features].map(([feature, detectors]) => this.classifyFeature(chunk, feature, detectors, budgetMs)));
    return found.flat();
  }

  private async classifyFeature(chunk: Chunk, feature: string, open: Detector[], budgetMs: number): Promise<Finding[]> {
    const decide = this.deps.decide!;
    const kind = SEND_KIND[chunk.event];
    const questions: MlQuestions = {};
    const asked: Array<{ detector: Detector; prefix: string; ids: string[] }> = [];
    open.forEach((detector, index) => {
      let own: MlQuestions | null = null;
      try {
        own = detector.ask!(chunk);
      } catch (err) {
        this.deps.log?.(`Hook ${detector.id} failed: ${(err as Error).message}`);
      }
      if (!own || !Object.keys(own).length) return;
      const prefix = `d${index}.`;
      for (const [id, question] of Object.entries(own)) questions[prefix + id] = question;
      asked.push({ detector, prefix, ids: Object.keys(own) });
    });
    if (!asked.length) return [];
    const withUser = chunk.lastUser && chunk.event !== "prompt" && this.deps.maySend?.("messages") !== false;
    const state = {
      event: chunk.event,
      mode: chunk.mode,
      ...(chunk.tool ? { tool: chunk.tool.name } : {}),
      ...(chunk.page ? { openPage: chunk.page } : {}),
      content: chunk.text,
      ...(withUser ? { userMessage: chunk.lastUser!.slice(0, 4000) } : {}),
    };
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs);
    });
    let result: DecideResult | null = null;
    try {
      result = await Promise.race([decide(state, questions, { feature, sends: withUser ? [kind, "messages"] : [kind], timeoutMs: budgetMs }), late]);
    } catch (err) {
      this.deps.log?.(`Hook classifier call failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!result?.ok) return [];
    const found: Finding[] = [];
    for (const { detector, prefix, ids } of asked) {
      const answers: MlAnswers = {};
      for (const id of ids) {
        const answer = result.answers[prefix + id];
        if (answer) answers[id] = answer;
      }
      try {
        const hit = detector.decide!(answers, chunk);
        if (hit) found.push(...findings(detector, hit));
      } catch (err) {
        this.deps.log?.(`Hook ${detector.id} failed: ${(err as Error).message}`);
      }
    }
    return found;
  }

  /**
   * Rules, then the classifier within the budget: what a gate waits for. A rule that already blocks
   * settles the call, so the classifier is not asked. Observing detectors are left to the transcript's own hook.
   */
  async evaluate(chunk: Chunk, budgetMs = GATE_BUDGET_MS): Promise<Finding[]> {
    const { found, open } = this.rules(chunk, true);
    if (!open.length || found.some((f) => f.action.kind === "block")) return found;
    return [...found, ...(await this.classify(chunk, open, budgetMs))];
  }
}

/** The text of a tool call that detectors match: name, title, detail and the start of its input. */
export function toolCallText(tool: { name: string; title?: string; detail?: string; input?: unknown; paths?: string[] }): string {
  let input = "";
  if (tool.input !== undefined) {
    try {
      input = typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input);
    } catch {
      input = "";
    }
  }
  // A 200 KB html argument is not interesting past its start.
  if (input.length > 4000) input = `${input.slice(0, 4000)}…`;
  const parts = [tool.name, tool.title, tool.detail, tool.paths?.join("\n"), input].filter((part): part is string => Boolean(part));
  return clip([...new Set(parts)].join("\n"));
}

/** Long text for a detector: its head and tail. */
export function clip(text: string, max = MAX_CHUNK_TEXT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}

/** Where a text block's opening ends: its first sentence, or about 200 characters. Null while it is too short. */
export function earlyEnd(text: string): number | null {
  const sentence = /[.!?](\s|$)/.exec(text);
  if (sentence && sentence.index >= 20) return sentence.index + 1;
  return text.length >= 200 ? 200 : null;
}

// ---------- the user's keyword rules (Agent settings, Hooks) ----------

export const RULE_MATCHES = ["keyword", "regex", "tool", "question"] as const;
export type RuleMatch = (typeof RULE_MATCHES)[number];

export type HookRule = {
  id: string;
  enabled: boolean;
  /** keyword: the text contains it. regex: a pattern on the text. tool: the tool's name or title contains it. question: a yes/no question for the classifier. */
  match: RuleMatch;
  pattern: string;
  event: HookEvent | "any";
  action: HookActionKind;
  /** The signal's name, the flag's label, what the agent is told (context), or why (ask, block). */
  text?: string;
  /** question: how sure the classifier must be, 0.5 to 1. */
  threshold?: number;
};

export const DEFAULT_THRESHOLD = 0.7;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The rules as saved. Throws with a message for the settings form when one cannot work. */
export function normalizeRules(input: unknown): HookRule[] {
  if (!Array.isArray(input)) return [];
  const out: HookRule[] = [];
  const taken = new Set<string>();
  for (const raw of input.slice(0, MAX_RULES)) {
    if (!isRecord(raw)) continue;
    const pattern = typeof raw.pattern === "string" ? raw.pattern.trim().slice(0, 500) : "";
    if (!pattern) throw new Error("A hook rule needs a pattern.");
    const match = RULE_MATCHES.find((m) => m === raw.match) ?? "keyword";
    const action = HOOK_ACTIONS.find((a) => a === raw.action);
    if (!action) throw new Error(`"${pattern}": pick what the rule does.`);
    let event: HookRule["event"] = HOOK_EVENTS.find((e) => e === raw.event) ?? "any";
    if (match === "tool" && event !== "tool_call" && event !== "tool_result") event = "tool_call";
    if (match === "regex") {
      try {
        new RegExp(pattern, "i");
      } catch (err) {
        throw new Error(`"${pattern}" is not a valid regular expression: ${(err as Error).message}`);
      }
    }
    const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 1000) : "";
    if (action === "context" && !text) throw new Error(`"${pattern}": say what the agent should be told.`);
    let id = typeof raw.id === "string" && /^[a-z0-9_-]{1,40}$/i.test(raw.id) ? raw.id : "";
    for (let n = out.length + 1; !id || taken.has(id); n++) id = `rule-${n}`;
    taken.add(id);
    const threshold = typeof raw.threshold === "number" && Number.isFinite(raw.threshold) ? Math.min(1, Math.max(0.5, raw.threshold)) : undefined;
    out.push({
      id,
      enabled: raw.enabled !== false,
      match,
      pattern,
      event,
      action,
      ...(text ? { text } : {}),
      ...(match === "question" && threshold !== undefined ? { threshold } : {}),
    });
  }
  return out;
}

function ruleAction(rule: HookRule): Action {
  const what = rule.match === "question" ? rule.pattern : `"${rule.pattern}"`;
  switch (rule.action) {
    case "signal":
      return { kind: "signal", name: rule.text || rule.id };
    case "flag":
      return { kind: "flag", ...(rule.text ? { label: rule.text } : {}) };
    case "context":
      return { kind: "context", text: rule.text ?? "" };
    case "ask":
      return { kind: "ask" };
    case "block":
      return { kind: "block", reason: rule.text || `Blocked by the user's hook rule ${what}.` };
  }
}

/** One of the user's rules as a detector. */
export function ruleDetector(rule: HookRule): Detector {
  const on: readonly HookEvent[] = rule.event === "any" ? (rule.match === "tool" ? ["tool_call"] : HOOK_EVENTS) : [rule.event];
  const label = rule.text && rule.action === "flag" ? rule.text : rule.pattern.length > 40 ? `${rule.pattern.slice(0, 40)}…` : rule.pattern;
  const hit: Hit = { actions: [ruleAction(rule)], ...(rule.action === "ask" && rule.text ? { reason: rule.text } : {}) };
  const base = { id: `rule:${rule.id}`, label, on };
  if (rule.match === "question") {
    const threshold = rule.threshold ?? DEFAULT_THRESHOLD;
    return {
      ...base,
      ask: () => ({ q: { type: "yesno", instructions: rule.pattern } }),
      decide: (answers) => {
        const answer = answers.q;
        return answer?.type === "yesno" && answer.yes >= threshold ? { ...hit, confidence: answer.yes } : null;
      },
    };
  }
  const needle = rule.pattern.toLowerCase();
  const regex = rule.match === "regex" ? new RegExp(rule.pattern, "i") : null;
  return {
    ...base,
    rule: (chunk) => {
      // Codex and Cursor name their calls by kind ("mcp", "command_execution"); the tool itself is in the title.
      if (rule.match === "tool") return [chunk.tool?.name, chunk.tool?.title].some((name) => name?.toLowerCase().includes(needle)) ? hit : "pass";
      return (regex ? regex.test(chunk.text) : chunk.text.toLowerCase().includes(needle)) ? hit : "pass";
    },
  };
}

/** The enabled rules as detectors; one that no longer compiles is left out. */
export function ruleDetectors(rules: HookRule[]): Detector[] {
  const out: Detector[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    try {
      out.push(ruleDetector(rule));
    } catch {
      // A regex saved by an older version that this one rejects.
    }
  }
  return out;
}

// ---------- what each provider lets a hook hold ----------

export type HookCoverage = {
  provider: ProviderId;
  label: string;
  /** all: every tool call can be held before it runs. some: only part of them. */
  hold: "all" | "some";
  held: string;
  /** What a hook only sees once it is already running. Empty when everything is held. */
  observed: string;
};

/** Providers whose every tool call asks the host first (Claude's PreToolUse callback, Pi's tool_call extension). */
export function holdsAll(provider: ProviderId): boolean {
  return provider === "claude" || provider === "pi";
}

export function hookCoverage(): HookCoverage[] {
  return [
    { provider: "claude", label: "Claude", hold: "all", held: "Every tool call, before it runs.", observed: "" },
    { provider: "pi", label: "Native", hold: "all", held: "Every tool call, before it runs.", observed: "" },
    {
      provider: "codex",
      label: "Codex",
      hold: "some",
      held: "Commands and file changes Codex asks approval for, and Scribe's own tools (pages, web requests).",
      observed: "Commands Codex runs in its sandbox without asking, and all of its own tools under Full access.",
    },
    {
      provider: "cursor",
      label: "Cursor",
      hold: "some",
      held: "Scribe's own tools (pages, web), MCP servers from Agent settings, and the host shell when it is on.",
      observed: "Cursor's built-in tools: shell, file edits, search.",
    },
  ];
}
