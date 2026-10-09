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

const MAX_FETCH_CHARS = 200_000;

/**
 * The web_fetch tool's work, for providers that bring their own (Cursor with web off or limited,
 * Pi always): fetch a URL as text, following redirects by hand so gate sees every host on the way.
 */
export async function gatedFetchText(rawUrl: unknown, gate: (url: string) => Promise<{ allowed: boolean; message?: string }>): Promise<{ text: string; isError: boolean }> {
  let url = typeof rawUrl === "string" ? rawUrl : "";
  for (let hop = 0; hop < 6; hop += 1) {
    if (!/^https?:\/\//i.test(url)) return { text: `Not an http(s) URL: ${url}`, isError: true };
    const gated = await gate(url);
    if (!gated.allowed) return { text: `Refused: ${gated.message ?? "the user did not allow this fetch."}`, isError: true };
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (next) {
      url = new URL(next, url).toString();
      continue;
    }
    const text = await res.text();
    const body = text.length > MAX_FETCH_CHARS ? `${text.slice(0, MAX_FETCH_CHARS)}\n… (truncated)` : text;
    return { text: `HTTP ${res.status} ${res.headers.get("content-type") ?? ""}\n\n${body}`, isError: !res.ok };
  }
  return { text: "Too many redirects.", isError: true };
}

/** A SearXNG instance's base URL as typed in Agent settings: http(s) only, no trailing slash or query. "" when unusable. */
export function cleanSearxngUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `${url.origin}${url.pathname.replace(/\/(search)?\/*$/, "")}`;
  } catch {
    return "";
  }
}

const MAX_SEARCH_RESULTS = 10;

/**
 * A web_search call for Pi and Cursor threads, through the user's SearXNG instance. The search
 * is checked like Claude's WebSearch: { kind: "search", domains }. An open search the thread's
 * setting does not cover keeps to reach (the allowlist and granted domains) without asking: `site:`
 * filters go into the query and other results are dropped. Anything else asks the user.
 */
export async function gatedSearchText(
  baseUrl: string,
  args: { query?: unknown; domains?: unknown },
  access: { allowed(call: WebCall): boolean; reach(): string[]; ask(call: WebCall): Promise<{ allowed: boolean; message?: string }> },
  signal?: AbortSignal
): Promise<{ text: string; isError: boolean }> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { text: "No query.", isError: true };
  const asked = cleanAllowlist(Array.isArray(args.domains) ? args.domains : []);
  const call: WebCall = { kind: "search", query, ...(asked.length ? { domains: asked } : {}) };
  let keep = asked;
  if (!access.allowed(call)) {
    const reach = asked.length ? [] : cleanAllowlist(access.reach());
    if (reach.length) keep = reach;
    else {
      const gated = await access.ask(call);
      if (!gated.allowed) return { text: `Refused: ${gated.message ?? "the user did not allow this search."}`, isError: true };
    }
  }
  const sites = keep.length && keep.length <= 8 ? ` ${keep.map((d) => `site:${d}`).join(" OR ")}` : "";
  const url = new URL(`${baseUrl}/search`);
  url.searchParams.set("q", `${query}${sites}`);
  url.searchParams.set("format", "json");
  let body: unknown;
  try {
    const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    if (res.status === 403) return { text: "The SearXNG instance refused JSON results: add json to search.formats in its settings.yml.", isError: true };
    if (!res.ok) return { text: `SearXNG answered HTTP ${res.status}.`, isError: true };
    body = await res.json();
  } catch (err) {
    return { text: `SearXNG at ${baseUrl} did not answer: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
  const raw = (body as { results?: unknown })?.results;
  const results = (Array.isArray(raw) ? raw : [])
    .map((r: { url?: unknown; title?: unknown; content?: unknown }) => ({
      url: typeof r?.url === "string" ? r.url : "",
      title: typeof r?.title === "string" ? r.title.trim() : "",
      content: typeof r?.content === "string" ? r.content.trim() : "",
    }))
    .filter((r) => /^https?:\/\//i.test(r.url) && (!keep.length || webAllowed(r.url, keep)))
    .slice(0, MAX_SEARCH_RESULTS);
  const scope = keep.length && keep !== asked ? `\n(Kept to the allowed domains: ${keep.join(", ")}. Pass domains to search a few of them directly; other domains ask the user.)` : "";
  if (!results.length) return { text: `No results.${scope}`, isError: false };
  const lines = results.map((r, i) => `${i + 1}. ${r.title || r.url}\n   ${r.url}${r.content ? `\n   ${r.content}` : ""}`);
  return { text: `${lines.join("\n\n")}${scope}`, isError: false };
}

/** The web_search tool's input, for Pi and Cursor. */
export const WEB_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "What to search for." },
    domains: { type: "array", items: { type: "string" }, description: "Only search these domains (and their subdomains), e.g. [\"docs.python.org\"]." },
  },
  required: ["query"],
};

export function webSearchDescription(web: WebAccess): string {
  const base = "Search the web and return the top results (title, URL, snippet). Use web_fetch to read a result.";
  if (web === "on") return base;
  if (web === "limited") return `${base} Without domains it searches only the user's allowed sites; naming other domains asks the user first, who may refuse.`;
  return `${base} Each search asks the user first, who may refuse.`;
}
