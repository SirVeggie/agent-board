import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { launchChromium } from "../chromium.js";

test("model source dialog saves exact custom prices, clears entries and offers endpoint reconfirmation", async (t) => {
  let browser;
  try { browser = await launchChromium({ headless: true, args: [], purpose: "Pricing UI test" }); }
  catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const requests: Record<string, any>[] = [];
    await page.route("http://pricing.test/**", async (route) => {
      if (!route.request().url().includes("/api/agent/")) return route.fulfill({ contentType: "text/html", body: "<main></main>" });
      requests.push(route.request().postDataJSON());
      await route.fulfill({ contentType: "application/json", body: "{}" });
    });
    await page.goto("http://pricing.test/");
    await page.addScriptTag({ content: "window.__name = (fn) => fn;" });
    for (const name of ["motion.js", "dom-sync.js", "audio.js", "audio-composer.js", "agent-render.js"]) await page.addScriptTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    const code = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8")
      .replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.pricingTest = editSource;")
      .replace(/async function sourcesChanged\(\) \{[\s\S]*?\n  \}/, "async function sourcesChanged() {}");
    await page.addScriptTag({ content: code });
    await page.evaluate(() => (window as any).pricingTest(null));
    await page.getByLabel("Name", { exact: true }).fill("Custom");
    await page.getByLabel("Base URL", { exact: true }).fill("https://api.example/v1");
    await page.getByRole("button", { name: "Add model price", exact: true }).click();
    await page.getByLabel("Model ID", { exact: true }).fill("vendor/model");
    await page.getByLabel("Pricing", { exact: true }).selectOption("custom");
    await page.getByLabel("Uncached input", { exact: true }).fill("0");
    await page.getByLabel("Output", { exact: true }).fill("1.25");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".ag-source"));
    assert.deepEqual(requests[0].pricing, { "vendor/model": { mode: "custom", rates: { input: "0", output: "1.25", cacheRead: "", cacheWrite: "" } } });
    await page.evaluate(() => (window as any).pricingTest({ id: "a", name: "Saved", baseUrl: "https://api.example/v1", models: [], pricing: { "vendor/model": { mode: "custom", rates: { input: "0", output: "1.25" }, updatedAt: 100 } } }));
    await page.getByLabel("Base URL", { exact: true }).fill("https://other.example/v1");
    assert.equal(await page.getByLabel("Apply these prices to the changed endpoint").isVisible(), true);
    await page.getByRole("button", { name: "Remove price entry", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".ag-source"));
    assert.deepEqual(requests[1].pricing, {});
  } finally { await browser.close(); }
});
