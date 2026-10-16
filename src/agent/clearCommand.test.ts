import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test("/clear opens a page-default draft in each chat layout without inheriting thread settings", async () => {
  for (const variant of ["side", "dock", "full"]) {
    for (const tab of [{ id: "current-page" }, null]) {
      const calls: string[] = [];
      const context = vm.createContext({
        activeTab: () => tab,
        setDockPick: (id: string, thread: string | null) => {
          assert.equal(thread, null);
          calls.push(`clear:${id}`);
        },
        dock: { renderTitle: () => calls.push("dock-title") },
        full: { renderList: () => calls.push("full-list") },
        sidebar: { listOpen: true, toggleList: () => calls.push("hide-list") },
        notice: () => {},
        inheritSettings: () => { throw new Error("Must not inherit settings"); },
      });
      vm.runInContext(between("  function defaultScope()", "  /* ---------- full window")
        + between("  function newThread(fromView", "  async function cycleMode()"), context);
      const view = vm.runInContext(`({${between("    async applyLocalSlash(name)", "    /** The thread's workspace folder")}})`, context);
      view.variant = variant;
      view.settings = () => { throw new Error("Must not read old thread settings"); };
      view.startDraft = (scope: unknown, settings: unknown) => {
        assert.deepEqual(JSON.parse(JSON.stringify(scope)), tab ? { kind: "page", ref: tab.id } : { kind: "global", ref: null });
        assert.deepEqual(JSON.parse(JSON.stringify(settings)), {});
        calls.push("draft");
      };
      await view.applyLocalSlash("clear");
      assert.ok(calls.includes("draft"));
      assert.equal(calls.includes("hide-list"), variant === "side");
      assert.equal(calls.includes("full-list"), variant === "full");
      assert.equal(calls.includes("clear:current-page"), variant === "dock" && Boolean(tab));
    }
  }
});

test("a reset page draft resolves workspace, mode and model from defaults", () => {
  const view = vm.runInNewContext(`({${between("    settings() {", "    async updateSettings(patch)")}})`, {
    prefs: () => ({ provider: "codex", models: { codex: "preferred-model" }, mode: "code", web: "on", recentWorkspaces: ["other-workspace"] }),
    providerAvailable: () => true,
    modelChoice: () => ({ effort: "high", modelParams: {} }),
    pageWorkspace: (id: string) => id === "current-page" ? "page-workspace" : null,
    approvalFor: () => "auto",
    webMode: (value: string, fallback: string) => value || fallback,
    dirKey: (value: string) => value,
  });
  view.thread = () => null;
  view.draft = { scope: { kind: "page", ref: "current-page" }, settings: {} };
  const settings = view.settings();
  assert.equal(settings.provider, "codex");
  assert.equal(settings.model, "preferred-model");
  assert.equal(settings.effort, "high");
  assert.equal(settings.mode, "board");
  assert.equal(settings.cwd, "page-workspace");
  assert.equal(settings.approval, "auto");
});

test("sending /clear consumes the command locally, including with attachments", async () => {
  for (const text of ["/clear", " /CLEAR \n"]) {
    const view = vm.runInNewContext(`({${between("    async send() {", "\n  }\n\n  /** Markdown to one plain line")}})`, {});
    const calls: string[] = [];
    view.input = { value: text };
    view.attachments = [{ name: "notes.txt" }];
    view.hidePicker = () => calls.push("hide");
    view.autosize = () => {};
    view.applyLocalSlash = async (name: string) => calls.push(name);
    await view.send();
    assert.equal(view.input.value, "");
    assert.deepEqual(calls, ["hide", "clear"]);
  }
});

test("the regular new-thread action still inherits the current chat settings", () => {
  const current = { scope: { kind: "workspace", ref: "workspace" }, model: "existing-model" };
  const view = {
    variant: "full",
    settings: () => current,
    startDraft: (scope: unknown, settings: unknown) => {
      assert.deepEqual(JSON.parse(JSON.stringify(scope)), current.scope);
      assert.equal(settings, current);
    },
  };
  const context = vm.createContext({ full: { renderList() {} }, inheritSettings: () => current, notice() {}, view });
  vm.runInContext(between("  function newThread(fromView", "  async function cycleMode()") + "newThread(view);", context);
});
