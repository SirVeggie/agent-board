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
