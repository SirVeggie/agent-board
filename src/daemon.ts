import { spawn } from "node:child_process";
import { AGENT_CLIENT, CLIENT_HEADER, baseUrl } from "./config.js";
import { log } from "./log.js";

export async function health(): Promise<{
  ok: boolean;
  url: string;
  viewers: number;
  tabs: number;
  activeId: string | null;
} | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as {
      ok: boolean;
      url: string;
      viewers: number;
      tabs: number;
      activeId: string | null;
    };
  } catch {
    return null;
  }
}

export async function ensureDaemon(): Promise<string> {
  const url = baseUrl();
  if (await health()) {
    return url;
  }
  log("Starting agent-board daemon");
  const args = process.argv.slice(1).filter((arg) => arg !== "--daemon" && arg !== "--stop");
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

export async function api(
  method: string,
  pathname: string,
  body?: unknown,
  options?: { timeoutMs?: number }
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${baseUrl()}${pathname}`, {
    method,
    headers: {
      [CLIENT_HEADER]: AGENT_CLIENT,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  return { status: res.status, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
