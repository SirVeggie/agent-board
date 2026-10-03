import { isPageAssetId } from "./pageAssets.js";

/** How many page images one MCP result will send to the model. */
export const MAX_INLINE_PAGE_IMAGES = 8;
/** Same cap as a chat image attachment; larger blobs stay as metadata. */
export const MAX_INLINE_PAGE_IMAGE_BYTES = 8 * 1024 * 1024;

const INLINE_IMAGE_MIME = /^(image\/(png|jpe?g|gif|webp|bmp))$/i;

export type StateImageRef = {
  /** Item id on the card/todo (`im_…`), when the page stored one. */
  id: string;
  name: string;
  assetId: string;
};

/**
 * Find `{ id, name, data: "/blob/pa_…" }` entries on one card or todo — the Kanban and
 * Todo-list convention. Looks at `images` on the value itself, on `result` (page_action get),
 * and on `value` (a page_state path). Does not walk every card on a whole-board dump.
 */
export function collectStateImages(value: unknown): StateImageRef[] {
  const out: StateImageRef[] = [];
  const seen = new Set<string>();
  for (const img of imageLists(value)) {
    if (!img || typeof img !== "object") continue;
    const rec = img as Record<string, unknown>;
    const data = typeof rec.data === "string" ? rec.data : "";
    const assetId = pageAssetIdIn(data);
    if (!assetId || seen.has(assetId)) continue;
    seen.add(assetId);
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : assetId;
    const id = typeof rec.id === "string" ? rec.id : "";
    out.push({ id, name, assetId });
  }
  return out;
}

function imageLists(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const rec = value as Record<string, unknown>;
  const lists: unknown[][] = [];
  if (Array.isArray(rec.images)) lists.push(rec.images);
  for (const key of ["result", "value"] as const) {
    const nested = rec[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested) && Array.isArray((nested as Record<string, unknown>).images)) {
      lists.push((nested as Record<string, unknown>).images as unknown[]);
    }
  }
  return lists.flat();
}

export function pageAssetIdIn(value: string): string | null {
  const match = /pa_[0-9a-f]{24}/.exec(value);
  return match && isPageAssetId(match[0]) ? match[0] : null;
}

/** Why this blob should not be sent as MCP image content, or null if it should. */
export function skipInlinePageImage(mimeType: string, bytes: number): string | null {
  if (bytes > MAX_INLINE_PAGE_IMAGE_BYTES) {
    return `too large (${bytes} bytes)`;
  }
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  if (!INLINE_IMAGE_MIME.test(mime)) {
    return mime.startsWith("image/") ? `${mime} cannot be inlined` : "not an image";
  }
  return null;
}

export function mcpImageMime(mimeType: string): string {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}
