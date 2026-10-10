// Pack-dependent retrieval eval, not a unit test. The source library is read-only.
// npm run build && npm run eval:search -- --data <data-dir> [--pack <data-dir>] [--max-rss-gb 4] [--verbose]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const maxRssGb = Number(option("--max-rss-gb", "4"));
if (!Number.isFinite(maxRssGb) || maxRssGb <= 0) throw new Error("--max-rss-gb must be positive");
// The pack can live in another data folder, so a library without one is evaluated untouched.
const packRoot = path.resolve(option("--pack", root));
const pack = detectSearchPack(packRoot);
if (pack.status !== "ready") throw new Error(`A real search pack is required: ${pack.message} (${pack.folder})`);
if (!searchEnabled(packRoot)) throw new Error("Enable the installed pack in Settings → Search before running this eval.");

const library = new DatabaseSync(path.join(root, "scribe.sqlite"), { readOnly: true });
let pages, folders, templates, bindings;
try {
  // Copy a consistent snapshot, release SQLite before the potentially long CPU index.
  library.exec("BEGIN");
  pages = library.prepare("SELECT * FROM tabs WHERE status IN ('open','closed')").all().map(row => ({ id: row.id, key: row.key, title: row.title, html: row.html, state: JSON.parse(row.state), updatedAt: row.updated_at, stateUpdatedAt: row.state_updated_at, folderId: row.folder_id }));
  folders = new Map(library.prepare("SELECT * FROM folders WHERE deleted_at IS NULL").all().map(row => [row.id, row]));
  templates = new Map(library.prepare("SELECT * FROM templates").all().map(row => [row.id, row]));
  bindings = new Map(library.prepare("SELECT * FROM template_bindings").all().map(row => [row.tab_id, row.template_id]));
  library.exec("COMMIT");
} finally { library.close(); }
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-search-eval-"));
const embedder = new SearchEmbedder({ root: packRoot });
const index = new SearchIndex(scratch, { pages: () => pages, get: id => byId.get(id), folder, declaration }, embedder);
const queries = JSON.parse(fs.readFileSync(new URL("./semantic-search-proto/queries.json", import.meta.url), "utf8"));
const answers = [];
let daemonPeak = process.memoryUsage().rss;
const sample = setInterval(() => { daemonPeak = Math.max(daemonPeak, process.memoryUsage().rss); }, 100);
const start = Date.now();
try {
  index.start(pack.pack.model, pack.pack.dtype);
  await index.idle();
  if (index.status().error) throw new Error(index.status().error);
  console.log(`Indexed ${index.status().indexedPages} pages / ${index.status().chunks} chunks in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  for (const query of queries) {
    const hits = await index.query(query.q, query.card ? "chunks" : "pages", () => true, 100000, false);
    // One result per expected card, even when its comments/description have multiple parts.
    const seen = new Set();
    const ranked = hits.filter(hit => {
      const key = query.card ? `${hit.tab_id}:${hit.kind}:${hit.anchor}` : hit.tab_id;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    const rank = ranked.findIndex(hit => byId.get(hit.tab_id)?.key === query.want && (!query.card || hit.kind === "record" && hit.anchor === String(query.card))) + 1;
    answers.push(rank || Infinity);
    console.log(`${rank > 0 && rank <= 3 ? "PASS" : "MISS"} rank=${rank || "absent"} ${query.q}`);
    if (verbose && !(rank > 0 && rank <= 3)) for (const hit of ranked.slice(0, 5)) console.log(`     ${hit.score.toFixed(3)} ${hit.kind} ${byId.get(hit.tab_id)?.title} › ${hit.label}`);
  }
  const top1 = answers.filter(r => r <= 1).length, top3 = answers.filter(r => r <= 3).length, top5 = answers.filter(r => r <= 5).length;
  const modelPeakGb = embedder.peakRssBytes / 1024 ** 3;
  const daemonPeakGb = Math.max(daemonPeak, process.memoryUsage().rss) / 1024 ** 3;
  console.log(JSON.stringify({ top1, top3, top5, total: answers.length, mrr: answers.reduce((sum, r) => sum + 1 / r, 0) / answers.length, modelPeakGb, daemonPeakGb, maxRssGb }, null, 2));
  // The spec baseline is 24/28; the memory guard is configurable for another CPU/runtime.
  if (top3 < 24 || !modelPeakGb || modelPeakGb > maxRssGb || daemonPeakGb > maxRssGb) process.exitCode = 1;
} finally {
  clearInterval(sample); embedder.dispose(); await index.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
