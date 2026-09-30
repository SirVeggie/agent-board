import assert from "node:assert/strict";
import { test } from "node:test";
import { framingVerdict } from "./frameCheck.js";

const BOARD = "http://127.0.0.1:4747";

function framable(xfo: string | null, csp: string | null): boolean | null {
  return framingVerdict(xfo, csp, BOARD).framable;
}

test("no framing headers allow the board to frame the site", () => {
  assert.equal(framable(null, null), true);
  assert.equal(framable(null, "default-src 'self'; script-src 'self'"), true);
});

test("X-Frame-Options DENY and SAMEORIGIN block, in any case", () => {
  assert.equal(framable("DENY", null), false);
  assert.equal(framable("sameorigin", null), false);
  assert.equal(framable("SAMEORIGIN, SAMEORIGIN", null), false);
  assert.equal(framable("ALLOW-FROM https://example.com", null), true);
});

test("frame-ancestors decides and overrides X-Frame-Options", () => {
  assert.equal(framable(null, "frame-ancestors 'none'"), false);
  assert.equal(framable(null, "frame-ancestors 'self'"), false);
  assert.equal(framable(null, "frame-ancestors *"), true);
  assert.equal(framable("DENY", "frame-ancestors *"), true);
  assert.equal(framable(null, "frame-ancestors https://example.com"), false);
});

test("frame-ancestors host sources match the board's origin", () => {
  assert.equal(framable(null, "frame-ancestors http://127.0.0.1:4747"), true);
  assert.equal(framable(null, "frame-ancestors 127.0.0.1:4747"), true);
  assert.equal(framable(null, "frame-ancestors http://127.0.0.1:*"), true);
  assert.equal(framable(null, "frame-ancestors http://127.0.0.1"), false);
  assert.equal(framable(null, "frame-ancestors http:"), true);
  assert.equal(framable(null, "frame-ancestors https:"), false);
});

test("every policy must allow framing", () => {
  assert.equal(framable(null, "frame-ancestors *, frame-ancestors 'none'"), false);
  assert.equal(framable(null, "default-src 'self', frame-ancestors *"), true);
});
