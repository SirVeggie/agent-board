import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseAssetInputs } from "./assets.js";
import { safeStem } from "./boardExport.js";
import { VERSION, WAIT_HEARTBEAT_MS, baseUrl, contentBaseUrl } from "./config.js";
import { api, ensureDaemon, health, setAgentLabel } from "./daemon.js";
import { log } from "./log.js";
import { openBoard } from "./openBoard.js";
import { clampWaitMs, parseEventNames } from "./signal.js";
import { STATE_OP_NAMES, filterItems, getAt } from "./stateOps.js";
import { clampLibraryPage } from "./librarySearch.js";
import { withAgentDates } from "./dates.js";
import type { PageAssetUsage } from "./pageAssets.js";
import { MAX_INLINE_PAGE_IMAGES, collectStateImages, mcpImageMime } from "./mcpImages.js";
import type { Tab, TabAsset, TabMeta } from "./types.js";

type ApiError = { error?: string };

type ScreenshotPayload = {
  mimeType: "image/png" | "image/jpeg";
  data: string;
  width: number;
  height: number;
  fullPage: boolean;
  selector?: string;
  click?: string;
  fromViewer?: boolean;
  local?: boolean;
  embed?: boolean;
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
 * one-line pointer after that, instead of every template's guide living in the skill. In a Scribe
 * chat the daemon keeps that memory instead (sent), since the chat's prompt can carry guides too.
 */
const deliveredGuides = new Map<string, string>();

async function withGuide(result: ToolResult, which: string, force = false): Promise<ToolResult> {
  let guide: TemplateGuide | null = null;
  let sent: boolean | undefined;
  try {
    const { status, data } = await api("GET", `/api/tabs/${encodeURIComponent(which)}/guide?deliver=1${force ? "&force=1" : ""}`);
    if (status < 400) {
      ({ guide = null, sent } = data as { guide?: TemplateGuide | null; sent?: boolean });
    }
  } catch {
    return result;
  }
  if (!guide) {
    return result;
  }
  if (!force && (sent ?? deliveredGuides.get(guide.id) === guide.text)) {
    result.content.push({
      type: "text",
      text: `This page is a "${guide.title}" page. Its agent guide was sent earlier in this session; page_state with guide: true shows it again.`,
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

/** Clients show these to the model on connect, even when the scribe skill is not loaded. */
const INSTRUCTIONS = [
  "Scribe is a tabbed HTML viewer the user keeps open. Use it for standalone visual output (investigation results, analyses, comparisons, design options) and interactive pages whose state you read back (todo lists, checklists, reviews, forms, kanban boards). Prefer it over writing .html files into the workspace or the host's own canvas or artifact features, unless the user asked for those.",
  "Also use it whenever the user refers to something in Scribe: a page title, a pasted page key (keys look like scribe:some-page; pass it as key to page_read / page_patch / page_state as is), or their todo list or kanban.",
  "If the scribe skill is available, load it before building or changing pages; it has the full rules.",
  "Show a page once with page_show and a stable key; for small edits to an existing page use page_patch, not a full re-show. Do not replace a page's content with a continuation: close it and show a new key. Pass background: true when creating a page the user will open from a link (a form, investigation, or evidence) rather than look at now — a new background page stays in the Library, not the tab strip.",
  "Find pages by title with page_list (open tabs), then library_search (every page). Never guess a key.",
  "Pages keep user data in page state (scribe.state / scribe.update / scribe.bind in the page). Read it with page_state (pass path to read one part), change it with page_update ops, or with page_action when the page's template has actions (its guide lists them). Never use localStorage in a page.",
  "Pages can link to each other by key: <a data-scribe-open=\"scribe:key\" data-scribe-mode=\"peek\">. Use peek for a quick look at evidence or references, split for side-by-side reading, and no mode when the user should go to that page. Plain hrefs to websites open the browser. Link only to keys you created or found with page_list / library_search.",
  "When the page asks the user to submit, choose, or finish something, call page_wait next with the event name the page sends. Never poll page_state.",
  "Only use page_screenshot for UI designs that belong to the current project, never to polish information pages.",
  "Do not create, edit, or delete templates unless the user asked. Pages from a template come with an agent guide in tool results; follow it.",
].join(" ");

export async function startMcp(): Promise<void> {
  await ensureDaemon();
  const server = new McpServer({ name: "scribe", version: VERSION }, { instructions: INSTRUCTIONS });
  // Claims on cards show who holds them; the client's own name is the best label we get.
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    if (client?.name) {
      setAgentLabel(client.name);
    }
  };

  server.tool(
    "page_show",
    "Present an HTML page in Scribe, the user's local page viewer. Creates a page or replaces the page with the same key (whether its tab is open or closed). Every page lives in the Library; the tab strip is just the pages currently open. Default: focus the tab, reopen it if closed, and open the browser only if nothing is viewing Scribe. Pass background: true to skip focus and the strip for a new page (created in the Library with a Library blip); an already-open tab stays in the background with an unread blip; an already-closed page stays closed with a Library blip. Use background when creating a page the user will open from a link rather than look at now. This is the only tool needed to show a page — do not follow it with a separate open or refresh. Prefer this over writing HTML files. Pass a full HTML document or a fragment. To show a user image file, pass assets (local paths) and reference them as asset:name in the HTML. Reuse key when updating the same topic. For a small change to an existing page, prefer page_patch instead of rewriting html.",
    {
      key: z
        .string()
        .optional()
        .describe("Stable identity for this page, e.g. sprint-notes; Scribe stores it as scribe:sprint-notes. Reusing the same key updates that page instead of opening another."),
      title: z.string().describe("Tab title shown in Scribe."),
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
          "If true, do not focus this tab and do not bring the Scribe window forward. A new page is created in the Library without opening a tab (unread blip on Library). An already-open tab stays open with an unread blip; an already-closed page stays closed with a Library blip. Use when the user said in the background / don’t switch tabs, for a page you will link to rather than put in front of them, and for private screenshot loops. Omit (default) when the user should look at this tab — that also reopens a closed page in the strip."
        ),
      pin: z.boolean().optional().describe("Pin the tab so Clear/close-unpinned will keep it."),
      folder: z
        .string()
        .optional()
        .describe(
          "Library folder path for a new page, e.g. \"CLIMS/Releases\" (created if missing). Only used when the page is created; never moves an existing page — the user organizes the Library. Pass an existing path from library_folders when the new page clearly belongs there, or a new path only when the user asked for that folder. Otherwise omit (the page lands in the Library root)."
        ),
      state: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Initial state for an interactive page, readable in the page as scribe.state. Applied only when the tab has no state yet, so re-showing a page never resets what the user has changed."
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
        note: showNote(closed, activate, payload.titleKept, "Shown", "Updated", Boolean(payload.created)),
      });
    }
  );

  server.tool(
    "page_patch",
    "Patch snippets on an existing Scribe page without rewriting the whole HTML. The page must already exist (open or closed) — this does not create a page. Each edit replaces an exact oldString with newString in the stored HTML. oldString must match exactly once unless replaceAll is true. Edits apply in order, atomically: if any edit fails, nothing changes, and the error shows where the stored text diverged from your oldString. Does not change page state or events. Default: focus the tab (and reopen it if closed). Pass background: true to patch without focusing. Prefer this over page_show when you are changing a few snippets. If you showed a fragment, the stored page is a wrapped full document — match the body you wrote, not the wrapper. For a large page, check it out with page_read toFile: true, edit that file with your file tools, then pass htmlPath (and the checkout's revision as expectedRevision) instead of edits.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Page key, e.g. scribe:sprint-notes (the scribe: prefix is optional)."),
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
          "Local HTML file that replaces the whole page, usually the path returned by page_read toFile: true after you edited it. Keeps title, page state, and events. Mutually exclusive with edits."
        ),
      expectedRevision: z
        .number()
        .optional()
        .describe(
          "Refuse the change if the page's revision is no longer this one (someone else edited it). Pass the revision from page_read or the previous page_patch."
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
          "If true, do not focus this tab and do not bring the Scribe window forward. Open tab: unread blip on that tab. Closed page: stays closed, unread blip on Library. Omit (default) when the user should look at this tab — that also reopens a closed page in the strip."
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
    "page_list",
    "List or search open tabs only. Omit query to list every open tab (id, key, title, folder, pinned, dates, size) plus activeId and closedCount — not paged. Pass query to search title, key, visible page text, and JSON state (same rules as library_search). Closed pages are never included; if the page is missing and closedCount > 0, call library_search with the same query (it searches every page). Do not invent a key. If library_search is missing, the MCP is stale — tell the user to reload it.",
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
              ? ` — call library_search with the same query to search every page (${closedCount} closed).`
              : ".")
          : closedCount > 0
            ? `${closedCount} closed page(s) are not listed here. Call library_search to page or search the whole Library.`
            : undefined,
      });
    }
  );

  server.tool(
    "library_search",
    "Page or search the Library: every page in Scribe, open or closed. Each row includes id, key, title, folder, open, dates, and a snippet when searching. Omit query to list in Library order (the user's folders and manual order; default 20 per page, max 50). Pass query to search: 1–3 distinctive words work best (jira, not my jira issues page). Filler words like my/page/tab are ignored; every remaining word must match. Searches title, key, visible page text, and JSON state; title matches rank first. Pass folder to limit to one folder and its subfolders. If remaining > 0, pass offset to get the next page. Do not dump the whole Library into context.",
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
    "library_folders",
    "List the Library's folders as paths (e.g. \"CLIMS/Releases\"), depth-first in the user's order, each with the number of pages directly inside it. Use before page_show when a new page clearly belongs to an existing folder, then pass that exact path as folder. Also usable as the folder filter for library_search. Never create a new folder unless the user asked for one.",
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
    "page_open",
    "Open a closed Library page as a tab (appended to the strip and focused), or focus it if it is already open. Identify the page by id or key from library_search. The page stays where it is in the Library.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Page key, e.g. scribe:sprint-notes (the scribe: prefix is optional)."),
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
    "page_read",
    "Read a page's title and HTML so you can revise it. Identify the tab by id or key. Works on open and closed pages without opening them. The HTML comes back as a second, unescaped text block, so copy oldStrings from it verbatim. For a large page (tens of KB) or a big rewrite, pass toFile: true instead: the HTML is written to a temp file and only its path and revision are returned. Edit that file with your normal file tools, then check it in with page_patch htmlPath + expectedRevision. The checkout is scratch, not a workspace file.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Page key, e.g. scribe:sprint-notes (the scribe: prefix is optional)."),
      toFile: z
        .boolean()
        .optional()
        .describe(
          "Check the page out to a temp file instead of returning the HTML. Returns path and revision for page_patch htmlPath + expectedRevision. Overwrites any earlier checkout of the same key."
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
              note: "This page is bound to a template. Do not edit its HTML — update the template with template_upsert.",
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
          note: `Checked out. Edit the file, then page_patch({ key: "${tab.key}", htmlPath, expectedRevision: ${tab.revision} }).`,
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
    "page_screenshot",
    "Capture a screenshot of a page so you can visually inspect a UI design for the current project. Do not use this to polish investigation, analysis, or other throwaway information pages — those are shown once for the user to read. Returns an image of the page at a canonical viewport (1280x800 unless you pass width/height). Pass selector to capture one element, or fullPage for a tall page. Pass local to seed scribe.local for this capture only (view switchers, open panels), fromViewer to start from the user's last local, or click a selector after load. Embed-template pages are captured at the embedded URL. Identify the tab by id or key (open or closed). Show or update the page with page_show first; pass background: true on page_show so the capture does not steal focus.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Page key, e.g. scribe:sprint-notes (the scribe: prefix is optional)."),
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
      local: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Seeded into scribe.local for this capture only, so you can screenshot a view switcher or open panel without editing the page. Not saved as a viewer. Overlay on fromViewer when both are set. Ignored (refused) on embed-template pages."
        ),
      fromViewer: z
        .boolean()
        .optional()
        .describe(
          "If true, start from the most recently written viewer local for this page (what the user last had in the desktop app or a browser). Combine with local to overlay fields. Does not use the live window's scroll, hover, or size."
        ),
      click: z
        .string()
        .optional()
        .describe(
          "CSS selector to click after load, before capture. First match, must be visible. Prefer local when the view lives in scribe.local — a click that calls scribe.set will persist shared state."
        ),
    },
    { readOnlyHint: true },
    async ({ id, key, selector, fullPage, width, height, local, fromViewer, click }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      try {
        const { status, data } = await api(
          "POST",
          `/api/tabs/${encodeURIComponent(which)}/screenshot`,
          { selector, fullPage, width, height, local, fromViewer, click },
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
                  click: shot.click ?? null,
                  fromViewer: shot.fromViewer ?? false,
                  local: shot.local ?? false,
                  embed: shot.embed ?? false,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult((err as Error).message || "page_screenshot failed");
      }
    }
  );

  server.tool(
    "page_state",
    "Read the live state of an interactive page: what the user has actually added, edited, or checked off. Returns the state (or, with path, just that part), stateRevision, and eventCursor (pass it to page_wait to wait for events after this read). Works whether or not the tab is focused, closed, or the browser is open. On a page with large arrays, read one part: path \"cards/num=12\", or path \"cards\" with where. Images on a single card or todo are attached so you can see them; a whole-board read does not inline every cover. Pages with template actions often have a cheaper list action. Do not poll this tool while waiting for the user — use page_wait.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Page key, e.g. scribe:sprint-notes."),
      path: z
        .string()
        .optional()
        .describe(
          `Return only the value at this path. "/"-separated: a key on an object; on an array an item's id ("cards/c_12ab"), a field=value match ("cards/num=31"), or "#<index>". Same paths as page_update ops.`
        ),
      where: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(`With a path to an array: only the items whose fields equal these values, e.g. path "cards", where { col: "col_ab12" }.`),
      guide: z
        .boolean()
        .optional()
        .describe("Include the page's template guide even if it was already sent in this session."),
    },
    { readOnlyHint: true },
    async ({ id, key, path: statePath, where, guide }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const { status, data } = await api("GET", `/api/tabs/${encodeURIComponent(which)}/state`);
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      let view: unknown = data;
      if (statePath !== undefined || where !== undefined) {
        const { state, ...rest } = data as { state: unknown } & Record<string, unknown>;
        try {
          let value = statePath ? getAt(state, statePath) : state;
          if (where) {
            value = filterItems(value, where);
          }
          view = { ...rest, path: statePath ?? "", ...(where ? { where } : {}), value };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }
      const result = await withImages(jsonResult(view), view, which);
      return (data as { templateId?: string }).templateId ? withGuide(result, which, guide === true) : result;
    }
  );

  server.tool(
    "page_wait",
    "Block until the page logs an event (scribe.signal(name, data) or data-scribe-signal in the page; Scribe itself logs some too, like claim_lost), then return the matching events, oldest first, and a cursor. Events carry a small data payload (e.g. { card: \"c_12\" }), not the page's state: read what you need with page_state path or a page action. Pass the returned cursor as after on the next wait so no event is missed or seen twice; without after, only events from now on count. Optional where matches fields on event data (e.g. { column: \"grok issues\" }). Use this instead of polling page_state. Default timeout is 2 hours. If timedOut is true, tell the user you are still waiting and call page_wait again with the same after. If closed is true, the user closed the tab (the page is still in the Library) — reopen it with page_open or stop. If deleted is true, the page was deleted; stop. missed: true means older events dropped out of the log (it keeps the last 500): scan the page's state instead.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Page key, e.g. scribe:sprint-notes."),
      events: z
        .string()
        .optional()
        .describe(
          "Event names to wait for, comma-separated (approved,rejected). Must match scribe.signal(\"name\") or data-scribe-signal=\"name\" in the page. Omit to wake on any event."
        ),
      after: z
        .number()
        .optional()
        .describe(
          "Cursor from the previous page_wait (or eventCursor from page_state). Events at or below it are skipped. Omit to wait only for new events."
        ),
      timeoutMs: z
        .number()
        .optional()
        .describe("How long to wait, in milliseconds. Defaults to 7200000 (2 hours). There is no maximum; the user can interrupt you at any time."),
      where: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
          `Match fields on each event's data (compared as text), e.g. { column: "grok issues" } so card_ready for another agent column does not wake you. Omit to accept any payload.`
        ),
    },
    { readOnlyHint: true },
    async ({ id, key, events, after, timeoutMs, where }, extra) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      let names: string[];
      try {
        names = parseEventNames(events);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      const waitMs = clampWaitMs(timeoutMs);
      // Clients abort a call that stays silent too long (Claude Code: 30 minutes for stdio), so report progress while waiting.
      const progressToken = extra._meta?.progressToken;
      const startedAt = Date.now();
      const label = names.length ? names.join(" or ") : "any event";
      const heartbeat =
        progressToken === undefined
          ? undefined
          : setInterval(() => {
              const seconds = Math.round((Date.now() - startedAt) / 1000);
              extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress: seconds, message: `Waiting for ${label} (${seconds}s)` },
                })
                .catch(() => {});
            }, WAIT_HEARTBEAT_MS);
      try {
        const { status, data } = await api(
          "POST",
          `/api/tabs/${encodeURIComponent(which)}/wait`,
          { events: names, ...(after !== undefined ? { after } : {}), timeoutMs: waitMs, ...(where ? { where } : {}) },
          { timeoutMs: waitMs + 15_000, signal: extra.signal }
        );
        if (status >= 400) {
          return errorResult((data as ApiError).error || `HTTP ${status}`);
        }
        return withGuide(jsonResult(data), which);
      } catch (err) {
        return errorResult((err as Error).message || "page_wait failed");
      } finally {
        clearInterval(heartbeat);
      }
    }
  );

  server.tool(
    "page_update",
    "Change an interactive page's state with ops, without focusing or reopening it. An open page applies them live; an unfocused tab or a closed page shows an unread blip. Ops address items by path, so you send only what changes: merge one card, insert one comment, move one item, set one key. They apply in order, all or nothing (if one fails, nothing changes and the error names it), to the latest state, so you don't need expectedRevision unless your edit depends on a value you read. Replace a whole top-level key with { op: \"set\", path: \"todos\", value: [...] }. When the page's template has actions (its guide lists them), prefer page_action: it applies the page's rules for you. Never write a key the page uses for in-progress typing (by convention, draft). To put a local file into the page's data (an image on a todo item or a card), pass it in assets and write \"asset:<name>\" as the value where its URL belongs.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Page key, e.g. scribe:sprint-notes."),
      ops: z
        .array(
          z.object({
            op: z
              .enum(STATE_OP_NAMES)
              .describe(
                "set: put value at path (an object key, or replace an array item; path \"\" replaces the whole state). merge: copy value's fields onto the object at path; a null field removes that key. remove: delete the key or array item at path. insert: add value to the array at path (created if missing). move: reposition the array item at path within its array. test: fail the whole write unless the value at path equals value (null matches a missing value)."
              ),
            path: z
              .string()
              .describe(
                `"/"-separated. On an object a segment is a key; on an array it picks an item by id ("cards/c_12ab"), by field=value ("cards/num=31"), or by "#<index>". Examples: merge "cards/num=31", insert "cards/num=31/comments", set "nextNum".`
              ),
            value: z.unknown().optional().describe("For set, merge, insert, test."),
            before: z
              .string()
              .optional()
              .describe(`For insert and move: place before the first item matching this selector, e.g. "col=col_ab12". No match places at the end.`),
            after: z.string().optional().describe("For insert and move: place after the item matching this selector. No match places at the end."),
            at: z
              .union([z.enum(["start", "end"]), z.number().int().min(0)])
              .optional()
              .describe(`For insert and move: "start", "end" (default), or an index.`),
          })
        )
        .describe("The changes, applied in order."),
      expectedRevision: z
        .number()
        .optional()
        .describe("Refuse the write if the page's stateRevision is no longer this one. Only needed when your edit depends on a value you read."),
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
          "Local files (images or any other file, 32 MB each) to store as page assets. Write the whole string \"asset:<name>\" as a value in an op wherever the file's URL belongs, e.g. { op: \"insert\", path: \"todos/t_1/images\", value: { id: \"i1\", name: \"photo.png\", data: \"asset:photo.png\" } }; it becomes a /blob/<id> URL the page can use as an img src. Every file must be referenced and every asset:<name> must have a file."
        ),
    },
    async ({ id, key, ops, expectedRevision, resolveIncompatibility, assets }) => {
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
      const { status, data } = await api("PUT", `/api/tabs/${encodeURIComponent(which)}/state`, {
        ops,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        resolveIncompatibility,
        ...(resolvedAssets.length ? { assets: resolvedAssets } : {}),
      });
      if (status === 409) {
        const conflict = data as { stateRevision: number };
        return errorResult(
          `Conflict: the page changed since revision ${expectedRevision}. Current stateRevision is ${conflict.stateRevision}. Re-read what your ops depend on (page_state with path) and retry.`
        );
      }
      if (status >= 400) {
        return errorResult((data as ApiError).error || `HTTP ${status}`);
      }
      const { applied, ...rest } = data as { applied?: unknown[] } & Record<string, unknown>;
      return withGuide(jsonResult({ ok: true, ...rest, applied: applied?.length ?? 0 }), which);
    }
  );

  server.tool(
    "page_action",
    "Run one of the page template's actions, e.g. on a Kanban board: list, get, create, comment, move, claim, finish. Actions apply the page's own rules (timestamps, ordering, numbering, who holds a card) in one atomic step, and read the latest state, so there's nothing to merge or retry. The page's agent guide lists its actions and their arguments; an unknown action name returns the list. Pages without a template (or with a template that has no actions) use page_update. get attaches images on the card or item so you can see them.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Page key, e.g. scribe:agent-todo."),
      action: z.string().describe("Action name from the page's guide."),
      args: z.record(z.string(), z.unknown()).optional().describe("The action's arguments, as the guide lists them."),
    },
    async ({ id, key, action, args }) => {
      const which = id || key;
      if (!which) {
        return errorResult("Provide id or key");
      }
      const { status, data } = await api("POST", `/api/tabs/${encodeURIComponent(which)}/action`, { action, args: args ?? {} });
      if (status >= 400) {
        return withGuide(errorResult((data as ApiError).error || `HTTP ${status}`), which);
      }
      return withGuide(await withImages(jsonResult(data), data, which), which);
    }
  );

  server.tool(
    "page_pin",
    "Pin an Scribe tab so Clear and close-unpinned keep it. Identify the tab by id or key.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Page key, e.g. scribe:sprint-notes (the scribe: prefix is optional)."),
    },
    async ({ id, key }) => pinResult(id || key, true)
  );

  server.tool(
    "page_unpin",
    "Unpin an Scribe tab so Clear and close-unpinned can close it. Identify the tab by id or key.",
    {
      id: z.string().optional().describe("Tab id, e.g. t_ab12cd34."),
      key: z.string().optional().describe("Page key, e.g. scribe:sprint-notes (the scribe: prefix is optional)."),
    },
    async ({ id, key }) => pinResult(id || key, false)
  );

  server.tool(
    "page_close",
    "Close Scribe tabs (same as the UI close button). The pages stay in the Library and can be reopened with page_open. Pass id or key for one tab, or unpinned/all to close several open tabs. Pass permanent: true to delete the page(s) instead (no confirmation); deleted pages stay in the user's Trash for 7 days, and Ctrl+Z restores the most recent delete (a bulk delete counts as one).",
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
    "template_upsert",
    "Create or update a reusable Scribe template. Only use when the user explicitly asked to create or edit a Scribe template. Built-in templates are read-only: to change one, use a new key (template_get the built-in for its HTML), or update its local copy (localId from template_list) if the user wants that copy changed. Updating a template re-renders every page created from it. Bump stateVersion when the page data shape changes so existing pages show an incompatibility overlay until you fix their state.",
    {
      key: z.string().optional().describe("Stable template identity. Reusing the same key updates that template."),
      title: z.string().describe("Name shown in the Templates sidebar."),
      description: z.string().optional().describe("Short blurb under the name in the template list."),
      html: z
        .string()
        .describe(
          "Template HTML. Use {{fieldKey}} for form values (HTML-escaped). Page scripts can also read scribe.template.values."
        ),
      fields: z
        .array(
          z.object({
            key: z.string().describe("Identifier used in {{key}} and scribe.template.values. JS identifier."),
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
        .record(z.string(), z.unknown())
        .optional()
        .describe("Seeded as scribe.state when a new page is opened from this template."),
      stateVersion: z
        .number()
        .optional()
        .describe("Integer >= 1. Bump when existing page data will not work with the new HTML."),
      guide: z
        .string()
        .optional()
        .describe(
          "Markdown for agents that later work with pages from this template: the state shape, events the page sends, and conventions (how to add an item, which keys to leave alone). Tool results hand it to an agent the first time it touches such a page. Omit to keep the current guide; an empty string removes it."
        ),
      syncedWithBuiltin: z
        .boolean()
        .optional()
        .describe(
          "For a built-in's local copy with builtinUpdate: pass true once this upsert brings in the built-in's latest changes (template_get the built-in), to clear the flag."
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
    "template_list",
    "List Scribe templates (no HTML): the user's own under templates, and read-only built-ins that ship with the app under builtins (id builtin:<key>; localId is the user's copy, if any). builtinUpdate on a copy means its built-in changed and the copy was not updated automatically; see the scribe skill's TEMPLATES.md before updating it. Only use when the user asked to work with Scribe templates.",
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
    "template_get",
    "Read a template's HTML, fields, and metadata, including a built-in's. Only use when the user asked to work with Scribe templates.",
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
    "template_delete",
    "Delete a template. Pages created from it stay, keep their last HTML, and become ordinary editable pages. Only use when the user asked to delete a Scribe template.",
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
    "template_open",
    "Create a pinned page from a template with the given form values. The user usually does this from the sidebar. Use only when they asked you to open an instance. Opening a built-in opens its local copy, creating that copy first if needed.",
    {
      id: z.string().optional().describe("Template id, e.g. tpl_ab12cd34 or builtin:todo-list."),
      key: z.string().optional().describe("Template key."),
      values: z.record(z.string(), z.unknown()).optional().describe("Form values matching the template fields."),
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

function showNote(
  closed: boolean,
  activate: boolean,
  titleKept: boolean | undefined,
  shown: string,
  updated: string,
  created = false
): string {
  const base = closed
    ? created
      ? "Created in the Library (not on the tab strip). The unread blip is on Library. Link the page, or use page_open if the user should see a tab."
      : `${updated} in the Library (tab closed). The unread blip is on Library, not the tab strip. Use page_open to bring it back.`
    : activate
      ? `${shown} on Scribe. Do not write this HTML to a workspace file.`
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
  const dir = path.join(os.tmpdir(), "scribe");
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

/**
 * Attach raster images found on one card or todo in a tool's JSON so the model can see
 * them. A whole-board dump is left as `/blob/` URLs; get one item to inline its photos.
 */
async function withImages(result: ToolResult, value: unknown, which: string): Promise<ToolResult> {
  const refs = collectStateImages(value);
  if (!refs.length) {
    return result;
  }
  const picked = refs.slice(0, MAX_INLINE_PAGE_IMAGES);
  const notes: string[] = [];
  if (refs.length > picked.length) {
    notes.push(
      `${refs.length} images in this result; inlining the first ${picked.length}. Read one card or item with get to see the rest.`
    );
  }
  for (const ref of picked) {
    try {
      const { status, data } = await api(
        "GET",
        `/api/tabs/${encodeURIComponent(which)}/assets/${encodeURIComponent(ref.assetId)}`
      );
      if (status >= 400) {
        notes.push(`${ref.name}: ${(data as ApiError).error || `HTTP ${status}`}`);
        continue;
      }
      const asset = data as { mimeType?: string; data?: string; skipped?: string };
      if (asset.skipped || !asset.data) {
        notes.push(`${ref.name}: ${asset.skipped || "not inlined"}`);
        continue;
      }
      const label = ref.id ? `${ref.name} (${ref.id})` : ref.name;
      result.content.push({ type: "text", text: `Attached image: ${label}` });
      result.content.push({
        type: "image",
        mimeType: mcpImageMime(asset.mimeType || "image/png"),
        data: asset.data,
      });
    } catch (err) {
      notes.push(`${ref.name}: ${(err as Error).message}`);
    }
  }
  if (notes.length) {
    result.content.push({ type: "text", text: notes.join("\n") });
  }
  return result;
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
