import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { baseUrl } from "./config.js";
import { api, ensureDaemon, health } from "./daemon.js";
import { log } from "./log.js";
import { openBrowser } from "./openBrowser.js";
import type { Tab } from "./types.js";

type ApiError = { error?: string };

export async function startMcp(): Promise<void> {
  await ensureDaemon();
  const server = new McpServer({
    name: "agent-board",
    version: "1.0.0",
  });

  server.tool(
    "board_show",
    "Present an HTML page on the local Agent Board. Creates a tab or replaces the tab with the same key, focuses it, and opens the browser only if the board is not already open. This is the only tool needed to show a page — do not follow it with a separate open or refresh. Prefer this over writing HTML files. Pass a full HTML document or a fragment. Reuse key when updating the same topic.",
    {
      key: z
        .string()
        .optional()
        .describe("Stable identity for this page. Reusing the same key updates that tab instead of opening another."),
      title: z.string().describe("Tab title shown in the board."),
      html: z.string().describe("HTML document or fragment to render in the tab."),
      activate: z
        .boolean()
        .optional()
        .describe("Focus this tab in the open board. Defaults to true."),
      pin: z.boolean().optional().describe("Pin the tab so Clear/close-unpinned will keep it."),
    },
    async ({ key, title, html, activate, pin }) => {
      const { status, data } = await api("POST", "/api/tabs", { key, title, html, activate, pin });
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const created = Boolean((data as { created?: boolean }).created);
      const tab = (data as { tab: { id: string; key: string; title: string } }).tab;
      const info = await health();
      if (!info || info.viewers === 0) {
        openBrowser(boardUrl(tab.id));
      }
      return jsonResult({
        created,
        id: tab.id,
        key: tab.key,
        title: tab.title,
        url: boardUrl(tab.id),
        note: "Shown on Agent Board. Do not write this HTML to a workspace file.",
      });
    }
  );

  server.tool(
    "board_list",
    "List tabs currently on the Agent Board (id, key, title, pinned, size). Use before updating or closing an existing page.",
    async () => {
      const { status, data } = await api("GET", "/api/tabs");
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      return jsonResult(data);
    }
  );

  server.tool(
    "board_read",
    "Read a board tab's title and HTML so you can revise it. Identify the tab by id or key.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
    },
    async ({ id, key }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const { status, data } = await api("GET", `/api/tabs/${encodeURIComponent(which)}`);
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const tab = data as Tab;
      return jsonResult({
        id: tab.id,
        key: tab.key,
        title: tab.title,
        pinned: tab.pinned,
        html: tab.html,
      });
    }
  );

  server.tool(
    "board_pin",
    "Pin an Agent Board tab so Clear and close-unpinned keep it. Identify the tab by id or key.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
    },
    async ({ id, key }) => pinResult(id || key, true)
  );

  server.tool(
    "board_unpin",
    "Unpin an Agent Board tab so Clear and close-unpinned can close it. Identify the tab by id or key.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
    },
    async ({ id, key }) => pinResult(id || key, false)
  );

  server.tool(
    "board_close",
    "Close Agent Board tabs. Pass id or key for one tab, or unpinned/all for bulk close.",
    {
      id: z.string().optional().describe("Tab id to close."),
      key: z.string().optional().describe("Tab key to close."),
      unpinned: z.boolean().optional().describe("If true, close every tab that is not pinned."),
      all: z.boolean().optional().describe("If true, close every tab including pinned ones."),
    },
    async ({ id, key, unpinned, all }) => {
      if (all || unpinned) {
        const filter = all ? "all" : "unpinned";
        const { status, data } = await api("DELETE", `/api/tabs?filter=${filter}`);
        if (status >= 400) {
          return errorResult((data as ApiError).error || `HTTP ${status}`);
        }
        return jsonResult(data);
      }
      const which = id || key;
      if (!which) {
        return errorResult("Provide id, key, unpinned, or all");
      }
      const { status, data } = await api("DELETE", `/api/tabs/${encodeURIComponent(which)}`);
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      return jsonResult(data);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP connected; board at ${baseUrl()}`);
}

async function pinResult(which: string | undefined, pin: boolean) {
  if (!which) {
    return errorResult("Provide id or key");
  }
  const { status, data } = await api("PATCH", `/api/tabs/${encodeURIComponent(which)}`, {
    pin,
    activate: false,
  });
  if (status >= 400) {
    return errorResult((data as ApiError).error || `HTTP ${status}`);
  }
  const tab = (data as { tab: { id: string; key: string; title: string; pinned: boolean } }).tab;
  return jsonResult({
    id: tab.id,
    key: tab.key,
    title: tab.title,
    pinned: tab.pinned,
  });
}

function boardUrl(id?: string): string {
  return id ? `${baseUrl()}/#${id}` : baseUrl();
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
