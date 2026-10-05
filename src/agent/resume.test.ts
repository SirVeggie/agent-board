import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { TurnInput } from "./providers/provider.js";
import type { Item, Turn } from "./types.js";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-resume-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

type Host = InstanceType<typeof AgentHost>;
const hosts: Host[] = [];

before(() => store.load());

after(() => {
  for (const host of hosts) host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A host whose sessions record their turns and never finish them, as if the agent were still at work. */
function startHost(): { host: Host; ran: Map<string, TurnInput[]> } {
  const host = new AgentHost(() => {});
  hosts.push(host);
  const ran = new Map<string, TurnInput[]>();
  const internals = host as unknown as { providers: Record<string, { createSession: (thread: { id: string }) => unknown }> };
  internals.providers.pi.createSession = (thread) => ({
    update: () => {},
    warm: async () => {},
    run: (input: TurnInput) => {
      ran.set(thread.id, [...(ran.get(thread.id) ?? []), input]);
      return new Promise(() => {});
    },
    cancel: async () => {},
    dispose: () => {},
  });
  return { host, ran };
}

/** Leave a thread as a restart finds it: its last turn still running, and maybe messages queued behind it. */
function cutOff(host: Host, opts: { queued?: Array<Partial<Item>>; earlierInterrupted?: number } = {}): string {
  const thread = host.createThread({ provider: "pi", mode: "board", scope: { kind: "global", ref: null } });
  const turns: Turn[] = [];
  const earlier = opts.earlierInterrupted ?? 0;
  for (let i = 0; i <= earlier; i++) {
    const last = i === earlier;
    turns.push({ id: `tu_${thread.id}_${i}`, threadId: thread.id, seq: i + 1, status: last ? "running" : "cancelled", ...(last ? {} : { interrupted: true }), model: "m", effort: null, mode: "board", startedAt: Date.now() });
  }
  for (const turn of turns) host.db.saveTurn(turn);
  const items = (opts.queued ?? []).map((extra, i) => ({ id: `it_${thread.id}_${i}`, threadId: thread.id, turnId: null, seq: i + 1, createdAt: Date.now(), kind: "user", text: `queued ${i}`, ...extra }) as Item);
  host.db.saveItems(items);
  return thread.id;
}

const userItems = (host: Host, threadId: string) => (host.threadDetail(threadId)?.items ?? []).filter((it): it is Item & { kind: "user" } => it.kind === "user");

test("a turn cut off by a restart is sent on with Scribe's note, and queued messages queue again", () => {
  const first = startHost().host;
  const id = cutOff(first, { queued: [{}, { card: { num: 7, title: "Fix" } }, { images: [{ id: "f1", name: "a.png", mimeType: "image/png", size: 1 }] }] });
  const looping = cutOff(first, { earlierInterrupted: 3 });
  first.dispose();
  hosts.splice(hosts.indexOf(first), 1);

  const { host, ran } = startHost();
  // Until it is sent on, the board must not take it for a stopped agent and release its card.
  assert.equal(host.runInfo(id).exists && host.runInfo(id).running, true);
  const cut = host.threadDetail(id)!.turns[0];
  assert.equal(cut.status, "cancelled");
  assert.equal(cut.interrupted, true);

  assert.deepEqual(host.resumeInterrupted(), [id]);
  const items = userItems(host, id);
  const note = items.at(-1)!;
  assert.equal(note.from, "scribe");
  assert.match(note.text, /^Scribe restarted while you were working/);
  assert.ok(note.turnId);
  // Text messages wait behind the new turn; one with an image cannot be sent again.
  const queued = (host as unknown as { queues: Map<string, Array<{ text: string; card?: { board: string } }>> }).queues.get(id)!;
  assert.deepEqual(queued.map((m) => m.text), ["queued 0", "queued 1"]);
  assert.equal(queued[1].card?.board, "");
  assert.equal(items.find((it) => it.text === "queued 2")?.dropped, true);

  // A thread whose turns keep getting cut off is left alone, so a turn that crashes Scribe cannot loop.
  assert.equal(host.runInfo(looping).exists && host.runInfo(looping).running, false);
  assert.equal(userItems(host, looping).length, 0);
});

test("the resumed turn reaches the agent worded as Scribe's", async () => {
  const first = startHost().host;
  const id = cutOff(first);
  first.dispose();
  hosts.splice(hosts.indexOf(first), 1);
  const { host, ran } = startHost();
  host.resumeInterrupted();
  for (let i = 0; i < 50 && !ran.get(id); i++) await new Promise((r) => setTimeout(r, 10));
  const [input] = ran.get(id) ?? [];
  assert.ok(input);
  assert.match(input.text, /<context>\nSent by Scribe itself, not typed by the user\.\n<\/context>/);
  assert.match(input.text, /Scribe restarted while you were working/);
});
