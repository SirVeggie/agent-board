import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_INLINE_PAGE_IMAGE_BYTES,
  collectStateImages,
  mcpImageMime,
  pageAssetIdIn,
  skipInlinePageImage,
} from "./mcpImages.js";

const PNG = "pa_aaaaaaaaaaaaaaaaaaaaaaaa";
const JPEG = "pa_bbbbbbbbbbbbbbbbbbbbbbbb";

test("collectStateImages picks kanban-style images off a get result", () => {
  const refs = collectStateImages({
    result: {
      num: 87,
      title: "hint",
      images: [
        { id: "im_1", name: "image.png", data: `/blob/${PNG}` },
        { id: "im_2", name: "shot.jpg", data: JPEG },
      ],
    },
    stateRevision: 1,
  });
  assert.deepEqual(refs, [
    { id: "im_1", name: "image.png", assetId: PNG },
    { id: "im_2", name: "shot.jpg", assetId: JPEG },
  ]);
});

test("collectStateImages walks a page_state path value and skips duplicate assets", () => {
  const refs = collectStateImages({
    value: {
      id: "c1",
      images: [
        { id: "im_1", name: "a.png", data: `/blob/${PNG}` },
        { id: "im_dup", name: "again.png", data: `/blob/${PNG}` },
      ],
    },
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].assetId, PNG);
});

test("collectStateImages ignores covers nested in a whole-board dump", () => {
  const refs = collectStateImages({
    state: {
      cards: [
        { id: "c1", images: [{ id: "im_1", name: "a.png", data: `/blob/${PNG}` }] },
        { id: "c2", images: [{ id: "im_2", name: "b.png", data: `/blob/${JPEG}` }] },
      ],
    },
  });
  assert.deepEqual(refs, []);
});

test("collectStateImages ignores blobs that are not in an images array", () => {
  const refs = collectStateImages({
    html: `<img src="/blob/${PNG}">`,
    cover: `/blob/${JPEG}`,
  });
  assert.deepEqual(refs, []);
});

test("collectStateImages ignores malformed image entries", () => {
  assert.deepEqual(
    collectStateImages({
      images: [null, "x", { data: "/blob/not-an-id" }, { data: `/blob/${PNG}`, name: "ok.png", id: "im_1" }],
    }),
    [{ id: "im_1", name: "ok.png", assetId: PNG }]
  );
});

test("pageAssetIdIn extracts an id from a URL or a bare id", () => {
  assert.equal(pageAssetIdIn(`/blob/${PNG}`), PNG);
  assert.equal(pageAssetIdIn(PNG), PNG);
  assert.equal(pageAssetIdIn("asset:photo.png"), null);
});

test("skipInlinePageImage allows common rasters and rejects the rest", () => {
  assert.equal(skipInlinePageImage("image/png", 100), null);
  assert.equal(skipInlinePageImage("image/jpeg", 100), null);
  assert.equal(skipInlinePageImage("image/jpg", 100), null);
  assert.equal(skipInlinePageImage("image/webp", 100), null);
  assert.equal(skipInlinePageImage("image/svg+xml", 100), "image/svg+xml cannot be inlined");
  assert.equal(skipInlinePageImage("application/pdf", 100), "not an image");
  assert.equal(skipInlinePageImage("image/png", MAX_INLINE_PAGE_IMAGE_BYTES + 1), `too large (${MAX_INLINE_PAGE_IMAGE_BYTES + 1} bytes)`);
});

test("mcpImageMime normalizes jpg", () => {
  assert.equal(mcpImageMime("image/jpg"), "image/jpeg");
  assert.equal(mcpImageMime("image/png; charset=binary"), "image/png");
});
