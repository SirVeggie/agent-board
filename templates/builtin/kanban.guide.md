# Kanban board: agent guide

Work on this board with `page_action`. Actions read the latest state and apply the board's rules in one step (move and done times, column order, card numbers, who holds a card), so there is nothing to merge or retry. People refer to cards by number: `#12`, passed as `card: 12`.

## Actions

{{actions}}

Columns are named by role (`agent`, `working`, `review`, `done`), id, or title. Match by role: the user renames columns. If several columns share a role (two agent inboxes), `list` includes all of them; `move`, `create`, and `release` need an id or title.

## Working a card

1. Find work: `list` with `column: "agent"` (every agent inbox), then `get` the card you take. To stay in one inbox, pass its id or title. A `list` with no column skips done-role cards (pass `done: true` for those, or `q` to search including them).
2. `claim` it with a short status text. That moves it to the working column and records you as its holder. Another agent's claim makes yours fail: pick a different card.
3. Report progress or ask questions with `comment`. If you are stuck, `update` its `status` to `{ kind: "blocked", text: "<why>" }` and wait for a `comment` event.
   In a Scribe chat, the user's new comments on a card you hold also come into your chat as a `<card_comment>` message, mid-turn when the provider can steer, else right after it. Answer them on the card. On a card whose chat has finished, a comment offers the user **Continue**, which sends that chat a note to get the card again and go on (claim it again while you work). If that chat's worktree branch was merged, it works in a new worktree from the latest base branch (files may have changed since: read them again), and the board merges the branch again when the chat ends.
4. Done: `finish` with a summary (what changed, what to check). The summary is posted as the card's hand-in comment, so do not also `comment` the same wrap-up. If you already did, call `finish` without `summary` and that comment is the hand-in. It moves the card to review, or to done when the board has no review column.
5. Giving up or handing back: `release` with a note.

If your thread fails or is stopped, Scribe moves your card back to the column it was claimed from with a blocked note. If you go quiet for a long time, it marks the card as held by a stale agent so someone can pick it up. While your chat waits on the user (page_ask, a question, an approval), the card you hold shows as blocked on that, and gets its status back once they answer.

## Agent workers

The user can set up a worker for an agent column (its header's start button). While it runs, the board starts a fresh agent chat for each card, with the user's instructions and the card to take, so no chat carries the whole run's context. Its prompt says when it may take a closely related card in the same chat; otherwise it ends its turn and the board starts the next agent, or waits for cards itself. In a worktree, the agent commits and rebases onto the branch it came from before it ends; the board then merges the branch, so the next agent starts from the latest work. If the merge doesn't go through, the board sends you a message in the same chat saying why: rebase, resolve the conflicts, commit, and end your turn without taking another card; the board tries the merge again. If a plan usage limit stops your turn, your card stays yours and the board sends you on in the same chat once the limit resets: check the card and your work so far, then finish it. When the user asks it to stop after its card, `list` shows `stopRequested: true` on the column and the page logs `worker_stop`: take no more cards and end your turn. `worker_step` is the page's own bookkeeping; don't call it.

The user can also run the column's worker on one card from the card's right-click menu. That chat is separate from the column's run: it takes only its card, and the board holds the card for it (a claim with the new thread) until it claims it itself.

## Events

Wait with `page_wait`. Pass the returned `cursor` as `after` next time, so nothing is missed or seen twice. Each event's `data` names the card: `{ card: "<id>", num: 12, column: "<title>", columnId, role }`. Pass `where` to match fields on that data (compared as text), e.g. `{ column: "grok issues" }`, so another agent column does not wake you.

| event | when |
|---|---|
| `card_ready` | The user moved a card into an `agent` column. `data` includes `column` (title), `columnId`, and `role`. |
| `comment` | The user commented on a card. |
| `approved` | The user approved a card in review; it moved to done. |
| `changes` | The user requested changes. Their note is the card's last comment and the card is back in the column it came from. |
| `claim_lost` | Scribe released a card because its agent's thread stopped. |
| `claim_stale` | Scribe flagged a card whose agent went quiet. |
| `worker_stop` | The user asked the column's agent worker to stop once its card is done. `data`: `{ column, columnId, role }`. |

## State

You rarely need raw state; the actions cover the usual work. For anything they don't, read with `page_state` and a `path` (`cards/num=12`) and write with `page_update` ops.

```
columns: [{ id, title, role?, wip? }]       // array order = board order
labels:  [{ id, name, color }]
cards:   [{ id, num, col, title, description, labels: [labelId], priority,
            due?, assignee?, checklist: [{ id, text, done }],
            comments: [{ id, by, at, text }], images: [{ id, name, data }],
            blockedBy: [cardId], status?, claim?, thread?, from?, archived?,
            cover?, createdAt, movedAt, doneAt? }]
nextNum: number
settings: { hideAddColumn?, showDoneDate?,    // the user's page settings; leave them alone
            workers?: { [columnId]: { name?, instructions, context?, provider?, model?, effort?, fast?, mode?,
                                      cwd?, approval?, worktree?, web?, show?,
                                      threadId?, run?, step?, stop?, merge?, error?, solo? } } }  // run..solo: the page's
```

- `description` and comments are markdown. `#12` links to card 12. `![alt](#img-<image id>)` shows one of the card's images inline.
- Link Scribe pages in a title, description, or comment with their key: `[[scribe:some-page]]` shows the page's title, `[[scribe:some-page|text]]` your own text, `[[peek:scribe:some-page]]` / `[[split:…]]` open it as a peek or beside the board, and `[text](scribe:some-page)` works too. Use keys you created or found with `page_list` / `library_search`.
- `priority`: 0 none, 1 low, 2 medium, 3 high, 4 urgent. `due`: `"YYYY-MM-DD"`. Times are epoch ms.
- `thread` is the in-app agent thread that last claimed the card (set by `claim`, kept after `finish`). The card's right-click menu opens it.
- Images: insert into `cards/num=12/images` with `page_update`, pass the file in `assets`, and write `data: "asset:<file name>"`. The first image is the card's cover unless `cover` is `false` (the card dialog's Show cover switch). `get` (and a `page_state` path to one card) attaches those images so you can see them; a whole-board read does not inline every cover.
- `from` is the last agent column the card entered. Sweep, `release` (no `to`), and Request changes send it back there when there is more than one agent column.
- Keep `archived` cards; they are the user's archive.
