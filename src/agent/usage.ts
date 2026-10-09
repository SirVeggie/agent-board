import type { ThreadUsage, Turn } from "./types.js";

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
  for (const turn of turns) {
    if (turn.reverted) continue;
    counted++;
    const u = turn.usage;
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
  };
}
