import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_PAGE_ASSET_BYTES,
  MAX_PAGE_ASSETS_PER_TAB,
  MAX_PAGE_ASSETS_TOTAL_BYTES,
  PAGE_ASSET_WARN_RATIO,
} from "./config.js";

/**
 * Blobs a page saves from its own code (`board.saveAsset`). Unlike agent-attached assets
 * (src/assets.ts), they live in scribe.sqlite and are addressed by a random id that the page
 * keeps in its state. Any occurrence of the id in the page's state or HTML counts as a
 * reference; an asset nobody references for PAGE_ASSET_ORPHAN_GRACE_MS is deleted.
 */
export type PageAssetMeta = {
  id: string;
  tabId: string;
  name: string;
  mimeType: string;
  bytes: number;
  createdAt: number;
  /** When the asset was last seen unreferenced; unset while the page references it. */
  orphanedAt?: number;
};

export type PageAssetUsage = {
  count: number;
  bytes: number;
  maxCount: number;
  maxBytes: number;
  /** Set once either limit is PAGE_ASSET_WARN_RATIO full. */
  warning?: string;
};

export type PageAssetInput = {
  name?: string;
  mimeType?: string;
  data: Buffer;
};

/** A page asset carried by an export file or an import. */
export type PageAssetDraft = {
  id: string;
  name: string;
  mimeType: string;
  createdAt: number;
  data: Buffer;
};

const ID_HEX = 24;
const PAGE_ASSET_ID = /^pa_[0-9a-f]{24}$/;
/** No word boundaries: a false positive only keeps an asset alive, a miss would delete one. */
const PAGE_ASSET_REF = /pa_[0-9a-f]{24}/g;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const NAME_MAX = 200;
const DEFAULT_MIME = "application/octet-stream";

export function newPageAssetId(): string {
  return `pa_${randomBytes(ID_HEX / 2).toString("hex")}`;
}

export function isPageAssetId(value: string): boolean {
  return PAGE_ASSET_ID.test(value);
}

/** Page-relative URL; the same for every page, so a page can store it and survive export/import. */
export function pageAssetUrl(id: string): string {
  return `/blob/${id}`;
}

export function collectPageAssetRefs(...texts: string[]): Set<string> {
  const refs = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PAGE_ASSET_REF)) {
      refs.add(match[0]);
    }
  }
  return refs;
}

/** Swap asset ids in a page's text, for an import whose ids are already taken on this board. */
export function remapPageAssetRefs(text: string, remap: Map<string, string>): string {
  if (!remap.size) {
    return text;
  }
  return text.replace(PAGE_ASSET_REF, (id) => remap.get(id) ?? id);
}

export function normalizePageAssetMime(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_MIME;
  }
  const bare = value.split(";")[0].trim().toLowerCase();
  return MIME.test(bare) ? bare : DEFAULT_MIME;
}

export function cleanPageAssetName(value: unknown): string {
  if (typeof value !== "string") {
    return "asset";
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, NAME_MAX);
  return cleaned || "asset";
}

export function assertPageAssetSize(bytes: number, label = "asset"): void {
  if (bytes <= 0) {
    throw new Error(`${label} is empty`);
  }
  if (bytes > MAX_PAGE_ASSET_BYTES) {
    throw new Error(`${label} is too large (${bytes} bytes, max ${MAX_PAGE_ASSET_BYTES})`);
  }
}

/** Throws when adding `adding` more assets of `addingBytes` would pass a page's limits. */
export function assertPageAssetRoom(current: { count: number; bytes: number }, adding: number, addingBytes: number): void {
  const count = current.count + adding;
  if (count > MAX_PAGE_ASSETS_PER_TAB) {
    throw new Error(`page asset limit reached (${count} assets, max ${MAX_PAGE_ASSETS_PER_TAB})`);
  }
  const bytes = current.bytes + addingBytes;
  if (bytes > MAX_PAGE_ASSETS_TOTAL_BYTES) {
    throw new Error(
      `page asset storage is full (${formatBytes(bytes)} needed, max ${formatBytes(MAX_PAGE_ASSETS_TOTAL_BYTES)})`
    );
  }
}

export function pageAssetUsage(current: { count: number; bytes: number } | undefined): PageAssetUsage {
  const count = current?.count ?? 0;
  const bytes = current?.bytes ?? 0;
  const usage: PageAssetUsage = {
    count,
    bytes,
    maxCount: MAX_PAGE_ASSETS_PER_TAB,
    maxBytes: MAX_PAGE_ASSETS_TOTAL_BYTES,
  };
  if (bytes >= MAX_PAGE_ASSETS_TOTAL_BYTES * PAGE_ASSET_WARN_RATIO) {
    usage.warning = `page assets use ${formatBytes(bytes)} of ${formatBytes(MAX_PAGE_ASSETS_TOTAL_BYTES)}`;
  } else if (count >= MAX_PAGE_ASSETS_PER_TAB * PAGE_ASSET_WARN_RATIO) {
    usage.warning = `page has ${count} of ${MAX_PAGE_ASSETS_PER_TAB} assets`;
  }
  return usage;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A local file the agent attaches to a page's state (page_update `assets`). */
export type PageAssetFile = {
  path: string;
  name?: string;
};

const FILE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".zip": "application/zip",
};

export function readPageAssetFile(input: PageAssetFile): { name: string; mimeType: string; data: Buffer } {
  const resolved = path.resolve(input.path);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`asset not found: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new Error(`asset is not a file: ${resolved}`);
  }
  assertPageAssetSize(stat.size, resolved);
  const name = cleanPageAssetName(input.name ?? path.basename(resolved));
  const mimeType = FILE_MIME[path.extname(input.name ?? resolved).toLowerCase()] ?? "application/octet-stream";
  return { name, mimeType, data: fs.readFileSync(resolved) };
}

const STATE_ASSET_REF = /^asset:(.+)$/;

/**
 * Replace every state string that is exactly `asset:<name>` with the URL for that name
 * (names compare case-insensitively). Returns the names it met that have no URL.
 */
export function substituteStateAssets(
  value: unknown,
  urls: Map<string, string>,
  used: Set<string>,
  missing: Set<string>
): unknown {
  if (typeof value === "string") {
    const match = STATE_ASSET_REF.exec(value);
    if (!match) {
      return value;
    }
    const key = match[1].trim().toLowerCase();
    const url = urls.get(key);
    if (url === undefined) {
      missing.add(match[1]);
      return value;
    }
    used.add(key);
    return url;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteStateAssets(item, urls, used, missing));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = substituteStateAssets(item, urls, used, missing);
    }
    return out;
  }
  return value;
}
