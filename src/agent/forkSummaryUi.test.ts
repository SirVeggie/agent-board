import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";

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
    await page.addScriptTag({ content: "window.__name = (fn) => fn;" });
    for (const name of ["motion.js", "dom-sync.js", "audio.js", "audio-composer.js", "agent-render.js", "settings-ui.js"]) {
      await page.addScriptTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    }
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await page.addScriptTag({ content: source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  renderAll = () => {}; window.forkTest = { settings: agentSettings, loadConfig };") });
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
    assert.match(await codex.innerText(), /Use destination thread's model/);
    assert.doesNotMatch(await page.getByRole("button", { name: "About Summaries for forks" }).getAttribute("aria-description") || "", /guarantee/);
    await codex.click();
    await page.getByText("Mini", { exact: true }).click();
    await page.waitForFunction(() => (window as any).forkTest.settings.forkSummarizers.get("codex").textContent.includes("Mini"));
    assert.match(await claude.innerText(), /Haiku/);
    providers = ["codex", "pi"];
    await page.evaluate(() => (window as any).forkTest.loadConfig());
    assert.equal(await page.locator('#ag-fork-summarizer-claude-label').count(), 0);
    assert.equal(await page.locator('#ag-fork-summarizer-pi-label').isVisible(), true);
    assert.equal(await page.locator('[id^="ag-fork-summarizer-"]').count(), 2);
  } finally { await browser.close(); }
});
