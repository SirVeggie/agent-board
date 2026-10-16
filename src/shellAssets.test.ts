import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import express from "express";
import { shellAssets } from "./shellAssets.js";
import { contentOriginGate } from "./contentOrigin.js";
import { CONTENT_HOST } from "./config.js";
import { fileURLToPath } from "node:url";

test("content origin serves the injected tooltip script while rejecting other shell resources", async () => {
  const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
  const app = express();
  app.use(contentOriginGate);
  app.use(shellAssets(publicDir, {}));
  app.use(express.static(publicDir));
  // A sentinel catches requests accidentally allowed through the gate.
  app.use((_req, res) => { res.status(200).send("passed gate"); });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, CONTENT_HOST, resolve));
  const base = `http://${CONTENT_HOST}:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(base + "/tooltip.js?v=3");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /javascript/);
    assert.equal(await response.text(), fs.readFileSync(path.join(publicDir, "tooltip.js"), "utf8"));
    // The file viewer's shared libraries pass the gate (#654); other vendor files do not.
    for (const url of ["/vendor/highlight.js", "/vendor/marked.js", "/vendor/purify.js", "/vendor/pdfjs/build/pdf.min.mjs", "/vendor/pdfjs/build/pdf.worker.min.mjs", "/vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap", "/vendor/pdfjs/wasm/openjpeg.wasm"]) {
      assert.equal((await fetch(base + url)).status, 200, url);
    }
    for (const url of ["/app.js", "/app.css", "/vendor/other.js", "/vendor/marked.js/x", "/vendor/pdfjs/package.json", "/vendor/pdfjs/build/pdf.mjs.map", "/vendor/pdfjs/cmaps/../package.json", "/vendor/pdfjs/web/pdf_viewer.mjs", "/api/tabs", "/api/tabs/t_1/file", "/api/agent/threads", "/api/appearance", "/api/appearance/bootstrap.js", "/tooltip.js/extra", "/Tooltip.js"]) {
      assert.equal((await fetch(base + url)).status, 403, url);
    }
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      assert.equal((await fetch(base + "/tooltip.js?v=3", { method })).status, 403, method);
    }
    assert.equal((await fetch(base + "/view/test-page")).status, 200);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

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
