/**
 * omp's fixed-width 256-byte title slot (line 1). Faithful port of
 * ~/node_modules/@oh-my-pi/pi-coding-agent/src/session/session-title-slot.ts
 *
 * The slot exists so omp can rewrite a title with one 256-byte pwrite. It IS
 * valid JSON — it is just not a session *entry* — so a lenient JSONL reader
 * parses it fine; readers must recognise it and fold it over the header
 * (`session-loader.ts:foldTitleSlot`: the slot WINS over `header.title`, and an
 * empty slot title DELETES it).
 */

import { SESSION_TITLE_SLOT_BYTES, type TitleSlot, type TitleSource, isTitleSlot } from "./native";

export type { TitleSlot, TitleSource };

const enc = new TextEncoder();

function byteLength(s: string): number {
  return enc.encode(s).byteLength;
}

function slotLine(title: string, source: TitleSource | undefined, updatedAt: string, pad: string): string {
  // Key order matters: it is what makes the byte budget reproducible.
  const slot: TitleSlot = source
    ? { type: "title", v: 1, title, source, updatedAt, pad }
    : { type: "title", v: 1, title, updatedAt, pad };
  return `${JSON.stringify(slot)}\n`;
}

/** Binary search by CODE POINT until the serialized line fits the slot. */
function truncateTitleForSlot(title: string, source: TitleSource | undefined, updatedAt: string): string {
  const cps = [...title];
  let low = 0;
  let high = cps.length;
  let best = "";
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const candidate = cps.slice(0, mid).join("");
    if (byteLength(slotLine(candidate, source, updatedAt, "")) <= SESSION_TITLE_SLOT_BYTES) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export interface TitleUpdate {
  title?: string;
  source?: TitleSource;
  updatedAt: string;
}

/** Serialize the slot to EXACTLY 256 UTF-8 bytes, trailing newline included. */
export function serializeTitleSlot(update: TitleUpdate): string {
  const title = truncateTitleForSlot(update.title ?? "", update.source, update.updatedAt);
  const unpadded = slotLine(title, update.source, update.updatedAt, "");
  const padBytes = SESSION_TITLE_SLOT_BYTES - byteLength(unpadded);
  if (padBytes < 0) throw new Error("session title slot metadata exceeds fixed slot size");
  const line = slotLine(title, update.source, update.updatedAt, " ".repeat(padBytes));
  if (byteLength(line) !== SESSION_TITLE_SLOT_BYTES) {
    throw new Error("session title slot serialization failed to produce fixed-width output");
  }
  return line;
}

export function parseTitleSlotLine(line: string): TitleSlot | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return isTitleSlot(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export interface PeeledContent {
  /** The JSONL body with the slot removed (identical to input when absent). */
  body: string;
  slot?: TitleSlot;
  /** Byte length of the physical slot line, for drift detection. */
  slotBytes?: number;
}

/** Peel the optional slot off a full or partial session body. */
export function peelTitleSlot(content: string): PeeledContent {
  const nl = content.indexOf("\n");
  if (nl < 0) return { body: content };
  const first = content.slice(0, nl);
  const slot = parseTitleSlotLine(first.trim());
  if (!slot) return { body: content };
  return { body: content.slice(nl + 1), slot, slotBytes: byteLength(first) + 1 };
}
