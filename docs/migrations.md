# Migrations

## `tabs.folder_instructions` column (additive, schema still 3)

- **What changed:** A page can be marked as its Library folder's standing agent instructions (`folderInstructions` on the tab, tab menu **Use as folder instructions**). Stored as `tabs.folder_instructions INTEGER NOT NULL DEFAULT 0`. A page titled `Instructions` counts even without the flag. Export files carry optional `folderInstructions: true`.
- **Why no version bump:** Existing rows are unchanged (default 0). SQLite has no `ADD COLUMN IF NOT EXISTS`, so `ensureFolderInstructionsColumn` checks `PRAGMA table_info(tabs)` first. `SCHEMA_VERSION` stays `3`.
- **Export format:** No transform. Older exports have no `folderInstructions` and import as unset. `EXPORT_VERSION` stays `1`.
- **Protocol:** additive route only (`POST /api/tabs/:id/folder-instructions`), refused for agents. `VERSION` stays `3.0.0`.
- **Where:** `src/schema.ts` (`TABS_TABLE_SQL`), `src/dbMigrate.ts` (`ensureFolderInstructionsColumn`), `src/store.ts` (`setFolderInstructions`, `folderInstructionsFor`), `src/agent/prompt.ts`.
- **How to verify:** `folder instruction pages walk parent folders and prefer a flag over the title` and the persist/export test in `src/store.test.ts`; `threadInstructions includes folder instruction pages` in `src/agent/prompt.test.ts`.
- **When to remove:** Keep. This is the current schema.

## `page_permissions` table (additive, schema still 3)

- **What changed:** What the user lets a page's own code do (`agent.chat`, `agent.unattended`, `agent.workspace`; plugins will add `plugin.<id>` ids) is stored in a new `page_permissions` table: `tab_id REFERENCES tabs(id) ON DELETE CASCADE`, `perm`, `value` (`allow` / `deny` / `ask`), `data` (JSON, `{ folders: [{ path, approval }] }` for per-folder permissions), `updated_at`. No row means the permission's default (`src/pagePermissions.ts`).
- **Why no version bump:** Nothing existing changes. `ensurePagePermissionSchema` runs `CREATE TABLE IF NOT EXISTS` on every open. `SCHEMA_VERSION` stays `3`.
- **Export format:** unchanged on purpose: grants stay on the PC that gave them and never travel with a page. `EXPORT_VERSION` stays `1`.
- **Protocol:** additive routes only (`GET`/`PUT /api/tabs/:id/permissions`, `POST /api/tabs/:id/permissions/check`), refused for agents and tab pages, so `VERSION` stays `3.0.0`. The shell falls back to the old behavior (clicks only) against a daemon without them. New bridge calls (`scribe.permissions`, `scribe.agent.stop` / `options` / `pickFolder`, start settings) need the daemon restarted.
- **Where:** `src/schema.ts` (`PAGE_PERMISSIONS_TABLE_SQL`), `src/dbMigrate.ts` (`ensurePagePermissionSchema`), `src/store.ts` (`pagePermissions`, `setPagePermission`, `resetRiskyPermissions`).
- **How to verify:** `page permissions are kept per page, reset by an agent rewrite, and not exported` in `src/store.test.ts`, and `src/pagePermissions.test.ts`.
- **When to remove:** Keep. This is the current schema.

## Scribe release: schema 3, data folder, page keys (breaking)

- **What changed:** The app is renamed from Agent Board to Scribe, and page state moved to ops, an event log, and per-viewer local state.
  - **Data folder:** `%LOCALAPPDATA%\agent-board` moves to `%LOCALAPPDATA%\scribe` the first time the new daemon starts (`migrateLegacyData` in `src/config.ts`), entry by entry, never overwriting what is already there. `board.sqlite` (and `-wal` / `-shm`) becomes `scribe.sqlite`. Claude Code's session folder for the scratch dir is copied to the new path's name so Pages-mode threads still resume. `SCRIBE_HOME` skips the folder move but still renames the database.
  - **Schema 2 → 3** (`migrateV2ToV3` in `src/dbMigrate.ts`): `tabs.signal_revision` / `tabs.signal` are renamed to `event_seq` / `events`, and a page's last signal becomes the first entry of its event log. A new `page_local` table (`tab_id` → `tabs(id)` cascade, `viewer`, `state`) holds `scribe.local`. A schema 1 board migrates through 2 (using the frozen `TABS_TABLE_V2_SQL`) and then to 3.
  - **Page keys** read `scribe:<slug>`. The store adds the prefix to any key without it when it loads (`store.load`) and writes those rows back; lookups take either form. Exports carry the prefixed keys; importing an older export prefixes its keys on the way in.
  - **Browser settings:** the UI moves `agent-board.*` localStorage keys to `scribe.*` on load. The desktop app has a new identifier (`local.scribe.desktop`), so its WebView profile, and with it window-only settings, starts fresh once.
  - **Desktop:** `scribe.exe` replaces `board.exe` (the installer removes the old exe), and the "Agent Board" startup entry moves to "Scribe".
- **Protocol:** `VERSION` 2.5.0 → 3.0.0. State writes are ops only (`PUT /api/tabs/:id/state { ops }`), `tab_state` carries ops instead of the whole state, `POST /api/tabs/:id/signal` became `/events`, waits take a cursor and return events. MCP tools are renamed (`board_*` → `page_*` / `library_*` / `template_*`), the page API is `window.scribe` with `data-scribe-*` attributes, and the MCP server is named `scribe`. Pages written for the old API need updating; the built-in templates are updated and resync on startup.
- **Outside the repo:** MCP configs must point a server named `scribe` at `dist/index.js` (Cursor: `~/.cursor/mcp.json`; Claude Code: `claude mcp`), and the skill folder is `.cursor/skills/scribe`.
- **How to verify:** `a schema v1 board migrates archived tabs into the Library` runs v1 → 3; the event, local state and key tests in `src/store.test.ts`; manually, copy an old `%LOCALAPPDATA%\agent-board` aside, start the daemon, and check that the folder moved and pages, keys and threads are intact.
- **When to remove:** the folder move, key prefixing and localStorage move can go once no Agent Board install is left to upgrade. Keep `migrateV2ToV3`.

## Templates tables (additive, schema still 1)

- **What changed:** Templates and page-to-template links are stored in two new SQLite tables: `templates` and `template_bindings`.
- **Why no version bump:** Existing `tabs` rows are unchanged. Old boards open as before; they simply have no templates until one is created. `SCHEMA_VERSION` stays `1`.
- **Where:** `src/dbMigrate.ts` (`ensureTemplateSchema`), called from `BoardDb.open` / `openExisting`. New databases also get the tables from `CREATE_SQL` in `src/db.ts`.
- **How to verify:** Create a template, open a page from it, restart the daemon, confirm the template list and the page link survive. Existing tabs without a binding still load.
- **When to remove:** Keep. This is the current schema, not a one-shot rewrite.

## `templates.builtin_key` / `builtin_fingerprint` columns (additive, schema still 2)

- **What changed:** Built-in templates ship in `templates/builtin` and are never stored. Opening one creates a local copy in `templates`, and the copy records which built-in it came from (`builtin_key`) and that built-in's content fingerprint at copy time (`builtin_fingerprint`). Both are nullable `TEXT`; null means an ordinary user template.
- **Why migration was needed:** Existing `templates` tables lack the columns and the template upsert writes them. SQLite has no `ADD COLUMN IF NOT EXISTS`, so `ensureTemplateBuiltinColumns` checks `PRAGMA table_info(templates)` first. `SCHEMA_VERSION` stays `2`.
- **Later addition:** `templates.guide` (nullable `TEXT`, the template's agent guide) is added by the same function in the same way.
- **On load:** a user template with no source whose content is identical to a built-in is linked to it, so opening that built-in reuses it instead of making a second copy.
- **Export format:** templates may carry an optional `source: { builtin, fingerprint }`. Import keeps it only when the target board has no copy of that built-in yet. Older exports have no `source`. `EXPORT_VERSION` stays `1`.
- **Where:** `src/dbMigrate.ts` (`ensureTemplateBuiltinColumns`, run by `ensureTemplateSchema`). New databases get the columns from `CREATE_SQL` / `TEMPLATE_TABLES_SQL`.
- **How to verify:** `template tables without the built-in columns are migrated` in `src/store.test.ts` drops the columns from a board, reopens it, and checks a copy's link survives a reload.
- **When to remove:** Keep. This is the current schema.

## `page_assets` table (additive, schema still 2)

- **What changed:** Blobs saved by page code (`board.saveAsset`) are stored in a new `page_assets` table: `id`, `tab_id REFERENCES tabs(id) ON DELETE CASCADE`, `name`, `mime_type`, `bytes`, `data BLOB`, `created_at`, `orphaned_at` (set while nothing in the page's state or HTML mentions the id).
- **Why no version bump:** Nothing existing changes. `ensurePageAssetSchema` runs `CREATE TABLE IF NOT EXISTS` on every open. `SCHEMA_VERSION` stays `2`.
- **Hazard for future migrations:** the cascade fires on any `DELETE` of a `tabs` row, and `foreign_keys` is on. A migration that rebuilds `tabs` (rename, create, copy, drop, like `migrateV1ToLibrarySchema`) would delete every page asset when it drops the old table, because `ALTER TABLE RENAME` repoints the foreign key at the renamed table. Turn `foreign_keys` off for such a rebuild (it cannot be changed inside a transaction), and keep the tabs upsert as `ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`.
- **Export format:** pages may carry an optional `pageAssets: [{ id, name, mimeType, createdAt, data }]` (base64). Older exports have none. Importing reuses the ids unless they already exist on the board; taken ids get new ones and the page's state and HTML are rewritten to match. `EXPORT_VERSION` stays `1`. `MAX_IMPORT_BYTES` rose from 128 MB to 400 MB.
- **Protocol:** `VERSION` 2.2.0 → 2.3.0 for the new `page_asset_warning` event.
- **Where:** `src/schema.ts` (`PAGE_ASSETS_TABLE_SQL`), `src/dbMigrate.ts` (`ensurePageAssetSchema`), `src/pageAssets.ts`.
- **How to verify:** the page asset tests in `src/store.test.ts`.
- **When to remove:** Keep. This is the current schema.

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
  - MCP tools were renamed without aliases: `board_archive` → `library_search`, `board_restore` → `page_open`. Result fields `archived` / `archiveCount` became `open` / `closedCount`; `page_wait` reports `closed` (tab closed, page kept) and `deleted`. Agents with a stale MCP need a reload.
  - HTTP: `/api/archive` → `/api/library`; `/api/tabs/:id/restore` → `/api/tabs/:id/open`.
  - Export files: `archivedAt` → `closedAt`, plus optional `folderPath` and `libPos`. `EXPORT_VERSION` stays `1`. Old exports still import (as open pages in the root); their `archivedAt` is ignored, with no fallback.
  - Browser localStorage keys keep their old names (`scribe.archiveOpen`, `scribe.archiveWidth`); a stored sidebar tab of `archive` is read as `library`. No transform.
- **How to verify:** The `a schema v1 board migrates archived tabs into the Library` test in `src/store.test.ts` builds a v1 database, opens it, and checks the migrated statuses, `closedAt`, and the initial Library order. Manually: copy an old `board.sqlite`, start the new daemon against it, and confirm open tabs and former archive rows show in the Library in that order.
- **When to remove:** Once every board in use has been opened by a schema 2 daemon, delete `migrateV1ToLibrarySchema` and `ensureAgentHiddenColumn` and make `openExisting` reject schema 1. For a local-only tool, one release after this lands is enough.

## Agent chat: `agent.sqlite` (new file, board schema unchanged)

- **What changed:** The in-app agent chat stores its threads, turns, transcript items, preferences, cached model lists, and page checkpoints in a separate SQLite file, `agent.sqlite`, next to `board.sqlite`. Tables: `meta`, `threads`, `turns`, `items`, `settings`. Rows keep their payload as JSON; the columns are only what queries need (`activity_at`, `archived`, `thread_id`, `seq`). `turns` and `items` reference `threads(id) ON DELETE CASCADE`.
- **Why a separate file:** Nothing in `board.sqlite` changes, so old boards open as before and a broken agent database can't affect pages. `SCHEMA_VERSION` stays `2`; `agent.sqlite` has its own `meta.schema` (`AGENT_SCHEMA_VERSION = 1`).
- **Protocol:** `VERSION` 2.4.0 → 2.5.0 for the new WebSocket events (`agent_thread`, `agent_thread_deleted`, `agent_item`, `agent_delta`, `agent_turn`) and the `/api/agent/*` routes. `public/app.js` `BOARD_VERSION` matches.
- **Dependencies:** zod 3 → 4 and `@modelcontextprotocol/sdk` 1.25 → 1.29 (peer dependencies of `@anthropic-ai/claude-agent-sdk`). The only code change was `z.record(value)` → `z.record(z.string(), value)` in `src/mcp.ts`.
- **On startup:** turns left `running` by a daemon that stopped are marked `cancelled`.
- **Export format:** unchanged; board exports don't include agent threads.
- **Where:** `src/agent/db.ts`.
- **When to remove:** Keep. This is the current schema.
