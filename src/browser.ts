import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { BROWSER_ACTIONS, type BrowserAction } from "./browserActions.js";
import { launchChromium } from "./chromium.js";
import { log } from "./log.js";
import { pngOrJpeg, screenshotUrl, shotOptions } from "./screenshot.js";
import { store } from "./store.js";

/**
 * The agent browser: a headed Chromium that Scribe chat threads drive through the browser_*
 * MCP tools. Each thread gets its own context (cookies and storage stay apart, and survive
 * between turns) with its own window and tabs. A context closes when its thread is archived or
 * deleted, or after it sits idle; the browser closes with its last context. It is a separate
 * browser from the headless one behind page_screenshot, so a stuck agent page can't break that.
 * SCRIBE_AGENT_BROWSER_HEADLESS=1 runs it headless (tests).
 */

const LAUNCH_ARGS = ["--mute-audio", "--no-first-run", "--no-default-browser-check"];
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const MIN_VIEWPORT = 320;
const MAX_VIEWPORT = 2560;
const NAV_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 8_000;
const SETTLE_MS = 2_000;
/** Playwright dragTo defaults to 1 (one jump). Pointer-event UIs need travel first. */
const DEFAULT_DRAG_STEPS = 10;
const MAX_DRAG_STEPS = 50;
const IDLE_CLOSE_MS = 30 * 60_000;
const MAX_LOG = 500;
const DEFAULT_SNAPSHOT_CHARS = 20_000;
const MAX_SNAPSHOT_CHARS = 100_000;
const MAX_EVAL_CHARS = 20_000;
const MAX_LIST = 200;


type ConsoleEntry = { seq: number; at: number; level: string; text: string; location?: string };
type NetworkEntry = {
  seq: number;
  at: number;
  method: string;
  url: string;
  type: string;
  status?: number;
  failure?: string;
  ms?: number;
};

type BrowserTab = {
  id: string;
  page: Page;
  console: ConsoleEntry[];
  network: NetworkEntry[];
};

type Session = {
  threadId: string;
  context: BrowserContext;
  tabs: Map<string, BrowserTab>;
  current?: string;
  nextTab: number;
  seq: number;
  idle: ReturnType<typeof setTimeout> | null;
};

export type Target = { ref?: string; selector?: string; text?: string };

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
const sessions = new Map<string, Session>();
const opening = new Map<string, Promise<Session>>();

/**
 * Hosts the agent browser may load as a page: loopback only (dev servers and Scribe itself).
 * Subresources and iframes are not checked, so a local page can still pull in its CDN fonts.
 */
export function allowedBrowserUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "about:" || url.protocol === "data:") {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** A URL the agent passed, or a Scribe page key or id, as the URL to load. */
export function resolveBrowserUrl(input: { url?: string; key?: string }): string {
  if (input.key) {
    const tab = store.get(input.key);
    if (!tab) {
      throw new Error(`tab not found: ${input.key}`);
    }
    return screenshotUrl(tab);
  }
  const url = input.url?.trim();
  if (!url) {
    throw new Error("Provide url or key");
  }
  // "localhost:5173" and "127.0.0.1:3000/x" are common shorthands.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data):/i.test(url) ? url : `http://${url}`;
}

export function browserHttpStatus(message: string): number {
  if (message.startsWith("tab not found") || message.startsWith("no browser tab")) {
    return 404;
  }
  if (message.includes("Could not launch")) {
    return 503;
  }
  if (/timeout/i.test(message)) {
    return 504;
  }
  if (message.startsWith("internal:")) {
    return 500;
  }
  return 400;
}

export async function browserOpen(
  threadId: string,
  input: { url?: string; key?: string; tab?: string; newTab?: boolean; snapshot?: boolean }
) {
  const url = resolveBrowserUrl(input);
  if (!allowedBrowserUrl(url)) {
    throw new Error(blockedMessage(url));
  }
  const session = await ensureSession(threadId);
  const tab = input.newTab || !session.tabs.size ? await newTab(session) : pickTab(session, input.tab);
  session.current = tab.id;
  await tab.page.bringToFront().catch(() => undefined);
  let navError: string | undefined;
  try {
    await tab.page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    navError = (err as Error).message.split("\n")[0];
    if (!/timeout/i.test(navError)) {
      throw new Error(`Could not open ${url}: ${navError}`);
    }
  }
  return {
    tab: tab.id,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    ...(navError ? { warning: `The page did not finish loading: ${navError}` } : {}),
    ...(input.snapshot === false ? {} : await snapshotOf(tab.page, undefined, DEFAULT_SNAPSHOT_CHARS)),
    ...errorsSince(tab, 0),
  };
}

export async function browserSnapshot(threadId: string, input: { tab?: string; selector?: string; maxChars?: number }) {
  const tab = pickTab(await requireSession(threadId), input.tab);
  const maxChars = clamp(input.maxChars ?? DEFAULT_SNAPSHOT_CHARS, 1_000, MAX_SNAPSHOT_CHARS);
  return {
    tab: tab.id,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    ...(await snapshotOf(tab.page, input.selector, maxChars)),
  };
}

export async function browserAct(
  threadId: string,
  input: Target & {
    tab?: string;
    action: BrowserAction;
    value?: string | string[];
    keys?: string;
    to?: Target;
    dx?: number;
    dy?: number;
    steps?: number;
    snapshot?: boolean;
  }
) {
  const tab = pickTab(await requireSession(threadId), input.tab);
  const { page } = tab;
  const mark = tab.console.at(-1)?.seq ?? 0;
  const value = input.value;
  const text = Array.isArray(value) ? value.join("") : value ?? "";
  switch (input.action) {
    case "click":
      await locate(page, input).click({ timeout: ACTION_TIMEOUT_MS });
      break;
    case "dblclick":
      await locate(page, input).dblclick({ timeout: ACTION_TIMEOUT_MS });
      break;
    case "hover":
      await locate(page, input).hover({ timeout: ACTION_TIMEOUT_MS });
      break;
    case "fill":
      await locate(page, input).fill(text, { timeout: ACTION_TIMEOUT_MS });
      break;
    case "type":
      if (hasTarget(input)) {
        await locate(page, input).pressSequentially(text, { timeout: ACTION_TIMEOUT_MS });
      } else {
        await page.keyboard.type(text);
      }
      break;
    case "press": {
      const keys = input.keys || text;
      if (!keys) {
        throw new Error("press needs keys, e.g. Enter or Control+A");
      }
      if (hasTarget(input)) {
        await locate(page, input).press(keys, { timeout: ACTION_TIMEOUT_MS });
      } else {
        await page.keyboard.press(keys);
      }
      break;
    }
    case "select":
      await locate(page, input).selectOption(Array.isArray(value) ? value : text, { timeout: ACTION_TIMEOUT_MS });
      break;
    case "check":
      await locate(page, input).check({ timeout: ACTION_TIMEOUT_MS });
      break;
    case "uncheck":
      await locate(page, input).uncheck({ timeout: ACTION_TIMEOUT_MS });
      break;
    case "scroll":
      if (hasTarget(input) && input.dx === undefined && input.dy === undefined) {
        await locate(page, input).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
      } else {
        if (hasTarget(input)) {
          await locate(page, input).hover({ timeout: ACTION_TIMEOUT_MS });
        }
        await page.mouse.wheel(input.dx ?? 0, input.dy ?? 600);
      }
      break;
    case "drag":
      if (!input.to || !hasTarget(input.to)) {
        throw new Error("drag needs to: { ref | selector | text }");
      }
      await locate(page, input).dragTo(locate(page, input.to), {
        timeout: ACTION_TIMEOUT_MS,
        steps: clamp(input.steps ?? DEFAULT_DRAG_STEPS, 1, MAX_DRAG_STEPS),
      });
      break;
    case "back":
      await page.goBack({ timeout: NAV_TIMEOUT_MS });
      break;
    case "forward":
      await page.goForward({ timeout: NAV_TIMEOUT_MS });
      break;
    case "reload":
      await page.reload({ timeout: NAV_TIMEOUT_MS });
      break;
    default:
      throw new Error(`unknown action: ${String(input.action)}. Use one of ${BROWSER_ACTIONS.join(", ")}`);
  }
  await settle(page);
  return {
    tab: tab.id,
    action: input.action,
    url: page.url(),
    title: await page.title().catch(() => ""),
    ...errorsSince(tab, mark),
    ...(input.snapshot === false ? {} : await snapshotOf(page, undefined, DEFAULT_SNAPSHOT_CHARS)),
  };
}

export async function browserScreenshot(threadId: string, input: Target & { tab?: string; fullPage?: boolean }) {
  const tab = pickTab(await requireSession(threadId), input.tab);
  const { page } = tab;
  const target = hasTarget(input) ? locate(page, input) : null;
  const { buffer, mimeType } = await pngOrJpeg((type) =>
    target
      ? target.screenshot({ ...shotOptions(type), timeout: ACTION_TIMEOUT_MS })
      : page.screenshot({ ...shotOptions(type), fullPage: Boolean(input.fullPage) })
  );
  return {
    tab: tab.id,
    url: page.url(),
    mimeType,
    data: buffer.toString("base64"),
    bytes: buffer.length,
  };
}

export async function browserEval(threadId: string, input: { tab?: string; script: string }) {
  const tab = pickTab(await requireSession(threadId), input.tab);
  if (!input.script?.trim()) {
    throw new Error("Provide script");
  }
  // An expression, or a function body when it uses return.
  const body = /\breturn\b/.test(input.script) ? input.script : `return (${input.script});`;
  const value = await tab.page.evaluate(
    async (source) => {
      const fn = new Function(`return (async () => { ${source} })();`) as () => Promise<unknown>;
      const result = await fn();
      if (result === undefined) return { undefined: true };
      try {
        return { json: JSON.stringify(result) };
      } catch {
        return { json: JSON.stringify(String(result)) };
      }
    },
    body
  );
  const text = "undefined" in value ? "undefined" : value.json ?? "null";
  return {
    tab: tab.id,
    result: text.length > MAX_EVAL_CHARS ? `${text.slice(0, MAX_EVAL_CHARS)}… (${text.length} chars)` : text,
  };
}

export async function browserConsole(
  threadId: string,
  input: { tab?: string; level?: string; pattern?: string; since?: number; limit?: number; clear?: boolean }
) {
  const tab = pickTab(await requireSession(threadId), input.tab);
  const pattern = input.pattern ? new RegExp(input.pattern, "i") : null;
  const levels = levelFilter(input.level);
  const rows = tab.console.filter(
    (row) =>
      row.seq > (input.since ?? 0) && (!levels || levels.has(row.level)) && (!pattern || pattern.test(row.text))
  );
  const limit = clamp(input.limit ?? 100, 1, MAX_LIST);
  if (input.clear) {
    tab.console.length = 0;
  }
  return { tab: tab.id, total: rows.length, messages: rows.slice(-limit), cursor: tab.console.at(-1)?.seq ?? input.since ?? 0 };
}

export async function browserNetwork(
  threadId: string,
  input: { tab?: string; urlPattern?: string; failedOnly?: boolean; since?: number; limit?: number; clear?: boolean }
) {
  const tab = pickTab(await requireSession(threadId), input.tab);
  const pattern = input.urlPattern ? new RegExp(input.urlPattern, "i") : null;
  const rows = tab.network.filter(
    (row) =>
      row.seq > (input.since ?? 0) &&
      (!pattern || pattern.test(row.url)) &&
      (!input.failedOnly || row.failure !== undefined || (row.status ?? 0) >= 400)
  );
  const limit = clamp(input.limit ?? 100, 1, MAX_LIST);
  if (input.clear) {
    tab.network.length = 0;
  }
  return { tab: tab.id, total: rows.length, requests: rows.slice(-limit), cursor: tab.network.at(-1)?.seq ?? input.since ?? 0 };
}

export async function browserViewport(
  threadId: string,
  input: { tab?: string; width?: number; height?: number; colorScheme?: "light" | "dark" | "no-preference" }
) {
  const tab = pickTab(await requireSession(threadId), input.tab);
  const current = tab.page.viewportSize() ?? DEFAULT_VIEWPORT;
  const size = {
    width: clamp(input.width ?? current.width, MIN_VIEWPORT, MAX_VIEWPORT),
    height: clamp(input.height ?? current.height, MIN_VIEWPORT, MAX_VIEWPORT),
  };
  await tab.page.setViewportSize(size);
  if (input.colorScheme) {
    await tab.page.emulateMedia({ colorScheme: input.colorScheme });
  }
  return { tab: tab.id, ...size, ...(input.colorScheme ? { colorScheme: input.colorScheme } : {}) };
}

export async function browserTabs(threadId: string, input: { close?: string; select?: string; closeAll?: boolean }) {
  if (input.closeAll) {
    await closeThreadBrowser(threadId);
    return { tabs: [], closed: true };
  }
  const session = sessions.get(threadId);
  if (!session) {
    return { tabs: [] };
  }
  touch(session);
  if (input.close) {
    const tab = pickTab(session, input.close);
    await tab.page.close().catch(() => undefined);
    session.tabs.delete(tab.id);
    if (session.current === tab.id) {
      session.current = [...session.tabs.keys()].at(-1);
    }
  }
  if (input.select) {
    const tab = pickTab(session, input.select);
    session.current = tab.id;
    await tab.page.bringToFront().catch(() => undefined);
  }
  const tabs = await Promise.all(
    [...session.tabs.values()].map(async (tab) => ({
      tab: tab.id,
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ""),
      current: tab.id === session.current,
    }))
  );
  return { tabs };
}

/** Closes a thread's context and its window. The browser goes with the last one. */
export async function closeThreadBrowser(threadId: string): Promise<void> {
  const session = sessions.get(threadId);
  if (!session) {
    return;
  }
  sessions.delete(threadId);
  if (session.idle) {
    clearTimeout(session.idle);
  }
  await session.context.close().catch(() => undefined);
  if (!sessions.size) {
    await closeAgentBrowser();
  }
}

export async function closeAgentBrowser(): Promise<void> {
  for (const session of sessions.values()) {
    if (session.idle) {
      clearTimeout(session.idle);
    }
  }
  sessions.clear();
  const current = browser;
  browser = null;
  launching = null;
  if (current) {
    await current.close().catch(() => undefined);
  }
}

export function browserSessions(): Array<{ threadId: string; tabs: number }> {
  return [...sessions.values()].map((session) => ({ threadId: session.threadId, tabs: session.tabs.size }));
}

function blockedMessage(url: string): string {
  return `The agent browser only opens loopback addresses (localhost, 127.x.x.x, *.localhost) and Scribe pages; ${url} is not one.`;
}

async function requireSession(threadId: string): Promise<Session> {
  const session = sessions.get(threadId);
  if (!session) {
    throw new Error("no browser tab is open for this thread: call browser_open first");
  }
  touch(session);
  return session;
}

async function ensureSession(threadId: string): Promise<Session> {
  const existing = sessions.get(threadId);
  if (existing && browser?.isConnected()) {
    touch(existing);
    return existing;
  }
  sessions.delete(threadId);
  let pending = opening.get(threadId);
  if (!pending) {
    pending = createSession(threadId).finally(() => opening.delete(threadId));
    opening.set(threadId, pending);
  }
  return pending;
}

async function createSession(threadId: string): Promise<Session> {
  const opened = await ensureBrowser();
  const context = await opened.newContext({ viewport: DEFAULT_VIEWPORT });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  // Top-level navigations stay on loopback, including links and redirects the page follows.
  await context.route("**/*", (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && !request.frame().parentFrame() && !allowedBrowserUrl(request.url())) {
      void route.abort("blockedbyclient");
      return;
    }
    void route.fallback();
  });
  const session: Session = { threadId, context, tabs: new Map(), nextTab: 1, seq: 0, idle: null };
  context.on("page", (page) => {
    if (![...session.tabs.values()].some((tab) => tab.page === page)) {
      // A popup or target=_blank link: track it like a tab the agent opened.
      const tab = track(session, page);
      session.current = tab.id;
    }
  });
  context.on("close", () => {
    if (sessions.get(threadId) === session) {
      sessions.delete(threadId);
    }
  });
  sessions.set(threadId, session);
  touch(session);
  return session;
}

async function newTab(session: Session): Promise<BrowserTab> {
  const page = await session.context.newPage();
  return [...session.tabs.values()].find((tab) => tab.page === page) ?? track(session, page);
}

function track(session: Session, page: Page): BrowserTab {
  const tab: BrowserTab = { id: `b${session.nextTab++}`, page, console: [], network: [] };
  session.tabs.set(tab.id, tab);
  const push = <T>(list: T[], row: T) => {
    list.push(row);
    if (list.length > MAX_LOG) {
      list.splice(0, list.length - MAX_LOG);
    }
  };
  page.on("console", (msg) => {
    const loc = msg.location();
    push(tab.console, {
      seq: ++session.seq,
      at: Date.now(),
      level: msg.type(),
      text: msg.text(),
      ...(loc?.url ? { location: `${loc.url}:${loc.lineNumber + 1}` } : {}),
    });
  });
  page.on("pageerror", (err) => {
    push(tab.console, { seq: ++session.seq, at: Date.now(), level: "pageerror", text: err.stack || err.message });
  });
  const started = new Map<object, NetworkEntry>();
  page.on("request", (request) => {
    const row: NetworkEntry = {
      seq: ++session.seq,
      at: Date.now(),
      method: request.method(),
      url: request.url(),
      type: request.resourceType(),
    };
    started.set(request, row);
    push(tab.network, row);
  });
  page.on("requestfinished", (request) => {
    const row = started.get(request);
    started.delete(request);
    if (!row) return;
    row.ms = Date.now() - row.at;
    void request
      .response()
      .then((response) => {
        if (response) row.status = response.status();
      })
      .catch(() => undefined);
  });
  page.on("requestfailed", (request) => {
    const row = started.get(request);
    started.delete(request);
    if (!row) return;
    row.ms = Date.now() - row.at;
    row.failure = request.failure()?.errorText ?? "failed";
  });
  page.on("close", () => {
    session.tabs.delete(tab.id);
    if (session.current === tab.id) {
      session.current = [...session.tabs.keys()].at(-1);
    }
  });
  return tab;
}

function pickTab(session: Session, id?: string): BrowserTab {
  const which = id ?? session.current;
  const tab = which ? session.tabs.get(which) : undefined;
  if (!tab) {
    throw new Error(
      id
        ? `no browser tab ${id}; open tabs: ${[...session.tabs.keys()].join(", ") || "none"}`
        : "no browser tab is open for this thread: call browser_open first"
    );
  }
  return tab;
}

function hasTarget(target: Target): boolean {
  return Boolean(target.ref || target.selector || target.text);
}

function locate(page: Page, target: Target): Locator {
  if (target.ref) {
    return page.locator(`aria-ref=${target.ref.replace(/^ref=/, "")}`);
  }
  if (target.selector) {
    return page.locator(target.selector).first();
  }
  if (target.text) {
    return page.getByText(target.text).first();
  }
  throw new Error("Provide ref (from browser_snapshot), selector, or text");
}

async function snapshotOf(page: Page, selector: string | undefined, maxChars: number) {
  try {
    const root = selector ? page.locator(selector).first() : page;
    const text = await root.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS });
    return text.length > maxChars
      ? { snapshot: text.slice(0, maxChars), truncated: `snapshot cut at ${maxChars} of ${text.length} chars; pass selector or maxChars` }
      : { snapshot: text };
  } catch (err) {
    return { snapshotError: (err as Error).message.split("\n")[0] };
  }
}

/** Console errors and page errors since a console seq, so a broken click shows up in its own result. */
function errorsSince(tab: BrowserTab, seq: number) {
  const errors = tab.console
    .filter((row) => row.seq > seq && (row.level === "error" || row.level === "pageerror"))
    .slice(-10)
    .map((row) => row.text.split("\n")[0]);
  return errors.length ? { consoleErrors: errors } : {};
}

function levelFilter(level: string | undefined): Set<string> | null {
  if (!level || level === "all") return null;
  if (level === "error") return new Set(["error", "pageerror"]);
  if (level === "warning") return new Set(["error", "pageerror", "warning"]);
  return new Set(level.split(",").map((part) => part.trim()));
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load", { timeout: SETTLE_MS }).catch(() => undefined);
  await page.waitForTimeout(150);
}

function touch(session: Session): void {
  if (session.idle) {
    clearTimeout(session.idle);
  }
  session.idle = setTimeout(() => {
    log(`Closing the idle agent browser of ${session.threadId}`);
    void closeThreadBrowser(session.threadId);
  }, IDLE_CLOSE_MS);
  session.idle.unref?.();
}

async function ensureBrowser(): Promise<Browser> {
  if (browser?.isConnected()) {
    return browser;
  }
  if (!launching) {
    launching = launchChromium({ headless: process.env.SCRIBE_AGENT_BROWSER_HEADLESS === "1", args: LAUNCH_ARGS, purpose: "Agent" })
      .then((opened) => {
        browser = opened;
        opened.on("disconnected", () => {
          if (browser === opened) {
            browser = null;
            for (const session of sessions.values()) {
              if (session.idle) clearTimeout(session.idle);
            }
            sessions.clear();
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}
