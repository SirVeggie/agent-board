---
name: scribe
description: Present investigation results, analyses, design suggestions, comparisons, and other structured visual HTML in Scribe, the user's local page viewer, via the scribe MCP (page_* tools). Also use for interactive pages whose state you want to read back or wait on, such as todo lists, checklists, reviews, forms, and kanban boards, and whenever the user refers to something already in Scribe, such as a page by title, a pasted page key (scribe:some-page), or their todo list or kanban, to read or change it. Prefer it over workspace .html files and the host's own canvas or artifact features unless the user asked for those. Use page_screenshot only when iterating on a UI design meant for the current project, never to polish throwaway information pages.
---

# Scribe

A localhost tabbed HTML viewer the user keeps open. Drive it with the `scribe` MCP. Do **not** write one-off HTML files into the workspace for presentation.

Some hosts list MCP tools as deferred: load the `page_*` tools you need with your tool search first. Only if `page_show` is truly absent, the MCP is not connected: tell the user to reload MCP servers in their client's MCP config, and fall back to a concise chat summary.

If you only see `board_*` tools, or `page_list` exists but `page_action` does not even after loading, the MCP is stale. Tell the user to reload MCP. Do not invent keys or skip the Library.

## Library model

The **Library** holds every page in Scribe, organized by the user into folders and a manual order. The tab strip is just the pages that are currently **open**. Closing a tab keeps the page in the Library; only a delete removes it. The user owns the organization: never move pages between folders or reorder them.

A page titled **Instructions**, or marked **Use as folder instructions** in its tab menu, is standing instructions for agent threads scoped to that folder or to a page in it (parent folders too). Edits apply on the next turn. Global and workspace threads do not get them.

## When to use it

Use Scribe for standalone visual output: investigation results, analyses, design options, architecture notes, tables that should stay on screen, walkthroughs. Put those pages up and stop — do not screenshot them to tweak layout or type.

Use `page_screenshot` only when the page **is** the design work for this project (a UI mock, layout, or component the user asked you to design or implement). Then Scribe is the design surface and the screenshot is how you see it.

Skip Scribe for code edits, short factual answers, drafts meant to be copied, or when the user asked for a specific other artifact.

After a page is up, answer small follow-up questions in chat. Do not patch or re-show the page for a clarification, a yes/no, a short extra fact, or anything that does not need to stay on the page. Update the page when the user asked to change it, or when the new material is substantial enough to belong there.

Prefer Scribe over the host's own canvas or artifact features and over workspace `.html` files, unless the user asked for one of those.

## Find a page

**By pasted key**: page keys look like `scribe:sprint-notes`, and the user copies them from Scribe as is. Pass one as `key` straight to `page_read`, `page_patch`, `page_state`, etc. It works for open and closed pages; no search needed. A bare page id (`t_1a2b3c4d`) goes in `id`.

The user names pages by **title** (“my Jira issues page”). Keys are slugs chosen when the page was made. Never guess a key.

**By title** (usual):

1. `page_list` — every **open** tab. Each row has `id`, `key`, **`title`**, `folder`. Scan titles.
2. If it is not there and `closedCount` > 0, `library_search` (no query: Library order, default 20, max 50; if `remaining` > 0, pass `offset`). Pass `folder: "CLIMS/Releases"` when the user names a folder.

**By content** (body or JSON state, or the title scan missed it): `library_search({ query })`. It searches every page, open or closed; each row says whether it is `open` and which `folder` it is in.

Then `page_read` with that `id` or `key` when you need the HTML (works on closed pages without opening them). The HTML comes back as its own unescaped text block after the metadata — copy `oldString`s from it verbatim. Prefer `page_patch` over rewriting what you read. For a large page, check it out to a file instead (see below).

**Search keywords.** Use 1–3 distinctive words (`jira`, `clims-18595`, a phrase from the page or its state). Do not paste the whole utterance (`my jira issues page`). Filler like *my / page / tab / the* is ignored; every remaining word must match. Both tools search **title, key, visible page text, and JSON state**. Title matches rank first.

Do not dump the Library into context. Page it (default 20, max 50). The Library is not capped.

## Show or update

Before writing HTML or calling `page_show` / `page_patch`, mention in a new line that Scribe is being updated so the pause does not look like the chat stopped.

**Create or rewrite** with `page_show` once:

- `key`: stable slug for this page (reuse only for in-place edits of that same page, e.g. `clims-12345-analysis`). Scribe stores it as `scribe:clims-12345-analysis`; either form finds the page later.
- `title`: short tab label
- `html`: a complete HTML document with inline CSS, or a fragment (Scribe wraps fragments)
- `assets`: omit unless the page needs images
- `background`: omit when the user should look at this tab (default: focus, open it if it was closed, open the browser only if nothing is viewing Scribe). Pass `background: true` when they said *in the background*, *don’t switch tabs*, *stay where I am*, during a **project design** screenshot loop they should not see yet, or when creating a page you will **link to** (a form, investigation, or evidence) rather than put in front of them. A new page with `background: true` is created in the Library without opening a tab.
- `pin`: omit or false unless they hinted the tab should persist, or it is a keep-using app (todo list, reusable tool). Do not pin one-off investigations, designs, dumps, questionnaires, demos, or forms.
- `folder`: for a **new** page, call `library_folders` first and pass an existing path when the page clearly belongs there (e.g. a CLIMS release analysis → `"CLIMS/Releases"`). Pass a path that does not exist yet only when the user asked for that folder (it is created). Otherwise omit: new pages land at the top of the Library root. It only applies when the page is created; re-showing never moves a page.

If the result has `titleKept: true`, the user renamed that page in the last 24 hours and your `title` was ignored. Keep using their title; do not fight it.

**Small markup edits** to a page that already exists: `page_patch` (see below). Do not `page_show` the whole document again.

Do not pass a second tool to open or refresh. `background` is the only focus flag.

| User said | Call | After |
| --- | --- | --- |
| show me / put it in Scribe | `page_show` (default) | Focused. A closed page is opened on the strip. |
| create a page you will link to (form, investigation, evidence) | `page_show` with `background: true` | Created in the Library, not on the strip. Unread blip on Library. |
| update in the background / don’t switch | `page_show` or `page_patch` with `background: true` | New: Library only. Open: unread blip on that tab. Closed: stays closed, unread blip on Library. |
| tweak a section / fix a line / add a paragraph | `page_patch` | Same focus rules as show. Does not rewrite the rest of the page. |
| a small follow-up about what’s already on the page | nothing — answer in chat | Leave the tab as-is. |
| bring it back / open it | `page_open` | Strip, focused. |
| change todos / cards / notes / checklist | `page_action` if the page has actions, else `page_update` | Never focuses. Unread blip if they are not on that tab (open or closed). |

If `page_show` or `page_patch` returns `open: false`, tell the user the blip is on Library, not the tab strip.

Mention in chat that it is in Scribe, with the tab title. Do not paste the HTML into chat.

### Patch an existing page

Prefer `page_patch` when the tab already exists and you are changing a few snippets — a heading, a paragraph, a table row, a CSS rule. It is cheaper than rewriting `html` and will not accidentally clobber the rest of the page.

```
page_patch({
  key: "clims-12345-analysis",
  background: true,
  edits: [
    { oldString: "<p>Status: in progress</p>", newString: "<p>Status: ready</p>" },
    { oldString: "</section>", newString: "<h2>Next</h2><p>Ship it.</p></section>" }
  ]
})
```

Rules:

- Identify the tab by the same `key` (or `id`) you used in `page_show`. The tab must already exist — this does not create.
- `oldString` is an exact substring of the **stored** HTML. If you originally passed a fragment, the stored page is wrapped (doctype + default CSS); match the body you wrote, not the wrapper.
- Each `oldString` must match exactly once. If it matches several times, add surrounding context or pass `replaceAll: true`.
- Edits apply in order, atomically. A failure changes nothing. The error says how much of your `oldString` matched, at which line, and quotes the stored text where it diverged — fix the snippet from that. Do not retry with a guess.
- Do not `page_read` first when the original markup is still in the conversation.
- Pass `expectedRevision` (from `page_read` or the previous `page_patch` result) when the user may have changed the page since you read it. A stale revision is refused.
- Same `background` / focus rules as `page_show`. Does not change page state or events.
- Still `page_show` for a new page, new `assets`, or seeding `state`.

### Large pages: read a window, grep, patch

`page_read` does not return a page over 24 KB whole. It returns the size, line count and an outline (headings, sections, script/style blocks with line numbers). Work on it like a file:

```
page_grep({ key: "todo-page", pattern: "renderList", context: 2 })
  → 412:function renderList(items) {  (with 2 lines either side)

page_read({ key: "todo-page", offset: 400, limit: 60 })
  → lines 400–459, numbered "412	function renderList(items) {"

page_patch({ key: "todo-page", edits: [{ oldString: "...", newString: "..." }], expectedRevision: 23 })
```

- Line numbers are a prefix (number, tab), not part of the HTML. Leave them out of `oldString`.
- `pattern` is a JavaScript regex; pass `literal: true` to search plain text.
- `full: true` returns the whole page anyway. Use it rarely: it costs the whole page in context.
- This works in every mode and for every provider. It is the way to edit large pages in Pages mode, which has no file tools.

### Large rewrites with file tools: check out to a file

When you have file tools (Code mode) and are rewriting a big part of a large page, you can instead check it out, edit it with your normal file tools, and check it back in. Not in Pages mode: there are no file tools there, so the file cannot be edited.

```
page_read({ key: "todo-page", toFile: true })
  → { path: "C:/Users/me/AppData/Local/Temp/scribe/todo-page.html", revision: 23, ... }

// edit that path with your normal file tools

page_patch({ key: "todo-page", htmlPath: "<that path>", expectedRevision: 23, background: true })
```

- The checkout is a scratch copy in the system temp folder, not a workspace file. The tab stays the source of truth; the file is only for editing.
- Check-in replaces the whole HTML but keeps title, page state, and events (unlike `page_show`). `htmlPath` and `edits` are mutually exclusive.
- Always pass the checkout's `revision` as `expectedRevision`. If it is refused, the page moved: check out again and redo your edits on the fresh copy.
- Template-bound pages cannot be checked out.

### Updating vs replacing

Do not replace a page with a new page without asking, even if it is a continuation of the previous subject.

Allowed page edits without clear intention:
- some edits, additions or otherwise improving the page

Not allowed:
- replacing all or most of the page content
- replacing the page with a continuation

If the content page would change a lot, it is better to make a new page, otherwise the user loses the ability to refer back to some older information if they want. If the subject remains the same and is a continuation, instead of replacing the page directly, close the old tab (`page_close`, which keeps it in the Library) and create a new one with a new `key`.

## HTML

- Self-contained: inline CSS. Do not link workspace files as `<img src="./foo.png">` or `file://` — those do not load.
- Full documents start with `<!DOCTYPE html>` or `<html`.
- Keep pages focused. Typical size is well under 200 KB (hard limit 2 MB). Images passed via `assets` do not count toward that cap.
- Do not rely on the parent page's styles; tab content renders in an iframe.

## Linking pages

Pages can link to other Scribe pages and to websites. The user opens a link as a tab (navigate), a **peek** (a fixed card over the page, for a quick look without opening a tab), or a **split** (a pane beside the current tab). Links keep related pages connected instead of one page trying to hold everything.

```html
<a data-scribe-open="scribe:clims-12345-analysis">Analysis</a>                              <!-- no mode: the user's Settings (Navigate by default) -->
<a data-scribe-open="scribe:clims-12345-logs" data-scribe-mode="peek">raw logs</a>          <!-- a quick look -->
<a data-scribe-open="scribe:clims-12345-analysis#risks" data-scribe-mode="split">Risks</a>  <!-- beside this page, scrolled to id="risks" -->
<a href="https://tauri.app/reference/config/">Tauri config reference</a>                    <!-- a website: opens the browser -->
<a data-scribe-open="scribe:clims-12345-logs"></a>                                         <!-- empty: shows the target page's title -->
```

When to link:

- A summary page with the details on their own pages: link each finding to its evidence page with `peek`, so the user checks it without losing their place.
- A page the user will read side by side with another (a spec beside its review checklist, a diff beside its notes): `split`.
- A page the user should go and work on (their todo list, the next step's form): leave the mode off. Their Settings decide what a plain link does, and holding Ctrl, Shift, or Alt always overrides you.
- Existing pages the user already has: find them with `page_list` / `library_search` and link by their `key`.

Rules:

- Link by **key**: the keys you chose in `page_show`, or ones from `page_list` / `library_search`. Never guess a key. A link to a key with no page is struck through, and fixes itself as soon as a page with that key exists, so you may show a hub page before its detail pages as long as you create them in the same turn.
- `#anchor` scrolls the target to the element with that `id`. Give the target the id.
- A plain `href` to a website opens the browser. `data-scribe-mode="peek"` or `"split"` shows the site inside Scribe, but many sites refuse to be framed (GitHub, Google, most logins) and then show an Open in browser card instead. Sites the user is signed in to may appear signed out. Use peek or split for docs and references, not for apps.
- Do not use `target="_blank"` or scripts for navigation; the link attributes cover it. `scribe.open(target, { mode, anchor })` is the script form for a click handler (it resolves to `{ ok, mode, id }` or `{ ok: false, error: "not_found" | "in_trash" }`). It refuses calls outside a click or key press, so a page can never switch the user's view on load.
- `scribe.resolve([keys])` returns `{ key: { id, title, open } | null }`, for a page that builds its link list from state.
- The built-in Todo list, Kanban board and Markdown note link pages in titles, descriptions, and comments with `[[scribe:key]]` (shows the page's title), `[[scribe:key|text]]`, `[[peek:scribe:key]]`, or `[[split:scribe:key]]`, and `[text](scribe:key)` in markdown. A key or page id written on its own links too. Write these in their state, not raw HTML.
- In chat replies, link a page as `[[scribe:key]]` or `[label](scribe:key)`.
- You cannot open a peek or split yourself: `page_show` / `page_open` focus a tab. Links are for the user to follow.

## Images

User-provided image files (chat attachments, local paths) go on a page through `assets` on `page_show`. Reference them as `asset:<name>`:

```
page_show({
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

`page_screenshot` is for **designs that belong to the current project** — a mock, layout, or component the user asked you to design or ship. It is not a proofreader for information pages.

Do **not** screenshot investigation results, analyses, architecture notes, ticket dumps, checklists, walkthroughs, or any other throwaway information page. Show (or patch) those once. The user can see them. Polishing their spacing or type wastes tokens.

When it **is** project design work:

1. `page_show` with the same `key`, `background: true` (so a new page stays in the Library and does not steal focus).
2. `page_screenshot` with that `key`. Default is a 1280×800 viewport of the page.
3. Inspect the image. For a small markup change, `page_patch` with `background: true`. For a larger rewrite, `page_show` again with `background: true`. Then screenshot again.

```
page_show({ key: "hero", title: "Hero", html, background: true })
page_screenshot({ key: "hero" })
page_screenshot({ key: "hero", selector: ".hero" })   // one component
page_screenshot({ key: "hero", fullPage: true })      // tall page; height is capped
page_screenshot({ key: "hero", local: { view: "expanded" } })  // capture-only scribe.local
page_screenshot({ key: "hero", fromViewer: true })             // user's last local
page_screenshot({ key: "hero", click: "[data-view=idle]" })    // click, then capture
```

Rules:

- Always `background: true` on `page_show` / `page_patch` in this loop unless the user should look at the tab right now.
- Identify the tab by the same `key` (or `id`) you used in `page_show`.
- `selector` is a CSS selector; it captures the first match. If it is missing or not visible, the tool errors — fix the markup or selector, do not retry blindly.
- `local` is seeded into `scribe.local` for this capture only; it is not saved as a viewer. Overlay it on `fromViewer` when both are set. Prefer `local` over patching the page's default to check another view.
- `fromViewer` uses the most recently written viewer local, not the live window's scroll, hover, or size.
- `click` clicks a selector after load. Prefer `local` when the view lives in `scribe.local` — a click that calls `scribe.set` will persist shared state.
- Embed-template pages are captured at the embedded URL, not the placeholder HTML.
- After `page_update` or `page_patch`, screenshot again without re-showing the full HTML. The capture loads current HTML + state from the daemon.
- The image is a canonical viewport, not the user's window size, zoom, or currently focused tab. Inactive / hidden tabs still screenshot correctly.
- Do not pin design-test pages. Do not write the HTML to a workspace file.
- If `page_screenshot` is missing, the Scribe MCP is on an old build — tell the user to reload MCP after rebuilding the daemon.

When you are done iterating and the user should see the result, `page_show` or `page_patch` once more **without** `background` so the tab comes to the front.

## Testing interactions

Scribe shows each page in an iframe that browser tools cannot reach. To click, drag, type, or run a script in a page, open its `viewUrl` (returned by `page_show`, `page_patch`, and `page_read`) directly in a browser. There, the page runs on its own with a live `window.scribe`.

In a Scribe chat thread you have your own browser: the `browser_*` tools (other MCP clients don't get them; use your host's browser tool there). It is a real window on the user's desktop, with your thread's own cookies and storage, kept between turns and closed when the thread is archived. It opens loopback addresses (`localhost`, `127.x.x.x`, `*.localhost`) and Scribe pages only, so start dev servers with Keeper first.

```
browser_open({ key: "scribe:hero" })            // a Scribe page's viewUrl; or { url: "localhost:5173" }
// → { tab: "b1", url, title } and a snapshot:  - button "Add one" [ref=e3]
browser_act({ action: "click", ref: "e3" })      // also fill, type, press, select, check, scroll, drag, back, reload
browser_act({ action: "fill", ref: "e5", value: "Ada" })
browser_console({ level: "error" })              // check before you call it done
browser_network({ failedOnly: true })
browser_screenshot({})                           // or { ref }, { selector }, { fullPage: true }
browser_viewport({ width: 390, height: 844, colorScheme: "dark" })
browser_eval({ script: "document.title" })       // inspect only; act with browser_act
browser_tabs({ closeAll: true })                 // when you are done testing
```

- Act on refs from the **latest** snapshot. `browser_act` returns a fresh one and the console errors the action caused; pass `snapshot: false` to skip it.
- `selector` or `text` work as targets when a ref is not handy. Pass `selector` to `browser_snapshot` to read one region of a large page.

- Writes and signals from that page go to the **real page**. Do not test destructive interactions on a page the user relies on (their todo list). Show a copy under a temp key with `background: true`, test its `viewUrl`, then delete it with `page_close({ key, permanent: true })`.
- Looking without changing anything (snapshot, reading the DOM, a script that only reads) is fine on the real page.
- Loaded directly, the page does not receive live updates from `page_update` or other viewers. Reload it to see them.
- This is for testing behavior. For a picture of the layout, `page_screenshot` is still the tool.

## Interactive pages

Every page owns a JSON state object stored by the daemon. Use it for anything the user can change — todo lists, checklists, notes, review queues — and you can read back exactly what they did.

**Never use `localStorage` in a page.** All pages share one origin, so it collides across pages, and you cannot read it. Use `scribe.local` for things that belong to one viewer.

`window.scribe` is injected before your page scripts run:

```js
scribe.state                      // shared state, available synchronously
scribe.set({ todos })             // replace top-level keys; arrays of items with ids are sent as item changes
scribe.update([{ op: "merge", path: "todos/t_1", value: { done: true } }])   // change one item directly with ops
scribe.onChange(render)           // someone else changed the state; not fired for your own writes
scribe.bind(el, "notes")          // two-way bind an input, textarea, or checkbox to a shared key
scribe.local                      // this viewer's own state: filters, open panels, drafts
scribe.setLocal({ filter: "mine" })
scribe.bind(el, "draft", { local: true })
scribe.signal("submitted", { item: "t_1" })   // log an event agents can wait on, with small data
scribe.action("move", { card: 12, to: "done" })  // run one of the page template's actions
scribe.saveAsset(file)            // store an image/file for this page; see Page assets
scribe.preview(fileOrAssetId)     // show images, PDFs, text and more in Scribe's viewer; see Previewing files
scribe.open("scribe:key", { mode })  // open a page or URL as "tab", "peek", or "split"; see Linking pages
scribe.agent.start(prompt)        // start an agent chat thread for this page; see Pages that use the agent
```

Less common:

```js
scribe.id                         // this page's tab id (t_…)
scribe.revision                   // the state revision this page has seen
scribe.template                   // { id, values, revision, compatible } on a template page, else null
scribe.flush()                    // send pending writes now (Scribe already does on hide and unload)
scribe.ops.get(state, "todos/t_1")   // the state-op engine: get(state, path), diff(before, after, keys), apply(state, ops)
scribe.reportIncompatible(reason) // template pages: this state is not one the HTML can show; see TEMPLATES.md
```

Writes apply on the page at once and reach the daemon as small item-level changes. When an agent (or another window) changes a different item at the same time, both changes survive. The same field written by two people at once: the later write wins.

Declarative events (do **not** also call `scribe.signal` in the same click):

```html
<button type="button" data-scribe-signal="submitted">Submit</button>
<form data-scribe-signal="submitted">...</form>
```

Seed a page's shape with the `state` argument to `page_show`. It applies only when the page has no state yet, so re-showing a revised page never resets what the user has done.

Rules that keep pages well behaved:

- Give every item in an array a stable `id` (`{ id: "t_1", ... }`). Arrays of items with ids merge with other writers item by item; arrays without ids are replaced whole.
- Bind every text field with `scribe.bind` rather than wiring inputs by hand. It protects in-flight typing: a remote change to a field the user is inside does not touch their caret.
- In `onChange`, re-render only the parts that changed. Do not rebuild a container that holds a bound field.
- Keep what belongs to one viewer — in-progress typing, filters, which item is open — in `scribe.local`, not in shared state. Agents never see it.
- State is JSON only, up to 4 MB per page. Images, files, and other binary data go in page assets (below), never base64 in state.

### Page assets (images and files saved by the page)

When the user adds an image or file on the page itself (a kanban card's picture, a pasted screenshot, a dropped PDF), save it with `scribe.saveAsset` and keep its id in state:

```js
const asset = await scribe.saveAsset(file);          // Blob, File, ArrayBuffer, or typed array
// asset: { id, url, name, mimeType, bytes, usage }
scribe.set({ cards: [...cards, { id: newId(), title, image: asset.id }] });
img.src = scribe.assetUrl(card.image);               // "/blob/<id>"; works for an id or a stored url
await scribe.deleteAsset(id);                        // optional; unreferenced ones are cleaned up anyway
const { assets, usage } = await scribe.listAssets();
```

- An asset stays as long as its id (or url) appears anywhere in the page's state or HTML. Once nothing mentions it for 10 minutes it is deleted, so an undo right after removing a card still works. Save the id to state right after the upload.
- Deleting the page permanently deletes its assets with it. Export and import carry them.
- Limits: 32 MB per asset, 2000 assets and 256 MB per page. `usage.warning` is set (and Scribe shows a notice) once a page is 80% full; `saveAsset` rejects past the limit, so handle the error.
- To show a local image in the page's markup, use `assets` on `page_show` (see Images). To put a local file into the page's *data* (an image on a todo item, a card, a gallery entry), use `assets` on `page_update` and write the whole string `"asset:<name>"` where its URL belongs. It is stored as a page asset and replaced with `/blob/<id>`:

```
page_update({
  key: "groceries",
  assets: ["C:/Users/me/Pictures/apples.jpg"],
  ops: [{ op: "insert", path: "todos", value: { id: "t9", text: "Apples", done: false, description: "", col: 0,
    images: [{ id: "i1", name: "apples.jpg", data: "asset:apples.jpg" }] } }]
})
```

Every file must be referenced and every `asset:<name>` needs a file; otherwise the write is refused. The built-in Todo list keeps images per item as `images: [{ id, name, data }]` and shows one inline in the description with `![alt](#img-<image id>)`. `page_action` get (and a `page_state` path to one card or item) attaches those images so you can see them; a whole-board read does not inline every cover.

### Previewing files

Do not build a lightbox or document viewer into a page. `scribe.preview` opens Scribe's own viewer over the window. It shows images, PDFs, video and audio, Markdown, CSV/TSV as a table, HTML (sandboxed, no scripts), JSON, and plain text or code. Other types get a download button. With several files, the arrow keys step through them.

```js
thumb.addEventListener("click", () => scribe.preview(card.image, { name: "photo.png" }));  // an asset id or /blob/ url
input.addEventListener("change", () => scribe.preview([...input.files]));                 // Blobs or Files
scribe.preview(images.map((i) => ({ src: i.data, name: i.name })), { index: 2 });          // a gallery, opened at the third
```

- It takes a Blob or File, an asset id, a URL the page can fetch, `{ src | blob, name?, mimeType? }`, or an array of any of these. It resolves `{ ok }` or `{ ok: false, error }`.
- Like `scribe.open`, it only works inside a click or key press; otherwise it resolves `{ ok: false, error: "no_gesture" }`. Call it first in the handler.

The shape to follow — bind the fields once, render the rest from state, and call `render()` yourself after your own writes:

```js
scribe.bind(document.getElementById("notes"), "notes");

function items() {
  return Array.isArray(scribe.state.todos) ? scribe.state.todos : [];
}

function render() {
  listEl.replaceChildren();          // rebuilds the list only, never the bound fields
  for (const todo of items()) { /* build one row */ }
}

function toggle(id, done) {
  scribe.update([{ op: "merge", path: `todos/${id}`, value: { done } }]);
  render();
}

scribe.onChange(render);
render();
```

### Pages that use the agent

A page can start Scribe's own agent chat and read its replies with `scribe.agent`. Use it for buttons like "Summarise", "Break this card down" or "Draft a reply", where the page builds the prompt from its state and shows the answer itself.

```js
const { ok, threadId, error } = await scribe.agent.start(prompt, { title: "Card #12", mode: "board", show: "dock" });
await scribe.agent.send(threadId, "Shorter, please.");     // queued if the thread is still working
const { reply } = await scribe.agent.wait(threadId);       // resolves when the thread is idle (default 10 min)
const { threads } = await scribe.agent.threads();          // this page's threads, newest first
const { thread, reply: last } = await scribe.agent.get(threadId);
scribe.agent.onChange((t) => render(t));                   // { id, title, status, queued, reply? } on status changes
await scribe.agent.stop(threadId);                         // stop the turn and drop queued messages
await scribe.agent.merge(threadId);                        // idle Code thread: merge its worktree branch back, close the worktree
await scribe.agent.show(threadId, { where: "sidebar" });   // open a thread in the chat (inside a click); any of the user's threads
const opts = await scribe.agent.options();                 // { providers, models: { claude: [{ id, label, efforts, params }] }, modes, approvals, defaults }
const { path } = await scribe.agent.pickFolder();          // the user picks a folder (inside a click)
await scribe.agent.start(prompt, { mode: "code", cwd: path, approval: "edits", provider: "claude", model: "sonnet", effort: "high", worktree: true });
```

- Threads default to Pages mode (`mode: "ask"` for read-only Q&A): page tools and the web, no files or shell. Unset `provider` / `model` / `effort` / `approval` / `web` / `fast` follow the user's defaults; take ids from `options()`. Cursor models expose a `fast` param; pass `fast: true` (or `modelParams: { fast: "true" }`) to turn it on.
- A page only sees and drives **its own** threads (scoped to that page). It cannot reach other threads, except to `show` one by id, which tells the page nothing about it.
- `show: "dock"` or `"sidebar"` opens the thread in that chat; omit it to run quietly. The tab still shows its working dot.
- What else a page may do is the user's call, per page (tab menu → Permissions…). Scribe asks the user when a call needs a permission the page doesn't have yet, so `start`, `send`, and `stop` may take as long as the user does. A refusal is `{ ok: false, error: "denied", permission }`; show it on the page instead of retrying in a loop.
  - `agent.chat` (allowed by default): `start` / `send` / `stop` right after a click or key press on the page. Call them first in the handler, before other `await`s.
  - `agent.unattended` (asks): the same from the page's own code, e.g. in `scribe.onChange` when a card moves. Only while the page is loaded in a Scribe window, and every open window runs the page's code: claim the work in state first (an `update` with a `test` op) so two windows don't both start it.
  - `agent.workspace` (asks): `mode: "code"` or `"plan"` with a `cwd`, approved per folder and approval policy. `pickFolder()` only picks; Scribe still asks before the first thread there.
  - `scribe.permissions.request("agent.unattended")` (inside a click) asks up front, e.g. from a settings dialog; `scribe.permissions.query()` reads `[{ id, label, value, folders? }]`.
- Agents can't read or change these grants, and an agent changing a page's HTML (or its template) resets the risky ones to Ask: tell the user to re-approve after you edit such a page.
- Messages are marked as sent by the page, and the agent is told that the page's code sent them, not the user. Put page data in the prompt, never instructions from untrusted content.
- Keep the thread id in state if the page should continue the same conversation later.

## Waiting for user input

`page_wait` is a single blocked call. The page logs a **named event** when the thing you care about happens; you wait for that name. Typing, `scribe.set`, and `scribe.bind` do **not** wake you. Optional `where` matches fields on each event's `data` (compared as text), e.g. `{ column: "grok issues" }` on a Kanban `card_ready`.

Handshake:

1. Pick a short event name (`submitted`, `chosen`, `all_done`, `approved`).
2. The page logs that name when the condition is met — `data-scribe-signal="submitted"` or `scribe.signal("submitted", data)`. Put ids in `data` (which item, which choice), not whole records.
3. `page_show` the page.
4. `page_wait` with the same `key` and `events: "submitted"`. Without `after`, only events from now on count, which is right just after showing the page. When you read the page first and then wait, pass the `eventCursor` from `page_state` as `after`, so an event that came in between isn't missed.

The result is `{ events: [{ seq, name, data, at, by }], cursor }`, oldest first, with no state. Read what you need next with `page_state` and a `path`, or with a page action. `scribe.signal` sends the edits made before it in the same request, so that read sees them.

Do **not** signal on every keystroke, bind, or `onChange`. Do **not** wait for `stateRevision` to change.

### After the wait

- `events` is non-empty — handle each one (branch on `name`). Pass the returned `cursor` as `after` on your next wait, so nothing is missed or seen twice even if several events arrived together.
- `timedOut: true` — tell the user you are still waiting, then call `page_wait` again with the **same** `after`.
- `closed: true` — the tab was closed (the page is still in the Library); reopen it with `page_open` if you still need the handshake, or stop.
- `deleted: true` — the page was deleted; stop.
- `missed: true` — more events happened than the log keeps (500). Read the page's state instead of relying on the events.

Default timeout is 2 hours, with no maximum. Keep the default unless you have a reason to stop waiting sooner; the user can interrupt you at any time. Never poll `page_state` in a loop.

### Patterns

Submit a form (bound fields are already in state):

```html
<button type="button" data-scribe-signal="submitted">Submit</button>
```

```
page_wait({ key: "review", events: "submitted" })
```

Choice buttons — the choice rides in the event's data. Use `type="button"` and **either** `data-scribe-signal` **or** `scribe.signal`, not both:

```html
<button type="button" onclick="pick('a')">Option A</button>
<button type="button" onclick="pick('b')">Option B</button>
<script>
function pick(id) {
  scribe.set({ choice: id });
  scribe.signal("chosen", { choice: id });
}
</script>
```

```
page_wait({ key: "options", events: "chosen" })   → events[0].data.choice
```

Different outcomes:

```html
<button type="button" data-scribe-signal="approved">Approve</button>
<button type="button" data-scribe-signal="rejected">Reject</button>
```

```
page_wait({ key: "pr-review", events: "approved,rejected" })
```

Then branch on `events[0].name`.

All todos checked — signal from the condition, not from each toggle:

```js
function toggle(id, done) {
  scribe.update([{ op: "merge", path: `todos/${id}`, value: { done } }]);
  render();
  const todos = scribe.state.todos;
  if (todos.length && todos.every((t) => t.done)) {
    scribe.signal("all_done");
  }
}
```

```
page_wait({ key: "todos", events: "all_done" })
```

Keyboard (Ctrl/Cmd+Enter):

```js
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  scribe.signal("submitted");
});
```

## Reading and changing page state

**Actions first.** Pages made from a template with actions (the built-in Kanban board and Todo list) list them in their agent guide. Use `page_action` for everyday work there: it applies the page's own rules in one atomic step and returns just what you need.

```
page_action({ key: "scribe:agent-todo", action: "list", args: { column: "agent" } })
page_action({ key: "scribe:agent-todo", action: "claim", args: { card: 12, text: "Fixing the export" } })
page_action({ key: "scribe:agent-todo", action: "finish", args: { card: 12, summary: "Done in abc123; check the export dialog." } })
```

**Reading.** `page_state` returns `state`, `stateRevision`, and `eventCursor`. Use it when you are **not** blocked on the user (they said “look at my notes”). Do not poll it. On a large page, read one part:

- `page_state({ key, path: "cards/num=12" })` returns just that value.
- `where` filters an array: `{ path: "cards", where: { col: "col_ab12" } }`.

**Writing.** `page_update` takes ops. An open page applies them live; it does **not** focus the tab or open a closed page. Unfocused open tabs and closed pages show an unread blip.

- Ops: `set` (a key, or replace an array item; path `""` replaces the whole state), `merge` (copy fields onto an object; a `null` field removes it), `remove`, `insert` (into the array at `path`), `move` (within its array), and `test` (fail the whole write unless the value at `path` equals `value`; `null` matches a missing value). `insert` and `move` take `before` / `after` (a selector) or `at` (`"start"`, `"end"`, an index).
- A path is `/`-separated. On an object a segment is a key; on an array it picks an item by `id` (`cards/c_12ab`), by `field=value` (`cards/num=12`), or by `#<index>`.
- Ops apply in order, all or nothing, to the latest state. A change elsewhere on the page does not refuse your write, so `expectedRevision` is optional. Pass it (or a `test` op) when your edit depends on a value you read.

```
page_update({ key: "sprint-board", ops: [
  { op: "merge", path: "items/t_12", value: { done: true, note: null } },
  { op: "insert", path: "items/t_12/comments", value: { id: "cm_1", by: "agent", at: 1790000000000, text: "Done." } },
  { op: "set", path: "updatedBy", value: "agent" }
] })
```

- Never write keys the page keeps per viewer or for in-progress typing; those belong in `scribe.local` and you can't see them anyway.
- Read state before acting on a page the user has had time to touch. Do not assume the state you wrote earlier is still current.

If the page asks the user to do something you must continue from — submit, choose, confirm, finish a checklist — call `page_wait` **next, in the same turn**, with the same event name the page logs. Do not poll `page_state`.

In a Scribe chat thread (the tool list has `page_ask`), use `page_ask` on the page instead of `page_wait`: the chat shows it as a question, the turn counts as waiting for the user, and the call returns the answering events and the page's state. The page should still log `submit` (or the event you pass) when the user is done.

## Pin, open, close

- `page_pin` / `page_unpin` (`id`/`key`) so Clear and close-unpinned keep or drop the tab. Same rule as `page_show` `pin`.
- `page_close` closes one tab (`id`/`key`), unpinned tabs (`unpinned: true`), or everything (`all: true`). Closed pages stay in the Library. Pass `permanent: true` to delete instead; deleted pages stay in the user's Trash for 7 days, and Ctrl+Z restores the most recent delete (a bulk delete counts as one).
- `page_open` (`id`/`key`) opens a closed page on the strip (focused).
- Reuse a `key` only for in-place edits of that page. A continuation or large rewrite gets a new key; close the old tab first so the previous page stays recoverable.
- Dates in tool results are local ISO (timezone offset); stored as unix ms on disk.

## Templates

Do **not** create, edit, or delete templates unless the user explicitly asked. Everyday pages still use `page_show` / `page_patch`.

When they do ask, read `TEMPLATES.md` in this skill folder before using `template_*`. A page bound to a template cannot have its HTML changed — update the template instead. You may still change that page's state, title, and pin.

Pages made from a template (a Kanban board, a Todo list) can come with an **agent guide**: the actions, the events the page logs, and the state shape. The first `page_state`, `page_read`, `page_wait`, `page_action`, or `template_open` on such a page in a session appends the guide to the result. Read it before changing that page, and follow it over general advice here. Later results only point back to it; `page_state` with `guide: true` shows it again.
