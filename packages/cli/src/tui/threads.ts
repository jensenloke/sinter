/**
 * Threads: one conversation, however many harnesses it has lived in.
 *
 * A ported session gets a NEW native id in the target store, so `codex:abc →
 * claude:def → codex:ghi` is three ledger rows describing one conversation.
 * A thread stitches them back together.
 *
 * Lineage links are recorded by the writers into the TARGET store's provenance
 * marker (not just the ledger), so `sinter scan` can rebuild threads from the
 * stores alone. Until the writers emit them, `links` is empty and every row is
 * its own single-hop thread — which is exactly what the menu should show.
 */

import type { HarnessId } from "@sinter/core";
import type { LedgerRow } from "@sinter/ledger";

/**
 * "this native session was ported FROM that one".
 *
 * Structurally compatible with `LineageRow` from @sinter/ledger, which is where
 * these come from in the running CLI; kept as its own type so the thread model
 * stays testable without a database.
 */
export interface LineageLink {
  threadId: string;
  harness: HarnessId;
  nativeId: string;
  /** 0-based position in the thread. Authoritative ordering when present. */
  hop?: number;
  parentHarness?: HarnessId;
  parentNativeId?: string;
  portedAt?: string;
}

export interface Thread {
  /** sinter's stable id, or `harness:native_id` for an unported session. */
  id: string;
  /** Oldest hop first. Always at least one. */
  hops: LedgerRow[];
  /** The newest hop — what `resume` and the next port work from. */
  tip: LedgerRow;
  /** True once the conversation has crossed a harness boundary. */
  ported: boolean;
}

const key = (harness: string, nativeId: string) => `${harness}\\0${nativeId}`;
const rowKey = (r: LedgerRow) => key(r.harness, r.nativeId);

function sortKey(r: LedgerRow): string {
  return r.updatedAt ?? r.createdAt ?? "";
}

/**
 * Group rows into threads. Rows with no lineage link become single-hop threads.
 * Threads are ordered by their tip, newest first — the same ordering the flat
 * list had, so the menu reads identically before lineage exists.
 */
export function buildThreads(rows: LedgerRow[], links: LineageLink[] = []): Thread[] {
  const threadIdOf = new Map<string, string>();
  const hopOf = new Map<string, number>();
  for (const l of links) {
    const k = key(l.harness, l.nativeId);
    threadIdOf.set(k, l.threadId);
    if (typeof l.hop === "number") hopOf.set(k, l.hop);
  }

  const groups = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const id = threadIdOf.get(rowKey(r)) ?? rowKey(r);
    const g = groups.get(id);
    if (g) g.push(r);
    else groups.set(id, [r]);
  }

  const threads: Thread[] = [];
  for (const [id, hops] of groups) {
    // `hop` is authoritative when lineage knows it: two ports moments apart can
    // carry indistinguishable timestamps, and a wall clock is not an ordering.
    hops.sort((a, b) => {
      const ha = hopOf.get(rowKey(a));
      const hb = hopOf.get(rowKey(b));
      if (ha !== undefined && hb !== undefined && ha !== hb) return ha - hb;
      return sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0;
    });
    const tip = hops[hops.length - 1]!;
    threads.push({
      id: id.includes("\\0") ? id.replace("\\0", ":") : id,
      hops,
      tip,
      ported: hops.length > 1,
    });
  }

  threads.sort((a, b) => (sortKey(a.tip) < sortKey(b.tip) ? 1 : sortKey(a.tip) > sortKey(b.tip) ? -1 : 0));
  return threads;
}

/** `codex → claude → omp`, for the thread's detail line. */
export function chainLabel(thread: Thread): string {
  return thread.hops.map((h) => h.harness).join(" → ");
}

/** Harnesses this conversation already lives in — a re-port target is not new work. */
export function harnessesIn(thread: Thread): Set<HarnessId> {
  return new Set(thread.hops.map((h) => h.harness));
}
