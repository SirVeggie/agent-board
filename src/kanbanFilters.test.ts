import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";

test("Kanban filters cycle, combine includes, and give exclusions precedence", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban filter test" });
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
    await page.setContent(`<script>
      window.scribe = {
        state: {
          columns: [{ id: 'todo', title: 'Todo' }],
          labels: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
          nextNum: 5, settings: {},
          cards: [
            { id: '1', num: 1, col: 'todo', title: 'One', labels: ['a'], priority: 3, assignee: 'Sol' },
            { id: '2', num: 2, col: 'todo', title: 'Two', labels: ['b'], priority: 0, assignee: 'Luna' },
            { id: '3', num: 3, col: 'todo', title: 'Three', labels: ['a', 'b'], priority: 3, assignee: 'sol' },
            { id: '4', num: 4, col: 'todo', title: 'Four', labels: [], priority: 1, assignee: '' }
          ]
        },
        local: {},
        set(patch) { Object.assign(this.state, patch); },
        setLocal(patch) { Object.assign(this.local, patch); },
        onChange(fn) { this.changed = fn; }
      };
    </script>${html}`);
    const shown = () => page.locator(".cards .card").evaluateAll(nodes => nodes.map(n => (n as HTMLElement).dataset.id).sort());
    const filter = (id: string) => page.locator(`#${id}`).locator("xpath=preceding-sibling::button[1]");
    const option = (name: string) => page.getByRole("option", { name, exact: true });
    const clear = () => page.locator("#clearFilter").click();
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);

    await filter("fLabel").click();
    await option("Alpha: off").click();
    assert.deepEqual(await shown(), ["1", "3"]);
    assert.equal(await page.getByRole("listbox").isVisible(), true);
    await option("Beta: off").click();
    assert.deepEqual(await shown(), ["1", "2", "3"]);
    await option("Beta: included").click();
    assert.deepEqual(await shown(), ["1"]); // Both labels: exclusion wins.
    await option("Alpha: included").click();
    assert.deepEqual(await shown(), ["4"]); // Negative-only filters start with all cards.
    await option("Beta: excluded").click();
    assert.deepEqual(await shown(), ["2", "4"]);
    await option("Alpha: excluded").click();
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);
    assert.equal(await page.locator("#clearFilter").isVisible(), false);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("listbox").count(), 0);

    await filter("fPriority").click();
    await option("None: off").click();
    assert.deepEqual(await shown(), ["2"]); // Priority zero is a real selection.
    await option("High: off").click();
    assert.deepEqual(await shown(), ["1", "2", "3"]);
    await option("High: included").click();
    assert.deepEqual(await shown(), ["2"]);
    await option("Any priority: off").click();
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);
    assert.equal(await page.getByRole("listbox").isVisible(), true);
    await page.keyboard.press("Escape");

    await filter("fAssignee").click();
    await option("Sol: off").click();
    assert.deepEqual(await shown(), ["1", "3"]); // Names remain case-insensitive.
    await option("Unassigned: off").click();
    assert.deepEqual(await shown(), ["1", "3", "4"]);
    await option("Sol: included").click();
    assert.deepEqual(await shown(), ["4"]);
    await clear(); // Outside click closes the menu and clears all choices.
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);
    assert.equal(await page.getByRole("listbox").count(), 0);

    // Keyboard selection stays open and cycles the highlighted row.
    await filter("fPriority").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    assert.deepEqual(await shown(), ["2"]);
    await page.keyboard.press("Enter");
    assert.deepEqual(await shown(), ["1", "3", "4"]);
    await page.keyboard.press("Space");
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);
    await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("listbox").count(), 0);

    // Existing viewer selections migrate naturally on the next click.
    await page.evaluate(() => {
      const scribe = (window as any).scribe;
      scribe.local.view = { label: "a", priority: 3, assignee: "SOL" };
      scribe.changed();
    });
    assert.deepEqual(await shown(), ["1", "3"]);
    await filter("fLabel").click();
    await option("Alpha: included").click();
    assert.deepEqual(await shown(), []);
    await clear();

    // Different filter groups intersect their matches.
    await filter("fLabel").click();
    await option("Beta: off").click();
    await filter("fPriority").click();
    await option("High: off").click();
    assert.deepEqual(await shown(), ["3"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
