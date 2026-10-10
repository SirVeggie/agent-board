# Semantic search prototype (#350)

The scripts behind the measurements in `docs/semantic-search-design.md`. They open the live `scribe.sqlite` read-only and write nothing to it.

They need `@huggingface/transformers`, which is not a dependency of Scribe. Run them from a scratch folder outside the repo:

```bash
mkdir scratch && cd scratch && npm init -y && npm i @huggingface/transformers@4.3.1
cp <repo>/tools/semantic-search-proto/* .
node build.mjs cpu q8      # chunk and embed the library → index-q8.json, index-q8.bin
node build.mjs dml fp16    # the same on DirectML
node query.mjs q8          # rank queries.json: page vector, whole page, chunks; 768 and 256 dims
node fuse.mjs              # ways to blend page and chunk scores for page results
node images.mjs            # embed image page assets, text → image retrieval
```

The first run downloads the model (314 MB for q8 text, 195 MB for q8 vision).

`build.mjs` batches by a token budget (third argument, default 6000). The CPU timing in the design doc came from an earlier version with fixed batches of 8, which peaked at 31.7 GB of memory on the long whole-page inputs.

`queries.json` names pages and cards of one personal library. Replace it to test another.
