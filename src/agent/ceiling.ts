import { APPROVAL_RANK } from "../pagePermissions.js";
import type { MlAnswer, MlQuestions } from "../ml/types.js";
import { GATE_BUDGET_MS, type HookDecide } from "./hooks.js";
import type { ApprovalPolicy, Thread } from "./types.js";

/**
 * Lowering a turn's permissions when the message does not need them
 * (docs/intent-detection-hooks-design.md, "Lowering permissions when they aren't needed").
 *
 * On send the classifier is asked what the message needs, and the turn runs with the lower of the
 * thread's approval level and what that needs: a question on a Full-access thread runs as if on Ask.
 * It is a soft ceiling: when the agent wants more, the user gets the usual approval prompt with the
 * reason and an "Allow for this turn" option that puts the thread's own level back. It only ever
 * lowers, and on a slow or failing classifier the thread's own level applies (fail open).
 */

/** How long a turn's start waits for the classifier: the gating budget. */
export const CEILING_BUDGET_MS = GATE_BUDGET_MS;
/**
 * How sure the classifier must be that the message needs nothing above a level before the turn is
 * lowered to it. The first real-turn replay found frequent activity conflicts at 0.8;
 * keep the setting off by default (docs/ceiling-evaluation.md).
 */
export const CEILING_THRESHOLD = 0.8;
/** The approval option the host adds while a turn runs lowered. */
export const LIFT_OPTION = "scribe:lift-ceiling";

export type CeilingNeed = "answer" | "pages" | "web" | "edit" | "run";

/** What a turn's ceiling is, as the transcript shows it (Turn.ceiling). */
export type TurnCeiling = {
  /** The level the turn started with. */
  approval: ApprovalPolicy;
  /** The thread's own level, which it would have run with. */
  from: ApprovalPolicy;
  /** What the message looked like it needs. */
  need: CeilingNeed;
  /** The user allowed the thread's own level for the rest of the turn. */
  lifted?: boolean;
};

export const CEILING_QUESTIONS: MlQuestions = {
  need: {
    type: "choice",
    instructions:
      "A user sent this message to a coding agent that can read files, edit files and run shell commands. What is the most the agent has to do to answer it? Pick the highest that applies.",
    options: {
      answer: "Only read, search and explain: a question, a review, an explanation, a plan or advice. Nothing is changed.",
      pages: "Create or change a page, note, board card or todo item in the app, without touching files in the project.",
      web: "Look something up on the web, without changing files or running commands.",
      edit: "Create, change, rename or delete files, such as writing or fixing code, without running anything.",
      run: "Run commands: build, test, install, start something, use git, or carry out a task whose steps are left to the agent.",
    },
  },
};

const NEEDS: readonly CeilingNeed[] = ["answer", "pages", "web", "edit", "run"];

function rank(approval: ApprovalPolicy): number {
  return APPROVAL_RANK.indexOf(approval);
}

/** The lower of two approval levels, by `ask < edits < auto < full`. */
export function lowerApproval(a: ApprovalPolicy, b: ApprovalPolicy): ApprovalPolicy {
  return rank(a) <= rank(b) ? a : b;
}

/**
 * The classifier's answer as a ceiling: "ask" when the message needs neither edits nor commands,
 * "edits" when it needs no commands, else none. An unsure answer gives none.
 */
export function ceilingFrom(answer: MlAnswer | undefined, threshold = CEILING_THRESHOLD): { approval: ApprovalPolicy; need: CeilingNeed } | null {
  if (answer?.type !== "choice" || !NEEDS.includes(answer.choice as CeilingNeed)) return null;
  const share = (need: CeilingNeed) => answer.probabilities[need] ?? (answer.choice === need ? 1 : 0);
  const run = share("run");
  const edit = share("edit");
  const need = answer.choice as CeilingNeed;
  if (need !== "run" && need !== "edit" && 1 - run - edit >= threshold) return { approval: "ask", need };
  if (need !== "run" && 1 - run >= threshold) return { approval: "edits", need };
  return null;
}

/** Whether a turn on this thread could be lowered at all: Code mode, above Ask. */
export function canLower(thread: Pick<Thread, "mode" | "approval">): boolean {
  return thread.mode === "code" && thread.approval !== "ask";
}

/**
 * Ask what the message needs. Null (the thread's own level applies) when the classifier is off,
 * slow, failing or unsure, and when the answer would not lower this thread.
 */
export async function classifyCeiling(decide: HookDecide, text: string, thread: Pick<Thread, "mode" | "approval">, budgetMs = CEILING_BUDGET_MS): Promise<TurnCeiling | null> {
  if (!canLower(thread) || !text.trim()) return null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    const result = await Promise.race([decide({ event: "prompt", mode: thread.mode, content: text.slice(0, 4000) }, CEILING_QUESTIONS, { sends: ["messages"], timeoutMs: budgetMs }), late]);
    if (!result?.ok) return null;
    const found = ceilingFrom(result.answers.need);
    if (!found) return null;
    const approval = lowerApproval(thread.approval, found.approval);
    return approval === thread.approval ? null : { approval, from: thread.approval, need: found.need };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The thread as a lowered turn's provider session sees it: live, except for its approval level. */
export function lowered(thread: Thread, approval: ApprovalPolicy): Thread {
  return new Proxy(thread, { get: (target, key) => (key === "approval" ? approval : Reflect.get(target, key)) });
}

/** The line on an approval prompt, and the turn's indicator: why this turn asks. */
export function ceilingReason(ceiling: Pick<TurnCeiling, "approval" | "need">): string {
  if (ceiling.approval === "edits") return "This turn started with file edits only because your message did not look like it needs commands.";
  const looked = ceiling.need === "pages" ? "it only needs pages" : ceiling.need === "web" ? "it only needs the web" : "a question";
  return `This turn started read-only because your message looked like ${looked}.`;
}
