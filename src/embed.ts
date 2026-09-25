import { baseUrl } from "./config.js";

const META_TAG = /<meta\b[^>]*>/gi;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
/** The meta tag belongs in <head>; don't scan a whole 2 MB page for it. */
const HEAD_SCAN_CHARS = 16_384;

/**
 * A page with <meta name="agent-board-embed" content="URL"> is shown by pointing the tab
 * iframe at URL directly, so the site's own cookies work. Only http(s) URLs outside the
 * board's origin qualify: a javascript: URL or the board itself would run with the board's
 * origin and reach its API.
 */
export function embedUrlFromHtml(html: string): string | undefined {
  for (const tag of html.slice(0, HEAD_SCAN_CHARS).match(META_TAG) ?? []) {
    const attrs = parseAttrs(tag);
    if (attrs.get("name")?.toLowerCase() === "agent-board-embed") {
      return safeEmbedUrl(attrs.get("content") ?? "");
    }
  }
  return undefined;
}

export function safeEmbedUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  if (url.origin === new URL(baseUrl()).origin) {
    return undefined;
  }
  return url.href;
}

function parseAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of tag.matchAll(ATTR)) {
    attrs.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attrs;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
