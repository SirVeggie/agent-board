// Prototype for #350: chunk the real library (read-only) and embed it with EmbeddingGemma 2.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { AutoConfig, AutoModel, AutoTokenizer } from "@huggingface/transformers";

const device = process.argv[2] || "cpu";
const dtype = process.argv[3] || "q8";
const db = new DatabaseSync(path.join(process.env.LOCALAPPDATA, "scribe", "scribe.sqlite"), { readOnly: true });
const folders = new Map(db.prepare("SELECT id,parent_id,name FROM folders WHERE deleted_at IS NULL").all().map((f) => [f.id, f]));
const folderPath = (id) => { const out = []; for (let f = folders.get(id); f; f = folders.get(f.parent_id)) out.unshift(f.name); return out.join("/"); };
const rows = db.prepare("SELECT id,key,title,html,state,folder_id FROM tabs WHERE status!='deleted'").all();

const ent = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const strip = (h) => ent(h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const TARGET = 1400, MAX = 2000, MIN = 200;

function sections(html) {
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const parts = body.split(/(?=<h[1-4]\b)/i);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
    const heading = m ? strip(m[1]) : "";
    const text = strip(m ? part.slice(m[0].length) : part);
    if (!text && !heading) continue;
    // long section: split on sentence ends near TARGET
    let rest = text;
    while (rest.length > MAX) {
      let cut = rest.lastIndexOf(". ", TARGET);
      if (cut < TARGET / 2) cut = rest.lastIndexOf(" ", TARGET);
      out.push({ heading, text: rest.slice(0, cut + 1) });
      rest = rest.slice(cut + 1).trim();
    }
    out.push({ heading, text: rest });
  }
  // merge short neighbours
  const merged = [];
  for (const s of out) {
    const last = merged.at(-1);
    if (last && (last.text.length < MIN || s.text.length < MIN) && last.text.length + s.text.length < TARGET) {
      last.text += " " + (s.heading ? s.heading + ": " : "") + s.text;
    } else merged.push({ ...s });
  }
  return merged;
}

const chunks = []; // { page, key, pageTitle, kind, label, anchor, doc }
for (const r of rows) {
  const folder = folderPath(r.folder_id);
  const text = strip(r.html);
  let state = {}; try { state = JSON.parse(r.state); } catch {}
  const cards = Array.isArray(state.cards) ? state.cards.filter((c) => !c.archived) : null;
  const items = Array.isArray(state.items) ? state.items : Array.isArray(state.todos) ? state.todos : null;
  // page-level vector: title, folder, and what the page is mostly about
  let summary = text.slice(0, 3000);
  if (cards) summary = cards.slice(-60).map((c) => c.title).join(" · ").slice(0, 3000);
  chunks.push({ page: r.id, key: r.key, pageTitle: r.title, kind: "page", label: r.title, doc: `title: ${r.title} | text: ${folder ? `Folder: ${folder}. ` : ""}${summary}` });
  // whole-page vector (8K context) for comparison
  if (!cards && text.length > 3000) chunks.push({ page: r.id, key: r.key, pageTitle: r.title, kind: "whole", label: r.title, doc: `title: ${r.title} | text: ${text.slice(0, 26000)}` });
  if (cards) {
    for (const c of cards) {
      const comments = (c.comments || []).map((x) => x.text).join("\n").slice(0, 1200);
      const body = [c.description || "", (c.checklist || []).map((i) => i.text).join("; "), comments].filter(Boolean).join("\n").slice(0, MAX);
      chunks.push({ page: r.id, key: r.key, pageTitle: r.title, kind: "card", label: `#${c.num} ${c.title}`, anchor: `card:${c.num}`, doc: `title: ${r.title} › ${c.title} | text: ${body || c.title}` });
    }
  } else {
    if (!r.title.includes("Kanban") && text.length > 600) for (const [i, s] of sections(r.html).entries()) {
      if (s.text.length < 40) continue;
      chunks.push({ page: r.id, key: r.key, pageTitle: r.title, kind: "section", label: s.heading || `part ${i + 1}`, anchor: `sec:${i}`, doc: `title: ${r.title}${s.heading ? ` › ${s.heading}` : ""} | text: ${s.text}` });
    }
    if (items) for (const it of items) { const t = it.text || it.title; if (t) chunks.push({ page: r.id, key: r.key, pageTitle: r.title, kind: "item", label: String(t).slice(0, 80), doc: `title: ${r.title} | text: ${t}` }); }
  }
}
const byKind = {}; for (const c of chunks) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
console.log("pages", rows.length, "chunks", chunks.length, byKind, "chars", chunks.reduce((a, c) => a + c.doc.length, 0));

const model_id = "onnx-community/embeddinggemma-2-ONNX";
let t = Date.now();
const config = await AutoConfig.from_pretrained(model_id);
config.vision_config = config.audio_config = null;
const model = await AutoModel.from_pretrained(model_id, { config, device, dtype });
const tokenizer = await AutoTokenizer.from_pretrained(model_id);
console.log("load ms", Date.now() - t, device, dtype, "rss MB", Math.round(process.memoryUsage().rss / 1e6));

// sort by length so batches pad little
const order = chunks.map((c, i) => i).sort((a, b) => chunks[a].doc.length - chunks[b].doc.length);
const vecs = new Float32Array(chunks.length * 768);
let tokens = 0; t = Date.now();
const BUDGET = Number(process.argv[4] || 6000);
for (let i = 0; i < order.length; ) {
  let n = 1; const per = (j) => Math.ceil(chunks[order[j]].doc.length / 3.5); while (i + n < order.length && n < 32 && (n + 1) * per(i + n) <= BUDGET) n++; const idx = order.slice(i, i + n); i += n;
  const enc = await tokenizer(idx.map((j) => chunks[j].doc), { padding: true, truncation: true, max_length: 8192 });
  tokens += enc.input_ids.dims[0] * enc.input_ids.dims[1];
  const { sentence_embedding } = await model(enc);
  idx.forEach((j, k) => vecs.set(sentence_embedding.data.subarray(k * 768, (k + 1) * 768), j * 768));
}
const ms = Date.now() - t;
console.log("embed ms", ms, "padded tokens", tokens, "chunks/s", (chunks.length / ms * 1000).toFixed(1), "tok/s", Math.round(tokens / ms * 1000), "rss MB", Math.round(process.memoryUsage().rss / 1e6));
fs.writeFileSync(`index-${dtype}.json`, JSON.stringify(chunks.map(({ doc, ...c }) => ({ ...c, len: doc.length, head: doc.slice(0, 160) }))));
fs.writeFileSync(`index-${dtype}.bin`, Buffer.from(vecs.buffer));
// single query latency
for (let i = 0; i < 3; i++) { t = Date.now(); await model(await tokenizer(["task: search result | query: where did I write about worktree junction problems"])); console.log("query ms", Date.now() - t); }
