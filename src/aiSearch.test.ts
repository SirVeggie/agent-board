import assert from "node:assert/strict";
import { test } from "node:test";
import { AI_SEARCH_MAX_HITS, CHUNK_TEXT, aiChunkPrompt, aiSearchPrompt, chunkDigest, digestPages, pageDigest, parseAiHits } from "./aiSearch.js";
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
    { id: "b", index: 1, reason: "fits well" },
    { id: "a", index: 0, reason: "" },
  ]);
});

test("parseAiHits keeps the first passage picked for a page", () => {
  const hits = parseAiHits('[{"n": 3, "why": "card"}, {"n": 1, "why": "same page"}, {"n": 2}]', ["a", "b", "a"]);
  assert.deepEqual(hits.map((hit) => [hit.id, hit.index]), [["a", 2], ["b", 1]]);
});

test("chunkDigest names the section or item and caps the text", () => {
  const page = { title: "Scribe Todo", folder: "Apps" };
  assert.equal(chunkDigest(page, { kind: "record", label: "#12 Deep card", text: "Fix  the\nlogin" }), "Scribe Todo — folder: Apps — item: #12 Deep card: Fix the login");
  assert.equal(chunkDigest({ title: "Notes", folder: null }, { kind: "section", label: "Setup", text: "x" }), "Notes — section: Setup: x");
  assert.equal(chunkDigest({ title: "Notes", folder: null }, { kind: "page", label: "Notes", text: "" }), "Notes");
  assert.ok(chunkDigest(page, { kind: "page", label: "", text: "word ".repeat(500) }).length < CHUNK_TEXT + 40);
});

test("aiChunkPrompt numbers the passages from 1", () => {
  const prompt = aiChunkPrompt("where is x", ["A", "B"]);
  assert.match(prompt, /\[1\] A\n\[2\] B/);
  assert.match(prompt, /They are looking for: where is x/);
});

test("parseAiHits caps the hits and rejects a reply with no list", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
  const reply = JSON.stringify(ids.map((_, i) => ({ n: i + 1, why: "" })));
  assert.equal(parseAiHits(reply, ids).length, AI_SEARCH_MAX_HITS);
  assert.deepEqual(parseAiHits("[]", ids), []);
  assert.throws(() => parseAiHits("nothing found", ids), /no result list/);
});
