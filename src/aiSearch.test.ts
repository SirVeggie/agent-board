import assert from "node:assert/strict";
import { test } from "node:test";
import { AI_SEARCH_MAX_HITS, aiSearchPrompt, digestPages, pageDigest, parseAiHits } from "./aiSearch.js";
import type { Tab } from "./types.js";

function tab(fields: Partial<Tab>): Tab {
  return { id: "t_1", key: "scribe:one", title: "One", html: "", state: {}, updatedAt: 0, ...fields } as Tab;
}

test("pageDigest has title, folder, text and state words, without ids or asset refs", () => {
  const digest = pageDigest(
    tab({ title: "Worktrees", html: "<style>x{}</style><p>Junction  vs npm ci</p>", state: { cards: [{ id: "c_ab12", title: "Share node_modules", data: "asset:x.png" }] } }),
    "Investigations"
  );
  assert.equal(digest, "Worktrees — folder: Investigations: Junction vs npm ci | Share node_modules");
});

test("pageDigest caps the text", () => {
  const digest = pageDigest(tab({ html: "word ".repeat(500) }), null);
  assert.ok(digest.length < 320);
});

test("digestPages puts the newest change first", () => {
  const ids = digestPages([tab({ id: "a", updatedAt: 1 }), tab({ id: "b", updatedAt: 3 }), tab({ id: "c", updatedAt: 2 })]).map((t) => t.id);
  assert.deepEqual(ids, ["b", "c", "a"]);
});

test("aiSearchPrompt numbers the digests from 1", () => {
  const prompt = aiSearchPrompt("where is x", ["A", "B"]);
  assert.match(prompt, /\[1\] A\n\[2\] B/);
  assert.match(prompt, /They are looking for: where is x/);
});

test("parseAiHits reads fenced JSON, drops unknown numbers and repeats", () => {
  const reply = 'Here:\n```json\n[{"n": 2, "why": " fits  well "}, {"n": 9, "why": "x"}, {"n": 2, "why": "again"}, {"n": 1}]\n```';
  assert.deepEqual(parseAiHits(reply, ["a", "b"]), [
    { id: "b", reason: "fits well" },
    { id: "a", reason: "" },
  ]);
});

test("parseAiHits caps the hits and rejects a reply with no list", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
  const reply = JSON.stringify(ids.map((_, i) => ({ n: i + 1, why: "" })));
  assert.equal(parseAiHits(reply, ids).length, AI_SEARCH_MAX_HITS);
  assert.deepEqual(parseAiHits("[]", ids), []);
  assert.throws(() => parseAiHits("nothing found", ids), /no result list/);
});
