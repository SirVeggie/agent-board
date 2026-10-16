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
      window.askThreads = {};
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
          start: async (prompt, opts) => {
            window.launches.push({ prompt, opts });
            return new Promise(resolve => { window.finishLaunch = () => {
              const id = 'asked' + window.launches.length;
              window.askThreads[id] = { id, status: 'running' };
              resolve({ ok: true, threadId: id });
            }; });
          },
          get: async id => ({ ok: true, thread: window.askThreads[id] }),
          steps: async () => ({ ok: true, steps: [] }),
          onSteps(fn) { window.sendSteps = fn; },
          onChange(fn) { window.threadChanged = fn; },
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
    const feed = page.locator('.comment-feed:not(.hidden)');
    await feed.getByText('Asking Sol…', { exact: true }).waitFor();
    await page.evaluate(() => (window as any).finishLaunch());
    await page.waitForFunction(() => (window as any).scribe.state.cards[0].comments.at(-1).followUp === "asked");
    assert.equal(await feed.count(), 1);
    await page.evaluate(() => (window as any).sendSteps({ id: 'asked1', steps: [{ key: 'tool1', kind: 'tool', text: 'Reading the card' }] }));
    await feed.getByText('Reading the card', { exact: true }).waitFor();
    // Streaming updates preserve the comment and its live line.
    await page.evaluate(() => { (window as any).liveComment = document.querySelector('.comment-feed:not(.hidden)')!.parentElement; });
    await page.evaluate(() => (window as any).sendSteps({ id: 'asked1', steps: [{ key: 'tool1', kind: 'tool', text: 'Reading the card details' }] }));
    await feed.getByText('Reading the card details', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).liveComment === document.querySelector('.comment-feed:not(.hidden)')!.parentElement), true);
    await page.locator("#commentBox").fill("A direct question");
    await page.locator("#commentPost").click();
    await page.locator(".comment-follow").last().getByRole("button", { name: "Ask", exact: true }).click();
    await page.waitForFunction(() => (window as any).launches.length === 2);
    await page.evaluate(() => (window as any).finishLaunch());
    await page.waitForFunction(() => (window as any).scribe.state.cards[0].comments.at(-1).askThread === 'asked2');
    assert.equal(await feed.count(), 2);
    await page.evaluate(() => (window as any).threadChanged({ id: 'asked1', status: 'idle', run: { phase: 'ended' } }));
    await page.waitForFunction(() => document.querySelectorAll('.comment-feed:not(.hidden)').length === 1);
    assert.match(await feed.locator('..').textContent() || '', /A direct question/);
    const launches = await page.evaluate(() => (window as any).launches);
    assert.equal(launches[0].opts.model, "chosen");
    assert.match(launches[1].prompt, /A direct question/);
    // A reload must reconnect to the Ask chat saved on the comment.
    await page.evaluate(() => {
      (window as any).savedBoard = structuredClone((window as any).scribe.state);
    });
    const saved = await page.evaluate(() => (window as any).savedBoard);
    await page.setContent(stub + `<script>scribe.state = ${JSON.stringify(saved)}; window.askThreads = { asked1: { id: 'asked1', status: 'idle' }, asked2: { id: 'asked2', status: 'running' } };</script>` + html);
    await page.locator('.card[data-id="c1"] .card-title').click();
    await page.waitForFunction(() => document.querySelectorAll('.comment-feed:not(.hidden)').length === 1);
    await page.evaluate(() => (window as any).sendSteps({ id: 'asked2', steps: [{ key: 'reason', kind: 'reason', text: 'Investigating the question' }] }));
    await feed.getByText('Investigating the question', { exact: true }).waitFor();
    await page.evaluate(() => (window as any).threadChanged({ id: 'asked2', status: 'idle', run: { phase: 'waiting' } }));
    await feed.getByText('Waiting for usage limit to reset…', { exact: true }).waitFor();
    await page.evaluate(() => (window as any).threadChanged({ id: 'asked2', status: 'idle' }));
    await page.waitForFunction(() => document.querySelectorAll('.comment-feed:not(.hidden)').length === 0);
    await page.evaluate(() => { (window as any).scribe.agent.start = async () => ({ ok: false, error: 'unavailable' }); });
    await page.locator('#commentBox').fill('Try another question');
    await page.locator('#commentPost').click();
    await page.locator('.comment-follow').last().getByRole('button', { name: 'Ask', exact: true }).click();
    await page.waitForFunction(() => (window as any).scribe.state.cards[0].comments.at(-1).followUp === 'askOffer');
    await page.waitForFunction(() => document.querySelectorAll('.comment-feed:not(.hidden)').length === 0);
    assert.equal(await page.locator('.comment-follow').last().getByRole('button', { name: 'Ask', exact: true }).isEnabled(), true);
    const result = { card: saved.cards[0] };
    assert.equal(result.card.assignee, "Person");
    assert.equal(result.card.col, "todo");
    assert.equal(result.card.thread, "old");
    assert.equal(result.card.claim, undefined);
    assert.equal(result.card.status, undefined);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
