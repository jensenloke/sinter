import type { SinterProvenance } from "./lineage";
import type { HarnessId, InstanceId, SessionSummary, SifSession } from "./sif";

/** Where a harness keeps its sessions, as detected on this machine. */
export interface StoreInfo {
  harness: HarnessId;
  instanceId?: InstanceId;
  /** Root path(s) of the store, e.g. ~/.claude/projects or the SQLite file. */
  paths: string[];
  /** Harness version if cheaply knowable (from records/db rows, not by running it). */
  version?: string;
  notes?: string;
}

/** How to address one native session. */
export interface SessionRef {
  harness: HarnessId;
  /** Configured harness instance. Omitted means the stable default instance. */
  instanceId?: InstanceId;
  nativeId: string;
  nativePath?: string;
}

export interface WriteOpts {
  /** Target cwd for the synthesized session; defaults to the SIF session cwd. */
  cwd?: string;
  /** Transfer mode stamped into port provenance for later lineage inspection. */
  mode?: string;
  /**
   * When false (the default), historical tool calls/results are flattened into
   * inert text so the target harness can never re-execute them. `true` is only
   * for same-harness moves.
   */
  liveTools?: boolean;
  /** Dry-run: validate + report what would be written, write nothing. */
  dryRun?: boolean;
}

export interface NativeRef extends SessionRef {
  /** Files/rows created, for reporting. */
  created: string[];
  /**
   * The lineage record the writer stamped into the target store, so the caller
   * can cache it in the ledger without re-reading the session it just wrote.
   * Optional: a caller that needs it and does not get it can recover it with
   * `provenanceOf(await adapter.read(ref))`.
   */
  provenance?: SinterProvenance;
}

/**
 * One per harness. Rules every adapter must follow:
 * - read()/list() NEVER mutate the source store. SQLite opens use mode=ro
 *   (never immutable=1 on live WAL databases — it silently reads stale data).
 * - Lenient parsing: skip unparseable lines, pass unknown record types through
 *   as NoteEntry with `raw` attached. Unknown ≠ error.
 * - write() always mints a NEW native session id, never touches existing
 *   sessions, and appends a sinter provenance marker in the target's native
 *   idiom (custom entry / metadata field / note record).
 * - Never reconstruct a cwd from an escaped directory name — read it from
 *   records. All three JSONL harnesses use different, partly lossy escapings.
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  /** Stable configured store namespace. Omitted means `default`. */
  readonly instanceId?: InstanceId;
  detect(): Promise<StoreInfo | null>;
  /** Cheap enumeration — use native indexes / head windows, not full parses. */
  list(): AsyncIterable<SessionSummary>;
  read(ref: SessionRef): Promise<SifSession>;
  write?(session: SifSession, opts?: WriteOpts): Promise<NativeRef>;
  /** argv to natively resume the given session, e.g. ["claude","--resume",id]. */
  resumeCommand(ref: SessionRef): string[];
}
