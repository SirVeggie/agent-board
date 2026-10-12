/**
 * Runs a labelled set of tool results through the prompt-injection question (src/agent/injection.ts)
 * and reports hits and false alarms per threshold, so INJECTION_THRESHOLD can be set from a real
 * classifier source.
 *
 *   npm run replay:injection -- [--file tools/injection-samples.json] [--data <dir>] [--dry] [--show 10]
 *
 * The file is a JSON array of { id, kind: "injection" | "benign", text, source?, note? }. Each text
 * is asked about window by window, as the live scan does, and its surest window counts. The texts
 * go to the default classifier source in ml-settings.json, under the "what may be sent" switch for
 * tool results; the feature's own switch is not needed, and the day's usage counters of a running
 * Scribe are left alone. --dry asks nothing and only counts.
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../src/config.js";
import { jevAdapter } from "../src/ml/adapters/jev.js";
import { MlService } from "../src/ml/service.js";
import { fileStore, type MlStore } from "../src/ml/settings.js";
import type { DecideOptions, DecideResult, MlDayUsage, MlQuestions } from "../src/ml/types.js";
import { windows } from "../src/agent/hooks.js";
import { INJECTION_QUESTION, INJECTION_THRESHOLD } from "../src/agent/injection.js";

export type Sample = { id: string; kind: "injection" | "benign"; text: string; source?: string; note?: string; yes?: number };

type Decide = (state: unknown, questions: MlQuestions, options: DecideOptions) => Promise<DecideResult>;

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

export function readSamples(file: string): Sample[] {
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${file} is not a JSON array`);
  return raw.filter((s): s is Sample => typeof s === "object" && s !== null && typeof s.id === "string" && typeof s.text === "string" && (s.kind === "injection" || s.kind === "benign"));
}

/** The surest "yes" over the text's windows, or an error name when no window was answered. */
export async function score(decide: Decide, text: string, timeoutMs = 20_000): Promise<{ yes: number } | { error: string }> {
  const results = await Promise.all(
    windows(text).map((content) => decide({ event: "tool_result", mode: "code", content }, { injection: INJECTION_QUESTION }, { sends: ["toolResults"], timeoutMs }))
  );
  let yes: number | undefined;
  let error = "no_answer";
  for (const result of results) {
    const answer = result.ok ? result.answers.injection : undefined;
    if (answer?.type === "yesno") yes = Math.max(yes ?? 0, answer.yes);
    else if (!result.ok) error = result.error;
  }
  return yes === undefined ? { error } : { yes };
}

export function counts(scored: Sample[], threshold = INJECTION_THRESHOLD): { injections: number; hits: number; benign: number; falseAlarms: number } {
  const hit = (s: Sample) => (s.yes ?? 0) >= threshold;
  const injections = scored.filter((s) => s.kind === "injection");
  const benign = scored.filter((s) => s.kind === "benign");
  return { injections: injections.length, hits: injections.filter(hit).length, benign: benign.length, falseAlarms: benign.filter(hit).length };
}

export function table(scored: Sample[], thresholds = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]): string[] {
  const rows = ["threshold  hits      missed  false alarms"];
  for (const threshold of thresholds) {
    const c = counts(scored, threshold);
    const cells = [threshold.toFixed(2).padEnd(9), `${c.hits}/${c.injections}`.padEnd(8), String(c.injections - c.hits).padStart(6), `${c.falseAlarms}/${c.benign}`.padStart(12)];
    rows.push(cells.join("  ") + (threshold === INJECTION_THRESHOLD ? "   <- current" : ""));
  }
  return rows;
}

async function main(): Promise<void> {
  const root = arg("data") ?? dataDir();
  const file = arg("file") ?? path.join(import.meta.dirname, "injection-samples.json");
  const show = Math.max(0, Number(arg("show") ?? 10) || 0);
  const samples = readSamples(file);
  console.log(`${samples.length} samples from ${file}: ${samples.filter((s) => s.kind === "injection").length} injections, ${samples.filter((s) => s.kind === "benign").length} ordinary.`);

  // Settings (and the key) from the data folder; the usage counters stay in memory.
  const files = fileStore(() => root);
  let usage: MlDayUsage | null = null;
  const store: MlStore = { read: files.read, write: () => {}, readUsage: () => usage, writeUsage: (next) => void (usage = next) };
  const settings = store.read();
  const source = settings.sources.find((s) => s.id === settings.defaultSource);
  console.log(source ? `Classifier source: ${source.name} (${source.model} at ${source.baseUrl}).` : "No classifier source is set (Settings, Classifier).");
  if (flag("dry") || !source || !samples.length) return;

  const service = new MlService({ store, adapter: jevAdapter(), log: () => {} });
  const failures = new Map<string, number>();
  let next = 0;
  const worker = async () => {
    for (let at = next++; at < samples.length; at = next++) {
      const result = await score((state, questions, options) => service.decide(state, questions, options), samples[at].text);
      if ("yes" in result) samples[at].yes = result.yes;
      else failures.set(result.error, (failures.get(result.error) ?? 0) + 1);
    }
  };
  await Promise.all(Array.from({ length: 2 }, worker));

  const scored = samples.filter((s) => s.yes !== undefined);
  if (failures.size) console.log(`Not answered: ${[...failures].map(([error, n]) => `${n} ${error}`).join(", ")}.`);
  if (!scored.length) return;
  console.log("");
  for (const row of table(scored)) console.log(row);
  if (!show) return;
  const line = (s: Sample) => `  ${s.yes!.toFixed(2)}  ${s.id}${s.note ? `: ${s.note}` : ""}`;
  const missed = scored.filter((s) => s.kind === "injection" && s.yes! < INJECTION_THRESHOLD).sort((a, b) => a.yes! - b.yes!);
  const alarms = scored.filter((s) => s.kind === "benign" && s.yes! >= INJECTION_THRESHOLD).sort((a, b) => b.yes! - a.yes!);
  console.log(`\nInjections missed at ${INJECTION_THRESHOLD} (${missed.length}):`);
  for (const s of missed.slice(0, show)) console.log(line(s));
  console.log(`\nFalse alarms at ${INJECTION_THRESHOLD} (${alarms.length}):`);
  for (const s of alarms.slice(0, show)) console.log(line(s));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "replay-injection.ts")) await main();
