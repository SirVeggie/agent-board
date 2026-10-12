import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium, type Page } from "playwright-core";
import { launchChromium } from "../chromium.js";

const read = (name: string) => fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8");

/** The board's chat scripts on a bare page, with two threads; `boot` runs in place of agent.js's own. */
async function load(page: Page, url: string, boot: string) {
  await page.goto(url);
  await page.addScriptTag({ content: "window.__name = (fn) => fn; window.opened = []; window.open = (url) => { window.opened.push(url); return { closed: false, focus() {}, close() {} }; };" });
  for (const name of ["popout.js", "dom-sync.js", "agent-render.js"]) {
    await page.addScriptTag({ content: read(name) });
  }
  await page.addScriptTag({
    content: read("agent.js").replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, `  window.chatTest = { S, sidebar, dock, full, chatFromWindow };\n  ${boot}`),
  });
  await page.evaluate(() => {
    const { S, sidebar, dock, full } = (window as any).chatTest;
    S.config.providers = [{ id: "codex", label: "Codex", available: true }];
    const base = { provider: "codex", model: "gpt-6.1-sol", mode: "ask", scope: { kind: "global", ref: null }, status: "idle", stats: {}, activityAt: 1, createdAt: 1 };
    for (const id of ["one", "two"]) {
      S.threads.set(id, { ...base, id, title: id });
      S.details.set(id, { items: [], byId: new Map(), turns: new Map() });
    }
    sidebar.mount();
    dock.mount();
    full.mount();
  });
}

test("the chat moves to a window of its own and back", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Chat window test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
    await context.route("http://chat.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: '<div class="workspace"><main></main></div><aside id="agent-pane"><div class="agent-inner"></div><div class="agent-resizer"></div></aside>',
    }));
    const errors: string[] = [];
    const main = await context.newPage();
    main.on("pageerror", (error) => errors.push(error.message));
    await load(main, "http://chat.test/", "");
    const popOut = main.getByRole("button", { name: "Open in its own window", exact: true });

    // From the sidebar: the thread and what was written go along, and the sidebar closes.
    await main.evaluate(() => {
      const { sidebar } = (window as any).chatTest;
      sidebar.setOpen(true);
      sidebar.view.setThread("one");
      sidebar.view.input.value = "Unsent message";
    });
    await popOut.click();
    assert.deepEqual(await main.evaluate(() => {
      const { S, sidebar } = (window as any).chatTest;
      return [(window as any).opened, S.sideOpen, sidebar.view.threadId, sidebar.view.input.value, (window as any).scribePopout.ids()];
    }), [["/?popout=agent-chat"], false, "one", "", []]);

    const child = await context.newPage();
    child.on("pageerror", (error) => errors.push(error.message));
    await load(child, "http://chat.test/?popout=agent-chat", "window.chatTest.open = () => full.open(chatFromWindow(window.scribePopout.chatHandoff()));");
    await child.evaluate(() => (window as any).chatTest.open());
    assert.deepEqual(await child.evaluate(() => {
      const { S, full } = (window as any).chatTest;
      return [S.fullOpen, S.dockShown, full.root.hidden, full.view.threadId, full.view.input.value, (window as any).scribeChat.escape(), S.fullOpen];
    }), [true, false, false, "one", "Unsent message", false, true]);
    assert.equal(await child.getByRole("button", { name: "Open in its own window", exact: true }).count(), 0);
    // A reload shows the thread again, without the text that was already handed over.
    assert.deepEqual(await child.evaluate(() => (window as any).scribePopout.chatHandoff()), { threadId: "one", draft: null, composer: null });

    // From the full window, with the chat window open: that window takes the thread over.
    await main.evaluate(() => {
      const { sidebar } = (window as any).chatTest;
      sidebar.view.setThread("two");
      (window as any).scribeChat.shortcut("full");
    });
    await popOut.click();
    await child.waitForFunction(() => (window as any).chatTest.full.view.threadId === "two");
    assert.deepEqual(await main.evaluate(() => {
      const { S, sidebar } = (window as any).chatTest;
      return [(window as any).opened.length, S.fullOpen, S.sideOpen, sidebar.view.threadId];
    }), [1, false, false, "two"]);

    // Back to the main window: the chat lands in the sidebar with what was written there.
    await child.evaluate(() => {
      const { full } = (window as any).chatTest;
      full.view.setThread("one");
      full.view.input.value = "Written in the window";
    });
    await child.getByRole("button", { name: "Back to the main window", exact: true }).click();
    await main.waitForFunction(() => (window as any).chatTest.S.sideOpen);
    assert.deepEqual(await main.evaluate(() => {
      const { sidebar } = (window as any).chatTest;
      return [sidebar.view.threadId, sidebar.view.input.value];
    }), ["one", "Written in the window"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
