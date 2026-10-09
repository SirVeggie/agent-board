import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import type { ThreadWorktree } from "./agent/types.js";
import { isLoopback, worktreePreviewRouter } from "./worktreePreview.js";

test("preview accepts only loopback addresses", () => {
  for (const addr of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopback(addr), true);
  for (const addr of [undefined, "192.168.1.2", "::ffff:192.168.1.2", "127.0.0.1.attacker"]) assert.equal(isLoopback(addr), false);
});

test("preview serves current registered public files and confines requests to that root", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scribe-preview-"));
  const root = path.join(dir, "tree");
  const publicDir = path.join(root, "public");
  await fs.mkdir(publicDir, { recursive: true });
  const shell = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  await fs.writeFile(path.join(publicDir, "index.html"), shell);
  await fs.writeFile(path.join(publicDir, "agent.css"), "worktree CSS");
  await fs.writeFile(path.join(publicDir, ".secret"), "hidden");
  await fs.writeFile(path.join(root, "secret.txt"), "outside");
  const wt: ThreadWorktree = { home: root, repo: root, path: root, branch: "agent/test", base: "master", baseCommit: "abc", links: [], createdAt: 0 };
  const app = express();
  app.use("/preview", worktreePreviewRouter(id => id === "t_registered" ? wt : null));
  app.get("/agent.css", (_req, res) => res.send("main CSS"));
  app.get("/preview.js", (_req, res) => res.send("main preview component"));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const prefix = "/preview/t_registered/";
  const request = (route: string, method = "GET") => new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    // Preserve raw dot segments: passing a URL would normalize them before sending.
    const req = http.request({ hostname: "127.0.0.1", port: (server.address() as { port: number }).port, path: route, method }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, text, headers: res.headers }));
    });
    req.on("error", reject); req.end();
  });
  try {
    const redirect = await request("/preview/t_registered");
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, prefix);
    const index = await request(prefix);
    assert.equal(index.status, 200);
    assert.equal(index.text, shell, "serves the actual worktree shell without a copied fixture");
    const assets = [...shell.matchAll(/(?:src|href)="([^" ]+)"/g)].map(match => match[1]);
    for (const asset of assets.filter(url => /\.(css|js|svg)(\?|$)/.test(url) && !url.startsWith("/vendor/"))) {
      assert.equal(new URL(asset, base + prefix).pathname.startsWith(prefix), true, asset);
    }
    const css = await request(prefix + "agent.css?v=1");
    assert.equal(css.text, "worktree CSS");
    assert.equal(css.headers["cache-control"], "no-store");
    assert.match(css.headers["content-type"]!, /text\/css/);
    await fs.writeFile(path.join(publicDir, "agent.css"), "edited CSS");
    assert.equal((await request(prefix + "agent.css")).text, "edited CSS");
    assert.equal((await request("/agent.css")).text, "main CSS");
    assert.equal((await request("/preview.js")).text, "main preview component");
    for (const file of [".secret", "../secret.txt", "%2e%2e/secret.txt", "..%5csecret.txt", "agent.css%3astream", "missing.css"]) {
      assert.equal((await request(prefix + file)).status, 404, file);
    }
    assert.equal((await request("/preview/unregistered/agent.css")).status, 404);
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) assert.equal((await request(prefix + "agent.css", method)).status, 405);
    // Directory junctions work on Windows without symlink privileges.
    await fs.symlink(root, path.join(publicDir, "escape"), "junction");
    assert.equal((await request(prefix + "escape/secret.txt")).status, 404);
    await fs.unlink(path.join(publicDir, "escape"));
    // The public directory itself must not be a junction outside the worktree.
    await fs.rename(publicDir, path.join(root, "saved-public"));
    await fs.symlink(dir, publicDir, "junction");
    assert.equal((await request(prefix + "tree/secret.txt")).status, 404);
    await fs.unlink(publicDir);
    await fs.rename(path.join(root, "saved-public"), publicDir);
    wt.closed = { how: "merged", at: Date.now() };
    assert.equal((await request(prefix + "agent.css")).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    // Cut any junctions even when an assertion fails before its cleanup.
    const publicStat = await fs.lstat(publicDir).catch(() => null);
    if (publicStat?.isSymbolicLink()) await fs.unlink(publicDir);
    else await fs.unlink(path.join(publicDir, "escape")).catch(() => undefined);
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith("scribe-preview-"));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
