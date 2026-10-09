import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";

test("dock shaders animate while visible, pause when hidden, and save provider appearance", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Orb test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://orb.local/**", route => route.fulfill({ contentType: "text/html", body: '<button id="dock-appearance">Customize</button>' }));
    await page.goto("http://orb.local/");
    for (const name of ["app.css", "agent.css", "orb.css"]) await page.addStyleTag({ content: fs.readFileSync(new URL("../public/" + name, import.meta.url), "utf8") });
    await page.addScriptTag({ content: `
      window.draws = 0; window.shaderErrors = []; window.pixelChecks = [];
      const draw = WebGLRenderingContext.prototype.drawArrays;
      WebGLRenderingContext.prototype.drawArrays = function(...args) {
        window.draws++; draw.apply(this, args);
        if (this.canvas.className === "dock-orb-canvas") {
          const pixels = new Uint8Array(this.drawingBufferWidth * this.drawingBufferHeight * 4);
          this.readPixels(0, 0, this.drawingBufferWidth, this.drawingBufferHeight, this.RGBA, this.UNSIGNED_BYTE, pixels);
          window.pixelChecks.push(pixels.some(v => v > 0));
        }
      };
      const compile = WebGLRenderingContext.prototype.compileShader;
      WebGLRenderingContext.prototype.compileShader = function(shader) { compile.call(this, shader); if (!this.getShaderParameter(shader, this.COMPILE_STATUS)) window.shaderErrors.push(this.getShaderInfoLog(shader)); };
    ` });
    for (const name of ["glfx.js", "orb.js"]) await page.addScriptTag({ content: fs.readFileSync(new URL("../public/" + name, import.meta.url), "utf8") });
    await page.getByRole("button", { name: "Customize", exact: true }).click();
    assert.equal(await page.locator(".dock-orb").evaluate(n => n.classList.contains("gl")), true);
    if (process.env.SCRIBE_ORB_SCREENSHOT) await page.screenshot({ path: process.env.SCRIBE_ORB_SCREENSHOT });
    const selects = page.locator("dialog select");
    for (const shape of ["liquid3d", "mesh", "ring", "ink", "plasma", "halftone", "flares", "galaxy"]) {
      await selects.nth(1).selectOption(shape);
      for (const symbol of ["none", "glow", "traced", "crt", "dots"]) await selects.nth(2).selectOption(symbol);
    }
    for (const effect of ["none", "dye", "flares", "galaxy", "circuit"]) await selects.nth(3).selectOption(effect);
    assert.deepEqual(await page.evaluate(() => (window as any).shaderErrors), []);
    assert.ok(await page.evaluate(() => (window as any).pixelChecks.every(Boolean)));
    // Idle motion continues with the pointer away; hiding the chat stops all drawing.
    await page.mouse.move(900, 600);
    await page.waitForTimeout(120);
    const idle = await page.evaluate(() => (window as any).draws);
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => (window as any).draws) > idle);
    await page.locator(".orb-settings-preview").evaluate(n => { (n as HTMLElement).style.display = "none"; });
    await page.waitForTimeout(80);
    const hidden = await page.evaluate(() => (window as any).draws);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (window as any).draws), hidden);
    await page.locator(".orb-settings-preview").evaluate(n => { (n as HTMLElement).style.display = ""; });
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => (window as any).draws) > hidden);
    const beforeBusy = await page.evaluate(() => (window as any).draws);
    await page.getByRole("checkbox", { name: "Preview busy" }).check();
    await page.waitForTimeout(180);
    assert.ok(await page.evaluate(() => (window as any).draws) > beforeBusy + 2);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(80);
    const reduced = await page.evaluate(() => (window as any).draws);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (window as any).draws), reduced);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => { document.documentElement.classList.add("no-ui-fx"); window.dispatchEvent(new Event("scribe:ui-fx")); });
    await page.waitForTimeout(80);
    const off = await page.evaluate(() => (window as any).draws);
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => (window as any).draws), off);
    await selects.nth(0).selectOption("codex");
    await selects.nth(1).selectOption("ring");
    await selects.nth(4).selectOption("ember");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("scribe.dock-appearance.v1")!));
    assert.equal(saved.codex.style, "ring");
    assert.equal(saved.codex.colors[1], "#a8321a");
    assert.equal(saved.claude.style, "galaxy");
    await page.getByRole("button", { name: "Customize", exact: true }).click();
    await selects.nth(0).selectOption("codex");
    assert.equal(await selects.nth(1).inputValue(), "ring");
    await selects.nth(1).selectOption("plasma");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("scribe.dock-appearance.v1")!).codex.style), "ring");
    const stopped = await page.evaluate(() => (window as any).draws);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (window as any).draws), stopped);
    // Reopening must release old GL contexts rather than exhausting Chromium's context limit.
    for (let i = 0; i < 10; i++) {
      await page.getByRole("button", { name: "Customize", exact: true }).click();
      assert.equal(await page.locator(".dock-orb").evaluate(n => n.classList.contains("gl")), true);
      await page.keyboard.press("Escape");
    }
    // The fallback contains no provider letter, and keeps a useful colour button without GL.
    await page.addScriptTag({ content: `
      HTMLCanvasElement.prototype.getContext = function() { return null; };
    ` });
    await page.getByRole("button", { name: "Customize", exact: true }).click();
    assert.equal(await page.locator(".dock-orb").evaluate(n => n.classList.contains("gl")), false);
    assert.equal(await page.locator(".dock-orb canvas").count(), 0);
    assert.equal(await page.locator(".dock-orb").textContent(), "");
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
