---
name: agent-board
description: Present investigation results, analyses, design suggestions, comparisons, and other structured visual HTML on the local Agent Board tab viewer via MCP (board_show, board_patch, board_screenshot, board_list, board_archive, board_restore, board_read, board_get_state, board_set_state, board_wait, board_pin, board_unpin, board_close). Also use for interactive pages whose state you want to read back or wait on, such as todo lists, checklists, reviews, and forms. Use board_screenshot only when iterating on a UI design meant for the current project, never to polish throwaway information pages.
---

# Agent Board

A localhost tabbed HTML viewer the user keeps open. Drive it with the `agent-board` MCP. Do **not** write one-off HTML files into the workspace for presentation.

If `board_show` is missing, the MCP is not connected — tell the user to reload MCP / check `~/.cursor/mcp.json`, and fall back to a concise chat summary.

If `board_list` exists but `board_archive` or `board_patch` does not, the MCP is stale. Tell the user to reload MCP. Do not invent keys or skip the archive.

## When to use it

Use the board for standalone visual output: investigation results, analyses, design options, architecture notes, tables that should stay on screen, walkthroughs. Put those pages up and stop — do not screenshot them to tweak layout or type.

Use `board_screenshot` only when the page **is** the design work for this project (a UI mock, layout, or component the user asked you to design or implement). Then the board is the design surface and the screenshot is how you see it.

Skip the board for code edits, short factual answers, drafts meant to be copied, or when the user asked for a specific other artifact.

After a page is up, answer small follow-up questions in chat. Do not patch or re-show the page for a clarification, a yes/no, a short extra fact, or anything that does not need to stay on the board. Update the page when the user asked to change it, or when the new material is substantial enough to belong there.

Prefer Agent Board over Cursor Canvas and over workspace `.html` files.

## Find a page

The user names pages by **title** (“my Jira issues page”). Keys are slugs you invented earlier. Never guess a key.

**By title** (usual):

1. `board_list` — every **open** tab. Each row has `id`, `key`, **`title`**. Scan titles.
2. If it is not there and `archiveCount` > 0, `board_archive` (no query: newest first, default 20, max 50; if `remaining` > 0, pass `offset`).

**By content** (body or JSON state, or the title scan missed it): call `board_list({ query })` and `board_archive({ query })` **in the same turn** with the same keywords. They do not search each other’s tabs.

Then `board_read` with that `id` or `key` when you need the HTML (works on archived tabs without restoring). Prefer `board_patch` over rewriting what you read.

**Search keywords.** Use 1–3 distinctive words (`jira`, `clims-18595`, a phrase from the page or its state). Do not paste the whole utterance (`my jira issues page`). Filler like *my / page / tab / the* is ignored; every remaining word must match. Both tools search **title, key, visible page text, and JSON state**. Title matches rank first.

Do not dump the archive into context. Page it (default 20, max 50). The archive is not capped.

## Show or update

Before writing HTML or calling `board_show` / `board_patch`, mention in a new line that the board is being updated so the pause does not look like the chat stopped.

**Create or rewrite** with `board_show` once:

- `key`: stable slug for this page (reuse only for in-place edits of that same page, e.g. `clims-12345-analysis`)
- `title`: short tab label
- `html`: a complete HTML document with inline CSS, or a fragment (the board wraps fragments)
- `assets`: omit unless the page needs images
- `background`: omit when the user should look at this tab (default: focus, restore if archived, open the browser only if nothing is viewing the board). Pass `background: true` when they said *in the background*, *don’t switch tabs*, *stay where I am*, or during a **project design** screenshot loop they should not see yet.
- `pin`: omit or false unless they hinted the tab should persist, or it is a keep-using app (todo list, reusable tool). Do not pin one-off investigations, designs, dumps, questionnaires, demos, or forms.

**Small markup edits** to a page that already exists: `board_patch` (see below). Do not `board_show` the whole document again.

Do not pass a second tool to open or refresh. Do not pass `activate` — that flag is gone; `background` is the only one.

| User said | Call | After |
| --- | --- | --- |
| show me / put it on the board | `board_show` (default) | Focused. Archived key is restored to the strip. |
| update in the background / don’t switch | `board_show` or `board_patch` with `background: true` | Open: unread blip on that tab. Archived: stays archived, unread blip on Archive. |
| tweak a section / fix a line / add a paragraph | `board_patch` | Same focus rules as show. Does not rewrite the rest of the page. |
| a small follow-up about what’s already on the page | nothing — answer in chat | Leave the tab as-is. |
| bring it back / restore | `board_restore` | Strip, focused. |
| change todos / notes / checklist | `board_set_state` | Never focuses. Unread blip if they are not on that tab (open or archived). |

If `board_show` or `board_patch` returns `archived: true`, tell the user the blip is on Archive, not the tab strip.

Mention in chat that it is on the board, with the tab title. Do not paste the HTML into chat.

### Patch an existing page

Prefer `board_patch` when the tab already exists and you are changing a few snippets — a heading, a paragraph, a table row, a CSS rule. It is cheaper than rewriting `html` and will not accidentally clobber the rest of the page.

```
board_patch({
  key: "clims-12345-analysis",
  background: true,
  edits: [
    { oldString: "<p>Status: in progress</p>", newString: "<p>Status: ready</p>" },
    { oldString: "</section>", newString: "<h2>Next</h2><p>Ship it.</p></section>" }
  ]
})
```

Rules:

- Identify the tab by the same `key` (or `id`) you used in `board_show`. The tab must already exist — this does not create.
- `oldString` is an exact substring of the **stored** HTML. If you originally passed a fragment, the stored page is wrapped (doctype + default CSS); match the body you wrote, not the wrapper.
- Each `oldString` must match exactly once. If it matches several times, add surrounding context or pass `replaceAll: true`.
- Edits apply in order, atomically. A failure changes nothing; do not retry with a guessed snippet — `board_read` or add more context.
- Do not `board_read` first when the original markup is still in the conversation.
- Same `background` / focus rules as `board_show`. Does not clear wait signals or JSON state.
- Still `board_show` for a new page, a large rewrite, new `assets`, or seeding `state`.

### Updating vs replacing

Do not replace a page with a new page without asking, even if it is a continuation of the previous subject.

Allowed page edits without clear intention:
- some edits, additions or otherwise improving the page

Not allowed:
- replacing all or most of the page content
- replacing the page with a continuation

If the content page would change a lot, it is better to make a new page, otherwise the user loses the ability to refer back to some older information if they want. If the subject remains the same and is a continuation, instead of replacing the page directly, archive the old page (`board_close`) and create a new one with a new `key`.

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

## Visual feedback (project designs only)

`board_screenshot` is for **designs that belong to the current project** — a mock, layout, or component the user asked you to design or ship. It is not a proofreader for board pages.

Do **not** screenshot investigation results, analyses, architecture notes, ticket dumps, checklists, walkthroughs, or any other throwaway information page. Show (or patch) those once. The user can see them. Polishing their spacing or type wastes tokens.

When it **is** project design work:

1. `board_show` with the same `key`, `background: true` (so the tab does not steal focus).
2. `board_screenshot` with that `key`. Default is a 1280×800 viewport of the page.
3. Inspect the image. For a small markup change, `board_patch` with `background: true`. For a larger rewrite, `board_show` again with `background: true`. Then screenshot again.

```
board_show({ key: "hero", title: "Hero", html, background: true })
board_screenshot({ key: "hero" })
board_screenshot({ key: "hero", selector: ".hero" })   // one component
board_screenshot({ key: "hero", fullPage: true })      // tall page; height is capped
```

Rules:

- Always `background: true` on `board_show` / `board_patch` in this loop unless the user should look at the tab right now.
- Identify the tab by the same `key` (or `id`) you used in `board_show`.
- `selector` is a CSS selector; it captures the first match. If it is missing or not visible, the tool errors — fix the markup or selector, do not retry blindly.
- After `board_set_state` or `board_patch`, screenshot again without re-showing the full HTML. The capture loads current HTML + state from the daemon.
- The image is a canonical viewport, not the user's window size, zoom, or currently focused tab. Inactive / hidden board tabs still screenshot correctly.
- Do not pin design-test pages. Do not write the HTML to a workspace file.
- If `board_screenshot` is missing, the Agent Board MCP is on an old build — tell the user to reload MCP after rebuilding the daemon.

When you are done iterating and the user should see the result, `board_show` or `board_patch` once more **without** `background` so the tab comes to the front.

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
- `archived: true` — the tab was archived; restore it with `board_restore` if you still need the handshake, or stop.
- `closed: true` — the tab was permanently deleted; stop.
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
- `board_set_state` merges the keys you pass, so send only what you are changing. An open page applies it live without reloading. It does **not** focus the tab and does **not** restore an archived tab. Unfocused open tabs and archived tabs show an unread blip.
- Pass `expectedRevision` from your last read. If the user changed the page in between, the write is refused and the error carries their current state — merge your change into it and retry with the revision it reports. Do not reach for `force`; it exists for deliberately resetting a page.
- Read state before acting on a page the user has had time to touch. Do not assume the state you wrote earlier is still current.

If the page asks the user to do something you must continue from — submit, choose, confirm, finish a checklist — call `board_wait` **next, in the same turn**, with the same signal name the page fires. Do not poll `board_get_state`.

## Pin, archive, close

- `board_pin` / `board_unpin` (`id`/`key`) so Clear and close-unpinned keep or drop the tab. Same rule as `board_show` `pin`.
- `board_close` archives one tab (`id`/`key`), unpinned tabs (`unpinned: true`), or everything (`all: true`). Pass `permanent: true` to delete instead of archiving.
- `board_restore` (`id`/`key`) brings an archived tab back to the open strip (focused).
- Reuse a `key` only for in-place edits of that page. A continuation or large rewrite gets a new key; archive the old tab first so the previous page stays recoverable.
- Dates in tool results are local ISO (timezone offset); stored as unix ms on disk.
