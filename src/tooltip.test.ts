import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";

test("shared tooltips handle dynamic pages, keyboard focus and modal dialogs", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Tooltip test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<button id="plain" title="First line&#10;Second line" aria-describedby="existing">Plain</button><span id="existing">Existing description</span><button id="rich" data-tooltip="Plain fallback" data-rich-tooltip>Rich</button><iframe title="Document name"></iframe><dialog><button id="modal" data-tooltip="Modal help">Modal</button></dialog>');
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/tooltip.js", import.meta.url), "utf8") });
    const tip = page.locator(".scribe-tooltip");
    assert.equal(await page.locator("#plain").getAttribute("title"), null);
    assert.equal(await page.locator("iframe").getAttribute("title"), "Document name");
    assert.equal(await page.locator("#plain").getAttribute("aria-description"), "First line\nSecond line");
    await page.locator("#plain").focus();
    await tip.waitFor({ state: "visible" });
    assert.equal(await tip.textContent(), "First line\nSecond line");
    assert.equal(await page.locator("#plain").getAttribute("aria-describedby"), "existing scribe-text-tooltip");
    await page.keyboard.press("Escape");
    await tip.waitFor({ state: "hidden" });
    assert.equal(await page.locator("#plain").getAttribute("aria-describedby"), "existing");
    await page.locator("#rich").focus();
    assert.equal(await tip.isVisible(), false);
    await page.evaluate(() => { document.querySelector("dialog")!.showModal(); });
    await tip.waitFor({ state: "visible" });
    assert.equal(await tip.textContent(), "Modal help");
    assert.equal(await tip.evaluate(node => node.matches(":popover-open")), true);
    await page.evaluate(() => { document.querySelector("#modal")!.setAttribute("title", "Changed help"); });
    await page.waitForFunction(() => document.querySelector(".scribe-tooltip")?.textContent === "Changed help");
    assert.equal(await page.locator("#modal").getAttribute("title"), null);
    await page.evaluate(() => { document.querySelector("#modal")!.remove(); });
    await tip.waitFor({ state: "hidden" });
    await page.evaluate(() => { document.querySelector("dialog")!.close(); });
    await page.locator("#plain").hover();
    await tip.waitFor({ state: "visible" });
    const bounds = await tip.boundingBox();
    assert.ok(bounds && bounds.x >= 8 && bounds.x + bounds.width <= 392 && bounds.y >= 8 && bounds.y + bounds.height <= 292);
    await page.evaluate(() => { document.querySelector("#plain")!.removeAttribute("data-tooltip"); });
    await tip.waitFor({ state: "hidden" });
    assert.equal(await page.locator("#plain").getAttribute("aria-description"), null);

    // A thread button's own tooltip must not dismiss the hovercard before click.
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/hovercard.js", import.meta.url), "utf8") });
    await page.addScriptTag({ content: `
      const anchor = document.createElement("button");
      anchor.id = "page-anchor";
      anchor.textContent = "Page";
      document.body.append(anchor);
      window.openedThreads = [];
      const hoverCard = window.createHoverCard({
        describe: () => ({ title: "Page", id: "scribe:page", madeBy: { text: "Maker", threadId: "thread-maker" } }),
        openThread: (id) => window.openedThreads.push(id),
      });
      hoverCard.bind(anchor, 0);
    ` });
    const card = page.locator("#hover-card");
    const thread = card.locator("[data-thread]");
    await page.locator("#page-anchor").hover();
    await card.waitFor({ state: "visible" });
    await thread.hover();
    await tip.waitFor({ state: "visible" });
    assert.equal(await card.isVisible(), true);
    assert.equal(await tip.textContent(), "Open thread: Maker");
    await page.mouse.down();
    await tip.waitFor({ state: "visible" });
    assert.equal(await card.isVisible(), true);
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => (window as any).openedThreads), ["thread-maker"]);
    await card.waitFor({ state: "hidden" });

    await page.locator("#page-anchor").hover();
    await card.waitFor({ state: "visible" });
    await page.evaluate(() => {
      document.querySelector("#plain")!.setAttribute("data-tooltip", "Outside help");
    });
    await page.locator("#plain").focus();
    await tip.waitFor({ state: "visible" });
    await card.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
