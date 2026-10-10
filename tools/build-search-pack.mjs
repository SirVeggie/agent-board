#!/usr/bin/env node
// Run on the target OS/architecture. Does not touch Scribe's dependencies.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const model = "onnx-community/embeddinggemma-2-ONNX";
const version = "1.0.0";
const runtimeVersion = "4.3.1";
const platform = process.platform, arch = process.arch;
if (!["win32", "linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error(`Unsupported platform: ${platform}-${arch}`);
const output = path.resolve(process.argv[2] || `scribe-search-pack-${version}-${platform}-${arch}.zip`);
if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);
const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "scribe-search-pack-"));
const root = path.join(temp, "pack");
await fsp.mkdir(root);
function run(command, args, cwd = root, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
async function* files(dir, prefix = "") {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) yield* files(path.join(dir, entry.name), relative + "/");
    else if (entry.isFile()) yield relative;
    else throw new Error(`Unexpected symlink in pack: ${relative}`);
  }
}
try {
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "@huggingface/transformers": runtimeVersion } }));
  // npm.cmd needs cmd on Windows; arguments here are fixed, never paths or user input.
  if (platform === "win32") await run("cmd.exe", ["/d", "/s", "/c", "npm install --omit=dev --no-audit --no-fund"]);
  else await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"]);
  const modules = path.join(root, "node_modules");
  await fsp.rm(path.join(modules, "onnxruntime-web"), { recursive: true, force: true });
  const native = path.join(modules, "onnxruntime-node", "bin", "napi-v6");
  for (const osName of await fsp.readdir(native)) {
    if (osName !== platform) await fsp.rm(path.join(native, osName), { recursive: true, force: true });
  }
  const nativePlatform = path.join(native, platform);
  for (const architecture of await fsp.readdir(nativePlatform)) {
    if (architecture !== arch) await fsp.rm(path.join(nativePlatform, architecture), { recursive: true, force: true });
  }
  // CPU only; omit CUDA provider libraries if this runtime version shipped them.
  for (const name of await fsp.readdir(path.join(nativePlatform, arch))) {
    if (/cuda|tensorrt/i.test(name)) await fsp.rm(path.join(nativePlatform, arch, name), { force: true });
  }
  const imgScope = path.join(modules, "@img");
  const sharpPlatform = platform === "win32" ? "win32" : platform;
  for (const name of await fsp.readdir(imgScope)) {
    if (/^sharp-/.test(name) && !name.endsWith(`-${sharpPlatform}-${arch}`)) await fsp.rm(path.join(imgScope, name), { recursive: true, force: true });
  }
  const runtimeEntry = "node_modules/@huggingface/transformers/dist/transformers.node.mjs";
  await fsp.access(path.join(root, runtimeEntry));
  const runtimeDist = path.dirname(path.join(root, runtimeEntry));
  for (const name of await fsp.readdir(runtimeDist)) {
    if (name !== "transformers.node.mjs") await fsp.rm(path.join(runtimeDist, name), { recursive: true, force: true });
  }
  // Resolve a single immutable model revision, including all external ONNX data shards.
  const metadataResponse = await fetch(`https://huggingface.co/api/models/${model}`);
  if (!metadataResponse.ok) throw new Error(`Model metadata: HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  if (!/^[a-f0-9]{40}$/.test(metadata.sha)) throw new Error("Missing model revision");
  const names = metadata.siblings.map(item => item.rfilename).filter(name =>
    /^[^/]+\.(json|txt|model)$/.test(name) || /^onnx\/(model|vision_encoder)_quantized\.onnx(?:_data.*)?$/.test(name));
  for (const required of ["config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "processor_config.json", "onnx/model_quantized.onnx", "onnx/vision_encoder_quantized.onnx"]) {
    if (!names.includes(required)) throw new Error(`Model is missing ${required}`);
  }
  for (const name of names) {
    const target = path.join(root, "models", model, name);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    console.log(`Fetching ${name}`);
    const response = await fetch(`https://huggingface.co/${model}/resolve/${metadata.sha}/${name}`);
    if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target));
  }
  // Preserve the model license alongside the runtime licenses installed by npm.
  for (const name of metadata.siblings.map(item => item.rfilename).filter(name => /^(LICENSE(?:\..*)?|README\.md)$/i.test(name))) {
    const response = await fetch(`https://huggingface.co/${model}/resolve/${metadata.sha}/${name}`);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    await fsp.writeFile(path.join(root, "models", model, name), await response.text());
  }
  // Fail the build if pruning broke native imports or offline text/vision inference.
  await run(process.execPath, ["--input-type=module", "-e", `
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = process.cwd();
    const { env, AutoConfig, AutoModel, AutoTokenizer, AutoProcessor, RawImage } = await import(pathToFileURL(path.join(root, '${runtimeEntry}')).href);
    env.allowRemoteModels = false;
    env.localModelPath = path.join(root, 'models') + path.sep;
    const id = '${model}';
    const config = await AutoConfig.from_pretrained(id, { local_files_only: true });
    config.audio_config = config.vision_config = null;
    const model = await AutoModel.from_pretrained(id, { config, dtype: 'q8', device: 'cpu', local_files_only: true });
    const tokenizer = await AutoTokenizer.from_pretrained(id, { local_files_only: true });
    const query = await model(await tokenizer(['task: search result | query: search pack test']));
    if (query.sentence_embedding.data.length !== 768) throw new Error('Invalid query vector');
    await model.dispose();
    const visionConfig = await AutoConfig.from_pretrained(id, { local_files_only: true });
    visionConfig.audio_config = null;
    const vision = await AutoModel.from_pretrained(id, { config: visionConfig, dtype: 'q8', device: 'cpu', local_files_only: true });
    const processor = await AutoProcessor.from_pretrained(id, { local_files_only: true });
    const image = new RawImage(new Uint8ClampedArray(32 * 32 * 3).fill(128), 32, 32, 3);
    const result = await vision(await processor(null, image));
    if (result.sentence_embedding.data.length !== 768) throw new Error('Invalid image vector');
    await vision.dispose();
    console.log('Offline text and vision smoke tests passed');
  `]);
  const hashes = {};
  for await (const name of files(root)) {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(path.join(root, name))) hash.update(chunk);
    hashes[name] = hash.digest("hex");
  }
  await fsp.writeFile(path.join(root, "pack.json"), JSON.stringify({ api: 1, version, platform, arch, model, dtype: "q8", runtimeVersion, revision: metadata.sha, files: hashes }, null, 2));
  await fsp.mkdir(path.dirname(output), { recursive: true });
  if (platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -Path (Join-Path $env:SCRIBE_PACK_ROOT '*') -DestinationPath $env:SCRIBE_PACK_ZIP"], root, { ...process.env, SCRIBE_PACK_ROOT: root, SCRIBE_PACK_ZIP: output });
  } else await run("zip", ["-q", "-r", output, "."]);
  console.log(`Built ${output}`);
} finally {
  await fsp.rm(temp, { recursive: true, force: true });
}
