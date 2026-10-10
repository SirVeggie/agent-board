# Text search index

Semantic search runs only with an installed, enabled search pack. The daemon starts a newest-first background backfill, then listens to page, state, folder and template changes. Page changes debounce for five seconds. Unchanged input hashes reuse vectors; unchanged page snapshots avoid writes entirely. Interrupted backfills resume from stored vectors. A model, dtype or chunker version change clears derived data and rebuilds it.

`search.sqlite` is derived data in the data folder. It is outside the page export format and can be deleted while Scribe is stopped. No embeddings or optional runtime dependencies are included in Scribe's normal install.

Templates declare `search.records` in their JSON. A record supplies `path`, `title`, `text` (including paths such as `comments[].text`), `anchor`, optional `skip` equality filters and a `label` with `{field}` substitutions. `context: "page"` uses only the page title in the embedding's title slot (Todo items); the default includes the record title (Kanban cards). Local copies of built-ins without a declaration inherit the built-in's declaration. Pages without a declaration use HTML heading sections and arrays of objects with ids from state.

Sections target 1,400 characters with a 2,000-character cap; length splits repeat a short final sentence. Long cards separate description/checklist and comments, splitting either further when needed to keep the cap. Page vectors use at most 3,000 characters plus folder context. Index requests contain at most 32 inputs, and the embedder uses real tokenizer lengths to bound padding to 6,000 tokens.

## HTTP

- `GET /api/search/semantic?q=...&scope=pages|chunks&limit=1..8` returns `hits` and `index` progress. Each hit has page `id`, `key`, `title`, `folder`, `kind`, `anchor`, `headingId`, `label` and `snippet`. Page results include the best chunk as their reason. Scores stay internal. Invalid input returns 400; an unavailable pack or inference error returns 503. Agent requests use Scribe's existing client header and filter hidden pages before ranking and the relative cutoff.
- `GET /api/search/index/status` returns `enabled`, `indexing`, `indexedPages`, `totalPages`, `chunks`, `pendingPages` and `error`. Empty pages count as processed without producing chunks. Search works during a partial backfill.

Page scores use `0.5 page + 0.3 best chunk + 0.2 second-best chunk`; with one chunk it supplies both chunk terms. Content results allow at most three chunks per page. Results stay within 0.08 of the top visible score. The last 50 query vectors are cached.

## Pack-dependent eval

```powershell
npm run build
npm run eval:search -- --data "C:\path\to\scribe-data"
```

Enable the pack in Settings → Search first. The script reads a consistent, read-only snapshot of `scribe.sqlite`, indexes into a temporary folder and removes that derived index on completion. It uses the production chunker, embedder and ranking with all 28 prototype queries. These expected page keys and card numbers belong to the original personal library; another library needs its own queries.

The report includes top 1/3/5 counts, MRR, the model child's native process memory high-water mark and sampled daemon memory. Exit status is nonzero below 24/28 in the top three, without memory telemetry, or above the memory guard (4 GiB per process by default, configurable with `--max-rss-gb`). This is an acceptance eval requiring a real pack and that library, not a unit test. Unit tests use synthetic vectors and a fake offline runtime and cannot establish retrieval quality or native model memory.
