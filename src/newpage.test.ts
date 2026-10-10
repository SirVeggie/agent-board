import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/newpage.js", import.meta.url), "utf8");

function screen() {
  let selected = "nebula";
  let working = false;
  let step: (dt: number) => void = () => {};
  let motionChange = () => {};
  let running = false;
  const events: Record<string, () => void> = {};
  const draws: { u_time: number; u_work: number }[] = [];
  const shaders: string[] = [];
  const motion = { matches: false, addEventListener: (_: string, fn: () => void) => { motionChange = fn; } };
  const node = () => ({
    hidden: false, textContent: "", innerHTML: "",
    classList: { toggle() {} }, addEventListener() {}, replaceChildren() {},
    cloneNode: () => node(), replaceWith() {}, querySelector: (_: string): any => node(),
  });
  const root = node();
  const parts = new Map<string, ReturnType<typeof node>>();
  root.querySelector = (key: string) => {
    if (!parts.has(key)) parts.set(key, node());
    return parts.get(key)!;
  };
  const win: any = {
    addEventListener: (name: string, fn: () => void) => { events[name] = fn; },
    scribeGL: {
      create: (_: unknown, shader: string) => {
        shaders.push(shader);
        return { set() {}, destroy() {}, draw: (values: any) => draws.push(values) };
      },
      loop: (fn: (dt: number) => void) => {
        step = fn;
        return { start: () => { running = true; }, stop: () => { running = false; } };
      },
    },
  };
  class Observer { observe() {} }
  runInNewContext(source, {
    window: win, document: { getElementById: () => root, documentElement: {} },
    localStorage: { getItem: () => selected }, matchMedia: () => motion,
    getComputedStyle: () => ({ backgroundColor: "rgb(17, 18, 24)" }),
    MutationObserver: Observer, ResizeObserver: Observer,
  });
  const page = win.createNewPage({
    templates: () => [], builtins: () => [], threads: () => 1, working: () => working,
    openChat() {},
  });
  return {
    page, draws, shaders, motion,
    tick: (dt: number) => { if (running) step(dt); },
    busy: (value: boolean) => { working = value; },
    choose: (id: string) => { selected = id; events["scribe:newpage-bg"](); },
    reduce: (value: boolean) => { motion.matches = value; motionChange(); },
    running: () => running,
  };
}

test("working intensity eases in and out while drift keeps its pace and hidden screens stop", () => {
  const s = screen();
  s.page.render({ id: "draft" });
  s.tick(.1);
  const idle = s.draws.at(-1)!;
  assert.equal(idle.u_work, 0);
  s.busy(true);
  s.page.render({ id: "draft" });
  s.tick(.1);
  const busy = s.draws.at(-1)!;
  assert.ok(busy.u_work > 0 && busy.u_work < 1);
  assert.ok(Math.abs(busy.u_time - idle.u_time - .1) < 1e-10);
  s.busy(false);
  s.page.render({ id: "draft" });
  s.tick(.1);
  assert.ok(s.draws.at(-1)!.u_work < busy.u_work);
  s.page.render(null);
  const count = s.draws.length;
  s.tick(.1);
  assert.equal(s.running(), false);
  assert.equal(s.draws.length, count);
});

test("reduced motion freezes time, updates working state and preserves it across Settings changes", () => {
  const s = screen();
  s.reduce(true);
  s.page.render({ id: "draft" });
  const time = s.draws.at(-1)!.u_time;
  s.busy(true);
  s.page.render({ id: "draft" });
  assert.equal(s.running(), false);
  assert.equal(s.draws.at(-1)!.u_work, 1);
  assert.equal(s.draws.at(-1)!.u_time, time);
  s.choose("aurora");
  assert.match(s.shaders.at(-1)!, /u_work\*wave\*1\.4/);
  assert.equal(s.draws.at(-1)!.u_work, 1);
  s.choose("contours");
  assert.match(s.shaders.at(-1)!, /line\*wave\*u_work/);
  assert.equal(s.draws.at(-1)!.u_time, time);
  s.reduce(false);
  assert.equal(s.running(), true);
  s.tick(.1);
  assert.ok(s.draws.at(-1)!.u_time > time);
});
