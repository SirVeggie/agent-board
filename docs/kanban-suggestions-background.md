# Background Kanban suggestions (#537)

Investigation, 2026-10-16. No runtime change made; implementation scope awaits a user decision.

## Related worker fix

#312 is complete. `src/actions/kanbanWorkers.ts` ports the worker loop into the daemon. `ActionSet.drive` returns state operations and optionally a `PageLaunch`; `launched` records its result (`src/actions/types.ts`). `Store.driveActions` visits both open and closed pages (`src/store.ts`). `src/http.ts` schedules this after board state writes (500 ms), ended runs, startup and periodic sweeps. Workers use a persisted step lease so old saved board HTML and the daemon cannot both start a card.

This is useful infrastructure and a concurrency precedent, but it does not run arbitrary background jobs. Its context, permissions, launch callback and outcomes specifically concern agent chats. Classifier work should not be represented as an agent run, nor depend on AgentHost being present (the current sweep returns before driveActions when it is absent).

## What is still missing

`templates/builtin/kanban.html` still owns suggestion scanning, debounce, question construction, inference and result storage. `suggestSeen` is in memory; the first scan deliberately takes stock without classifying. Closing the last board window stops inference and reopening does not catch up. More than eight simultaneous card changes are skipped as bulk work.

`src/ml/page.ts` already offers a daemon-side gate: `PageMl.decide(pageId, grants, body)`, checking the page's `ml.decide` permission and per-page limits. A closed board does not inherently require a new permission system: the worker fix demonstrates checking stored page grants in the daemon. The product decision is whether the existing grant should authorize closed-board classification, or whether users explicitly opt into that expanded behavior. Do not silently bypass the page gate with direct MlService calls.

The shared service cache and in-flight coalescing avoid some duplicate backend calls, but each viewer reaches the page rate gate first. They do not provide durable per-card jobs, restart recovery or ownership of writes.

## Recommendation if closed-board processing is wanted

Reuse the daemon's post-write notification and open/closed page enumeration pattern from #312. Add a separate classifier scheduler, independent of worker run state and AgentHost, rather than generalizing PageLaunch into a classifier call.

1. Explicitly enable background suggestions for a board and require its current `ml.decide` grant. Stop without prompts on revocation or missing classifier configuration. Keep secrets and grants out of exported board state.
2. At successful state commits, detect eligible new cards and title/description changes by stable ID. Persist a bounded pending record with input and policy hashes before inference; suggestion-only writes must not reschedule work. Establish a baseline on migration rather than classifying the whole existing board. Preserve bulk-import suppression.
3. Debounce, lease and process one card at a time through PageMl, with bounded retry/backoff and restart recovery. Hash taxonomy, exclusions and classifier configuration as well as text. Mark successful no-suggestion answers complete too.
4. Before writing, recheck the card text, labels, priority, dismissals, taxonomy, settings, grants and lease. Use conditional narrow state operations on `card.suggest`; never replace the card or alter its actual labels/priority automatically.
5. Reduce the updated template to displaying and accepting/dismissing chips. Account for saved older HTML that still calls the classifier: worker step leases do not protect suggestion calls. Migrate/disable its inference loop or route it into the same deduplicated scheduler before the per-page rate gate. Test customized copies explicitly.

Cover closed boards, UI/action edits, two viewers, restart recovery, stale answers, revocation, changed taxonomy, no-result completion, imports and legacy saved HTML with fake classifier tests. No live inference is necessary for these checks.

## Smaller alternative

Persist a bounded text fingerprint baseline and classify up to ten changed cards when the board next opens. This avoids a daemon job system, but does not provide suggestions while closed, still needs a migration baseline and two-window coordination, and deliberately drops overflow. Existing card timestamps are insufficient: `createdAt` misses edits and `movedAt` tracks moves, not title/description changes.

## Decision

- Implement daemon suggestions: recommended if closed-board coverage is the goal; larger than merely attaching to the worker loop.
- Implement bounded catch-up on open: cheaper, eventual coverage with a stated cap.
- Keep the current behavior: acceptable if closed-board suggestions have little value.

#289 overlaps the post-commit detection and deduplication work and should be resolved alongside a daemon implementation, rather than creating another competing hook.
