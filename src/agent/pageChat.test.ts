import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Turn } from "./types.js";
import {
  PAGE_CHAT_STALE_MS,
  pageDockThreadId,
  pageThreadIsStale,
  pageThreadWorkspace,
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

test("a new page thread takes the workspace of the latest AI reply on that page", () => {
  const threads = [
    t("old", { finishedAt: now - 5 * hour, cwd: "S:\\old" }),
    t("new", { finishedAt: now - hour, cwd: "S:\\notes" }),
    t("other", { scope: { kind: "page", ref: "t_other" }, cwd: "S:\\other", finishedAt: now }),
    t("global", { scope: { kind: "global", ref: null }, cwd: "S:\\agent-board", finishedAt: now }),
  ];
  assert.equal(pageThreadWorkspace(threads, "t_page"), "S:\\notes");
});

test("a page with no AI replies has no workspace, even when other threads remember one", () => {
  const threads = [
    t("draft", { finishedAt: undefined, cwd: "S:\\notes" }),
    t("global", { scope: { kind: "global", ref: null }, cwd: "S:\\agent-board", finishedAt: now }),
  ];
  assert.equal(pageThreadWorkspace(threads, "t_page"), null);
  assert.equal(pageThreadWorkspace([], "t_page"), null);
});

test("archived threads and a worktree's home folder", () => {
  assert.equal(pageThreadWorkspace([t("gone", { archived: true, cwd: "S:\\gone" })], "t_page"), null);
  assert.equal(
    pageThreadWorkspace([t("wt", { cwd: "S:\\wt", worktree: { home: "S:\\proj" } })], "t_page"),
    "S:\\proj"
  );
});

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
  assert.equal(pageDockThreadId([stale], { pickId: "stale", pageId: "t_page", now }), null);
  assert.equal(pageDockThreadId([fresh], { pickId: "fresh", pageId: "t_page", now }), "fresh");
  assert.equal(pageDockThreadId([fresh, stale], { pageId: "t_page", now }), "fresh");
  assert.equal(pageDockThreadId([running], { pageId: "t_page", now }), "run");
});

test("a remembered pick that is gone falls through to the newest page thread", () => {
  const page = t("page", { activityAt: now - 10 });
  const older = t("older", { activityAt: now - 20, finishedAt: now - 20 });
  assert.equal(pageDockThreadId([page, older], { pickId: "missing", pageId: "t_page", now }), "page");
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

type HostInternals = {
  loadTurns: (id: string) => Turn[];
  saveTurn: (turn: Turn) => void;
  threads: Map<string, { cwd: string | null; worktree?: { home: string } | null }>;
};

function reply(threadId: string, endedAt: number): void {
  const internals = host as unknown as HostInternals;
  const turn: Turn = {
    id: `tu_${threadId}_${endedAt}`,
    threadId,
    seq: internals.loadTurns(threadId).length + 1,
    status: "done",
    model: "m",
    effort: null,
    mode: "board",
    startedAt: endedAt - 1000,
    endedAt,
  };
  internals.loadTurns(threadId).push(turn);
  internals.saveTurn(turn);
}

test("createThread on a page does not inherit the last global workspace", () => {
  host.setPrefs({ recentWorkspaces: ["S:\\Library\\Projects\\agent-board"], scopeWorkspaces: { "page:t_empty": "S:\\wrong" } });
  const thread = host.createThread(
    { provider: "pi", mode: "board", scope: { kind: "page", ref: "t_empty" } },
    { remember: false }
  );
  assert.equal(thread.cwd, null);
});

test("createThread on a page inherits cwd from that page's latest reply", () => {
  host.setPrefs({ recentWorkspaces: ["S:\\Library\\Projects\\agent-board"] });
  const prior = host.createThread(
    { provider: "pi", mode: "board", cwd: "S:\\notes", scope: { kind: "page", ref: "t_notes" } },
    { remember: false }
  );
  reply(prior.id, now);
  const older = host.createThread(
    { provider: "pi", mode: "board", cwd: "S:\\old-notes", scope: { kind: "page", ref: "t_notes" } },
    { remember: false }
  );
  reply(older.id, now - hour);
  const next = host.createThread(
    { provider: "pi", mode: "board", scope: { kind: "page", ref: "t_notes" } },
    { remember: false }
  );
  assert.equal(next.cwd, "S:\\notes");
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
  const prior = host.createThread(
    { provider: "pi", mode: "board", cwd: "S:\\notes", scope: { kind: "page", ref: "t_explicit" } },
    { remember: false }
  );
  reply(prior.id, now);
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
