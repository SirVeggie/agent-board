# Thread search performance investigation (#602)

Investigated on 2026-10-13 after #595 and #603. This branch adds a reproducible
synthetic benchmark and this report; it does not change runtime search or migrate
the user's database. The decision form and report are in Scribe at
`scribe:thread-search-performance-602`.

## Recommendation

Use a dedicated search worker with its own database connection, then add a
normalized searchable-text projection and a selective substring index. Keep a
complete scan fallback for short and very common terms. Fix request sequencing
and cache invalidation alongside that work. Treat responsiveness and query speed
as separate goals: a worker protects chat/daemon responsiveness even when a query
still takes hundreds of milliseconds; an index reduces the work for selective
queries. Neither alone solves everything.

Do not copy the current SQL LIKE predicate onto an FTS table and assume it is
indexed. SQLite documents that LIKE with ESCAPE cannot use the trigram index.
The benchmark instead uses quoted MATCH phrases on JS-lowercased text with a
case-sensitive trigram tokenizer, then the existing message matcher verifies hits.

## Current costs and behavior

- `src/agent/db.ts:137`: synchronous leading-wildcard LIKE scans whole item JSON;
  it extracts text and excludes tool/thinking, dropped and subagent items. JSON
  metadata can create candidates: `x` matches the property name `text`.
- `src/agent/host.ts:2464` and `src/agent/routes.ts:340`: the scan and snippet
  matching happen synchronously in the request handler. They occupy the daemon's
  JavaScript thread. Making the handler async alone will not move that work.
- `src/agent/threadSearch.ts:39`: matching accumulates words across messages,
  retaining the earliest message with the largest number of matched query words.
  It already skips later text processing once the best possible snippet is found.
- `public/agent.js:1069`: 180 ms debounce, eight cached queries, 30-second TTL.
  Cancel currently resolves a pending debounce promise; it does not abort an
  in-flight request or stop a database scan. In-flight completions set `last`
  without checking whether their query is still current. There is no message
  revision invalidation of the cache in the current source.
- #603 already improved title ranking/filtering from roughly 15–23 ms to 6–7 ms
  on 10,000 synthetic titles. Database work is the next priority.

## Reproduction and measurements

Run `node --import tsx tools/bench-thread-search-options.ts [message-count]`.
Default: 50,000 messages in 1,000 threads, roughly 2 KB of text each, including
tool/dropped/subagent rows, metadata-only candidates and cross-message terms.
43,459 eligible messages remain. It creates a fresh disposable synthetic database
and never opens real history. Every approach uses the production `matchMessages`
function and asserts complete equality against an exhaustive text scan, including
hit words, ordering and snippets. The fixture includes punctuation, quoted text,
literal wildcard characters, backslashes, non-ASCII case and emoji.

Node v25.2.1 / SQLite 3.50.4 on this machine. Each query has two warmups and seven
timed runs. Figures are medians in ms, with OS caches warmed by repeated queries;
SQLite retains its default connection cache settings. Timings include SQL,
iteration and snippet matching, excluding the 180 ms debounce, network, rendering,
index construction and initial memory loading. Synthetic results are not a
measurement of the user's real corpus or cold-start latency.

| Query | Current JSON | Extract text in SQL | Stored normalized text | Trigram + short scan | In-memory text scan |
|---|---:|---:|---:|---:|---:|
| `llama.cpp h2o` | 301.99 | 352.86 | 251.86 | 9.71 | 24.19 |
| `x` | 250.35 | 213.36 | 177.19 | 162.93 | 18.46 |
| `h2` | 174.69 | 241.97 | 184.47 | 177.55 | 24.81 |
| `project` | 237.79 | 247.38 | 266.91 | 466.77 | 16.37 |
| `missingneedle` | 158.69 | 260.62 | 184.26 | 0.03 | 35.22 |
| `splitneedle otherneedle` | 306.05 | 393.49 | 252.22 | 25.11 | 80.35 |
| `x llama.cpp` | 252.89 | 290.67 | 269.33 | 187.00 | 20.22 |

The `x` query yields 43,459 candidates from current JSON, versus 434 from extracted
or projected text. That removal of false candidates does not remove linear scan
cost. Selective long queries improve by about 12–33x with this trigram prototype; common
terms can regress, and a mixed short/long query still needs the short-term scan.

The synthetic base database uses 197.52 MiB of logical pages. The projection
adds 191.72 MiB because this prototype stores both original and normalized text;
the external-content positional trigram index adds another 98.61 MiB. Projection
backfill took 5.90 seconds and index rebuild 5.74 seconds on the recorded run
(an earlier run took 1.39 / 3.24 seconds, illustrating machine-load variability).
These are one-off
prototype costs, not estimates of production startup or streaming-write overhead.
The repeated filler text and simple distributions also limit generalization.

## Approaches and tradeoffs

1. **Extract text inside the existing SQL query.** Smallest change; removes JSON
   metadata false candidates, but repeated JSON parsing and substring scans remain.
   Measurements do not justify promising a speed improvement. A generated or
   materialized text column avoids repeated extraction; an ordinary B-tree cannot
   index arbitrary `contains` searches. Useful groundwork, not the final speed fix.
2. **Normalized text table.** Materialize only eligible main user/assistant text,
   with item id, thread id, sequence and JS-lowercased text. This removes per-query
   JSON parsing and normalizes Unicode consistently. Still linear for scans.
   A production projection can store normalized text once and fetch original text
   for selected snippets, reducing this prototype's duplication at an unmeasured
   retrieval cost. Changes must track edits, drop flags, parent tool changes,
   deletion and streaming updates transactionally.
3. **SQLite FTS5 trigram index.** Preserves arbitrary substring search within
   technical names, unlike ordinary word/prefix FTS. Excellent for selective long
   terms. Shorter than three Unicode characters cannot use trigram MATCH, so retain
   a fallback. Use candidate-count thresholds to switch common terms to a scan,
   rather than always retrieving tens of thousands of indexed rows. Measure the
   threshold on diverse corpora. Consider indexing per-thread documents to reduce
   candidate count, then verify individual messages for snippets and boundary
   false positives; this variation was not benchmarked.
4. **Resident text cache in a worker.** This fixture gives 16–80 ms scans without
   repeated SQLite decoding. It retains about 90 MB of raw eligible UTF-8 text,
   plus JS string/object overhead (actual heap/RSS not measured), and requires
   loading and updating that cache. Better short-query responsiveness may justify
   it on typical histories, but use a memory budget and fall back to disk. Do not
   load all transcripts into the daemon's existing main-thread item cache.
5. **Character/bigram postings.** Can avoid full scans for selective one/two-character
   queries. Extra storage, update work and bespoke code; ubiquitous characters still
   match most threads. Thread-level postings or compact bitsets are worth evaluating
   only if measured short-query latency remains unacceptable. Not benchmarked here.
6. **Worker scheduling, coalescing and revision cache.** Complement every backend.
   Keep at most one active job and the newest pending query, deduplicate identical
   requests across viewers, tag results with query id and corpus revision, and
   discard obsolete completions. Aborting HTTP alone does not cancel synchronous
   SQLite work; cooperative chunking can stop between chunks, or let the current
   worker job finish and replace its queued successor. A revision cache avoids
   repeating queries without hiding edits for a fixed TTL. These benefits were not
   timed by this benchmark.

## Semantics and rollout requirements

- Preserve #603's ranking, stopword behavior, fuzzy titles and single-character
  support. Do not replace substring matching with word-only/prefix-only FTS.
- Retrieve the union of message candidates for query words, not their intersection
  in each message. A thread can accumulate terms across different messages and
  title/message combinations. A naive row LIMIT can miss higher-ranked threads.
- Verify against JS `toLowerCase().includes()` and preserve earliest-best snippets.
  Lowercase with the same JS normalization on insertion and query preparation;
  escape MATCH quotes, preserve punctuation, and fallback on unsupported inputs.
- Backfill off the daemon thread, record a corpus/index version, and keep current
  search available until the new projection/index catches up. Updates and deletion
  must keep the index consistent; streaming text should be batched, with its current
  eligible text available before final indexing. Include recovery/rebuild tests.
- Validate on multiple synthetic sizes and diverse text distributions, then a
  separately authorized real-history comparison. Measure p50/p95 query latency,
  keystroke-to-result latency, daemon event-loop delay under concurrent chats,
  cold start, disk/RAM use, backfill, and incremental streaming-write overhead.
  Proposed targets: daemon delay below 20 ms, warm selective lookup below 50 ms,
  and bounded short/common-query work. These are acceptance proposals, not results.

## Decision

Recommended first implementation: worker isolation/request freshness plus normalized
text and trigram candidates, retaining complete short/common-term scans. Measure
before adding a full resident cache or custom short-term postings. Existing design
card #605 tracks the database limitation; #602 remains in Needs input because this
is an investigation without runtime implementation.

Full recorded timings, maximums and candidate counts are in
`docs/thread-search-performance-602.jsonl`. All 13 queries × five approaches passed
equivalence assertions on the final 50,000-message run. Repository TypeScript
checking also passed. Design card #607 records request/cache freshness separately.

Primary reference: [SQLite FTS5: trigram tokenizer](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)
(short terms, ESCAPE limitations and index consistency). The benchmark exercises
the tokenizer in this installation rather than assuming its availability.
