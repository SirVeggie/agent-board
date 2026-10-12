import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";

test("SDK settings render update, current and failed checks and allow retry", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "SDK updates test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const requests: string[] = [];
    let failed = false;
    await page.route("http://sdk.test/**", async (route) => {
      const url = route.request().url();
      if (!url.includes("/api/agent/")) return route.fulfill({ contentType: "text/html", body: "<main></main>" });
      requests.push(url);
      return route.fulfill({ contentType: "application/json", status: failed ? 500 : 200, body: JSON.stringify(failed ? { error: "offline" } : {
        checkedAt: 100,
        sdks: [
          { label: "Cursor SDK", installed: "1.0.9", latest: "1.0.10", outdated: true },
          { label: "Codex SDK", installed: "1.0.0", latest: "1.0.0", outdated: false },
          { label: "Claude Agent SDK", installed: "1.0.0", latest: null, outdated: null, error: "npm check timed out" },
        ],
      }) });
    });
    await page.goto("http://sdk.test/");
    await page.addScriptTag({ content: "window.__name = (fn) => fn;" });
    for (const name of ["motion.js", "dom-sync.js", "agent-render.js"]) await page.addScriptTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await page.addScriptTag({ content: source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.sdkTest = agentSettings;") });
    await page.evaluate(async () => {
      const settings = (window as any).sdkTest;
      settings.sdkStatus = document.createElement("div");
      settings.sdkCheck = document.createElement("button");
      settings.sdkCheck.textContent = "Check for updates";
      document.querySelector("main")!.append(settings.sdkStatus, settings.sdkCheck);
      await settings.renderSdkUpdates();
    });
    const rows = page.locator(".setting-row");
    assert.match(await rows.nth(0).innerText(), /1.0.9.*latest 1.0.10[\s\S]*Update available/);
    assert.match(await rows.nth(1).innerText(), /Up to date/);
    assert.match(await rows.nth(2).innerText(), /npm check timed out/);
    assert.equal(await page.locator(".ag-tag.ok").count(), 1);
    assert.match(await page.locator("main").innerText(), /restart Scribe/);
    failed = true;
    await page.evaluate(() => (window as any).sdkTest.renderSdkUpdates(true));
    assert.ok(requests.at(-1)?.endsWith("/sdk-updates?refresh=1"));
    assert.match(await page.locator("main").innerText(), /SDK check failed: offline/);
    assert.equal(await page.getByRole("button", { name: "Check for updates" }).isEnabled(), true);
  } finally { await browser.close(); }
});
