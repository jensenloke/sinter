/**
 * Test-only stand-in for `opencode import`.
 *
 * `write()` shells out to the real `opencode` CLI, which would land rows in the
 * user's live store — never acceptable from a test. This helper does exactly
 * what src/cli/cmd/import.ts does with an export payload instead: parse the
 * session/message/part records and insert them into a SQLite db with opencode's
 * schema, hoisting `id`/`sessionID`/`messageID` out of the JSON blobs the way
 * the real importer does. That makes a genuine write → store → read round trip
 * testable offline.
 */
import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  parent_id text,
  slug text NOT NULL,
  directory text NOT NULL,
  title text NOT NULL,
  version text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
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
CREATE TABLE IF NOT EXISTS message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
CREATE TABLE IF NOT EXISTS part (
  id text PRIMARY KEY,
  message_id text NOT NULL,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
`;

/** Inserts one `opencode export`-shaped payload into `dbPath`. Returns its session id. */
export function materializeExport(dbPath: string, payload: any): string {
  const db = new Database(dbPath, { create: true });
  try {
    db.exec(SCHEMA);
    const info = payload.info;
    db.run(
      `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated,
                            path, agent, model, cost, tokens_input, tokens_output, tokens_reasoning,
                            tokens_cache_read, tokens_cache_write)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        info.id,
        info.projectID ?? "global",
        null,
        info.slug ?? "imported",
        info.directory ?? "",
        info.title ?? "",
        info.version ?? "sinter",
        info.time?.created ?? 0,
        info.time?.updated ?? info.time?.created ?? 0,
        info.path ?? "",
        info.agent ?? null,
        info.model ? JSON.stringify(info.model) : null,
        info.cost ?? 0,
        info.tokens?.input ?? 0,
        info.tokens?.output ?? 0,
        info.tokens?.reasoning ?? 0,
        info.tokens?.cache?.read ?? 0,
        info.tokens?.cache?.write ?? 0,
      ],
    );

    // Real part rows are stamped with their insertion time, so a monotonic
    // counter here reproduces the store's (time_created, id) ordering.
    let partClock = 0;
    for (const msg of payload.messages) {
      const { id, sessionID: _s, ...msgData } = msg.info;
      const created = msg.info.time?.created ?? 0;
      db.run("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)", [
        id,
        info.id,
        created,
        created,
        JSON.stringify(msgData),
      ]);
      for (const part of msg.parts) {
        const { id: partId, sessionID: _ps, messageID, ...partData } = part;
        partClock += 1;
        db.run("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)", [
          partId,
          messageID,
          info.id,
          partClock,
          partClock,
          JSON.stringify(partData),
        ]);
      }
    }
    return info.id as string;
  } finally {
    db.close();
  }
}
