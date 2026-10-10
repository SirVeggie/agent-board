import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../config.js";

export const SEARCH_PACK_API = 1;
export const SEARCH_MODEL = "onnx-community/embeddinggemma-2-ONNX";
export const SEARCH_RUNTIME = "node_modules/@huggingface/transformers/dist/transformers.node.mjs";
export type SearchPack = {
  api: number; version: string; platform: string; arch: string;
  model: string; dtype: "q8"; files: Record<string, string>;
};
export type PackStatus = {
  status: "not-installed" | "ready" | "wrong-version" | "invalid";
  folder: string; requiredApi: number; message: string; pack?: SearchPack;
};
export function searchPackDir(root = dataDir()): string { return path.resolve(root, "packs", "search"); }

/** Cheap detection for Settings; hashes are checked by the build, not on every UI read. */
export function detectSearchPack(root = dataDir(), platform = process.platform, arch = process.arch): PackStatus {
  const folder = searchPackDir(root);
  const result = (status: PackStatus["status"], message: string, pack?: SearchPack): PackStatus =>
    ({ status, folder, requiredApi: SEARCH_PACK_API, message, ...(pack ? { pack } : {}) });
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(path.join(folder, "pack.json"), "utf8")); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return result("not-installed", "Not installed");
    return result("invalid", "Cannot read pack.json. Unzip the search pack again.");
  }
  if (!raw || typeof raw !== "object") return result("invalid", "Invalid pack.json");
  const p = raw as SearchPack;
  if (p.api !== SEARCH_PACK_API) return result("wrong-version", `Requires a search pack with API ${SEARCH_PACK_API}`);
  if (p.platform !== platform || p.arch !== arch) return result("wrong-version", `Requires a ${platform}-${arch} search pack`);
  if (typeof p.version !== "string" || !p.version || p.model !== SEARCH_MODEL || p.dtype !== "q8" || !p.files || typeof p.files !== "object" || Array.isArray(p.files)) {
    return result("invalid", "Unsupported model or invalid search pack manifest");
  }
  const required = [SEARCH_RUNTIME, ...["config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "processor_config.json", "onnx/model_quantized.onnx", "onnx/vision_encoder_quantized.onnx"].map(f => `models/${SEARCH_MODEL}/${f}`)];
  for (const name of required) if (!p.files[name]) return result("invalid", `Incomplete search pack: ${name}`);
  for (const [name, hash] of Object.entries(p.files)) {
    if (name.includes("\\") || path.posix.isAbsolute(name) || name.split("/").some(part => part === ".." || !part) || !/^[a-f0-9]{64}$/.test(hash)) return result("invalid", "Invalid file entry in pack.json");
    try { if (!fs.statSync(path.join(folder, name)).isFile()) throw new Error(); }
    catch { return result("invalid", `Incomplete search pack: ${name}`); }
  }
  return result("ready", `Ready · ${p.version}`, p);
}

export function searchEnabled(root = dataDir()): boolean {
  try { return JSON.parse(fs.readFileSync(path.join(root, "search-settings.json"), "utf8")).enabled === true; }
  catch { return false; }
}
export function setSearchEnabled(enabled: boolean, root = dataDir()): void {
  if (enabled && detectSearchPack(root).status !== "ready") throw new Error("Install a compatible search pack first");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "search-settings.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ enabled }));
  fs.renameSync(`${file}.tmp`, file);
}
