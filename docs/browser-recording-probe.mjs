// Probe for card #391: which ways of recording the agent browser work with the user's own
// Edge/Chrome and playwright-core, and what they cost. Run: node docs/browser-recording-probe.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-rec-probe-"));
const VIEWPORT = { width: 1280, height: 800 };
const PAGE = `<!doctype html><body style="margin:0;background:#14161a;color:#eee;font:20px system-ui">
<style>@keyframes slide{from{left:0}to{left:1100px}} #box{position:absolute;top:200px;width:120px;height:120px;background:#4a9eff;border-radius:16px;animation:slide 1.2s ease-in-out infinite alternate}
#panel{position:absolute;top:400px;left:40px;width:400px;height:0;overflow:hidden;background:#2a2f38;transition:height .4s} #panel.open{height:300px}</style>
<button id="go" style="margin:40px;font-size:24px" onclick="panel.classList.toggle('open')">Toggle panel</button>
<div id="box"></div><div id="panel"><p style="padding:20px">Panel content with some text to compress.</p></div></body>`;

const results = {};
const time = async (fn) => {
  const start = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - start), value };
};

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return { browser: await chromium.launch({ channel, headless: true }), launch: { channel } };
    } catch {}
  }
  // As src/chromium.ts does: the channel lookup misses some installs, so try the usual paths.
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], "C:\Program Files", "C:\Program Files (x86)"];
  for (const root of roots.filter(Boolean)) {
    for (const rel of ["Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe", "BraveSoftware/Brave-Browser/Application/brave.exe"]) {
      const executablePath = path.join(root, rel);
      if (fs.existsSync(executablePath)) {
        return { browser: await chromium.launch({ executablePath, headless: true }), launch: { executablePath } };
      }
    }
  }
  throw new Error("no Edge, Chrome, or Brave");
}

async function drive(page) {
  await page.waitForTimeout(600);
  await page.click("#go");
  await page.waitForTimeout(900);
  await page.click("#go");
  await page.waitForTimeout(900);
}

// Step 1 looks for ffmpeg in Playwright's default folder; step 2 points it at an empty one.
const shellBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
delete process.env.PLAYWRIGHT_BROWSERS_PATH;
// Playwright reads that variable when it loads.
const { chromium } = await import("playwright-core");
const { browser, launch: how } = await launch();
results.browser = `${how.channel ?? path.basename(how.executablePath)} ${browser.version()}`;

// 1. Playwright's page.screencast to a .webm file (needs Playwright's own ffmpeg download).
{
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.setContent(PAGE);
  const file = path.join(out, "screencast.webm");
  try {
    await page.screencast.start({ path: file, size: VIEWPORT });
    const actions = await page.screencast.showActions().then(() => "ok", (err) => err.message.split("\n")[0]);
    await drive(page);
    const stop = await time(() => page.screencast.stop());
    results.screencastFile = { bytes: fs.statSync(file).size, stopMs: stop.ms, showActions: actions };
  } catch (err) {
    results.screencastFile = { error: err.message.split("\n")[0] };
  }
  await context.close();
}

// 2. The same without Playwright's browser folder (a machine that never ran `playwright install`).
{
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(out, "no-browsers");
  const script = `import { chromium } from "playwright-core";
    const b = await chromium.launch({ ...${JSON.stringify(how)}, headless: true });
    const p = await b.newPage();
    try { await p.screencast.start({ path: ${JSON.stringify(path.join(out, "nope.webm"))} }); await p.screencast.stop(); console.log("ok"); }
    catch (e) { console.log(e.message.split("\\n")[0]); }
    await b.close();`;
  const probe = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..", ".rec-probe-tmp.mjs");
  fs.writeFileSync(probe, script);
  const run = spawnSync(process.execPath, [probe], { encoding: "utf8", env: process.env });
  fs.rmSync(probe);
  results.screencastFileWithoutFfmpeg = (run.stdout || run.stderr).trim().split("\n").pop();
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  results.shellBrowsersPath = shellBrowsersPath ?? null;
}

// 3. Raw CDP screencast frames (what the chat's live view uses), with a second CDP session
//    casting the same page at the same time, as the live view would while a recording runs.
let frames = [];
{
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.setContent(PAGE);
  const cast = async (sink, params) => {
    const cdp = await context.newCDPSession(page);
    cdp.on("Page.screencastFrame", (event) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
      sink.push({ data: event.data, t: event.metadata.timestamp });
    });
    await cdp.send("Page.startScreencast", params);
    return cdp;
  };
  const live = [];
  const a = await cast(frames, { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 800 });
  const b = await cast(live, { format: "jpeg", quality: 70, maxWidth: 1920, maxHeight: 1920 });
  const run = await time(() => drive(page));
  await a.send("Page.stopScreencast");
  await b.send("Page.stopScreencast");
  const bytes = frames.reduce((sum, f) => sum + Buffer.from(f.data, "base64").length, 0);
  results.cdpFrames = {
    frames: frames.length,
    fps: +(frames.length / (run.ms / 1000)).toFixed(1),
    jpegBytes: bytes,
    secondSessionFrames: live.length,
  };
  await context.close();
}

// 4. Frames to a .webm inside the browser itself (WebCodecs VP8/VP9/H.264 support, and
//    MediaRecorder on a canvas), so no ffmpeg is needed.
{
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  // WebCodecs needs a secure context: loopback counts, about:blank does not.
  await context.route("http://localhost/encoder", (route) => route.fulfill({ contentType: "text/html", body: "<body></body>" }));
  await page.goto("http://localhost/encoder");
  results.webCodecs = await page.evaluate(async () => {
    const support = {};
    for (const [name, codec] of [["vp8", "vp8"], ["vp9", "vp09.00.10.08"], ["h264", "avc1.42001f"], ["av1", "av01.0.04M.08"]]) {
      try {
        support[name] = (await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 800 })).supported;
      } catch (err) {
        support[name] = String(err);
      }
    }
    return {
      support,
      mediaRecorder: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/mp4;codecs=avc1"].filter((t) => MediaRecorder.isTypeSupported(t)),
    };
  });
  // Replay the frames from step 3 onto a canvas at their own timestamps and record it.
  const t0 = frames[0]?.t ?? 0;
  const replay = await time(() =>
    page.evaluate(
      async ({ list, width, height }) => {
        const canvas = Object.assign(document.createElement("canvas"), { width, height });
        const ctx = canvas.getContext("2d");
        const images = await Promise.all(
          list.map(async (f) => createImageBitmap(await (await fetch(`data:image/jpeg;base64,${f.data}`)).blob()))
        );
        ctx.drawImage(images[0], 0, 0);
        const stream = canvas.captureStream();
        const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: 1_500_000 });
        const chunks = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        const done = new Promise((resolve) => (recorder.onstop = resolve));
        recorder.start();
        const start = performance.now();
        for (let i = 0; i < images.length; i++) {
          const wait = list[i].at * 1000 - (performance.now() - start);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          ctx.drawImage(images[i], 0, 0);
        }
        await new Promise((r) => setTimeout(r, 100));
        recorder.stop();
        await done;
        const blob = new Blob(chunks, { type: "video/webm" });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
      },
      { list: frames.map((f) => ({ data: f.data, at: f.t - t0 })), ...VIEWPORT }
    )
  );
  const file = path.join(out, "mediarecorder.webm");
  fs.writeFileSync(file, Buffer.from(replay.value, "base64"));
  results.mediaRecorderWebm = { bytes: fs.statSync(file).size, encodeMs: replay.ms };

  // 5. A filmstrip the agent itself can look at: evenly spaced frames in one image.
  const picks = Array.from({ length: 8 }, (_, i) => frames[Math.round((i * (frames.length - 1)) / 7)]);
  await page.setViewportSize({ width: 1296, height: 420 });
  await page.setContent(
    `<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px">${picks
      .map((f) => `<img style="width:100%" src="data:image/jpeg;base64,${f.data}">`)
      .join("")}</body>`
  );
  const strip = await page.screenshot({ type: "jpeg", quality: 70 });
  fs.writeFileSync(path.join(out, "filmstrip.jpg"), strip);
  results.filmstrip = { bytes: strip.length, frames: picks.length };
  await context.close();
}

// 6. What Playwright's bundled ffmpeg can encode (is GIF among them?).
{
  const dir = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  const ffmpegDir = fs.existsSync(dir) ? fs.readdirSync(dir).find((name) => name.startsWith("ffmpeg-")) : undefined;
  if (ffmpegDir) {
    const exe = path.join(dir, ffmpegDir, "ffmpeg-win64.exe");
    const run = spawnSync(exe, ["-hide_banner", "-encoders"], { encoding: "utf8" });
    const names = run.stdout.split("\n").filter((line) => /^\s*[VAS][.\w]{5}\s+\w/.test(line)).map((line) => line.trim().split(/\s+/)[1]);
    results.playwrightFfmpeg = { path: exe, bytes: fs.statSync(exe).size, encoders: names };
  } else {
    results.playwrightFfmpeg = "not installed";
  }
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
console.log(`files: ${out}`);
