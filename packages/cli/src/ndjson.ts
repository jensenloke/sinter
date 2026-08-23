import type { SifEntry, SifSession } from "@sinter/core";

export const TRANSCRIPT_NDJSON_SCHEMA = "sinter.transcript.ndjson.v1" as const;

export interface SessionRecord {
  schema: typeof TRANSCRIPT_NDJSON_SCHEMA;
  type: "session";
  parentSessionId?: string;
  session: Omit<SifSession, "entries" | "subsessions">;
}

export interface EntryRecord {
  schema: typeof TRANSCRIPT_NDJSON_SCHEMA;
  type: "entry";
  sessionId: string;
  index: number;
  entry: SifEntry;
}

export type TranscriptRecord = SessionRecord | EntryRecord;

/**
 * Stream-shaped, reconstructable SIF: session metadata first, then ordered
 * entries, then each nested session using the same shape.
 */
export function* transcriptRecords(
  session: SifSession,
  options: { subsessions?: boolean; parentSessionId?: string } = {},
): Generator<TranscriptRecord> {
  const { entries, subsessions, ...metadata } = session;
  yield {
    schema: TRANSCRIPT_NDJSON_SCHEMA,
    type: "session",
    ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    session: metadata,
  };
  for (let index = 0; index < entries.length; index++) {
    yield {
      schema: TRANSCRIPT_NDJSON_SCHEMA,
      type: "entry",
      sessionId: session.id,
      index,
      entry: entries[index]!,
    };
  }
  if (options.subsessions === false) return;
  for (const child of subsessions ?? []) {
    yield* transcriptRecords(child, { subsessions: true, parentSessionId: session.id });
  }
}

export function transcriptNdjson(session: SifSession, options: { subsessions?: boolean } = {}): string {
  return Array.from(transcriptRecords(session, options), (record) => JSON.stringify(record)).join("\n");
}
