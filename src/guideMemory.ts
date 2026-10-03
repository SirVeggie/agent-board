/**
 * Template guides each Scribe chat thread's agent has already been given. The chat host puts a
 * page's guide into the prompt when the page comes up (the thread's own page, a page chip, a
 * scribe: link), and the MCP asks here before attaching it to a tool result, so the agent reads
 * each guide once whichever way it arrived. MCP clients outside a Scribe chat keep their own memory.
 */

const sent = new Map<string, Map<string, string>>();

export type GuideRef = { id: string; text: string };

export function guideSent(thread: string, guide: GuideRef): boolean {
  return sent.get(thread)?.get(guide.id) === guide.text;
}

export function markGuideSent(thread: string, guide: GuideRef): void {
  let guides = sent.get(thread);
  if (!guides) {
    guides = new Map();
    sent.set(thread, guides);
  }
  guides.set(guide.id, guide.text);
}

/** The thread's agent starts over (rewind, a new session), so it no longer has the guides. */
export function forgetGuides(thread: string): void {
  sent.delete(thread);
}
