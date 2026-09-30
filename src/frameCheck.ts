import { baseUrl } from "./config.js";
import { safeEmbedUrl } from "./embed.js";

/**
 * Whether a site lets the board show it in an iframe (a peek or split of an external link).
 * A cross-origin frame fires `load` even when the browser refuses it, so the board asks the
 * daemon to read the site's X-Frame-Options and CSP frame-ancestors headers instead.
 */
export type FrameCheck = {
  /** null when the probe could not tell (network error, timeout); the board frames it anyway. */
  framable: boolean | null;
  reason?: string;
};

const PROBE_TIMEOUT_MS = 3000;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; result: FrameCheck }>();

export async function checkFramable(raw: string): Promise<FrameCheck> {
  const href = safeEmbedUrl(raw);
  if (!href) {
    return { framable: false, reason: "not an http(s) URL outside the board" };
  }
  const hit = cache.get(href);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit.result;
  }
  const result = await probe(href);
  if (result.framable !== null) {
    cache.delete(href);
    cache.set(href, { at: Date.now(), result });
    while (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value as string);
    }
  }
  return result;
}

async function probe(href: string): Promise<FrameCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(href, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
    });
    void res.body?.cancel().catch(() => undefined);
    return framingVerdict(res.headers.get("x-frame-options"), res.headers.get("content-security-policy"), baseUrl());
  } catch (err) {
    return { framable: null, reason: (err as Error).name === "AbortError" ? "timed out" : (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Decide from the two headers whether `embedder` (the board's origin) may frame the response. */
export function framingVerdict(xfo: string | null, csp: string | null, embedder: string): FrameCheck {
  for (const policy of splitPolicies(csp)) {
    const sources = frameAncestors(policy);
    if (sources && !sources.some((source) => sourceAllows(source, embedder))) {
      return { framable: false, reason: `frame-ancestors ${sources.join(" ") || "(empty)"}` };
    }
  }
  // Browsers ignore X-Frame-Options when a policy sets frame-ancestors, but a blocking policy returned above.
  if (!csp || !splitPolicies(csp).some((policy) => frameAncestors(policy))) {
    for (const value of (xfo ?? "").split(",")) {
      const option = value.trim().toLowerCase();
      if (option === "deny" || option === "sameorigin") {
        return { framable: false, reason: `X-Frame-Options ${option.toUpperCase()}` };
      }
    }
  }
  return { framable: true };
}

/** Several CSP headers arrive joined with commas; each is its own policy and all of them apply. */
function splitPolicies(csp: string | null): string[] {
  return (csp ?? "")
    .split(",")
    .map((policy) => policy.trim())
    .filter(Boolean);
}

function frameAncestors(policy: string): string[] | null {
  for (const directive of policy.split(";")) {
    const parts = directive.trim().split(/\s+/);
    if (parts[0]?.toLowerCase() === "frame-ancestors") {
      return parts.slice(1);
    }
  }
  return null;
}

/** A CSP source expression against an origin like http://127.0.0.1:4747. 'self' never matches: the site is not the board. */
function sourceAllows(source: string, embedder: string): boolean {
  const value = source.trim().toLowerCase();
  if (value === "*") {
    return true;
  }
  if (value.startsWith("'")) {
    return false;
  }
  const origin = new URL(embedder);
  const scheme = origin.protocol;
  if (/^[a-z][a-z0-9+.-]*:$/.test(value)) {
    return value === scheme || (value === "http:" && scheme === "https:");
  }
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9.-]+)(?::(\*|\d+))?(?:\/.*)?$/.exec(value);
  if (!match) {
    return false;
  }
  const [, sourceScheme, host, port] = match;
  if (sourceScheme && `${sourceScheme}:` !== scheme && !(sourceScheme === "http" && scheme === "https:")) {
    return false;
  }
  if (host === "*") {
    // A bare * host needs a scheme to be a host source; "*" alone is handled above.
  } else if (host.startsWith("*.")) {
    if (!origin.hostname.endsWith(host.slice(1))) {
      return false;
    }
  } else if (host !== origin.hostname) {
    return false;
  }
  const embedderPort = origin.port || (scheme === "https:" ? "443" : "80");
  if (port === "*") {
    return true;
  }
  const defaultScheme = sourceScheme ? `${sourceScheme}:` : scheme;
  const wanted = port || (defaultScheme === "https:" ? "443" : "80");
  return wanted === embedderPort;
}
