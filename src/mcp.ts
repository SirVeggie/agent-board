import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseAssetInputs } from "./assets.js";
import { safeStem } from "./boardExport.js";
import { VERSION, baseUrl, contentBaseUrl } from "./config.js";
import { api, ensureDaemon, health } from "./daemon.js";
import { log } from "./log.js";
import { openBoard } from "./openBoard.js";
import { clampWaitMs, parseSignalNames } from "./signal.js";
import { clampLibraryPage } from "./librarySearch.js";
import { withAgentDates } from "./dates.js";
import type { PageAssetUsage } from "./pageAssets.js";
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

type TemplateGuide = { id: string; title: string; text: string };
type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };

/**
 * Template guides already handed to this agent. One MCP process serves one agent session, so
 * a guide goes out in full the first time the agent touches a page from that template and as a
 * one-line pointer after that, instead of every template's guide living in the skill.
 */
const deliveredGuides = new Map<string, string>();

async function withGuide(result: ToolResult, which: string, force = false): Promise<ToolResult> {
  let guide: TemplateGuide | null = null;
  try {
    const { status, data } = await api("GET", `/api/tabs/${encodeURIComponent(which)}/guide`);
    guide = status < 400 ? ((data as { guide?: TemplateGuide | null }).guide ?? null) : null;
  } catch {
    return result;
  }
  if (!guide) {
    return result;
  }
  if (!force && deliveredGuides.get(guide.id) === guide.text) {
    result.content.push({
      type: "text",
      text: `This page is a "${guide.title}" page. Its agent guide was sent earlier in this session; board_get_state with guide: true shows it again.`,
    });
    return result;
  }
  deliveredGuides.set(guide.id, guide.text);
  result.content.push({
    type: "text",
    text: `Agent guide for "${guide.title}" pages. Follow it when reading or changing this page.\n\n${guide.text}`,
  });
  return result;
}

/** Clients show these to the model on connect, even when the agent-board skill is not loaded. */
const INSTRUCTIONS = [
  "Agent Board is a tabbed HTML viewer the user keeps open. Use it for standalone visual output (investigation results, analyses, comparisons, design options) and interactive pages whose state you read back (todo lists, checklists, reviews, forms). Prefer it over writing .html files into the workspace or the host's own canvas or artifact features, unless the user asked for those.",
  "Also use it whenever the user refers to something on the board: a page title, a pasted `Agent Board tab t_…` id (pass the t_… id straight to board_read / board_patch / board_get_state), or their todo list or kanban.",
  "If the agent-board skill is available, load it before building or changing pages; it has the full rules.",
  "Show a page once with board_show and a stable key; for small edits to an existing page use board_patch, not a full re-show. Do not replace a page's content with a continuation: close it and show a new key.",
  "Find pages by title with board_list (open tabs), then board_library (every page). Never guess a key.",
  "Pages keep user data in board state (board.set / board.bind in the page, board_get_state / board_set_state from you, with expectedRevision). Never use localStorage in a page.",
  "When the page asks the user to submit, choose, or finish something, call board_wait next with the signal name the page fires. Never poll board_get_state.",
  "Only use board_screenshot for UI designs that belong to the current project, never to polish information pages.",
  "Do not create, edit, or delete templates unless the user asked. Pages from a template come with an agent guide in tool results; follow it.",
].join(" ");

export async function startMcp(): Promise<void> {
  await ensureDaemon();
  const server = new McpServer({ name: "agent-board", version: VERSION }, { instructions: INSTRUCTIONS });

  server.tool(
    "board_show",
    "Present an HTML page on the local Agent Board. Creates a page or replaces the page with the same key (whether its tab is open or closed). Every page lives in the Library; the tab strip is just the pages currently open. Default: focus the tab, reopen it if closed, and open the browser only if nothing is viewing the board. Pass background: true to update without focusing or raising the window — an open tab stays in the background with an unread blip; a closed page stays closed with a Library blip. This is the only tool needed to show a page — do not follow it with a separate open or refresh. Prefer this over writing HTML files. Pass a full HTML document or a fragment. To show a user image file, pass assets (local paths) and reference them as asset:name in the HTML. Reuse key when updating the same topic. For a small change to an existing page, prefer board_patch instead of rewriting html.",
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
          "If true, do not focus this tab and do not bring the board window forward. Use when the user said update in the background, stay where I am, or don’t switch tabs, and for private screenshot loops. Open tab: unread blip on that tab. Closed page: stays closed, unread blip on Library. Omit (default) when the user should look at this tab — that also reopens a closed page in the strip."
        ),
      pin: z.boolean().optional().describe("Pin the tab so Clear/close-unpinned will keep it."),
      folder: z
        .string()
        .optional()
        .describe(
          "Library folder path for a new page, e.g. \"CLIMS/Releases\" (created if missing). Only used when the page is created; never moves an existing page — the user organizes the Library. Pass an existing path from board_folders when the new page clearly belongs there, or a new path only when the user asked for that folder. Otherwise omit (the page lands in the Library root)."
        ),
      state: z
        .record(z.unknown())
        .optional()
        .describe(
          "Initial state for an interactive page, readable in the page as board.state. Applied only when the tab has no state yet, so re-showing a page never resets what the user has changed."
        ),
    },
    async ({ key, title, html, assets, pin, state, background, folder }) => {
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
        folder,
        assets: resolvedAssets.length ? resolvedAssets : undefined,
      });
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const payload = data as {
        created?: boolean;
        closed?: boolean;
        titleKept?: boolean;
        tab: { id: string; key: string; title: string; folder: string | null; assets?: TabAsset[] };
      };
      const { tab } = payload;
      const closed = Boolean(payload.closed);
      if (activate) {
        const info = await health();
        if (!info || info.viewers === 0) {
          openBoard(boardUrl(tab.id));
        }
      }
      return jsonResult({
        created: Boolean(payload.created),
        open: !closed,
        id: tab.id,
        key: tab.key,
        title: tab.title,
        folder: tab.folder,
        ...(payload.titleKept ? { titleKept: true } : {}),
        url: boardUrl(tab.id),
        viewUrl: viewUrl(tab.id),
        assets: tab.assets ?? [],
        note: showNote(closed, activate, payload.titleKept, "Shown", "Updated"),
      });
    }
  );

  server.tool(
    "board_patch",
    "Patch snippets on an existing Agent Board page without rewriting the whole HTML. The page must already exist (open or closed) — this does not create a page. Each edit replaces an exact oldString with newString in the stored HTML. oldString must match exactly once unless replaceAll is true. Edits apply in order, atomically: if any edit fails, nothing changes, and the error shows where the stored text diverged from your oldString. Does not clear wait signals or page state. Default: focus the tab (and reopen it if closed). Pass background: true to patch without focusing. Prefer this over board_show when you are changing a few snippets. If you showed a fragment, the stored page is a wrapped full document — match the body you wrote, not the wrapper. For a large page, check it out with board_read toFile: true, edit that file with your file tools, then pass htmlPath (and the checkout's revision as expectedRevision) instead of edits.",
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
        .optional()
        .describe("Replacements to apply in order. Each sees the result of the previous edit. Omit when only changing title or when passing htmlPath. Refused on pages bound to a template."),
      htmlPath: z
        .string()
        .optional()
        .describe(
          "Local HTML file that replaces the whole page, usually the path returned by board_read toFile: true after you edited it. Keeps title, page state, and wait signals. Mutually exclusive with edits."
        ),
      expectedRevision: z
        .number()
        .optional()
        .describe(
          "Refuse the change if the page's revision is no longer this one (someone else edited it). Pass the revision from board_read or the previous board_patch."
        ),
      title: z
        .string()
        .optional()
        .describe(
          "Optional new tab title. May be sent without edits to rename a tab, including a template-bound page. Ignored for 24h after the user renamed the page themselves (the result then has titleKept: true)."
        ),
      background: z
        .boolean()
        .optional()
        .describe(
          "If true, do not focus this tab and do not bring the board window forward. Open tab: unread blip on that tab. Closed page: stays closed, unread blip on Library. Omit (default) when the user should look at this tab — that also reopens a closed page in the strip."
        ),
    },
    async ({ id, key, edits, htmlPath, expectedRevision, title, background }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const hasEdits = Boolean(edits && edits.length > 0);
      if (hasEdits && htmlPath) {
        return errorResult("Pass either edits or htmlPath, not both");
      }
      if (!hasEdits && !htmlPath && !title) {
        return errorResult("Provide edits, htmlPath, or title");
      }
      let html: string | undefined;
      if (htmlPath) {
        try {
          html = stripBom(fs.readFileSync(path.resolve(htmlPath), "utf8"));
        } catch (err) {
          return errorResult(`Could not read htmlPath: ${(err as Error).message}`);
        }
      }
      const activate = background !== true;
      const { status, data } = await api("POST", `/api/tabs/${encodeURIComponent(which)}/patch`, {
        edits: hasEdits ? edits : undefined,
        html,
        expectedRevision,
        title,
        activate,
      });
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const payload = data as {
        applied: number;
        closed: boolean;
        titleKept?: boolean;
        tab: { id: string; key: string; title: string; revision: number; htmlBytes: number; folder: string | null };
      };
      if (activate) {
        const info = await health();
        if (!info || info.viewers === 0) {
          openBoard(boardUrl(payload.tab.id));
        }
      }
      return jsonResult({
        applied: payload.applied,
        open: !payload.closed,
        id: payload.tab.id,
        key: payload.tab.key,
        title: payload.tab.title,
        folder: payload.tab.folder,
        ...(payload.titleKept ? { titleKept: true } : {}),
        revision: payload.tab.revision,
        htmlBytes: payload.tab.htmlBytes,
        url: boardUrl(payload.tab.id),
        viewUrl: viewUrl(payload.tab.id),
        note: showNote(payload.closed, activate, payload.titleKept, "Patched", "Patched"),
      });
    }
  );

  server.tool(
    "board_list",
    "List or search open tabs only. Omit query to list every open tab (id, key, title, folder, pinned, dates, size) plus activeId and closedCount — not paged. Pass query to search title, key, visible page text, and JSON state (same rules as board_library). Closed pages are never included; if the page is missing and closedCount > 0, call board_library with the same query (it searches every page). Do not invent a key. If board_library is missing, the MCP is stale — tell the user to reload it.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Keywords to search open tabs. Prefer distinctive words (jira). Every remaining word must match. Searches title, key, page text, and JSON state. Omit to list every open tab."
        ),
    },
    { readOnlyHint: true },
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
        closedCount?: number;
        matchCount?: number;
        returned?: number;
        remaining?: number;
        openCount?: number;
      };
      const closedCount = payload.closedCount ?? 0;
      const searched = Boolean(query?.trim());
      return jsonResult({
        tabs: (payload.tabs ?? []).map((tab) => {
          const dates = withAgentDates(tab);
          return searched ? { ...dates, snippet: tab.snippet ?? null } : dates;
        }),
        activeId: payload.activeId,
        closedCount,
        ...(searched
          ? {
              returned: payload.returned,
              remaining: payload.remaining,
              matchCount: payload.matchCount,
              openCount: payload.openCount,
            }
          : {}),
        note: searched
          ? `Searched open tabs only (${payload.matchCount ?? 0} match(es) of ${payload.openCount ?? 0}). Closed pages are not included` +
            (closedCount > 0
              ? ` — call board_library with the same query to search every page (${closedCount} closed).`
              : ".")
          : closedCount > 0
            ? `${closedCount} closed page(s) are not listed here. Call board_library to page or search the whole Library.`
            : undefined,
      });
    }
  );

  server.tool(
    "board_library",
    "Page or search the Library: every page on the board, open or closed. Each row includes id, key, title, folder, open, dates, and a snippet when searching. Omit query to list in Library order (the user's folders and manual order; default 20 per page, max 50). Pass query to search: 1–3 distinctive words work best (jira, not my jira issues page). Filler words like my/page/tab are ignored; every remaining word must match. Searches title, key, visible page text, and JSON state; title matches rank first. Pass folder to limit to one folder and its subfolders. If remaining > 0, pass offset to get the next page. Do not dump the whole Library into context.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Keywords to search pages. Prefer distinctive title words (jira). Every remaining word must match. Searches title, key, page text, and JSON state. Omit to list in Library order."
        ),
      folder: z
        .string()
        .optional()
        .describe("Folder path like \"CLIMS/Releases\" to limit results to that folder and its subfolders."),
      offset: z.number().optional().describe("Skip this many matching pages. Default 0."),
      limit: z
        .number()
        .optional()
        .describe("Page size. Default 20, maximum 50."),
    },
    { readOnlyHint: true },
    async ({ query, folder, offset, limit }) => {
      const page = clampLibraryPage(offset, limit);
      const params = new URLSearchParams();
      if (query?.trim()) {
        params.set("query", query.trim());
      }
      if (folder?.trim()) {
        params.set("folder", folder.trim());
      }
      params.set("offset", String(page.offset));
      params.set("limit", String(page.limit));
      const { status, data } = await api("GET", `/api/library?${params.toString()}`);
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const payload = data as {
        tabs: Array<TabMeta & { snippet?: string | null; open: boolean; folder: string | null }>;
        returned: number;
        remaining: number;
        matchCount: number;
        total: number;
      };
      const searched = Boolean(query?.trim());
      return jsonResult({
        tabs: (payload.tabs ?? []).map((tab) => {
          const dates = withAgentDates(tab);
          return searched ? { ...dates, snippet: tab.snippet ?? null } : dates;
        }),
        returned: payload.returned,
        remaining: payload.remaining,
        matchCount: payload.matchCount,
        total: payload.total,
        note:
          payload.matchCount === payload.total
            ? `Returned ${payload.returned} of ${payload.total} pages; ${payload.remaining} after this page.`
            : `Returned ${payload.returned} of ${payload.matchCount} matches (${payload.total} pages); ${payload.remaining} matches after this page.`,
      });
    }
  );

  server.tool(
    "board_folders",
    "List the Library's folders as paths (e.g. \"CLIMS/Releases\"), depth-first in the user's order, each with the number of pages directly inside it. Use before board_show when a new page clearly belongs to an existing folder, then pass that exact path as folder. Also usable as the folder filter for board_library. Never create a new folder unless the user asked for one.",
    {},
    { readOnlyHint: true },
    async () => {
      const { status, data } = await api("GET", "/api/folders/tree");
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const folders = (data as { folders: Array<{ path: string; pages: number }> }).folders ?? [];
      return jsonResult({
        folders: folders.map(({ path, pages }) => ({ path, pages })),
        note: folders.length ? `${folders.length} folders.` : "The Library has no folders; new pages go to the root.",
      });
    }
  );

  server.tool(
    "board_open",
    "Open a closed Library page as a tab (appended to the strip and focused), or focus it if it is already open. Identify the page by id or key from board_library. The page stays where it is in the Library.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
    },
    async ({ id, key }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const { status, data } = await api("POST", `/api/tabs/${encodeURIComponent(which)}/open`, { activate: true });
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const payload = data as { tab: TabMeta & { folder: string | null }; closedCount: number };
      return jsonResult({
        ...withAgentDates(payload.tab),
        closedCount: payload.closedCount,
        note: "Open in the tab strip.",
      });
    }
  );

  server.tool(
    "board_read",
    "Read a board tab's title and HTML so you can revise it. Identify the tab by id or key. Works on open and closed pages without opening them. The HTML comes back as a second, unescaped text block, so copy oldStrings from it verbatim. For a large page (tens of KB) or a big rewrite, pass toFile: true instead: the HTML is written to a temp file and only its path and revision are returned. Edit that file with your normal file tools, then check it in with board_patch htmlPath + expectedRevision. The checkout is scratch, not a workspace file.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
      toFile: z
        .boolean()
        .optional()
        .describe(
          "Check the page out to a temp file instead of returning the HTML. Returns path and revision for board_patch htmlPath + expectedRevision. Overwrites any earlier checkout of the same key."
        ),
    },
    { readOnlyHint: true },
    async ({ id, key, toFile }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const { status, data } = await api("GET", `/api/tabs/${encodeURIComponent(which)}`);
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const tab = data as Tab & { folder: string | null; pageAssets?: PageAssetUsage };
      const dates = withAgentDates(tab);
      const meta = {
        id: tab.id,
        key: tab.key,
        title: tab.title,
        folder: tab.folder,
        pinned: tab.pinned,
        open: !tab.closedAt,
        revision: tab.revision,
        htmlBytes: Buffer.byteLength(tab.html, "utf8"),
        createdAt: dates.createdAt,
        updatedAt: dates.updatedAt,
        ...(dates.closedAt ? { closedAt: dates.closedAt } : {}),
        viewUrl: viewUrl(tab.id),
        assets: tab.assets ?? [],
        ...(tab.pageAssets ? { pageAssets: tab.pageAssets } : {}),
        ...(tab.templateId
          ? {
              templateId: tab.templateId,
              templateValues: tab.templateValues ?? {},
              templateCompatible: tab.templateCompatible !== false,
              note: "This page is bound to a template. Do not edit its HTML — update the template with board_template_upsert.",
            }
          : {}),
      };
      if (toFile) {
        if (tab.templateId) {
          return errorResult("This page is bound to a template and cannot be checked out. Update the template instead.");
        }
        let file: string;
        try {
          file = writeCheckout(tab);
        } catch (err) {
          return errorResult(`Could not write checkout: ${(err as Error).message}`);
        }
        return jsonResult({
          ...meta,
          path: file,
          note: `Checked out. Edit the file, then board_patch({ key: "${tab.key}", htmlPath, expectedRevision: ${tab.revision} }).`,
        });
      }
      const result: ToolResult = {
        content: [
          { type: "text" as const, text: JSON.stringify(meta, null, 2) },
          { type: "text" as const, text: tab.html },
        ],
      };
      return tab.templateId ? withGuide(result, tab.id) : result;
    }
  );

  server.tool(
    "board_screenshot",
    "Capture a screenshot of a board page so you can visually inspect a UI design for the current project. Do not use this to polish investigation, analysis, or other throwaway information pages — those are shown once for the user to read. Returns an image of the page at a canonical viewport (1280x800 unless you pass width/height). Pass selector to capture one element, or fullPage for a tall page. Identify the tab by id or key (open or closed). Show or update the page with board_show first; pass background: true on board_show so the capture does not steal focus.",
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
    { readOnlyHint: true },
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
    "Read the live state of an interactive board page: what the user has actually added, edited, or checked off. Returns the state object plus stateRevision, which you pass back to board_set_state as expectedRevision, and the last signal (if any). Works whether or not the tab is focused, closed, or the browser is open. Do not poll this tool while waiting for the user — use board_wait.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Tab key used when the page was shown."),
      guide: z
        .boolean()
        .optional()
        .describe("Include the page's template guide even if it was already sent in this session."),
    },
    { readOnlyHint: true },
    async ({ id, key, guide }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const { status, data } = await api("GET", `/api/tabs/${encodeURIComponent(which)}/state`);
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const result = jsonResult(data);
      return (data as { templateId?: string }).templateId ? withGuide(result, which, guide === true) : result;
    }
  );

  server.tool(
    "board_wait",
    "Block until the board page fires a named signal (board.signal or data-board-signal), then return that signal plus the live state. Use this instead of polling board_get_state. Show the page with board_show first, then call this in the same turn with the same signal name the page fires. Default timeout is 10 minutes. If timedOut is true, tell the user you are still waiting and call board_wait again with the same afterSignalRevision. If closed is true, the user closed the tab (the page is still in the Library) — reopen it with board_open or stop. If deleted is true, the page was deleted; stop. If you already got a signal and need the next one without re-showing the page, pass that signal's revision as afterSignalRevision. board_show clears the last signal, so the next wait can omit afterSignalRevision.",
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
    { readOnlyHint: true },
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
        return withGuide(jsonResult(data), which);
      } catch (err) {
        return errorResult((err as Error).message || "board_wait failed");
      }
    }
  );

  server.tool(
    "board_set_state",
    "Update the state of an interactive board page without focusing or reopening it. An open page applies the write live without reloading. An unfocused open tab and a closed page both show an unread blip. Keys merge into the existing state, so send only what you are changing. Pass expectedRevision from board_get_state: if the user changed the page in the meantime the write is refused and the response carries their current state, so you can merge your change into it and retry. Never write a key the page uses for in-progress typing (by convention, draft). To put a local image or file into the page's data (an image on a todo item, a card, a gallery), pass it in assets and reference it as \"asset:<name>\" in state.",
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
      resolveIncompatibility: z
        .boolean()
        .optional()
        .describe(
          "If true, clear the template incompatibility overlay on this page after you have fixed its state. Only for pages bound to a template."
        ),
      assets: z
        .array(
          z.union([
            z.string().describe("Absolute or workspace-relative path to a local file."),
            z.object({
              path: z.string().describe("Absolute or workspace-relative path to a local file."),
              name: z.string().optional().describe("Name to use in asset:name. Defaults to the file's basename."),
            }),
          ])
        )
        .optional()
        .describe(
          "Local files (images or any other file, 32 MB each) to store as page assets. Put the whole string \"asset:<name>\" as a value in state wherever the file's URL belongs, e.g. { todos: [..., { images: [{ id: \"i1\", name: \"photo.png\", data: \"asset:photo.png\" }] }] }; it is replaced with a /blob/<id> URL the page can use as an img src. Every file must be referenced and every asset:<name> must have a file."
        ),
    },
    async ({ id, key, state, expectedRevision, replace, force, resolveIncompatibility, assets }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      let resolvedAssets: { path: string; name?: string }[] = [];
      try {
        resolvedAssets = resolveAssetPaths(assets);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      const guardRevision = force ? undefined : (expectedRevision ?? 0);
      const { status, data } = await api("PUT", `/api/tabs/${encodeURIComponent(which)}/state`, {
        state,
        replace,
        expectedRevision: guardRevision,
        resolveIncompatibility,
        ...(resolvedAssets.length ? { assets: resolvedAssets } : {}),
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
    "Close Agent Board tabs (same as the UI close button). The pages stay in the Library and can be reopened with board_open. Pass id or key for one tab, or unpinned/all to close several open tabs. Pass permanent: true to delete the page(s) instead (no confirmation); deleted pages stay in the user's Trash for 7 days, and Ctrl+Z restores the most recent delete (a bulk delete counts as one).",
    {
      id: z.string().optional().describe("Tab id to close or delete."),
      key: z.string().optional().describe("Tab key to close or delete."),
      unpinned: z.boolean().optional().describe("If true, close (or permanently delete) every open tab that is not pinned."),
      all: z.boolean().optional().describe("If true, close (or permanently delete) every open tab including pinned ones."),
      permanent: z
        .boolean()
        .optional()
        .describe("If true, delete the page instead of just closing its tab. Default false."),
    },
    { destructiveHint: true },
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

  server.tool(
    "board_template_upsert",
    "Create or update a reusable Agent Board template. Only use when the user explicitly asked to create or edit a board template. Built-in templates are read-only: to change one, use a new key (board_template_get the built-in for its HTML), or update its local copy (localId from board_template_list) if the user wants that copy changed. Updating a template re-renders every page created from it. Bump stateVersion when the page data shape changes so existing pages show an incompatibility overlay until you fix their state.",
    {
      key: z.string().optional().describe("Stable template identity. Reusing the same key updates that template."),
      title: z.string().describe("Name shown in the Templates sidebar."),
      description: z.string().optional().describe("Short blurb under the name in the template list."),
      html: z
        .string()
        .describe(
          "Template HTML. Use {{fieldKey}} for form values (HTML-escaped). Page scripts can also read board.template.values."
        ),
      fields: z
        .array(
          z.object({
            key: z.string().describe("Identifier used in {{key}} and board.template.values. JS identifier."),
            label: z.string().describe("Label on the Open / Edit form."),
            type: z.enum(["text", "textarea", "number", "select", "checkbox"]),
            required: z.boolean().optional(),
            placeholder: z.string().optional(),
            help: z.string().optional(),
            default: z.union([z.string(), z.number(), z.boolean()]).optional(),
            options: z
              .array(z.union([z.string(), z.object({ value: z.string(), label: z.string() })]))
              .optional()
              .describe("Required for select. Strings are used as both value and label."),
            min: z.number().optional(),
            max: z.number().optional(),
            maxLength: z
              .number()
              .int()
              .optional()
              .describe("Character limit for text/textarea values (default 500 / 4000, up to 65536)."),
          })
        )
        .optional()
        .describe("Form fields the user fills when opening or editing a page from this template."),
      titleTemplate: z
        .string()
        .optional()
        .describe('Tab title pattern, e.g. "{{title}}". Defaults to a field named title, or the template name.'),
      initialState: z
        .record(z.unknown())
        .optional()
        .describe("Seeded as board.state when a new page is opened from this template."),
      stateVersion: z
        .number()
        .optional()
        .describe("Integer >= 1. Bump when existing page data will not work with the new HTML."),
      guide: z
        .string()
        .optional()
        .describe(
          "Markdown for agents that later work with pages from this template: the state shape, signals the page fires, and conventions (how to add an item, which keys to leave alone). Tool results hand it to an agent the first time it touches such a page. Omit to keep the current guide; an empty string removes it."
        ),
      syncedWithBuiltin: z
        .boolean()
        .optional()
        .describe(
          "For a built-in's local copy with builtinUpdate: pass true once this upsert brings in the built-in's latest changes (board_template_get the built-in), to clear the flag."
        ),
    },
    async ({ key, title, html, fields, description, titleTemplate, initialState, stateVersion, guide, syncedWithBuiltin }) => {
      const { status, data } = await api("POST", "/api/templates", {
        key,
        title,
        html,
        fields,
        description,
        titleTemplate,
        initialState,
        stateVersion,
        guide,
        syncedWithBuiltin,
      });
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      return jsonResult(data);
    }
  );

  server.tool(
    "board_template_list",
    "List Agent Board templates (no HTML): the user's own under templates, and read-only built-ins that ship with the app under builtins (id builtin:<key>; localId is the user's copy, if any). builtinUpdate on a copy means its built-in changed and the copy was not updated automatically; see the agent-board skill's TEMPLATES.md before updating it. Only use when the user asked to work with board templates.",
    {},
    { readOnlyHint: true },
    async () => {
      const { status, data } = await api("GET", "/api/templates");
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      return jsonResult(data);
    }
  );

  server.tool(
    "board_template_get",
    "Read a template's HTML, fields, and metadata, including a built-in's. Only use when the user asked to work with board templates.",
    {
      id: z.string().optional().describe("Template id, e.g. tpl_ab12cd34 or builtin:todo-list."),
      key: z.string().optional().describe("Template key."),
    },
    { readOnlyHint: true },
    async ({ id, key }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const { status, data } = await api("GET", `/api/templates/${encodeURIComponent(which)}`);
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      return jsonResult(data);
    }
  );

  server.tool(
    "board_template_delete",
    "Delete a template. Pages created from it stay, keep their last HTML, and become ordinary editable pages. Only use when the user asked to delete a board template.",
    {
      id: z.string().optional().describe("Template id, e.g. tpl_ab12cd34."),
      key: z.string().optional().describe("Template key."),
    },
    { destructiveHint: true },
    async ({ id, key }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const { status, data } = await api("DELETE", `/api/templates/${encodeURIComponent(which)}`);
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      return jsonResult(data);
    }
  );

  server.tool(
    "board_template_open",
    "Create a pinned page from a template with the given form values. The user usually does this from the sidebar. Use only when they asked you to open an instance. Opening a built-in opens its local copy, creating that copy first if needed.",
    {
      id: z.string().optional().describe("Template id, e.g. tpl_ab12cd34 or builtin:todo-list."),
      key: z.string().optional().describe("Template key."),
      values: z.record(z.unknown()).optional().describe("Form values matching the template fields."),
    },
    async ({ id, key, values }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const { status, data } = await api("POST", `/api/templates/${encodeURIComponent(which)}/open`, {
        values: values ?? {},
      });
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const { tab, template, copiedBuiltin } = data as {
        tab: { id: string; key: string; title: string };
        template: { id: string; key: string };
        copiedBuiltin: boolean;
      };
      const info = await health();
      if (!info || info.viewers === 0) {
        openBoard(boardUrl(tab.id));
      }
      return withGuide(
        jsonResult({
          id: tab.id,
          key: tab.key,
          title: tab.title,
          url: boardUrl(tab.id),
          templateId: template.id,
          note: copiedBuiltin
            ? `Copied the built-in to the user's templates as ${template.key} and opened a pinned page from that copy.`
            : "Opened a pinned page from the template.",
        }),
        tab.id
      );
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

function showNote(closed: boolean, activate: boolean, titleKept: boolean | undefined, shown: string, updated: string): string {
  const base = closed
    ? `${updated} in the Library (tab closed). The unread blip is on Library, not the tab strip. Use board_open to bring it back.`
    : activate
      ? `${shown} on Agent Board. Do not write this HTML to a workspace file.`
      : `${updated} in the background. The unread blip is on that tab if it was not focused. Do not write this HTML to a workspace file.`;
  return titleKept ? `${base} The user renamed this page recently, so its title was kept.` : base;
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

/** The tab page on its own, outside the board's iframe, so a browser tool can drive it. */
function viewUrl(id: string): string {
  return `${contentBaseUrl()}/view/${encodeURIComponent(id)}`;
}

function writeCheckout(tab: Tab): string {
  const dir = path.join(os.tmpdir(), "agent-board");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeStem(tab.key)}.html`);
  fs.writeFileSync(file, tab.html, "utf8");
  return file;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
