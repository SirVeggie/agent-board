import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";

test("Ask is gated by the default worker and leaves the card workflow intact", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban Ask test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const html = fs.readFileSync(new URL("../templates/builtin/kanban.html", import.meta.url), "utf8");
    const stub = `<script>
      window.launches = [];
      window.scribe = {
        id: 'board', title: 'Board', local: {},
        state: {
          columns: [{ id: 'todo', title: 'Todo' }], labels: [], nextNum: 2,
          settings: { workers: { sol: { name: 'Sol', provider: 'codex', model: 'chosen', mode: 'ask' } } },
          cards: [{ id: 'c1', num: 1, col: 'todo', title: 'Question', assignee: 'Person', thread: 'old',
            comments: [], createdAt: 1, movedAt: 1 }]
        },
        set(patch) { this.state = { ...this.state, ...patch }; this.wrote(); },
        setLocal(patch) { Object.assign(this.local, patch); },
        onChange(fn) { this.changed = fn; },
        wrote() { if (this.changed) queueMicrotask(() => this.changed(this.state, { source: 'local' })); },
        signal() {},
        agent: {
          options: async () => ({ ok: true, providers: [{ id: 'codex', available: true }] }),
          start: async (prompt, opts) => { window.launches.push({ prompt, opts }); return { ok: true, threadId: 'asked' }; },
          card: async () => { throw new Error('Must not resume the old worker'); }
        }
      };
    </script>`;
    await page.setContent(stub + html);
    await page.locator('.card[data-id="c1"] .card-title').click();
    assert.equal(await page.locator("#commentAsk").count(), 0);
    await page.locator("#commentBox").fill("Without a default");
    await page.locator("#commentPost").click();
    assert.equal(await page.locator(".comment-follow").count(), 0);
    await page.locator("#mClose").click();
    await page.locator("#workersBtn").click();
    const select = page.getByRole("button", { name: "Default model", exact: true });
    assert.equal(await select.textContent(), "None");
    await select.click();
    assert.deepEqual(await page.getByRole("option").allTextContents(), ["✓None", "Sol"]);
    await page.getByRole("option", { name: "Sol", exact: true }).click();
    assert.equal(await select.textContent(), "Sol");
    await page.keyboard.press("Escape");
    await page.locator('.card[data-id="c1"] .card-title').click();
    assert.equal(await page.locator("#commentAsk").count(), 0);
    await page.locator("#commentBox").fill("Why does this happen?");
    await page.locator("#commentPost").click();
    assert.equal(await page.locator(".comment-follow").getByRole("button", { name: "Continue", exact: true }).count(), 0);
    await page.locator(".comment-follow").getByRole("button", { name: "Ask", exact: true }).click();
    await page.waitForFunction(() => (window as any).scribe.state.cards[0].comments.at(-1).followUp === "asked");
    await page.locator("#commentBox").fill("A direct question");
    await page.locator("#commentPost").click();
    await page.locator(".comment-follow").last().getByRole("button", { name: "Ask", exact: true }).click();
    await page.waitForFunction(() => (window as any).launches.length === 2);
    const result = await page.evaluate(() => ({ card: (window as any).scribe.state.cards[0], launches: (window as any).launches }));
    assert.equal(result.card.assignee, "Person");
    assert.equal(result.card.col, "todo");
    assert.equal(result.card.thread, "old");
    assert.equal(result.card.claim, undefined);
    assert.equal(result.card.status, undefined);
    assert.equal(result.launches[0].opts.model, "chosen");
    assert.match(result.launches[1].prompt, /A direct question/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
