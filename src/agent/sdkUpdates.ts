import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_SDKS = [
  { label: "Claude Agent SDK", package: "@anthropic-ai/claude-agent-sdk" },
  { label: "Cursor SDK", package: "@cursor/sdk" },
  { label: "Codex SDK", package: "@openai/codex-sdk" },
  { label: "Native agent", package: "@earendil-works/pi-coding-agent" },
  { label: "Native model SDK", package: "@earendil-works/pi-ai" },
] as const;

type Version = { core: bigint[]; pre: string[] };
function version(value: string): Version | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if (!match) return null;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((part) => /^0\d+$/.test(part))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

/** Null for invalid versions; prereleases sort before the corresponding stable release. */
export function newerSdkVersion(latest: string, installed: string): boolean | null {
  const a = version(latest), b = version(installed);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (!a.pre.length || !b.pre.length) return !!b.pre.length && !a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x !== undefined;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y);
    if (xn !== yn) return !xn;
    return x > y;
  }
  return false;
}

/** Resolve from Scribe, not the thread's workspace or the dependency range in package.json. */
export function installedSdkVersion(name: string): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.resolve(name)));
    for (;;) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
        if (manifest.name === name) return typeof manifest.version === "string" ? manifest.version : null;
      } catch { /* An entry point can be several folders below its manifest. */ }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch { return null; }
}

export type SdkUpdate = { label: string; package: string; installed: string | null; latest: string | null; outdated: boolean | null; error?: string };
export type SdkUpdateReport = { checkedAt: number; sdks: SdkUpdate[] };

/** Bounded, read-only registry lookups. A failed lookup never means an SDK is up to date. */
export function createSdkUpdateCheck(deps: {
  fetch?: typeof fetch;
  installed?: (name: string) => string | null;
  now?: () => number;
} = {}) {
  const request = deps.fetch ?? fetch;
  const installed = deps.installed ?? installedSdkVersion;
  const now = deps.now ?? Date.now;
  let cached: SdkUpdateReport | null = null;
  let expires = 0;
  let pending: Promise<SdkUpdateReport> | null = null;
  return function check(refresh = false): Promise<SdkUpdateReport> {
    if (pending) return pending;
    if (!refresh && cached && now() < expires) return Promise.resolve(cached);
    pending = Promise.all(AGENT_SDKS.map(async (sdk): Promise<SdkUpdate> => {
      const row: SdkUpdate = { ...sdk, installed: installed(sdk.package), latest: null, outdated: null };
      try {
        const response = await request(`https://registry.npmjs.org/${encodeURIComponent(sdk.package)}/latest`, {
          signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`npm returned HTTP ${response.status}`);
        const data = await response.json() as { version?: unknown };
        if (typeof data.version !== "string" || !version(data.version)) throw new Error("npm returned an invalid version");
        row.latest = data.version;
        if (row.installed) {
          row.outdated = newerSdkVersion(row.latest, row.installed);
          if (row.outdated === null) row.error = "Installed version could not be compared";
        } else row.error = "Installed version could not be read";
      } catch (err) {
        row.error = err instanceof Error && err.name === "TimeoutError" ? "npm check timed out" : err instanceof Error ? err.message : "npm check failed";
      }
      return row;
    })).then((sdks) => {
      cached = { checkedAt: now(), sdks };
      // Retry failures sooner, but avoid repeatedly hitting npm while opening settings.
      expires = cached.checkedAt + (sdks.some((sdk) => sdk.error) ? 5 * 60_000 : 6 * 60 * 60_000);
      return cached;
    }).finally(() => { pending = null; });
    return pending;
  };
}

export const checkSdkUpdates = createSdkUpdateCheck();
