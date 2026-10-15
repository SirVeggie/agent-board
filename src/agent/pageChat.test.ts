import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  PAGE_CHAT_STALE_MS,
  pageDockThreadId,
  pageThreadIsStale,
  type PageChatThread,
} from "./pageChat.js";

const now = 1_700_000_000_000;
const hour = 60 * 60 * 1000;

function t(id: string, over: Partial<PageChatThread> = {}): PageChatThread {
  return {
    id,
    scope: { kind: "page", ref: "t_page" },
    cwd: "S:\\notes",
    activityAt: now,
    finishedAt: now - hour,
    status: "idle",
    ...over,
  };
}

test("a thread is stale only after two hours without an AI reply, unless it is still working", () => {
  assert.equal(pageThreadIsStale(t("fresh", { finishedAt: now - hour }), now), false);
  assert.equal(pageThreadIsStale(t("old", { finishedAt: now - PAGE_CHAT_STALE_MS - 1 }), now), true);
  assert.equal(pageThreadIsStale(t("edge", { finishedAt: now - PAGE_CHAT_STALE_MS }), now), false);
  assert.equal(pageThreadIsStale(t("run", { finishedAt: now - 5 * hour, status: "running" }), now), false);
  assert.equal(pageThreadIsStale(t("wait", { finishedAt: now - 5 * hour, status: "waiting" }), now), false);
  assert.equal(pageThreadIsStale(t("draft", { finishedAt: undefined }), now), false);
});

test("opening the dock shows the page's last thread unless that reply is older than two hours", () => {
  const fresh = t("fresh", { finishedAt: now - hour, activityAt: now - hour });
  const stale = t("stale", { finishedAt: now - 5 * hour, activityAt: now - 5 * hour });
  const running = t("run", { finishedAt: now - 5 * hour, activityAt: now, status: "running" });
  assert.equal(pageDockThreadId([fresh], { pageId: "t_page", now }), "fresh");
  assert.equal(pageDockThreadId([stale], { pageId: "t_page", now }), null);
  assert.equal(pageDockThreadId([stale], { pick: { id: "stale", at: 0 }, pageId: "t_page", now }), null);
  assert.equal(pageDockThreadId([fresh], { pick: { id: "fresh", at: 0 }, pageId: "t_page", now }), "fresh");
  assert.equal(pageDockThreadId([fresh, stale], { pageId: "t_page", now }), "fresh");
  assert.equal(pageDockThreadId([running], { pageId: "t_page", now }), "run");
});

test("a remembered pick that is gone falls through to the newest page thread", () => {
  const page = t("page", { activityAt: now - 10 });
  const older = t("older", { activityAt: now - 20, finishedAt: now - 20 });
  assert.equal(pageDockThreadId([page, older], { pick: { id: "missing", at: now }, pageId: "t_page", now }), "page");
});

test("a new thread the user started on the page stays new when they come back", () => {
  const fresh = t("fresh", { finishedAt: now - 60_000, activityAt: now - 60_000 });
  assert.equal(pageDockThreadId([fresh], { pick: { id: null, at: now - hour }, pageId: "t_page", now }), null);
});

test("picking an old thread keeps it for two hours from the pick", () => {
  const old = t("old", { finishedAt: now - 5 * hour, activityAt: now - 5 * hour });
  assert.equal(pageDockThreadId([old], { pick: { id: "old", at: now - hour }, pageId: "t_page", now }), "old");
  assert.equal(pageDockThreadId([old], { pick: { id: "old", at: now - 3 * hour }, pageId: "t_page", now }), null);
  // A recent reply keeps a pick fresh too.
  const recent = t("recent", { finishedAt: now - hour });
  assert.equal(pageDockThreadId([recent], { pick: { id: "recent", at: now - 5 * hour }, pageId: "t_page", now }), "recent");
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-page-chat-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;

before(() => {
  store.load();
  host = new AgentHost(() => undefined);
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createThread on a page does not inherit the last global workspace", () => {
  host.setPrefs({ recentWorkspaces: ["S:\\Library\\Projects\\agent-board"], scopeWorkspaces: { "page:t_empty": "S:\\wrong" } });
  const thread = host.createThread(
    { provider: "pi", mode: "board", scope: { kind: "page", ref: "t_empty" } },
    { remember: false }
  );
  assert.equal(thread.cwd, null);
});

test("a page takes the workspace of the thread that created it, and its new threads start there", () => {
  const maker = host.createThread(
    { provider: "pi", mode: "code", cwd: "S:\notes", scope: { kind: "global", ref: null } },
    { remember: false }
  );
  const { tab } = store.upsert({
    title: "Made by a thread",
    html: "<p>hi</p>",
    viewer: "agent",
    actor: { at: now, thread: maker.id, workspace: "S:\notes" },
  });
  assert.equal(tab.workspace, "S:\notes");
  assert.equal(tab.provenance?.created?.thread, maker.id);
  assert.equal("workspace" in (tab.provenance?.created ?? {}), false);
  const next = host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: tab.id } }, { remember: false });
  assert.equal(next.cwd, "S:\notes");
  // A later write by another thread leaves the page's workspace alone.
  store.update(tab.id, { title: "Changed", viewer: "agent", actor: { at: now, thread: "th_other", workspace: "S:\elsewhere" } });
  assert.equal(store.get(tab.id)?.workspace, "S:\notes");
  store.setWorkspace(tab.id, null);
  assert.equal(store.get(tab.id)?.workspace, undefined);
  const cleared = host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: tab.id } }, { remember: false });
  assert.equal(cleared.cwd, null);
});

test("createThread still uses recent workspaces when the thread is not on a page", () => {
  host.setPrefs({
    recentWorkspaces: ["S:\\Library\\Projects\\agent-board"],
    scopeWorkspaces: { "folder:f1": "S:\\folder-ws" },
  });
  const global = host.createThread({ provider: "pi", mode: "code", scope: { kind: "global", ref: null } }, { remember: false });
  assert.equal(global.cwd, "S:\\Library\\Projects\\agent-board");
  const folder = host.createThread({ provider: "pi", mode: "board", scope: { kind: "folder", ref: "f1" } }, { remember: false });
  assert.equal(folder.cwd, "S:\\folder-ws");
});

test("createThread keeps an explicit cwd, including none", () => {
  host.setPrefs({ recentWorkspaces: ["S:\\Library\\Projects\\agent-board"] });
  const none = host.createThread(
    { provider: "pi", mode: "board", cwd: null, scope: { kind: "page", ref: "t_explicit" } },
    { remember: false }
  );
  assert.equal(none.cwd, null);
  const set = host.createThread(
    { provider: "pi", mode: "board", cwd: "S:\\picked", scope: { kind: "page", ref: "t_explicit" } },
    { remember: false }
  );
  assert.equal(set.cwd, "S:\\picked");
});
