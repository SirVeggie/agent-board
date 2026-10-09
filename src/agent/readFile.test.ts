import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readScopedFile, READ_FILE_MAX_BYTES, READ_FILE_MAX_LINE_CHARS } from "./readFile.js";
import { threadFilesDir } from "./attachments.js";
import type { ThreadWorktree } from "./types.js";

test("scoped reads paginate, enforce modes and scope, and bound bytes and output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-read-test-"));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  const scope = { cwd, mode: "code", approval: "auto" } as const;
  try {
    await fs.writeFile(path.join(cwd, "text.txt"), "one\r\ntwo\r\nthree\r\n");
    const first = await readScopedFile(scope, { path: "text.txt", offset: 2, limit: 1 });
    assert.equal(first.content, "2\ttwo");
    assert.equal(first.totalLines, 3);
    assert.equal(first.nextOffset, 3);
    assert.equal(first.truncated, true);
    const end = await readScopedFile(scope, { path: "text.txt", offset: first.nextOffset });
    assert.equal(end.content, "3\tthree");
    assert.equal(end.nextOffset, null);
    assert.equal((await readScopedFile(scope, { path: "text.txt", offset: 20 })).linesReturned, 0);
    await fs.writeFile(path.join(root, "outside.txt"), "outside");
    for (const mode of ["code", "ask", "plan"] as const) {
      for (const approval of ["ask", "edits", "auto", "full"] as const) {
        const thread = { cwd, mode, approval };
        assert.equal((await readScopedFile(thread, { path: "text.txt" })).linesReturned, 3);
        if (mode === "code" && approval === "full") assert.equal((await readScopedFile(thread, { path: "../outside.txt" })).content, "1\toutside");
        else await assert.rejects(readScopedFile(thread, { path: "../outside.txt" }), /outside the workspace/);
      }
    }
    await assert.rejects(readScopedFile({ ...scope, mode: "board", approval: "full" }, { path: "text.txt" }), /mode/);
    await assert.rejects(readScopedFile(null, { path: "text.txt" }), /mode/);
    await assert.rejects(readScopedFile({ ...scope, cwd: null }, { path: "text.txt" }), /No workspace/);
    // Junctions work without Windows symlink privileges.
    await fs.symlink(root, path.join(cwd, "escape"), "junction");
    await assert.rejects(readScopedFile(scope, { path: "escape/outside.txt" }), /link target/);
    await fs.writeFile(path.join(cwd, "binary"), Buffer.from([0, 1, 2]));
    await assert.rejects(readScopedFile(scope, { path: "binary" }), /Binary/);
    await fs.writeFile(path.join(cwd, "invalid"), Buffer.from([255]));
    await assert.rejects(readScopedFile(scope, { path: "invalid" }), /UTF-8/);
    const listing = await readScopedFile(scope, { path: "." });
    assert.equal(listing.kind, "directory");
    assert.match(listing.content, /\ttext\.txt$/m);
    await fs.mkdir(path.join(cwd, "sub"));
    assert.match((await readScopedFile(scope, { path: "." })).content, /\tsub\/$/m);
    for (const input of [{ offset: 0 }, { offset: 1.5 }, { limit: 0 }, { limit: 1001 }]) {
      await assert.rejects(readScopedFile(scope, { path: "text.txt", ...input }), /offset|limit/);
    }
    await fs.writeFile(path.join(cwd, "long"), Array.from({ length: 20 }, () => "a".repeat(1_990)).join("\n"));
    const bounded = await readScopedFile(scope, { path: "long" });
    assert.equal(bounded.nextOffset, 17);
    assert.ok(bounded.content.length <= 32_000);
    // Sparse: the size check comes before any byte is read.
    await fs.writeFile(path.join(cwd, "huge"), "");
    await fs.truncate(path.join(cwd, "huge"), READ_FILE_MAX_BYTES + 1);
    await assert.rejects(readScopedFile(scope, { path: "huge" }), /64 MiB/);
    await fs.writeFile(path.join(cwd, "longline"), `${"x".repeat(32_001)}\nshort`);
    const cut = await readScopedFile(scope, { path: "longline" });
    assert.equal(cut.content, `1\t${"x".repeat(READ_FILE_MAX_LINE_CHARS)}… [${32_001 - READ_FILE_MAX_LINE_CHARS} more characters]\n2\tshort`);
    assert.match(cut.note, /1 line\(s\) were cut/);
    // Pages past the first stream chunk count lines across chunk edges, including a CRLF split between chunks.
    const many = Array.from({ length: 30_000 }, (_, i) => `line ${i + 1}`).join("\r\n");
    await fs.writeFile(path.join(cwd, "many"), `﻿${many}\r\n`);
    const tail = await readScopedFile(scope, { path: "many", offset: 29_999 });
    assert.equal(tail.totalLines, 30_000);
    assert.equal(tail.content, "29999\tline 29999\n30000\tline 30000");
    assert.equal((await readScopedFile(scope, { path: "many", limit: 1 })).content, "1\tline 1");
    await fs.writeFile(path.join(cwd, "split"), Buffer.concat([Buffer.alloc(64 * 1024 - 1, 97), Buffer.from("\r\nb")]));
    assert.equal((await readScopedFile(scope, { path: "split" })).totalLines, 2);
    await fs.writeFile(path.join(cwd, "blank"), "a\n\n");
    assert.equal((await readScopedFile(scope, { path: "blank" })).totalLines, 2);
  } finally {
    // Remove the junction itself first: never recurse through its target on Windows.
    await fs.unlink(path.join(cwd, "escape")).catch(() => {});
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("scribe-read-test-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recorded worktree links and own attachments are readable without granting adjacent files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-read-roots-"));
  const previousHome = process.env.SCRIBE_HOME;
  process.env.SCRIBE_HOME = path.join(root, "data");
  const cwd = path.join(root, "worktree");
  const repo = path.join(root, "main");
  const dependency = path.join(repo, "node_modules");
  const linked = path.join(cwd, "node_modules");
  const thread = { id: "thread-one", cwd, mode: "ask", approval: "full",
    worktree: { path: cwd, repo, links: ["node_modules"] } as ThreadWorktree } as const;
  try {
    await fs.mkdir(cwd);
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(path.join(dependency, "index.js"), "export default 1;");
    await fs.writeFile(path.join(repo, "private.txt"), "main checkout");
    await fs.symlink(dependency, linked, "junction");
    assert.match((await readScopedFile(thread, { path: "node_modules/index.js" })).content, /export default/);
    assert.match((await readScopedFile(thread, { path: path.join(dependency, "index.js") })).content, /export default/);
    await assert.rejects(readScopedFile(thread, { path: path.join(repo, "private.txt") }), /outside/);
    await assert.rejects(readScopedFile({ ...thread, worktree: null }, { path: "node_modules/index.js" }), /link target/);
    for (const id of [thread.id, "thread-two"]) {
      await fs.mkdir(threadFilesDir(id), { recursive: true });
      await fs.writeFile(path.join(threadFilesDir(id), "attached.txt"), id);
    }
    const attachment = path.join(threadFilesDir(thread.id), "attached.txt");
    assert.match((await readScopedFile(thread, { path: attachment })).content, /thread-one/);
    assert.match((await readScopedFile({ ...thread, cwd: null }, { path: attachment })).content, /thread-one/);
    await assert.rejects(readScopedFile(thread, { path: path.join(threadFilesDir("thread-two"), "attached.txt") }), /outside/);
    await assert.rejects(readScopedFile({ ...thread, mode: "board" }, { path: attachment }), /mode/);
    const escape = path.join(dependency, "escape");
    await fs.symlink(repo, escape, "junction");
    await assert.rejects(readScopedFile(thread, { path: "node_modules/escape/private.txt" }), /link target/);
    await fs.unlink(escape);
    // A link listed by Scribe must still point to its recorded main-checkout counterpart.
    await fs.unlink(linked);
    await fs.symlink(repo, linked, "junction");
    await assert.rejects(readScopedFile(thread, { path: "node_modules/private.txt" }), /link target/);
  } finally {
    if (previousHome === undefined) delete process.env.SCRIBE_HOME;
    else process.env.SCRIBE_HOME = previousHome;
    await fs.unlink(linked).catch(() => {});
    await fs.unlink(path.join(dependency, "escape")).catch(() => {});
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("scribe-read-roots-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});
