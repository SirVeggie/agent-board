import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ItemBody } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-follow-"));
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

function page(key: string): string {
  return store.upsert({ key, title: key, html: `<p>${key}</p>` }).tab.id;
}

test("followToPage rebinds a user thread to the page it opened", () => {
  const pageId = page("follow-target");
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: "t_old" } });
  assert.equal(host.followToPage(thread.id, pageId), true);
  assert.deepEqual(host.getThread(thread.id)?.scope, { kind: "page", ref: pageId });
});

test("followToPage binds a global floating-chat thread to the new page", () => {
  const pageId = page("follow-global");
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  assert.equal(host.followToPage(thread.id, pageId), true);
  assert.deepEqual(host.getThread(thread.id)?.scope, { kind: "page", ref: pageId });
});

test("followToPage is a no-op when the thread already belongs to that page", () => {
  const pageId = page("follow-same");
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: pageId } });
  assert.equal(host.followToPage(thread.id, pageId), false);
  assert.deepEqual(host.getThread(thread.id)?.scope, { kind: "page", ref: pageId });
});

test("followToPage leaves a board-owned thread on its page", () => {
  const pageId = page("follow-board");
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "page", ref: "t_board" } });
  const internals = host as unknown as { addItem: (threadId: string, turnId: string | null, body: ItemBody) => unknown };
  internals.addItem(thread.id, null, { kind: "user", text: "Take card #1", from: "page" });
  assert.equal(host.followToPage(thread.id, pageId), false);
  assert.deepEqual(host.getThread(thread.id)?.scope, { kind: "page", ref: "t_board" });
});

test("followToPage ignores a missing thread or page", () => {
  const pageId = page("follow-missing");
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  assert.equal(host.followToPage("th_nope", pageId), false);
  assert.equal(host.followToPage(thread.id, "t_nope"), false);
  assert.deepEqual(host.getThread(thread.id)?.scope, { kind: "global", ref: null });
});
