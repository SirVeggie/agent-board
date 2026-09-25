# Migrations

## Templates tables (additive, schema still 1)

- **What changed:** Templates and page-to-template links are stored in two new SQLite tables: `templates` and `template_bindings`.
- **Why no version bump:** Existing `tabs` rows are unchanged. Old boards open as before; they simply have no templates until one is created. `SCHEMA_VERSION` stays `1`.
- **Where:** `src/dbMigrate.ts` (`ensureTemplateSchema`), called from `BoardDb.open` / `openExisting`. New databases also get the tables from `CREATE_SQL` in `src/db.ts`.
- **How to verify:** Create a template, open a page from it, restart the daemon, confirm the template list and the page link survive. Existing tabs without a binding still load.
- **When to remove:** Keep. This is the current schema, not a one-shot rewrite.

## `tabs.agent_hidden` column (additive, schema still 1)

- **What changed:** Tabs can be hidden from the agent, from the board UI only. The flag is stored in a new `tabs.agent_hidden INTEGER NOT NULL DEFAULT 0` column. Export files carry it as an optional `agentHidden: true` on each page.
- **Why migration was needed:** `board.sqlite` files created before this change have no `agent_hidden` column, and the tab upsert writes it. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the migration checks `PRAGMA table_info(tabs)` first. Existing rows get the default `0` (visible). `SCHEMA_VERSION` stays `1`.
- **Export format:** No transform. Older exports don't have `agentHidden` and import as visible. `EXPORT_VERSION` stays `1`.
- **Where:** `src/dbMigrate.ts` (`ensureAgentHiddenColumn`), called from `BoardDb.openExisting` in `src/db.ts`. New databases get the column from `CREATE_SQL`.
- **How to verify:** The `opening a board without tabs.agent_hidden adds the column` test in `src/store.test.ts` drops the column, reopens the board, and checks that tabs load and the flag persists. Manually: start the new daemon against an old `board.sqlite`, hide a tab from its menu, restart, and confirm the eye icon is still there.
- **When to remove:** Once every board in use has been opened by a daemon with this change, `ensureAgentHiddenColumn` can be deleted. `CREATE_SQL` already has the column. For a local-only tool, one release after this lands is enough.
