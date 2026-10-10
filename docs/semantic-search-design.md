# Semantic search with EmbeddingGemma 2

Design for #350, 10 October 2026, with the decisions of the same day. No runtime code yet. Everything under "Proposed" is a Scribe interface to build, not an existing feature. The measurements come from a prototype run against the live library (read-only); the scripts are in `tools/semantic-search-proto/`.

## Decisions

Answered on the card on 10 October 2026:

| Question | Decision |
|---|---|
| Where the model runs | Built into Scribe through transformers.js, as an **optional pack**. Scribe stays a light install without it. |
| How the pack arrives | First pass: the user downloads a zip and unzips it into the data folder. Downloading from inside the app comes later. |
| Palette | Both: semantic hits under a "Related" divider in normal search, and a prefix for semantic-only search. |
| First build | Pages, sections, kanban cards and images. |
| GPU | CPU only. |
| Agents | `library_search` gets a semantic mode, after the first build. |
| Chat threads | Later, as their own phase. |

In short: index every page as one page vector plus one vector per section, kanban card and list item. Rank pages by a blend of the page vector and its two best chunks. Images are indexed too, scored together with the text of the card or item that owns them, because on this library's screenshots text-to-image retrieval alone was weak.

Build cards: #370 pack and embedder, #371 chunker and index, #372 palette, #373 images, #374 agents and Ask AI.

## The model

From the model card ([onnx-community/embeddinggemma-2-ONNX](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX), released 6 October 2026, Apache 2.0):

| Property | Value |
|---|---|
| Parts | Text 270M, vision encoder 170M, audio encoder 300M. Each encoder loads separately. |
| Output | 768 dimensions, L2-normalized. Matryoshka truncation to 512, 256 or 128, then re-normalize. |
| Context | 8,192 tokens shared by all inputs. An image costs 280 tokens by default (70 to 1120). |
| Prefixes | Query: `task: search result \| query: {query}`. Document: `title: {title} \| text: {content}`, `title: none` without one. Images take no prefix. |
| Sizes (text / vision) | q8 314 MB / 195 MB, fp16 543 MB / 336 MB, q4 175 MB / 109 MB |
| Fidelity to fp32 | q8 0.9997, fp16 0.9998, q4 0.975 (text 0.988), worst-case cosine |
| Benchmarks | MTEB multilingual 61.36 at 768d, 60.41 at 256d, 57.89 at 128d. Multimodal (MMEB v2) 59.01, 56.24, 45.65. |

Runtimes on release: transformers.js (ONNX), Ollama, llama.cpp, LM Studio, sentence-transformers, MLX. Ollama's `270m` tag is text only; `440m` and `740m` take images.

## Measurements

Library at the time: 116 pages, 584k characters of page text, 355 kanban cards (573k characters with comments), 27 PNG page assets, all on kanban cards. Machine: Windows 11, RTX 4090. transformers.js 4.3.1, Node 25.

### Speed

| Step | CPU, q8 | DirectML, fp16 |
|---|---|---|
| Model load (files already on disk) | 8.1 s | 10.2 s |
| Index everything: 1,235 chunks, 514k padded tokens | 261 s (2.0k tokens/s) | 35 s (14.8k tokens/s) |
| One query, warm | 145 to 155 ms | 310 to 340 ms |
| Scan 1,235 vectors at 768d in plain JS | 1 to 2 ms | same |
| One image, vision encoder q8, 280 tokens | 1.3 s | not measured |

The index is 3.8 MB as float32 at 768d.

The first CPU run used fixed batches of 8 and included 64 whole-page inputs of up to about 6,000 tokens. Its process memory peaked at **31.7 GB**. The DirectML run batched by a token budget (at most about 6,000 padded tokens per batch) and peaked at 0.9 GB of process memory. CPU with the token budget was not re-measured.

I did not confirm from a profiler that the `dml` device ran on the GPU; the 7x throughput suggests it did.

### Text retrieval

28 queries written to avoid the words of the page or card they aim at ("dictating tasks by talking" for "Voice todo capture"). 20 aim at a page, 8 at one kanban card. Each has one expected answer, so a near-duplicate ranked above it counts as a miss. I wrote the queries after seeing the titles, so this is a sanity check and not a benchmark.

Page queries (20):

| Ranking | Top 1 | Top 3 | Top 5 | MRR |
|---|---|---|---|---|
| Page vector only (title, folder, first 3,000 characters) | 15 | 16 | 17 | 0.806 |
| Whole page in one 8K-token vector, with the page vector | 15 | 17 | 19 | n/a |
| Best chunk only | 11 | 18 | 18 | 0.735 |
| 0.5 page + 0.5 best chunk | 15 | 18 | 18 | 0.820 |
| **0.5 page + 0.3 best chunk + 0.2 second-best chunk** | **16** | **18** | **18** | **0.854** |

Card queries (8), searching all chunks: the expected card was first for 5, second for 1, and ranked 10 and 21 for the other two. In both misses, closely related content ranked above it: cards #236 and #247 for the tooltip on the glowing icon, and the auto-scroll mockups page for the chat that jumps while typing. Page-level vectors cannot find a card at all: the board's page vector only holds card titles.

All 28 queries, chunks at 256 dimensions instead of 768: top 1 unchanged at 16, top 3 dropped from 24 to 22.

A Finnish query ("missä on ostoslista") found the English shopping list, first by page vector and second by chunks.

What the numbers say:

- Chunks are what make cards and sections findable, and they lift top 3 for pages. On their own they lower top 1 for pages, because one strong section in a related page beats the page that is about the topic. The blend keeps both.
- The whole-page vector costs most of the indexing time and memory and buys little over the page vector. Drop it.
- Scores are not calibrated. Right answers scored 0.63 to 0.83; unrelated chunks still scored 0.60 to 0.70. An empty page titled "New page" scored 0.61 to 0.71 against unrelated queries. There is no absolute cut-off to use.

### Images

27 screenshots attached to kanban cards, vision encoder q8.

- Card title as the query, ranking the 27 screenshots: the card's own screenshot was first for 10 and in the top 3 for 18. The pool is 27 images, so this is an easy test.
- Generic descriptions ("a context menu", "a kanban board with columns", "error message dialog") mostly returned unrelated screenshots.

App screenshots look alike, and a card title describes a problem more than a picture. For this library the text around an image (the card, the file name, the alt text) is the stronger signal. Photos and diagrams may do better; there were none to test.

## Design

### Search pack (proposed)

Scribe gets no new dependencies. The runtime and the model ship as a pack, and all search code is inert until one is installed.

A pack is a zip named `scribe-search-pack-<version>-<platform>-<arch>.zip`:

```text
pack.json                       api, version, platform, arch, model id, dtype, sha256 of each file
node_modules/                   @huggingface/transformers, onnxruntime-node for one platform, sharp
models/onnx-community/embeddinggemma-2-ONNX/
  config.json, tokenizer.json, processor configs
  onnx/model_quantized.onnx(+_data)            text, q8, 314 MB
  onnx/vision_encoder_quantized.onnx(+_data)   vision, q8, 195 MB
```

- It unzips to `<data dir>/packs/search/`. Settings → Search shows that folder with an Open folder button, the pack's status (not installed, ready, wrong version) and the on/off switch.
- `pack.json` carries an `api` number. Scribe refuses a pack whose `api` it does not know, and says which pack version it needs.
- The index records the pack's model and dtype. A pack with another model rebuilds the index.
- Removing search is deleting the folder and `search.sqlite`.
- `tools/build-search-pack.mjs` builds it: install transformers.js in a temp folder, drop `onnxruntime-web` and the other platforms' binaries, fetch the model files, write `pack.json`, zip. Where the zip is published is open (a GitHub release asset would do).
- Later: a Download button in Settings that fetches and unpacks the zip, and a text-only pack (about 435 MB) if the vision encoder turns out not to be worth 195 MB.

Verified with a hand-built pack on Windows: 630 MB unpacked (114 MB runtime, 517 MB model files). A script outside any project imported transformers.js from the pack by file URL and embedded a query with remote models turned off. `onnxruntime-node` is an N-API addon, so the pack is not tied to one Node version. The desktop app's bundled runtime was not tested.

### Runtime (proposed)

- `src/search/embedderChild.ts`: a child process the daemon spawns on first use and stops after 10 minutes idle. It imports transformers.js from the pack (`import(pathToFileURL(...))`), sets `env.allowRemoteModels = false` and `env.localModelPath` to the pack's `models` folder, takes batches over IPC and returns Float32Arrays. A child process keeps about 500 MB of model memory and any native crash out of the daemon.
- Text model `q8` on CPU. The vision encoder loads only when images are indexed or an image is the query.
- No GPU path in the first build. DirectML with `fp16` indexed 7 times faster in the prototype and can be added if the library outgrows CPU.
- Nothing leaves the machine: the pack is offline, and search makes no network calls.
- Interface `Embedder { embedDocuments(items), embedQuery(text), embedImage(bytes) }`, so an HTTP backend (LM Studio, Ollama, llama.cpp) can be added later.

### What gets indexed

Every unit is embedded as `title: {context} | text: {content}`.

| Unit | Title slot | Text | Anchor |
|---|---|---|---|
| Page | Page title | `Folder: {path}.` then the first 3,000 characters of visible text. For a board: its card titles. | none |
| Section | `{page} › {heading}` | Text from one h1 to h4 heading to the next | section index, and the heading's `id` when it has one |
| Kanban card | `{board} › {card title}` | Description, checklist, comments | card number |
| List item | Page title | Item text and description | item id |
| Image (phase 3) | none | The image, 280 tokens | asset id, and the card or item that owns it |

Chunking rules:

- Split page HTML at h1 to h4. Scripts and styles are dropped first.
- Target 1,400 characters, hard cap 2,000 (about 500 tokens). A longer section is split at a sentence end near 1,400.
- A section under 200 characters merges into its neighbour while the result stays under 1,400.
- No overlap between heading sections. When one section is split by length, repeat its last sentence at the start of the next part.
- A card over the cap becomes two chunks: description with checklist, and comments.
- Skip pages with under 40 characters of text, so empty pages stop ranking for everything.
- Skip `workerLog`, `settings`, ids, colours, asset refs and URLs in state (the filters in `src/aiSearch.ts` `stateWords`).

Records in state come from a template declaration, not guessing. Proposed block in a template's json:

```json
"search": {
  "records": [
    { "path": "cards", "skip": { "archived": true }, "title": "title",
      "text": ["description", "checklist[].text", "comments[].text"], "anchor": "num", "label": "#{num} {title}" }
  ]
}
```

Pages without a template get a fallback: each array of objects with ids becomes records, with their string fields joined.

### Storage (proposed)

A separate `search.sqlite` in the data dir. It is derived data: safe to delete, left out of export and backup, and it keeps frequent vector writes out of `scribe.sqlite`.

```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  tab_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- page | section | record | image
  anchor TEXT,                 -- card number, item id, section index, asset id
  label TEXT NOT NULL,         -- heading or "#12 Card title"
  snippet TEXT NOT NULL,       -- first 200 characters, for the result row
  hash TEXT NOT NULL,          -- of the embedded text or image bytes
  vec BLOB NOT NULL            -- float32, 768
);
CREATE INDEX idx_chunks_tab ON chunks(tab_id);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- model, dtype, chunker version
```

Store 768 dimensions as float32. At 3 KB a chunk, 100,000 chunks would be 307 MB. The daemon keeps all vectors in one Float32Array and scans it; no vector index or SQLite extension. If the scan passes about 50 ms, rank on the first 256 dimensions and re-score the top 200 at 768.

### Indexing

- Trigger: the store's `tab_upserted` and state writes, debounced 5 seconds per page.
- Re-chunk the page, hash each chunk, embed only chunks whose hash changed, delete chunks that are gone. A comment on one card of Scribe Todo re-embeds that one card (about 0.2 s on CPU), not the board.
- First run: a background queue, newest pages first, resumable. Search works on a partial index and the palette shows how far it is.
- Batches: sort by length, fill to about 6,000 padded tokens, at most 32 items.
- A page moved to Trash loses its chunks. A change of model, dtype or chunker version rebuilds everything.
- Pages hidden from agents stay indexed and are filtered per viewer at query time, like `listOpenTabs("agent")`.

### Query and ranking

1. Embed `task: search result | query: {text}`. Keep the last 50 query vectors.
2. Score every chunk by dot product.
3. Page results: `0.5 × page + 0.3 × best chunk + 0.2 × second-best chunk`. With one chunk, it counts for both.
4. Content results: chunks by score, at most 3 per page.
5. Cut-off relative to the top hit: keep results within 0.08 of the best score, at most 8. Never show a raw score.
6. Merge with word search: word matches keep their order on top; semantic hits not already listed follow.

Each row's reason is the best chunk: its label and snippet ("#335 Desktop app: dropped files never reach the board"). That comes free, with no LLM call.

The weights and the cut-off are first guesses from 28 queries. Keep the query set as a test fixture and extend it before tuning.

### Where it shows up

- **Palette (Ctrl+D).** Word matches appear at once, as now. About 150 ms later, semantic hits fill in under a "Related" divider. Enter on a section or card hit opens the page at that section or card. A prefix (default `~`, configurable like `=` and `?`) searches by meaning only.
- **Ask AI (`?`).** It sends the 30 chunks closest to the question, each with up to 500 characters of its text: a smaller prompt that sees content deep in a page. A result names the section or card the model picked. With search off, failed, or less than 90% of the pages indexed, it sends the first 300 characters of up to 600 pages, as before (`src/aiSearch.ts`).
- **MCP.** `library_search` takes `mode: "semantic"` and returns chunk hits with their anchors, so an agent can find a card on any board by meaning. `folder` and `limit` (default 10, at most 30) apply. With no word match and search on, the word search's note points to it.
- **Page API.** Not in the first phases (as in `docs/classification-api-design.md`).

### Images

- Index image page assets and `page_show` assets with the vision encoder: 1.3 s each on CPU, on idle.
- An image's score is `0.5 × image vector + 0.5 × its owner's text chunk`, since the text around a screenshot was the better signal here.
- An image as the query (paste a screenshot into the palette) finds similar images and their cards. This needs no text-to-image alignment and should work better than text queries; untested.
- A mixed input (`{card text} <|image|>` in one vector) is supported by the model and untested here.

## Build order

1. **#370 Pack and embedder.** Pack build script, pack detection, embedder process, Settings → Search.
2. **#371 Chunker and index.** Chunker, template `search` declaration, `search.sqlite`, incremental indexing, ranking, HTTP endpoints, eval script.
3. **#372 Palette.** "Related" rows, the semantic prefix, progress and off states.
4. **#373 Images.** Vision encoder, blended image score, image rows, image as the query.
5. **#374 Agents and Ask AI.** `library_search` semantic mode, Ask AI over retrieved chunks.

#372, #373 and #374 each need #371 and are independent of each other. Later: chat threads in the index, duplicate-card hints, related pages on a page's hover card, in-app pack download.

## Gaps in Scribe this depends on

- #355: a link can scroll a page to an element id, but nothing opens a kanban card or list item from outside the page. Card hits need a way to open the page focused on one record.
- #356: `searchLibrary` and `searchPages` strip the HTML and stringify the state of every page on every query. The chunker's extracted text would give them a cache.
