# Agent Board

A local tabbed HTML viewer the Cursor agent can drive over MCP.

You keep **http://127.0.0.1:4747** open in the browser. The agent opens, updates, reads, and closes tabs there instead of writing throwaway `.html` files into a workspace.

## How it works

- A small **daemon** serves the board on `127.0.0.1:4747` and remembers tabs in `%LOCALAPPDATA%\agent-board`.
- Cursor talks to a **stdio MCP** process. That process starts the daemon if needed, then calls the local HTTP API.
- The browser page stays connected over a WebSocket, so new pages appear as tabs immediately.

The MCP process can come and go with Cursor. The daemon stays up so the board does not reset when a chat ends.

## Commands

```bat
cd C:\library\software\agent-board
npm install
npm run build
npm start
```

`npm start` runs the daemon in the foreground. Cursor does not need this: the MCP server starts the daemon on first use.

```bat
npm stop
```

stops a running daemon.

## Cursor MCP

Add this to `%USERPROFILE%\.cursor\mcp.json`:

```json
"agent-board": {
  "command": "node",
  "args": ["C:\\library\\software\\agent-board\\dist\\index.js"]
}
```

Reload MCP in Cursor after changing that file. Then open http://127.0.0.1:4747 or ask the agent to present something visually.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `board_show` | Create or replace a page (`key` + `title` + `html`). Opens the browser only if the board is not already open. |
| `board_list` | List open tabs |
| `board_read` | Read a tab's HTML so it can be revised |
| `board_pin` / `board_unpin` | Pin or unpin a tab (`id` or `key`) so Clear keeps or drops it |
| `board_close` | Close one tab, all unpinned tabs, or everything |

Reuse the same `key` when updating a topic. Pass a full HTML document, or a fragment (it gets a readable dark template).

## Data

Tabs persist in `%LOCALAPPDATA%\agent-board\state.json` across daemon and Cursor restarts. The last 5 closed pages stay in that file too, so **Ctrl+Z** can restore them.

The browser **Clear** button closes unpinned tabs. Pinned tabs stay until you close them. **Ctrl+S** downloads the current page as HTML.

Port: `4747` (override with `AGENT_BOARD_PORT`). Bound to localhost only.
