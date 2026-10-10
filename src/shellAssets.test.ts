import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import express from "express";
import { shellAssets } from "./shellAssets.js";

test("shell cache versions follow bytes, compress responses, and revalidate unversioned URLs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-shell-cache-"));
  fs.writeFileSync(path.join(dir, "index.html"), '<script src="./app.js?v=1"></script><script src="/vendor/test.js"></script>');
  fs.writeFileSync(path.join(dir, "app.js"), "// script\n".repeat(300));
  const app = express();
  app.use(shellAssets(dir, { "/vendor/test.js": () => "// vendor" }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const html = await fetch(base);
    assert.equal(html.headers.get("cache-control"), "no-store");
    const markup = await html.text();
    const url = /\.\/app.js\?v=[a-f0-9]+/.exec(markup)![0].slice(1);
    assert.match(markup, /vendor\/test.js\?v=[a-f0-9]{16}/);
    const asset = await fetch(base + url);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(asset.headers.get("content-encoding"), "gzip");
    assert.equal(await asset.text(), "// script\n".repeat(300));
    const etag = asset.headers.get("etag")!;
    const plain = await fetch(base + "/app.js", { headers: { "Accept-Encoding": "identity" } });
    assert.equal(plain.headers.get("cache-control"), "no-cache");
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.equal((await fetch(base + "/app.js", { headers: { "If-None-Match": etag, "Cache-Control": "max-age=0" } })).status, 304);
    assert.equal((await fetch(base + url, { method: "HEAD" })).status, 200);
    fs.writeFileSync(path.join(dir, "app.js"), "// new script");
    const updated = await (await fetch(base)).text();
    assert.ok(!updated.includes(url.slice(1)));
    assert.equal((await fetch(base + url)).headers.get("cache-control"), "no-cache");
    assert.equal((await fetch(base + "/missing.js")).status, 404);
    assert.equal((await fetch(base + "/constructor")).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
