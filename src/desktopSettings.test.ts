import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";

test("desktop motion setting explains old shells and toggles on supported shells", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Desktop settings test" });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="chrome"><div class="actions"></div></div><section id="desktop-settings"></section>');
    await page.evaluate(`(() => {
      const state = { compact: false, maximized: false, hidden: false };
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        if (command === "set_desktop_setting") state[args.name] = args.value;
        return { ...state };
      } } };
    })()`);
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/desktop.js", import.meta.url), "utf8") });
    const toggle = page.locator("#desktop-reduced-motion");
    await page.waitForFunction(() => (document.getElementById("desktop-reduced-motion") as HTMLButtonElement).disabled);
    assert.equal(await page.getByRole("status").textContent(), "Update the desktop app to use Reduce motion.");
    assert.equal(await page.getByRole("status").isVisible(), true);
    await page.evaluate(() => (window as any).scribeDesktop.setState({ reducedMotion: false, hidden: false }));
    assert.equal(await toggle.isEnabled(), true);
    assert.equal(await page.getByRole("status").isVisible(), false);
    await toggle.click();
    await page.waitForFunction(() => document.getElementById("desktop-reduced-motion")?.getAttribute("aria-checked") === "true");
    await toggle.click();
    await page.waitForFunction(() => document.getElementById("desktop-reduced-motion")?.getAttribute("aria-checked") === "false");
  } finally {
    await browser.close();
  }
});
