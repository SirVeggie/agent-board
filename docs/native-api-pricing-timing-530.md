# Native pricing timing investigation (#530)

Reviewed 2026-10-12 against the installed Pi 1.0.3 packages and the official sources below. Implementation: `src/agent/tariffs.ts`, `pricing.ts`, `providers/pi.ts`; decision form: [Scribe evidence](scribe:native-api-pricing-timing-530). Follow-up #549 awaits evidence/direction before automatic tariff selection.

## What Pi exposes

- `pi-coding-agent/dist/core/sdk.js` connects extension `before_provider_request` to `onPayload`, and `after_provider_response` to `onResponse`. The payload event has no request/attempt ID; extension context supplies the current model.
- `pi-ai/dist/api/openai-completions.js` constructs the assistant message timestamp before the payload hook, then wraps the HTTP call in `retryProviderRequest`. `onResponse` and stream `start` happen after a successful response. `pi-agent-core/dist/agent-loop.js` emits assistant `message_start` from this stream event, or from a final failure when no partial stream was returned.
- `pi-ai/dist/utils/provider-retry.js` repeats the HTTP call without invoking `onPayload` again. Transport retries default to zero; `retry.provider.maxRetries` can enable them. A mocked transport test verifies payload → failed fetch → successful fetch → response with `maxRetries: 1`.
- `pi-coding-agent/dist/core/agent-session.js` also retries failed logical calls and emits `auto_retry_start`. These can produce distinct assistant messages; they are not a complete HTTP attempt ledger. Failed messages with no returned billable usage remain unpriced, while returned usage is retained.
- Capture only numeric timing observations, never payloads, headers, keys or bodies. Each message consumes its current observation; a duplicate message cannot charge twice or consume the next observation. Unmatched models remain unknown.

These hooks cannot prove the actual send time for every attempt. This implementation therefore retains catalog estimates with unresolved tariff status rather than selecting rates using turn start, assistant timestamp or response time. A future transport hook must correlate dispatch/end/usage to stable attempt IDs, without global fetch interception or mutation of shared model prices.

## Provider evidence and calendar

The [official DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing/) was fetched directly on the review date. It supplies peak/off-peak rates, UTC windows and exceptions for weekends/Chinese public holidays, including the legacy Flash aliases. It does not identify a billing timestamp for boundary-spanning requests, explicitly name the holiday/weekend date timezone, or specify which adjusted holiday ranges count for billing.

The [Haidian government reproduction of State Council notice No. 7](https://en.bjhd.gov.cn/workinginhaidian/supportingservices/publicholidays/202512/t20251211_4797062.shtml) supplies the complete announced 2026 holiday ranges and adjusted working days (notice dated 2025-11-04). The bundle covers 2026-01-01 through 2027-01-01, end excluded. It includes announced holiday ranges and leaves Saturdays/Sundays off-peak, including adjusted working weekends. Asia/Shanghai date interpretation is explicitly tentative; this is government calendar evidence, not confirmation that DeepSeek uses it for billing.

No arbitrary-page scraper or network refresh runs in the product. Applicability begins on the review date and expires at the start of 2027 as a bundled review policy, not a claim about DeepSeek's publication/effective date. Verification and applicability stay separate. Manual fixed prices suppress tariff evidence/discounts; explicit Unknown suppresses estimation.

## Persisted decisions and practical limits

New assistant-message records contain pre-payload/response-header observations when available, completion time, unavailable attempt timing, an embedded reviewed profile/calendar, the observed schedule under tentative calendar semantics, boundary flags and unresolved reasons. Boundary detection checks intervening transitions even if the endpoints share a window. Missing/expired applicability and incomplete calendar coverage are explicit. Diagnostic lower/upper candidate totals are recorded only when both complete rate tables apply to all billed categories; they do not replace the selected catalog cost or claim invoice bounds.

Catalog fallback retains catalog freshness Unknown. The reviewed tariff date is displayed separately in cost details, with a 30-day review reminder. Unresolved reasons set `costPartial`, which existing thread/helper/Harness/board totals propagate. No historical records are automatically annotated or repriced. Individual transport failures without visible message usage remain outside this ledger; complete attempt accounting is the follow-up.

Validation covers exact endpoints/aliases, UTC window edges, tentative holiday date edges, adjusted working weekends, expired profile/calendar coverage, intervening boundaries, candidate calculations, immutable decisions, fixed override precedence, deduplication, independent messages, transport retries and existing usage aggregation.
