import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { contentBaseUrl } from "./config.js";
import { log } from "./log.js";
import { store } from "./store.js";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_VIEWPORT = 320;
const MAX_VIEWPORT = 1600;
const MAX_FULL_PAGE_HEIGHT = 6000;
const MAX_PNG_BYTES = 1_500_000;
const IDLE_CLOSE_MS = 30_000;
const NAV_TIMEOUT_MS = 20_000;
const JPEG_QUALITY = 82;

const LAUNCH_ARGS = ["--hide-scrollbars", "--mute-audio"];
const CHANNELS = ["msedge", "chrome"] as const;
const CHROMIUM_EXES = ["msedge.exe", "chrome.exe", "brave.exe"] as const;
const CHROMIUM_RELS = [
  path.join("Microsoft", "Edge", "Application", "msedge.exe"),
  path.join("Google", "Chrome", "Application", "chrome.exe"),
  path.join("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
];

export type ScreenshotRequest = {
  idOrKey: string;
  selector?: string;
  fullPage?: boolean;
  width?: number;
  height?: number;
};

export type ScreenshotResult = {
  mimeType: "image/png" | "image/jpeg";
  data: string;
  width: number;
  height: number;
  fullPage: boolean;
  selector?: string;
  id: string;
  key: string;
  title: string;
  bytes: number;
};

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let inFlight = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export async function captureTab(input: ScreenshotRequest): Promise<ScreenshotResult> {
  const tab = store.get(input.idOrKey);
  if (!tab) {
    throw new Error(`tab not found: ${input.idOrKey}`);
  }

  const width = clamp(input.width ?? DEFAULT_WIDTH, MIN_VIEWPORT, MAX_VIEWPORT);
  const height = clamp(input.height ?? DEFAULT_HEIGHT, MIN_VIEWPORT, MAX_VIEWPORT);
  const selector = input.selector?.trim() || undefined;
  const fullPage = Boolean(input.fullPage) && !selector;

  return withBrowser(async (opened) => {
    const page = await opened.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    try {
      await page.goto(`${contentBaseUrl()}/view/${encodeURIComponent(tab.id)}`, {
        waitUntil: "load",
        timeout: NAV_TIMEOUT_MS,
      });
      await page.evaluate(() => document.fonts.ready);
      await sleep(100);

      const shot = selector
        ? await captureSelector(page, selector)
        : await capturePage(page, width, height, fullPage);

      return {
        mimeType: shot.mimeType,
        data: shot.buffer.toString("base64"),
        width: shot.width,
        height: shot.height,
        fullPage,
        selector,
        id: tab.id,
        key: tab.key,
        title: tab.title,
        bytes: shot.buffer.length,
      };
    } finally {
      await page.close();
    }
  });
}

export async function closeScreenshotBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const current = browser;
  browser = null;
  launching = null;
  if (!current) {
    return;
  }
  try {
    await current.close();
  } catch {
    // Closing on shutdown is best-effort.
  }
}

export function screenshotHttpStatus(message: string): number {
  if (message.startsWith("tab not found")) {
    return 404;
  }
  if (message.startsWith("selector not found") || message.startsWith("selector is not visible")) {
    return 400;
  }
  if (message.includes("Could not launch")) {
    return 503;
  }
  if (/timeout/i.test(message)) {
    return 504;
  }
  return 500;
}

async function captureSelector(page: Page, selector: string): Promise<Shot> {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) {
    throw new Error(`selector not found: ${selector}`);
  }
  try {
    await loc.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    throw new Error(`selector is not visible: ${selector}`);
  }
  const box = await loc.boundingBox();
  const { buffer, mimeType } = await pngOrJpeg((type) => loc.screenshot(shotOptions(type)));
  return {
    buffer,
    mimeType,
    width: Math.max(1, Math.round(box?.width ?? 0)),
    height: Math.max(1, Math.round(box?.height ?? 0)),
  };
}

async function capturePage(page: Page, width: number, height: number, fullPage: boolean): Promise<Shot> {
  const scrollHeight = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
  );
  const clipHeight = fullPage ? Math.min(Math.max(scrollHeight, height), MAX_FULL_PAGE_HEIGHT) : height;
  const { buffer, mimeType } = await pngOrJpeg((type) => {
    const opts = shotOptions(type);
    if (!fullPage || clipHeight <= height) {
      return page.screenshot(opts);
    }
    return page.screenshot({
      ...opts,
      clip: { x: 0, y: 0, width, height: clipHeight },
    });
  });
  return {
    buffer,
    mimeType,
    width,
    height: fullPage ? clipHeight : height,
  };
}

type ImageType = "png" | "jpeg";

type Shot = {
  buffer: Buffer;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
};

function shotOptions(type: ImageType) {
  return type === "jpeg"
    ? { type: "jpeg" as const, quality: JPEG_QUALITY, animations: "disabled" as const }
    : { type: "png" as const, animations: "disabled" as const };
}

async function pngOrJpeg(take: (type: ImageType) => Promise<Buffer>): Promise<{
  buffer: Buffer;
  mimeType: "image/png" | "image/jpeg";
}> {
  const png = await take("png");
  if (png.length <= MAX_PNG_BYTES) {
    return { buffer: png, mimeType: "image/png" };
  }
  const jpeg = await take("jpeg");
  return { buffer: jpeg, mimeType: "image/jpeg" };
}

async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  inFlight += 1;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  try {
    return await fn(await ensureBrowser());
  } finally {
    inFlight -= 1;
    if (inFlight === 0) {
      idleTimer = setTimeout(() => {
        void closeScreenshotBrowser();
      }, IDLE_CLOSE_MS);
    }
  }
}

async function ensureBrowser(): Promise<Browser> {
  if (browser?.isConnected()) {
    return browser;
  }
  if (!launching) {
    launching = launchBrowser()
      .then((opened) => {
        browser = opened;
        opened.on("disconnected", () => {
          if (browser === opened) {
            browser = null;
          }
        });
        return opened;
      })
      .finally(() => {
        launching = null;
      });
  }
  return launching;
}

async function launchBrowser(): Promise<Browser> {
  const errors: string[] = [];
  for (const channel of CHANNELS) {
    try {
      const opened = await chromium.launch({ channel, headless: true, args: LAUNCH_ARGS });
      log(`Screenshot browser launched (${channel})`);
      return opened;
    } catch (err) {
      errors.push(`${channel}: ${(err as Error).message}`);
    }
  }
  for (const executablePath of chromiumExecutables()) {
    try {
      const opened = await chromium.launch({ executablePath, headless: true, args: LAUNCH_ARGS });
      log(`Screenshot browser launched (${executablePath})`);
      return opened;
    } catch (err) {
      errors.push(`${executablePath}: ${(err as Error).message}`);
    }
  }
  throw new Error(
    `Could not launch a Chromium browser for screenshots. Install Microsoft Edge, Google Chrome, or Brave. ${errors.join("; ")}`
  );
}

function chromiumExecutables(): string[] {
  const found = new Set<string>();
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(
    (value): value is string => Boolean(value)
  );
  for (const root of roots) {
    for (const rel of CHROMIUM_RELS) {
      const candidate = path.join(root, rel);
      if (fs.existsSync(candidate)) {
        found.add(candidate);
      }
    }
  }
  for (const exe of CHROMIUM_EXES) {
    const fromReg = appPath(exe);
    if (fromReg && fs.existsSync(fromReg)) {
      found.add(fromReg);
    }
  }
  return [...found];
}

function appPath(exe: string): string | undefined {
  const keys = [
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ];
  for (const key of keys) {
    const result = spawnSync("reg", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true });
    const match = result.stdout?.match(/REG_SZ\s+(.+\.exe)/i);
    if (match) {
      return match[1].trim().replace(/^"|"$/g, "");
    }
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
