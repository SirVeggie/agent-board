/**
 * ask_user: Scribe's own question tool, the same on every provider. The agent sends structured
 * questions (choices, text, numbers, scales); the chat renders them as a card, or as a form dialog
 * when there are many, and the answers go back as text the model reads.
 */
import { isPlainRecord, type QuestionSpec } from "./types.js";
import type { QuestionAnswer, QuestionRequest } from "./providers/provider.js";

const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 12;
/** More questions than this, or any long text answer, opens as a form dialog rather than inline. */
const INLINE_MAX = 3;

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Checks the tool's input and turns it into the chat's question request. Throws a message the agent can act on. */
export function parseQuestionInput(input: unknown): QuestionRequest {
  const body = isPlainRecord(input) ? input : {};
  const raw = Array.isArray(body.questions) ? body.questions : [];
  if (!raw.length) throw new Error("Send at least one question.");
  if (raw.length > MAX_QUESTIONS) throw new Error(`At most ${MAX_QUESTIONS} questions at a time.`);
  const questions = raw.map((q, i): QuestionSpec => {
    if (!isPlainRecord(q)) throw new Error(`Question ${i + 1} is not an object.`);
    const prompt = str(q.question, 1000);
    if (!prompt) throw new Error(`Question ${i + 1} has no question text.`);
    const type = q.type === undefined ? (Array.isArray(q.options) ? "choice" : "text") : q.type;
    if (type !== "choice" && type !== "text" && type !== "number" && type !== "scale") {
      throw new Error(`Question ${i + 1}: type must be choice, text, number or scale.`);
    }
    const spec: QuestionSpec = { id: `q${i + 1}`, prompt, multi: false, options: [], ...(type === "choice" ? {} : { type }) };
    const header = str(q.header, 40);
    if (header) spec.header = header;
    if (q.optional === true) spec.optional = true;
    if (type === "choice") {
      const opts = (Array.isArray(q.options) ? q.options : []).slice(0, MAX_OPTIONS);
      spec.options = opts.map((o, j) => {
        const label = typeof o === "string" ? str(o, 200) : isPlainRecord(o) ? str(o.label, 200) : undefined;
        if (!label) throw new Error(`Question ${i + 1}, option ${j + 1} has no label.`);
        const description = isPlainRecord(o) ? str(o.description, 400) : undefined;
        return { id: `o${j + 1}`, label, ...(description ? { description } : {}) };
      });
      if (spec.options.length < 2) throw new Error(`Question ${i + 1} needs at least two options (or use type text).`);
      spec.multi = q.multiSelect === true;
    } else {
      const placeholder = str(q.placeholder, 200);
      if (placeholder) spec.placeholder = placeholder;
    }
    if (type === "text" && q.long === true) spec.long = true;
    if (type === "number" || type === "scale") {
      const min = num(q.min);
      const max = num(q.max);
      if (type === "scale") {
        spec.min = min ?? 1;
        spec.max = max ?? 5;
        if (spec.max <= spec.min || spec.max - spec.min > 10) throw new Error(`Question ${i + 1}: a scale runs over 2 to 11 steps (min < max, max - min <= 10).`);
        const low = str(q.minLabel, 40);
        const high = str(q.maxLabel, 40);
        if (low) spec.minLabel = low;
        if (high) spec.maxLabel = high;
      } else {
        if (min !== undefined) spec.min = min;
        if (max !== undefined) spec.max = max;
      }
    }
    return spec;
  });
  const title = str(body.title, 300);
  const display = body.display === "inline" || body.display === "dialog" ? body.display : autoDisplay(questions);
  return { ...(title ? { title } : {}), questions, display };
}

function autoDisplay(questions: QuestionSpec[]): "inline" | "dialog" {
  return questions.length > INLINE_MAX || questions.some((q) => q.long) ? "dialog" : "inline";
}

/** One question's answer as the user gave it: option labels for choices, the value otherwise. */
export function answerText(q: QuestionSpec, answer: Extract<QuestionAnswer, { answers: unknown }>): string[] {
  const values = answer.answers[q.id] ?? [];
  return !q.type ? values.map((id) => q.options.find((o) => o.id === id)?.label ?? id) : values.filter((v) => v.trim());
}

/** The answers as text for the model. */
export function formatAnswers(req: QuestionRequest, answer: QuestionAnswer): string {
  if ("skipped" in answer) return `The user skipped the questions${answer.reason ? `: ${answer.reason}` : "."} Carry on with your best judgment.`;
  return req.questions
    .map((q) => {
      const values = answerText(q, answer);
      const note = answer.notes?.[q.id];
      return `${q.prompt}\n→ ${values.length ? values.join(", ") : "(no answer)"}${note ? `\nNote: ${note}` : ""}`;
    })
    .join("\n\n");
}
