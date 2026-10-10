import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/newpage.js", import.meta.url), "utf8");

function screen(webgl = true) {
  let selected = "nebula";
  let working = false;
  let step: (dt: number) => void = () => {};
  let motionChange = () => {};
  let running = false;
  const events: Record<string, (event?: any) => void> = {};
  let provider = "claude";
  let providerColors: string | null = null;
  const palettes: Record<string, string[]> = {
    claude: ["#2a0a06", "#a8321a", "#f08a2c", "#ffe1a6"],
    codex: ["#0d2a5c", "#3b82f6", "#93c5fd", "#fff7d6"],
  };
  const uniforms: Record<string, any> = {};
  const classes = new Set<string>();
  const css: Record<string, string> = {};
  const draws: { u_time: number; u_motionTime: number; u_work: number }[] = [];
  const shaders: string[] = [];
  const animations: { finished: Promise<void>; finish: () => void; cancelled: boolean; cancel: () => void }[] = [];
  const timers = new Map<number, () => void>();
  const motion = { matches: false, addEventListener: (_: string, fn: () => void) => { motionChange = fn; } };
  const node = () => ({
    hidden: false, textContent: "", innerHTML: "",
    classList: { toggle(_name: string, _on: boolean) {} }, addEventListener() {}, replaceChildren() {},
    cloneNode: () => node(), replaceWith() {}, querySelector: (_: string): any => node(),
  });
  const root = node();
  (root as any).animate = () => {
    let finish!: () => void;
    const animation = { finished: new Promise<void>((resolve) => { finish = resolve; }), finish: () => finish(), cancelled: false, cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation;
  };
  root.classList.toggle = (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name); };
  (root as any).style = { setProperty: (name: string, value: string) => { css[name] = value; } };
  const parts = new Map<string, ReturnType<typeof node>>();
  root.querySelector = (key: string) => {
    if (!parts.has(key)) parts.set(key, node());
    return parts.get(key)!;
  };
  const win: any = {
    matchMedia: () => motion,
    addEventListener: (name: string, fn: () => void) => { events[name] = fn; },
    scribeOrb: { colors: (p: string) => palettes[p] },
    scribeGL: {
      create: (_: unknown, shader: string) => {
        shaders.push(shader);
        return { set: (values: any) => Object.assign(uniforms, values), destroy() {}, draw: (values: any) => draws.push(values) };
      },
      loop: (fn: (dt: number) => void) => {
        step = fn;
        return { start: () => { running = true; }, stop: () => { running = false; } };
      },
    },
  };
  if (!webgl) delete win.scribeGL;
  class Observer { observe() {} }
  runInNewContext(source, {
    window: win, document: { getElementById: () => root, documentElement: {} },
    localStorage: { getItem: (key: string) => key === "scribe.newPageProviderColors" ? providerColors : selected }, matchMedia: () => motion,
    getComputedStyle: () => ({ backgroundColor: "rgb(17, 18, 24)" }),
    MutationObserver: Observer, ResizeObserver: Observer,
    setTimeout: (fn: () => void) => { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const page = win.createNewPage({
    templates: () => [], builtins: () => [], threads: () => 1, working: () => working,
    openChat() {},
    provider: () => provider,
  });
  return {
    page, draws, shaders, motion, uniforms, classes, css, root, animations, timers,
    frame: () => {
      const listeners = new Set<() => void>();
      return { dataset: {} as Record<string, string>, animate: (root as any).animate,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
        load: () => [...listeners].forEach((fn) => fn()), listeners };
    },
    provider: (p: string) => { provider = p; events["scribe:dock-provider"]({ detail: { provider: p } }); },
    tint: (value: boolean) => { providerColors = value ? "1" : "0"; events["scribe:newpage-bg"](); },
    customize: () => { palettes.codex[1] = "#12ab34"; events["scribe:orb-appearance"](); },
    tick: (dt: number) => { if (running) step(dt); },
    busy: (value: boolean) => { working = value; },
    choose: (id: string) => { selected = id; events["scribe:newpage-bg"](); },
    reduce: (value: boolean) => { motion.matches = value; motionChange(); },
    running: () => running,
  };
}

test("replacement waits for load, survives rerenders and stops the backdrop after fading", async () => {
  const s = screen();
  const frame = s.frame();
  s.page.render({ id: "draft" });
  s.page.replace({ id: "draft" }, frame);
  s.page.replace({ id: "draft" }, frame);
  assert.equal(s.root.hidden, false);
  assert.equal(frame.listeners.size, 1);
  assert.equal(s.animations.length, 0);
  frame.load();
  assert.equal(s.animations.length, 2);
  assert.equal(s.timers.size, 0);
  s.animations.forEach((animation) => animation.finish());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.root.hidden, true);
  assert.equal(s.running(), false);
});

test("switching pages cancels a pending replacement and reduced motion skips the fade", () => {
  const s = screen();
  const frame = s.frame();
  s.page.render({ id: "draft" });
  s.page.replace({ id: "draft" }, frame);
  s.page.render({ id: "other" });
  assert.equal(frame.listeners.size, 0);
  assert.equal(s.timers.size, 0);
  frame.load();
  assert.equal(s.animations.length, 0);
  s.reduce(true);
  frame.dataset.loaded = "1";
  s.page.replace({ id: "other" }, frame);
  assert.equal(s.root.hidden, true);
  assert.equal(s.animations.length, 0);
});

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

test("provider palettes update live, preserve the shader and restore defaults when disabled", () => {
  const s = screen();
  s.reduce(true);
  s.page.render({ id: "draft" });
  assert.equal(s.uniforms.u_tint, 1);
  assert.equal(s.css["--np-c1"], "168,50,26");
  const count = s.shaders.length;
  const time = s.draws.at(-1)!.u_time;
  s.provider("codex");
  assert.equal(s.css["--np-c1"], "59,130,246");
  assert.equal(s.uniforms.u_c1.join(","), [59 / 255, 130 / 255, 246 / 255].join(","));
  s.customize();
  assert.equal(s.css["--np-c1"], "18,171,52");
  assert.equal(s.shaders.length, count);
  assert.equal(s.draws.at(-1)!.u_time, time);
  s.tint(false);
  assert.equal(s.uniforms.u_tint, 0);
  assert.equal(s.classes.has("provider-colors"), false);
  s.provider("claude");
  assert.equal(s.uniforms.u_tint, 0);
  s.tint(true);
  assert.equal(s.uniforms.u_tint, 1);
  assert.equal(s.css["--np-c1"], "168,50,26");
});

test("Bokeh drift speeds up gently without jumping on working changes, and freezes with reduced motion", () => {
  const s = screen();
  s.choose("bokeh");
  s.page.render({ id: "draft" });
  s.tick(.1);
  const idle = s.draws.at(-1)!;
  s.busy(true);
  s.page.render({ id: "draft" });
  s.tick(.1);
  const entering = s.draws.at(-1)!;
  assert.ok(entering.u_motionTime - idle.u_motionTime > .1);
  assert.ok(entering.u_motionTime - idle.u_motionTime < .11);
  s.tick(1);
  const busy = s.draws.at(-1)!;
  assert.ok(Math.abs(busy.u_motionTime - entering.u_motionTime - 1.1) < 1e-10);
  s.busy(false);
  s.page.render({ id: "draft" });
  s.tick(.1);
  const leaving = s.draws.at(-1)!;
  assert.ok(leaving.u_motionTime - busy.u_motionTime > .1);
  assert.ok(leaving.u_motionTime - busy.u_motionTime < .11);
  s.reduce(true);
  s.busy(true);
  s.page.render({ id: "draft" });
  s.tick(1);
  assert.equal(s.draws.at(-1)!.u_motionTime, leaving.u_motionTime);
  assert.equal(s.draws.at(-1)!.u_work, 1);
});

test("CSS fallback follows providers and the setting without WebGL", () => {
  const s = screen(false);
  s.page.render({ id: "draft" });
  assert.equal(s.classes.has("provider-colors"), true);
  s.provider("codex");
  assert.equal(s.css["--np-c2"], "147,197,253");
  s.tint(false);
  assert.equal(s.classes.has("provider-colors"), false);
  s.page.render(null);
  s.provider("claude");
  assert.equal(s.classes.has("provider-colors"), false);
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
