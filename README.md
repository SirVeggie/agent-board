# Agent Board

A local tabbed HTML viewer the Cursor agent can drive over MCP.

You keep **http://127.0.0.1:4747** open in the browser. The agent opens, updates, reads, and closes tabs there instead of writing throwaway `.html` files into a workspace.

## How it works

- A small **daemon** serves the board on `127.0.0.1:4747` and remembers tabs in `%LOCALAPPDATA%\agent-board`.
- Cursor talks to a **stdio MCP** process. That process starts the daemon if needed, then calls the local HTTP API.
- The browser page stays connected over a WebSocket, so new pages appear as tabs immediately.

The MCP process can come and go with Cursor. The daemon stays up so the board does not reset when a chat ends.

## Setup on a new PC

`dist/` is not in git, and Cursor only sees the MCP server and skill if they are registered on that machine. After clone:

```bat
cd C:\path\to\agent-board
npm install
npm run build
```

Then two copies outside the repo:

1. **MCP** — add this to `%USERPROFILE%\.cursor\mcp.json`, with the `args` path pointing at this clone:

```json
"agent-board": {
  "command": "node",
  "args": ["C:\\path\\to\\agent-board\\dist\\index.js"]
}
```

2. **Skill** — copy `.cursor\skills\agent-board` to `%USERPROFILE%\.cursor\skills\agent-board`. A project skill only applies in this repo; the personal copy is what agents use from every other workspace. A junction stays in sync with git:

```bat
mklink /J %USERPROFILE%\.cursor\skills\agent-board C:\path\to\agent-board\.cursor\skills\agent-board
```

Reload MCP in Cursor after changing `mcp.json`. Then open http://127.0.0.1:4747 or ask the agent to present something visually.

`npm start` runs the daemon in the foreground. Cursor does not need this: the MCP server starts the daemon on first use. `npm stop` stops a running daemon.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `board_show` | Create or replace a page (`key` + `title` + `html`, optional `state` and `assets`). Default focuses the tab (and restores it if archived). Pass `background: true` to update without focusing: unread blip on an open tab, or on Archive if the tab is archived. |
| `board_patch` | Change snippets on an existing page (`id`/`key` + `edits` of `oldString`/`newString`). Same background/focus rules as show. Does not create a tab or reset wait state. |
| `board_screenshot` | Capture a PNG (or JPEG) of a tab's page or a CSS `selector`. Canonical 1280×800 viewport unless you pass `width`/`height`/`fullPage`. |
| `board_list` | List open tabs (`id`, `key`, `title`, …) plus `archiveCount`. Pass `query` to search title, key, page text, and JSON state among **open** tabs. |
| `board_archive` | Page archived tabs (default 20, max 50) or search with `query` over title, key, page text, and JSON state. Open tabs are not searched. |
| `board_restore` | Bring an archived tab back to the open strip |
| `board_read` | Read a tab's HTML so it can be revised (open or archived) |
| `board_get_state` | Read what the user has actually typed, added, or checked off on an interactive page |
| `board_wait` | Block until the page fires a named signal (`board.signal` / `data-board-signal`), then return that signal plus the live state. Default 10 minutes. Do not poll `board_get_state`. |
| `board_set_state` | Write state without focusing. Unfocused open tabs and archived tabs show an unread blip. |
| `board_pin` / `board_unpin` | Pin or unpin a tab (`id` or `key`) so Clear keeps or drops it |
| `board_close` | Archive one tab, all unpinned tabs, or everything. Pass `permanent: true` to delete instead |

Reuse the same `key` when updating a topic. Pass a full HTML document, or a fragment (it gets a readable dark template). For a small change to an existing page, `board_patch` with exact `oldString`/`newString` edits instead of sending the whole document again.

### Images

`board_show` accepts local image files via `assets` (path strings, or `{ path, name }`). The daemon copies them next to the tab and the page can reference them as `asset:name`:

```html
<img src="asset:hero.png" alt="Hero">
```

png, jpg, gif, webp, svg, ico, and avif. 8 MB per file, 16 files / 32 MB per tab. These do not count toward the 2 MB HTML cap. Re-showing a key without `assets` keeps files already attached. Workspace-relative `<img src>` and `file://` URLs do not work — tab pages are served from `http://127.0.0.2` and cannot see the disk.

`board_screenshot` loads the tab's content page in a headless Chromium browser (Edge, Chrome, or Brave — not the board chrome) and returns an image. Pair it with `board_show(..., background: true)` so a design loop does not steal window focus. Default viewport is 1280×800; pass `selector` for one element or `fullPage` for a tall page.

## Interactive pages

Every tab owns a JSON state object that lives in the daemon, not in the browser. The agent can read and write it whether or not the tab is focused, or the browser is even open. Pages get it as `window.board`, injected before any page script runs:

```js
board.state                  // current state, readable synchronously on load
board.set({ todos })         // merge top-level keys, saved on a short debounce
board.signal("submitted")    // wake board_wait; flushes pending board.set first
board.onChange(render)       // agent or another viewer changed something
board.bind(el, "notes")      // two-way bind an input, textarea, or checkbox
```

A submit button can declare the same handshake without extra script: `data-board-signal="submitted"`. The agent then calls `board_wait` with that signal name. `board_show` clears the last signal on the tab so a new wait does not instantly see the previous submit.

Interactive pages should use this instead of `localStorage` — all tab pages share one origin, so their `localStorage` collides, and the agent cannot see it.

`board.bind` is what makes text fields safe. It saves as you type (250 ms idle, 1 s ceiling), and when a remote change arrives for a field you are currently in, it leaves your caret and half-typed text alone, marks the field `board-stale`, and reconciles once you move on.

Writes merge at the top level, so the agent updating `todos` never disturbs the `notes` you are typing. To make in-progress form input completely off limits, keep it under a `draft` key — by convention the agent reads it but never writes it.

### Conflicts

`board_get_state` returns a `stateRevision`. Passing it back as `expectedRevision` makes the write conditional: if the user changed the page in between, it is refused with `409` and the response carries their current state, so the agent can merge and retry. Agent writes without an `expectedRevision` are refused on a page that already has state, unless `force` is set. Writes from the page itself are never blocked — the person looking at the screen wins ties.

`board_wait` blocks until `board.signal("name")` (or `data-board-signal="name"`) fires on that tab. It returns the signal plus the current state. Waiting for any state change would wake on every keystroke; the named signal is the handshake. After a successful wait, pass `signal.revision` as `afterSignalRevision` to wait for the next one without re-showing the page.

## Data

Tabs persist in `%LOCALAPPDATA%\agent-board\board.sqlite` across daemon and Cursor restarts, including each tab's state object (max 256 KB per tab). Image files live in `%LOCALAPPDATA%\agent-board\assets\<tabId>\`. Closing a tab moves it to the **archive** (kept until you empty it or permanently delete). **Ctrl+Z** restores whichever is newer: the most recently archived tab, or one of the last 5 tabs that were permanently deleted while still open. A previous `state.json` is imported once and renamed to `state.json.bak`.

The browser **Clear** button archives unpinned tabs. Pinned tabs stay until you archive or delete them. Shift+click a tab's × permanently deletes it (confirmation in the UI). **Ctrl+S** downloads the current page as HTML.

Port: `4747` (override with `AGENT_BOARD_PORT`). Bound to localhost only.

Tab pages load in an iframe from **http://127.0.0.2:4747** so they can use `localStorage` without accessing the board chrome or API. Refresh the board after upgrading so the new iframe sandbox takes effect.
