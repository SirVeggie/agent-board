import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";

const source = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("updates keep hovered rows and focused editors connected", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Hover stability test" });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<script>
      window.scribe = {
        state: {
          columns: [{ id: 'todo', title: 'Todo' }, { id: 'done', title: 'Done' }], labels: [], settings: {}, nextNum: 3,
          cards: [{ id: 'a', num: 1, col: 'todo', title: 'One', description: 'Description', images: [{ data: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>' }] },
                  { id: 'b', num: 2, col: 'todo', title: 'Two' }]
        }, local: {},
        set(patch) { Object.assign(this.state, patch); },
        setLocal(patch) { Object.assign(this.local, patch); },
        onChange(fn) { this.changed = fn; }
      };
    </script>${source("../templates/builtin/kanban.html")}`);
    await page.locator('.card[data-id="a"]').hover();
    assert.deepEqual(await page.evaluate(() => {
      const w = window as any;
      const row = document.querySelector('.card[data-id="a"]')!;
      const observer = new MutationObserver(() => {});
      observer.observe(document.body, { childList: true, subtree: true });
      const image = row.querySelector("img");
      const column = row.closest(".column");
      const button = column!.querySelector(".col-menu-btn");
      w.scribe.state.cards[1].comments = [{ id: "comment", by: "Sol", text: "Update", at: Date.now() }];
      w.scribe.changed();
      return [row === document.querySelector('.card[data-id="a"]'), image === row.querySelector("img"),
        column === row.closest(".column"), button === column!.querySelector(".col-menu-btn"),
        observer.takeRecords().every(record => [...record.removedNodes].every(n => n !== row && !n.contains(row)))];
    }), [true, true, true, true, true]);
    // An unrelated event must not restart an inline column rename or discard its draft.
    await page.locator('.col-title').first().click();
    await page.locator('.col-title-input').fill('Draft column');
    assert.deepEqual(await page.evaluate(() => {
      const w = window as any;
      const input = document.activeElement as HTMLInputElement;
      input.setSelectionRange(2, 5);
      w.scribe.changed();
      w.scribe.changed();
      return [document.activeElement === input, input.isConnected, input.value, input.selectionStart, input.selectionEnd];
    }), [true, true, "Draft column", 2, 5]);
    await page.locator('.col-title-input').press('Enter');
    await page.locator('.add-card').first().click();
    await page.locator('.composer-input').fill('Draft card');
    assert.deepEqual(await page.evaluate(() => {
      const w = window as any;
      const input = document.activeElement as HTMLTextAreaElement;
      input.setSelectionRange(1, 4);
      w.scribe.changed();
      return [document.activeElement === input, input.isConnected, input.value, input.selectionStart, input.selectionEnd];
    }), [true, true, "Draft card", 1, 4]);
    await page.locator('.card[data-id="a"] .card-title').click();
    await page.locator('#mdPreview').click();
    await page.locator('#mdEditor').fill('Unsent description');
    assert.deepEqual(await page.evaluate(() => {
      const w = window as any;
      const editor = document.activeElement as HTMLTextAreaElement;
      editor.setSelectionRange(3, 7);
      for (let i = 0; i < 5; i++) {
        w.scribe.state.settings.workerLog = [{ text: "Worker update " + i }];
        w.scribe.state.cards[1].status = { kind: "working", text: "Working " + i };
        w.scribe.changed();
      }
      return [document.activeElement === editor, editor.value, editor.selectionStart, editor.selectionEnd];
    }), [true, "Unsent description", 3, 7]);

    await page.setContent(`<script>
      window.scribe = {
        state: { todos: [{ id: 'a', text: 'One', done: false }, { id: 'b', text: 'Two', done: false }] }, local: {},
        set(patch) { Object.assign(this.state, patch); }, setLocal(patch) { Object.assign(this.local, patch); },
        bind() {}, onChange(fn) { this.changed = fn; }
      };
    </script>${source("../templates/builtin/todo-list.html")}`);
    await page.locator('.item[data-id="a"]').hover();
    assert.deepEqual(await page.evaluate(() => {
      const w = window as any;
      const row = document.querySelector('.item[data-id="a"]')!;
      const observer = new MutationObserver(() => {});
      observer.observe(document.body, { childList: true, subtree: true });
      w.scribe.state.todos[1].text = "Changed";
      w.scribe.changed();
      return [row === document.querySelector('.item[data-id="a"]'),
        observer.takeRecords().every(record => [...record.removedNodes].every(n => n !== row && !n.contains(row)))];
    }), [true, true]);
    await page.locator('.item[data-id="a"] .check').click();
    assert.equal(await page.locator('.item[data-id="a"] .check').isChecked(), true);
    assert.equal(await page.evaluate(() => (window as any).scribe.state.todos[0].done), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("shell updates retain composer pills, thread controls and template rows with live handlers", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Shell hover stability test" });
  try {
    const page = await browser.newPage();
    await page.route("http://hover.test/**", route => route.fulfill({ contentType: "text/html", body: '<div id="threads"></div><div id="bar"></div><div id="tail"></div><div id="templates"></div>' }));
    await page.goto("http://hover.test/");
    await page.addScriptTag({ content: source("../public/dom-sync.js") });
    const agent = source("../public/agent.js");
    const app = source("../public/app.js");
    // Exercise the production renderers with a small host, without starting the shell or a daemon.
    await page.addScriptTag({ content: `
      const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
      const icon = name => el('span', 'icon', name);
      const button = (text, cls, fn, tip) => { const n = el('button', cls); if (typeof text === 'string') n.textContent = text; else n.append(text); n.onclick = fn; if (tip) n.dataset.tooltip = tip; return n; };
      const S = { threads: new Map(), filter: 'all', search: '', hidePageThreads: false };
      const LS = { filter: 'filter', hidePage: 'hidePage', compact: 'compact' };
      const compactThreads = () => localStorage.getItem(LS.compact) === '1';
      const movedBanners = () => [], renderLists = () => renderThreadList(document.querySelector('#threads'), {});
      ${agent.slice(agent.indexOf('  function renderThreadList('), agent.indexOf('  /** The line under a thread', agent.indexOf('  function renderThreadList(')))}
      const modelInfo = () => ({ label: 'Model', efforts: [] }), providerIcon = icon;
      const MODES = [{ id: 'plan', label: 'Plan' }], WEB_MODES = [{ id: 'off', label: 'Off' }];
      const webMode = () => 'off', webEnforced = () => true;
      const openWorktree = () => null, usageChip = () => null, contextMeter = () => el('span', 'context', 'Context');
      const bindHoverTip = () => {}, worktreePendingTip = value => String(value), sendKey = () => 'enter';
      const settings = { provider: 'test', model: 'test', mode: 'plan', cwd: 'workspace', useWorktree: false };
      const view = {
        settings: () => settings, thread: () => null, bar: document.querySelector('#bar'), sendSlot: document.querySelector('#tail'),
        renderForkNote() {}, setWorktree(value) { settings.useWorktree = value; },
        ${agent.slice(agent.indexOf('    renderComposerBar() {'), agent.indexOf('\n    /**', agent.indexOf('    renderComposerBar() {')))}
      };
      const state = { templates: [{ id: 'one', title: 'Template', fields: [{ key: 'old' }] }], builtinTemplates: [] };
      const FILE_SVG = '', BUILTIN_SVG = '', TEMPLATE_CARD_DELAY = 0, hoverCard = { bind() {} };
      const findTemplateMeta = id => state.templates.find(t => t.id === id);
      const openTemplateModal = template => window.opened = template;
      ${app.slice(app.indexOf('  function templateRow('), app.indexOf('  function builtinMenu('))}
      window.check = () => {
        renderLists(); view.renderComposerBar();
        window.scribeSyncChildren(document.querySelector('#templates'), state.templates.map(t => templateRow(t, false)));
      };
      window.replaceMetadata = () => { state.templates = [{ ...state.templates[0], fields: [{ key: 'new' }] }]; };
      window.check();
    ` });
    assert.deepEqual(await page.evaluate(() => {
      const w = window as any;
      const controls = [...document.querySelectorAll('#threads input, #threads button, #bar button, #tail button, #templates > div')];
      const search = document.querySelector('input')!;
      search.focus();
      w.replaceMetadata();
      w.check(); w.check();
      return [controls.every(n => n.isConnected), document.activeElement === search];
    }), [true, true]);
    await page.locator('#templates > div').click();
    assert.equal(await page.evaluate(() => (window as any).opened.fields[0].key), 'new');
    await page.locator('#bar .ag-wt-icon').click();
    assert.equal(await page.evaluate(() => { (window as any).check(); return document.querySelector('#bar .ag-wt-icon')!.classList.contains('on'); }), true);
    await page.locator('#bar .ag-wt-icon').click();
    assert.equal(await page.evaluate(() => { (window as any).check(); return document.querySelector('#bar .ag-wt-icon')!.classList.contains('on'); }), false);
  } finally {
    await browser.close();
  }
});
