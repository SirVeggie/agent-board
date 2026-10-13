# Five-hour window pre-triggering (#552)

Investigated 2026-10-12; implemented 2026-10-13 after the user's confirmation.
No live model requests or account changes were made during development.

## Implementation and user confirmation

The user confirmed on #552 that the five-hour period starts on first usage after
reset, and chose the scheduler for both providers, ten minutes after reset. Their
account's actual reported limits take precedence over the general pricing page
quoted below; the earlier Pro statement was too broad for this account.

Agent settings > Plan usage now has separate Claude (Haiku) and Codex (Luna)
switches, off by default. The daemon checks every 30 seconds, sends at most once
per provider-reported reset after ten minutes, persists that attempt before
sending, and refreshes quota afterwards. Last result appears with plan usage.
It never schedules from Claude's locally projected countdown. A later server
reset permits another cycle; wake/restart makes one current decision, with no
replay of missed periods. Missing quota is polled again without sending.

The scheduler skips active provider work and unavailable or exhausted included
usage. Claude checks account metadata and usage on the active query before
releasing its input; API-key and cloud sources are rejected. It uses Haiku with
tools, settings sources and thinking disabled, a minimal system instruction and
an isolated temporary cwd. Codex selects an available Luna model, copies only
the managed auth file into an isolated temporary home, verifies ChatGPT included
usage, removes API-key/base-URL environment overrides, and disables shell,
web, apps, multi-agent, hooks, memories and goals. A read-only temporary cwd has
no workspace instructions. Provider-built-in instructions/overhead may remain.
Any managed token refresh is synchronized back before the temporary home is
removed. No fallback model or funding source is used.

Disabling a switch or stopping Scribe aborts an in-flight send. Requests have a
60-second cancellation deadline; failures are not retried for the same reset.
The result says "Sent", rather than claiming a new server window was proven.
Runtime provider behavior still needs observation on the user's accounts; the
automated tests use offline doubles, including the actual request methods.

## What is established

- [Claude usage limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)
  describes five-hour session and weekly limits shared across Claude surfaces.
- [Claude Max](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)
  explicitly says the weekly reset is fixed regardless of when usage starts.
  These pages do not specify precisely how an idle five-hour session is anchored
  or whether a minimal Haiku request starts the same session used by other models.
- [Official Codex pricing](https://learn.chatgpt.com/docs/pricing) describes
  five-hour periods for Plus and Standard Business, shared local/cloud allowances,
  and possible weekly limits. At investigation time it states Pro has no five-hour
  limit. It does not document an API to start a window or guarantee an idle-window
  start rule. Luna is listed as a lower-usage option, not a window-start mechanism.

The proposed benefit is plausible *if* a request anchors an idle session: a ping
at 09:00 followed by work at 12:00 could put the reset at 14:00 instead of 17:00.
This example is conditional, not verified provider behavior. It shifts timing;
it does not increase the allowance per window or remove weekly limits. Starting
near a reset can also lose unused allowance sooner.

## Current Scribe behavior

- `src/agent/planLimits.ts`: `applyExpiredWindows` zeros expired Claude windows
  and `nextResetAfter` advances their timestamps by fixed five-hour/week periods.
  This local projection is not evidence that a server session has started. Codex
  snapshots explicitly bypass that projection.
- `src/agent/host.ts`: Claude refreshes quota with `fetchPlanUsage` after reset;
  Codex uses `readRateLimits`. These reads do not send model messages. The Claude
  refresh path applies the local projection both before and after the read.
- `src/agent/providers/claude.ts`: `complete` uses a tools-free, one-turn query
  with no settings sources and no session persistence. That is a useful starting
  point for a probe, but tools-free does not establish subscription-only billing
  or zero provider/system context. The existing billing investigation (#453)
  documents why provider login status alone does not prove a request's source.

## Recommended next step: bounded verification

Choose the provider/account and a known expired or inactive five-hour session.
Read fresh provider quota before sending one tools-free request, asking for only
"hi", on a user-selected available Haiku or Luna model. Read quota afterwards
and record server timestamps and the effective request source. Do not use the
projected UI countdown as evidence. Observe the next idle reset too; one initial
request cannot prove repeated-cycle behavior. Use account dashboards if provider
reports are missing or ambiguous. No automatic retries or recurring traffic in
this first experiment.

## Concrete scheduler proposal, if verification supports it

- Off by default; separate Claude and Codex switches. Run only while Scribe's
  daemon is alive. Select an available cheap model explicitly; no costly fallback.
- Base each attempt on a fresh, provider-reported five-hour reset and verified
  subscription source. Skip unknown source, missing quota, unsupported plans,
  exhausted applicable weekly limits, and ongoing provider work.
- At most one attempt per observed expired window, persisted across restarts and
  protected against overlapping attempts. On wake, make one fresh decision;
  never replay missed periods. Failure stops that cycle rather than retrying.
- Send no thread/page/workspace context, tools, project instructions, or attached
  files; enforce cancellation and a short deadline. Provider system overhead is
  unavoidable. Do not fall back to API/paid-credit funding.
- Refresh quota after success. Schedule another attempt only from a newly
  observed server reset; if none appears, show an unverified outcome and stop.
- Expose last attempt/result and a disable switch. Measure window movement rather
  than labeling successful text generation as a successful window start.

## Decision history

The original investigation could not establish the premise from documentation
alone. The user subsequently confirmed it and chose the scheduler for both
providers. #554 tracks the projected Claude countdown separately.
