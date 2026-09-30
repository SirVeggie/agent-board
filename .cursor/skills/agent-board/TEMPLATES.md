# Agent Board templates

Read this file only when the user asked you to create, edit, delete, or open a **board template**. Do not create templates unprompted.

A template is reusable page HTML plus a form. The user opens instances from the Templates sidebar. Updating the template re-renders every linked page with that page's own form values.

## Tools

| Tool | Purpose |
| --- | --- |
| `board_template_upsert` | Create or replace a template (`key`, `title`, `html`, `fields`, optional `description`, `titleTemplate`, `initialState`, `stateVersion`, `guide`) |
| `board_template_list` | Names and field schemas (no HTML) |
| `board_template_get` | Full HTML and fields |
| `board_template_delete` | Remove the template. Existing pages stay, keep last HTML, and become ordinary pages |
| `board_template_open` | Open a pinned instance with `values`. Prefer letting the user do this in the UI |

Reuse the same `key` when updating that template.

## Built-in templates

Some templates ship with the app (Embed, Kanban board, Markdown note, Todo list). `board_template_list` returns them under `builtins` with ids like `builtin:todo-list`. They are read-only: `board_template_upsert` and `board_template_delete` refuse them.

Opening a built-in (from the sidebar or `board_template_open`) copies it into the user's templates first, once, and the page binds to that copy. On startup, an app update refreshes the copy (and its pages) only if the copy is unedited and the built-in's `stateVersion` is unchanged. Otherwise the copy is left alone; to bring it up to date, compare it with the built-in (`board_template_get`) and upsert the copy, migrating page state if `stateVersion` changed. `localId` on a built-in is the id of its copy, and the copy's `builtinSource` names the built-in.

If the user wants a changed version of a built-in, `board_template_get` it and upsert under a new key, or update their copy by `localId` if they want that copy changed.

## Authoring

1. Decide the form with the user, or pick a small set: e.g. Title, item name singular/plural, column count.
2. Write HTML as you would for `board_show`. Use `{{fieldKey}}` where the value should appear in markup (HTML-escaped). In scripts, read `board.template.values.fieldKey`.
3. Use `board.state` for live data (todos, notes). Put starting data in `initialState`.
4. Set `titleTemplate` if the tab title should include a field, e.g. `{{title}}`.
5. Field `type`: `text`, `textarea`, `number`, `select`, `checkbox`. Select needs `options`. Keys must be JS identifiers.
6. If an agent will read or change the page's state, write a `guide`: markdown with the state shape, the signals the page fires and when, and the rules for editing (which keys to leave alone, how to add an item). Tool results hand it to any agent the first time it touches a page from the template, so nothing about the template needs to go in this skill. Keep it under a page; `templates/builtin/kanban.guide.md` is a good model. Upserting without `guide` keeps the current one.

Do not pin the template itself. The user opens pages from the sidebar.

## Updating a template

`board_template_upsert` with the same `key` replaces HTML and fields, then re-renders every linked page.

If the **page data shape** changed (new required `board.state` keys, different list format):

1. Bump `stateVersion` (integer, start at 1).
2. Linked pages show an overlay and cannot be used until you fix each page.
3. `board_get_state` / `board_set_state` still work. After the data is valid, call `board_set_state` with `resolveIncompatibility: true` and `expectedRevision`.

If you only change layout or copy and existing data still works, leave `stateVersion` alone.

A page can call `board.reportIncompatible(reason)` if it detects bad data itself.

## Bound pages

`board_list` / `board_read` include `templateId` when a page is linked.

- **Do not** `board_show` or `board_patch` HTML on that page. The tools refuse it.
- You **may** change title (`board_patch` with `title` only), pin, and state.
- To change structure, update the template.

Exports (`.board.json`) carry the template with its pages, so an imported page stays bound. Import reuses an identical local template instead of duplicating it.

## Example: todo template

Fields: `title` (text, required), `item` (text, default `task`), `items` (text, default `tasks`), `columns` (number, 1–4, default 3).

HTML uses `{{title}}` in the heading and `board.template.values.columns` when laying out columns. `initialState` is `{ todos: [] }`. `titleTemplate` is `{{title}}`.
