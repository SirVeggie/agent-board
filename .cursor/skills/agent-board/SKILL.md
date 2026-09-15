---
name: agent-board
description: Present investigation results, analyses, design suggestions, comparisons, and other structured visual HTML on the local Agent Board tab viewer via MCP (board_show, board_screenshot, board_list, board_read, board_get_state, board_set_state, board_wait, board_pin, board_unpin, board_close). Also use for interactive pages whose state you want to read back or wait on, such as todo lists, checklists, reviews, and forms; and for testing visual designs by showing HTML and screenshotting it.
---

# Agent Board

A localhost tabbed HTML viewer the user keeps open. Drive it with the `agent-board` MCP. Do **not** write one-off HTML files into the workspace for presentation.

If the `board_show` tool is missing, tell the user the Agent Board MCP is not connected (reload MCP / check `~/.cursor/mcp.json`) and fall back to a concise chat summary.

## When to use it

Use the board for standalone visual output: investigation results, analyses, design options, architecture notes, tables that should stay on screen, walkthroughs. Use it to **test visual designs** too: show HTML, screenshot it, inspect the image, and revise — the board is the design surface, `board_screenshot` is how you see it.

Skip it for code edits, short factual answers, drafts meant to be copied, or when the user asked for a specific other artifact.

Prefer Agent Board over Cursor Canvas and over workspace `.html` files.

## How to present

1. Before writing HTML or calling `board_show`, mention in a new line clearly that the board is being updated so the pause does not look like the chat stopped.
2. Call `board_show` once with:
   - `key`: stable slug for this topic (reuse to update, e.g. `issue-12345-analysis`)
   - `title`: short tab label
   - `html`: a **complete HTML document** with inline CSS, or a fragment (the board wraps fragments in a dark readable template)
   - `assets`: omit unless the page needs images. Pass local file paths (user attachments) and reference them as `asset:name` in the HTML — see Images below.
   - `activate`: true (default) when the user should look at this tab. Use `background: true` instead when you are iterating privately (design screenshot loops) or updating a tab the user is not on. Do not pass `background: true` together with `activate: true`.
   - `pin`: omit or false. Pin only when the user hints the tab should persist (e.g. “long lived tab”, keep it between sessions) or the page is a keep-using interactive app (todo app, reusable tool). Do **not** pin one-off investigations, designs, info dumps, questionnaires, demos, or forms — even if you expect to read the answers later in this chat.
3. `board_show` focuses the tab and opens the browser only if nothing is already viewing the board, unless you passed `background: true` (or `activate: false`) — then it does not switch tabs or raise the window. Do not call a second tool to open or refresh.
4. If the page asks the user to do something you must continue from — submit, choose, confirm, finish a checklist — call `board_wait` **next, in the same turn**, with the same signal name the page fires. Do not poll `board_get_state`.
5. Mention in chat that it is on the board, with the tab title. Do not paste the HTML into chat.

## HTML

- Self-contained: inline CSS. Do not link workspace files as `<img src="./foo.png">` or `file://` — those do not load.
- Full documents start with `<!DOCTYPE html>` or `<html`.
- Keep pages focused. Typical size is well under 200 KB (hard limit 2 MB). Images passed via `assets` do not count toward that cap.
- Do not rely on the parent page's styles; tab content renders in an iframe.

## Images

User-provided image files (chat attachments, local paths) go on a page through `assets` on `board_show`. Reference them as `asset:<name>`:

```
board_show({
  key: "mockup",
  title: "Mockup",
  assets: [{ path: "C:/Users/me/Pictures/hero.png", name: "hero.png" }],
  html: `<img src="asset:hero.png" alt="Hero">`
})
```

`assets` may also be a list of paths. The name is then the file's basename (`photo.png` → `asset:photo.png`). Prefer passing `name` when the filename is long, has spaces, or you want a short slug.

Rules:

- Use `asset:name`. Do not use `file://`, a workspace-relative path, or a base64 data URI for user photos.
- png, jpg, gif, webp, svg, ico, avif. 8 MB each, 16 per tab, 32 MB total.
- Re-showing the same `key` without `assets` keeps images already attached. The same `name` replaces that file.
- The tool result lists the attached names — use those in `src`.

## Visual feedback

Use `board_screenshot` when you need to **see** a page — layout, spacing, type, color — not just read its HTML. The tool returns an image. Look at that image, then revise.

Loop:

1. `board_show` with the same `key`, `background: true` (so the tab does not steal focus).
2. `board_screenshot` with that `key`. Default is a 1280×800 viewport of the page.
3. Inspect the image. Change the HTML (or `board_set_state`), then `board_show` again with `background: true` and screenshot again.

```
board_show({ key: "hero", title: "Hero", html, background: true })
board_screenshot({ key: "hero" })
board_screenshot({ key: "hero", selector: ".hero" })   // one component
board_screenshot({ key: "hero", fullPage: true })      // tall page; height is capped
```

Rules:

- Always `background: true` on `board_show` in this loop unless the user should look at the tab right now.
- Identify the tab by the same `key` (or `id`) you used in `board_show`.
- `selector` is a CSS selector; it captures the first match. If it is missing or not visible, the tool errors — fix the markup or selector, do not retry blindly.
- After `board_set_state`, screenshot again without re-showing HTML. The capture loads current HTML + state from the daemon.
- The image is a canonical viewport, not the user's window size, zoom, or currently focused tab. Inactive / hidden board tabs still screenshot correctly.
- Do not pin design-test pages. Do not write the HTML to a workspace file.
- If `board_screenshot` is missing, the Agent Board MCP is on an old build — tell the user to reload MCP after rebuilding the daemon.

When you are done iterating and the user should see the result, `board_show` once more **without** `background` so the tab comes to the front.

## Interactive pages

Every tab owns a JSON state object stored by the daemon. Use it for anything the user can change — todo lists, checklists, notes, review queues — and you can read back exactly what they did.

**Never use `localStorage` in a board page.** All tab pages share one origin, so it collides across tabs, and you cannot read it.

`window.board` is injected before your page scripts run:

```js
board.state                     // current state, available synchronously
board.set({ todos })            // merge top-level keys, saved on a short debounce
board.signal("submitted")       // wake board_wait; flushes pending board.set first
board.onChange(render)          // a remote change arrived; not fired for your own board.set
board.bind(el, "notes")         // two-way bind an input, textarea, or checkbox
board.revision                  // current stateRevision
```

Declarative wake-ups (do **not** also call `board.signal` in the same click):

```html
<button type="button" data-board-signal="submitted">Submit</button>
<form data-board-signal="submitted">...</form>
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

## Waiting for user input

`board_wait` is a single blocked call. The page fires a **named signal** when the thing you care about happens; you wait for that name. Typing, `board.set`, and `board.bind` do **not** wake you.

Handshake:

1. Pick a short signal name (`submitted`, `chosen`, `all_done`, `approved`).
2. The page fires that name when the condition is met — `data-board-signal="submitted"` or `board.signal("submitted")`.
3. `board_show` the page (this clears any previous signal on that tab).
4. `board_wait` with the same `key` and `signal`. Use the returned `state`; do not follow with `board_get_state` unless you need a later read.

`board.signal` flushes pending `board.set` in the same request, so the wait result includes what the user just saved.

Do **not** signal on every keystroke, bind, or `onChange`. Do **not** wait for `stateRevision` to change.

### After the wait

- `timedOut: true` — tell the user you are still waiting, then call `board_wait` again with the **same** `afterSignalRevision` you used (omit / `0` if this was the first wait after `board_show`).
- `closed: true` — the tab was closed; stop.
- `signal` is set — continue from `state`. Branch on `signal.name` when you waited for more than one outcome.

Waiting again on the **same** page without `board_show`: pass `afterSignalRevision` = the previous `signal.revision`, or you instantly get the old signal. After a new `board_show`, omit it.

Default timeout is 10 minutes (maximum 10 minutes). Never poll `board_get_state` in a loop.

### Patterns

Submit a form (bound fields are already in state):

```html
<button type="button" data-board-signal="submitted">Submit</button>
```

```
board_wait({ key: "review", signal: "submitted" })
```

Choice buttons — save the value, then signal. Use `type="button"` and **either** `data-board-signal` **or** `board.signal`, not both:

```html
<button type="button" onclick="pick('a')">Option A</button>
<button type="button" onclick="pick('b')">Option B</button>
<script>
function pick(id) {
  board.set({ choice: id });
  board.signal("chosen");
}
</script>
```

```
board_wait({ key: "options", signal: "chosen" })
```

Different outcomes:

```html
<button type="button" data-board-signal="approved">Approve</button>
<button type="button" data-board-signal="rejected">Reject</button>
```

```
board_wait({ key: "pr-review", signal: "approved,rejected" })
```

Then branch on the returned `signal.name`.

All todos checked — signal from the condition, not from each toggle:

```js
function toggle(id, done) {
  const todos = items().map((t) => (t.id === id ? { ...t, done } : t));
  board.set({ todos });
  render();
  if (todos.length && todos.every((t) => t.done)) {
    board.signal("all_done");
  }
}
```

```
board_wait({ key: "todos", signal: "all_done" })
```

Keyboard (Ctrl/Cmd+Enter):

```js
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  board.signal("submitted");
});
```

## Reading and writing page state

- `board_get_state` (`id` or `key`) returns `state`, `stateRevision`, and the last `signal`. Use it when you are **not** blocked on the user (they said “look at my notes”). Do not poll it.
- `board_set_state` merges the keys you pass, so send only what you are changing. An open page applies it live without reloading.
- Pass `expectedRevision` from your last read. If the user changed the page in between, the write is refused and the error carries their current state — merge your change into it and retry with the revision it reports. Do not reach for `force`; it exists for deliberately resetting a page.
- Read state before acting on a page the user has had time to touch. Do not assume the state you wrote earlier is still current.

## Updating and cleanup

- `board_list` before guessing ids.
- `board_read` with `id` or `key` to revise existing HTML, then `board_show` with the same `key`. For visual QA, follow with `board_screenshot` instead of guessing from the markup.
- `board_pin` / `board_unpin` for a tab (`id`/`key`) so Clear and close-unpinned keep or drop it. Same rule as `board_show` `pin`: only after a persistence hint or for a keep-using app — never because a one-off page feels useful.
- `board_close` for one tab (`id`/`key`), unpinned tabs (`unpinned: true`), or everything (`all: true`).
- Reuse the same `key` across a conversation instead of opening duplicate tabs for the same topic.
