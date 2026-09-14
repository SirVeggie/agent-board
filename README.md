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
cd C:\library\software\agent-board
npm install
npm run build
```

Then two copies outside the repo:

1. **MCP** — add this to `%USERPROFILE%\.cursor\mcp.json`, with the `args` path pointing at this clone:

```json
"agent-board": {
  "command": "node",
  "args": ["C:\\library\\software\\agent-board\\dist\\index.js"]
}
```

2. **Skill** — copy `.cursor\skills\agent-board` to `%USERPROFILE%\.cursor\skills\agent-board`. A project skill only applies in this repo; the personal copy is what agents use from every other workspace. A junction stays in sync with git:

```bat
mklink /J %USERPROFILE%\.cursor\skills\agent-board C:\library\software\agent-board\.cursor\skills\agent-board
```

Reload MCP in Cursor after changing `mcp.json`. Then open http://127.0.0.1:4747 or ask the agent to present something visually.

`npm start` runs the daemon in the foreground. Cursor does not need this: the MCP server starts the daemon on first use. `npm stop` stops a running daemon.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `board_show` | Create or replace a page (`key` + `title` + `html`, optional `state`). Opens the browser only if the board is not already open. Pass `background: true` to skip focusing the tab and raising the window. |
| `board_screenshot` | Capture a PNG (or JPEG) of a tab's page or a CSS `selector`. Canonical 1280×800 viewport unless you pass `width`/`height`/`fullPage`. |
| `board_list` | List open tabs |
| `board_read` | Read a tab's HTML so it can be revised |
| `board_get_state` | Read what the user has actually typed, added, or checked off on an interactive page |
| `board_wait` | Block until the page fires a named signal (`board.signal` / `data-board-signal`), then return that signal plus the live state. Default 10 minutes. Do not poll `board_get_state`. |
| `board_set_state` | Write state back; an open page applies it live without reloading |
| `board_pin` / `board_unpin` | Pin or unpin a tab (`id` or `key`) so Clear keeps or drops it |
| `board_close` | Close one tab, all unpinned tabs, or everything |

Reuse the same `key` when updating a topic. Pass a full HTML document, or a fragment (it gets a readable dark template).

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

Tabs persist in `%LOCALAPPDATA%\agent-board\state.json` across daemon and Cursor restarts, including each tab's state object (max 256 KB per tab). The last 5 closed pages stay in that file too, so **Ctrl+Z** can restore them.

The browser **Clear** button closes unpinned tabs. Pinned tabs stay until you close them. **Ctrl+S** downloads the current page as HTML.

Port: `4747` (override with `AGENT_BOARD_PORT`). Bound to localhost only.

Tab pages load in an iframe from **http://127.0.0.2:4747** so they can use `localStorage` without accessing the board chrome or API. Refresh the board after upgrading so the new iframe sandbox takes effect.
