import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { AutoConfig, AutoModel, AutoProcessor, RawImage } from "@huggingface/transformers";
const db = new DatabaseSync(path.join(process.env.LOCALAPPDATA, "scribe", "scribe.sqlite"), { readOnly: true });
const assets = db.prepare("SELECT a.id,a.name,a.bytes,a.data,t.state FROM page_assets a JOIN tabs t ON t.id=a.tab_id").all();
const cardOf = new Map();
for (const a of assets) { if (cardOf.has(a.id)) continue; try { for (const c of JSON.parse(a.state).cards || []) for (const im of c.images || []) cardOf.set(String(im.data).split("/").pop(), c); } catch {} }
const model_id = "onnx-community/embeddinggemma-2-ONNX";
const config = await AutoConfig.from_pretrained(model_id); config.audio_config = null;
let t = Date.now();
const processor = await AutoProcessor.from_pretrained(model_id);
const model = await AutoModel.from_pretrained(model_id, { config, device: "cpu", dtype: "q8" });
console.log("load ms", Date.now() - t, "rss", Math.round(process.memoryUsage().rss / 1e6));
const embed = async (...inputs) => (await model(await processor(...inputs))).sentence_embedding.data;
const items = [];
t = Date.now();
for (const a of assets) {
  const card = cardOf.get(a.id); if (!card) continue;
  const img = await RawImage.fromBlob(new Blob([a.data], { type: "image/png" }));
  const t1 = Date.now();
  const v = Float32Array.from(await embed(null, img));
  items.push({ card, v, ms: Date.now() - t1, size: `${img.width}x${img.height}` });
}
console.log("images", items.length, "total ms", Date.now() - t, "per image ms", items.map((i) => i.ms).sort((a, b) => a - b)[items.length >> 1], "rss", Math.round(process.memoryUsage().rss / 1e6));
const dot = (a, b) => { let s = 0; for (let i = 0; i < 768; i++) s += a[i] * b[i]; return s; };
// 1) card title as query -> rank of that card's own screenshot among all screenshots
const ranks = [];
for (const it of items) {
  const q = await embed([`task: search result | query: ${it.card.title}`]);
  const order = items.map((x) => [dot(q, x.v), x]).sort((a, b) => b[0] - a[0]);
  const r = order.findIndex(([, x]) => x.card.num === it.card.num) + 1; ranks.push(r);
  console.log(String(r).padStart(2), order[0][0].toFixed(3), `#${it.card.num}`, it.card.title.slice(0, 70), "| top:", `#${order[0][1].card.num}`);
}
console.log("own screenshot top1", ranks.filter((r) => r === 1).length, "top3", ranks.filter((r) => r <= 3).length, "of", ranks.length);
// 2) free descriptions
for (const text of ["a kanban board with columns", "a context menu", "a chat conversation panel", "error message dialog", "settings form with toggles", "a terminal with code"]) {
  const q = await embed([`task: search result | query: ${text}`]);
  const order = items.map((x) => [dot(q, x.v), x]).sort((a, b) => b[0] - a[0]).slice(0, 3);
  console.log(text, "→", order.map(([s, x]) => `${s.toFixed(3)} #${x.card.num} ${x.card.title.slice(0, 34)}`).join(" | "));
}
