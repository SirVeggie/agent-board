import { spawn } from "node:child_process";
import http from "node:http";
import { AGENT_CLIENT, CLIENT_HEADER, VERSION, baseUrl } from "./config.js";
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
    log(`Replacing agent-board daemon ${running.version ?? "unknown"} with ${VERSION}`);
    await stopDaemon();
  }
  log("Starting agent-board daemon");
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
  throw new Error(`Agent Board daemon did not start at ${url}`);
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
  throw new Error(`Agent Board daemon at ${baseUrl()} did not stop`);
}

/** node:http rather than fetch: fetch gives up on a response after 5 minutes, which would cut board_wait short. */
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
