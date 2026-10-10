// Pack-dependent image retrieval check, not a unit test. The source library is read-only.
// npm run build && npm run eval:images -- --data <data-dir> [--pack <data-dir>] [--verbose]
// Indexes only the pages that hold images, then compares image-only ranking with the blended score.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "../dist/config.js";
import { loadBuiltinTemplates } from "../dist/builtinTemplates.js";
import { parseSearchDeclaration } from "../dist/search/chunker.js";
import { SearchIndex } from "../dist/search/indexer.js";
import { SearchEmbedder } from "../dist/search/embedder.js";
import { detectSearchPack, searchEnabled } from "../dist/search/pack.js";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = path.resolve(option("--data", dataDir()));
const verbose = args.includes("--verbose");
const packRoot = path.resolve(option("--pack", root));
const pack = detectSearchPack(packRoot);
if (pack.status !== "ready") throw new Error(`A real search pack is required: ${pack.message} (${pack.folder})`);
if (!searchEnabled(packRoot)) throw new Error("Enable the installed pack in Settings → Search before running this eval.");

const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|avif)$/i;
const library = new DatabaseSync(path.join(root, "scribe.sqlite"), { readOnly: true });
let pages, folders, templates, bindings;
const assetsOf = new Map();
try {
  library.exec("BEGIN");
  for (const row of library.prepare("SELECT id,tab_id,name,mime_type,data FROM page_assets").all()) {
    if (!IMAGE_TYPE.test(row.mime_type)) continue;
    const data = Uint8Array.from(row.data);
    assetsOf.set(row.tab_id, [...assetsOf.get(row.tab_id) ?? [], { ref: row.id, name: row.name, hash: row.id, read: () => data }]);
  }
  pages = library.prepare("SELECT * FROM tabs WHERE status IN ('open','closed')").all().map(row => ({ id: row.id, key: row.key, title: row.title, html: row.html, state: JSON.parse(row.state), assets: JSON.parse(row.assets || "[]"), updatedAt: row.updated_at, stateUpdatedAt: row.state_updated_at, folderId: row.folder_id }));
  folders = new Map(library.prepare("SELECT * FROM folders WHERE deleted_at IS NULL").all().map(row => [row.id, row]));
  templates = new Map(library.prepare("SELECT * FROM templates").all().map(row => [row.id, row]));
  bindings = new Map(library.prepare("SELECT * FROM template_bindings").all().map(row => [row.tab_id, row.template_id]));
  library.exec("COMMIT");
} finally { library.close(); }
// Files given to page_show live beside the database.
for (const page of pages) for (const asset of page.assets) {
  if (!IMAGE_TYPE.test(asset.mimeType)) continue;
  const file = path.join(root, "assets", page.id, asset.name);
  if (!fs.existsSync(file)) continue;
  const data = fs.readFileSync(file);
  assetsOf.set(page.id, [...assetsOf.get(page.id) ?? [], { ref: `asset:${asset.name}`, name: asset.name, hash: createHash("sha256").update(data).digest("hex"), read: () => data }]);
}
pages = pages.filter(page => assetsOf.has(page.id));
const byId = new Map(pages.map(page => [page.id, page]));
const builtins = new Map(loadBuiltinTemplates().map(t => [t.key, t]));
const folder = page => {
  const names = [], seen = new Set();
  for (let f = folders.get(page.folderId); f && !seen.has(f.id); f = folders.get(f.parent_id)) { names.unshift(f.name); seen.add(f.id); }
  return names.join("/") || null;
};
const declaration = page => {
  const template = templates.get(bindings.get(page.id));
  return template?.search ? parseSearchDeclaration(JSON.parse(template.search)) : builtins.get(template?.builtin_key)?.search;
};
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-image-eval-"));
const embedder = new SearchEmbedder({ root: packRoot });
const imageMs = [];
const timed = { embedQuery: q => embedder.embedQuery(q), embedDocuments: items => embedder.embedDocuments(items), embedImage: async bytes => { const t = Date.now(); const v = await embedder.embedImage(bytes); imageMs.push(Date.now() - t); return v; } };
const index = new SearchIndex(scratch, { pages: () => pages, get: id => byId.get(id), folder, declaration, assets: page => assetsOf.get(page.id) ?? [] }, timed, 5000, 0);
const all = () => true;
const count = (ranks, n) => ranks.filter(r => r > 0 && r <= n).length;
const short = (text, n = 44) => String(text).replace(/\s+/g, " ").slice(0, n);
try {
  const start = Date.now();
  index.start(pack.pack.model, pack.pack.dtype);
  await index.idle();
  const status = index.status();
  if (status.error) throw new Error(status.error);
  imageMs.sort((a, b) => a - b);
  console.log(`Indexed ${status.indexedPages} pages, ${status.chunks} text chunks, ${status.images} images in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  // The first image pays for loading the vision encoder.
  console.log(`Per image: median ${imageMs[imageMs.length >> 1]} ms, first (with encoder load) ${Math.max(...imageMs)} ms${status.imageError ? `, last error: ${status.imageError}` : ""}`);
  const images = await index.queryImages("image", all, 100000, false, 1);
  const owners = new Map();
  for (const hit of images) if (hit.ownerRow && hit.ownerRow.kind !== "page") {
    const key = `${hit.tab_id}\n${hit.owner}`;
    owners.set(key, { tab: hit.tab_id, owner: hit.owner, label: hit.label, refs: [...owners.get(key)?.refs ?? [], hit.anchor] });
  }
  console.log(`${images.length} images, ${owners.size} owning cards, items or sections\n`);

  const rankOf = (hits, owner) => hits.findIndex(hit => hit.tab_id === owner.tab && hit.owner === owner.owner) + 1;
  // Weight of the image in the score: 1 is the image alone, 0.5 the blend Scribe uses, 0 the owner's text alone.
  const weights = [1, 0.7, 0.5, 0.3, 0];
  const compare = async (title, cases) => {
    const ranks = weights.map(() => []);
    console.log(`${title} (rank of the owner's image at image weight ${weights.join(", ")}):`);
    for (const { query, owner } of cases) {
      const row = [];
      for (const [i, weight] of weights.entries()) { const rank = rankOf(await index.queryImages(query, all, 100000, false, weight), owner); ranks[i].push(rank); row.push(String(rank).padStart(2)); }
      if (verbose) console.log(`  ${row.join(" ")}  ${short(query, 70)}`);
    }
    for (const [i, weight] of weights.entries()) console.log(`  weight ${weight.toFixed(1)}${weight === 1 ? " (image only)" : weight === 0.5 ? " (blended)" : weight === 0 ? " (owner's text only)" : ""}: top 1 ${count(ranks[i], 1)}, top 3 ${count(ranks[i], 3)} of ${cases.length}, MRR ${(ranks[i].reduce((sum, r) => sum + (r ? 1 / r : 0), 0) / Math.max(1, cases.length)).toFixed(3)}`);
    return ranks;
  };
  // 1) The owner's title as the query, as in the prototype. The owner's chunk holds its title, so any text weight wins this one.
  const titled = await compare("Owner's title as the query", [...owners.values()].map(owner => ({ query: owner.label.replace(/^#\d+\s+/, ""), owner })));
  const only = titled[0], blended = titled[2];

  // 2) Queries reworded to avoid the card's words, written after seeing the titles: a sanity check, not a benchmark.
  const queries = JSON.parse(fs.readFileSync(new URL("./semantic-search-proto/image-queries.json", import.meta.url), "utf8"));
  const cases = queries.flatMap(query => {
    const owner = [...owners.values()].find(o => byId.get(o.tab)?.key === query.want && o.owner.startsWith(`record:cards:${query.card}:`));
    return owner ? [{ query: query.q, owner }] : [];
  });
  console.log("");
  const reworded = cases.length ? await compare("Reworded card queries", cases) : null;
  if (!reworded) console.log("None of the reworded queries' cards has an image in this library.");

  // 3) Plain descriptions of what a picture shows.
  console.log("\nPlain descriptions (top 3, image only | blended):");
  for (const text of ["a kanban board with columns", "a context menu", "a chat conversation panel", "error message dialog", "settings form with toggles", "a terminal with code"]) {
    const show = hits => hits.slice(0, 3).map(hit => `${hit.score.toFixed(3)} ${short(hit.label, 30)}`).join(" · ");
    console.log(`  ${text}\n    image:   ${show(await index.queryImages(text, all, 3, false, 1))}\n    blended: ${show(await index.queryImages(text, all, 3, false, 0.5))}`);
    const kept = await index.queryImages(text, all, 8, true);
    if (verbose) console.log(`    rows the palette would keep: ${kept.length}`);
  }

  // 4) An image as the query: a cropped, rescaled copy of each image should find the original.
  const sharp = createRequire(path.join(pack.folder, "package.json"))("sharp");
  const found = [], margins = [], kept = [];
  for (const hit of images.slice(0, 40)) {
    const bytes = assetsOf.get(hit.tab_id).find(asset => asset.ref === hit.anchor).read();
    const meta = await sharp(bytes).metadata();
    if (meta.width < 40 || meta.height < 40) continue;
    const box = { left: Math.round(meta.width * 0.1), top: Math.round(meta.height * 0.1), width: Math.round(meta.width * 0.8), height: Math.round(meta.height * 0.8) };
    const copy = await sharp(bytes).extract(box).resize({ width: Math.max(32, Math.round(box.width * 0.7)) }).jpeg({ quality: 70 }).toBuffer();
    const hits = await index.queryImages(copy, all, 100000, false);
    const rank = hits.findIndex(h => h.tab_id === hit.tab_id && h.anchor === hit.anchor) + 1;
    found.push(rank);
    const other = hits.find(h => !(h.tab_id === hit.tab_id && h.anchor === hit.anchor));
    if (rank && other) margins.push(hits[rank - 1].score - other.score);
    kept.push((await index.queryImages(copy, all, 8, true)).length);
    if (verbose || rank !== 1) console.log(`  rank ${rank}  ${hits[0].score.toFixed(3)} best, original ${rank ? hits[rank - 1].score.toFixed(3) : "absent"}  ${short(hit.label, 50)}`);
  }
  margins.sort((a, b) => a - b); kept.sort((a, b) => a - b);
  console.log(`\nImage as the query (80% crop, 70% scale, JPEG): original first for ${count(found, 1)}, top 3 for ${count(found, 3)} of ${found.length}`);
  if (margins.length) console.log(`  lead over the best other image: median ${margins[margins.length >> 1].toFixed(3)}, smallest ${margins[0].toFixed(3)}; rows kept by the cut-off: median ${kept[kept.length >> 1]}, most ${kept.at(-1)}`);
  console.log(JSON.stringify({ images: images.length, owners: owners.size, titleImageOnly: { top1: count(only, 1), top3: count(only, 3) }, titleBlended: { top1: count(blended, 1), top3: count(blended, 3) }, reworded: reworded && { of: cases.length, imageOnlyTop3: count(reworded[0], 3), blendedTop3: count(reworded[2], 3), textOnlyTop3: count(reworded[4], 3) }, imageQuery: { top1: count(found, 1), of: found.length }, medianImageMs: imageMs[imageMs.length >> 1] }));
} finally {
  embedder.dispose(); await index.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
