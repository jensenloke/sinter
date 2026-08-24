/**
 * Ledger schema — one row per session across every harness, plus an FTS5 index
 * over the human-searchable fields (title / first prompt), plus a cache of the
 * lineage links that group native sessions into sinter threads.
 *
 * The primary key is (harness, instance_id, native_id): native ids are only
 * unique inside one configured harness store.
 *
 * MIGRATION POLICY — `SCHEMA_SQL` is additive for fresh and current databases.
 * Opening a v1 ledger under v2 gains the `lineage` table; v2 under v3 gains the
 * `session_aliases` table; v3 under v4 gains the `session_pins` table; v4 under
 * v5 gains `saved_views`; v5 under v6 gains `session_notes` and `session_tags`.
 * Versions that rewrite identity or data must use a separate, explicit,
 * transactional migration before this schema is applied. v7 does that in
 * `migrateLedgerV7`, preserving every legacy row under instance `default`.
 *
 * `SCHEMA_VERSION` is a record of what was last applied (stored in `meta`), not
 * a trigger: nothing keys off its value, so bumping it cannot wipe anything.
 */

export const SCHEMA_VERSION = 7;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  harness           TEXT NOT NULL,
  instance_id       TEXT NOT NULL DEFAULT 'default',
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
  PRIMARY KEY (harness, instance_id, native_id)
);

CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_cwd_idx      ON sessions(cwd);
CREATE INDEX IF NOT EXISTS sessions_prefix_idx   ON sessions(native_id);

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  harness      UNINDEXED,
  instance_id  UNINDEXED,
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
  instance_id TEXT NOT NULL DEFAULT 'default',
  native_id TEXT NOT NULL,
  alias     TEXT NOT NULL,
  PRIMARY KEY (harness, instance_id, native_id)
);

CREATE TABLE IF NOT EXISTS session_pins (
  harness   TEXT NOT NULL,
  instance_id TEXT NOT NULL DEFAULT 'default',
  native_id TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (harness, instance_id, native_id)
);

CREATE TABLE IF NOT EXISTS lineage (
  harness            TEXT NOT NULL,
  instance_id        TEXT NOT NULL DEFAULT 'default',
  native_id          TEXT NOT NULL,
  thread_id          TEXT NOT NULL,
  hop                INTEGER NOT NULL DEFAULT 0,
  parent_harness     TEXT,
  parent_instance_id TEXT,
  parent_native_id   TEXT,
  ported_at          TEXT,
  mode               TEXT,
  recorded_at        TEXT,
  PRIMARY KEY (harness, instance_id, native_id)
);

CREATE INDEX IF NOT EXISTS lineage_thread_idx ON lineage(thread_id);

CREATE TABLE IF NOT EXISTS saved_views (
  name              TEXT PRIMARY KEY COLLATE NOCASE,
  harnesses         TEXT,
  cwd               TEXT,
  since_window      TEXT,
  row_limit         INTEGER,
  include_ghost     INTEGER NOT NULL DEFAULT 0,
  include_subagents INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_notes (
  harness    TEXT NOT NULL,
  instance_id TEXT NOT NULL DEFAULT 'default',
  native_id  TEXT NOT NULL,
  note       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (harness, instance_id, native_id)
);

CREATE TABLE IF NOT EXISTS session_tags (
  harness   TEXT NOT NULL,
  instance_id TEXT NOT NULL DEFAULT 'default',
  native_id TEXT NOT NULL,
  tag       TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (harness, instance_id, native_id, tag)
);

CREATE INDEX IF NOT EXISTS session_tags_tag_idx ON session_tags(tag COLLATE NOCASE);
`;

/**
 * v7 is the first identity-changing migration. It runs as one immediate
 * transaction and maps every legacy row to the stable `default` instance.
 * Table copies preserve all user metadata before any old table is dropped;
 * the FTS index is rebuilt from the copied source + metadata rows.
 */
export function migrateLedgerV7(db: import("bun:sqlite").Database): void {
  const columns = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === "instance_id")) return;

  db.transaction(() => {
    // Another Sinter process may have completed the migration while this one
    // waited for the immediate write reservation.
    const current = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (current.some((column) => column.name === "instance_id")) return;
    db.exec(`
      CREATE TABLE sessions_v7 (
        harness TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT 'default', native_id TEXT NOT NULL,
        native_path TEXT, cwd TEXT, title TEXT, first_prompt TEXT, created_at TEXT, updated_at TEXT,
        message_count INTEGER, model TEXT, git_branch TEXT, tokens_input INTEGER, tokens_output INTEGER,
        tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL,
        parent_native_id TEXT, is_subagent INTEGER NOT NULL DEFAULT 0, ghost INTEGER NOT NULL DEFAULT 0,
        host TEXT, scanned_at TEXT, PRIMARY KEY (harness, instance_id, native_id)
      );
      INSERT INTO sessions_v7
        SELECT harness, 'default', native_id, native_path, cwd, title, first_prompt, created_at, updated_at,
          message_count, model, git_branch, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
          tokens_cache_write, cost, parent_native_id, is_subagent, ghost, host, scanned_at FROM sessions;

      CREATE TABLE session_aliases_v7 (
        harness TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT 'default', native_id TEXT NOT NULL,
        alias TEXT NOT NULL, PRIMARY KEY (harness, instance_id, native_id)
      );
      INSERT INTO session_aliases_v7 SELECT harness, 'default', native_id, alias FROM session_aliases;
      CREATE TABLE session_pins_v7 (
        harness TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT 'default', native_id TEXT NOT NULL,
        pinned_at TEXT NOT NULL, PRIMARY KEY (harness, instance_id, native_id)
      );
      INSERT INTO session_pins_v7 SELECT harness, 'default', native_id, pinned_at FROM session_pins;
      CREATE TABLE session_notes_v7 (
        harness TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT 'default', native_id TEXT NOT NULL,
        note TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (harness, instance_id, native_id)
      );
      INSERT INTO session_notes_v7 SELECT harness, 'default', native_id, note, updated_at FROM session_notes;
      CREATE TABLE session_tags_v7 (
        harness TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT 'default', native_id TEXT NOT NULL,
        tag TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (harness, instance_id, native_id, tag)
      );
      INSERT INTO session_tags_v7 SELECT harness, 'default', native_id, tag FROM session_tags;
      CREATE TABLE lineage_v7 (
        harness TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT 'default', native_id TEXT NOT NULL,
        thread_id TEXT NOT NULL, hop INTEGER NOT NULL DEFAULT 0, parent_harness TEXT,
        parent_instance_id TEXT, parent_native_id TEXT, ported_at TEXT, mode TEXT, recorded_at TEXT,
        PRIMARY KEY (harness, instance_id, native_id)
      );
      INSERT INTO lineage_v7
        SELECT harness, 'default', native_id, thread_id, hop, parent_harness,
          CASE WHEN parent_harness IS NULL THEN NULL ELSE 'default' END,
          parent_native_id, ported_at, mode, recorded_at FROM lineage;

      DROP TABLE sessions_fts;
      DROP TABLE sessions;
      DROP TABLE session_aliases;
      DROP TABLE session_pins;
      DROP TABLE session_notes;
      DROP TABLE session_tags;
      DROP TABLE lineage;
      ALTER TABLE sessions_v7 RENAME TO sessions;
      ALTER TABLE session_aliases_v7 RENAME TO session_aliases;
      ALTER TABLE session_pins_v7 RENAME TO session_pins;
      ALTER TABLE session_notes_v7 RENAME TO session_notes;
      ALTER TABLE session_tags_v7 RENAME TO session_tags;
      ALTER TABLE lineage_v7 RENAME TO lineage;

      CREATE INDEX sessions_updated_idx ON sessions(updated_at DESC);
      CREATE INDEX sessions_cwd_idx ON sessions(cwd);
      CREATE INDEX sessions_prefix_idx ON sessions(native_id);
      CREATE INDEX lineage_thread_idx ON lineage(thread_id);
      CREATE INDEX session_tags_tag_idx ON session_tags(tag COLLATE NOCASE);
      CREATE VIRTUAL TABLE sessions_fts USING fts5(
        harness UNINDEXED, instance_id UNINDEXED, native_id UNINDEXED, title, first_prompt,
        tokenize = 'unicode61'
      );
      INSERT INTO sessions_fts (harness, instance_id, native_id, title, first_prompt)
        SELECT s.harness, s.instance_id, s.native_id,
          trim(coalesce(a.alias || char(10), '') || coalesce(s.title || char(10), '') ||
            coalesce((SELECT group_concat(t.tag, ' ') FROM session_tags t
              WHERE t.harness=s.harness AND t.instance_id=s.instance_id AND t.native_id=s.native_id), '')),
          trim(coalesce(s.first_prompt || char(10), '') || coalesce(n.note, ''))
        FROM sessions s
        LEFT JOIN session_aliases a ON a.harness=s.harness AND a.instance_id=s.instance_id AND a.native_id=s.native_id
        LEFT JOIN session_notes n ON n.harness=s.harness AND n.instance_id=s.instance_id AND n.native_id=s.native_id;
      INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '7');
    `);
  }).immediate();
}
