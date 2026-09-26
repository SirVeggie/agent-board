export const TABS_TABLE_SQL = `
CREATE TABLE tabs (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('open','closed','deleted')),
  strip_seq INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  deleted_at INTEGER,
  revision INTEGER NOT NULL,
  state_revision INTEGER NOT NULL,
  state_updated_at INTEGER NOT NULL DEFAULT 0,
  signal_revision INTEGER NOT NULL DEFAULT 0,
  signal TEXT,
  assets TEXT NOT NULL DEFAULT '[]',
  agent_hidden INTEGER NOT NULL DEFAULT 0,
  folder_id TEXT,
  lib_pos REAL NOT NULL DEFAULT 0,
  deleted_batch TEXT,
  user_title_at INTEGER
);
CREATE INDEX idx_tabs_status_closed ON tabs(status, closed_at DESC);
CREATE INDEX idx_tabs_status_deleted ON tabs(status, deleted_at DESC);
`;

export const FOLDERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  pos REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_batch TEXT
);
`;
