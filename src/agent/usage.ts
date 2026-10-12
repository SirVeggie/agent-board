import type { ProviderId, ThreadUsage, Turn } from "./types.js";
import { promptTokens } from "./harness.js";

/**
 * Totals across a thread's turns, for boards and `runInfo` when a chat ends.
 * Reverted turns are omitted; cancelled or failed turns still count — they used tokens.
 */
export function sumThreadUsage(turns: Turn[]): ThreadUsage | undefined {
  let counted = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let cost = 0;
  let hasInput = false;
  let hasOutput = false;
  let hasCacheRead = false;
  let hasCacheWrite = false;
  let hasReasoning = false;
  let hasCost = false;
  let estimatedCostUsd: number | undefined;
  let reportedCostUsd: number | undefined;
  let costPartial = false;
  for (const turn of turns) {
    if (turn.reverted) continue;
    counted++;
    const u = turn.usage;
    if (u?.costPartial) costPartial = true;
    if (u?.estimatedCostUsd !== undefined) estimatedCostUsd = (estimatedCostUsd ?? 0) + u.estimatedCostUsd;
    if (u?.reportedCostUsd !== undefined) reportedCostUsd = (reportedCostUsd ?? 0) + u.reportedCostUsd;
    if (!u) continue;
    if (typeof u.inputTokens === "number") {
      input += u.inputTokens;
      hasInput = true;
    }
    if (typeof u.outputTokens === "number") {
      output += u.outputTokens;
      hasOutput = true;
    }
    if (typeof u.cacheReadTokens === "number") {
      cacheRead += u.cacheReadTokens;
      hasCacheRead = true;
    }
    if (typeof u.cacheWriteTokens === "number") {
      cacheWrite += u.cacheWriteTokens;
      hasCacheWrite = true;
    }
    if (typeof u.reasoningTokens === "number") {
      reasoning += u.reasoningTokens;
      hasReasoning = true;
    }
    if (typeof u.costUsd === "number") {
      cost += u.costUsd;
      hasCost = true;
    }
  }
  if (!counted) return undefined;
  return {
    turns: counted,
    ...(hasInput ? { inputTokens: input } : {}),
    ...(hasOutput ? { outputTokens: output } : {}),
    ...(hasCacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(hasCacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
    ...(hasReasoning ? { reasoningTokens: reasoning } : {}),
    ...(hasCost ? { costUsd: cost } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
    ...(costPartial ? { costPartial: true } : {}),
  };
}

/** Snapshot the whole helper tree; recompute rather than accumulating on continuation. */
export function sumUsageTree(
  id: string,
  threads: Iterable<{ id: string; helperOf?: string; provider: ProviderId }>,
  turnsFor: (id: string) => Turn[],
): ThreadUsage | undefined {
  const all = [...threads];
  const seen = new Set<string>();
  const snapshots: ThreadUsage[] = [];
  let main: ThreadUsage | undefined;
  function visit(threadId: string): void {
    if (seen.has(threadId)) return;
    seen.add(threadId);
    const thread = all.find((t) => t.id === threadId);
    if (!thread) return;
    const turns = turnsFor(threadId).filter((t) => !t.reverted);
    const raw = sumThreadUsage(turns);
    const normalized = turns.reduce((n, t) => n + promptTokens(thread.provider, t.usage), 0);
    const own: ThreadUsage = { ...raw, turns: raw?.turns ?? 0, promptTokens: normalized,
      ...((!turns.length && threadId !== id || turns.some((t) => t.usage?.costUsd === undefined)) ? { costPartial: true } : {}) };
    if (threadId === id) main = own;
    else snapshots.push(own);
    for (const child of all) if (child.helperOf === threadId) visit(child.id);
  }
  visit(id);
  if (!main || (!main.turns && !snapshots.length)) return undefined;
  function combine(parts: ThreadUsage[]): ThreadUsage {
    const result: ThreadUsage = { turns: 0, inputTokens: 0, promptTokens: 0 };
    for (const part of parts) {
      result.turns += part.turns;
      result.inputTokens! += part.promptTokens ?? 0;
      result.promptTokens! += part.promptTokens ?? 0;
      for (const key of ["outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "costUsd", "estimatedCostUsd", "reportedCostUsd"] as const) {
        if (part[key] !== undefined) result[key] = (result[key] ?? 0) + part[key]!;
      }
      if (part.costPartial) result.costPartial = true;
    }
    return result;
  }
  if (!snapshots.length) return main;
  return { ...combine([main, ...snapshots]), main, helpers: { ...combine(snapshots), threads: snapshots.length } };
}
