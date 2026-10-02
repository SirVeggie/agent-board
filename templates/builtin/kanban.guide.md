# Kanban board: agent guide

A board's state is often tens of KB, so work on single cards: read with `page_state` and a `path`, change with `page_update` `ops`. Don't send the whole `cards` array to change one card.

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
- Link other board pages in a card's `title`, `description`, or comments: `[[page-key]]` or `[[t_1a2b3c4d]]` shows that page's title, `[[target|text]]` your own text, and `[[peek:target]]` / `[[split:target]]` open it as a peek or beside the board (`[text](peek:target)` works in markdown too). A bare page id links as well. Use keys or ids you created or found with `page_list` / `library_search`; a missing page shows struck through.
- `comments[].by` is `"user"` or `"agent"`. Always add comments with `by: "agent"`.
- `status` is yours: `{ kind: "working" | "blocked" | "info", text }`. It shows on the card; remove it when you finish.
- Leave out fields you don't need; the page fills in ids, `num`, empty arrays and timestamps. Keep `archived` cards; they are the user's archive.
- Images: pass the file in `page_update` `assets` and put `data: "asset:<file name>"` in the image entry. The first image is the card's cover.

## Reading and changing cards

Paths pick a card by `num` or `id`: `cards/num=12`, `cards/c_ab12`. A few read patterns:

```
page_state({ key, path: "columns" })                         // column ids and roles
page_state({ key, path: "cards/num=12" })                    // one card
page_state({ key, path: "cards", where: { col: "<agent column id>" } })  // a column's cards
```

Change cards with `ops`. They apply to the latest state, so another agent's or the user's change to a different card does not conflict, and you don't need `expectedRevision`. The ops in one call apply together or not at all.

```
// Claim #12
ops: [
  { op: "merge", path: "cards/num=12", value: { col: "<working id>", movedAt: <now>, assignee: "agent",
      status: { kind: "working", text: "Fixing the export" } } },
  { op: "move", path: "cards/num=12", before: "col=<working id>" }
]

// Comment on it
ops: [{ op: "insert", path: "cards/num=12/comments", value: { id: "cm_<unique>", by: "agent", at: <now>, text: "..." } }]

// Finish it: no status (null removes a field), into done, first in that column
ops: [
  { op: "merge", path: "cards/num=12", value: { status: null, col: "<done id>", movedAt: <now>, doneAt: <now> } },
  { op: "move", path: "cards/num=12", before: "col=<done id>" }
]

// New card: read nextNum first
ops: [
  { op: "insert", path: "cards", value: { id: "c_<unique>", num: 52, col: "<column id>", title: "...", createdAt: <now>, movedAt: <now> },
    before: "col=<column id>" },
  { op: "set", path: "nextNum", value: 53 }
]
```

`before: "col=<id>"` places the card above the first card in that column, or at the end of `cards` when the column is empty. Use it so a moved card lands at the top of its new column. When creating a card, pass `expectedRevision` from the read that gave you `nextNum` (`page_state({ key, path: "nextNum" })`), so two agents can't take the same number. On a conflict, read `nextNum` again and retry.

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

Wait with `page_wait` on any of these. Each one sets `lastEvent.cardId` to the card it concerns.

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
