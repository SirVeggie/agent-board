// Read-only shell startup profile against a running daemon. No app data is changed.
// node tools/profile-startup.mjs [http://127.0.0.1:4747] [samples=3]
// All files and APIs come from the running daemon; instrumentation stays in the probe.
import { chromium } from 'playwright-core';

const base = new URL(process.argv[2] || 'http://127.0.0.1:4747');
if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Use a loopback daemon');
const samples = Number(process.argv[3] || 3);
if (!Number.isInteger(samples) || samples < 1 || samples > 20) throw new Error('Use 1–20 samples');
let browser;
if (process.env.PROFILE_BROWSER) browser = await chromium.launch({ executablePath: process.env.PROFILE_BROWSER, headless: true });
for (const channel of ['msedge', 'chrome']) {
  if (browser) break;
  try { browser = await chromium.launch({ channel, headless: true }); break; }
  catch { /* Try the other installed browser. */ }
}
if (!browser) throw new Error('Install Edge/Chrome or set PROFILE_BROWSER to your Chromium executable');

// Instrumentation only: timings and byte/count summaries, never page/thread content.
function instrument(mode) {
  const p = window.startupProfile = { gl: [], tasks: [] };
  new PerformanceObserver(list => {
    p.tasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration })));
  }).observe({ type: 'longtask', buffered: true });
  let gl;
  Object.defineProperty(window, 'scribeGL', { configurable: true, get: () => gl, set(value) {
    gl = value;
    const original = value.create;
    value.create = function(canvas, ...args) {
      const start = performance.now();
      const result = mode === 'no-webgl' ? null : original.call(this, canvas, ...args);
      p.gl.push({ canvas: canvas.className, start, ms: performance.now() - start, ok: Boolean(result), hidden: !canvas.clientWidth || !canvas.clientHeight });
      return result;
    };
  } });
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      p.socketStart = performance.now();
      this.addEventListener('open', () => p.socketOpen = performance.now());
      this.addEventListener('error', () => p.socketError = performance.now());
      this.addEventListener('close', event => p.socketClose = { at: performance.now(), code: event.code });
      this.addEventListener('message', event => {
        const start = performance.now();
        const data = JSON.parse(event.data);
        if (data.type === 'snapshot') {
          p.snapshot = { at: start, characters: event.data.length, tabs: data.tabs.length, closed: data.closed.length };
          setTimeout(() => p.snapshotRendered = performance.now(), 0);
        }
      });
    }
  };
  new MutationObserver(() => {
    if (!p.tabsRendered && document.querySelector('#tabs [role=tab]')) p.tabsRendered = performance.now();
  }).observe(document, { childList: true, subtree: true });
}

try {
  // Each scenario has fresh storage. Second and later navigations are reloads.
  for (const mode of ['normal', 'no-webgl']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(instrument, mode);
    const page = await context.newPage();
    page.on('pageerror', error => console.error(error.message));
    page.on('requestfailed', request => console.error(request.url() + ': ' + request.failure()?.errorText));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    for (let i = 0; i < samples; i++) {
      if (i === 0) await page.goto(base.href, { waitUntil: 'load' });
      else await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.startupProfile?.snapshotRendered, null, { timeout: 10000 }).catch(async error => {
        console.error(JSON.stringify(await page.evaluate(() => ({ profile: window.startupProfile }))));
        throw error;
      });
      await page.waitForTimeout(750);
      const result = await page.evaluate(() => {
        const p = window.startupProfile;
        const nav = performance.getEntriesByType('navigation')[0];
        return {
          ...p, navigation: { responseEnd: nav.responseEnd, domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd },
          resources: performance.getEntriesByType('resource').filter(e => e.name.includes('/api/') || e.name.includes('fonts.googleapis.com')).map(e => ({ path: new URL(e.name).pathname, start: e.startTime, ms: e.duration, bytes: e.decodedBodySize })),
          frames: [...document.querySelectorAll('iframe')].map(e => ({ loaded: e.dataset.loaded === '1' })),
        };
      });
      console.log(JSON.stringify({ mode, sample: i + 1, ...result }));
    }
    await context.close();
  }
} finally {
  await browser.close();
}
