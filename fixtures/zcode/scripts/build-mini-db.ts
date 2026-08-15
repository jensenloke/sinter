#!/usr/bin/env bun
/**
 * Builds fixtures/zcode/mini.db: a tiny SQLite fixture mirroring the subset
 * of the real zcode `~/.zcode/cli/db/db.sqlite` schema the adapter reads
 * (session/message/part/turn_usage/session_entry), seeded from the sanitized
 * JSON row dumps in this directory (see extract-fixture-rows.ts for
 * provenance — two real, small sessions, secret-scanned, no redaction
 * needed).
 *
 * Plain rollback-journal mode so the fixture is a single self-contained file
 * with no -wal/-shm sidecars to check in (the real store is WAL; that's a
 * live-store concern the adapter's open-with-fallback-copy logic handles,
 * not something the fixture needs to reproduce).
 *
 * Run: bun fixtures/zcode/scripts/build-mini-db.ts
 * (Regenerates fixtures/zcode/mini.db from the JSON dumps — never touches
 * the live or scratch source store.)
 */
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const outPath = join(dir, "..", "mini.db");

for (const suffix of ["", "-wal", "-shm"]) {
  const p = outPath + suffix;
  if (existsSync(p)) rmSync(p);
}

const sessions = await Bun.file(join(dir, "mini-sessions.json")).json();
const messages = await Bun.file(join(dir, "mini-messages.json")).json();
const parts = await Bun.file(join(dir, "mini-parts.json")).json();
const turnUsage = await Bun.file(join(dir, "mini-turn-usage.json")).json();
const sessionEntries = await Bun.file(join(dir, "mini-session-entries.json")).json();

const db = new Database(outPath, { create: true });

// Schema subset (columns the adapter actually reads), mirroring the live
// hand-rolled opencode-shaped schema captured via `sqlite3 db.sqlite .schema`.
db.exec(`
CREATE TABLE session (
  id text primary key,
  project_id text not null,
  workspace_id text,
  parent_id text,
  slug text not null,
  directory text not null,
  path text,
  title text not null,
  version text not null,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  revert text,
  permission text,
  time_created integer not null,
  time_updated integer not null,
  time_compacting integer,
  time_archived integer,
  task_type text not null default 'interactive',
  title_source text not null default 'first_input',
  title_message_id text,
  time_title_updated integer,
  trace_id text
);

CREATE TABLE message (
  id text primary key,
  session_id text not null,
  time_created integer not null,
  time_updated integer not null,
  data text not null,
  sequence integer
);

CREATE TABLE part (
  id text primary key,
  message_id text not null,
  session_id text not null,
  time_created integer not null,
  time_updated integer not null,
  data text not null,
  sequence integer
);

CREATE TABLE turn_usage (
  session_id text not null,
  turn_id text not null,
  trace_id text,
  user_message_id text,
  status text not null,
  started_at integer not null,
  first_model_start_at integer,
  first_token_at integer,
  completed_at integer,
  duration_ms integer,
  time_to_first_token_ms integer,
  model_request_count integer not null default 0,
  model_retry_count integer not null default 0,
  tool_call_count integer not null default 0,
  tool_error_count integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  computed_total_tokens integer not null default 0,
  retryable integer not null default 0,
  cancelled_by_user integer not null default 0,
  context_exceeded integer not null default 0,
  error_type text,
  error_code text,
  primary key(session_id, turn_id)
);

CREATE TABLE session_entry (
  id text primary key,
  session_id text not null,
  type text not null,
  time_created integer not null,
  time_updated integer not null,
  data text not null
);

CREATE INDEX session_project_idx on session(project_id);
CREATE INDEX session_parent_idx on session(parent_id);
CREATE INDEX message_session_sequence_idx on message(session_id, sequence, time_created, id);
CREATE INDEX part_session_message_sequence_idx on part(session_id, message_id, sequence);
CREATE INDEX turn_usage_started_idx on turn_usage(started_at);
CREATE INDEX session_entry_session_idx on session_entry(session_id);
CREATE INDEX session_entry_session_type_idx on session_entry(session_id, type);
`);

const insertSession = db.prepare(
  `INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived, task_type, title_source, title_message_id, time_title_updated, trace_id)
   VALUES ($id, $project_id, $workspace_id, $parent_id, $slug, $directory, $path, $title, $version, $share_url, $summary_additions, $summary_deletions, $summary_files, $summary_diffs, $revert, $permission, $time_created, $time_updated, $time_compacting, $time_archived, $task_type, $title_source, $title_message_id, $time_title_updated, $trace_id)`,
);
for (const s of sessions) {
  insertSession.run({
    $id: s.id,
    $project_id: s.project_id,
    $workspace_id: s.workspace_id,
    $parent_id: s.parent_id,
    $slug: s.slug,
    $directory: s.directory,
    $path: s.path,
    $title: s.title,
    $version: s.version,
    $share_url: s.share_url,
    $summary_additions: s.summary_additions,
    $summary_deletions: s.summary_deletions,
    $summary_files: s.summary_files,
    $summary_diffs: s.summary_diffs,
    $revert: s.revert,
    $permission: s.permission,
    $time_created: s.time_created,
    $time_updated: s.time_updated,
    $time_compacting: s.time_compacting,
    $time_archived: s.time_archived,
    $task_type: s.task_type,
    $title_source: s.title_source,
    $title_message_id: s.title_message_id,
    $time_title_updated: s.time_title_updated,
    $trace_id: s.trace_id,
  });
}

const insertMessage = db.prepare(
  `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES ($id, $session_id, $time_created, $time_updated, $data, $sequence)`,
);
for (const m of messages) {
  insertMessage.run({
    $id: m.id,
    $session_id: m.session_id,
    $time_created: m.time_created,
    $time_updated: m.time_updated,
    $data: m.data,
    $sequence: m.sequence,
  });
}

const insertPart = db.prepare(
  `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES ($id, $message_id, $session_id, $time_created, $time_updated, $data, $sequence)`,
);
for (const p of parts) {
  insertPart.run({
    $id: p.id,
    $message_id: p.message_id,
    $session_id: p.session_id,
    $time_created: p.time_created,
    $time_updated: p.time_updated,
    $data: p.data,
    $sequence: p.sequence,
  });
}

const insertTurnUsage = db.prepare(
  `INSERT INTO turn_usage (session_id, turn_id, trace_id, user_message_id, status, started_at, first_model_start_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms, model_request_count, model_retry_count, tool_call_count, tool_error_count, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens, retryable, cancelled_by_user, context_exceeded, error_type, error_code)
   VALUES ($session_id, $turn_id, $trace_id, $user_message_id, $status, $started_at, $first_model_start_at, $first_token_at, $completed_at, $duration_ms, $time_to_first_token_ms, $model_request_count, $model_retry_count, $tool_call_count, $tool_error_count, $input_tokens, $output_tokens, $reasoning_tokens, $cache_creation_input_tokens, $cache_read_input_tokens, $computed_total_tokens, $retryable, $cancelled_by_user, $context_exceeded, $error_type, $error_code)`,
);
for (const t of turnUsage) {
  insertTurnUsage.run({
    $session_id: t.session_id,
    $turn_id: t.turn_id,
    $trace_id: t.trace_id,
    $user_message_id: t.user_message_id,
    $status: t.status,
    $started_at: t.started_at,
    $first_model_start_at: t.first_model_start_at,
    $first_token_at: t.first_token_at,
    $completed_at: t.completed_at,
    $duration_ms: t.duration_ms,
    $time_to_first_token_ms: t.time_to_first_token_ms,
    $model_request_count: t.model_request_count,
    $model_retry_count: t.model_retry_count,
    $tool_call_count: t.tool_call_count,
    $tool_error_count: t.tool_error_count,
    $input_tokens: t.input_tokens,
    $output_tokens: t.output_tokens,
    $reasoning_tokens: t.reasoning_tokens,
    $cache_creation_input_tokens: t.cache_creation_input_tokens,
    $cache_read_input_tokens: t.cache_read_input_tokens,
    $computed_total_tokens: t.computed_total_tokens,
    $retryable: t.retryable,
    $cancelled_by_user: t.cancelled_by_user,
    $context_exceeded: t.context_exceeded,
    $error_type: t.error_type,
    $error_code: t.error_code,
  });
}

const insertSessionEntry = db.prepare(
  `INSERT INTO session_entry (id, session_id, type, time_created, time_updated, data) VALUES ($id, $session_id, $type, $time_created, $time_updated, $data)`,
);
for (const e of sessionEntries) {
  insertSessionEntry.run({
    $id: e.id,
    $session_id: e.session_id,
    $type: e.type,
    $time_created: e.time_created,
    $time_updated: e.time_updated,
    $data: e.data,
  });
}

db.close();

console.log(`wrote ${outPath}`);
