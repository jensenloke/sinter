/**
 * Ledger schema — one row per session across every harness, plus an FTS5 index
 * over the human-searchable fields (title / first prompt), plus a cache of the
 * lineage links that group native sessions into sinter threads.
 *
 * The primary key is (harness, native_id): native ids are only unique inside a
 * harness, and sinter never rewrites a source store's ids.
 *
 * MIGRATION POLICY — the statements below are the whole migration. Every one is
 * `CREATE ... IF NOT EXISTS`, so applying them to an older database is purely
 * additive: existing rows are never dropped, rewritten or re-created. Opening a
 * v1 ledger under v2 gains the `lineage` table; v2 under v3 gains the
 * `session_aliases` table. Both keep every session row. New versions must keep
 * that property; a change that needs to rewrite data has
 * to be a separate, explicit, versioned step — never a silent re-`exec` here.
 *
 * `SCHEMA_VERSION` is a record of what was last applied (stored in `meta`), not
 * a trigger: nothing keys off its value, so bumping it cannot wipe anything.
 */

export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  harness           TEXT NOT NULL,
  native_id         TEXT NOT NULL,
  native_path       TEXT,
  cwd               TEXT,
  title             TEXT,
  first_prompt      TEXT,
  created_at        TEXT,
  updated_at        TEXT,
  message_count     INTEGER,
  model             TEXT,
  git_branch        TEXT,
  tokens_input      INTEGER,
  tokens_output     INTEGER,
  tokens_reasoning  INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  cost              REAL,
  parent_native_id  TEXT,
  is_subagent       INTEGER NOT NULL DEFAULT 0,
  ghost             INTEGER NOT NULL DEFAULT 0,
  host              TEXT,
  scanned_at        TEXT,
  PRIMARY KEY (harness, native_id)
);

CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_cwd_idx      ON sessions(cwd);
CREATE INDEX IF NOT EXISTS sessions_prefix_idx   ON sessions(native_id);

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  harness      UNINDEXED,
  native_id    UNINDEXED,
  title,
  first_prompt,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS session_aliases (
  harness   TEXT NOT NULL,
  native_id TEXT NOT NULL,
  alias     TEXT NOT NULL,
  PRIMARY KEY (harness, native_id)
);

CREATE TABLE IF NOT EXISTS lineage (
  harness            TEXT NOT NULL,
  native_id          TEXT NOT NULL,
  thread_id          TEXT NOT NULL,
  hop                INTEGER NOT NULL DEFAULT 0,
  parent_harness     TEXT,
  parent_native_id   TEXT,
  ported_at          TEXT,
  mode               TEXT,
  recorded_at        TEXT,
  PRIMARY KEY (harness, native_id)
);

CREATE INDEX IF NOT EXISTS lineage_thread_idx ON lineage(thread_id);
`;
