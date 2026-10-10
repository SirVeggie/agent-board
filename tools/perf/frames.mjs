// What keeps the Scribe shell drawing frames while nothing happens: who calls requestAnimationFrame,
// which CSS animations run, and how many frames a second come out of it.
//
//   node tools/perf/frames.mjs --base http://127.0.0.1:4791 [--tab t_…] [--thread th_…] [--fx off] [--seconds 5] [--stream] [--motion reduce]
//
// --stream (with --thread, fake agents only) measures while a fake turn streams into that thread.
import { launch } from "./launch.mjs";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split(/\s*--/).filter(Boolean).map((part) => {
  const [key, ...rest] = part.trim().split(/\s+/);
  return [key, rest.join(" ") || true];
}));
const base = String(args.base || "http://127.0.0.1:4791");
const seconds = Number(args.seconds || 5);
const { browser } = await launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: args.motion === "reduce" ? "reduce" : "no-preference" });
await context.addInitScript(() => {
  const callers = (window.__raf = {});
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => {
    const line = (new Error().stack || "").split("\n")[2] || "";
    const where = line.replace(/^\s*at\s+/, "").replace(/https?:\/\/[^/]+/, "").replace(/\?v=\d+/, "");
    callers[where] = (callers[where] || 0) + 1;
    return raf(fn);
  };
});
if (args.fx === "off") {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("scribe.uiEffects", "0");
      localStorage.setItem("scribe.chromeFx", "off");
      localStorage.setItem("scribe.auroraEdge", "0");
      localStorage.setItem("scribe.auroraIdle", "0");
    } catch {}
  });
}
const page = await context.newPage();
await page.goto(base, { waitUntil: "load" });
await page.waitForFunction(() => window.scribeChat && window.scribeApp);
if (args.tab) await page.evaluate((id) => (location.hash = `#${id}`), String(args.tab));
if (args.thread) await page.evaluate((id) => window.scribeChat.openThread(id), String(args.thread));
await page.waitForTimeout(4000);
if (args.stream && args.thread) {
  const composer = page.locator("#agent-pane textarea.ag-textarea").first();
  await composer.click();
  await composer.fill("[fake:stream=40] [fake:delay=200] perf frames probe");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
}

const session = await context.newCDPSession(page);
await session.send("Performance.enable");
const metrics = async () => Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
await page.evaluate(() => {
  for (const key of Object.keys(window.__raf)) delete window.__raf[key];
});
const before = await metrics();
await page.waitForTimeout(seconds * 1000);
const after = await metrics();
const report = await page.evaluate(() => ({
  raf: window.__raf,
  animations: document.getAnimations().filter((a) => a.playState === "running").map((a) => {
    const el = a.effect?.target;
    const timing = a.effect?.getComputedTiming?.() ?? {};
    return `${a.animationName || a.transitionProperty || a.constructor.name} on ${el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].join(".")}` : ""}` : "?"}${timing.iterations === Infinity ? " (infinite)" : ""}${el && !el.checkVisibility?.() ? " [not visible]" : ""}`;
  }),
  canvases: [...document.querySelectorAll("canvas")].map((c) => `${c.className || c.id || "canvas"} ${c.width}x${c.height}${c.checkVisibility?.() ? "" : " [not visible]"}`),
}));
const per = (key) => Math.round((after[key] - before[key]) / seconds);
console.log(JSON.stringify({
  tab: args.tab || "(start)", thread: args.thread || null, fx: args.fx === "off" ? "off" : "default",
  perSecond: { rafCalls: Math.round(Object.values(report.raf).reduce((a, b) => a + b, 0) / seconds), styleRecalcs: per("RecalcStyleCount"), layouts: per("LayoutCount") },
  mainThreadPct: Math.round(((after.TaskDuration - before.TaskDuration) / seconds) * 1000) / 10,
  rafCallers: Object.fromEntries(Object.entries(report.raf).map(([k, v]) => [k, Math.round(v / seconds)])),
  runningAnimations: report.animations,
  canvases: report.canvases,
}, null, 1));
await browser.close();
