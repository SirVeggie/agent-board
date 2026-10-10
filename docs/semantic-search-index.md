# Search index

Semantic search runs only with an installed, enabled search pack. The daemon starts a newest-first background backfill, then listens to page, state, folder and template changes. Page changes debounce for five seconds. Unchanged input hashes reuse vectors; unchanged page snapshots avoid writes entirely. Interrupted backfills resume from stored vectors. A model, dtype or chunker version change clears derived data and rebuilds it.

`search.sqlite` is derived data in the data folder. It is outside the page export format and can be deleted while Scribe is stopped. No embeddings or optional runtime dependencies are included in Scribe's normal install.

Templates declare `search.records` in their JSON. A record supplies `path`, `title`, `text` (including paths such as `comments[].text`), `anchor`, optional `skip` equality filters and a `label` with `{field}` substitutions. `context: "page"` uses only the page title in the embedding's title slot (Todo items); the default includes the record title (Kanban cards). Local copies of built-ins without a declaration inherit the built-in's declaration. Pages without a declaration use HTML heading sections and arrays of objects with ids from state.

Pages under 40 characters of text are skipped, so empty pages do not rank for everything; a page with a declaration is skipped only when none of its records has text (a one-item list is still indexed). Sections target 1,400 characters with a 2,000-character cap; length splits repeat a short final sentence. Long cards separate description/checklist and comments, splitting either further when needed to keep the cap. Page vectors use at most 3,000 characters plus folder context. Index requests contain at most 32 inputs, and the embedder uses real tokenizer lengths to bound padding to 6,000 tokens.

## Images

Image assets are indexed with the pack's vision encoder: the blobs a page's code saves (`pa_…`, such as a kanban card's images) and the files given to `page_show` (`asset:<name>`). PNG, JPEG, GIF, WebP and AVIF up to 20 MB; SVG and icons are left out. Only an image the page's HTML or state refers to is indexed.

- Each image belongs to the text chunk it sits on: the card or item whose record names it, else the heading section whose HTML shows it, else the page. Its row keeps that chunk's key and label.
- Images are embedded one at a time, only while no page waits for its text, and not within three seconds of a search. A search therefore waits behind one image at most (about 1.3 s on CPU). The vision encoder loads with the first image and leaves with the model process after ten idle minutes.
- A page asset never changes, so its id is its hash; a `page_show` file is hashed by its bytes. An unchanged image is not embedded again when its card is edited: only its owner and label are updated.
- An image leaves the index when the page stops referring to it, when the asset is deleted, and with its page. An image that cannot be decoded is skipped until search is switched on again; three failures in a row stop image indexing until then, and `imageError` in the index status says why.
- A text query scores an image `0.5 × image + 0.5 × its owner's text chunk` (the page's vector when the owner has no chunk), and keeps images within 0.04 of the best. An image as the query compares pictures only and keeps those within 0.08.
- Image rows never count as a page's chunks in page or content results.

## HTTP

- `GET /api/search/semantic?q=...&scope=images&limit=1..8` returns image hits: `kind: "image"`, `anchor` (the asset reference), `image` (its URL), `label` (the owner's label), `snippet` (the file name) and `owner` (`kind`, `anchor`, `headingId` of the card, item or section; `null` when the page owns it).
- `POST /api/search/semantic/image?limit=1..8` takes an image's bytes as the body (up to 20 MB) and returns the same hits for the images that look most like it.
- `GET /api/search/semantic?q=...&scope=pages|chunks&limit=1..8` returns `hits` and `index` progress. Each hit has page `id`, `key`, `title`, `folder`, `kind`, `anchor`, `headingId`, `label` and `snippet`. Page results include the best chunk as their reason. Scores stay internal. Invalid input returns 400; an unavailable pack or inference error returns 503. Agent requests use Scribe's existing client header and filter hidden pages before ranking and the relative cutoff.
- `GET /api/search/index/status` returns `enabled`, `indexing`, `indexedPages`, `totalPages`, `chunks` (text only), `pendingPages`, `error`, `images`, `pendingImagePages` and `imageError`. Empty pages count as processed without producing chunks. Search works during a partial backfill.

Page scores use `0.5 page + 0.3 best chunk + 0.2 second-best chunk`; with one chunk it supplies both chunk terms. Content results allow at most three chunks per page. Results stay within 0.08 of the top visible score. The last 50 query vectors are cached.

## Palette

- Normal search (Ctrl+D): word matches show first. For a query of three characters or more, pages found by meaning that are not already listed are appended under a "Related" divider. Rows above and the selection do not move.
- The semantic prefix (default `~`, set under Settings → Palette prefixes) skips the word search: pages by the blended score, then the other matching sections and cards under "Sections and cards".
- A semantic row shows the page, what matched (the section heading or the record's label, such as "#335 Card title") and the snippet.
- Enter on a section hit opens the page at the section: by the heading's `id` when it has one, otherwise by the anchor `scribe-section:N` (the page's Nth h1 to h4), which the page bridge resolves. A card hit opens the page only, until #355.
- The semantic prefix also lists up to four images under "Images": a thumbnail, the page, the owner's label ("#335 Card title") and the file name. Enter opens the page, at the section for a section's image. Normal search shows no image rows.
- Paste an image into the palette, or drop one on it, to search by that image: the rows are the indexed images that look most like it, with their cards. Typing goes back to text search.
- While the index is building, the divider and the prefix's empty state say "indexing N of M pages".
- With search off or no pack, normal search makes no semantic request, and the prefix shows one row that says how to turn it on; Enter on it opens Settings.

## Pack-dependent eval

```powershell
npm run build
npm run eval:search -- --data "C:\path\to\scribe-data"
```

`--pack <data-dir>` takes the pack and its on switch from another data folder, so a library without a pack is evaluated without installing one into it. `--verbose` lists the top five results under each miss.

Enable the pack in Settings → Search first. The script reads a consistent, read-only snapshot of `scribe.sqlite`, indexes into a temporary folder and removes that derived index on completion. It uses the production chunker, embedder and ranking with all 28 prototype queries. These expected page keys and card numbers belong to the original personal library; another library needs its own queries.

The report includes top 1/3/5 counts, MRR, the model child's native process memory high-water mark and sampled daemon memory. Exit status is nonzero below 24/28 in the top three, without memory telemetry, or above the memory guard (4 GiB per process by default, configurable with `--max-rss-gb`). This is an acceptance eval requiring a real pack and that library, not a unit test. Unit tests use synthetic vectors and a fake offline runtime and cannot establish retrieval quality or native model memory.

### Result on the original library (10 October 2026)

127 pages, 1,540 chunks, CPU q8, indexed in 240 s. The model process peaked at 2.5 GB and the daemon side at 0.1 GB (the prototype's fixed batches peaked at 31.7 GB).

| | top 1 | top 3 | top 5 | MRR |
|---|---|---|---|---|
| Prototype, best single vector per page | 16 | 24 | 24 | 0.727 |
| Production, blended page score | 21 | 23 | 24 | 0.797 |

The prototype's 24 came from ranking pages by their best single vector. Its own run of the blend the design chose scored 18 of 20 page queries; production scores 17 of 20, and both find 6 of 8 cards. The five misses:

- Four are the prototype's misses too: the sandbox and Claude/Codex comparison pages (ranks 8 and 6, behind newer pages on the same subjects) and cards #257 and #180 (not among the board's three best cards).
- "small quick models for tagging and labelling cards" ranks its page fifth, where the prototype's blend ranked it third. An earlier design page for the same feature is first. Six other weightings of page, best and second-best chunk left it fifth, so the weights were not changed.

## Image eval

```powershell
npm run build
npm run eval:images -- --data "C:\path\to\scribe-data" --pack "C:\path\to\data-with-pack" --verbose
```

Reads the library read-only, indexes only the pages that hold images into a temporary folder, and compares image weights from 1 (image only) to 0 (owner's text only). It runs the prototype's checks (`tools/semantic-search-proto/images.mjs`: the owner's title as the query, plain descriptions), 20 queries reworded to avoid their card's words (`image-queries.json`, written after seeing the titles, so a sanity check and not a benchmark), and an image query: an 80% crop of each image, scaled to 70% and saved as JPEG, should find the original.

### Result on the original library (10 October 2026)

30 images on 28 cards, CPU q8, 1.24 s an image (2.2 s for the first, which loads the encoder).

Rank of the owner's image among the 30:

| Image weight | Title: top 1 | Title: top 3 | Reworded: top 1 | Reworded: top 3 | Reworded: MRR |
|---|---|---|---|---|---|
| 1 (image only) | 11 of 28 | 19 | 4 of 20 | 7 | 0.364 |
| 0.7 | 24 | 27 | 12 | 18 | 0.743 |
| **0.5 (blended, used)** | **28** | **28** | **16** | **19** | **0.863** |
| 0.3 | 28 | 28 | 17 | 19 | 0.902 |
| 0 (owner's text only) | 28 | 28 | 18 | 20 | 0.933 |

- The blend beats image-only by a wide margin. The title check is circular for any text weight, since the owner's chunk holds its title; the reworded queries are the fairer test.
- On these screenshots the image half adds nothing to a text query: the owner's text alone ranks slightly better than the blend. The pool is 30 app screenshots that look alike, so this says little about photos or diagrams. The weight stays at the design's 0.5 until a library with other kinds of images can be measured.
- Plain descriptions ("a context menu", "error message dialog") still mostly return unrelated screenshots, with or without the blend. All 30 images score 0.62 to 0.72 against any of them, which is why the blended cut-off is 0.04 and the palette shows four at most.
- An image as the query works: the cropped copy found its original first for 28 of 30, with a median lead of 0.105 over the next image. Unrelated screenshots still score about 0.8 against each other, so a pasted image that is not in the library returns loosely similar ones.
