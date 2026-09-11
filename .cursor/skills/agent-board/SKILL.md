---
name: agent-board
description: Present investigation results, analyses, design suggestions, comparisons, and other structured visual HTML on the local Agent Board tab viewer via MCP (board_show, board_list, board_read, board_get_state, board_set_state, board_pin, board_unpin, board_close). Also use for interactive pages whose state you want to read back or update, such as todo lists, checklists, and shared notes.
---

# Agent Board

A localhost tabbed HTML viewer the user keeps open. Drive it with the `agent-board` MCP. Do **not** write one-off HTML files into the workspace for presentation.

If the `board_show` tool is missing, tell the user the Agent Board MCP is not connected (reload MCP / check `~/.cursor/mcp.json`) and fall back to a concise chat summary.

## When to use it

Use the board for standalone visual output: investigation results, analyses, design options, architecture notes, tables that should stay on screen, walkthroughs.

Skip it for code edits, short factual answers, drafts meant to be copied, or when the user asked for a specific other artifact.

Prefer Agent Board over Cursor Canvas and over workspace `.html` files.

## How to present

1. Before writing HTML or calling `board_show`, mention in a new line clearly that the board is being updated so the pause does not look like the chat stopped.
2. Call `board_show` once with:
   - `key`: stable slug for this topic (reuse to update, e.g. `clims-12345-analysis`)
   - `title`: short tab label
   - `html`: a **complete HTML document** with inline CSS, or a fragment (the board wraps fragments in a dark readable template)
   - `activate`: true unless you are updating a background tab
   - `pin`: true only if the tab should survive Clear / close-unpinned
3. Stop there. `board_show` focuses the tab and opens the browser only if nothing is already viewing the board. Do not call a second tool to open or refresh.
4. Mention in chat that it is on the board, with the tab title. Do not paste the HTML into chat.

## HTML

- Self-contained: inline CSS, no workspace assets.
- Full documents start with `<!DOCTYPE html>` or `<html`.
- Keep pages focused. Typical size is well under 200 KB (hard limit 2 MB).
- Do not rely on the parent page's styles; tab content renders in an iframe.

## Interactive pages

Every tab owns a JSON state object stored by the daemon. Use it for anything the user can change — todo lists, checklists, notes, review queues — and you can read back exactly what they did.

**Never use `localStorage` in a board page.** All tab pages share one origin, so it collides across tabs, and you cannot read it.

`window.board` is injected before your page scripts run:

```js
board.state                     // current state, available synchronously
board.set({ todos })            // merge top-level keys, saved on a short debounce
board.onChange(render)          // a remote change arrived; not fired for your own board.set
board.bind(el, "notes")         // two-way bind an input, textarea, or checkbox
board.revision                  // current stateRevision
```

Seed a page's shape with the `state` argument to `board_show`. It applies only when the tab has no state yet, so re-showing a revised page never resets what the user has done.

Rules that keep pages well behaved:

- Bind every text field with `board.bind` rather than wiring inputs by hand. It protects in-flight typing: a remote change to a field the user is inside does not touch their caret.
- In `onChange`, re-render only the parts that changed. Do not rebuild a container that holds a bound field.
- Keep in-progress form input under a `draft` key and never write that key from the agent.
- State is JSON only, 256 KB per tab.

The shape to follow — bind the fields once, render the rest from state, and call `render()` yourself after your own writes:

```js
board.bind(document.getElementById("notes"), "notes");

function items() {
  return Array.isArray(board.state.todos) ? board.state.todos : [];
}

function render() {
  listEl.replaceChildren();          // rebuilds the list only, never the bound fields
  for (const todo of items()) { /* build one row */ }
}

function toggle(id, done) {
  board.set({ todos: items().map((t) => (t.id === id ? { ...t, done } : t)) });
  render();
}

board.onChange(render);
render();
```

## Reading and writing page state

- `board_get_state` (`id` or `key`) returns `state` and `stateRevision`. This is the live truth, whether or not the tab is focused or the browser is open.
- `board_set_state` merges the keys you pass, so send only what you are changing. An open page applies it live without reloading.
- Pass `expectedRevision` from your last read. If the user changed the page in between, the write is refused and the error carries their current state — merge your change into it and retry with the revision it reports. Do not reach for `force`; it exists for deliberately resetting a page.
- Read state before acting on a page the user has had time to touch. Do not assume the state you wrote earlier is still current.

## Updating and cleanup

- `board_list` before guessing ids.
- `board_read` with `id` or `key` to revise existing HTML, then `board_show` with the same `key`.
- `board_pin` / `board_unpin` for a tab (`id`/`key`) so Clear and close-unpinned keep or drop it.
- `board_close` for one tab (`id`/`key`), unpinned tabs (`unpinned: true`), or everything (`all: true`).
- Reuse the same `key` across a conversation instead of opening duplicate tabs for the same topic.
