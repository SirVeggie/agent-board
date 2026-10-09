import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bridgeAsks } from "./mcpBridge.js";
import { applyImport, bridgedToolName, cleanFile, cleanServer, expandEnv, importCandidates, readMcpFile, serversForThread, writeMcpFile } from "./mcpConfig.js";

const thread = (mode: "code" | "ask" | "plan" | "board", cwd: string | null = null) => ({ mode, cwd, worktree: null });

test("cleanServer keeps known fields and reads other apps' shapes", () => {
  assert.deepEqual(cleanServer({ command: "npx", args: ["-y", "x"], env: { A: 1 }, foo: "bar" }), { command: "npx", args: ["-y", "x"], env: { A: "1" } });
  assert.deepEqual(cleanServer({ type: "streamable-http", url: "https://x/mcp" }), { url: "https://x/mcp", type: "http" });
  assert.equal(cleanServer({ command: "x", disabled: true })?.enabled, false);
  assert.equal(cleanServer({ args: ["x"] }), null);
  assert.deepEqual(cleanServer({ enabled: false }), { enabled: false });
});

test("servers reach threads by mode, enabled, and workspace layer", () => {
  const file = cleanFile({
    mcpServers: {
      docs: { command: "docs" },
      board: { command: "b", modes: ["board", "code"] },
      off: { command: "o", enabled: false },
      shared: { command: "global" },
    },
    workspaces: {
      "S:\\Proj": { mcpServers: { shared: { command: "local" }, docs: { enabled: false }, db: { command: "db", approve: "auto" } } },
    },
  });
  const names = (mode: "code" | "ask" | "plan" | "board", cwd: string | null) => serversForThread(thread(mode, cwd), file).map((s) => s.name).sort();
  assert.deepEqual(names("code", null), ["board", "docs", "shared"]);
  assert.deepEqual(names("board", null), ["board"]);
  assert.deepEqual(names("code", "s:/proj/sub"), ["board", "db", "shared"]);
  assert.deepEqual(names("code", "S:\\Projector"), ["board", "docs", "shared"]);
  const shared = serversForThread(thread("ask", "S:\\Proj"), file).find((s) => s.name === "shared");
  assert.equal(shared?.command, "local");
  assert.equal(shared?.layer, "S:\\Proj");
  assert.equal(serversForThread(thread("code", "S:\\Proj"), file).find((s) => s.name === "db")?.approve, "auto");
});

test("a worktree thread gets its home workspace's servers", () => {
  const file = cleanFile({ workspaces: { "S:\\Proj": { mcpServers: { db: { command: "db" } } } } });
  const wt = { mode: "code" as const, cwd: "C:\\wt\\x", worktree: { home: "S:\\Proj", repo: "S:\\Proj", path: "C:\\wt\\x", branch: "b", base: "master", baseCommit: "", links: [], createdAt: 0 } };
  assert.deepEqual(serversForThread(wt, file).map((s) => s.name), ["db"]);
});

test("reserved and odd names are dropped", () => {
  const file = cleanFile({ mcpServers: { scribe: { command: "x" }, "bad name": { command: "x" }, ok: { command: "x" } } });
  assert.deepEqual(Object.keys(file.mcpServers), ["ok"]);
});

test("env expansion and tool names", () => {
  assert.equal(expandEnv("a ${FOO} ${env:FOO} ${NOPE}", { FOO: "1" }), "a 1 1 ");
  assert.equal(bridgedToolName("my.server", "do thing"), "my_server__do_thing");
  assert.equal(bridgedToolName("s", "x".repeat(80)).length, 64);
});

test("approval: ask unless full access or the server runs without asking", () => {
  assert.equal(bridgeAsks({ approval: "ask" }, { approve: "ask" }), true);
  assert.equal(bridgeAsks({ approval: "auto" }, { approve: "ask" }), true);
  assert.equal(bridgeAsks({ approval: "full" }, { approve: "ask" }), false);
  assert.equal(bridgeAsks({ approval: "ask" }, { approve: "auto" }), false);
});

test("import lists other apps' servers and applies the picked ones", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-mcp-"));
  const ws = path.join(home, "proj");
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { a: { command: "a" } }, projects: { [ws]: { mcpServers: { b: { type: "sse", url: "http://b" } } } } }));
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "a2" }, c: { url: "http://c" } } }));
  fs.writeFileSync(path.join(ws, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { d: { command: "d" } } }));
  const current = cleanFile({ mcpServers: { c: { command: "mine" } } });
  const found = importCandidates([ws], current, home);
  const ids = found.map((c) => `${c.source}:${c.scope === "global" ? "g" : "w"}:${c.name}${c.exists ? "!" : ""}`).sort();
  assert.deepEqual(ids, ["claude:g:a", "claude:w:b", "cursor:g:a", "cursor:g:c!", "cursor:w:d"]);
  const next = applyImport(current, found.filter((c) => c.name !== "c"));
  assert.deepEqual(Object.keys(next.mcpServers).sort(), ["a", "c"]);
  assert.equal(next.mcpServers.c.command, "mine");
  const file = path.join(home, "mcp.json");
  writeMcpFile(next, file);
  const back = readMcpFile(file);
  assert.deepEqual(Object.keys(Object.values(back.workspaces)[0].mcpServers).sort(), ["b", "d"]);
  fs.rmSync(home, { recursive: true, force: true });
});
