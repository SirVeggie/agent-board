/**
 * Replays the page-intent hint question (src/agent/pageIntent.ts) over stored chat turns and reports
 * how often it would have been right, so PAGE_HINT_THRESHOLD can be set from real traffic.
 *
 *   npm run replay:page-intent -- [--data <dir>] [--limit 300] [--dock] [--page-threads] [--dry] [--show 10]
 *
 * A turn counts as "made a page" when one of its page_show calls created a page in front of the user
 * (not background). The agent database is opened read-only. The messages go to the default
 * classifier source in ml-settings.json, under the "what may be sent" switch for your messages;
 * the day's usage counters of a running Scribe are left alone. --dry asks nothing and only counts.
 *
 * --dock keeps only messages typed into the floating chat, which Scribe records from the version
 * that added this script on. Older turns do not say where they were typed; --page-threads keeps
 * threads that belong to a page, the nearest stand-in. The open page's title, which the live
 * question also gets, is not part of the replay.
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "../src/config.js";
import { jevAdapter } from "../src/ml/adapters/jev.js";
import { MlService } from "../src/ml/service.js";
import { fileStore, type MlStore } from "../src/ml/settings.js";
import type { MlDayUsage } from "../src/ml/types.js";
import { PAGE_HINT_THRESHOLD, PAGE_INTENT_QUESTION } from "../src/agent/pageIntent.js";
import type { Item, Thread, Turn } from "../src/agent/types.js";

type Sample = { text: string; made: boolean; dock: boolean; yes?: number };

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A page_show call that created a page in front of the user. */
export function madePage(item: Item): boolean {
  if (item.kind !== "tool" || item.parentToolId || item.status !== "done") return false;
  if (!/(^|__)page_show$/.test(item.name) && !/^Scribe:\s+page_show\b/.test(item.title)) return false;
  const input = isRecord(item.input) ? (isRecord(item.input.arguments) ? item.input.arguments : item.input) : {};
  if (input.background === true) return false;
  return /"created"\s*:\s*true/.test(item.output ?? "");
}

/** One sample per turn the user started by typing: its message, and whether the turn made a page. */
export function samples(threads: Thread[], turnsOf: (id: string) => Turn[], itemsOf: (id: string) => Item[], opts: { dock?: boolean; pageThreads?: boolean } = {}): Sample[] {
  const out: Array<Sample & { at: number }> = [];
  for (const thread of threads) {
    // Helpers answer another agent's briefs, and a workspace-scoped thread has no page tools.
    if (thread.helperOf || thread.scope.kind === "workspace") continue;
    if (opts.pageThreads && thread.scope.kind !== "page") continue;
    const items = itemsOf(thread.id);
    for (const turn of turnsOf(thread.id)) {
      const own = items.filter((item) => item.turnId === turn.id);
      const user = own.find((item) => item.kind === "user");
      if (!user || user.kind !== "user" || user.from || user.card || user.steer || !user.text.trim()) continue;
      if (opts.dock && !user.dock) continue;
      out.push({ text: user.text, made: own.some(madePage), dock: Boolean(user.dock), at: turn.startedAt ?? user.createdAt });
    }
  }
  return out.sort((a, b) => b.at - a.at).map(({ at: _at, ...sample }) => sample);
}

export function table(scored: Sample[], thresholds = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]): string[] {
  const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : "-");
  const rows = ["threshold  hints  right  wrong  missed  precision  recall"];
  for (const threshold of thresholds) {
    const hinted = scored.filter((s) => (s.yes ?? 0) >= threshold);
    const right = hinted.filter((s) => s.made).length;
    const pages = scored.filter((s) => s.made).length;
    const cells = [threshold.toFixed(2).padEnd(9), String(hinted.length).padStart(5), String(right).padStart(5), String(hinted.length - right).padStart(5), String(pages - right).padStart(6), pct(right, hinted.length).padStart(9), pct(right, pages).padStart(6)];
    rows.push(cells.join("  ") + (threshold === PAGE_HINT_THRESHOLD ? "   <- current" : ""));
  }
  return rows;
}

const clipLine = (text: string) => text.replace(/\s+/g, " ").slice(0, 110);

async function main(): Promise<void> {
  const root = arg("data") ?? dataDir();
  const limit = Math.max(1, Number(arg("limit")) || 300);
  const show = Math.max(0, Number(arg("show") ?? 10) || 0);
  const db = new DatabaseSync(path.join(root, "agent.sqlite"), { readOnly: true });
  const rows = <T>(sql: string, ...params: string[]) => (db.prepare(sql).all(...params) as Array<{ data: string }>).map((row) => JSON.parse(row.data) as T);
  const all = samples(
    rows<Thread>("SELECT data FROM threads"),
    (id) => rows<Turn>("SELECT data FROM turns WHERE thread_id = ? ORDER BY seq", id),
    (id) => rows<Item>("SELECT data FROM items WHERE thread_id = ? ORDER BY seq", id),
    { dock: flag("dock"), pageThreads: flag("page-threads") }
  );
  db.close();
  const picked = all.slice(0, limit);
  const pages = picked.filter((s) => s.made).length;
  console.log(`${all.length} typed turns found; using the ${picked.length} most recent: ${pages} made a new page, ${picked.filter((s) => s.dock).length} are marked as floating chat.`);
  if (!picked.length) return;

  // Settings (and the key) from the data folder; the usage counters stay in memory.
  const files = fileStore(() => root);
  let usage: MlDayUsage | null = null;
  const store: MlStore = { read: files.read, write: () => {}, readUsage: () => usage, writeUsage: (next) => void (usage = next) };
  const settings = store.read();
  const source = settings.sources.find((s) => s.id === settings.defaultSource);
  console.log(source ? `Classifier source: ${source.name} (${source.model} at ${source.baseUrl}).` : "No classifier source is set (Settings, Classifier).");
  if (flag("dry") || !source) return;

  const service = new MlService({ store, adapter: jevAdapter(), log: () => {} });
  const failures = new Map<string, number>();
  let next = 0;
  const worker = async () => {
    for (let at = next++; at < picked.length; at = next++) {
      const sample = picked[at];
      const result = await service.decide(
        { event: "prompt", mode: "code", content: sample.text.slice(0, 20_000) },
        { page: { type: "yesno", instructions: PAGE_INTENT_QUESTION } },
        { sends: ["messages"], timeoutMs: 20_000 }
      );
      const answer = result.ok ? result.answers.page : undefined;
      if (answer?.type === "yesno") sample.yes = answer.yes;
      else failures.set(result.ok ? "no_answer" : result.error, (failures.get(result.ok ? "no_answer" : result.error) ?? 0) + 1);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  const scored = picked.filter((s) => s.yes !== undefined);
  if (failures.size) console.log(`Not answered: ${[...failures].map(([error, n]) => `${n} ${error}`).join(", ")}.`);
  if (!scored.length) return;
  console.log(`\n${scored.length} answered, ${scored.filter((s) => s.made).length} of them made a page.\n`);
  for (const row of table(scored)) console.log(row);
  if (!show) return;
  const wrong = scored.filter((s) => !s.made && s.yes! >= PAGE_HINT_THRESHOLD).sort((a, b) => b.yes! - a.yes!);
  const missed = scored.filter((s) => s.made && s.yes! < PAGE_HINT_THRESHOLD).sort((a, b) => a.yes! - b.yes!);
  console.log(`\nHinted at ${PAGE_HINT_THRESHOLD} with no page (${wrong.length}):`);
  for (const s of wrong.slice(0, show)) console.log(`  ${s.yes!.toFixed(2)}  ${clipLine(s.text)}`);
  console.log(`\nMade a page without a hint (${missed.length}):`);
  for (const s of missed.slice(0, show)) console.log(`  ${s.yes!.toFixed(2)}  ${clipLine(s.text)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "replay-page-intent.ts")) await main();
