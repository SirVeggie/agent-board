import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";
import { BOARD_BRIDGE_JS } from "./bridge.js";

const BOOT = { id: "page", state: { cards: [{ id: "a", title: "A" }, { id: "b", title: "B" }] }, stateRevision: 1 };

const PAGE = `<script>window.__SCRIBE_BOOT__=${JSON.stringify(BOOT)};</script><script>${BOARD_BRIDGE_JS}</script>
<script>
  window.seen = [];
  window.seenLocal = [];
  var first = scribe.state.cards;
  scribe.onChange(function (state, info) { seen.push({ source: info.source, ops: info.ops, keptB: state.cards[1] === first[1] }); });
  scribe.onChange(function (state, info) { seenLocal.push({ source: info.source, ops: info.ops }); }, { local: true });
</script>`;

test("onChange tells the page the source and ops of a change, and local listeners hear its own writes once per burst", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Bridge change info test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const writes: unknown[] = [];
    await page.route("http://bridge.test/**", (route) => {
      const url = route.request().url();
      if (url.includes("/api/tabs/page/state") && route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push(body.ops);
        return route.fulfill({ json: { stateRevision: 3, fromRevision: 2, applied: body.ops } });
      }
      return route.fulfill({ contentType: "text/html", body: url.endsWith("/frame") ? PAGE : '<iframe src="/frame"></iframe>' });
    });
    await page.goto("http://bridge.test/");
    const frame = page.frames()[1];
    await frame.waitForFunction(() => Array.isArray((window as any).seen));

    // A remote delta: both listeners hear it with its ops; the untouched card keeps its identity.
    const remote = [{ op: "merge", path: "cards/a", value: { title: "A2" } }];
    await page.evaluate((ops) => {
      document.querySelector("iframe")!.contentWindow!.postMessage({ type: "scribe-state", id: "page", stateRevision: 2, fromRevision: 1, ops }, "*");
    }, remote);
    await frame.waitForFunction(() => (window as any).seen.length === 1);
    assert.deepEqual(await frame.evaluate(() => (window as any).seen), [{ source: "remote", ops: remote, keptB: true }]);
    assert.deepEqual(await frame.evaluate(() => (window as any).seenLocal), [{ source: "remote", ops: remote }]);

    // Two writes in one go: one local notice with both ops, and none for the default listener.
    await frame.evaluate(() => {
      (window as any).scribe.update({ op: "merge", path: "cards/b", value: { title: "B2" } });
      (window as any).scribe.set({ cards: (window as any).scribe.state.cards.concat([{ id: "c", title: "C" }]) });
    });
    await frame.waitForFunction(() => (window as any).seenLocal.length === 2);
    const local = await frame.evaluate(() => (window as any).seenLocal[1]);
    assert.equal(local.source, "local");
    assert.deepEqual(local.ops.map((op: { op: string; path: string }) => op.op + " " + op.path), ["merge cards/b", "insert cards"]);
    await frame.evaluate(() => (window as any).scribe.flush());
    await page.waitForTimeout(50);
    assert.equal(await frame.evaluate(() => (window as any).seen.length), 1);
    assert.equal(writes.length, 1);
  } finally {
    await browser.close();
  }
});
