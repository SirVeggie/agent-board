import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { rankWorkspaceFiles, searchWorkspaceFiles } from "./workspaceFiles.js";

test("rankWorkspaceFiles prefers basename matches and shallow paths", () => {
  const paths = ["README.md", "src/agent/types.ts", "src/agent/prompt.ts", "docs/readme.md", "public/agent.js"];
  assert.deepEqual(
    rankWorkspaceFiles(paths, "types", 5).map((h) => h.path),
    ["src/agent/types.ts"]
  );
  assert.deepEqual(
    rankWorkspaceFiles(paths, "agent", 5).map((h) => h.path),
    ["public/agent.js", "src/agent/prompt.ts", "src/agent/types.ts"]
  );
  assert.deepEqual(
    rankWorkspaceFiles(paths, "", 2).map((h) => h.path),
    ["README.md", "docs/readme.md"]
  );
  assert.equal(rankWorkspaceFiles(paths, "nope", 10).length, 0);
});

test("rankWorkspaceFiles requires every query word", () => {
  const paths = ["src/agent/prompt.ts", "src/store.ts"];
  assert.deepEqual(
    rankWorkspaceFiles(paths, "agent prompt", 5).map((h) => h.path),
    ["src/agent/prompt.ts"]
  );
});

let root = "";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-wsfiles-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("searchWorkspaceFiles uses git and skips ignored paths", async () => {
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nsecret.txt\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "a\n");
  fs.writeFileSync(path.join(repo, "src", "b.ts"), "b\n");
  fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "x\n");
  fs.writeFileSync(path.join(repo, "secret.txt"), "nope\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(repo, "src", "new.ts"), "new\n");

  const hits = await searchWorkspaceFiles(repo, "ts", 10);
  assert.deepEqual(
    hits.map((h) => h.path).sort(),
    ["src/a.ts", "src/b.ts", "src/new.ts"]
  );
  assert.ok(!hits.some((h) => h.path.includes("node_modules") || h.path === "secret.txt"));

  const inSrc = await searchWorkspaceFiles(path.join(repo, "src"), "a", 10);
  assert.deepEqual(
    inSrc.map((h) => h.path),
    ["a.ts"]
  );
});

test("searchWorkspaceFiles walks a folder that is not a git repo", async () => {
  const dir = path.join(root, "plain");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "top.txt"), "t\n");
  fs.writeFileSync(path.join(dir, "lib", "util.js"), "u\n");
  fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "x\n");
  const hits = await searchWorkspaceFiles(dir, "", 10);
  assert.deepEqual(
    hits.map((h) => h.path).sort(),
    ["lib/util.js", "top.txt"]
  );
  assert.deepEqual(await searchWorkspaceFiles(path.join(dir, "missing"), "x", 10), []);
  assert.deepEqual(await searchWorkspaceFiles("", "x", 10), []);
});
