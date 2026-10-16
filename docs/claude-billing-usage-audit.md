# Claude billing source and usage visibility audit (#453)

Status 2026-10-16: the user approved all three reporting fixes for personal local
use, with future totals prioritized. Implemented in `8ac9583`; details below.
The findings describe the code as audited on October 11.

Investigated 2026-10-11. Investigation only; no product changes, credential reads,
auth commands, account switching, network quota probes, or model requests. Local
source and installed SDK 0.3.296 types were inspected. Official pages were fetched
on this date. This establishes reporting gaps, not an incorrect charge on any
particular account.

## Findings

### 1. Provider status does not establish a thread's billing source

`src/agent/providers/claude.ts:773` passes `...process.env` into a thread query.
The daemon's keys, tokens, cloud selectors, profile selectors and endpoint
configuration survive. User settings load for all queries; normal chats also
load project/local settings (`:739`). An SDK login does not remove those sources.

The [authentication reference](https://code.claude.com/docs/en/authentication)
documents cloud selection, bearer token, API key, helper, setup-token OAuth,
profile/federation, then saved subscription login as precedence, with gateway
and profile exceptions. In noninteractive mode an environment API key is used
when present. A setup-token authenticates a subscription; a bearer token may
authenticate a proxy, whose downstream billing cannot be inferred from its name.
Named profiles/federation can outrank saved login. Managed policy may instead
block a credential. Exact behavior remains version/settings dependent.

Scribe runs `auth status --json` on the SDK binary without a thread cwd or explicit
query environment (`:107`). Positive results are cached for 60 seconds (`:207`).
Its formatter prefers email over API-key source over non-first-party provider
(`:129`); `authMethod` is accepted but never displayed. This may hide useful source
metadata when fields coexist. Cloud-only results can display a backend, but there
is no structured, thread-specific source attached to a turn.

The installed SDK exposes `Query.accountInfo()` with organization,
subscriptionType, tokenSource, apiKeySource and apiProvider; Scribe does not call
it. These are candidate inputs, not proof of the credit balance charged. Status
from a fresh global process can differ from an existing/warmed query or a thread
loading project auth settings. Do not label email or successful login as proof
that subscription allowances paid for a request.

### 2. Extra-usage spending is confused with current overage use

`src/agent/planLimits.ts:142` accepts `extra_usage`, but retains only utilization
as an Extra usage window. It discards enabled state when utilization is zero,
used_credits, monthly_limit and currency. Null utilization hides paid spend even
when used_credits is nonzero. Installed SDK types (`sdk.d.ts:6296`) describe these
amounts as billing-period spend in currency minor units; they are not a remaining
balance or a current-request billing signal.

The parser sets `overage: true` whenever extra usage is enabled and utilization
is positive. `public/agent.js:7110` then says “Using extra usage”; the settings
heading does the same (`:7271`). Historical spend after included limits reset can
therefore be presented as active paid use. Conversely a zero/null percentage does
not establish that paid use is inactive. The live rate-limit parser (`:43`) does
use `isUsingOverage`, but merges both kinds of report into the same flag.

[Usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)
cover sends beyond included subscription limits when enabled, are charged
separately, and have spend controls. The account Usage dashboard distinguishes
included usage from credit consumption. Scribe does not expose the equivalent
enabled/spend/cap fields or a credit balance.

### 3. Quotas are shared by provider and can remain stale

`src/agent/host.ts:405,516,597` loads and persists one `limits.claude` snapshot.
There is no account, organization, backend or credential identity. A usage read
tries existing sessions first (`claude.ts:428`), else starts a user-settings-only
query (`:445`). A null/unavailable report does not clear the old Claude snapshot
(`host.ts:653`). The frontend looks it up only by provider (`agent.js:6961`).

After auth changes, an API thread can therefore continue to see a previous
subscription meter; the code cannot associate a meter with the current thread's
billing source. This is a code-supported possibility, not a reproduced live
account switch. Some displayed percentages are locally zeroed after reset, rather
than freshly reported by the server. Future account support must namespace quota
state and show unavailable/stale explicitly.

### 4. SDK cumulative estimates are stored as turn totals

`claude.ts:1288` sums result `modelUsage` and forwards `total_cost_usd` directly
to the current turn. `host.ts:3095` stores that usage without computing a delta.
`src/agent/usage.ts:21` then sums all turns for thread/board totals. The installed
SDK types (`sdk.d.ts:5738,5746`) explicitly describe both result fields as running
totals across streaming-input turns, restored on resume/fork and reset by /clear.

The [SDK cost guide](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
confirms these scopes and describes dollar fields as client estimates, not
authoritative billing. Scribe uses long-lived streaming queries, so this is a
scope mismatch for both tokens and cost. Example: results $1 then $1.50 become
turns $1 and $1.50, then a $2.50 thread total, although the latest estimate is
$1.50. Resume baselines and reset/error behavior also need explicit handling.

The footer (`agent.js:3574`) shows plan-window deltas in preference to dollars;
otherwise it shows a bare dollar amount. Neither path identifies credit type or
actual charge. Plan-window deltas can also include usage from other apps sharing
the account. Monetary estimates should remain separate from plan percentages and
paid-credit evidence.

## Three distinct funding paths

| Effective route | What can fund it | What this audit can conclude |
| --- | --- | --- |
| Subscription OAuth or setup-token | Included plan usage, then enabled subscription usage credits | Scribe needs active-query metadata and separate current-overage evidence. |
| Console organization API credential | Monthly API credits, then purchased credits/auto-reload or invoicing | The API key alone cannot identify which balance funded a request. |
| Cloud provider or gateway | Provider/gateway-specific billing | An Anthropic subscription email is insufficient evidence. |

[Monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)
are claimed into a linked Console organization on eligible Max/Team plans. They
are separate from plan allowances and subscription extra usage, and do not cover
cloud-provider requests. API-key SDK runs can use that organization's credits;
plan-login SDK runs still use plan limits. Purchased credits can take over after
monthly credits run out. Scribe has no Console balance read or funding-breakdown
field, so it cannot reliably say “monthly credits” versus “purchased credits.”
Use the account Usage dashboard or Console Billing as appropriate to verify funds.

## Distribution guidance remains unresolved

The [SDK support update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
dated October 7, 2026 says subscription-limit use remains available for SDK,
headless CLI and third-party apps. It also introduces monthly API credits.
The current [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
still requires prior approval for third-party developers offering claude.ai login
or rate limits in their products. User access guidance does not explicitly revoke
that developer requirement. These public pages do not confirm approval for Scribe
distribution. Check whether Scribe already has approval; otherwise seek written
clarification before expanding distributed subscription-login support. No contact
was made as part of this audit.

## Validation and limits

No new tests or runtime changes were added. Offline synthetic inputs were passed
to the actual quota parsers and thread summation function, transpiled in memory
with TypeScript and evaluated without SDK imports or network calls:

- Included utilization 10%, extra enabled, historical spend 2500 cents, cap
  10000 cents, extra utilization 25% -> `overage: true`; spend/currency discarded.
- Same spend with null cap/utilization -> only included window; spend invisible.
- Live event with `isUsingOverage: false` -> no overage flag.
- Stored cumulative fixtures (100 tokens/$1, then 150/$1.50) -> thread summary
  250 tokens/$2.50, demonstrating why upstream totals need deltas.

The initial tsx attempt failed to spawn esbuild under the shell sandbox; the
in-memory TypeScript approach succeeded. This was a tooling restriction, not a
Scribe product issue. No credential values or local account identifiers were read.
These fixtures prove parser/aggregation behavior; they do not reproduce an actual
charge, verify a particular credential combination, or establish vendor approval.

## Proposed follow-ups for a scope decision

1. Show structured source metadata from the active query, with an unknown state;
   distinguish backend, auth method and account. Compare desired subscription
   selection to effective source without exposing secrets. Keep status scoped to
   the query's environment/settings; do not silently change credentials.
2. Preserve extra enabled/spend/cap/currency separately from current overage;
   namespace quotas by account/source and explicitly handle unavailable/stale
   reads. Do not invent a remaining balance or imply a Console credit read exists.
3. Convert cumulative result estimates to turn deltas with resume/fork/reset
   baselines, and label estimates accordingly. Cover multiple turns, reset,
   resumed historical totals, errors with zeroed totals, and subagent usage using
   offline fixtures. Existing historic totals may need a separate repair decision.

For future source tests, use synthetic SDK metadata and captured fixtures with
secrets removed. Actual account tests or paid turns require a separate decision.
The linked Scribe form on #453 recorded the scope decision used below.

## Implementation and validation (2026-10-16)

- Active queries read `accountInfo()` before releasing user input and attach only
  documented backend/auth-source/account metadata to future turn usage. The global
  auth-status formatter also preserves backend/auth-method/key-source metadata
  alongside an email. Neither reports which individual credit balance funded a
  request. Credentials and environment values are never inspected for reporting.
- Thread quota snapshots are isolated in the host by thread/query. A new or closed
  query clears its snapshot; failed and non-subscription reports show unavailable.
  They never fall back to another thread's or the default environment's quota.
  Settings use a separate default-environment read with its own source metadata.
  Previously persisted Claude provider quotas are discarded at daemon startup.
- Extra usage retains enabled state, billing-period spend, cap, currency and its
  observation time, including zero/null utilization. Only a live SDK
  `isUsingOverage` value describes the last request; after five minutes it displays
  unknown. Historical spend cannot set that flag. Expired Claude windows retain
  observed percentages and show stale/awaiting-update states rather than invented
  zero utilization. Console API balances remain explicitly unavailable.
- A read-only `/usage` session baseline is captured on query initialization,
  including resume/fork. SDK result totals become per-turn token/cost deltas;
  context-window capacity is retained as capacity, and SDK child result frames
  cannot independently finish or count a parent turn. Counter decreases on a
  successful result start a new epoch. Zeroed/error regressions leave the prior
  baseline intact. A missing baseline suppresses that first ambiguous total,
  marks accounting partial, and establishes a baseline for following results.
- SDK dollar values now use the existing estimated-cost display and aggregation
  fields. Account-wide quota changes no longer replace Claude turn cost with a
  subscription percentage. Historical stored usage is not rewritten.

Validation: `npx tsc --noEmit`, `node --check public/agent.js`, and
`git diff --check` passed. The focused suite passed 47 tests, including a headless
browser fixture using intercepted local data, with no skips:

```powershell
npx tsx --test --test-isolation=none src/agent/claudeUsage.test.ts src/agent/claudeUsageUi.test.ts src/agent/planLimits.test.ts src/agent/usageWindowStarts.test.ts src/agent/usageWindowRequests.test.ts src/agent/pricing.test.ts src/agent/sparePool.test.ts
```

The shell sandbox blocked the test runner/browser child processes, so the final
suite ran with approved process access. No login, account switching, credential
reads, actual quota probes or paid model turns were used. The SDK usage API is
experimental: unavailable fields remain unknown/partial instead of being inferred.
This reporting implementation does not resolve the separate distribution-approval
question; the user's scope decision was personal local use only.
