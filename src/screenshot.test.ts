import assert from "node:assert/strict";
import { test } from "node:test";
import { contentBaseUrl } from "./config.js";
import {
  beginCaptureBoot,
  captureBootOf,
  endCaptureBoot,
  parseScreenshotLocal,
  readCaptureBoot,
  screenshotHttpStatus,
  screenshotUrl,
} from "./screenshot.js";

test("parseScreenshotLocal accepts a plain object and rejects junk", () => {
  assert.equal(parseScreenshotLocal(undefined), undefined);
  assert.deepEqual(parseScreenshotLocal({ view: "expanded" }), { view: "expanded" });
  assert.throws(() => parseScreenshotLocal("x"), /local must be a JSON object/);
  assert.throws(() => parseScreenshotLocal([]), /local must be a JSON object/);
  assert.throws(() => parseScreenshotLocal({ big: "x".repeat(70 * 1024) }), /local is too large/);
});

test("screenshotUrl loads embed pages at the embedded URL", () => {
  const tab = {
    id: "t_abc",
    html: `<!DOCTYPE html><html><head><meta name="scribe-embed" content="http://127.0.0.1:8188/"></head><body></body></html>`,
  };
  assert.equal(screenshotUrl(tab), "http://127.0.0.1:8188/");
  assert.equal(screenshotUrl(tab, "deadbeef0123"), "http://127.0.0.1:8188/");
});

test("screenshotUrl points ordinary pages at /view/:id, with a shot query when seeded", () => {
  const tab = { id: "t_abc", html: "<p>hi</p>" };
  assert.equal(screenshotUrl(tab), `${contentBaseUrl()}/view/t_abc`);
  assert.equal(screenshotUrl(tab, "deadbeef0123"), `${contentBaseUrl()}/view/t_abc?shot=deadbeef0123`);
});

test("capture boot is readable until ended, and junk ids miss", () => {
  const id = beginCaptureBoot({ view: "idle" });
  assert.match(id, /^[a-f0-9]{12}$/);
  assert.deepEqual(readCaptureBoot(id), { local: { view: "idle" } });
  assert.deepEqual(captureBootOf(id), { local: { view: "idle" } });
  assert.equal(captureBootOf("not-a-shot"), undefined);
  assert.equal(captureBootOf(1), undefined);
  endCaptureBoot(id);
  assert.equal(readCaptureBoot(id), undefined);
});

test("screenshotHttpStatus maps local and click errors to 400", () => {
  assert.equal(screenshotHttpStatus("tab not found: x"), 404);
  assert.equal(screenshotHttpStatus("selector not found: .x"), 400);
  assert.equal(screenshotHttpStatus("click selector not found: .x"), 400);
  assert.equal(screenshotHttpStatus("click selector is not visible: .x"), 400);
  assert.equal(screenshotHttpStatus("local must be a JSON object"), 400);
  assert.equal(screenshotHttpStatus("local is too large (max 65536 bytes)"), 400);
  assert.equal(screenshotHttpStatus("local and fromViewer do not apply to embed pages; the capture loads the embedded URL directly"), 400);
});
