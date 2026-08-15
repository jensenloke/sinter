#!/usr/bin/env bun
/**
 * Builds a synthetic SQLite fixture matching the opencode schema subset the
 * adapter reads. The JSON sources are fictional and never access a live store.
 *
 * Run: bun fixtures/opencode/scripts/build-mini-db.ts
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

const project = await Bun.file(join(dir, "mini-project.json")).json();
const sessions = await Bun.file(join(dir, "mini-sessions.json")).json();
const messages = await Bun.file(join(dir, "mini-messages.json")).json();
const parts = await Bun.file(join(dir, "mini-parts.json")).json();

const db = new Database(outPath, { create: true });
// Plain rollback-journal mode so the fixture is a single self-contained
// file with no -wal/-shm sidecars to check in.

// Schema subset (columns the adapter actually reads), mirroring the live
// drizzle schema captured via `sqlite3 opencode.db .schema`.
db.exec(`
CREATE TABLE project (
  id text PRIMARY KEY,
  worktree text NOT NULL,
  vcs text,
  name text,
  icon_url text,
  icon_color text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_initialized integer,
  sandboxes text NOT NULL,
  commands text,
  icon_url_override text
);

CREATE TABLE session (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  parent_id text,
  slug text NOT NULL,
  directory text NOT NULL,
  title text NOT NULL,
  version text NOT NULL,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  revert text,
  permission text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_compacting integer,
  time_archived integer,
  workspace_id text,
  path text,
  agent text,
  model text,
  cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL,
  tokens_cache_write integer DEFAULT 0 NOT NULL,
  metadata text
);

CREATE TABLE message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);

CREATE TABLE part (
  id text PRIMARY KEY,
  message_id text NOT NULL,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);

CREATE INDEX session_project_idx ON session (project_id);
CREATE INDEX session_parent_idx ON session (parent_id);
CREATE INDEX part_session_idx ON part (session_id);
CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
CREATE INDEX part_message_id_id_idx ON part (message_id, id);
`);

const insertProject = db.prepare(
  `INSERT INTO project (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands, icon_url_override)
   VALUES ($id, $worktree, $vcs, $name, $icon_url, $icon_color, $time_created, $time_updated, $time_initialized, $sandboxes, $commands, $icon_url_override)`,
);
insertProject.run({
  $id: project[0].id,
  $worktree: project[0].worktree,
  $vcs: project[0].vcs,
  $name: project[0].name,
  $icon_url: project[0].icon_url,
  $icon_color: project[0].icon_color,
  $time_created: project[0].time_created,
  $time_updated: project[0].time_updated,
  $time_initialized: project[0].time_initialized,
  $sandboxes: project[0].sandboxes,
  $commands: project[0].commands,
  $icon_url_override: project[0].icon_url_override,
});

const insertSession = db.prepare(
  `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived, workspace_id, path, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, metadata)
   VALUES ($id, $project_id, $parent_id, $slug, $directory, $title, $version, $share_url, $summary_additions, $summary_deletions, $summary_files, $summary_diffs, $revert, $permission, $time_created, $time_updated, $time_compacting, $time_archived, $workspace_id, $path, $agent, $model, $cost, $tokens_input, $tokens_output, $tokens_reasoning, $tokens_cache_read, $tokens_cache_write, $metadata)`,
);
for (const s of sessions) {
  insertSession.run({
    $id: s.id,
    $project_id: s.project_id,
    $parent_id: s.parent_id,
    $slug: s.slug,
    $directory: s.directory,
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
    $workspace_id: s.workspace_id,
    $path: s.path,
    $agent: s.agent,
    $model: s.model,
    $cost: s.cost,
    $tokens_input: s.tokens_input,
    $tokens_output: s.tokens_output,
    $tokens_reasoning: s.tokens_reasoning,
    $tokens_cache_read: s.tokens_cache_read,
    $tokens_cache_write: s.tokens_cache_write,
    $metadata: s.metadata,
  });
}

const insertMessage = db.prepare(
  `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ($id, $session_id, $time_created, $time_updated, $data)`,
);
for (const m of messages) {
  insertMessage.run({
    $id: m.id,
    $session_id: m.session_id,
    $time_created: m.time_created,
    $time_updated: m.time_updated,
    $data: m.data,
  });
}

const insertPart = db.prepare(
  `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ($id, $message_id, $session_id, $time_created, $time_updated, $data)`,
);
for (const p of parts) {
  insertPart.run({
    $id: p.id,
    $message_id: p.message_id,
    $session_id: p.session_id,
    $time_created: p.time_created,
    $time_updated: p.time_updated,
    $data: p.data,
  });
}

// --- synthetic child session, to exercise parent_id -> subsession without
// needing a large real transcript in the fixture. Entirely fabricated (not
// copied from any real conversation).
const parentId = "synthetic-1393";
const childId = "ses_synthetic_child_0001";
const childMsgId = "msg_minifakechild0000000001";
const childPartId = "prt_minifakechild0000000001";
const childTimeCreated = 1786205870000;

insertSession.run({
  $id: childId,
  $project_id: project[0].id,
  $parent_id: parentId,
  $slug: "mini-fake-child",
  $directory: "/workspace/synthetic-project",
  $title: "synthetic fixture subsession",
  $version: "1.18.14",
  $share_url: null,
  $summary_additions: 0,
  $summary_deletions: 0,
  $summary_files: 0,
  $summary_diffs: null,
  $revert: null,
  $permission: null,
  $time_created: childTimeCreated,
  $time_updated: childTimeCreated + 500,
  $time_compacting: null,
  $time_archived: null,
  $workspace_id: null,
  $path: "",
  $agent: "build",
  $model: JSON.stringify({ id: "dgx-current", providerID: "dgx-router", variant: "default" }),
  $cost: 0,
  $tokens_input: 10,
  $tokens_output: 2,
  $tokens_reasoning: 0,
  $tokens_cache_read: 0,
  $tokens_cache_write: 0,
  $metadata: null,
});

insertMessage.run({
  $id: childMsgId,
  $session_id: childId,
  $time_created: childTimeCreated,
  $time_updated: childTimeCreated,
  $data: JSON.stringify({
    role: "user",
    time: { created: childTimeCreated },
    agent: "build",
    model: { providerID: "dgx-router", modelID: "dgx-current" },
    summary: { diffs: [] },
    id: childMsgId,
    sessionID: childId,
  }),
});

insertPart.run({
  $id: childPartId,
  $message_id: childMsgId,
  $session_id: childId,
  $time_created: childTimeCreated,
  $time_updated: childTimeCreated,
  $data: JSON.stringify({
    type: "text",
    text: "synthetic subsession fixture prompt",
    id: childPartId,
    sessionID: childId,
    messageID: childMsgId,
  }),
});

db.close();

console.log(`wrote ${outPath}`);
