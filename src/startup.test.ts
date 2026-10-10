import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";

test("effects wait for visible restored UI, cancel queued work, and keep fallback on failure", async () => {
  const browser = process.env.SCRIBE_TEST_CHROMIUM
    ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
    : await launchChromium({ headless: true, args: [], purpose: "Startup test" });
  try {
    const page = await browser.newPage();
    await page.setContent('<html data-restoring><body><div id="host" style="display:none"><canvas style="width:60px;height:60px"></canvas></div></body></html>');
    await page.addScriptTag({ content: "window.__name = value => value;" });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/glfx.js", import.meta.url), "utf8") });
    await page.evaluate(() => {
      const w = window as any;
      w.created = 0; w.drawn = 0; w.ready = 0;
      w.scribeGL.create = () => { w.created++; return { set() {}, draw() { w.drawn++; return true; }, destroy() {} }; };
      w.effect = w.scribeGL.lazy(document.querySelector("canvas"), "", { onReady: () => w.ready++ });
      w.effect.draw({ u_time: 1 });
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (window as any).created), 0);
    await page.evaluate(() => { document.querySelector<HTMLElement>("#host")!.style.display = "block"; (window as any).effect.draw({ u_time: 2 }); });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (window as any).created), 0, "restoring blocks visible graphics");
    await page.evaluate(() => { document.documentElement.removeAttribute("data-restoring"); dispatchEvent(new Event("scribe:restored")); });
    await page.waitForFunction(() => (window as any).ready === 1);
    assert.equal(await page.evaluate(() => (window as any).created), 1);
    assert.ok(await page.evaluate(() => (window as any).drawn) > 0);
    await page.evaluate(() => {
      const w = window as any;
      w.effect.destroy();
      const cancelled = w.scribeGL.lazy(document.querySelector("canvas"), "");
      cancelled.draw({}); cancelled.destroy();
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (window as any).created), 1);
    await page.evaluate(() => {
      const w = window as any;
      w.scribeGL.create = () => null;
      w.failed = false;
      w.scribeGL.lazy(document.querySelector("canvas"), "", { onError: () => w.failed = true }).draw({});
    });
    await page.waitForFunction(() => (window as any).failed);
    // A pane can close while the driver is still compiling.
    await page.evaluate(() => {
      const w = window as any;
      w.destroyed = 0;
      w.scribeGL.create = () => new Promise(resolve => w.finish = resolve);
      w.pending = w.scribeGL.lazy(document.querySelector("canvas"), "", { onReady: () => w.ready++ });
      w.pending.draw({});
    });
    await page.waitForFunction(() => (window as any).finish);
    await page.evaluate(() => {
      const w = window as any;
      w.pending.destroy();
      w.finish({ destroy() { w.destroyed++; } });
    });
    await page.waitForFunction(() => (window as any).destroyed === 1);
    assert.equal(await page.evaluate(() => (window as any).ready), 1, "cancelled compiler cannot replace the fallback");
  } finally { await browser.close(); }
});

test("refresh keeps the restoring view until a snapshot, and retry recovers to true empty state", async () => {
  const browser = process.env.SCRIBE_TEST_CHROMIUM
    ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
    : await launchChromium({ headless: true, args: [], purpose: "Restore test" });
  try {
    const page = await browser.newPage();
    await page.addInitScript({ content: "window.__name = value => value;" });
    const root = new URL("../public/", import.meta.url);
    await page.route("http://restore.local/**", route => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name.startsWith("api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
      if (name.startsWith("vendor/")) return route.fulfill({ body: "" });
      if (!name) {
        // The shell is tested independently of the agent UI's network configuration.
        const html = fs.readFileSync(new URL("index.html", root), "utf8").replace(/<script src="\.\/agent(?:-render)?\.js[^>]*><\/script>/g, "");
        return route.fulfill({ contentType: "text/html", body: html });
      }
      const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "image/svg+xml";
      return route.fulfill({ contentType: type, body: fs.readFileSync(new URL(name, root)) });
    });
    await page.route("https://fonts.googleapis.com/**", route => route.abort());
    await page.addInitScript(() => {
      const w = window as any;
      w.sockets = [];
      w.WebSocket = class extends EventTarget {
        static OPEN = 1; static CLOSING = 2;
        readyState = 0;
        constructor() { super(); w.sockets.push(this); }
        send() {}
        close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
      };
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://restore.local/");
    assert.equal(await page.locator("#startup").isVisible(), true);
    assert.equal(await page.locator("#empty").isVisible(), false);
    // Initial connection timeout must expose a useful retry control.
    await page.getByRole("button", { name: "Retry connection" }).waitFor({ state: "visible", timeout: 8000 });
    await page.getByRole("button", { name: "Retry connection" }).click();
    await page.evaluate(() => {
      const w = window as any;
      const socket = w.sockets.at(-1);
      socket.readyState = 1; socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "snapshot", version: "3.0.2", tabs: [], closed: [], folders: [], templates: [], activeId: null }) }));
    });
    assert.equal(await page.locator("#startup").isVisible(), false);
    assert.equal(await page.locator("#empty").isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-restoring")), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
