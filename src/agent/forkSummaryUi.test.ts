import { loadChatFixture } from "../testSupport/shell.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";

test("provider switches fork on send and archive only after an accepted message", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Pending provider switch test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const requests: { method: string; path: string; body: any }[] = [];
    let rejectMessage = false;
    const source = { id: "original", title: "Original", provider: "claude", model: "haiku", mode: "code", approval: "ask", scope: { kind: "global", ref: null }, stats: { turns: 3 }, status: "idle" };
    let fork: any;
    await page.route("http://fork.test/**", async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace("/api/agent", "");
      if (!req.url().includes("/api/agent/")) return route.fulfill({ contentType: "text/html", body: "<main></main>" });
      const body = req.postData() ? req.postDataJSON() : null;
      requests.push({ method: req.method(), path, body });
      let data: any = {};
      if (path.endsWith("/fork")) {
        fork = { ...source, ...body, id: "fork", stats: { turns: 0 }, fork: { from: source.id, title: source.title, provider: source.provider } };
        data = { thread: fork };
      } else if (path === "/threads/fork" && req.method() === "PATCH") {
        fork = { ...fork, ...body };
        data = { thread: fork };
      } else if (path === "/threads/original" && req.method() === "PATCH") data = { thread: { ...source, ...body } };
      if (path.endsWith("/messages") && rejectMessage) return route.fulfill({ status: 400, json: { error: "Try again" } });
      return route.fulfill({ json: data });
    });
    await page.goto("http://fork.test/");

    const js = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, js.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  renderAll = () => {}; window.switchTest = { ChatView, S };"));
    await page.evaluate((source) => {
      const w = window as any;
      const { ChatView, S } = w.switchTest;
      S.threads.set(source.id, source);
      S.config = { providers: [], models: {}, prefs: { models: {}, modelSettings: {} } };
      const view = Object.create(ChatView.prototype);
      Object.assign(view, { threadId: source.id, variant: "full", input: document.createElement("textarea"), forkNote: document.createElement("div"), attachments: [], mentions: [] });
      for (const method of ["renderHeader", "renderContext", "autosize", "hidePicker", "closeHelper", "focus", "parkComposer"]) view[method] = () => {};
      view.renderComposerBar = () => view.renderForkNote(view.thread());
      view.renderAll = view.renderComposerBar;
      view.composerContext = () => [];
      document.querySelector("main")!.append(view.forkNote);
      w.switchTest.view = view;
    }, source);
    const update = (patch: any) => page.evaluate((patch) => (window as any).switchTest.view.updateSettings(patch), patch);
    await update({ provider: "codex", model: "mini" });
    await page.getByRole("button", { name: "Archive on send", exact: true }).click();
    assert.equal(requests.length, 0);
    await update({ model: "large" });
    assert.equal(await page.evaluate(() => (window as any).switchTest.view.settings().model), "large");
    await update({ provider: "claude", model: "haiku" });
    assert.equal(requests.some(r => r.path.endsWith("/fork") || r.body?.archived), false);
    assert.equal(await page.evaluate(() => (window as any).switchTest.view.pendingFork), null);

    await update({ provider: "codex", model: "mini" });
    await page.evaluate(() => {
      const view = (window as any).switchTest.view;
      view.input.value = "Keep this draft";
      view.attachments = [{ name: "a.txt", mimeType: "text/plain", data: "YWJj" }];
    });
    await page.getByRole("button", { name: "New thread", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => {
      const v = (window as any).switchTest.view;
      return [v.threadId, v.settings().provider, v.input.value, v.attachments.length, v.pendingFork];
    }), [null, "codex", "Keep this draft", 1, null]);
    assert.equal(requests.some(r => r.path.endsWith("/fork") || r.path === "/threads"), false);

    await page.evaluate(() => {
      const v = (window as any).switchTest.view;
      v.threadId = "original";
      v.draft = null;
      v.attachments = [];
      v.input.value = "Continue";
    });
    await update({ provider: "codex", model: "mini" });
    await page.getByRole("button", { name: "Archive on send", exact: true }).click();
    rejectMessage = true;
    await page.evaluate(() => (window as any).switchTest.view.send());
    assert.equal(requests.filter(r => r.method === "POST" && r.path.endsWith("/fork")).length, 1);
    assert.equal(requests.some(r => r.body?.archived), false);
    assert.equal(await page.evaluate(() => (window as any).switchTest.view.input.value), "Continue");
    rejectMessage = false;
    const archiveResponse = page.waitForResponse(r => r.url().endsWith("/threads/original") && r.request().postDataJSON()?.archived === true);
    await page.evaluate(() => (window as any).switchTest.view.send());
    await archiveResponse;
    assert.equal(requests.filter(r => r.method === "POST" && r.path.endsWith("/fork")).length, 1);
    const archived = requests.findIndex(r => r.body?.archived === true);
    assert.ok(archived > requests.findLastIndex(r => r.path.endsWith("/messages")));
  } finally { await browser.close(); }
});

test("fork model settings populate after startup and follow provider changes", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Fork summary settings test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    let providers = ["claude", "codex"];
    let prefs = { forkSummarizers: { claude: "haiku" }, summarizer: { provider: "claude", model: "haiku" } };
    await page.route("http://fork.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith("/api/agent/")) return route.fulfill({ contentType: "text/html", body: '<div><div id="panel"><h2 class="settings-title">Settings</h2></div></div>' });
      let data: unknown = {};
      if (url.pathname.endsWith("/config")) data = { providers: providers.map(id => ({ id, available: true })), models: {}, prefs, limits: {} };
      if (url.pathname.endsWith("/models")) data = { models: [{ id: "haiku", label: "Haiku" }, { id: "mini", label: "Mini" }] };
      if (url.pathname.endsWith("/prefs")) {
        const patch = route.request().postDataJSON();
        prefs = { ...prefs, forkSummarizers: { ...prefs.forkSummarizers, ...patch.forkSummarizers } };
        data = prefs;
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("http://fork.test/");

    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  renderAll = () => {}; window.forkTest = { settings: agentSettings, loadConfig };"));
    await page.evaluate(() => {
      const w = window as any;
      w.scribeSettingsUI.mount(document.getElementById("panel"), [{ label: "General", sections: [] }]);
      w.forkTest.settings.mount();
      w.forkTest.settings.categories.open();
    });
    await page.getByRole("button", { name: "Helpers & utilities", exact: true }).click();
    assert.equal(await page.locator('[id^="ag-fork-summarizer-"]').count(), 0);
    await page.evaluate(() => (window as any).forkTest.loadConfig());
    const claude = page.locator('.setting-row').filter({ has: page.locator('#ag-fork-summarizer-claude-label') }).getByRole("button");
    const codex = page.locator('.setting-row').filter({ has: page.locator('#ag-fork-summarizer-codex-label') }).getByRole("button");
    assert.equal(await claude.isVisible(), true);
    assert.match(await claude.innerText(), /Haiku/);
    assert.match(await codex.innerText(), /Use chat's model/);
    const summaryHelp = await page.getByRole("button", { name: "About Summary models" }).getAttribute("aria-description") || "";
    assert.match(summaryHelp, /forks and Native context compaction/);
    assert.match(summaryHelp, /Claude, Codex, and Cursor manage their own context compaction/);
    await codex.click();
    await page.getByText("Mini", { exact: true }).first().click();
    await page.waitForFunction(() => (window as any).forkTest.settings.forkSummarizers.get("codex").textContent.includes("Mini"));
    assert.match(await claude.innerText(), /Haiku/);
    await codex.click();
    await page.getByText("Haiku", { exact: true }).last().click();
    await page.waitForFunction(() => (window as any).forkTest.settings.forkSummarizers.get("codex").textContent.includes("Haiku"));
    assert.deepEqual((prefs.forkSummarizers as any).codex, { provider: "claude", model: "haiku" });
    providers = ["codex", "pi"];
    await page.evaluate(() => (window as any).forkTest.loadConfig());
    assert.equal(await page.locator('#ag-fork-summarizer-claude-label').count(), 0);
    assert.equal(await page.locator('#ag-fork-summarizer-pi-label').isVisible(), true);
    assert.equal(await page.locator('[id^="ag-fork-summarizer-"]').count(), 2);
  } finally { await browser.close(); }
});
