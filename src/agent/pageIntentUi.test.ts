import { loadChatFixture } from "../testSupport/shell.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";

test("page_show during the intent grace period keeps the original screen and cancels its expiry", () => {
  const source = fs.readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("  function onPageIntent(intent)"), source.indexOf("  /** The floating chat's turn looks"));
  const timers = new Map<number, () => void>();
  const context: any = {
    pageIntent: null, pageIntentDismissed: null, pageIntentToggle: {}, childId: null,
    state: { activeId: "origin" }, flagOn: () => true, renderFrames() {},
    PAGE_INTENT_GRACE_MS: 700, endPageIntent() {},
    setTimeout: (fn: () => void) => { timers.set(1, fn); return 1; },
    clearTimeout: (id: number) => timers.delete(id),
  };
  runInNewContext(handler + `
    onPageIntent({ itemId: "announcement", turnId: "turn", title: "Plan" });
    onPageIntent(null);
    state.activeId = "made";
    onPageIntent({ itemId: "page_show", turnId: "turn", title: "My plan" });
  `, context);
  assert.equal(context.pageIntent.origin, "origin");
  assert.equal(context.pageIntent.itemId, "page_show");
  assert.equal(context.pageIntent.title, "My plan");
  assert.equal(context.pageIntent.ending, 0);
  assert.equal(timers.size, 0);
});

test("the floating chat maps page_create signals onto the hint and the creating screen", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Page intent UI test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://intent.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: '<div class="workspace"><main></main></div><aside id="agent-pane"><div class="agent-inner"></div><div class="agent-resizer"></div></aside>',
    }));
    await page.goto("http://intent.test/");

    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.intentTest = { S, dock };"));
    await page.evaluate(() => {
      const { S, dock } = (window as any).intentTest;
      S.config.providers = [{ id: "codex", label: "Codex", available: true }];
      dock.mount();
      const base = { provider: "codex", model: "gpt-6.1-sol", mode: "ask", scope: { kind: "global", ref: null }, status: "running", stats: {}, activityAt: 1, createdAt: 1 };
      for (const id of ["shown", "other"]) {
        S.threads.set(id, { ...base, id, title: id });
        S.details.set(id, { items: [], byId: new Map(), turns: new Map([[`${id}-1`, { id: `${id}-1`, threadId: id, status: "running" }], [`${id}-0`, { id: `${id}-0`, threadId: id, status: "done" }]]) });
      }
      dock.view.setThread("shown");
      const seen: unknown[] = ((window as any).seen = []);
      window.addEventListener("scribe:page-intent", (event) => seen.push(["intent", (event as CustomEvent).detail]));
      window.addEventListener("scribe:page-hint", (event) => seen.push(["hint", (event as CustomEvent).detail]));
    });
    /** Runs the steps in the page and returns the events they raised. */
    const events = (steps: string) => page.evaluate(`(() => {
      const { S, dock } = window.intentTest;
      const signal = (stage, extra = {}) => dock.onIntent({ threadId: "shown", turnId: "shown-1", name: "page_create", stage, detector: "x", event: "prompt", ...extra });
      const call = (id, status, input, extra = {}) => dock.onItem({ id, threadId: "shown", turnId: "shown-1", kind: "tool", tool: "mcp", name: "mcp__scribe__page_show", title: "Scribe: page_show", status, input, ...extra });
      window.seen.length = 0;
      ${steps}
      return JSON.parse(JSON.stringify(window.seen));
    })()`);

    // Signals that are not this chat's running turn do nothing.
    assert.deepEqual(await events(`
      signal("hint", { threadId: "other", turnId: "other-1" });
      signal("confirmed", { threadId: "other", turnId: "other-1" });
      signal("hint", { turnId: "shown-0" });
      signal("confirmed", { turnId: null });
      signal("hint", { name: "release" });
    `), []);

    // The hint, then the agent's announcement takes over, then its page_show call, which ends it.
    assert.deepEqual(await events(`
      signal("hint");
      signal("confirmed", { title: "Reading list" });
      signal("hint");
      call("c1", "running", { title: "", key: "reading" });
      call("c1", "running", { title: "My reading list", key: "reading" });
      call("c1", "done", { title: "My reading list", key: "reading" });
    `), [
      ["hint", { threadId: "shown", turnId: "shown-1" }],
      ["hint", null],
      ["intent", { itemId: "intent:shown-1", threadId: "shown", turnId: "shown-1", title: "Reading list", announced: true }],
      ["intent", { itemId: "c1", threadId: "shown", turnId: "shown-1", title: "Reading list" }],
      ["intent", { itemId: "c1", threadId: "shown", turnId: "shown-1", title: "My reading list" }],
      ["intent", null],
    ]);

    // Background calls never raise a creating screen, while running or finished.
    assert.deepEqual(await events(`
      call("b0", "running", { title: "Evidence", background: true });
      call("b0", "done", { title: "Evidence", background: true });
    `), []);

    // An announced page whose page_show this chat first sees finished still ends the screen; a background page does not.
    assert.deepEqual(await events(`
      signal("confirmed", { title: "Plan" });
      call("b1", "running", { title: "Evidence", background: true });
      call("b1", "done", { title: "Evidence", background: true });
      call("c2", "done", { title: "Plan" });
    `), [
      ["intent", { itemId: "intent:shown-1", threadId: "shown", turnId: "shown-1", title: "Plan", announced: true }],
      ["intent", null],
    ]);

    // A page_show call already on screen is not replaced by a later signal, and the turn's end clears a hint.
    assert.deepEqual(await events(`
      call("c3", "running", { title: "Board" });
      signal("confirmed", { title: "Other" });
      call("c3", "done", { title: "Board" });
      signal("hint");
      dock.onTurn({ id: "shown-1", threadId: "shown", status: "done" });
    `), [
      ["intent", { itemId: "c3", threadId: "shown", turnId: "shown-1", title: "Board" }],
      ["intent", null],
      ["hint", { threadId: "shown", turnId: "shown-1" }],
      ["hint", null],
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
