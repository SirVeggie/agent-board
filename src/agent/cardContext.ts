import type { store } from "../store.js";
import { collectStateImages, mcpImageMime, skipInlinePageImage } from "../mcpImages.js";
import { MAX_FILES_PER_MESSAGE, MAX_MESSAGE_BYTES } from "./attachments.js";
import type { ChatImage, ThreadScope } from "./types.js";

/** Resolve a page's card on the host so the first input has the same data as page_action get. */
export function cardContext(
  pages: Pick<typeof store, "runAction" | "readTabPageAsset">,
  scope: ThreadScope,
  num: unknown,
  attached: { data: string }[] = [],
): { text: string; images: ChatImage[] } {
  if (scope.kind !== "page" || !scope.ref || !Number.isInteger(num) || Number(num) < 1) {
    throw new Error("Card context requires a page thread and a card number");
  }
  const { result } = pages.runAction(scope.ref, "get", { card: num }, { by: "user" });
  const images: ChatImage[] = [];
  const notes: string[] = [];
  let bytes = attached.reduce((total, file) => total + Math.floor(file.data.length * 3 / 4), 0);
  for (const ref of collectStateImages(result)) {
    try {
      const asset = pages.readTabPageAsset(scope.ref, ref.assetId);
      const skipped = skipInlinePageImage(asset.meta.mimeType, asset.data.length);
      if (skipped) throw new Error(skipped);
      if (attached.length + images.length >= MAX_FILES_PER_MESSAGE || bytes + asset.data.length > MAX_MESSAGE_BYTES) {
        throw new Error("message attachment limit reached");
      }
      images.push({ name: `${ref.name}${ref.id ? ` (${ref.id})` : ""}`, mimeType: mcpImageMime(asset.meta.mimeType), data: asset.data.toString("base64") });
      bytes += asset.data.length;
    } catch (err) {
      notes.push(`${ref.name} (${ref.id}): ${(err as Error).message}`);
    }
  }
  return {
    text: `Card snapshot (page_action get):\n${JSON.stringify(result, null, 2)}${notes.length ? `\nImages not attached; use page_action get if needed:\n${notes.join("\n")}` : ""}`,
    images,
  };
}
