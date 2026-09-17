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
import { clampArchivePage } from "./archiveSearch.js";
import { withAgentDates } from "./dates.js";
import type { Tab, TabAsset, TabMeta } from "./types.js";

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
    version: "1.5.0",
  });

  server.tool(
    "board_show",
    "Present an HTML page on the local Agent Board. Creates a tab or replaces the tab with the same key (open or archived). Default: focus the tab, restore it if archived, and open the browser only if nothing is viewing the board. Pass background: true to update without focusing or raising the window — an open tab stays in the background with an unread blip; an archived tab stays archived with an Archive blip. This is the only tool needed to show a page — do not follow it with a separate open or refresh. Prefer this over writing HTML files. Pass a full HTML document or a fragment. To show a user image file, pass assets (local paths) and reference them as asset:name in the HTML. Reuse key when updating the same topic. For a small change to an existing page, prefer board_patch instead of rewriting html.",
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
      background: z
        .boolean()
        .optional()
        .describe(
          "If true, do not focus this tab and do not bring the board window forward. Use when the user said update in the background, stay where I am, or don’t switch tabs, and for private screenshot loops. Open tab: unread blip on that tab. Archived tab: stays archived, unread blip on Archive. Omit (default) when the user should look at this tab — that also restores an archived key to the strip."
        ),
      pin: z.boolean().optional().describe("Pin the tab so Clear/close-unpinned will keep it."),
      state: z
        .record(z.unknown())
        .optional()
        .describe(
          "Initial state for an interactive page, readable in the page as board.state. Applied only when the tab has no state yet, so re-showing a page never resets what the user has changed."
        ),
    },
    async ({ key, title, html, assets, pin, state, background }) => {
      const activate = background !== true;
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
        activate,
        pin,
        state,
        assets: resolvedAssets.length ? resolvedAssets : undefined,
      });
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const created = Boolean((data as { created?: boolean }).created);
      const archived = Boolean((data as { archived?: boolean }).archived);
      const tab = (data as { tab: { id: string; key: string; title: string; assets?: TabAsset[] } }).tab;
      if (activate) {
        const info = await health();
        if (!info || info.viewers === 0) {
          openBrowser(boardUrl(tab.id));
        }
      }
      return jsonResult({
        created,
        archived,
        id: tab.id,
        key: tab.key,
        title: tab.title,
        url: boardUrl(tab.id),
        assets: tab.assets ?? [],
        note: archived
          ? "Updated in the archive (background). The unread blip is on Archive, not the tab strip. Use board_restore to bring it back."
          : activate
            ? "Shown on Agent Board. Do not write this HTML to a workspace file."
            : "Updated in the background. The unread blip is on that tab if it was not focused. Do not write this HTML to a workspace file.",
      });
    }
  );

  server.tool(
    "board_patch",
    "Patch snippets on an existing Agent Board page without rewriting the whole HTML. The tab must already exist (open or archived) — this does not create a page. Each edit replaces an exact oldString with newString in the stored HTML. oldString must match exactly once unless replaceAll is true. Edits apply in order, atomically: if any edit fails, nothing changes. Does not clear wait signals or page state. Default: focus the tab (and restore it if archived). Pass background: true to patch without focusing. Prefer this over board_show when you are changing a few snippets. If you showed a fragment, the stored page is a wrapped full document — match the body you wrote, not the wrapper. On a match failure, call board_read or add more surrounding context; do not guess.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
      edits: z
        .array(
          z.object({
            oldString: z
              .string()
              .min(1)
              .describe("Exact snippet to find in the stored HTML. Must match once unless replaceAll is true."),
            newString: z.string().describe("Replacement. Pass an empty string to delete the snippet."),
            replaceAll: z
              .boolean()
              .optional()
              .describe("Replace every match. Default false (exactly one match required)."),
          })
        )
        .min(1)
        .describe("Replacements to apply in order. Each sees the result of the previous edit."),
      title: z.string().optional().describe("Optional new tab title."),
      background: z
        .boolean()
        .optional()
        .describe(
          "If true, do not focus this tab and do not bring the board window forward. Open tab: unread blip on that tab. Archived tab: stays archived, unread blip on Archive. Omit (default) when the user should look at this tab — that also restores an archived key to the strip."
        ),
    },
    async ({ id, key, edits, title, background }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const activate = background !== true;
      const { status, data } = await api("POST", `/api/tabs/${encodeURIComponent(which)}/patch`, {
        edits,
        title,
        activate,
      });
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const payload = data as {
        applied: number;
        archived: boolean;
        tab: { id: string; key: string; title: string; revision: number; htmlBytes: number };
      };
      if (activate) {
        const info = await health();
        if (!info || info.viewers === 0) {
          openBrowser(boardUrl(payload.tab.id));
        }
      }
      return jsonResult({
        applied: payload.applied,
        archived: payload.archived,
        id: payload.tab.id,
        key: payload.tab.key,
        title: payload.tab.title,
        revision: payload.tab.revision,
        htmlBytes: payload.tab.htmlBytes,
        url: boardUrl(payload.tab.id),
        note: payload.archived
          ? "Patched in the archive (background). The unread blip is on Archive, not the tab strip. Use board_restore to bring it back."
          : activate
            ? "Patched on Agent Board. Do not write this HTML to a workspace file."
            : "Patched in the background. The unread blip is on that tab if it was not focused. Do not write this HTML to a workspace file.",
      });
    }
  );

  server.tool(
    "board_list",
    "List or search open tabs only. Omit query to list every open tab (id, key, title, pinned, dates, size) plus activeId and archiveCount — not paged. Pass query to search title, key, visible page text, and JSON state (same rules as board_archive). Archived tabs are never included; if the page is missing and archiveCount > 0, also call board_archive with the same query. Do not invent a key. If board_archive is missing, the MCP is stale — tell the user to reload it.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Keywords to search open tabs. Prefer distinctive words (jira). Every remaining word must match. Searches title, key, page text, and JSON state. Omit to list every open tab."
        ),
    },
    async ({ query }) => {
      const params = new URLSearchParams();
      if (query?.trim()) {
        params.set("query", query.trim());
      }
      const qs = params.toString();
      const { status, data } = await api("GET", qs ? `/api/tabs?${qs}` : "/api/tabs");
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const payload = data as {
        tabs: Array<TabMeta & { snippet?: string | null }>;
        activeId: string | null;
        archiveCount?: number;
        matchCount?: number;
        returned?: number;
        remaining?: number;
        openCount?: number;
      };
      const archiveCount = payload.archiveCount ?? 0;
      const searched = Boolean(query?.trim());
      return jsonResult({
        tabs: (payload.tabs ?? []).map((tab) => {
          const dates = withAgentDates(tab);
          return searched ? { ...dates, snippet: tab.snippet ?? null } : dates;
        }),
        activeId: payload.activeId,
        archiveCount,
        ...(searched
          ? {
              returned: payload.returned,
              remaining: payload.remaining,
              matchCount: payload.matchCount,
              openCount: payload.openCount,
            }
          : {}),
        note: searched
          ? `Searched open tabs only (${payload.matchCount ?? 0} match(es) of ${payload.openCount ?? 0}). Archived tabs are not included` +
            (archiveCount > 0
              ? ` — also call board_archive with the same query (${archiveCount} in the archive).`
              : ".")
          : archiveCount > 0
            ? `${archiveCount} archived tab(s) are not listed here. Call board_archive to page them, or pass query to search open tabs (title, key, page text, state).`
            : undefined,
      });
    }
  );

  server.tool(
    "board_archive",
    "Page or search archived tabs only (max 200 stored). Each row includes id, key, title, dates, and a snippet when searching. Omit query to list by archived date, newest first (default 20 per page, max 50). Pass query to search: 1–3 distinctive words work best (jira, not my jira issues page). Filler words like my/page/tab are ignored; every remaining word must match. Searches title, key, visible page text, and JSON state; title matches rank first. Open tabs are not searched — use board_list with the same query for those. If remaining > 0, pass offset to get the next page. Do not dump the whole archive into context.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Keywords to search archived tabs. Prefer distinctive title words (jira). Every remaining word must match. Searches title, key, page text, and JSON state. Omit to list by archived date."
        ),
      offset: z.number().optional().describe("Skip this many matching tabs. Default 0."),
      limit: z
        .number()
        .optional()
        .describe("Page size. Default 20, maximum 50."),
    },
    async ({ query, offset, limit }) => {
      const page = clampArchivePage(offset, limit);
      const params = new URLSearchParams();
      if (query?.trim()) {
        params.set("query", query.trim());
      }
      params.set("offset", String(page.offset));
      params.set("limit", String(page.limit));
      const { status, data } = await api("GET", `/api/archive?${params.toString()}`);
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const payload = data as {
        tabs: Array<TabMeta & { snippet?: string | null }>;
        returned: number;
        remaining: number;
        matchCount: number;
        archiveCount: number;
      };
      return jsonResult({
        tabs: (payload.tabs ?? []).map((tab) => {
          const dates = withAgentDates(tab);
          return {
            ...dates,
            snippet: tab.snippet ?? null,
          };
        }),
        returned: payload.returned,
        remaining: payload.remaining,
        matchCount: payload.matchCount,
        archiveCount: payload.archiveCount,
        note:
          payload.matchCount === payload.archiveCount
            ? `Returned ${payload.returned} of ${payload.archiveCount} archived tabs; ${payload.remaining} after this page.`
            : `Returned ${payload.returned} of ${payload.matchCount} matches (${payload.archiveCount} tabs in the archive); ${payload.remaining} matches after this page.`,
      });
    }
  );

  server.tool(
    "board_restore",
    "Bring an archived tab back to the open tab strip (appended at the end and focused). Identify the tab by id or key from board_archive.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
    },
    async ({ id, key }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const { status, data } = await api("POST", `/api/tabs/${encodeURIComponent(which)}/restore`);
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const payload = data as { tab: TabMeta; archiveCount: number };
      return jsonResult({
        ...withAgentDates(payload.tab),
        archiveCount: payload.archiveCount,
        note: "Restored to the open tab strip.",
      });
    }
  );

  server.tool(
    "board_read",
    "Read a board tab's title and HTML so you can revise it. Identify the tab by id or key. Works on open and archived tabs without restoring.",
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
      const dates = withAgentDates(tab);
      return jsonResult({
        id: tab.id,
        key: tab.key,
        title: tab.title,
        pinned: tab.pinned,
        archived: Boolean(tab.archivedAt),
        createdAt: dates.createdAt,
        updatedAt: dates.updatedAt,
        ...(dates.archivedAt ? { archivedAt: dates.archivedAt } : {}),
        html: tab.html,
        assets: tab.assets ?? [],
      });
    }
  );

  server.tool(
    "board_screenshot",
    "Capture a screenshot of a board page so you can visually inspect a UI design for the current project. Do not use this to polish investigation, analysis, or other throwaway information pages — those are shown once for the user to read. Returns an image of the page at a canonical viewport (1280x800 unless you pass width/height). Pass selector to capture one element, or fullPage for a tall page. Identify the tab by id or key (open or archived). Show or update the page with board_show first; pass background: true on board_show so the capture does not steal focus.",
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
    "Read the live state of an interactive board page: what the user has actually added, edited, or checked off. Returns the state object plus stateRevision, which you pass back to board_set_state as expectedRevision, and the last signal (if any). Works whether or not the tab is focused, archived, or the browser is open. Do not poll this tool while waiting for the user — use board_wait.",
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
    "Block until the board page fires a named signal (board.signal or data-board-signal), then return that signal plus the live state. Use this instead of polling board_get_state. Show the page with board_show first, then call this in the same turn with the same signal name the page fires. Default timeout is 10 minutes. If timedOut is true, tell the user you are still waiting and call board_wait again with the same afterSignalRevision. If archived is true, the tab moved to the archive — restore it or stop. If closed is true, the tab was permanently deleted; stop. If you already got a signal and need the next one without re-showing the page, pass that signal's revision as afterSignalRevision. board_show clears the last signal, so the next wait can omit afterSignalRevision.",
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
    "Update the state of an interactive board page without focusing it or restoring it from the archive. An open page applies the write live without reloading. An unfocused open tab and an archived tab both show an unread blip. Keys merge into the existing state, so send only what you are changing. Pass expectedRevision from board_get_state: if the user changed the page in the meantime the write is refused and the response carries their current state, so you can merge your change into it and retry. Never write a key the page uses for in-progress typing (by convention, draft).",
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
    "Archive Agent Board tabs (same as the UI close button). Pass id or key for one tab, or unpinned/all for bulk archive. Pass permanent: true to delete instead of archiving (no confirmation). Permanent delete of an open tab can be undone with Ctrl+Z for the last 5; deleting from the archive cannot.",
    {
      id: z.string().optional().describe("Tab id to archive or delete."),
      key: z.string().optional().describe("Tab key to archive or delete."),
      unpinned: z.boolean().optional().describe("If true, archive (or permanently delete) every tab that is not pinned."),
      all: z.boolean().optional().describe("If true, archive (or permanently delete) every tab including pinned ones."),
      permanent: z
        .boolean()
        .optional()
        .describe("If true, delete instead of moving to the archive. Default false."),
    },
    async ({ id, key, unpinned, all, permanent }) => {
      const extra = permanent ? "permanent=true" : "";
      if (all || unpinned) {
        const filter = all ? "all" : "unpinned";
        const qs = extra ? `filter=${filter}&${extra}` : `filter=${filter}`;
        const { status, data } = await api("DELETE", `/api/tabs?${qs}`);
        if (status >= 400) {
          return errorResult((data as ApiError).error || `HTTP ${status}`);
        }
        return jsonResult(data);
      }
      const which = id || key;
      if (!which) {
        return errorResult("Provide id, key, unpinned, or all");
      }
      const suffix = extra ? `?${extra}` : "";
      const { status, data } = await api("DELETE", `/api/tabs/${encodeURIComponent(which)}${suffix}`);
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
