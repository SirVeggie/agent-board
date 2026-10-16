# Permission ceiling replay, 2026-10-16

Keep automatic lowering **off by default**. The current question and 0.8 threshold conflict
with recorded activity too often in the first real-turn sample. No threshold or question
was tuned on this small sample.

After the user approved reading chats on Scribe Todo and the exact classifier replay,
`npm run replay:ceiling -- --page t_d93be87b --out tools/ceiling-results-2026-10-16.json`
asked the configured H2O Lightning 4B source (`h2o-lightning-4b`, loopback port 10000).
All 40 calls answered, with no failures. The source used 11,255 input tokens; full usage,
question wording and aggregate results are in the JSON report. No messages are committed.

The cohort covers October 4–16: completed Code turns initiated by typed user messages,
excluding helpers, slash commands, automated/card messages, reverted turns and turns
already subject to a ceiling. It contains 33 turns with command activity, 3 with only
read activity and 4 with opaque tools. One turn received a folded steering message;
it is reported separately, leaving 39 turns for threshold comparisons.

| Threshold | Lowered | Known activity among lowered | Conflicts | Conflict share of known lowered |
|---|---:|---:|---:|---:|
| 0.50 | 29 | 25 | 22 | 88% |
| 0.60 | 29 | 25 | 22 | 88% |
| 0.70 | 27 | 23 | 20 | 87% |
| 0.75 | 26 | 22 | 19 | 86% |
| 0.80 | 26 | 22 | 19 | 86% |
| 0.85 | 17 | 13 | 10 | 77% |
| 0.90 | 14 | 10 | 7 | 70% |
| 0.95 | 8 | 5 | 2 | 40% |
| 0.99 | 1 | 1 | 0 | 0% |

At 0.8, 8 turns would start on Ask and 18 on Edits. Four lowered turns have unknown
activity and do not enter the conflict denominator. A conflict means an Ask ceiling
with observed edits or commands, or an Edits ceiling with observed commands. All scored,
unsteered requests completed within the live 500 ms budget at replay concurrency two;
the budget-limited table therefore matches the quality table. This is not a load test.

These are counterfactual Full-access starts, not counted approval clicks. Historical
approval settings are not available per turn. Agents sometimes run commands unnecessarily;
failed commands, denied approvals and read-only shell commands still count as command
activity because the ceiling governs them too. Unknown MCP/code-mode tools are excluded
from known outcomes unless explicit command activity establishes a conflict. File changes
also count even when no edit tool was recorded. Tool attempts are used regardless of success.

This board-scoped sample is small and skewed toward coding follow-ups. It does not establish
a population false-positive rate, and one safe lowering at 0.99 cannot establish safety.
The live question sees only the message's first 4,000 characters, without prior conversation
or attachments; short follow-ups may need that context. A future comparison should include
human-labelled necessary permissions, explicit questions and independent held-out turns.

Keep steered messages subject to the turn's existing ceiling and explicit lift prompt for
now. The single steered sample would have been lowered, but cannot distinguish initial
intent from later work. Automatically raising permissions on steering would need separate
measurement and provider/session synchronization; the current data does not justify it.

No extra Classifier switch was added: the existing Agent switch continues to control the
feature. A per-feature classifier id/log label remains useful observability work if the
feature is developed further; it is not required to run this isolated replay.

The replay opens SQLite read-only, requires a page id to constrain access, respects the
message-sharing switch, uses the production question and `ceilingFrom`, disables caching,
and holds usage counters in memory. `--dry` counts only; `--show N` explicitly opts into
printing message excerpts. `--out` stores aggregate evidence only. Obtain chat-read and
classifier-destination permission for each new corpus before running it.

Validation: four synthetic tests cover nested/denied tools, sample exclusions, steering,
threshold transitions, unknown denominators and live-budget exclusion. Both replay files
pass strict TypeScript checking.
