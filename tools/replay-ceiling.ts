/**
 * Replay the live permission question on completed, typed Code turns.
 * npm run replay:ceiling -- --page <page-id> [--data <dir>] [--limit 300] [--dry]
 *   [--timeout 20000] [--show 0] [--out <aggregate-json>]
 *
 * Obtain permission to read the selected chats before running. The database is read-only;
 * only the first 4000 message characters go to the configured classifier, respecting its
 * messages switch. Settings and live usage counters are never written. Output contains
 * aggregate counts only unless --show is explicitly supplied. --out never stores messages.
 * This is an activity proxy, not a human-labelled measure of necessary permissions.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "../src/config.js";
import { CEILING_BUDGET_MS, CEILING_QUESTIONS, CEILING_THRESHOLD, ceilingFrom } from "../src/agent/ceiling.js";
import type { Item, Thread, Turn } from "../src/agent/types.js";
import { jevAdapter } from "../src/ml/adapters/jev.js";
import { MlService } from "../src/ml/service.js";
import { fileStore, type MlStore } from "../src/ml/settings.js";
import type { MlAnswer, MlDayUsage } from "../src/ml/types.js";

export type Activity = "read" | "edit" | "run" | "unknown";
export type Sample = { text: string; at: number; activity: Activity; steered: boolean; answer?: MlAnswer; ms?: number };

/** Include nested tools, failed attempts and approvals: denied work still needed permission. */
export function activity(turn: Turn, items: Item[]): Activity {
  let edit = Boolean(turn.files?.length);
  let unknown = false;
  for (const item of items) {
    if (item.kind !== "tool" && item.kind !== "approval") continue;
    if (item.tool === "execute") return "run";
    if (["edit", "delete", "move"].includes(item.tool)) edit = true;
    if (item.kind !== "tool") continue;
    // Some providers record MCP edits without a normalized ToolKind.
    if (/(^|[_.])(?:apply_patch|write_file|edit_file)$/.test(item.name)) edit = true;
    else if (/(^|[_.])(?:exec_command|host_shell|command_execution)$/.test(item.name)) return "run";
    else if (item.tool === "task" || item.tool === "other" || item.tool === "mcp") {
      // Scribe page/library operations do not edit project files. Helpers and opaque
      // code-mode calls may do so; do not count their absence of native edits as read-only.
      const safe = /(?:^|__)scribe__(?:page_|library_|read_file$|list_files$|grep_files$|scribe_docs$|thread_|settings_|memory_|ask_user$)/.test(item.name)
        && !/agent_run$/.test(item.name);
      if (!safe && item.tool !== "other") unknown = true;
      if (item.tool === "other") unknown = true;
    }
  }
  return unknown ? "unknown" : edit ? "edit" : "read";
}

export function samples(threads: Thread[], turnsOf: (id: string) => Turn[], itemsOf: (id: string) => Item[]): Sample[] {
  const out: Sample[] = [];
  for (const thread of threads) {
    if (thread.helperOf) continue;
    const items = itemsOf(thread.id);
    for (const turn of turnsOf(thread.id)) {
      if (turn.mode !== "code" || turn.status !== "done" || turn.reverted || turn.ceiling) continue;
      const own = items.filter((i) => i.turnId === turn.id);
      const user = own.find((i) => i.kind === "user" && !i.steer);
      if (!user || user.kind !== "user" || user.from || user.card || user.dropped || !user.text.trim() || user.text.startsWith("/")) continue;
      out.push({ text: user.text, at: turn.startedAt, activity: activity(turn, own), steered: own.some((i) => i.kind === "user" && i.steer === "folded" && !i.dropped) });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Counterfactual Full-access starts; failed/opaque/steered turns are separate denominators. */
export function counts(scored: Sample[], threshold: number, budgetMs = Infinity) {
  let lowered = 0, ask = 0, edits = 0, conflicts = 0, unknown = 0, late = 0;
  const clean = scored.filter((s) => !s.steered && s.answer);
  for (const s of clean) {
    if ((s.ms ?? 0) > budgetMs) { late++; continue; }
    const ceiling = ceilingFrom(s.answer, threshold);
    if (!ceiling) continue;
    lowered++;
    if (ceiling.approval === "ask") ask++; else edits++;
    if (s.activity === "unknown") unknown++;
    else if (s.activity === "run" || (s.activity === "edit" && ceiling.approval === "ask")) conflicts++;
  }
  const knownLowered = lowered - unknown;
  return { threshold, eligible: clean.length, late, lowered, ask, edits, unknown, knownLowered, conflicts,
    conflictRate: knownLowered ? conflicts / knownLowered : null };
}

const arg = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1]; };
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const root = arg("data") ?? dataDir();
  const page = arg("page");
  if (!page) throw new Error("Pass --page <page-id> to limit the replay to chats you have permission to read.");
  const limit = Math.max(1, Math.floor(Number(arg("limit")) || 300));
  const timeoutMs = Math.max(1, Number(arg("timeout")) || 20_000);
  const db = new DatabaseSync(path.join(root, "agent.sqlite"), { readOnly: true });
  let picked: Sample[], total: number;
  try {
    const rows = <T>(sql: string, ...params: string[]) => (db.prepare(sql).all(...params) as { data: string }[]).map((r) => JSON.parse(r.data) as T);
    const threads = rows<Thread>("SELECT data FROM threads WHERE json_extract(data, '$.scope.kind') = 'page' AND json_extract(data, '$.scope.ref') = ?", page);
    const all = samples(threads, (id) => rows<Turn>("SELECT data FROM turns WHERE thread_id = ? ORDER BY seq", id), (id) => rows<Item>("SELECT data FROM items WHERE thread_id = ? ORDER BY seq", id));
    total = all.length;
    picked = all.slice(0, limit);
  } finally { db.close(); }
  const cohort = { total, picked: picked.length, steered: picked.filter((s) => s.steered).length,
    activity: Object.fromEntries(["read", "edit", "run", "unknown"].map((kind) => [kind, picked.filter((s) => s.activity === kind).length])),
    oldest: picked.length ? new Date(picked.at(-1)!.at).toISOString() : null, newest: picked.length ? new Date(picked[0].at).toISOString() : null };
  console.log(JSON.stringify(cohort, null, 2));
  const files = fileStore(() => root);
  let usage: MlDayUsage | null = null;
  const store: MlStore = { read: files.read, write: () => {}, readUsage: () => usage, writeUsage: (next) => void (usage = next) };
  const settings = store.read();
  const source = settings.sources.find((s) => s.id === settings.defaultSource);
  console.log(JSON.stringify({ classifier: source ? { name: source.name, baseUrl: source.baseUrl, model: source.model } : null, messagesAllowed: settings.send.messages }));
  if (flag("dry") || !picked.length) return;
  if (!source) throw new Error("No classifier source configured.");
  if (process.env.SCRIBE_FAKE_ML) throw new Error("Remove SCRIBE_FAKE_ML to measure a real classifier.");
  const service = new MlService({ store, adapter: jevAdapter(), log: () => {} });
  const failures: Record<string, number> = {};
  const models = new Set<string>();
  let next = 0;
  const worker = async () => {
    for (let at = next++; at < picked.length; at = next++) {
      const s = picked[at];
      const result = await service.decide({ event: "prompt", mode: "code", content: s.text.slice(0, 4000) }, CEILING_QUESTIONS, { sends: ["messages"], timeoutMs, cache: false });
      if (result.ok && result.answers.need?.type === "choice") {
        s.answer = result.answers.need; s.ms = result.ms; models.add(result.model);
      } else { const error = result.ok ? "no_answer" : result.error; failures[error] = (failures[error] ?? 0) + 1; }
      if ((at + 1) % 25 === 0) console.error(`Answered ${at + 1}/${picked.length}`);
    }
  };
  await Promise.all(Array.from({ length: 2 }, worker));
  const scored = picked.filter((s) => s.answer);
  const thresholds = [0.5, 0.6, 0.7, 0.75, CEILING_THRESHOLD, 0.85, 0.9, 0.95, 0.99];
  const report = { measuredAt: new Date().toISOString(), page, source: source.name, models: [...models], timeoutMs, liveBudgetMs: CEILING_BUDGET_MS, questions: CEILING_QUESTIONS, cohort, answered: scored.length, failures, usage,
    quality: thresholds.map((t) => counts(scored, t)), withinLiveBudget: thresholds.map((t) => counts(scored, t, CEILING_BUDGET_MS)),
    steered: { answered: scored.filter((s) => s.steered).length, lowered: scored.filter((s) => s.steered && ceilingFrom(s.answer)).length } };
  console.log(JSON.stringify(report, null, 2));
  if (arg("out")) fs.writeFileSync(arg("out")!, JSON.stringify(report, null, 2) + "\n");
  const show = Math.max(0, Number(arg("show")) || 0);
  for (const s of scored.filter((s) => !s.steered && counts([s], CEILING_THRESHOLD).conflicts).slice(0, show)) {
    console.log(`${s.activity}: ${s.text.replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "replay-ceiling.ts")) await main();
