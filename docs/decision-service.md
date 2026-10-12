# Decision service (`src/ml/`)

Card #516, the first piece of the intent-detection design (`docs/intent-detection-hooks-design.md`). One daemon function that asks a classifier small typed questions about a piece of state. Nothing calls it yet; hooks, the page API and the features are later cards.

## Calling it

```ts
import { mlService } from "./ml/service.js";

const result = await mlService().decide(
  "Make me a page that tracks my reading list",      // state: text, an object or an array
  {
    page: { type: "yesno", instructions: "Does answering this need a new Scribe page?" },
    needs: { type: "choice", instructions: "What does the message need?", options: { read: "Only reading", edit: "File edits", shell: null } },
    risk: { type: "score", instructions: "How risky is this?", levels: ["harmless", "needs care", "dangerous"] },
  },
  { feature: "page-intent", sends: ["messages"], timeoutMs: 500 },
);
if (result.ok) result.answers.page;   // { type: "yesno", yes: 0.93 }
```

- `decide` never throws. A failure is `{ ok: false, error, message, ms }` and the caller carries on without an answer. `error` is one of `no_source`, `disabled`, `not_allowed`, `invalid_request`, `input_too_large`, `unauthorized`, `rate_limited`, `busy`, `timeout`, `unavailable`, `invalid_response`.
- Answers come back under the question ids: `{ type: "yesno", yes }` (probability of yes), `{ type: "choice", choice, probabilities, confidence }`, `{ type: "score", score, probabilities, confidence }` (the score is probability-weighted and can fall between levels; 1 is the first). `confidence` comes from the whole distribution and is not the probability of the chosen option.
- Options: `source` (id; the default source otherwise), `feature` (refused with `disabled` while its switch is off), `sends` (what the state holds: `messages`, `agentText`, `toolCalls`, `toolResults`; refused with `not_allowed` when one is switched off in Settings), `timeoutMs` (default 5000, at most 30000; it covers queueing and retries), `cache: false`.
- Limits: 32 questions per call, 120,000 characters of state, 2–255 choice options, 2–10 score levels. At most 4 calls are at a backend at once and 32 more may wait (`busy` beyond that). Identical requests are answered from a cache for 5 minutes (200 entries) and share one call while in flight.
- A feature adds itself to `ML_FEATURES` in `src/ml/settings.ts` (`{ id, label, hint, default }`) and gets its switch in Settings → Classifier.

## Sources

A source is a Jev-API endpoint: name, base URL, API key, model. The adapter (`adapters/jev.ts`) posts `{ model, state, questions }` to `{baseUrl}/v1/systemone` with a Bearer key and retries 429 and 529 twice with backoff (or the server's `Retry-After`). A local source is any server that speaks the same API at another base URL. One source is the default.

Sources and switches are in `ml-settings.json` in the data folder; today's counters in `ml-usage.json`. A key never leaves the daemon: the routes return `hasKey` only, and pointing a source at another host clears its saved key unless a new one is sent with it.

`SCRIBE_FAKE_ML=1` makes the daemon answer from `adapters/fake.ts` (no network), like `SCRIBE_FAKE_AGENTS` for agents. Tests build their own `new MlService({ store: memoryStore(), adapter: fakeAdapter() })`.

## Routes (`/api/ml`, board shell only)

| Route | Does |
|---|---|
| `GET /settings` | `{ sources, defaultSource, features, send, usage }` |
| `PUT /settings` | `{ defaultSource?, features?, send? }`; only what is named changes |
| `POST /sources`, `PUT /sources/:id`, `DELETE /sources/:id` | Add, change (`apiKey: ""` clears the key), remove |
| `POST /sources/:id/test` | One short made-up question through the source; always 200 with a decide result |
| `GET /usage` | Today's `calls`, `cached`, `failed`, `inputTokens`, `outputTokens`, and `latency` (`last`, `median`, `p95` in ms since the daemon started) |

## Latency

Not measured yet against the real API. Every backend call logs `ml decide { source, model, ms, questions, feature, inputTokens }` to the daemon log, and Settings → Classifier shows the last, median and 95th-percentile time, so later cards can set their time budgets from real numbers.
