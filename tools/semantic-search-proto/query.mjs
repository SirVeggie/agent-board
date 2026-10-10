import fs from "node:fs";
import { AutoConfig, AutoModel, AutoTokenizer } from "@huggingface/transformers";
const dtype = process.argv[2] || "q8";
const meta = JSON.parse(fs.readFileSync(`index-${dtype}.json`, "utf8"));
const buf = fs.readFileSync(`index-${dtype}.bin`);
const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
const model_id = "onnx-community/embeddinggemma-2-ONNX";
const config = await AutoConfig.from_pretrained(model_id);
config.vision_config = config.audio_config = null;
const model = await AutoModel.from_pretrained(model_id, { config, device: "cpu", dtype });
const tokenizer = await AutoTokenizer.from_pretrained(model_id);
const queries = JSON.parse(fs.readFileSync("queries.json", "utf8"));
const dims = [768, 256];
const norm = (v, d) => { let s = 0; for (let i = 0; i < d; i++) s += v[i] * v[i]; return Math.sqrt(s); };
const dnorm = {}; for (const d of dims) dnorm[d] = meta.map((_, j) => norm(vecs.subarray(j * 768, j * 768 + d), d));
function search(qv, d, kinds) {
  const qn = norm(qv, d); const out = [];
  for (let j = 0; j < meta.length; j++) { if (!kinds.includes(meta[j].kind)) continue; let s = 0; const o = j * 768; for (let i = 0; i < d; i++) s += qv[i] * vecs[o + i]; out.push([s / qn / dnorm[d][j], j]); }
  return out.sort((a, b) => b[0] - a[0]);
}
// page rank = best chunk per page (max), with page-level vector included
function pages(ranked) { const seen = new Map(); for (const [s, j] of ranked) if (!seen.has(meta[j].key)) seen.set(meta[j].key, [s, j]); return [...seen.entries()]; }
const modes = { pageOnly: ["page"], whole: ["page", "whole"], chunks: ["page", "section", "card", "item"] };
const stats = {};
for (const q of queries) {
  let t = Date.now();
  const { sentence_embedding } = await model(await tokenizer([`task: search result | query: ${q.q}`]));
  const qv = sentence_embedding.data; const embMs = Date.now() - t;
  console.log(`\nQ: ${q.q}   [want ${q.want}] embed ${embMs}ms`);
  for (const d of dims) for (const [mode, kinds] of Object.entries(modes)) {
    t = Date.now(); const ranked = search(qv, d, kinds); const ms = Date.now() - t;
    const pr = pages(ranked);
    const rank = q.card ? ranked.findIndex(([, j]) => meta[j].label.startsWith(`#${q.card} `)) + 1 : pr.findIndex(([k]) => k === q.want) + 1;
    const id = `${mode}@${d}`; (stats[id] ||= []).push(rank || 99);
    if (d === 768 && mode === "chunks") {
      console.log(`  scan ${ms}ms; top chunks:`); for (const [s, j] of ranked.slice(0, 4)) console.log(`   ${s.toFixed(3)} ${meta[j].kind.padEnd(7)} ${meta[j].pageTitle.slice(0, 40)} › ${meta[j].label.slice(0, 60)}`);
    }
  }
  console.log("  rank of wanted:", Object.entries(stats).map(([k, v]) => `${k}=${v.at(-1)}`).join("  "));
}
console.log("\nSUMMARY (n=" + queries.length + ")");
for (const [k, v] of Object.entries(stats)) console.log(k.padEnd(14), "top1", v.filter((r) => r === 1).length, "top3", v.filter((r) => r <= 3).length, "top5", v.filter((r) => r <= 5).length, "MRR", (v.reduce((a, r) => a + 1 / r, 0) / v.length).toFixed(3));
