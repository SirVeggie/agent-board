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

test("SearXNG addresses are cleaned to a base URL", async () => {
  const { cleanSearxngUrl } = await import("./webAccess.js");
  assert.equal(cleanSearxngUrl(" http://box:8080/ "), "http://box:8080");
  assert.equal(cleanSearxngUrl("https://s.example.com/searx/search?q=x"), "https://s.example.com/searx");
  assert.equal(cleanSearxngUrl("ftp://box"), "");
  assert.equal(cleanSearxngUrl("not a url"), "");
});

test("web_search through SearXNG: open search keeps to the allowlist, named domains ask", async () => {
  const { gatedSearchText } = await import("./webAccess.js");
  const queries: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    queries.push(url.searchParams.get("q") ?? "");
    assert.equal(url.searchParams.get("format"), "json");
    return new Response(
      JSON.stringify({
        results: [
          { url: "https://docs.python.org/3/x", title: "Py", content: "snippet" },
          { url: "https://evil.example/y", title: "Evil" },
        ],
      })
    );
  }) as typeof fetch;
  try {
    const asked: unknown[] = [];
    const limited = { allowed: () => false, reach: () => ["python.org"], ask: async (call: unknown) => (asked.push(call), { allowed: false, message: "no" }) };
    const open = await gatedSearchText("http://sx", { query: "asyncio" }, limited);
    assert.equal(open.isError, false);
    assert.equal(queries.at(-1), "asyncio site:python.org");
    assert.match(open.text, /docs\.python\.org/);
    assert.doesNotMatch(open.text, /evil/);
    assert.equal(asked.length, 0);

    const refused = await gatedSearchText("http://sx", { query: "x", domains: ["evil.example"] }, limited);
    assert.ok(refused.isError);
    assert.match(refused.text, /Refused: no/);
    assert.equal(asked.length, 1);

    const full = await gatedSearchText("http://sx", { query: "x" }, { allowed: () => true, reach: () => [], ask: async () => ({ allowed: false }) });
    assert.equal(queries.at(-1), "x");
    assert.match(full.text, /evil\.example/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
