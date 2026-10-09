# Fast decisions and classification in Scribe

Research for #246, 9 October 2026. Initial design only; no runtime implementation. Replaces the assumptions in the earlier offline proposal. All APIs below labelled **proposed** are Scribe interfaces, not existing features or promises of provider compatibility.

## Recommendation

Start with a small daemon decision service, a direct Jev adapter, and opt-in kanban label and priority suggestions. Expose the same service to custom pages. Evaluate a local Fastino classifier against the same examples before choosing the default backend. Keep extraction, embeddings and reranking as separately advertised capabilities. Do not build all four services before proving the first useful workflow.

Suggested first scope: classify card title and description using board label descriptions, return suggestions, and let the user accept or dismiss them. Do not route workers automatically in this phase: assigning a running worker can launch coding work. Semantic search should be a separate project sharing provider configuration, with Jev optionally evaluated as a reranker.

## What the models actually provide

| Backend | Verified capabilities | Implication for Scribe |
|---|---|---|
| TypeSafe Jev | Text/JSON state plus named typed questions: Choice selects an option, Score returns an expectation over rubric levels, Noul returns a yes probability. Questions run independently against shared state. | Use Choice for one category, separate Noul questions for overlapping labels, and Score for ranking. A result cannot depend on a sibling question in the same call. No free-form titles, summaries, extraction strings or embeddings. [Introduction](https://docs.typesafe.ai/introduction), [API](https://docs.typesafe.ai/api) |
| Fastino GLiNER2.5-Decide | Apache-2.0 classifier; model card describes 340M English model, CPU/GPU inference, runtime label descriptions, single/multi-label decisions. Multilingual Decide is a separate checkpoint. | A concrete local candidate for triage. Its ordinal labels are ordinary classes, not Jev's probability-weighted Score. Evaluate rather than treating it as a drop-in equivalent. [Model card](https://huggingface.co/fastino/GLiNER2.5-Decide) |
| Fastino GLiNER2 base family | Entity extraction, classification, structured records and relations. Original gliner2-base-v1 card describes a 205M CPU-capable model. | Separate extraction adapter can return verbatim text/spans. Advertise only tasks verified for the selected checkpoint. [Base model](https://huggingface.co/fastino/gliner2-base-v1), [maintained library](https://github.com/fastino-ai/GLiNER2) |
| Fastino hosted platform | Official landing page advertises hosted inference, OpenAI/Anthropic-compatible formats and X-API-Key authentication. | Do not reuse Scribe's Bearer-only source adapter unchanged or assume an old Pioneer/TLM endpoint. Detailed docs could not be fetched in this research; hosted GLiNER request/response schema, model availability and pricing remain unverified. [Platform](https://www.gliner2.com/) |
| Generative model fallback | Existing Scribe model sources are a configuration and credential pattern. | A possible separately enabled adapter; structured-output support must be checked per endpoint. Never manufacture calibrated probabilities from generated confidence numbers. |

Jev's official models page currently lists jev-1.13.0 at **$0.042 per million input tokens**, output free. It lists 64k total request tokens and 32k for state plus the longest question, with rates subject to change. Pin versions for evaluated rules and record the resolved model; aliases move. This is dated vendor documentation, not a live account test. [Models and limits](https://docs.typesafe.ai/models)

Illustrative cost: 1,000 calls of 1,000 billable input tokens each would cost $0.042 at that rate; retries and additional criteria increase usage. Network latency, provider queue time and local cold starts determine user experience. The previous proposal's 10–50 ms CPU and 0.5–3 s fallback estimates were not measured and should not be used as product promises.

Jev confidence is derived from its probability distribution and differs from the probability of the selected label. Noul has no separate confidence field. Preserve these meanings; neither GLiNER scores nor LLM self-reported certainty become Jev probabilities by renaming them. Thresholds need Scribe workload evaluation. [Confidence](https://docs.typesafe.ai/confidence)

## Useful workflows

| Area | Input → useful output | Priority and boundary |
|---|---|---|
| Kanban | Title + description → existing label IDs and priority suggestion | First. Multi-label topics; one priority Choice including unspecified. Users retain explicit fields. |
| Todo and notes pages | Item/note text → existing categories or tags | First page API examples. Closed sets work; classifier does not invent titles or rewrite notes. |
| Custom intake tracker | Pasted message → request type; extractor → contact/order fields | Later extraction capability. Validate fields, display original spans and require review for ambiguous values. |
| Library | Page text + folder descriptions → proposed destination | Later. Suggestions only; avoid sending whole library to a remote backend. |
| Search | Query + retrieved chunks → relevance ranking | Separate search phase; useful for MCP and palette. Retrieval precedes judgment. |
| Duplicate cards | Retrieved candidate + new card → same underlying task probability | Later. Pairwise decision after retrieval; a shared topic is not a duplicate. Never merge automatically. |
| Agent tools | Bounded list of records → classification results | Useful for batches, consistent board policies and previewing triage without launching agents. A one-item generic tool is lower value. |
| Chat | Message + short thread context → possible topic mismatch | Later, dismissible hint. Short follow-ups are hard; user can send immediately. |
| Worker/model routing | Task + eligible worker descriptions → routing suggestion | Later, after separate evaluation. Paused workers, claims, WIP, authorization and spend remain deterministic rules. |
| Review comments | Comment → likely question/change/approval intent | At most suggest a button. Classification must not approve or finish cards. |

Due dates require a second operation: identify the date phrase, resolve it using a fixed reference time and Europe/Helsinki or the user's chosen zone, and validate in code. Jev can select among pre-parsed candidates or bounded date components; it cannot produce arbitrary strings. Checklist extraction and thread titles need an extractor/parser or generative model. Jev's own guidance notes literal interpretation, arithmetic/date comparison, option-order and adversarial-input limitations. [Known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## Current Scribe integration points

These findings come from the checked-out repository, not provider documentation:

- `src/agent/openaiSources.ts`: stores source keys on the daemon side in agent.sqlite and exposes only hasKey to the UI. Reuse this pattern, not its OpenAI request/auth contract for every backend.
- `src/bridge.ts`, `src/http.ts`, `src/pagePermissions.ts`: page bridge, daemon routes and per-page grants. There are currently agent.chat, agent.unattended and agent.workspace permissions; ML grants need adding. Agent edits can reset risky grants.
- `src/store.ts:502`: Store.runAction is synchronous and commits action ops atomically. Inference must occur after commit, outside the state transaction.
- `src/actions/kanban.ts:500`: MCP/action create writes cards. `templates/builtin/kanban.html:2030` UI addCard uses scribe.set instead. An action-only hook misses UI creation. Use a daemon post-commit state-change hook, or migrate every creation path first.
- `src/librarySearch.ts`, `src/pageSearch.ts`: lexical title/key/content search; pageSearch also examines state data. Semantic content projection must deliberately include user state and exclude scripts, worker logs and transient forms.
- `src/db.ts`, `src/agent/db.ts`: separate page and agent databases. Persist derived search index/jobs through normal versioned migrations; do not place provider credentials in page state/export.

New modules could live under `src/ml/` (types, provider adapters, service, queue), with route wiring in http.ts and bridge wiring in bridge.ts. This is a proposed structure, not existing files.

## Proposed API and provider contract

Use one decision operation for a state and several independent questions. Classification is a convenience wrapper. Keep extraction separate and do not expose embeddings in the page API until a real page needs them.

```ts
type Question =
  | { kind: 'choice'; instructions: string;
      options: { id: string; description: string }[] }
  | { kind: 'binary'; instructions: string }
  | { kind: 'score'; instructions: string; levels: string[] };

// Proposed page methods; daemon derives page identity from the bridge.
await scribe.ml.capabilities();
await scribe.ml.decide({ state: { title, description }, questions });
await scribe.classify(text, {
  labels: [{ id: 'bug', description: 'A defect in existing behavior' }],
  mode: 'multi'
});
// Only when the selected source advertises extraction:
await scribe.extract(text, { fields: [{ id: 'deadline', kind: 'span' }] });
```

Proposed daemon routes: POST /api/ml/decide, POST /api/ml/extract, GET /api/ml/capabilities. The page cannot choose an arbitrary URL or obtain a provider key. Authenticate page calls through the existing bridge/session mechanism; do not accept a body pageId as authority. MCP tools call the same service using their caller context and return data without modifying cards.

Every answer carries the question ID, type and selected value, optional scores/distribution, score semantics, source ID, requested/resolved model, policy revision, input hash, elapsed time and cache status. Include abstention (`unclassified`) and typed errors: denied, unavailable, unsupported_task, input_too_large, rate_limited, timeout, invalid_response. Model explanations are not a mandatory field because Jev does not generate them.

Capabilities are per source and model: choice, multiLabel, binary, ordinalClass, rubricExpectation, extractionSpans, maximum input, score semantics and language notes. GLiNER ordinalClass does not satisfy rubricExpectation silently. A missing capability rejects the operation unless the user explicitly configured a compatible fallback. A remote fallback never follows a local failure without a remote grant.

For Jev, the adapter sends POST https://api.typesafe.ai/v1/systemone with Bearer auth and {model, state, questions}; maps choice to Choice, binary to Noul, score to Score. Multi-label classification becomes one fully described Noul per label, not a mutually exclusive Choice. Stable Scribe label IDs are options, with human descriptions in criteria. Priority is a Choice over unspecified/low/medium/high/urgent, mapped in code to 0–4; do not round a fractional rubric expectation into a card priority. [Provider API](https://docs.typesafe.ai/api)

For a local Fastino adapter, run one warm Python process behind a loopback-only sidecar, optionally supervised by Keeper. Use a pinned gliner2 package/model revision and an isolated environment; check availability of that release during implementation rather than blindly pairing current main docs with an older wheel. The sidecar declares capabilities and scores; adapt labels/descriptions to classify_text and multi_label for the selected model. It loads weights once, limits requests and offers health/warmup. An offline runtime still needs an initial weight/dependency download. Do not install or start this sidecar as part of this design task. [Library](https://github.com/fastino-ai/GLiNER2)

Service responsibilities: strict request and response validation, bounded text/question/item limits, per-page concurrency and spending budgets, cancellation/deadlines, limited retries with jitter for transient failures, and no retries on invalid requests or denied grants. Cache successes using source/model revision + task/schema + language + policy + input hash, scoped to caller authorization. Changing a grant invalidates access even to cached data. Never cache failures as confident answers or log input text/keys by default.

## Grants and unattended behavior

Off by default. Settings choose sources per capability and show local/remote location. Proposed grants distinguish use of local inference, sending text to a particular remote source, and unattended jobs. A local service still consumes resources. Endpoint/model changes that alter location or data handling require renewed consent.

Enabling board auto-triage is a user gesture where grants are requested up front. Background calls never open repeated permission prompts: missing/revoked grants stop jobs and expose a clear status. Closed-board processing is daemon work under the stored board policy, independent of the current agent thread's web switch. The switch controls that thread's web tools, not permission for all Scribe features.

Pages supply only their intended text projection. An imported page cannot use classification to read other pages or launch agent work. UI content and provider results remain data; validate returned IDs against the current board. A prediction never grants permission or bypasses claims/worker rules.

## Kanban flow and race handling

1. Commit creation immediately. The daemon compares committed card IDs and relevant text fields, scheduling only opted-in eligible boards. Observe UI, MCP, action and import paths. Decide explicitly whether bulk imports are triaged; default to skip old imported cards.
2. Debounce short-lived title/description edits, then enqueue by (page ID, card ID, input hash, label/rule revision, source/model revision). Persist jobs for restart recovery with a lease so two viewers/retries do not duplicate writes.
3. Infer outside the state transaction. Before storing a result, re-read the board and confirm card exists, is eligible, policy/grant is still active, input/taxonomy match, and the job owns its lease. Drop stale answers or schedule a fresh job.
4. Write a narrow suggestion field through Store.writeState ops with test conditions. Avoid replacing the card or writing status/claim/assignee. Suggestions have stable IDs, provenance and accepted/dismissed state; storage is bounded. Suggestion-only writes do not enqueue another job.
5. New template accept/dismiss actions validate current IDs and atomic field conditions. Labels may be added without removing existing labels. Automatic fill, if enabled later, must track whether a user explicitly chose empty labels or priority 0; those values alone do not prove an untouched field.
6. A failed provider leaves a usable card with no suggestion, not a blocked workflow. Rejections inform an evaluation set only when retained intentionally; they do not silently fine-tune Jev or switch providers.

## Semantic search: retrieve, then judge

Jev can rerank query/candidate pairs using Noul relevance judgments; the official cookbook demonstrates this. Thus the earlier categorical claim that a classifier is not useful for semantic search was too strong. It is useful in the ranking stage, but querying every page/chunk on each search scales poorly. [Reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)

Proposed pipeline: eligible content projection → lexical candidates plus embedding candidates → reciprocal rank fusion → optional top-K reranker → page results with chunk snippets. Rank fusion avoids simply adding unrelated lexical and cosine score scales. Evaluate Jev versus a dedicated reranker on Scribe queries; no universal rerank endpoint format is assumed.

Index title and meaningful rendered text plus explicitly selected state fields. Remove scripts/styles, draft forms, worker logs and ephemeral suggestion data. Chunk with stable content hashes. Persist page ID, chunk ID/text hash, projection version, embedding source/model/dimension and vector in a derived SQLite table. Update on HTML AND state changes, deletion, import and eligible scope changes; hide stale/deleted entries immediately. Build a replacement index for new model versions, then switch atomically so incompatible vector spaces are never mixed.

Apply folder/page eligibility before sending chunks to remote inference. Search permission is separate from a page's permission to classify its own input. Start with a bounded brute-force prototype and measure it; no promise that tens of thousands of vectors are cheap enough on every machine. Keep lexical results available while indexing or a backend is unavailable. Add optional semantic mode to library_search/palette only after retrieval-quality and latency evaluation.

## Delivery and evaluation

| Phase | Deliverable | Gate |
|---|---|---|
| 1 | Decision service + Jev adapter + page bridge + kanban suggestions | Grants, validation, all creation paths and race checks; test corpus and UI review. |
| 2 | Local Decide sidecar adapter and comparison | Actual warm/cold latency, RAM, multilingual quality and installation success on the user's hardware. |
| 3 | Extraction for custom intake/todo pages; bounded MCP batch tools | Verified span/schema contracts, date normalization, preview-only batch tools with explicit apply path. |
| 4 | Hybrid search and optional reranker; duplicate suggestions | Measured retrieval recall and ranking gains; privacy scope and indexing lifecycle. |
| Later | Folder, wrong-thread and worker/model suggestions | Each needs its own quality target; automatic worker dispatch remains a separate decision. |

Before choosing a default, compare Jev and local Decide on at least 100 representative cards, including no-label items, overlapping topics, incomplete descriptions, conflicting priorities, Finnish/English and instruction-like text. Report label precision/recall, exact label-set accuracy, priority agreement, abstention and accepted/dismissed suggestions. Use a held-out portion, measure by language, and permute choice order to test stability. Avoid vendor leaderboard claims as evidence of Scribe quality.

Proposed acceptance target for discussion: suggestions within 2 seconds at p95 once warm, no card-create delay, and 90% precision for suggestions displayed. These are product targets, not observed performance; useful recall must be reported too. Automatic application needs a stricter measured threshold chosen with the user. Measure cold start, queue delays, cancellation, retry cost and p50/p95 on actual hardware/network. Integration checks must cover closed boards, two windows, edited/deleted cards, revoked grants, taxonomy changes, restarts, imports, malformed provider answers and intentional empty fields.

No billable model calls, installation, runtime changes or latency/quality benchmarks were performed for this investigation. The next decisions are backend order, initial use cases and suggestion versus automatic application. The linked Scribe page contains a persistent form and freeform field for those choices.
