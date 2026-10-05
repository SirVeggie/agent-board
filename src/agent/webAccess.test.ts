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

test("web calls: the setting, the allowlist and the thread's grants", async () => {
  const { webCallAllowed, grantWeb, webPassCovers, parseWebImportance } = await import("./webAccess.js");
  const fetch = (url: string) => ({ kind: "fetch" as const, url });
  assert.ok(webCallAllowed(fetch("https://x.io"), "on", [], undefined));
  assert.ok(!webCallAllowed(fetch("https://x.io"), "off", ["x.io"], undefined));
  assert.ok(webCallAllowed(fetch("https://x.io"), "limited", ["x.io"], undefined));
  assert.ok(!webCallAllowed({ kind: "search", query: "q" }, "limited", ["x.io"], undefined));
  assert.ok(webCallAllowed({ kind: "search", domains: ["x.io"] }, "limited", ["x.io"], undefined));
  const grants = grantWeb(undefined, "domain", fetch("https://www.Example.com/a"));
  assert.deepEqual(grants, { domains: ["example.com"] });
  assert.ok(webCallAllowed(fetch("https://api.example.com"), "off", [], grants));
  assert.ok(webCallAllowed({ kind: "search", query: "q" }, "off", [], grantWeb(grants, "session", fetch("https://y.io"))));
  assert.ok(webPassCovers(fetch("https://a.io/1"), fetch("https://a.io/2")));
  assert.ok(!webPassCovers(fetch("https://a.io/1"), fetch("https://b.io/")));
  assert.ok(webPassCovers({ kind: "search" }, { kind: "search", query: "q" }));
  assert.equal(parseWebImportance("trivial"), "trivial");
  assert.equal(parseWebImportance("urgent"), undefined);
});
