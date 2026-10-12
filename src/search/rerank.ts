import type { DecideOptions, DecideResult, MlQuestions } from "../ml/types.js";

/**
 * The optional step after vector retrieval (#520): the closest hits are each asked "does this fit the
 * search?" in one classifier call, with the query as the shared state. Hits that fit move up, the rest
 * are dropped. Any failure or a missed time budget leaves the vector ranking as it was.
 */

/** The Classifier feature switch (Settings, Search and Classifier). */
export const RERANK_FEATURE = "search-rerank";
/** Hits asked about, best first. Later ones keep their vector order after them. */
export const RERANK_TOP_K = 20;
/** A hit whose "yes" is below this is dropped. Not measured yet: set it from `npm run eval:rerank`. */
export const RERANK_THRESHOLD = 0.3;
/**
 * How long a search waits for the classifier before it returns the vector ranking. Not measured yet
 * against a real source (the eval prints the times): the palette's is short because it is typed into,
 * an agent's library_search can wait longer.
 */
export const RERANK_BUDGET_MS = { user: 800, agent: 2500 } as const;
/** Characters of one hit's text in its question. */
export const RERANK_TEXT = 500;
export const RERANK_QUESTION = "The state is what someone typed to search their personal page library. Would they want the passage below among the results?";

export type RerankDecide = (state: unknown, questions: MlQuestions, options: DecideOptions) => Promise<DecideResult>;
export type RerankInfo =
  | { applied: true; ms: number; asked: number; dropped: number; cached: boolean }
  /** `reason` is the decision service's error kind. */
  | { applied: false; reason: string; ms: number };

/**
 * Yes-probabilities sit close together and wobble, so hits are ordered by tenths of "yes" and keep
 * their vector order inside a tenth.
 */
const band = (yes: number) => Math.round(yes * 10);

export async function rerankHits<T>(
  query: string,
  hits: T[],
  passage: (hit: T) => string,
  decide: RerankDecide,
  options: { timeoutMs: number; topK?: number; threshold?: number },
): Promise<{ hits: T[]; info: RerankInfo }> {
  const head = hits.slice(0, options.topK ?? RERANK_TOP_K);
  const questions: MlQuestions = {};
  head.forEach((hit, i) => {
    questions[`h${i}`] = {
      type: "yesno",
      instructions: `${RERANK_QUESTION}\n\nPassage: ${passage(hit).slice(0, RERANK_TEXT + 200)}`,
      criteria: { yes: "It is about what they are looking for, or answers it.", no: "It is about something else, or only shares a word with the search." },
    };
  });
  // Page text goes out under the "tool results" switch, like what an agent reads from a page.
  const result = await decide({ search: query }, questions, { feature: RERANK_FEATURE, sends: ["toolResults"], timeoutMs: options.timeoutMs });
  if (!result.ok) return { hits, info: { applied: false, reason: result.error, ms: result.ms } };
  const threshold = options.threshold ?? RERANK_THRESHOLD;
  const scored = head.map((hit, i) => {
    const answer = result.answers[`h${i}`];
    // A hit the backend left unanswered stays, in the middle.
    return { hit, i, yes: answer?.type === "yesno" && Number.isFinite(answer.yes) ? answer.yes : 0.5 };
  });
  const kept = scored.filter((s) => s.yes >= threshold).sort((a, b) => band(b.yes) - band(a.yes) || a.i - b.i);
  return {
    hits: [...kept.map((s) => s.hit), ...hits.slice(head.length)],
    info: { applied: true, ms: result.ms, asked: head.length, dropped: head.length - kept.length, cached: result.cached },
  };
}
