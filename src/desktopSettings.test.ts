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
      const state = { compact: false, maximized: false, hidden: false, childDockingSupported: true };
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
    assert.equal(await page.locator("#desktop-update").isVisible(), true);
    await page.locator("#desktop-update").click();
    const dialog = page.getByRole("dialog");
    assert.match(await dialog.textContent() || "", /API: unreported/);
    assert.match(await dialog.locator("pre").textContent() || "", /npm run desktop:install/);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.evaluate(() => (window as any).scribeDesktop.setState({ reducedMotion: false, hidden: false }));
    assert.equal(await toggle.isEnabled(), true);
    assert.equal(await page.getByRole("status").isVisible(), false);
    await toggle.click();
    await page.waitForFunction(() => document.getElementById("desktop-reduced-motion")?.getAttribute("aria-checked") === "true");
    await toggle.click();
    await page.waitForFunction(() => document.getElementById("desktop-reduced-motion")?.getAttribute("aria-checked") === "false");
    assert.equal(await page.locator("#desktop-dock-children").isDisabled(), true);
    await page.evaluate(() => (window as any).scribeDesktop.setState({ dockChildWindows: false, childDockingSupported: true }));
    const docking = page.locator("#desktop-dock-children");
    assert.equal(await docking.isEnabled(), true);
    await docking.click();
    await page.waitForFunction(() => document.getElementById("desktop-dock-children")?.getAttribute("aria-checked") === "true");
    await docking.click();
    await page.waitForFunction(() => document.getElementById("desktop-dock-children")?.getAttribute("aria-checked") === "false");
    await page.evaluate(() => (window as any).scribeDesktop.setState({ dockChildWindows: false, childDockingSupported: false }));
    assert.equal(await docking.isDisabled(), true);
  } finally {
    await browser.close();
  }
});

test("desktop compatibility follows native revision and fields, with build and update details", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Desktop compatibility test" });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="chrome"><div class="actions"></div></div><section id="desktop-settings"></section>');
    await page.evaluate(`(() => {
      window.__TAURI__ = { core: { invoke: () => new Promise(() => {}) } };
    })()`);
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/desktop.js", import.meta.url), "utf8") });
    assert.equal(await page.locator("#desktop-reduced-motion").isDisabled(), true);
    assert.equal(await page.locator("#desktop-update").isVisible(), false);
    const state = { apiRevision: 2, version: "1.0.0", builtAt: "1791680000", executable: "C:\\Scribe's app\\scribe.exe", hidden: false,
      compactOnTop: true, openFromAgents: true, closeToTray: false, launchAtStartup: false, reducedMotion: false,
      dockChildWindows: false, childDockingSupported: true };
    await page.evaluate((state) => (window as any).scribeDesktop.setState(state), state);
    assert.equal(await page.locator("#desktop-update").isVisible(), false);
    assert.equal(await page.locator("#desktop-reduced-motion").isEnabled(), true);
    await page.getByRole("button", { name: "Build details", exact: true }).click();
    const dialog = page.getByRole("dialog");
    assert.match(await dialog.textContent() || "", /Version: 1\.0\.0 · API: 2/);
    assert.equal(await dialog.locator("pre").textContent(), "npm run desktop:install -- 'C:\\Scribe''s app'");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.evaluate((state) => (window as any).scribeDesktop.setState({ ...state, apiRevision: 1 }), state);
    assert.equal(await page.locator("#desktop-update").isVisible(), true);
    // A legacy shell with all today's settings still needs an update to report its API.
    await page.evaluate((state) => (window as any).scribeDesktop.setState({ ...state, apiRevision: undefined }), state);
    assert.equal(await page.locator("#desktop-update").isVisible(), true);
    await page.evaluate((state) => (window as any).scribeDesktop.setState({ ...state, apiRevision: 0 }), state);
    assert.equal(await page.locator("#desktop-update").isVisible(), true);
    // Newer shells are compatible; a missing feature is still disabled and reported.
    await page.evaluate((state) => (window as any).scribeDesktop.setState({ ...state, apiRevision: 2 }), state);
    assert.equal(await page.locator("#desktop-update").isVisible(), false);
    await page.evaluate((state) => (window as any).scribeDesktop.setState({ ...state, apiRevision: 2, closeToTray: undefined }), state);
    assert.equal(await page.locator("#desktop-tray").isDisabled(), true);
    assert.equal(await page.locator("#desktop-update").isVisible(), true);
    // Popouts keep the warning out of their title bar.
    await page.reload();
    await page.setContent('<div class="chrome"><div class="actions"></div></div>');
    await page.evaluate(`window.scribePopout = { childId: "page" }; window.__TAURI__ = { core: { invoke: async () => ({ hidden: false }) } };`);
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/desktop.js", import.meta.url), "utf8") });
    assert.equal(await page.locator("#desktop-update").isVisible(), false);
  } finally {
    await browser.close();
  }
});

test("child title-bar docking tracks bare drag regions, with Shift passed to native tracking", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Child window docking test" });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="chrome"><span class="popout-title" data-tauri-drag-region>Page</span><div class="actions"></div></div>');
    await page.evaluate(`(() => {
      window.calls = [];
      window.nativeState = { dockChildWindows: true, childDockingSupported: true, hidden: false };
      window.scribePopout = { childId: "page", chatChild: false };
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        window.calls.push({ command, args });
        return { ...window.nativeState };
      } } };
    })()`);
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/desktop.js", import.meta.url), "utf8") });
    await page.locator(".popout-title").click({ modifiers: ["Shift"] });
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.args?.action === "drag-child").length), 1);
    await page.locator(".popout-title").dispatchEvent("mousedown", { button: 0, detail: 2 });
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.args?.action === "drag-child").length), 1);
    await page.locator(".win-close").click();
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.args?.action === "drag-child").length), 1);
    await page.evaluate(() => {
      (window as any).nativeState.dockChildWindows = false;
      (window as any).scribeDesktop.setState((window as any).nativeState);
    });
    await page.locator(".popout-title").click();
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.args?.action === "drag-child").length), 1);
    await page.evaluate(() => {
      (window as any).nativeState = { dockChildWindows: true, childDockingSupported: false };
      (window as any).scribeDesktop.setState((window as any).nativeState);
    });
    assert.equal(await page.locator("#desktop-dock-children").count(), 0); // Children keep settings off screen.
    await page.locator(".popout-title").click();
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.args?.action === "drag-child").length), 1);
  } finally { await browser.close(); }
});
