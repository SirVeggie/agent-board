import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

process.env.SCRIBE_AGENT_BROWSER_HEADLESS = "1";

const {
  allowedBrowserUrl,
  browserAct,
  browserConsole,
  browserEval,
  browserHttpStatus,
  browserNetwork,
  browserOpen,
  browserScreenshot,
  browserSessions,
  browserSnapshot,
  browserTabs,
  closeAgentBrowser,
  closeThreadBrowser,
  resolveBrowserUrl,
} = await import("./browser.js");

test("allowedBrowserUrl lets loopback through and nothing else", () => {
  for (const url of [
    "http://localhost:5173/",
    "http://app.localhost/",
    "https://127.0.0.1:8443/x",
    "http://127.0.0.2:4747/view/t_1",
    "http://[::1]:3000/",
    "about:blank",
  ]) {
    assert.equal(allowedBrowserUrl(url), true, url);
  }
  for (const url of [
    "https://example.com/",
    "http://192.168.1.10/",
    "http://localhost.evil.com/",
    "file:///C:/Windows/win.ini",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(allowedBrowserUrl(url), false, url);
  }
});

test("resolveBrowserUrl adds http:// to bare hosts", () => {
  assert.equal(resolveBrowserUrl({ url: "localhost:5173" }), "http://localhost:5173");
  assert.equal(resolveBrowserUrl({ url: "127.0.0.1:3000/a" }), "http://127.0.0.1:3000/a");
  assert.equal(resolveBrowserUrl({ url: "https://localhost/" }), "https://localhost/");
  assert.equal(resolveBrowserUrl({ url: "about:blank" }), "about:blank");
  assert.throws(() => resolveBrowserUrl({}), /Provide url or key/);
});

test("browserHttpStatus maps errors", () => {
  assert.equal(browserHttpStatus("no browser tab is open for this thread"), 404);
  assert.equal(browserHttpStatus("Could not launch a Chromium browser (Agent)."), 503);
  assert.equal(browserHttpStatus("locator.click: Timeout 8000ms exceeded."), 504);
  assert.equal(browserHttpStatus("The agent browser only opens loopback addresses"), 400);
});

const FIXTURE = `<!DOCTYPE html><html><head><title>Fixture</title></head><body>
<h1>Counter</h1>
<label>Name <input id="name"></label>
<button id="inc" onclick="count.textContent = String(Number(count.textContent) + 1); console.log('clicked ' + count.textContent)">Add one</button>
<output id="count">0</output>
<button onclick="fetch('/missing'); throw new Error('boom')">Break</button>
<a href="https://example.com/">Away</a>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(FIXTURE);
    return;
  }
  res.writeHead(404);
  res.end("nope");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  await closeAgentBrowser();
  server.close();
});

let launched = true;

test("a thread opens a page, acts on refs, and reads console and network", async (t) => {
  let opened;
  try {
    opened = await browserOpen("thr_a", { url: `${base}/` });
  } catch (err) {
    if ((err as Error).message.includes("Could not launch")) {
      launched = false;
      t.skip("no Chromium browser installed");
      return;
    }
    throw err;
  }
  assert.equal(opened.tab, "b1");
  assert.equal(opened.title, "Fixture");
  assert.ok("snapshot" in opened && opened.snapshot);
  const ref = /button "Add one" \[ref=(e\d+)\]/.exec(opened.snapshot as string)?.[1];
  assert.ok(ref, opened.snapshot as string);

  const clicked = await browserAct("thr_a", { action: "click", ref });
  assert.match(clicked.snapshot as string, /status \[ref=e\d+\]: "1"/);
  assert.equal(await browserEval("thr_a", { script: "document.getElementById('count').textContent" }).then((r) => r.result), '"1"');

  await browserAct("thr_a", { action: "fill", selector: "#name", value: "Ada" });
  assert.equal((await browserEval("thr_a", { script: "return document.getElementById('name').value" })).result, '"Ada"');

  const broke = await browserAct("thr_a", { action: "click", text: "Break", snapshot: false });
  assert.ok(broke.consoleErrors?.some((line) => /boom/.test(line)), JSON.stringify(broke));

  const logs = await browserConsole("thr_a", { pattern: "clicked" });
  assert.deepEqual(
    logs.messages.map((row) => row.text),
    ["clicked 1"]
  );
  const failed = await browserNetwork("thr_a", { failedOnly: true });
  assert.ok(failed.requests.some((row) => row.url.endsWith("/missing") && row.status === 404), JSON.stringify(failed));

  const shot = await browserScreenshot("thr_a", { selector: "h1" });
  assert.equal(shot.mimeType, "image/png");
  assert.ok(shot.bytes > 0);

  const part = await browserSnapshot("thr_a", { selector: "h1" });
  assert.match(part.snapshot as string, /Counter/);
});

test("links off loopback are blocked, and threads get their own browser", async (t) => {
  if (!launched) {
    t.skip("no Chromium browser installed");
    return;
  }
  await assert.rejects(browserOpen("thr_a", { url: "https://example.com/" }), /only opens loopback/);
  await browserAct("thr_a", { action: "click", text: "Away", snapshot: false }).catch(() => undefined);
  const { result } = await browserEval("thr_a", { script: "location.host" });
  assert.notEqual(result, '"example.com"');

  await assert.rejects(browserSnapshot("thr_b", {}), /call browser_open first/);
  await browserOpen("thr_b", { url: `${base}/`, snapshot: false });
  assert.equal((await browserEval("thr_b", { script: "document.getElementById('count').textContent" })).result, '"0"');
  assert.equal(browserSessions().length, 2);

  await browserOpen("thr_b", { url: `${base}/`, newTab: true, snapshot: false });
  assert.deepEqual(
    (await browserTabs("thr_b", {})).tabs.map((tab) => [tab.tab, tab.current]),
    [
      ["b1", false],
      ["b2", true],
    ]
  );
  await browserTabs("thr_b", { close: "b2" });
  assert.deepEqual((await browserTabs("thr_b", {})).tabs.map((tab) => tab.tab), ["b1"]);

  await closeThreadBrowser("thr_b");
  assert.deepEqual(
    browserSessions().map((session) => session.threadId),
    ["thr_a"]
  );
});
