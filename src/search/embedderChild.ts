import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { SEARCH_RUNTIME, type SearchPack } from "./pack.js";
import { tokenBatches } from "./batches.js";
import type { EmbedDocument } from "./embedder.js";

// The optional runtime deliberately has no compile-time dependency in Scribe.
const folder = process.argv[2];
let runtime: any;
let textModel: any, tokenizer: any, visionModel: any, processor: any;
let pack: SearchPack;
async function loadRuntime(): Promise<void> {
  if (runtime) return;
  pack = JSON.parse(fs.readFileSync(path.join(folder, "pack.json"), "utf8"));
  runtime = await import(pathToFileURL(path.join(folder, SEARCH_RUNTIME)).href);
  runtime.env.allowRemoteModels = false;
  runtime.env.allowLocalModels = true;
  runtime.env.useBrowserCache = false;
  runtime.env.localModelPath = path.join(folder, "models") + path.sep;
}
async function loadText(): Promise<void> {
  await loadRuntime();
  if (textModel) return;
  const config = await runtime.AutoConfig.from_pretrained(pack.model, { local_files_only: true });
  config.vision_config = config.audio_config = null;
  tokenizer = await runtime.AutoTokenizer.from_pretrained(pack.model, { local_files_only: true });
  textModel = await runtime.AutoModel.from_pretrained(pack.model, { config, device: "cpu", dtype: pack.dtype, local_files_only: true });
}
async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  await loadText();
  // Measure tokens before batching, rather than guessing from characters (especially multilingual text).
  const lengths: number[] = [];
  for (const text of texts) {
    const tokens = await tokenizer(text, { truncation: true, max_length: 6000 });
    lengths.push(tokens.input_ids.dims.at(-1));
  }
  const vectors: Float32Array[] = new Array(texts.length);
  for (const batch of tokenBatches(lengths)) {
    const encoded = await tokenizer(batch.map(i => texts[i]), { padding: true, truncation: true, max_length: 6000 });
    const { sentence_embedding: output } = await textModel(encoded);
    const width = output.dims.at(-1);
    batch.forEach((index, i) => { vectors[index] = Float32Array.from(output.data.subarray(i * width, (i + 1) * width)); });
  }
  return vectors;
}
async function embedImage(bytes: Uint8Array): Promise<Float32Array[]> {
  await loadRuntime();
  if (!visionModel) {
    const config = await runtime.AutoConfig.from_pretrained(pack.model, { local_files_only: true });
    config.audio_config = null;
    processor = await runtime.AutoProcessor.from_pretrained(pack.model, { local_files_only: true });
    visionModel = await runtime.AutoModel.from_pretrained(pack.model, { config, device: "cpu", dtype: pack.dtype, local_files_only: true });
  }
  const image = await runtime.RawImage.fromBlob(new Blob([Uint8Array.from(bytes).buffer]));
  const { sentence_embedding } = await visionModel(await processor(null, image));
  return [Float32Array.from(sentence_embedding.data)];
}
// Serialize requests so ONNX execution and lazy loading never overlap.
let queue = Promise.resolve();
process.on("message", (raw: unknown) => {
  const { id, method, input } = raw as { id: number; method: string; input: any };
  queue = queue.then(async () => {
    try {
      let vectors: Float32Array[];
      if (method === "embedQuery") vectors = await embedTexts([`task: search result | query: ${input}`]);
      else if (method === "embedDocuments") vectors = await embedTexts((input as EmbedDocument[]).map(item => `title: ${item.title || "none"} | text: ${item.text}`));
      else if (method === "embedImage") vectors = await embedImage(input);
      else throw new Error("Unknown embedding method");
      if (process.connected) process.send?.({ id, vectors, peakRssBytes: process.resourceUsage().maxRSS * 1024 });
    } catch (err) { if (process.connected) process.send?.({ id, error: (err as Error).message }); }
  });
});
// A daemon crash/disconnect must not leave model memory behind.
process.on("disconnect", () => process.exit(0));
