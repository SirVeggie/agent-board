# Agent Board templates

Read this file only when the user asked you to create, edit, delete, or open a **board template**. Do not create templates unprompted.

A template is reusable page HTML plus a form. The user opens instances from the Templates sidebar. Updating the template re-renders every linked page with that page's own form values.

## Tools

| Tool | Purpose |
| --- | --- |
| `board_template_upsert` | Create or replace a template (`key`, `title`, `html`, `fields`, optional `description`, `titleTemplate`, `initialState`, `stateVersion`) |
| `board_template_list` | Names and field schemas (no HTML) |
| `board_template_get` | Full HTML and fields |
| `board_template_delete` | Remove the template. Existing pages stay, keep last HTML, and become ordinary pages |
| `board_template_open` | Open a pinned instance with `values`. Prefer letting the user do this in the UI |

Reuse the same `key` when updating that template.

## Authoring

1. Decide the form with the user, or pick a small set: e.g. Title, item name singular/plural, column count.
2. Write HTML as you would for `board_show`. Use `{{fieldKey}}` where the value should appear in markup (HTML-escaped). In scripts, read `board.template.values.fieldKey`.
3. Use `board.state` for live data (todos, notes). Put starting data in `initialState`.
4. Set `titleTemplate` if the tab title should include a field, e.g. `{{title}}`.
5. Field `type`: `text`, `textarea`, `number`, `select`, `checkbox`. Select needs `options`. Keys must be JS identifiers.

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
