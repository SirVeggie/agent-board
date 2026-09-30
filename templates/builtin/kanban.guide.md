# Kanban board: agent guide

Read state with `board_get_state`, change it with `board_set_state` and `expectedRevision`. Write whole top-level keys: to change one card, send the full `cards` array with that card edited. If the write is refused as stale, merge into the returned state and retry.

## State

```
columns: [{ id, title, role?, wip? }]      // array order = board order
labels:  [{ id, name, color }]
cards:   [{ id, num, col, title, description, labels: [labelId], priority,
            due?, assignee?, checklist: [{ id, text, done }],
            comments: [{ id, by, at, text }], images: [{ id, name, data }],
            blockedBy: [cardId], status?, archived?, archivedAt?,
            createdAt, movedAt, doneAt?, seenAt? }]
nextNum: number
lastEvent: { type, cardId, at }            // written by the page just before each signal
view: { q, label, priority, assignee, due } // the user's filter; leave it alone
settings: { hideAddColumn?, showDoneDate? } // the user's page settings; leave them alone
```

- `col` is a column **id**. Order inside a column is the order in `cards`.
- `num` is the card's short number, shown as `#12`; people will refer to cards by it. For a new card use `nextNum` and increase `nextNum` by one.
- `priority`: 0 none, 1 low, 2 medium, 3 high, 4 urgent. `due`: `"YYYY-MM-DD"`. Times are epoch ms.
- `description` is markdown. `#12` links to card 12. `![alt](#img-<image id>)` shows one of the card's images inline.
- Link other board pages in a card's `title`, `description`, or comments: `[[page-key]]` or `[[t_1a2b3c4d]]` shows that page's title, `[[target|text]]` your own text, and `[[peek:target]]` / `[[split:target]]` open it as a peek or beside the board (`[text](peek:target)` works in markdown too). A bare page id links as well. Use keys or ids you created or found with `board_list` / `board_library`; a missing page shows struck through.
- `comments[].by` is `"user"` or `"agent"`. Always add comments with `by: "agent"`.
- `status` is yours: `{ kind: "working" | "blocked" | "info", text }`. It shows on the card; remove it when you finish.
- Leave out fields you don't need; the page fills in ids, `num`, empty arrays and timestamps. Keep `archived` cards; they are the user's archive.
- Images: pass the file in `board_set_state` `assets` and put `data: "asset:<file name>"` in the image entry. The first image is the card's cover.

## Column roles

Match columns by `role`, never by title; the user renames them.

| role | meaning |
|---|---|
| `agent` | Agent inbox. The user drops cards here for you. |
| `working` | Where you move a card while you work on it. |
| `review` | Where you put finished work. The card shows Approve and Request changes. |
| `done` | Complete. Moving a card here: set `doneAt`. |

When you move a card, set `col` and `movedAt`. For a done column, keep an existing `doneAt`; if it has none, set it and put the card first among that column's cards in `cards`, so the newest done work is on top. For any other column, remove `doneAt`.

## Signals

Wait with `board_wait` on any of these. Each one sets `lastEvent.cardId` to the card it concerns.

| signal | fired when |
|---|---|
| `card_ready` | A card entered an `agent` column. |
| `comment` | The user commented on a card. |
| `approved` | The user approved a card in review. It was moved to the first `done` column. |
| `changes` | The user requested changes. Their note is the card's last comment and the card is back in the `agent` column. |

Several events can land while you are busy, so after waking also scan: cards in the `agent` column, and cards with user comments newer than your last one.

## Working a card

1. Claim it: move it to the `working` column, set `assignee: "agent"` and `status: { kind: "working", text: "<what you're doing>" }`.
2. Report progress or ask questions as comments. If you are stuck, set `status.kind` to `"blocked"` with the reason and wait for `comment`.
3. When done, add a summary comment, remove `status`, and move the card to the `review` column (or `done` if the board has no review column).
