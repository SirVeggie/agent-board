# Multiple Claude subscriptions (#452)

Investigated 2026-10-11. This is a feasibility report, not an implementation.

## Finding

Scribe can plausibly support two or three signed-in Claude accounts concurrently by giving each account an independent `CLAUDE_CONFIG_DIR` and setting that environment on each Claude child process. Claude Code explicitly documents this use case. Its authentication documentation says the directory isolates credential files on Windows/Linux and the Keychain entry on macOS, as well as configuration and session history. See [environment variables](https://code.claude.com/docs/en/env-vars) and [credential management](https://code.claude.com/docs/en/authentication).

These are separate subscriptions, not one pooled plan. This investigation establishes the documented mechanism and required Scribe changes; it does not establish that buying multiple Pro accounts is an approved way to multiply one person's allowance. No two-account login or paid request was performed, and existing credentials were not read or modified.

## Current Anthropic guidance

The [SDK subscription support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), updated October 7, 2026, says Agent SDK, headless CLI, and third-party applications can still use subscription limits. It also announces monthly API credits for Max/Team. The [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) still says third-party developers need prior approval to offer claude.ai login/rate limits. These official pages conflict; the dated support update supports continued subscriber use, but does not resolve permission to distribute that feature in a product for others.

The [login guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) prefers API authentication for third-party tools, directs developers building products for others to use API keys, and reserves the ability to charge third-party usage against usage credits. Preserve Scribe's honest SDK client identity; do not disguise traffic. [Consumer terms](https://www.anthropic.com/legal/consumer-terms) prohibit account sharing and bypassing protective measures. The retrieved terms do not explicitly mention multiple accounts. Do not claim a blanket ban or blanket permission for stacking subscriptions; clarify with Anthropic before positioning automatic account rotation as a quota workaround.

For the budget goal, [usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) offer Pro subscribers pay-as-you-go continuation with a monthly spending cap. That gives an intermediate budget without multiple logins; it does not guarantee the same capacity as another Pro allowance. Published [plans](https://support.claude.com/en/articles/11049762-choose-a-claude-plan) include Max 5x and Max 20x, rather than only one Max tier. Local euro checkout totals were not verified.

## What Scribe would need

| Area | Current code | Required change |
| --- | --- | --- |
| Account identity | `src/agent/host.ts` constructs one ClaudeProvider; threads have no Claude account selector | Stable account IDs and local profile directories; retain an explicit legacy/default account for existing threads |
| Login/status | `claude.ts` spawns auth login/status with inherited environment; one auth/login cache | Use the selected profile for login and status, serialize login per profile, verify displayed account identity |
| Queries | Session query uses `process.env`; model discovery, completion and standalone usage queries inherit environment | Pass the same account environment to every query path; never mutate daemon-wide environment |
| Auth precedence | Inherited API keys/tokens/cloud routing can override stored subscription login | Define subscription vs API profiles explicitly; detect overrides and show the effective billing source |
| Sessions/prewarm | One session set and spare pool; `claudeSpareKey` has no account component | Bind a live process to one account, include account in pool keys and caches |
| Usage/recovery | `host.ts` stores limits by ProviderId; Claude fetchPlanUsage returns the first live report | Store limits by account, route reports and reset waits to the originating account; no combined percentage |
| Resume/fork/move | Native session ID plus config-root-dependent transcript paths; `workspaceMove.ts` and `permissions.ts` use a global config root | Persist account with native session ID and propagate its root through resume, fork, permissions, workspace moves and deletion |
| User choice | Provider/model selected for chats, workers and helpers | Select account at thread creation and in worker/helper settings; inherit account deliberately; prevent silent switching on resume |

Use opaque IDs and local metadata in Scribe, leaving credential storage/refresh to Claude Code. Removing an account should stop its processes and retain or explicitly handle affected chat history. Do not copy credential files into the database or git.

## Proposed first implementation

Support manual account selection for new chats and workers, with independent usage display. Keep each existing chat pinned to its original account. Defer automatic fallback and moving an existing native session between profiles; transcript location, settings and memory change with the profile.

Before shipping, verify two independently signed-in profiles using the bundled CLI on Windows (and platform credential isolation on macOS/Linux), including concurrent queries, auth refresh, quota separation, prewarm separation, daemon restart/resume, forks and workspace moves. Unit tests should cover environment construction, migration/default selection, cache keys and per-account wait/recovery. SDK usage fetching is experimental in the existing adapter, so report unavailable usage rather than another account's quota.

## Decision requested

Choose manual multi-account support, an investigation of Pro plus capped usage credits, or retain this report without implementation. Also clarify whether this is for personal local use or a feature distributed to other users, and whether separate new chats/workers meet the need. The linked Scribe form collects these answers and freeform notes.
