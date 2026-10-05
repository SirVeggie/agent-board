/** Web search and fetch for a thread: any site, only the allowlist's domains, or none. */
export type WebAccess = "on" | "limited" | "off";

/**
 * Starting allowlist for limited web access: documentation, package registries and code hosts an
 * agent commonly needs while coding. A domain also allows its subdomains.
 */
export const DEFAULT_WEB_ALLOWLIST: string[] = [
  "github.com",
  "githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "stackoverflow.com",
  "stackexchange.com",
  "developer.mozilla.org",
  "wikipedia.org",
  "npmjs.com",
  "nodejs.org",
  "typescriptlang.org",
  "pypi.org",
  "python.org",
  "readthedocs.io",
  "crates.io",
  "docs.rs",
  "rust-lang.org",
  "go.dev",
  "pkg.go.dev",
  "learn.microsoft.com",
  "docs.anthropic.com",
  "docs.claude.com",
  "platform.openai.com",
  "cursor.com",
  "w3.org",
  "whatwg.org",
  "caniuse.com",
  "web.dev",
];

/** Older threads and prefs stored web as a boolean. Unknown values give undefined. */
export function parseWebAccess(value: unknown): WebAccess | undefined {
  if (value === true || value === "on") return "on";
  if (value === false || value === "off") return "off";
  if (value === "limited") return "limited";
  return undefined;
}

/** One domain per entry, lower case, without scheme, path, port or a leading "*." / ".". Drops blanks and repeats. */
export function cleanAllowlist(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const domain = raw
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/[/?#].*$/, "")
      .replace(/:\d+$/, "")
      .replace(/^\*?\./, "")
      .replace(/\.$/, "");
    if (domain && /^[a-z0-9.-]+$/.test(domain)) out.add(domain);
  }
  return [...out];
}

/** Whether a host (or a URL's host) is on the allowlist; each entry also allows its subdomains. */
export function webAllowed(urlOrHost: string, allowlist: string[]): boolean {
  let host = urlOrHost.trim().toLowerCase();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    return false;
  }
  host = host.replace(/\.$/, "");
  if (!host) return false;
  return allowlist.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * How much an agent needs a web request it asks for while its thread's web access does not cover it.
 * In threads a board worker runs, nobody may be watching: an unanswered request is refused after
 * this long and the agent goes on without it. necessary waits until the turn ends.
 */
export type WebImportance = "necessary" | "important" | "useful" | "trivial";

export const WEB_IMPORTANCE_WAIT_MS: Record<WebImportance, number | null> = {
  necessary: null,
  important: 2 * 60 * 60 * 1000,
  useful: 15 * 60 * 1000,
  trivial: 2 * 60 * 1000,
};

export function parseWebImportance(value: unknown): WebImportance | undefined {
  return typeof value === "string" && value in WEB_IMPORTANCE_WAIT_MS ? (value as WebImportance) : undefined;
}

/** What the user let a thread reach beyond its web setting, for the rest of the thread. */
export type WebGrants = { all?: boolean; domains?: string[] };

/** A web call an agent wants to make: a fetch of url, or a search (limited to domains when it names some). */
export type WebCall = { kind: "fetch"; url: string } | { kind: "search"; query?: string; domains?: string[] };

/** The domains a call reaches: the fetched URL's host, or the domains a search is limited to. Empty for an open search. */
export function webCallDomains(call: WebCall): string[] {
  if (call.kind === "search") return cleanAllowlist(call.domains ?? []);
  try {
    const host = new URL(call.url).hostname.toLowerCase().replace(/\.$/, "");
    return host ? [host.replace(/^www\./, "")] : [];
  } catch {
    return [];
  }
}

/** Whether a thread may make this call without asking: web on, the allowlist (limited), or what the user granted. */
export function webCallAllowed(call: WebCall, web: WebAccess, allowlist: string[], grants: WebGrants | undefined): boolean {
  if (web === "on" || grants?.all) return true;
  const domains = webCallDomains(call);
  if (!domains.length) return false;
  const reach = [...(web === "limited" ? allowlist : []), ...(grants?.domains ?? [])];
  return domains.every((domain) => webAllowed(domain, reach));
}

/** The grants after the user answered a request with "domain" or "session". */
export function grantWeb(grants: WebGrants | undefined, answer: "domain" | "session", call: WebCall): WebGrants {
  if (answer === "session") return { ...grants, all: true };
  return { ...grants, domains: cleanAllowlist([...(grants?.domains ?? []), ...webCallDomains(call)]) };
}

/** Whether an "Allow once" pass from web_request covers a call: a fetch on the same host, or a search within the asked domains. */
export function webPassCovers(pass: WebCall, call: WebCall): boolean {
  if (pass.kind !== call.kind) return false;
  const asked = webCallDomains(pass);
  if (pass.kind === "search" && !asked.length) return true;
  const domains = webCallDomains(call);
  return domains.length > 0 && domains.every((domain) => webAllowed(domain, asked));
}
