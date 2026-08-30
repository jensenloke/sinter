/**
 * Session lineage — the contract that lets one conversation keep its identity
 * across every harness it is ported into.
 *
 * Two levels of id:
 *   - `nativeId`  belongs to the harness. sinter never rewrites it.
 *   - `threadId`  belongs to sinter. Minted at the FIRST port and carried
 *                 unchanged through every hop after that.
 *
 * The record below is written by `HarnessAdapter.write()` into the TARGET
 * store, in that store's native idiom (a `custom` entry for omp/pi, an import
 * note for opencode, …). The ledger's lineage table is a cache of it — if the
 * ledger is deleted, `sinter relink` rebuilds it by reading the stores.
 *
 * Adapters must round-trip it: `read()` puts whatever it finds under
 * `session.preserve[PRESERVE_KEY]`.
 */

import { DEFAULT_INSTANCE_ID, type HarnessId, type InstanceId, type SifSession } from "./sif";
import { mintSifId } from "./util";

/** Where a round-tripped provenance record lives on a SIF session. */
export const PRESERVE_KEY = "sinter" as const;

/** Bumped when the record's shape changes incompatibly. */
export const LINEAGE_VERSION = 1;

/** One session in a thread's ancestry. */
export interface Hop {
  harness: HarnessId;
  /** Configured harness instance. Omitted in legacy records and means `default`. */
  instanceId?: InstanceId;
  nativeId: string;
  host?: string;
}

/**
 * What a writer stamps into the target store.
 *
 * `chain` is the whole ordered ancestry INCLUDING the session being written, so
 * a single record is enough to rebuild the thread even when the intermediate
 * stores have been garbage-collected.
 */
export interface SinterProvenance {
  v: typeof LINEAGE_VERSION;
  /** sinter version that wrote the record. */
  sinter: string;
  threadId: string;
  /** 0-based position of this session within `chain`. */
  hop: number;
  chain: Hop[];
  /** Immediate parent — `chain[hop - 1]`, denormalised for cheap reads. */
  from?: Hop;
  portedAt: string;
  /** Transfer mode the port used: full | slim | compact | digest. */
  mode?: string;
  /** False when historical tool calls were left executable (same-harness moves). */
  inertTools?: boolean;
  /** gzip+base64 of the source SIF, inlined when small — see `encodeCarry`. */
  carry?: string;
  /** Path to a sidecar carry file when the payload is too big to inline. */
  carryRef?: string;
  /** Bytes of the pre-compression carry payload, for reporting. */
  carryBytes?: number;
}

export function mintThreadId(): string {
  return mintSifId();
}

// ------------------------------------------------------------------- reading

function isHop(x: unknown): x is Hop {
  const h = x as Hop | undefined;
  return !!h && typeof h === "object" && typeof h.harness === "string" && typeof h.nativeId === "string";
}

function sameHop(a: Hop | undefined, b: Hop): boolean {
  return !!a && a.harness === b.harness && (a.instanceId ?? DEFAULT_INSTANCE_ID) ===
    (b.instanceId ?? DEFAULT_INSTANCE_ID) && a.nativeId === b.nativeId;
}

/**
 * Tolerant parse. Anything that is not a well-formed record — including the
 * v0 `{sinter, sourceHarness, sourceNativeId}` marker earlier writers emitted —
 * is upgraded when possible and dropped when not. Unknown ≠ error.
 */
export function readProvenance(raw: unknown): SinterProvenance | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;

  if (typeof r.threadId === "string" && Array.isArray(r.chain)) {
    const chain = r.chain.filter(isHop);
    if (!chain.length) return undefined;
    const hop = typeof r.hop === "number" && r.hop >= 0 ? Math.min(r.hop, chain.length - 1) : chain.length - 1;
    return {
      v: LINEAGE_VERSION,
      sinter: typeof r.sinter === "string" ? r.sinter : "0",
      threadId: r.threadId,
      hop,
      chain,
      from: isHop(r.from) ? r.from : chain[hop - 1],
      portedAt: typeof r.portedAt === "string" ? r.portedAt : "",
      mode: typeof r.mode === "string" ? r.mode : undefined,
      inertTools: typeof r.inertTools === "boolean" ? r.inertTools : undefined,
      carry: typeof r.carry === "string" ? r.carry : undefined,
      // Dropping this would strand every sidecar payload `storeCarry` wrote:
      // the blob is on disk but nothing left in the record points at it.
      carryRef: typeof r.carryRef === "string" ? r.carryRef : undefined,
      carryBytes: typeof r.carryBytes === "number" ? r.carryBytes : undefined,
    };
  }

  // v0 marker: a single known parent, no thread identity. Synthesise a
  // two-hop chain so pre-lineage ports still group correctly; the thread id is
  // derived from the parent so repeated reads agree on it.
  if (typeof r.sourceHarness === "string" && typeof r.sourceNativeId === "string") {
    const parent: Hop = { harness: r.sourceHarness as HarnessId, nativeId: r.sourceNativeId };
    return {
      v: LINEAGE_VERSION,
      sinter: typeof r.sinter === "string" ? r.sinter : "0",
      threadId: `legacy:${parent.harness}:${parent.nativeId}`,
      hop: 1,
      chain: [parent],
      from: parent,
      portedAt: typeof r.importedAt === "string" ? r.importedAt : "",
    };
  }

  return undefined;
}

/**
 * The provenance an adapter round-tripped onto a session, if any.
 *
 * Completes the chain with the session's OWN identity when the stored record
 * does not already end there. A v0 legacy marker records only where the session
 * came FROM — it never knew its own native id, because the writer minted that
 * id and the marker predates the chain format. Only a reader holding the
 * session can supply the missing final hop, so without this repair a relinked
 * legacy port produces a thread containing its ancestor but not itself.
 */
export function provenanceOf(session: SifSession): SinterProvenance | undefined {
  const prov = readProvenance(session.preserve?.[PRESERVE_KEY]);
  if (!prov) return undefined;

  const self: Hop = {
    harness: session.origin.harness,
    ...(session.origin.instanceId ? { instanceId: session.origin.instanceId } : {}),
    nativeId: session.origin.nativeId,
    ...(session.origin.host ? { host: session.origin.host } : {}),
  };
  const last = prov.chain[prov.chain.length - 1];
  if (sameHop(last, self)) return prov;

  const chain = [...prov.chain, self];
  return { ...prov, chain, hop: chain.length - 1, from: chain[chain.length - 2] };
}

// ------------------------------------------------------------------- writing

export interface BuildProvenanceOpts {
  /** The session being ported, as read from the source store. */
  source: SifSession;
  /** Where it is being written. */
  target: Hop;
  sinterVersion: string;
  portedAt: string;
  mode?: string;
  inertTools?: boolean;
  carry?: string;
  carryBytes?: number;
}

/**
 * Extend the source's chain by one hop, or start a new thread when the source
 * has never been ported. Re-porting BACK into a harness already in the chain is
 * a normal append, not a cycle to collapse: it is a real, later hop.
 */
export function buildProvenance(opts: BuildProvenanceOpts): SinterProvenance {
  const prior = provenanceOf(opts.source);
  const self: Hop = {
    harness: opts.source.origin.harness,
    ...(opts.source.origin.instanceId ? { instanceId: opts.source.origin.instanceId } : {}),
    nativeId: opts.source.origin.nativeId,
    ...(opts.source.origin.host ? { host: opts.source.origin.host } : {}),
  };

  // The source's own chain already ends at the source when it was itself
  // ported; otherwise the source is the root.
  const base: Hop[] = prior ? dedupeTail(prior.chain, self) : [self];
  const chain = [...base, opts.target];

  return {
    v: LINEAGE_VERSION,
    sinter: opts.sinterVersion,
    threadId: prior?.threadId ?? mintThreadId(),
    hop: chain.length - 1,
    chain,
    from: chain[chain.length - 2],
    portedAt: opts.portedAt,
    mode: opts.mode,
    inertTools: opts.inertTools,
    carry: opts.carry,
    carryBytes: opts.carryBytes,
  };
}

/** Append `self` to `chain` unless it is already the last element. */
function dedupeTail(chain: Hop[], self: Hop): Hop[] {
  const last = chain[chain.length - 1];
  if (sameHop(last, self)) return chain;
  return [...chain, self];
}

// ------------------------------------------------------- carry-forward SIF

/**
 * Ports flatten historical tool calls to inert text so the receiving harness
 * can never re-run them. That is correct but lossy, and doing it twice nests
 * the markers — a three-hop transcript degrades badly.
 *
 * Carry-forward avoids it: the writer stashes the ORIGINAL SIF next to the
 * flattened transcript. A later hop reads the original entries instead of
 * re-parsing its own inert output.
 */
export const CARRY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Above this compressed size the payload goes to a sidecar file instead of
 * inline. Harness stores are line-oriented JSONL or SQLite rows written by
 * someone else's parser; a multi-megabyte value inside one of their records is
 * a good way to break them. sinter keeps big blobs in its own directory.
 */
export const CARRY_INLINE_MAX = 256 * 1024;

export function encodeCarry(session: SifSession, maxBytes = CARRY_MAX_BYTES): string | undefined {
  const json = JSON.stringify(session);
  if (json.length > maxBytes) return undefined;
  const gz = Bun.gzipSync(new TextEncoder().encode(json));
  return Buffer.from(gz).toString("base64");
}

/** `~/.sinter/carry/<harness>/<nativeId>.sif.json.gz` — sinter's own directory. */
export function carrySidecarPath(
  harness: HarnessId,
  nativeId: string,
  root?: string,
  instanceId: InstanceId = DEFAULT_INSTANCE_ID,
): string {
  const home = root ?? `${process.env.SINTER_HOME ?? `${process.env.HOME}/.sinter`}`;
  const instancePrefix = instanceId === DEFAULT_INSTANCE_ID ? "" : `${instanceId.replace(/[/\\]/g, "_")}__`;
  return `${home}/carry/${harness}/${instancePrefix}${nativeId.replace(/[/\\]/g, "_")}.sif.json.gz`;
}

export function decodeCarry(encoded: string | undefined): SifSession | undefined {
  if (!encoded) return undefined;
  try {
    const gz = Buffer.from(encoded, "base64");
    const json = new TextDecoder().decode(Bun.gunzipSync(gz));
    const parsed = JSON.parse(json) as SifSession;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.entries) ? parsed : undefined;
  } catch {
    // A corrupt or truncated blob must never take a read down: the flattened
    // transcript in the store is still perfectly usable.
    return undefined;
  }
}

/**
 * Persist a carry payload, inline when small and to a sidecar when not.
 * Returns the fields to merge into the provenance record.
 */
export async function storeCarry(
  session: SifSession,
  target: Hop,
  opts: { root?: string; maxBytes?: number } = {},
): Promise<Pick<SinterProvenance, "carry" | "carryRef" | "carryBytes">> {
  const encoded = encodeCarry(session, opts.maxBytes);
  if (!encoded) return {};
  const carryBytes = JSON.stringify(session).length;
  if (encoded.length <= CARRY_INLINE_MAX) return { carry: encoded, carryBytes };

  const path = carrySidecarPath(target.harness, target.nativeId, opts.root, target.instanceId);
  await Bun.write(path, Buffer.from(encoded, "base64"));
  return { carryRef: path, carryBytes };
}

/** Recover a carried SIF from either location. Never throws. */
export async function loadCarry(prov: SinterProvenance | undefined): Promise<SifSession | undefined> {
  if (!prov) return undefined;
  if (prov.carry) return decodeCarry(prov.carry);
  if (!prov.carryRef) return undefined;
  try {
    const bytes = await Bun.file(prov.carryRef).arrayBuffer();
    return decodeCarry(Buffer.from(bytes).toString("base64"));
  } catch {
    return undefined;
  }
}

/** Attach a provenance record to a session for the writer to persist. */
export function withProvenance(session: SifSession, prov: SinterProvenance): SifSession {
  return { ...session, preserve: { ...session.preserve, [PRESERVE_KEY]: prov } };
}
