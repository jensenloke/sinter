import type { HarnessId, SifEntry, SifSession } from "@sinter/core";

export const COMPARE_SCHEMA = "sinter.compare.v1" as const;

export const ENTRY_KINDS = [
  "user",
  "assistant",
  "toolResult",
  "compaction",
  "modelChange",
  "subsession",
  "note",
] as const satisfies readonly SifEntry["kind"][];
export const CONTENT_TYPES = ["text", "thinking", "image", "toolCall"] as const;

type EntryCounts = Record<(typeof ENTRY_KINDS)[number], number>;
type ContentCounts = Record<(typeof CONTENT_TYPES)[number], number>;

export interface SessionInventory {
  origin: { harness: HarnessId; nativeId: string };
  sessions: number;
  entries: number;
  entriesWithRaw: number;
  sessionsWithPreserve: number;
  entryKinds: EntryCounts;
  contentParts: ContentCounts;
  models: string[];
}

export interface SessionComparison {
  schema: typeof COMPARE_SCHEMA;
  left: SessionInventory;
  right: SessionInventory;
  /** Every value is right minus left. Counts describe shape, not semantic equivalence. */
  delta: {
    sessions: number;
    entries: number;
    entriesWithRaw: number;
    sessionsWithPreserve: number;
    entryKinds: EntryCounts;
    contentParts: ContentCounts;
  };
}

const zeroEntries = (): EntryCounts => Object.fromEntries(ENTRY_KINDS.map((kind) => [kind, 0])) as EntryCounts;
const zeroContent = (): ContentCounts => Object.fromEntries(CONTENT_TYPES.map((type) => [type, 0])) as ContentCounts;

export function inventorySession(root: SifSession): SessionInventory {
  const inventory: SessionInventory = {
    origin: { harness: root.origin.harness, nativeId: root.origin.nativeId },
    sessions: 0,
    entries: 0,
    entriesWithRaw: 0,
    sessionsWithPreserve: 0,
    entryKinds: zeroEntries(),
    contentParts: zeroContent(),
    models: [],
  };
  const models = new Set<string>();

  const visit = (session: SifSession) => {
    inventory.sessions++;
    if (session.preserve && Object.keys(session.preserve).length) inventory.sessionsWithPreserve++;
    for (const entry of session.entries) {
      inventory.entries++;
      inventory.entryKinds[entry.kind]++;
      if (entry.raw !== undefined) inventory.entriesWithRaw++;
      if (entry.kind === "assistant" && entry.model?.id) models.add(entry.model.id);
      if (entry.kind === "modelChange") models.add(entry.model);
      if ("content" in entry) {
        for (const part of entry.content) inventory.contentParts[part.type]++;
      }
    }
    for (const child of session.subsessions ?? []) visit(child);
  };
  visit(root);
  inventory.models = [...models].sort();
  return inventory;
}

const deltaRecord = <K extends string>(left: Record<K, number>, right: Record<K, number>): Record<K, number> =>
  Object.fromEntries(Object.keys(left).map((key) => [key, right[key as K] - left[key as K]])) as Record<K, number>;

export function compareSessions(leftSession: SifSession, rightSession: SifSession): SessionComparison {
  const left = inventorySession(leftSession);
  const right = inventorySession(rightSession);
  return {
    schema: COMPARE_SCHEMA,
    left,
    right,
    delta: {
      sessions: right.sessions - left.sessions,
      entries: right.entries - left.entries,
      entriesWithRaw: right.entriesWithRaw - left.entriesWithRaw,
      sessionsWithPreserve: right.sessionsWithPreserve - left.sessionsWithPreserve,
      entryKinds: deltaRecord(left.entryKinds, right.entryKinds),
      contentParts: deltaRecord(left.contentParts, right.contentParts),
    },
  };
}
