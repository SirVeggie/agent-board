# Migrations

## Templates tables (additive, schema still 1)

- **What changed:** Templates and page-to-template links are stored in two new SQLite tables: `templates` and `template_bindings`.
- **Why no version bump:** Existing `tabs` rows are unchanged. Old boards open as before; they simply have no templates until one is created. `SCHEMA_VERSION` stays `1`.
- **Where:** `src/dbMigrate.ts` (`ensureTemplateSchema`), called from `BoardDb.open` / `openExisting`. New databases also get the tables from `CREATE_SQL` in `src/db.ts`.
- **How to verify:** Create a template, open a page from it, restart the daemon, confirm the template list and the page link survive. Existing tabs without a binding still load.
- **When to remove:** Keep. This is the current schema, not a one-shot rewrite.
