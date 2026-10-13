/** The thread menu's search over what was said in a thread: the user's messages and the agent's replies, not tool calls or thinking. */

export type MessageRow = { threadId: string; text: string };

export type ThreadMessageHit = {
  id: string;
  /** The query words this thread's messages mention. The client adds the words its title matches. */
  words: string[];
  /** Around the first word in the message that mentions the most of them. */
  snippet: string;
};

/** A query's words, lowercase: a thread matches when each is in its title or its messages, in any order. */
export function searchWords(q: unknown): string[] {
  const words = typeof q === "string" ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
  return [...new Set(words)].slice(0, 10);
}

/** SQL LIKE patterns that find a word in an item's stored JSON. LIKE folds case for ASCII only, so other letters get their case variants. */
export function likePatterns(word: string): string[] {
  const forms = /[^\x00-\x7f]/.test(word) ? [word, word.toUpperCase(), word[0].toUpperCase() + word.slice(1)] : [word];
  return [...new Set(forms)].map((form) => `%${JSON.stringify(form).slice(1, -1).replace(/[!%_]/g, "!$&")}%`);
}

export function messageSnippet(text: string, word: string, width = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const at = Math.max(0, compact.toLowerCase().indexOf(word));
  const start = Math.max(0, at - 40);
  const end = Math.min(compact.length, start + width);
  return (start > 0 ? "…" : "") + compact.slice(start, end) + (end < compact.length ? "…" : "");
}

/** Rows come in thread order (oldest message first within a thread); threads with no word in any message are left out. */
export function matchMessages(rows: Iterable<MessageRow>, words: string[]): ThreadMessageHit[] {
  const found = new Map<string, { words: Set<string>; best: number; snippet: string }>();
  for (const row of rows) {
    const text = row.text.toLowerCase();
    const here = words.filter((word) => text.includes(word));
    if (!here.length) continue;
    let hit = found.get(row.threadId);
    if (!hit) found.set(row.threadId, (hit = { words: new Set(), best: 0, snippet: "" }));
    for (const word of here) hit.words.add(word);
    if (here.length > hit.best) {
      hit.best = here.length;
      hit.snippet = messageSnippet(row.text, here[0]);
    }
  }
  return [...found].map(([id, hit]) => ({ id, words: [...hit.words], snippet: hit.snippet }));
}
