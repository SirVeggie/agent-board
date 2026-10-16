import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";

const source = (name: string) => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");

test("background picker renders real previews, toggles choices, and disposes effects", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Settings background picker test" });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="newpage-bgs">Choose…</button>');
    await page.addScriptTag({ content: "window.scribeAppearance = { getItem: () => null };" });
    await page.addStyleTag({ content: source("app.css") });
    for (const name of ["motion.js", "glfx.js", "newpage.js"]) await page.addScriptTag({ content: source(name) });
    const app = source("app.js");
    const picker = app.slice(app.indexOf("  function renderNewPageBgs()"), app.indexOf("  function renderChromeFx()"));
    const items = app.slice(app.indexOf("  const NEWPAGE_BGS ="), app.indexOf("  /** Also read by chromefx.js"));
    await page.addScriptTag({ content: `const appearanceStorage = new Map(); appearanceStorage.getItem = appearanceStorage.get; appearanceStorage.setItem = appearanceStorage.set; const NEWPAGE_BG_KEY = "backgrounds"; ${items}\n${picker}\nrenderNewPageBgs();` });
    await page.getByRole("button", { name: "Choose…" }).click();
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.locator("canvas").count(), 7);
    await page.waitForFunction(() => document.querySelectorAll('canvas[data-ready="1"]').length === 7);
    const nebula = dialog.getByRole("button", { name: "Nebula", exact: true });
    await nebula.click();
    assert.equal(await nebula.getAttribute("aria-pressed"), "false");
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Choose…" }).click();
    assert.equal(await page.getByRole("button", { name: "Nebula", exact: true }).getAttribute("aria-pressed"), "false");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
  } finally { await browser.close(); }
});

test("custom speech fields save independently and Model sources opens its settings", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Custom speech settings test" });
  try {
    const page = await browser.newPage();
    const patches: any[] = [];
    await page.route("http://audio.test/**", route => {
      if (route.request().method() === "PUT") patches.push(route.request().postDataJSON());
      return route.fulfill({ json: {} });
    });
    await page.goto("http://audio.test/");
    await page.addScriptTag({ content: `window.scribeAudio = { refresh: async () => ({ sources: [], stt: { model: "whisper-1" }, input: {} }), device: () => "" }; window.scribeChat = { openModelSources: () => document.body.dataset.sources = "open" }; window.createSelect = input => { const control = document.createElement("button"); input.after(control); input.parentElement.syncSelect = () => {}; return control; };` });
    await page.addScriptTag({ content: source("audio-settings.js") });
    await page.evaluate(async () => {
      const settings = (window as any).scribeAudioSettings;
      document.body.append(...settings.sections); await settings.refresh();
    });
    assert.equal(await page.locator("#audio-url").isVisible(), false);
    await page.locator("#audio-source").selectOption("__custom__");
    await page.locator("#audio-url").fill("http://localhost:9000/v1");
    await page.locator("#audio-url").dispatchEvent("change");
    await page.locator("#audio-key").fill("custom-key");
    await page.locator("#audio-key").dispatchEvent("change");
    await page.waitForFunction(() => document.querySelector("#audio-url")?.getAttribute("type") === "url");
    await page.getByRole("button", { name: "Model sources →" }).click();
    assert.equal(await page.locator("body").getAttribute("data-sources"), "open");
    await page.waitForTimeout(100);
    assert.ok(patches.some(patch => patch.stt.custom?.apiKey === "custom-key"));
    assert.ok(patches.some(patch => patch.stt.custom?.baseUrl === "http://localhost:9000/v1"));
  } finally { await browser.close(); }
});
