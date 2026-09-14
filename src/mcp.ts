import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseAssetInputs } from "./assets.js";
import { baseUrl } from "./config.js";
import { api, ensureDaemon, health } from "./daemon.js";
import { log } from "./log.js";
import { openBrowser } from "./openBrowser.js";
import { clampWaitMs, parseSignalNames } from "./signal.js";
import type { Tab, TabAsset } from "./types.js";

type ApiError = { error?: string };

type ScreenshotPayload = {
  mimeType: "image/png" | "image/jpeg";
  data: string;
  width: number;
  height: number;
  fullPage: boolean;
  selector?: string;
  id: string;
  key: string;
  title: string;
  bytes: number;
};

export async function startMcp(): Promise<void> {
  await ensureDaemon();
  const server = new McpServer({
    name: "agent-board",
    version: "1.3.0",
  });

  server.tool(
    "board_show",
    "Present an HTML page on the local Agent Board. Creates a tab or replaces the tab with the same key. By default it focuses the tab and opens the browser only if the board is not already open. Pass background: true to update without focusing the tab or raising the window — use that when screenshotting a design. This is the only tool needed to show a page — do not follow it with a separate open or refresh. Prefer this over writing HTML files. Pass a full HTML document or a fragment. To show a user image file, pass assets (local paths) and reference them as asset:name in the HTML. Reuse key when updating the same topic.",
    {
      key: z
        .string()
        .optional()
        .describe("Stable identity for this page. Reusing the same key updates that tab instead of opening another."),
      title: z.string().describe("Tab title shown in the board."),
      html: z.string().describe("HTML document or fragment to render in the tab."),
      assets: z
        .array(
          z.union([
            z.string().describe("Absolute or workspace-relative path to an image file."),
            z.object({
              path: z.string().describe("Absolute or workspace-relative path to an image file."),
              name: z
                .string()
                .optional()
                .describe("Name to use in asset:name. Defaults to the file's basename."),
            }),
          ])
        )
        .optional()
        .describe(
          "Local image files to attach (png, jpg, gif, webp, svg, ico, avif). Reference them in HTML as asset:name, e.g. <img src=\"asset:hero.png\">. Re-showing the same key without assets keeps files already attached."
        ),
      activate: z
        .boolean()
        .optional()
        .describe("Focus this tab in the open board. Defaults to true. Do not pass true together with background."),
      background: z
        .boolean()
        .optional()
        .describe(
          "If true, do not focus this tab and do not bring the board window forward. Use when iterating on a design the user is not looking at, especially before board_screenshot."
        ),
      pin: z.boolean().optional().describe("Pin the tab so Clear/close-unpinned will keep it."),
      state: z
        .record(z.unknown())
        .optional()
        .describe(
          "Initial state for an interactive page, readable in the page as board.state. Applied only when the tab has no state yet, so re-showing a page never resets what the user has changed."
        ),
    },
    async ({ key, title, html, assets, activate, pin, state, background }) => {
      const resolved = resolveActivate(activate, background);
      if (!resolved.ok) {
        return errorResult(resolved.error);
      }
      let resolvedAssets: { path: string; name?: string }[] = [];
      try {
        resolvedAssets = resolveAssetPaths(assets);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      const { status, data } = await api("POST", "/api/tabs", {
        key,
        title,
        html,
        activate: resolved.activate,
        pin,
        state,
        assets: resolvedAssets.length ? resolvedAssets : undefined,
      });
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const created = Boolean((data as { created?: boolean }).created);
      const tab = (data as { tab: { id: string; key: string; title: string; assets?: TabAsset[] } }).tab;
      if (resolved.activate) {
        const info = await health();
        if (!info || info.viewers === 0) {
          openBrowser(boardUrl(tab.id));
        }
      }
      return jsonResult({
        created,
        id: tab.id,
        key: tab.key,
        title: tab.title,
        url: boardUrl(tab.id),
        assets: tab.assets ?? [],
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
        assets: tab.assets ?? [],
      });
    }
  );

  server.tool(
    "board_screenshot",
    "Capture a screenshot of a board page so you can visually inspect a design. Returns an image of the page at a canonical viewport (1280x800 unless you pass width/height). Pass selector to capture one element, or fullPage for a tall page. Identify the tab by id or key. Show or update the page with board_show first; pass background: true on board_show so the capture does not steal focus.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
      selector: z
        .string()
        .optional()
        .describe("CSS selector for one element. Captures the first match. Errors if missing or not visible."),
      fullPage: z
        .boolean()
        .optional()
        .describe("Capture the full scrolling page, capped at 6000px tall. Ignored when selector is set. Defaults to the viewport."),
      width: z
        .number()
        .optional()
        .describe("Viewport width in CSS pixels. Default 1280. Clamped 320–1600."),
      height: z
        .number()
        .optional()
        .describe("Viewport height in CSS pixels. Default 800. Clamped 320–1600."),
    },
    async ({ id, key, selector, fullPage, width, height }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      try {
        const { status, data } = await api(
          "POST",
          `/api/tabs/${encodeURIComponent(which)}/screenshot`,
          { selector, fullPage, width, height },
          { timeoutMs: 45_000 }
        );
        if (status >= 400) {
          return errorResult((data as ApiError).error || `HTTP ${status}`);
        }
        const shot = data as ScreenshotPayload;
        if (!shot?.data || !shot.mimeType) {
          return errorResult("Screenshot response was empty");
        }
        return {
          content: [
            { type: "image" as const, mimeType: shot.mimeType, data: shot.data },
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: shot.id,
                  key: shot.key,
                  title: shot.title,
                  width: shot.width,
                  height: shot.height,
                  mimeType: shot.mimeType,
                  bytes: shot.bytes,
                  fullPage: shot.fullPage,
                  selector: shot.selector ?? null,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult((err as Error).message || "board_screenshot failed");
      }
    }
  );

  server.tool(
    "board_get_state",
    "Read the live state of an interactive board page: what the user has actually added, edited, or checked off. Returns the state object plus stateRevision, which you pass back to board_set_state as expectedRevision, and the last signal (if any). Works whether or not the tab is focused or the browser is open. Do not poll this tool while waiting for the user — use board_wait.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
    },
    async ({ id, key }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const { status, data } = await api("GET", `/api/tabs/${encodeURIComponent(which)}/state`);
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      return jsonResult(data);
    }
  );

  server.tool(
    "board_wait",
    "Block until the board page fires a named signal (board.signal or data-board-signal), then return that signal plus the live state. Use this instead of polling board_get_state. Show the page with board_show first, then call this in the same turn with the same signal name the page fires. Default timeout is 10 minutes. If timedOut is true, tell the user you are still waiting and call board_wait again with the same afterSignalRevision. If you already got a signal and need the next one without re-showing the page, pass that signal's revision as afterSignalRevision. board_show clears the last signal, so the next wait can omit afterSignalRevision.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
      signal: z
        .string()
        .describe(
          "Signal name the page fires. Must match board.signal(\"name\") or data-board-signal=\"name\". For more than one outcome, pass a comma-separated list: approved,rejected"
        ),
      afterSignalRevision: z
        .number()
        .optional()
        .describe(
          "Ignore signals at or below this revision. Omit (or 0) after board_show. After a successful wait, pass the returned signal.revision to wait for the next one on the same page."
        ),
      timeoutMs: z
        .number()
        .optional()
        .describe("How long to wait, in milliseconds. Defaults to 600000 (10 minutes). Maximum 10 minutes."),
    },
    async ({ id, key, signal, afterSignalRevision, timeoutMs }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      let names: string[];
      try {
        names = parseSignalNames(signal);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      const waitMs = clampWaitMs(timeoutMs);
      try {
        const { status, data } = await api(
          "POST",
          `/api/tabs/${encodeURIComponent(which)}/wait`,
          {
            signal: names,
            afterSignalRevision: afterSignalRevision ?? 0,
            timeoutMs: waitMs,
          },
          { timeoutMs: waitMs + 15_000 }
        );
        if (status >= 400) {
          return errorResult((data as ApiError).error || `HTTP ${status}`);
        }
        return jsonResult(data);
      } catch (err) {
        return errorResult((err as Error).message || "board_wait failed");
      }
    }
  );

  server.tool(
    "board_set_state",
    "Update the state of an interactive board page; an open page applies it live without reloading. Keys merge into the existing state, so send only what you are changing. Pass expectedRevision from board_get_state: if the user changed the page in the meantime the write is refused and the response carries their current state, so you can merge your change into it and retry. Never write a key the page uses for in-progress typing (by convention, draft).",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
      state: z.record(z.unknown()).describe("Top-level keys to write. Merges unless replace is true."),
      expectedRevision: z
        .number()
        .optional()
        .describe("stateRevision from your last board_get_state. Omit only when seeding a page that has no state yet."),
      replace: z
        .boolean()
        .optional()
        .describe("Replace the whole state object instead of merging keys into it."),
      force: z
        .boolean()
        .optional()
        .describe("Skip the revision check and overwrite whatever is there. Only for deliberately resetting a page."),
    },
    async ({ id, key, state, expectedRevision, replace, force }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const guardRevision = force ? undefined : (expectedRevision ?? 0);
      const { status, data } = await api("PUT", `/api/tabs/${encodeURIComponent(which)}/state`, {
        state,
        replace,
        expectedRevision: guardRevision,
      });
      if (status === 409) {
        const conflict = data as { state: unknown; stateRevision: number };
        return errorResult(
          `Conflict: the page changed since revision ${guardRevision}. Current stateRevision is ${conflict.stateRevision}. Merge your change into the state below and retry with expectedRevision ${conflict.stateRevision}.\n\n${JSON.stringify(conflict.state, null, 2)}`
        );
      }
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      return jsonResult(data);
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

function resolveAssetPaths(assets: Array<string | { path: string; name?: string }> | undefined) {
  return parseAssetInputs(assets).map((item) => ({
    path: path.resolve(item.path),
    name: item.name,
  }));
}

function resolveActivate(
  activate: boolean | undefined,
  background: boolean | undefined
): { ok: true; activate: boolean } | { ok: false; error: string } {
  if (background === true && activate === true) {
    return { ok: false, error: "background and activate cannot both be true" };
  }
  if (background === true) {
    return { ok: true, activate: false };
  }
  return { ok: true, activate: activate !== false };
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
