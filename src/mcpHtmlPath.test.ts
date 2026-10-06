import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readHtmlPath, resolveShowHtml } from "./mcp.js";

function withTempHtml(name: string, body: string, fn: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-htmlpath-"));
  const file = path.join(dir, name);
  try {
    fs.writeFileSync(file, body, "utf8");
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("readHtmlPath strips a BOM and returns the file", () => {
  withTempHtml("page.html", "\uFEFF<h1>Hi</h1>", (file) => {
    assert.deepEqual(readHtmlPath(file), { html: "<h1>Hi</h1>" });
  });
});

test("readHtmlPath reports a missing file", () => {
  const missing = path.join(os.tmpdir(), "scribe-htmlpath-missing", "nope.html");
  const result = readHtmlPath(missing);
  assert.ok("error" in result);
  assert.match(result.error, /^Could not read htmlPath:/);
});

test("resolveShowHtml takes html or htmlPath, not both or neither", () => {
  assert.deepEqual(resolveShowHtml("<p>a</p>", undefined), { html: "<p>a</p>" });
  assert.deepEqual(resolveShowHtml("", undefined), { html: "" });
  assert.deepEqual(resolveShowHtml(undefined, undefined), { error: "Provide html or htmlPath" });
  withTempHtml("page.html", "<p>from file</p>", (file) => {
    assert.deepEqual(resolveShowHtml(undefined, file), { html: "<p>from file</p>" });
    assert.deepEqual(resolveShowHtml("<p>a</p>", file), { error: "Pass either html or htmlPath, not both" });
  });
});
