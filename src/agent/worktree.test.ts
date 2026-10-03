import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { revertTrees, snapshotTree } from "./git.js";
import { commitAll, createWorktree, dropBranchIfEmpty, headCommit, mergeWorktree, removeWorktree, resetHead, worktreeProgress, worktreeStatus } from "./worktree.js";

let root = "";
let repo = "";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-wt-"));
  process.env.SCRIBE_HOME = path.join(root, "home");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "src", "a.txt"), "one\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "x");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("a worktree branches from HEAD, links node_modules, and keeps the link out of git", async () => {
  fs.writeFileSync(path.join(repo, "src", "a.txt"), "dirty\n");
  const made = await createWorktree(path.join(repo, "src"), repo, "Fix the dropdown!");
  sh(repo, "checkout", "-q", "--", "src/a.txt");
  const wt = made.worktree;
  assert.equal(wt.branch, "agent/fix-the-dropdown");
  assert.equal(wt.base, "main");
  assert.equal(made.cwd, path.join(wt.path, "src"));
  assert.ok(wt.path.startsWith(path.join(root, "home", "worktrees")));
  assert.deepEqual(wt.links, ["node_modules"]);
  assert.ok(fs.existsSync(path.join(wt.path, "node_modules", "dep", "index.js")));
  assert.equal(made.notes.length, 1, "warns that uncommitted main-checkout changes are not carried over");
  assert.equal(fs.readFileSync(path.join(wt.path, "src", "a.txt"), "utf8"), "one\n");
  assert.equal(sh(wt.path, "status", "--porcelain"), "");
  const status = await worktreeStatus(wt);
  assert.deepEqual(status.dirty, []);
  assert.equal(status.ahead, 0);

  // A second thread with the same title gets its own branch and folder.
  const second = await createWorktree(repo, repo, "Fix the dropdown!");
  assert.equal(second.worktree.branch, "agent/fix-the-dropdown-2");
  await removeWorktree(second.worktree);
  assert.ok(await dropBranchIfEmpty(second.worktree));

  // Work, then merge into main.
  fs.writeFileSync(path.join(wt.path, "src", "a.txt"), "two\n");
  assert.deepEqual(await worktreeProgress(wt), { ahead: 0, dirty: true });
  await assert.rejects(mergeWorktree(wt), /uncommitted/);
  assert.ok(await commitAll(wt, "change a"));
  assert.deepEqual(await worktreeProgress(wt), { ahead: 1, dirty: false });
  assert.deepEqual(await mergeWorktree(wt), { commits: 1 });
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "two\n");
  await removeWorktree(wt);
  assert.ok(!fs.existsSync(wt.path));
  assert.ok(fs.existsSync(path.join(repo, "node_modules", "dep", "index.js")), "removing the worktree leaves the linked folder alone");
  assert.ok(await dropBranchIfEmpty(wt));
});

test("merge refuses when the main checkout is on another branch", async () => {
  const { worktree: wt } = await createWorktree(repo, repo, "other");
  fs.writeFileSync(path.join(wt.path, "b.txt"), "b\n");
  await commitAll(wt, "add b");
  sh(repo, "checkout", "-q", "-b", "side");
  await assert.rejects(mergeWorktree(wt), /Switch it to main/);
  sh(repo, "checkout", "-q", "main");
  await removeWorktree(wt);
  assert.equal(await dropBranchIfEmpty(wt), false, "a branch with commits is kept");
  assert.equal(sh(repo, "branch", "--list", wt.branch).replace("*", "").trim(), wt.branch);
});

test("reverting a worktree turn undoes its commits too", async () => {
  const { worktree: wt } = await createWorktree(repo, repo, "revert me");
  const beforeTree = (await snapshotTree(wt.path))!;
  const beforeHead = (await headCommit(wt.path))!;
  fs.writeFileSync(path.join(wt.path, "c.txt"), "c\n");
  await commitAll(wt, "add c");
  fs.writeFileSync(path.join(wt.path, "d.txt"), "d\n");
  const afterTree = (await snapshotTree(wt.path))!;
  assert.deepEqual(await revertTrees(wt.path, beforeTree, afterTree), { ok: true });
  assert.deepEqual(await resetHead(wt.path, beforeHead), { ok: true });
  assert.equal(await headCommit(wt.path), beforeHead);
  assert.ok(!fs.existsSync(path.join(wt.path, "c.txt")));
  assert.ok(!fs.existsSync(path.join(wt.path, "d.txt")));
  assert.equal(sh(wt.path, "status", "--porcelain"), "");
  await removeWorktree(wt);
  assert.ok(await dropBranchIfEmpty(wt));
});
