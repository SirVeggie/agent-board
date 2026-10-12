import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { launchChromium } from "../chromium.js";

test("caret insertion replaces selection and spaces words without separating punctuation", () => {
  const context = vm.createContext({ window: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(new URL("../../public/audio.js", import.meta.url), "utf8"), context);
  const insert = context.window.scribeAudio.insertAtCaret;
  for (const [value, start, end, text, expected, caret] of [
    ["", 0, 0, " Hello ", "Hello", 5],
    ["Hello", 5, 5, "world", "Hello world", 11],
    ["Hello wrong!", 6, 11, "world", "Hello world!", 11],
    ["Hello friend", 5, 5, "dear", "Hello dear friend", 10],
    ["Hello", 5, 5, ",", "Hello,", 6],
    ["(now)", 1, 4, "later", "(later)", 6],
    ["a\nb", 2, 2, "new", "a\nnew b", 6],
    ["Hello", 1, 4, "  ", "Hello", 4],
  ] as const) {
    const result = insert(value, start, end, text);
    assert.equal(result.value, expected); assert.equal(result.caret, caret);
  }
});

test("Chromium capture stops tracks, enforces one session and cap; composer handles editing, cancellation, sending and push-to-talk", async () => {
  const browser = await launchChromium({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"], purpose: "Audio UI test" });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(7000);
    const settings = { stt: { source: "test", model: "whisper-1" }, input: { sendAfterDictation: false, pushToTalk: true }, sources: [{ id: "test", name: "Test" }], available: true };
    let transcriptionRequests = 0, delay = 0;
    await page.route("http://127.0.0.1:47999/**", async route => {
      const url = route.request().url();
      if (url.includes("/api/audio/settings")) return route.fulfill({ json: settings });
      if (url.includes("/api/audio/transcriptions")) {
        transcriptionRequests++; if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        return route.fulfill({ json: { ok: true, text: "spoken words" } });
      }
      return route.fulfill({ contentType: "text/html", body: '<main><textarea></textarea><div class="bar"><button class="ag-mic"><span></span></button></div></main>' });
    });
    await page.goto("http://127.0.0.1:47999/");
    for (const name of ["audio.js", "audio-composer.js"]) await page.addScriptTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    await page.evaluate(`(() => {
      window.notices = []; window.sent = 0; window.openedSettings = null;
      window.scribeAudio.notice = text => window.notices.push(text);
      window.scribeApp = { openSettings: category => window.openedSettings = category };
      window.view = { bar: document.querySelector('.bar'), input: document.querySelector('textarea'), threadId: 'thread', visible: () => true,
        focus() { this.input.focus(); }, send() { window.sent++; } };
      window.composer = window.scribeAudio.bindComposer(window.view);
      document.querySelector('button').onclick = () => window.composer.toggle();
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.streams = [];
      navigator.mediaDevices.getUserMedia = async opts => { const stream = await get(opts); window.streams.push(stream); return stream; };
    })()`);
    await page.evaluate(async () => { const audio = (window as any).scribeAudio; await audio.refresh(); (window as any).capture = await audio.capture({ owner: { kind: "chat", threadId: "direct" }, maxMs: 150 }); });
    assert.equal(await page.evaluate(async () => { try { await (window as any).scribeAudio.capture({}); return false; } catch { return true; } }), true);
    await page.waitForFunction(() => (window as any).capture.state === "stopped");
    assert.ok(await page.evaluate(async () => (await (window as any).capture.stop()).size > 0));
    assert.equal(await page.evaluate(() => (window as any).streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === "ended"))), true);

    await page.locator("textarea").fill("Hello wrong!");
    await page.locator("button").click(); await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "recording");
    delay = 250;
    await page.locator("button").click();
    await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "transcribing");
    await page.evaluate(() => { const input = document.querySelector("textarea")!; input.value = "Edited wrong!"; input.setSelectionRange(7, 12); });
    await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "idle");
    assert.equal(await page.locator("textarea").inputValue(), "Edited spoken words!");
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("textarea")), true);
    delay = 0;

    const previous = transcriptionRequests;
    await page.locator("button").click(); await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "recording");
    await page.keyboard.press("Escape");
    assert.equal(transcriptionRequests, previous);
    assert.equal(await page.evaluate(() => (window as any).streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === "ended"))), true);

    settings.input.sendAfterDictation = true;
    await page.locator("textarea").focus();
    await page.keyboard.down("Control"); await page.keyboard.down("Shift"); await page.keyboard.down("Space");
    await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "recording");
    await page.keyboard.up("Space"); await page.keyboard.up("Shift"); await page.keyboard.up("Control");
    await page.waitForFunction(() => (window as any).sent === 1);

    // A late response following a thread switch must be discarded.
    delay = 250;
    await page.locator("button").click(); await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "recording");
    await page.locator("button").click(); await page.waitForFunction(() => document.querySelector("button")?.getAttribute("data-state") === "transcribing");
    await page.evaluate(() => { (window as any).composer.cancel(); (window as any).view.threadId = "other"; (window as any).view.input.value = "Other draft"; });
    await page.waitForTimeout(350);
    assert.equal(await page.locator("textarea").inputValue(), "Other draft");
    assert.equal(await page.evaluate(() => (window as any).sent), 1);
    delay = 0;

    settings.available = false;
    await page.locator("button").click(); await page.waitForFunction(() => (window as any).openedSettings === "Audio");
    assert.equal(await page.evaluate(() => (window as any).notices.length), 0);

    // Permission-denied errors produce one useful notice.
    settings.available = true;
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("blocked", "NotAllowedError"); }; });
    await page.locator("button").click(); await page.waitForFunction(() => (window as any).notices.length === 1);
    assert.match(await page.evaluate(() => (window as any).notices[0]), /Microphone blocked.*site permissions/);
  } finally { await browser.close(); }
});
