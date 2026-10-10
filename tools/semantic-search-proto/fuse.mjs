// Page ranking: how to combine the page vector, the best chunk and word matches. Uses cached vectors.
import fs from "node:fs";
import { AutoConfig, AutoModel, AutoTokenizer } from "@huggingface/transformers";
const meta = JSON.parse(fs.readFileSync("index-q8.json", "utf8"));
const buf = fs.readFileSync("index-q8.bin"); const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
const model_id = "onnx-community/embeddinggemma-2-ONNX";
const config = await AutoConfig.from_pretrained(model_id); config.vision_config = config.audio_config = null;
const model = await AutoModel.from_pretrained(model_id, { config, device: "cpu", dtype: "q8" });
const tokenizer = await AutoTokenizer.from_pretrained(model_id);
const queries = JSON.parse(fs.readFileSync("queries.json", "utf8")).filter((q) => !q.card);
const keys = [...new Set(meta.map((m) => m.key))];
const res = {};
const add = (name, rank) => (res[name] ||= []).push(rank || 99);
for (const q of queries) {
  const qv = (await model(await tokenizer([`task: search result | query: ${q.q}`]))).sentence_embedding.data;
  const per = new Map(keys.map((k) => [k, { page: 0, chunks: [] }]));
  for (let j = 0; j < meta.length; j++) { if (meta[j].kind === "whole") continue; let s = 0; for (let i = 0; i < 768; i++) s += qv[i] * vecs[j * 768 + i]; const p = per.get(meta[j].key); if (meta[j].kind === "page") p.page = s; else p.chunks.push(s); }
  const score = (fn) => keys.map((k) => { const p = per.get(k); p.chunks.sort((a, b) => b - a); return [fn(p), k]; }).sort((a, b) => b[0] - a[0]).findIndex(([, k]) => k === q.want) + 1;
  add("page vector only", score((p) => p.page));
  add("best chunk only", score((p) => Math.max(p.page * 0, ...p.chunks, p.chunks.length ? -1 : p.page)));
  add("max(page, best chunk)", score((p) => Math.max(p.page, ...p.chunks)));
  add("0.5 page + 0.5 best", score((p) => 0.5 * p.page + 0.5 * Math.max(p.page, ...p.chunks)));
  add("0.6 page + 0.4 best", score((p) => 0.6 * p.page + 0.4 * Math.max(p.page, ...p.chunks)));
  add("0.5 page + 0.3 best + 0.2 second", score((p) => { const b = Math.max(p.page, ...p.chunks); return 0.5 * p.page + 0.3 * b + 0.2 * (p.chunks[1] ?? b); }));
}
for (const [k, v] of Object.entries(res)) console.log(k.padEnd(34), "top1", v.filter((r) => r === 1).length, "top3", v.filter((r) => r <= 3).length, "top5", v.filter((r) => r <= 5).length, "MRR", (v.reduce((a, r) => a + 1 / r, 0) / v.length).toFixed(3), "ranks", v.join(","));
// score distribution: how separable is a hit from noise
