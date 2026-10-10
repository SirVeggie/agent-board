import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bridgeAsks } from "./mcpBridge.js";
import { applyImport, removeCursorImports, bridgedToolName, claudeOwnServers, cleanFile, cleanServer, expandEnv, importCandidates, readMcpFile, serversForThread, writeMcpFile } from "./mcpConfig.js";

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
  const names = (mode: "code" | "ask" | "plan" | "board", cwd: string | null) => serversForThread(thread(mode, cwd), file, null).map((s) => s.name).sort();
  assert.deepEqual(names("code", null), ["board", "docs", "shared"]);
  assert.deepEqual(names("board", null), ["board"]);
  assert.deepEqual(names("code", "s:/proj/sub"), ["board", "db", "shared"]);
  assert.deepEqual(names("code", "S:\\Projector"), ["board", "docs", "shared"]);
  const shared = serversForThread(thread("ask", "S:\\Proj"), file, null).find((s) => s.name === "shared");
  assert.equal(shared?.command, "local");
  assert.equal(shared?.layer, "S:\\Proj");
  assert.equal(serversForThread(thread("code", "S:\\Proj"), file, null).find((s) => s.name === "db")?.approve, "auto");
});

test("a worktree thread gets its home workspace's servers", () => {
  const file = cleanFile({ workspaces: { "S:\\Proj": { mcpServers: { db: { command: "db" } } } } });
  const wt = { mode: "code" as const, cwd: "C:\\wt\\x", worktree: { home: "S:\\Proj", repo: "S:\\Proj", path: "C:\\wt\\x", branch: "b", base: "master", baseCommit: "", links: [], createdAt: 0 } };
  assert.deepEqual(serversForThread(wt, file, null).map((s) => s.name), ["db"]);
});

test("Code chats inherit only Keeper, using the home workspace for worker worktrees", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-keeper-"));
  const ws = path.join(home, "proj");
  const sharedWs = path.join(home, "shared");
  fs.mkdirSync(ws);
  fs.mkdirSync(sharedWs);
  try {
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
      mcpServers: { keeper: { command: "global", approve: "auto" }, unrelated: { command: "other" } },
      projects: { [ws]: { mcpServers: { keeper: { command: "project" } } } },
    }));
    fs.writeFileSync(path.join(sharedWs, ".mcp.json"), JSON.stringify({ mcpServers: { keeper: { url: "http://localhost/mcp" } } }));
    const empty = cleanFile({});
    const global = serversForThread(thread("code"), empty, home);
    assert.deepEqual(global.map((s) => s.name), ["keeper"]);
    assert.equal(global[0].command, "global");
    assert.equal(global[0].approve, "ask");
    for (const mode of ["ask", "plan", "board"] as const) {
      assert.deepEqual(serversForThread(thread(mode, ws), empty, home), []);
    }
    const wt = { ...thread("code", path.join(home, "worktree")), worktree: { home: ws, repo: ws, path: path.join(home, "worktree"), branch: "worker", base: "master", baseCommit: "", links: [], createdAt: 0 } };
    assert.equal(serversForThread(wt, empty, home)[0].command, "project");
    assert.equal(serversForThread(thread("code", sharedWs), empty, home)[0].url, "http://localhost/mcp");

    const custom = cleanFile({ mcpServers: { keeper: { command: "scribe", approve: "auto" } } });
    assert.equal(serversForThread(wt, custom, home)[0].command, "scribe");
    assert.equal(serversForThread(wt, custom, home)[0].approve, "auto");
    for (const keeper of [{ enabled: false }, { command: "scribe", modes: ["ask"] }]) {
      assert.deepEqual(serversForThread(wt, cleanFile({ mcpServers: { keeper } }), home), []);
      assert.deepEqual(serversForThread(wt, cleanFile({ workspaces: { [ws]: { mcpServers: { keeper } } } }), home), []);
    }
    const disabledWs = path.join(home, "disabled");
    fs.mkdirSync(disabledWs);
    fs.writeFileSync(path.join(disabledWs, ".mcp.json"), JSON.stringify({ mcpServers: { keeper: { disabled: true } } }));
    assert.deepEqual(serversForThread(thread("code", disabledWs), empty, home), []);
    assert.deepEqual(serversForThread(thread("code"), empty, path.join(home, "absent")), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
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


test("Cursor cleanup backs up global and workspace files and preserves unselected and unknown fields", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-cursor-cleanup-"));
  try {
    const ws = path.join(home, "project");
    const files = [home, ws].map((dir) => path.join(dir, ".cursor", "mcp.json"));
    const original = '{\r\n  "other": {"keep": true}, "mcpServers": {"take": {"command": "take", "cursorOnly": 42}, "leave": {"command": "leave", "unknown": true}}\r\n}\r\n';
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, original);
    }
    const picked = importCandidates([ws], cleanFile({}), home).filter((c) => c.name === "take");
    const current = applyImport(cleanFile({}), picked);
    const results = removeCursorImports(picked, current, home);
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.error, undefined);
      assert.deepEqual(result.names, ["take"]);
      assert.equal(fs.readFileSync(result.backup!, "utf8"), original);
      assert.deepEqual(JSON.parse(fs.readFileSync(result.file, "utf8")), {
        other: { keep: true }, mcpServers: { leave: { command: "leave", unknown: true } },
      });
    }
    assert.equal(current.mcpServers.take.command, "take");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cursor cleanup refuses changed source files, changed Scribe copies and unrelated paths", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-cursor-cleanup-"));
  try {
    const file = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file));
    const original = JSON.stringify({ mcpServers: { take: { command: "take" } } });
    fs.writeFileSync(file, original);
    const picked = importCandidates([], cleanFile({}), home);
    const current = applyImport(cleanFile({}), picked);
    fs.writeFileSync(file, original + "\n");
    assert.match(removeCursorImports(picked, current, home)[0].error!, /file changed/);
    assert.equal(fs.readFileSync(file, "utf8"), original + "\n");
    fs.writeFileSync(file, original);
    current.mcpServers.take.command = "edited";
    assert.match(removeCursorImports(picked, current, home)[0].error!, /no longer matches/);
    assert.throws(() => removeCursorImports([{ ...picked[0], file: path.join(home, "other.json") }], current, home), /Not a Cursor/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["mcp.json"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("claudeOwnServers names what Claude Code would load in a workspace", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-claude-own-"));
  const ws = path.join(home, "proj");
  fs.mkdirSync(ws);
  assert.deepEqual(claudeOwnServers(ws, home), []);
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { keeper: { command: "k" }, scribe: { command: "s" } },
    projects: { [ws]: { mcpServers: { local: { command: "l" } } }, [path.join(home, "other")]: { mcpServers: { nope: { command: "n" } } } },
  }));
  fs.writeFileSync(path.join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { url: "http://s" }, keeper: { command: "k2" } } }));
  assert.deepEqual(claudeOwnServers(ws, home).sort(), ["keeper", "local", "shared"]);
  assert.deepEqual(claudeOwnServers(null, home), ["keeper"]);
  fs.rmSync(home, { recursive: true, force: true });
});
