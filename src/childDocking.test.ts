import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

function harness(desktop = true, child = false) {
  const events = new Map<string, Function>();
  const calls: any[] = [];
  let target: any = { edge: "right" };
  let dragging = false;
  const context: any = {
    location: { search: child ? "?popout=p" : "", pathname: "/" }, URLSearchParams,
    queueMicrotask: (fn: Function) => fn(), setInterval: () => {},
    addEventListener: (name: string, fn: Function) => events.set(name, fn),
    innerWidth: 1200, innerHeight: 800,
    BroadcastChannel: class { postMessage(msg: any) { calls.push(["message", msg.type]); } addEventListener() {} },
    __TAURI__: desktop ? { core: { invoke: async (name: string, args: any) => { calls.push([name, args.action]); } } } : undefined,
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(new URL("../public/popout.js", import.meta.url), "utf8"), context);
  const popout = context.scribePopout;
  popout.bindDocking({
    views: {
      beginPageDrag: (source: any) => calls.push(["begin", source.id]),
      updatePageDrag: (x: number, y: number) => { calls.push(["preview", x, y]); return target; },
      endPageDrag: () => calls.push(["end"]),
      dropPage: async (source: any, drop: any) => calls.push(["drop", source.id, drop.edge || drop.pane]),
    }, findAnyTab: (id: string) => id === "p", isDragging: () => dragging,
  });
  if (desktop && !child) popout.open({ id: "p" });
  calls.length = 0;
  return { calls, popout, events, send: (detail: any) => events.get("scribe:child-drag")?.({ detail }),
    setTarget: (value: any) => { target = value; }, setDragging: () => { dragging = true; } };
}

test("native child drag scales to CSS, clears suppressed previews, and docks only a valid release", async () => {
  const h = harness();
  await h.send({ id: "p", enabled: true, x: .75, y: .5 });
  assert.deepEqual(h.calls, [["begin", "p"], ["preview", 900, 400]]);
  await h.send({ id: "p", enabled: false, done: true }); // Shift / Escape / disabled setting
  assert.deepEqual(h.calls.at(-1), ["end"]);
  assert(h.popout.has("p"));
  await h.send({ id: "p", enabled: true, x: .5, y: .5 });
  await h.send({ id: "p", enabled: true, x: 1.1, y: .5, done: true });
  assert(h.popout.has("p"));
  assert.deepEqual(h.calls.at(-1), ["end"]);
  h.setTarget(null); // Title bar / sidebar / insufficient room
  await h.send({ id: "p", enabled: true, x: .5, y: .5, done: true });
  assert(h.popout.has("p"));
  h.setTarget({ pane: "left" });
  await h.send({ id: "p", enabled: true, x: .5, y: .5, done: true });
  assert(!h.popout.has("p"));
  assert.deepEqual(h.calls.slice(-4), [["end"], ["message", "close"], ["drop", "p", "left"], ["child_window", "focus-main"]]);
  const split = harness();
  await split.send({ id: "p", enabled: true, x: .9, y: .5, done: true });
  assert(split.calls.some(call => call[0] === "drop" && call[2] === "right"));
  const closed = harness();
  await closed.send({ id: "p", enabled: true, x: .5, y: .5 });
  closed.popout.windowClosed("child-p");
  await closed.send({ id: "p", enabled: true, x: .5, y: .5, done: true });
  assert.deepEqual(closed.calls.at(-1), ["end"]);
  assert(!closed.calls.some(call => call[0] === "drop"));
});

test("docking ignores other drags, unknown children, standalone chat and browser windows", async () => {
  const h = harness();
  for (const id of ["unknown", "agent-chat"]) await h.send({ id, enabled: true, x: .5, y: .5, done: true });
  h.setDragging();
  await h.send({ id: "p", enabled: true, x: .5, y: .5, done: true });
  assert.deepEqual(h.calls, []);
  assert.equal(harness(false).events.has("scribe:child-drag"), false);
  assert.equal(harness(true, true).events.has("scribe:child-drag"), false);
});
