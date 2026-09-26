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
- **Where:** `src/dbMigrate.ts` (`ensureAgentHiddenColumn`). It now runs only as the first step of the schema 1 → 2 migration below, so a v1 board without the column still upgrades. New databases get the column from `TABS_TABLE_SQL` in `src/schema.ts`.
- **How to verify:** Covered by the schema 1 → 2 test below, which builds a v1 database.
- **When to remove:** Together with `migrateV1ToLibrarySchema`.

## Library: schema 2 (`tabs` rebuild, `folders` table)

- **What changed:** The Archive became the Library. Every page is in it, open or closed, organized into nested folders with a manual order. The strip is just the open pages.
  - `tabs.status` `'archived'` → `'closed'`, `tabs.archived_at` → `tabs.closed_at`.
  - New `tabs` columns: `folder_id` (null = root), `lib_pos` (sparse float order within a folder), `deleted_batch` (groups a multi-page delete into one undo step), `user_title_at` (last user rename; holds off agent title writes for 24h).
  - New `folders` table (`id`, `name`, `parent_id`, `pos`, `created_at`).
  - `SCHEMA_VERSION` 1 → 2.
- **Why migration was needed:** SQLite cannot change the `status` CHECK constraint in place, so `tabs` is rebuilt (rename to `tabs_v1`, create the new table, copy, drop). Existing boards also need an initial Library order.
- **Initial order:** Everything lands in the root. Open tabs first in strip order (pinned first), then archived pages newest first.
- **Where:** `src/dbMigrate.ts` (`migrateV1ToLibrarySchema`), called from `BoardDb.openExisting` in `src/db.ts` when `meta.schema` is `1`. It runs in one transaction and rolls back on failure. The table DDL is shared with new databases through `src/schema.ts` (`TABS_TABLE_SQL`, `FOLDERS_TABLE_SQL`), which also breaks the `db.ts` ↔ `dbMigrate.ts` import cycle.
- **Other shape changes (no migration code):**
  - MCP tools were renamed without aliases: `board_archive` → `board_library`, `board_restore` → `board_open`. Result fields `archived` / `archiveCount` became `open` / `closedCount`; `board_wait` reports `closed` (tab closed, page kept) and `deleted`. Agents with a stale MCP need a reload.
  - HTTP: `/api/archive` → `/api/library`; `/api/tabs/:id/restore` → `/api/tabs/:id/open`.
  - Export files: `archivedAt` → `closedAt`, plus optional `folderPath` and `libPos`. `EXPORT_VERSION` stays `1`. Old exports still import (as open pages in the root); their `archivedAt` is ignored, with no fallback.
  - Browser localStorage keys keep their old names (`agent-board.archiveOpen`, `agent-board.archiveWidth`); a stored sidebar tab of `archive` is read as `library`. No transform.
- **How to verify:** The `a schema v1 board migrates archived tabs into the Library` test in `src/store.test.ts` builds a v1 database, opens it, and checks the migrated statuses, `closedAt`, and the initial Library order. Manually: copy an old `board.sqlite`, start the new daemon against it, and confirm open tabs and former archive rows show in the Library in that order.
- **When to remove:** Once every board in use has been opened by a schema 2 daemon, delete `migrateV1ToLibrarySchema` and `ensureAgentHiddenColumn` and make `openExisting` reject schema 1. For a local-only tool, one release after this lands is enough.
