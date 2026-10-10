# Optional search pack

Scribe has no model/runtime dependency. Without a pack, search by meaning is off and no embedder process starts. This first stage provides the runtime; indexing and search results follow in #371 and #372.

Build on the OS and architecture that will use the pack (Windows, macOS or Linux; x64 or arm64):

```bash
node tools/build-search-pack.mjs
```

The build needs npm, internet access to npm and Hugging Face, and `zip` on macOS/Linux (Windows uses PowerShell). It installs transformers.js 4.3.1 into a temporary folder, keeps that machine's native runtime and sharp binaries, and downloads only the q8 text and vision models, supporting configurations and license files. Model downloads use one immutable revision. It runs offline text and image inference before hashing the files and writing the zip. It never changes Scribe's node_modules or dependencies. An optional first argument chooses the output zip path; an existing file is refused.

Unzip the zip's contents directly into the folder shown in **Settings → Search** (`<data dir>/packs/search`). `pack.json` must be directly inside that folder, beside `models` and `node_modules`. Open Settings again to refresh detection, then switch **Search by meaning** on. The preference is saved in `search-settings.json` in the data folder and defaults to off.

Detection checks API 1, platform/architecture, model/dtype and the presence of all manifest files. SHA-256 hashes are provided for distribution verification; Settings does not hash hundreds of megabytes each time it opens. An incompatible or incomplete pack cannot be enabled.

The daemon's `searchEmbedder` exposes `embedQuery(text)`, `embedDocuments([{ title?, text }])` and `embedImage(bytes)`, returning Float32Array vectors over advanced IPC serialization. It starts on first use, uses CPU q8 and local models only, loads vision when first needed, and exits after ten minutes with no pending requests. Text inputs are measured with the tokenizer, sorted into batches of at most 32 items and 6,000 padded tokens, then restored to input order. A single input is truncated to 6,000 tokens. Turning search off, daemon shutdown and loss of the IPC parent stop the process; later enabled calls restart it. Failed requests reject without crashing the daemon.

Run fake-runtime tests without downloads:

```bash
npm run test:search
```

Release validation still requires building the full pack and trying it with the desktop app's bundled Node runtime on each distributed platform.
