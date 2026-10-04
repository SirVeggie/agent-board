import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanAllowlist, parseWebAccess, webAllowed } from "./webAccess.js";

test("older boolean web settings read as on and off", () => {
  assert.equal(parseWebAccess(true), "on");
  assert.equal(parseWebAccess(false), "off");
  assert.equal(parseWebAccess("limited"), "limited");
  assert.equal(parseWebAccess("sometimes"), undefined);
});

test("allowlist entries are cleaned to bare domains", () => {
  assert.deepEqual(cleanAllowlist(["https://GitHub.com/foo", " *.npmjs.com ", ".python.org", "example.com:8080", "", "github.com", 3]), [
    "github.com",
    "npmjs.com",
    "python.org",
    "example.com",
  ]);
});

test("a domain allows itself and its subdomains, not look-alikes", () => {
  const list = ["github.com", "docs.rs"];
  assert.ok(webAllowed("https://github.com/x/y", list));
  assert.ok(webAllowed("https://raw.api.github.com/z", list));
  assert.ok(webAllowed("docs.rs", list));
  assert.ok(!webAllowed("https://evilgithub.com", list));
  assert.ok(!webAllowed("https://github.com.evil.io/", list));
  assert.ok(!webAllowed("not a url://", list));
});
