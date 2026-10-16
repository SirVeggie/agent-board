import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const html = fs.readFileSync(new URL("../templates/builtin/kanban.html", import.meta.url), "utf8");
const migration = html.slice(html.indexOf("  async function migrateLegacyImages()"), html.indexOf("  function addImageFiles("));
const legacy = "data:image/png;base64,aGVsbG8=";
const url = "/blob/pa_aaaaaaaaaaaaaaaaaaaaaaaa";

function harness(cards: any[], save: (blob: Blob) => Promise<unknown>) {
  const hints: string[] = [];
  const context = vm.createContext({
    fetch, scribe: { saveAsset: save },
    allCards: () => cards,
    card: (id: string) => cards.find(c => c.id === id),
    updateCard: (id: string, fn: (c: any) => any) => {
      const i = cards.findIndex(c => c.id === id);
      cards[i] = fn({ ...cards[i] });
    },
    setHint: (message: string) => hints.push(message),
  });
  vm.runInContext(migration, context);
  return { run: () => vm.runInContext("migrateLegacyImages()", context) as Promise<void>, hints };
}

test("legacy card images migrate without changing image IDs, markdown, or existing asset references", async () => {
  const cards = [{ id: "a", description: "![shot](#img-im_1)", cover: false, images: [
    { id: "im_1", name: "shot.png", data: legacy }, { id: "im_2", name: "saved", data: url },
  ] }, { id: "archived", archived: true, images: [{ id: "im_3", name: "old", data: legacy }] }];
  let uploads = 0;
  const h = harness(cards, async blob => {
    uploads++;
    assert.equal(blob.type, "image/png");
    assert.equal(await blob.text(), "hello");
    return { url };
  });
  await h.run();
  assert.equal(uploads, 2);
  assert.equal(cards[0].description, "![shot](#img-im_1)");
  assert.equal(cards[0].cover, false);
  assert.deepEqual(JSON.parse(JSON.stringify(cards[0].images)), [{ id: "im_1", name: "shot.png", data: url }, { id: "im_2", name: "saved", data: url }]);
  assert.equal(cards[1].images[0].data, url);
  await h.run();
  assert.equal(uploads, 2, "already migrated images need no uploads");
  assert.deepEqual(h.hints, []);
});

test("migration retains failed images for retry and preserves edits made while uploading", async () => {
  const cards = [{ id: "a", title: "Original", images: [
    { id: "failed", data: legacy }, { id: "removed", data: legacy }, { id: "changed", data: legacy }, { id: "ok", data: legacy },
  ] }];
  let n = 0;
  const h = harness(cards, async () => {
    n++;
    if (n === 1) throw new Error("storage full");
    cards[0].title = "Edited";
    cards[0].images = cards[0].images.filter(im => im.id !== "removed");
    cards[0].images.find(im => im.id === "changed")!.data = "replacement";
    return { url };
  });
  await h.run();
  assert.equal(cards[0].title, "Edited");
  assert.deepEqual(cards[0].images.map(im => im.data), [legacy, "replacement", url]);
  assert.equal(h.hints.length, 1);
  await h.run();
  assert.equal(cards[0].images[0].data, url);
});
