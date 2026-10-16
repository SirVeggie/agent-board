import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "../chromium.js";
import { chatScripts, loadShellScripts } from "../testSupport/shell.js";

const agent = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");

/** The production chat view in a bare page: no daemon, no shell; the test feeds it events (#431). */
async function chatPage() {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Transcript update test" });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  // localStorage needs a real origin.
  await page.route("http://chat.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<body></body>" }));
  await page.goto("http://chat.test/");
  const exposed = agent.replace(/  if \(document\.readyState === "loading"\)[\s\S]*?else boot\(\);/, `
    window.T = {
      S, onEvent, view: full.view, R,
      open(thread, items, turns) {
        S.threads.set(thread.id, thread);
        S.details.set(thread.id, { items, byId: new Map(items.map((it) => [it.id, it])), turns: new Map(turns.map((t) => [t.id, t])) });
        S.fullOpen = true;
        document.body.append(full.view.root);
        full.view.threadId = thread.id;
        full.view.renderTranscript();
      },
      frame: () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
    };
  `);
  assert.notEqual(exposed, agent, "boot() is replaced");
  await loadShellScripts(page, {
    scripts: [...chatScripts, "/vendor/marked.js", "/vendor/purify.js", "agent.js"],
    transform: (name, source) => (name === "agent.js" ? exposed : source),
  });
  return { browser, page, errors };
}

const thread = { id: "t", title: "Thread", status: "running", scope: { kind: "global", ref: null }, stats: {}, provider: "claude", model: "m" };
const turn = { id: "u1", threadId: "t", seq: 1, status: "running", startedAt: 1 };
const items = [
  { id: "m", threadId: "t", turnId: "u1", seq: 1, kind: "user", text: "Go" },
  { id: "r", threadId: "t", turnId: "u1", seq: 2, kind: "reasoning", text: "Thinking **hard**", startedAt: 1, endedAt: 3000 },
  { id: "x", threadId: "t", turnId: "u1", seq: 3, kind: "tool", tool: "execute", toolId: "c1", title: "ls", detail: "ls", status: "done", output: "a\nb", startedAt: 1, endedAt: 2 },
  { id: "p", threadId: "t", turnId: "u1", seq: 4, kind: "approval", requestId: "p", title: "Run rm", status: "pending", options: [{ id: "allow", kind: "allow_once", label: "Allow" }, { id: "deny", kind: "reject_once", label: "Deny" }] },
];

test("a turn's unchanged steps stay in the page, typed notes survive, and collapsed bodies build on open", async () => {
  const { browser, page, errors } = await chatPage();
  try {
    await page.evaluate(([thread, items, turn]) => (window as any).T.open(thread, items, [turn]), [thread, items, turn] as const);
    const before = await page.evaluate(() => {
      const w = window as any;
      const tool = document.querySelector('[data-item-id="x"]')!;
      const reason = document.querySelector('[data-item-id="r"]')!;
      const note = document.querySelector('[data-item-id="p"] input') as HTMLInputElement;
      note.value = "because";
      note.dispatchEvent(new Event("input"));
      w.kept = { tool, reason, note };
      // Collapsed: nothing built yet.
      return [tool.querySelector(".ag-tool-body")!.childElementCount, reason.querySelector(".ag-reason-body")!.childElementCount];
    });
    assert.deepEqual(before, [0, 0]);

    // A new step and a changed approval in the same turn.
    await page.evaluate(async () => {
      const w = window as any;
      w.T.onEvent({ type: "agent_item", item: { id: "y", threadId: "t", turnId: "u1", seq: 5, kind: "text", text: "Done." } });
      const p = w.T.S.details.get("t").byId.get("p");
      w.T.onEvent({ type: "agent_item", item: { ...p, title: "Run rm -rf" } });
      await w.T.frame();
    });
    const after = await page.evaluate(() => {
      const w = window as any;
      const tool = document.querySelector('[data-item-id="x"]');
      const note = document.querySelector('[data-item-id="p"] input') as HTMLInputElement;
      return [tool === w.kept.tool, document.querySelector('[data-item-id="r"]') === w.kept.reason, note === w.kept.note, note.value,
        Boolean(document.querySelector('[data-item-id="y"]')), document.querySelectorAll("[data-sync-keep]").length,
        tool!.classList.contains("ag-step-last")];
    });
    // The approval was rebuilt, but its note came back from the model.
    assert.deepEqual(after, [true, true, false, "because", true, 0, true]);

    const opened = await page.evaluate(() => {
      (document.querySelector('[data-item-id="x"] .ag-tool-head') as HTMLElement).click();
      (document.querySelector('[data-item-id="r"] .ag-reason-head') as HTMLElement).click();
      return [document.querySelector('[data-item-id="x"] .ag-out')?.textContent, document.querySelector('[data-item-id="r"] strong')?.textContent];
    });
    assert.deepEqual(opened, ["a\nb", "hard"]);

    // Opened steps stay open and built through another update.
    const still = await page.evaluate(async () => {
      const w = window as any;
      w.T.onEvent({ type: "agent_item", item: { id: "z", threadId: "t", turnId: "u1", seq: 6, kind: "text", text: "More." } });
      // A later step on the same rail takes the last-step mark from the kept one.
      w.T.onEvent({ type: "agent_item", item: { id: "w", threadId: "t", turnId: "u1", seq: 3.5, kind: "tool", tool: "execute", toolId: "c2", title: "pwd", detail: "pwd", status: "running", startedAt: 5 } });
      await w.T.frame();
      const tool = document.querySelector('[data-item-id="x"]')!;
      return [tool === w.kept.tool, tool.classList.contains("open"), Boolean(tool.querySelector(".ag-out")), tool.classList.contains("ag-step-last"),
        document.querySelector('[data-item-id="y"]')!.classList.contains("ag-answer-earlier")];
    });
    assert.deepEqual(still, [true, true, true, false, true]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
