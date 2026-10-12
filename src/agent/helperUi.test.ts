import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";

test("helper cards open in place, preserve the parent, and attribute approvals", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Helper chat test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 850 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const approvals: string[] = [];
    await page.route("http://helpers.test/**", async (route) => {
      if (route.request().url().includes("/api/agent/approvals/")) {
        approvals.push(route.request().url().split("/").at(-1)!);
        return route.fulfill({ contentType: "application/json", body: "{}" });
      }
      return route.fulfill({ contentType: "text/html", body: '<main style="display:flex;width:460px;height:780px"></main>' });
    });
    await page.goto("http://helpers.test/");
    for (const name of ["app.css", "agent.css"]) await page.addStyleTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    await page.addScriptTag({ content: "window.__name = (fn) => fn;" });
    for (const name of ["motion.js", "dom-sync.js", "agent-render.js"]) await page.addScriptTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    // Exercise the real chat views with fixture data, without booting a daemon or providers.
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await page.addScriptTag({ content: source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.helperTest = { S, view: sidebar.view, views, onEvent, flyoutSnapshot, helperCall, liveStep, searchThreads, dock };") });
    await page.evaluate(() => {
      const { S, view } = (window as any).helperTest;
      const base = { provider: "claude", model: "sonnet", effort: null, mode: "code", approval: "ask", web: "off", cwd: null, scope: { kind: "global", ref: null }, stats: { turns: 1, files: 0, added: 0, removed: 0 }, createdAt: 1, activityAt: 1, archived: false, unread: false, queued: 0 };
      S.config.providers = [{ id: "claude", label: "Claude", available: true }];
      S.threads.set("parent", { ...base, id: "parent", title: "Main task", status: "idle" });
      S.threads.set("helper", { ...base, id: "helper", helperOf: "parent", title: "Helper: Audit the files", status: "running", activity: { line: "Reading files" } });
      const tool = { id: "launch", threadId: "parent", turnId: "turn", seq: 1, kind: "tool", name: "mcp__scribe__agent_run", tool: "mcp", title: "Helper", helper: "helper", input: { task: "Audit the files", provider: "claude" }, status: "done", output: JSON.stringify({ thread: "helper", status: "running" }), startedAt: 1 };
      S.details.set("parent", { items: [tool], byId: new Map([[tool.id, tool]]), turns: new Map([["turn", { id: "turn", status: "done" }]]) });
      const text = { id: "reply", threadId: "helper", turnId: "helper-turn", seq: 1, kind: "text", text: "I am checking the files." };
      S.details.set("helper", { items: [text], byId: new Map([[text.id, text]]), turns: new Map([["helper-turn", { id: "helper-turn", status: "running" }]]) });
      document.querySelector("main")!.append(view.root);
      S.current = "parent";
      view.setThread("parent");
      view.input.value = "Parent draft";
    });
    // Header icons must be discoverable without seeing their custom hover tips.
    const parent = page.locator(".ag-view-side");
    for (const name of ["Thread actions", "Agent settings (Ctrl+Shift+,)", "New thread (Ctrl+Shift+K)", "Full window (Ctrl+Shift+L)", "Send (Enter)"]) {
      assert.equal(await parent.getByRole("button", { name, exact: true }).count(), 1, name);
    }
    const threadActions = parent.getByRole("button", { name: "Thread actions", exact: true });
    assert.equal(await threadActions.getAttribute("data-tooltip"), "Thread actions");
    assert.equal(await threadActions.getAttribute("title"), null);
    // Text and staged text labels keep their visible name, even with a longer tip.
    await page.evaluate(() => {
      const { button, icon, el } = (window as any).AgentRender;
      const fixture = el("div");
      fixture.id = "button-names";
      fixture.append(button("Save", "", null, "Save all changes"));
      const staged = button("", "", null, "Show threads started by workers");
      staged.append(icon("task"), el("span", null, "Show workers"));
      const labelled = el("span", null, "Review");
      labelled.prepend(icon("diff"));
      fixture.append(staged, button(labelled, "", null, "Review the full diff"));
      document.body.append(fixture);
    });
    for (const name of ["Save", "Show workers", "Review"]) {
      assert.equal(await page.locator("#button-names").getByRole("button", { name, exact: true }).count(), 1);
    }
    await page.locator("#button-names").evaluate(node => node.remove());
    assert.equal(await page.locator(".ag-helper-call .ag-task-badge").textContent(), "working");
    // The live feed names the helper, and the pickers keep it under its thread until a search asks for it.
    const picked = await page.evaluate(() => {
      const { S, liveStep, searchThreads, dock } = (window as any).helperTest;
      const anchor = document.createElement("button");
      document.body.append(anchor);
      dock.threadMenu(anchor);
      const menu = [...document.querySelectorAll(".ag-menu-item")].map((node) => [node.querySelector(".ag-menu-label")!.textContent, node.classList.contains("sub")]);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      anchor.remove();
      const hit = (r: any) => [r.id, r.title, r.locationLabel, r.snippet];
      return { step: liveStep(S.details.get("parent").items[0]).text, menu, all: searchThreads("").map(hit), found: searchThreads("audit").map(hit) };
    });
    assert.equal(picked.step, "Helper · Audit the files · sonnet");
    assert.deepEqual(picked.menu, [["New thread", false], ["Main task", false], ["Audit the files", true]]);
    assert.deepEqual(picked.all, [["parent", "Main task", "Thread", ""]]);
    assert.deepEqual(picked.found, [["helper", "Audit the files", "Helper", "Main task"]]);
    assert.equal(await page.getByRole("button", { name: "Open thread", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Open helper: Audit the files", exact: true }).click();
    assert.equal(await page.locator(".ag-view-helper .ag-title").textContent(), "Helper: Audit the files");
    assert.equal(await page.evaluate(() => (window as any).helperTest.S.current), "parent");
    assert.equal(await page.evaluate(() => (window as any).helperTest.views().length), 4);
    assert.equal(await page.locator(".ag-view-helper").getByRole("button", { name: "Stop (Esc twice)", exact: true }).count(), 1);
    if (process.env.SCRIBE_HELPER_SCREENSHOT) await page.screenshot({ path: process.env.SCRIBE_HELPER_SCREENSHOT.replace(/\.png$/, "-panel.png") });
    await page.locator('.ag-view-helper textarea:not([aria-hidden])').fill("Helper draft");
    await page.getByRole("button", { name: "Close helper and return to parent chat" }).click();
    assert.equal(await page.locator('.ag-view-side textarea:not([aria-hidden])').inputValue(), "Parent draft");
    await page.getByRole("button", { name: "Open helper: Audit the files", exact: true }).click();
    assert.equal(await page.locator('.ag-view-helper textarea:not([aria-hidden])').inputValue(), "Helper draft");
    await page.getByRole("button", { name: "Close helper and return to parent chat" }).click();
    await page.evaluate(() => {
      const { S, onEvent } = (window as any).helperTest;
      onEvent({ type: "agent_thread", thread: { ...S.threads.get("helper"), status: "waiting", asking: { kind: "approval", itemId: "helper-approval", title: "Run tests", detail: "npm test", options: [{ id: "allow", label: "Allow", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "reject_once" }] } } });
    });
    assert.match(await page.locator(".ag-helper-approval-name").textContent() || "", /Audit the files/);
    await page.locator(".ag-helper-approval").getByRole("button", { name: "Allow", exact: true }).click();
    assert.deepEqual(approvals, ["helper-approval"]);
    const active = await page.evaluate(() => (window as any).helperTest.flyoutSnapshot("button").rows.map((r: any) => [r.thread.id, r.thread.status]));
    assert.deepEqual(active, [["parent", "waiting"]]);
    if (process.env.SCRIBE_HELPER_SCREENSHOT) await page.screenshot({ path: process.env.SCRIBE_HELPER_SCREENSHOT });
    await page.evaluate(() => {
      const { S, onEvent } = (window as any).helperTest;
      const detail = S.details.get("helper");
      detail.turns.get("helper-turn").status = "done";
      detail.items[0].text = "Audit complete.";
      onEvent({ type: "agent_thread", thread: { ...S.threads.get("helper"), status: "idle", asking: undefined } });
    });
    assert.equal(await page.locator(".ag-helper-call .ag-task-badge").textContent(), "done");
    assert.equal(await page.locator(".ag-helper-approval").count(), 0);
    await page.getByRole("button", { name: "Show helper brief and report", exact: true }).click();
    assert.match(await page.locator(".ag-helper-call .ag-tool-body").textContent() || "", /Audit complete/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
