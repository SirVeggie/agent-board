# Kanban board: agent guide

Work on this board with `page_action`. Actions read the latest state and apply the board's rules in one step (move and done times, column order, card numbers, who holds a card), so there is nothing to merge or retry. People refer to cards by number: `#12`, passed as `card: 12`.

## Actions

{{actions}}

Columns are named by role (`agent`, `working`, `review`, `done`), id, or title. Match by role: the user renames columns.

## Working a card

1. Find work: `list` with `column: "agent"`, then `get` the card you take.
2. `claim` it with a short status text. That moves it to the working column and records you as its holder. Another agent's claim makes yours fail: pick a different card.
3. Report progress or ask questions with `comment`. If you are stuck, `update` its `status` to `{ kind: "blocked", text: "<why>" }` and wait for a `comment` event.
4. Done: `finish` with a summary (what changed, what to check). The summary is posted as the card's hand-in comment, so do not also `comment` the same wrap-up. If you already did, call `finish` without `summary` and that comment is the hand-in. It moves the card to review, or to done when the board has no review column.
5. Giving up or handing back: `release` with a note.

If your thread fails or is stopped, Scribe moves your card back to the agent column with a blocked note. If you go quiet for a long time, it marks the card as held by a stale agent so someone can pick it up.

## Events

Wait with `page_wait`. Pass the returned `cursor` as `after` next time, so nothing is missed or seen twice. Each event's `data` names the card: `{ card: "<id>", num: 12 }`.

| event | when |
|---|---|
| `card_ready` | The user moved a card into an `agent` column. |
| `comment` | The user commented on a card. |
| `approved` | The user approved a card in review; it moved to done. |
| `changes` | The user requested changes. Their note is the card's last comment and the card is back in the agent column. |
| `claim_lost` | Scribe released a card because its agent's thread stopped. |
| `claim_stale` | Scribe flagged a card whose agent went quiet. |

## State

You rarely need raw state; the actions cover the usual work. For anything they don't, read with `page_state` and a `path` (`cards/num=12`) and write with `page_update` ops.

```
columns: [{ id, title, role?, wip? }]       // array order = board order
labels:  [{ id, name, color }]
cards:   [{ id, num, col, title, description, labels: [labelId], priority,
            due?, assignee?, checklist: [{ id, text, done }],
            comments: [{ id, by, at, text }], images: [{ id, name, data }],
            blockedBy: [cardId], status?, claim?, archived?,
            createdAt, movedAt, doneAt? }]
nextNum: number
settings: { hideAddColumn?, showDoneDate? }  // the user's page settings; leave them alone
```

- `description` and comments are markdown. `#12` links to card 12. `![alt](#img-<image id>)` shows one of the card's images inline.
- Link Scribe pages in a title, description, or comment with their key: `[[scribe:some-page]]` shows the page's title, `[[scribe:some-page|text]]` your own text, `[[peek:scribe:some-page]]` / `[[split:…]]` open it as a peek or beside the board, and `[text](scribe:some-page)` works too. Use keys you created or found with `page_list` / `library_search`.
- `priority`: 0 none, 1 low, 2 medium, 3 high, 4 urgent. `due`: `"YYYY-MM-DD"`. Times are epoch ms.
- Images: insert into `cards/num=12/images` with `page_update`, pass the file in `assets`, and write `data: "asset:<file name>"`. The first image is the card's cover.
- Keep `archived` cards; they are the user's archive.
