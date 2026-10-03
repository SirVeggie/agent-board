/** What a forked thread's first message carries from the thread it came from, when it starts a fresh session. */

/** Characters of the in-between turns handed to the summarizer, and of each message carried verbatim. */
export const MAX_FORK_MIDDLE = 150_000;
export const MAX_FORK_MESSAGE = 8_000;
/** Characters of the in-between turns sent as they are when the summary failed. */
const MAX_MIDDLE_VERBATIM = 24_000;

/** Kept as the setting fork:<thread id> until the fork's first turn ends. summary: written once, then reused. */
export type ForkMaterial = { first: string; middle: string; last: string; reply: string; summary?: string };

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function summaryPrompt(conversation: string): string {
  return [
    "Below is the middle part of a conversation between a user and a coding agent. Another agent will continue the work from a fresh start; it also gets the first message, the last message, and the last reply, but not this part.",
    "Summarize it for that agent: what was asked and decided, what was done (files, commands, results), what the user corrected or rejected, and what is still open. Keep names, paths, and numbers exact. Leave out pleasantries. Plain text, at most about 500 words. Answer with the summary only.",
    "",
    `<conversation>\n${conversation}\n</conversation>`,
  ].join("\n");
}

/** The earlier conversation a fork's first message carries, when it starts a fresh session. */
export function forkBlock(title: string, providerLabel: string, m: ForkMaterial): string {
  const parts = [
    `This thread was forked from the thread “${title}”, which ran with ${providerLabel}. You are a new session, so this is what you know of it. Changes it made to files are already in the workspace.`,
    `First message from the user:\n${m.first}`,
  ];
  if (m.middle) {
    parts.push(
      m.summary
        ? `Summary of the conversation in between:\n${m.summary}`
        : `The conversation in between:\n${m.middle.length > MAX_MIDDLE_VERBATIM ? `…${m.middle.slice(-MAX_MIDDLE_VERBATIM)}` : m.middle}`
    );
  }
  if (m.last) parts.push(`Last message from the user:\n${m.last}`);
  if (m.reply) parts.push(`The agent's last reply:\n${m.reply}`);
  return `<earlier_conversation>\n${parts.join("\n\n")}\n</earlier_conversation>\n\n`;
}
