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
    // Saved settings from the earlier experiment must migrate without losing palettes.
    await page.evaluate(() => localStorage.setItem("scribe.dock-appearance.v1", JSON.stringify({
      cursor: { style: "flares", bleed: "dye", colors: ["#061a33", "#0b5e8a", "#22b8cf", "#d6f6ff"] },
      pi: { style: "ring", bleed: "circuit" },
    })));
    for (const name of ["app.css", "agent.css", "orb.css"]) await page.addStyleTag({ content: fs.readFileSync(new URL("../public/" + name, import.meta.url), "utf8") });
    await page.addScriptTag({ content: `
      window.draws = 0; window.shaderErrors = []; window.pixelChecks = [];
      const draw = WebGLRenderingContext.prototype.drawArrays;
      WebGLRenderingContext.prototype.drawArrays = function(...args) {
        window.draws++; draw.apply(this, args);
        if (this.canvas.className === "dock-orb-canvas" || this.canvas.className === "dock-orb-surface") {
          const pixels = new Uint8Array(this.drawingBufferWidth * this.drawingBufferHeight * 4);
          this.readPixels(0, 0, this.drawingBufferWidth, this.drawingBufferHeight, this.RGBA, this.UNSIGNED_BYTE, pixels);
          this.canvas.lastPixels = Array.from(pixels);
          if (this.canvas.className === "dock-orb-canvas") window.pixelChecks.push(pixels.some(v => v > 0));
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
    assert.equal(await selects.nth(1).locator('option[value="flares"]').count(), 0);
    assert.equal(await selects.nth(3).locator('option[value="circuit"]').count(), 0);
    await selects.nth(0).selectOption("cursor");
    assert.equal(await selects.nth(1).inputValue(), "mesh");
    assert.equal(await selects.nth(3).inputValue(), "flares");
    await selects.nth(0).selectOption("pi");
    assert.equal(await selects.nth(3).inputValue(), "none");
    await selects.nth(0).selectOption("claude");
    for (const shape of ["liquid3d", "mesh", "ring", "ink", "plasma", "halftone", "galaxy"]) {
      await selects.nth(1).selectOption(shape);
      for (const symbol of ["none", "glow", "traced", "crt", "dots"]) await selects.nth(2).selectOption(symbol);
    }
    for (const effect of ["none", "dye", "flares", "galaxy", "glow", "breathing", "waveDots", "pulse", "motes"]) {
      await selects.nth(3).selectOption(effect);
    }
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
    // Icon colour and size are independent of the shape and survive changing its style.
    for (const palette of ["white", "amber", "ink"]) await page.getByLabel("Icon palette", { exact: true }).selectOption(palette);
    await page.getByLabel("Icon palette", { exact: true }).selectOption("ice");
    const sizeControl = page.getByRole("slider", { name: "Icon size" });
    await sizeControl.focus();
    await sizeControl.press("End");
    await sizeControl.press("ArrowLeft");
    await sizeControl.press("ArrowLeft");
    await selects.nth(2).selectOption("glow");
    await selects.nth(1).selectOption("mesh");
    const capture = async (): Promise<number[]> => page.locator(".dock-orb-canvas").evaluate(canvas => (canvas as any).lastPixels);
    // Circular shapes have a soft edge; the galaxy retains its own fading arms.
    await selects.nth(2).selectOption("none");
    for (const shape of ["liquid3d", "mesh", "ring", "ink", "plasma", "halftone"]) {
      await selects.nth(1).selectOption(shape);
      const pixels = await capture();
      assert.ok(pixels[(38 * 76 + 69) * 4 + 3] > 0, shape + " edge glow");
    }
    await selects.nth(1).selectOption("galaxy");
    assert.equal((await capture())[(38 * 76 + 69) * 4 + 3], 0, "no circular galaxy halo");
    await selects.nth(1).selectOption("none");
    await selects.nth(3).selectOption("none");
    assert.ok((await capture()).every(v => v === 0), "no shape or icon is transparent");
    await selects.nth(2).selectOption("glow");
    assert.ok((await capture()).some(v => v > 0), "icon works without a shape");
    await selects.nth(1).selectOption("mesh");
    const meshIcon = await capture();
    await selects.nth(1).selectOption("galaxy");
    const galaxyIcon = await capture();
    // Bright white icon pixels keep the same footprint on the larger galaxy coordinate domain.
    const bright = (pixels: number[]) => pixels.reduce((n, v, i) => n + (i % 4 === 0 && v > 200 && pixels[i+1] > 200 && pixels[i+2] > 200 ? 1 : 0), 0);
    assert.ok(bright(galaxyIcon) > 10);
    assert.ok(Math.abs(bright(meshIcon) - bright(galaxyIcon)) < 20);
    // Surface pixels verify a steady glow and genuinely moving waves, gradients and motes.
    for (const effect of ["glow", "breathing", "waveDots", "pulse", "motes"]) {
      await selects.nth(3).selectOption(effect);
      const before: number[] = await page.locator(".dock-orb-surface").evaluate(canvas => (canvas as any).lastPixels);
      assert.ok(before.some(v => v > 0), effect + " renders");
      await page.evaluate(() => { document.documentElement.classList.remove("no-ui-fx"); window.dispatchEvent(new Event("scribe:ui-fx")); });
      await page.waitForTimeout(160);
      await page.evaluate(() => { document.documentElement.classList.add("no-ui-fx"); window.dispatchEvent(new Event("scribe:ui-fx")); });
      const after: number[] = await page.locator(".dock-orb-surface").evaluate(canvas => (canvas as any).lastPixels);
      if (effect === "glow") assert.deepEqual(after, before);
      else assert.notDeepEqual(after, before, effect + " animates");
    }
    if (process.env.SCRIBE_ORB_SCREENSHOT) {
      await selects.nth(1).selectOption("mesh");
      await selects.nth(4).selectOption("ocean");
      for (const effect of ["flares", "glow", "breathing", "waveDots", "pulse", "motes"]) {
        await selects.nth(3).selectOption(effect);
        await page.screenshot({ path: process.env.SCRIBE_ORB_SCREENSHOT.replace(/\.png$/, "-" + effect + ".png") });
      }
      await selects.nth(1).selectOption("galaxy");
    }
    await selects.nth(0).selectOption("cursor");
    await selects.nth(1).selectOption("none");
    await selects.nth(0).selectOption("codex");
    await selects.nth(1).selectOption("ring");
    await selects.nth(4).selectOption("ember");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("scribe.dock-appearance.v1")!));
    assert.equal(saved.codex.style, "ring");
    assert.equal(saved.codex.colors[1], "#a8321a");
    assert.equal(saved.claude.style, "galaxy");
    assert.equal(saved.claude.iconSize, 1);
    assert.deepEqual(saved.claude.iconColors, ["#7ee7ff", "#ffffff"]);
    assert.equal(saved.cursor.bleed, "flares");
    assert.equal(saved.cursor.style, "none");
    assert.equal(saved.pi.bleed, "none");
    await page.getByRole("button", { name: "Customize", exact: true }).click();
    await selects.nth(0).selectOption("codex");
    assert.equal(await selects.nth(1).inputValue(), "ring");
    await selects.nth(0).selectOption("claude");
    assert.equal(await page.getByRole("slider", { name: "Icon size" }).inputValue(), "100");
    assert.equal(await page.getByLabel("Icon palette", { exact: true }).inputValue(), "ice");
    await selects.nth(0).selectOption("codex");
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
