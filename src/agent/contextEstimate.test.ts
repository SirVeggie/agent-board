import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { seedTokens } from "./harness.js";

// The chat's context estimate lives in the browser script; take its two pure functions out to run them here.
const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
const fn = (name: string) => {
  const match = new RegExp(`\\n  function ${name}\\([\\s\\S]*?\\n  \\}\\n`).exec(source);
  assert.ok(match, `${name} not found in agent.js`);
  return match[0];
};
type Detail = { items: Array<Record<string, unknown>>; turns: Map<string, { id: string; seq: number }> };
const estimateContext = new Function(`${fn("itemContextChars")}${fn("estimateContext")}return estimateContext;`)() as (detail: Detail | null, measured: { seq: number } | null) => number;

const turn = (seq: number) => ({ id: `t${seq}`, seq });
const detail = (items: Detail["items"]): Detail => ({ items, turns: new Map([turn(1), turn(2)].map((t) => [t.id, t])) });

test("the context estimate counts what the model reads, at four characters a token", () => {
  const items = [
    { kind: "user", turnId: "t1", text: "a".repeat(400) },
    { kind: "reasoning", turnId: "t1", text: "r".repeat(4000) },
    { kind: "tool", turnId: "t1", input: { command: "x".repeat(86) }, output: "o".repeat(300) },
    { kind: "text", turnId: "t1", text: "b".repeat(200), parentToolId: "sub" },
    { kind: "text", turnId: "t2", text: "c".repeat(800) },
    { kind: "user", turnId: null, text: "d".repeat(40) },
    { kind: "user", turnId: null, text: "dropped".repeat(40), dropped: true },
  ];
  // Nothing measured: the whole chat, without reasoning, subagent items and dropped messages.
  assert.equal(estimateContext(detail(items), null), (400 + 100 + 300 + 800 + 40) / 4);
  // Turn 1 reported its context: only later turns and queued messages are estimated.
  assert.equal(estimateContext(detail(items), turn(1)), (800 + 40) / 4);
  assert.equal(estimateContext(detail(items), turn(2)), 40 / 4);
  assert.equal(estimateContext(null, null), 0);
});

test("without a provider count, the estimate starts over after the conversation was summarized", () => {
  const items = [
    { kind: "text", turnId: "t1", text: "a".repeat(4000) },
    { kind: "notice", turnId: "t1", level: "info", text: "Cursor summarized the conversation to make room." },
    { kind: "text", turnId: "t2", text: "b".repeat(80) },
  ];
  assert.equal(estimateContext(detail(items), null), 20);
});

test("startup estimates include instructions, tool schemas, server instructions and workspace files", () => {
  const base = seedTokens("codex", 0, { tokens: 0, instructionsChars: 0 }, []);
  assert.ok(base > 0);
  assert.equal(seedTokens("codex", 1200, { tokens: 800, instructionsChars: 400 }, [{ tokens: 300 }]), base + 2400);
});

test("the meter includes startup context before a reply and replaces it with measured context", () => {
  const turns = new Map<string, any>();
  const S = { details: new Map([["thread", { items: [], turns }]]) };
  const contextInfo = new Function("S", "modelInfo", "contextSeed", "noteWindows", "knownWindows",
    `${fn("sizeTokens")}${fn("itemContextChars")}${fn("estimateContext")}${fn("contextInfo")}return contextInfo;`
  )(S, () => null, () => ({ tokens: 24000, window: 272000 }), () => {}, new Map());
  const view = { settings: () => ({ provider: "codex", model: "test" }), thread: () => ({ id: "thread", provider: "codex" }) };
  assert.equal(contextInfo(view).used, 24000);
  assert.equal(contextInfo(view).window, 272000);
  assert.equal(contextInfo(view).estimate, 24000);
  turns.set("t1", { id: "t1", seq: 1, usage: { contextTokens: 31000, contextWindow: 272000 } });
  assert.equal(contextInfo(view).used, 31000);
  assert.equal(contextInfo(view).estimate, 0);
});

test("startup requests are shared across renders and late replies cannot overwrite changed settings", async () => {
  const requests: Array<{ resolve: (value: unknown) => void }> = [];
  const contextSeed = new Function("api", `${fn("contextSeed")}return contextSeed;`)(() => new Promise((resolve) => requests.push({ resolve })));
  let refreshes = 0;
  const view = { thread: () => null, refreshContextMeter: () => refreshes++ };
  assert.equal(contextSeed(view, { provider: "codex" }), null);
  contextSeed(view, { provider: "codex" });
  assert.equal(requests.length, 1);
  contextSeed(view, { provider: "cursor" });
  requests[0].resolve({ tokens: 999 });
  await Promise.resolve();
  assert.equal(refreshes, 0);
  requests[1].resolve({ tokens: 24000 });
  await Promise.resolve();
  assert.equal(contextSeed(view, { provider: "cursor" }).tokens, 24000);
  assert.equal(refreshes, 1);
});
