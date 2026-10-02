import { spawn } from "node:child_process";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { AGENT_CLIENT, AGENT_LABEL_HEADER, CLIENT_HEADER, SESSION_HEADER, THREAD_HEADER, VERSION, baseUrl } from "./config.js";

/** Identifies this MCP process to the daemon, so claims can tell a live agent from one that stopped. */
const SESSION_ID = randomBytes(6).toString("hex");
let agentLabel = "";

/** The MCP client's name (e.g. "claude-code"), once the client has introduced itself. */
export function setAgentLabel(label: string): void {
  agentLabel = label.replace(/[^\x20-\x7e]/g, "").slice(0, 60);
}
import { log } from "./log.js";

type Health = {
  ok: boolean;
  version?: string;
  url: string;
  viewers: number;
  tabs: number;
  activeId: string | null;
};

export async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

export async function ensureDaemon(): Promise<string> {
  const url = baseUrl();
  const running = await health();
  if (running?.version === VERSION) {
    return url;
  }
  if (running) {
    log(`Replacing scribe daemon ${running.version ?? "unknown"} with ${VERSION}`);
    await stopDaemon();
  }
  log("Starting scribe daemon");
  const args = process.argv.slice(1).filter((arg) => arg !== "--daemon" && arg !== "--stop" && arg !== "--ensure");
  args.push("--daemon");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 25; i += 1) {
    await sleep(120);
    if (await health()) {
      return url;
    }
  }
  throw new Error(`Scribe daemon did not start at ${url}`);
}

/** A daemon from another build answers health but speaks a different API, so it must be replaced. */
async function stopDaemon(): Promise<void> {
  try {
    await api("POST", "/api/shutdown", undefined, { timeoutMs: 2000 });
  } catch {
    /* it may exit before answering */
  }
  for (let i = 0; i < 40; i += 1) {
    await sleep(100);
    if (!(await health())) {
      return;
    }
  }
  throw new Error(`Scribe daemon at ${baseUrl()} did not stop`);
}

/** node:http rather than fetch: fetch gives up on a response after 5 minutes, which would cut page_wait short. */
export async function api(
  method: string,
  pathname: string,
  body?: unknown,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<{ status: number; data: unknown }> {
  const signals = [options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined, options?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      `${baseUrl()}${pathname}`,
      {
        method,
        headers: {
          [CLIENT_HEADER]: AGENT_CLIENT,
          [SESSION_HEADER]: SESSION_ID,
          ...(process.env.SCRIBE_THREAD ? { [THREAD_HEADER]: process.env.SCRIBE_THREAD } : {}),
          ...(agentLabel ? { [AGENT_LABEL_HEADER]: agentLabel } : {}),
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        },
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  return { status, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
