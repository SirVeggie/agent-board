import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import express from "express";
import { AGENT_CLIENT, CLIENT_HEADER } from "../config.js";
import { store } from "../store.js";
import { searchRouter } from "./routes.js";
import { searchIndex } from "./service.js";
import { searchEmbedder } from "./embedder.js";
import { SEARCH_MODEL, SEARCH_RUNTIME, searchPackDir, setSearchEnabled } from "./pack.js";

test("semantic HTTP validates queries, returns anchors without scores and filters hidden pages", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-semantic-routes-"));
  const previous = process.env.SCRIBE_HOME; process.env.SCRIBE_HOME = root;
  const app = express(); app.use(express.json()); app.use("/api/search", searchRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/search`;
  try {
    assert.equal((await fetch(`${url}/semantic?q=hello`)).status, 503);
    assert.equal(fs.existsSync(path.join(root, "search.sqlite")), false);
    for (const query of ["q=", "q=hello&scope=wrong", "q=hello&limit=0", "q=hello&limit=31", "q=hello&limit=NaN", "q=" + "x".repeat(501)]) assert.equal((await fetch(`${url}/semantic?${query}`)).status, 400);
    const folder = searchPackDir(root);
    const runtime = `
      export const env = {};
      export const AutoConfig = { from_pretrained: async () => ({}) };
      export const AutoTokenizer = { from_pretrained: async () => async input => ({ input_ids: { dims: [Array.isArray(input) ? input.length : 1, 10] } }) };
      export const AutoModel = { from_pretrained: async () => async encoded => {
        const n = encoded.input_ids?.dims[0] ?? 1, data = new Float32Array(n * 768);
        for (let i = 0; i < n; i++) data[i * 768] = 1;
        return { sentence_embedding: { dims: [n, 768], data } };
      } };
      export const AutoProcessor = { from_pretrained: async () => async () => ({}) };
      export const RawImage = { fromBlob: async () => ({}) };
    `;
    const files: Record<string, string> = {};
    for (const name of [SEARCH_RUNTIME, ...["config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "processor_config.json", "onnx/model_quantized.onnx", "onnx/vision_encoder_quantized.onnx"].map(n => `models/${SEARCH_MODEL}/${n}`)]) {
      const content = name === SEARCH_RUNTIME ? runtime : "{}";
      fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true }); fs.writeFileSync(path.join(folder, name), content);
      files[name] = createHash("sha256").update(content).digest("hex");
    }
    fs.writeFileSync(path.join(folder, "pack.json"), JSON.stringify({ api: 1, version: "test", platform: process.platform, arch: process.arch, model: SEARCH_MODEL, dtype: "q8", files }));
    store.load();
    const board = store.openFromTemplate("builtin:kanban", { title: "Board" }).tab;
    store.writeState(board.id, { ops: [{ op: "set", path: "cards", value: [{ num: 12, title: "Deep card", description: "Searchable card description for the route fixture" }] }] });
    const shot = store.savePageAsset(board.id, { name: "shot.png", mimeType: "image/png", data: Buffer.from([1, 2, 3]) }).asset;
    store.writeState(board.id, { ops: [{ op: "set", path: "cards/num=12/images", value: [{ id: "im_a", name: "shot.png", data: `/blob/${shot.id}` }] }] });
    const hidden = store.upsert({ title: "Hidden", html: "<h1>Hidden</h1><p>" + "Hidden information. ".repeat(20) + "</p>" }).tab;
    store.setAgentHidden(hidden.id, true);
    const enable = await fetch(`${url}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    assert.equal(enable.status, 200); await searchIndex.idle();
    const status = await (await fetch(`${url}/index/status`)).json();
    assert.equal(status.error, null); assert.ok(status.indexedPages >= 2); assert.ok(status.chunks >= 4);
    const user = await (await fetch(`${url}/semantic?q=hello&scope=pages`)).json();
    assert.ok(user.hits.some((h: { id: string }) => h.id === hidden.id));
    const agent = await (await fetch(`${url}/semantic?q=hello&scope=chunks`, { headers: { [CLIENT_HEADER]: AGENT_CLIENT } })).json();
    assert.ok(agent.hits.every((h: { id: string }) => h.id !== hidden.id));
    const card = agent.hits.find((h: { id: string }) => h.id === board.id);
    assert.equal(card.anchor, "12"); assert.equal(card.kind, "record"); assert.equal(card.label, "#12 Deep card");
    // A folder limits the hits to the pages in it; the hidden page stays out for the agent.
    const inRoot = await fetch(`${url}/semantic?q=hello&scope=chunks&limit=30&folder=${encodeURIComponent("/")}`, { headers: { [CLIENT_HEADER]: AGENT_CLIENT } });
    assert.deepEqual([...new Set((await inRoot.json()).hits.map((h: { id: string }) => h.id))], [board.id]);
    assert.equal((await fetch(`${url}/semantic?q=hello&folder=Nowhere`)).status, 404);
    assert.equal(card.score, undefined); assert.equal(card.hash, undefined); assert.equal(card.vec, undefined);
    // Image rows carry the image's URL and the card it sits on, for a text query and for an image as the query.
    assert.equal(status.images, 1);
    const wanted = [{ id: board.id, key: board.key, title: "Board", folder: null, kind: "image", anchor: shot.id, headingId: null, label: "#12 Deep card", snippet: "shot.png", image: `/blob/${shot.id}`, owner: { kind: "record", anchor: "12", headingId: null } }];
    assert.deepEqual((await (await fetch(`${url}/semantic?q=hello&scope=images`)).json()).hits, wanted);
    const similar = await fetch(`${url}/semantic/image`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Uint8Array.of(9, 9) });
    assert.deepEqual((await similar.json()).hits, wanted);
    assert.equal((await fetch(`${url}/semantic/image`, { method: "POST" })).status, 400);
    const queriesBefore = searchEmbedder.peakRssBytes; assert.ok(queriesBefore > 0);
    store.deleteMany([board.id]);
    assert.equal((await searchIndex.query("hello", "chunks", () => true)).some(h => h.tab_id === board.id), false);
    const disable = await fetch(`${url}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    assert.equal(disable.status, 200); assert.equal((await fetch(`${url}/semantic?q=hello`)).status, 503);
    assert.equal(searchEmbedder.running, false);
  } finally {
    setSearchEnabled(false, root); searchEmbedder.stop(); await searchIndex.close(); store.closeDb();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.SCRIBE_HOME; else process.env.SCRIBE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
