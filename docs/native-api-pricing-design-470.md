# Native API pricing design (#470)

Status: proposal; no runtime implementation. Decision form and investigation: [#470 API pricing design](scribe:native-api-pricing-470). Investigated 2026-10-12.

## Current behavior and evidence

- `src/agent/openaiSources.ts`: `OpenAISource` stores endpoint, credentials, model IDs and reasoning support; no prices. Settings live in `openai.sources`. `normalizeSource` reconstructs saved fields, so adding a UI field alone would lose it.
- `src/agent/providers/pi.ts:72`: `sourceModelCost` trusts an exact official DeepSeek origin and supported paths, maps known legacy Flash aliases, and copies Pi catalog prices. Other sources receive all-zero SDK prices as an unknown-price sentinel. Keep the endpoint guard: a proxy using the same model ID can charge different rates.
- `pi.ts:267`: prices are registered as static model metadata. `pi.ts:1024`: assistant message usage accumulates into a turn, copying a truthy SDK cost total. Known free calls and unknown prices are indistinguishable; one turn may contain many API requests.
- `src/agent/types.ts`: `Usage.costUsd` has no origin or rate snapshot. `usage.ts`, `harness.ts`, `actions/kanban.ts`, `public/agent.js`, and `public/harness.js` consume this number. Historical turns already store their number rather than recalculating it; retain that behavior.
- Harness aggregation additionally treats missing costs as zero without coverage information. Logged separately as #528 in design; coordinate that work with this proposal.

## Provider evidence and limits

[DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) lists prices per million tokens. Off-peak is half peak; peak runs Monday–Friday, 01:00–04:00 and 06:00–10:00 UTC, excluding Chinese public holidays. Weekends and holidays are off-peak throughout. Known legacy Flash aliases use the current Flash price.

This was verified through the official page's indexed search result (crawl reported two weeks old); direct page fetches timed out. This is evidence for the design, not a live rate refresh. Do not mark prices verified today on that basis. No numeric tariff table is copied into this proposal.

The retrieved text does not specify the billing timestamp for requests spanning a boundary, the holiday date timezone, or the source of a complete holiday calendar. Those details require confirmation before an automatic tariff is advertised as fully resolved. Request dispatch time is a proposed estimate convention, not an asserted DeepSeek billing rule.

## Model-source settings

Add a Pricing section per source with one entry per exact model ID (including discovered IDs and IDs containing slashes). Price identity is source ID + normalized endpoint identity + exact model ID; a model name match across endpoints is insufficient. Built-in models use provider + model ID.

Each entry chooses Automatic, Custom fixed prices, or Unknown. Automatic uses an eligible provider tariff, then a compatible catalog rate with its limitations visible. Unknown explicitly disables estimation. Custom replaces the entire rate set: never combine half a custom table with half a changing catalog table.

Custom fields use USD per 1M tokens: uncached input, output, cache read and cache write. Input/output are required; cache prices can be blank if unsupported. Blank means unknown for usage in that category; zero means a known free category. Reject negative, non-finite, nonnumeric and unreasonable precision values server-side. Store validated decimal strings (up to nine decimal places); use decimal/integer arithmetic and round only at display time. Optional reference URL and note explain the rate. Save user edit time separately from a user-confirmed verification time.

Removing an override explicitly restores Automatic. Omitting pricing in an older client's update preserves existing pricing. Preserve overrides when refreshing the discovered model list; show orphaned entries so users can remove them deliberately. Endpoint changes invalidate overrides until reconfirmed, since they may refer to another vendor. Names and API key changes alone do not change pricing identity. Custom fixed prices suppress provider tariff discounts; label that choice clearly.

V1 supports fixed custom rates and reviewed provider tariff profiles. A general user-authored calendar/rules editor is deferred; it adds conflict, timezone and holiday semantics beyond the useful initial UI.

## Rates, freshness and resolution

Use an immutable versioned rate record with ID, origin (`custom`, `provider-tariff`, `catalog`), provider/source and model match, endpoint identity, currency/unit, rates, effective-from/to, reference, verified-at when genuinely known, catalog version, and tariff/calendar version when applicable. Refresh time and publication/effective time are different fields.

Recommended first release: ship reviewed tariff profiles and holiday data with the app; allow editing fixed overrides. Do not scrape arbitrary pages or silently mutate custom entries. Catalog freshness without a verification date is Unknown, even when its package is recent. Proposed review reminder: 30 days since verification; show older/unknown rates without preventing API calls. Freshness is advisory; a stale rate can still produce an explicitly stale estimate. Expired applicability or an unmatched model produces unknown pricing, not a current catalog substitution disguised as the same tariff.

For an automatic request estimate resolve: exact custom entry, explicit Unknown, eligible provider profile valid at dispatch, then compatible catalog. A provider profile declaring a model/time unsupported must carry that uncertainty into any catalog fallback. Unknown endpoints never inherit another vendor's tariff solely by model ID. Provider-reported USD cost, if the adapter actually supplies it for that request, takes precedence over the estimate; retain the estimate as audit evidence without adding both.

## Time-dependent tariffs

Represent schedules as effective-dated profiles with weekday windows, explicit IANA timezone, half-open intervals `[start, end)`, named rate sets, and a versioned holiday calendar with coverage dates and source. DeepSeek windows use UTC with no local-machine DST conversion. Proposed holiday date interpretation is Asia/Shanghai, subject to provider confirmation; weekends remain off-peak even when China declares a substitute working weekend.

Resolve separately for every billable request, including subsequent tool-loop calls and retries. Capture dispatch time and the selected immutable rate record before sending, not when a model is first listed or when a turn completes. Snapshot source settings at the start of a user turn, so edits take effect on the next turn; still select the applicable schedule for each request's dispatch. Never mutate shared Pi model prices to switch tariffs: concurrent sessions can need different rates.

If holiday coverage is absent, applicability is ambiguous, or the request crosses a boundary with an undocumented billing convention, flag uncertainty. Where valid candidate rate sets exist, retain lower/upper estimates and use the upper value as a conservative displayed estimate with explanation. With no defensible candidates, leave cost unknown. Never assume a holiday calendar extends beyond its coverage. Historical records retain the calendar decision used then, even if later corrected.

Implementation must first establish a Pi request-level dispatch/response hook, including automatic retries. `message_start` alone is not proof that an HTTP request was dispatched. If the SDK cannot expose enough request information, persist catalog estimates with Unknown tariff status and defer automatic tariff claims; do not approximate all calls using turn start time.

## Recorded usage contract

Add an append-only request cost ledger to turn usage (or a dedicated table linked by turn ID). Each record contains stable request/attempt identity, dispatch/end timestamps, source/provider, requested and returned model, billable normalized token categories, rate snapshot, selected tariff/calendar and freshness at dispatch, estimate and optional bounds, optional provider-reported amount, selected amount/origin, and missing/uncertain reasons. Do not store API keys or credential-bearing URLs. Rate IDs alone are insufficient: embed a snapshot or reference an immutable persisted row that survives source deletion and catalog replacement.

Normalize token categories before pricing: input here excludes cache read/write; output includes billed reasoning when the adapter reports it as part of output. Do not add reasoning twice. If an endpoint omits cache attribution, record the assumption or an unknown component rather than treating missing information as zero. Cost is the sum of disjoint billed token categories times their rates divided by 1M.

Deduplicate request records on repeated events. Retry failures without returned billable usage remain unknown; do not invent chargeable tokens. Retain usage actually returned on failed/cancelled calls. Host usage events are cumulative snapshots, so replace the current snapshot rather than summing it again. Audit retention follows the turn's normal lifecycle.

Retain `costUsd` as the selected known subtotal for existing readers, including explicit zero. Add reported/estimated/legacy subtotals, priced and unpriced request counts, uncertainty reasons and `costPartial`. Estimated is a provenance label, independent of completeness: a fully estimated turn need not be partial. Legacy costs with no origin remain `legacy-unknown`; never claim they were provider-reported. Legacy turns with no cost stay unpriced. Never automatically backfill or reprice old turns using today's rates. A future what-if comparison must be separate from recorded usage.

## Display and propagation

| Condition | Display |
| --- | --- |
| All amounts supplied by an adapter's provider-cost field | Provider-reported $… |
| All amounts estimated | Estimated $… |
| Both origins | Cost $… with reported/estimated split |
| Known subtotal plus unpriced requests | Partial $…; missing count |
| No priced requests | Cost unknown |
| Explicit free rates with complete usage | Estimated $0.00 |
| Old cost with no provenance | Recorded $…; origin unavailable |

Details show the rate per category, source/reference, verification date or Unknown, request timestamp, tariff decision, uncertainty and actual snapshot used. Provider-reported does not promise an invoice or include taxes/credits. No-cost subscription turns remain unknown rather than receiving an API estimate from their model name.

Propagate these fields through main/helper thread totals, Harness filters and rows, Kanban action sanitization and default templates. Keep costs and coverage scoped to the same filtered turn set. Older saved board HTML may discard new fields: daemon/action readers must preserve them where supported and describe older views' limitation without relabelling history. Read the `ui-help-text` skill before implementing settings hints or tooltips.

## Implementation slices and acceptance

1. Fixed overrides, validation, immutable request records, known-zero handling and legacy migration; surface estimated/reported/unknown origins throughout usage consumers.
2. Reviewed DeepSeek profile and versioned holiday coverage, after verifying the SDK hook and unresolved provider conventions. No remote scraping dependency.
3. Optional automatic rate refresh and general custom schedules only after a separate design decision. Persist last valid data atomically; network failure cannot block an inference call or alter old usage.

Required tests at implementation: override precedence and clearing; blank vs zero; invalid prices; older-client save; endpoint changes; discovered/slashed model IDs; official endpoint vs proxy; weekday start/end boundaries; lunch gap; weekends including substitute workdays; holidays near UTC/local midnight; unknown/out-of-range calendar; effective-date changes; boundary-crossing calls; multiple requests in one turn; retry/dedup/cancellation; model switch and concurrent sessions; token cache/reasoning normalization; stale/unknown verification; source deletion; historical stability after rate refresh; reported cost replacing rather than adding to an estimate; all-unknown, partial and mixed-origin main/helper/Harness/board totals.

## Decisions for the user

Recommend fixed overrides and cost provenance first, then reviewed DeepSeek tariff support once request hooks and provider timing/calendar conventions are verified. Choose this sequence or request the combined implementation. Also choose reviewed bundled updates (recommended initially) or a separately designed automatic refresh. The Scribe form includes a freeform field for rate-unit, reminder or display preferences.
