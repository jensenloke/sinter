import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import type { HarnessAdapter, HarnessId, SessionSummary, SinterProvenance } from "@sinter/core";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

export interface LedgerRow {
  harness: HarnessId;
  nativeId: string;
  nativePath?: string;
  cwd?: string;
  title?: string;
  alias?: string;
  firstPrompt?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  model?: string;
  gitBranch?: string;
  tokensInput?: number;
  tokensOutput?: number;
  tokensReasoning?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  cost?: number;
  parentNativeId?: string;
  isSubagent: boolean;
  ghost: boolean;
  host?: string;
  scannedAt?: string;
}

/**
 * One "this native session belongs to that thread" link.
 *
 * A cache of what the adapters stamped into the target stores — see
 * `SinterProvenance` in @sinter/core. Losing it is never fatal: `sinter relink`
 * rebuilds the table by re-reading the stores.
 */
export interface LineageRow {
  harness: HarnessId;
  nativeId: string;
  threadId: string;
  /** 0-based position within the thread. 0 is the session nothing was ported from. */
  hop: number;
  parentHarness?: HarnessId;
  parentNativeId?: string;
  portedAt?: string;
  mode?: string;
}

export interface ListOpts {
  harness?: HarnessId | HarnessId[];
  /** Exact cwd match. */
  cwd?: string;
  /** ISO cutoff; rows with updated_at (or created_at) >= this are kept. */
  since?: string;
  limit?: number;
  /** Include rows whose backing session is gone (default true). */
  includeGhost?: boolean;
  /** Include subagent/sidechain rows (default true). */
  includeSubagents?: boolean;
}

export interface ScanHarnessStat {
  seen: number;
  inserted: number;
  updated: number;
  unchanged: number;
  ghosts: number;
}

export interface ScanResult {
  harnesses: Record<string, ScanHarnessStat>;
  errors: { harness: string; error: string }[];
}

export interface ResolveResult {
  row?: LedgerRow;
  candidates: LedgerRow[];
}

const SESSION_SELECT = `SELECT s.*, a.alias AS alias
FROM sessions AS s
LEFT JOIN session_aliases AS a
  ON a.harness = s.harness AND a.native_id = s.native_id`;

const COLUMNS = [
  "harness",
  "native_id",
  "native_path",
  "cwd",
  "title",
  "first_prompt",
  "created_at",
  "updated_at",
  "message_count",
  "model",
  "git_branch",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "cost",
  "parent_native_id",
  "is_subagent",
  "ghost",
  "host",
  "scanned_at",
] as const;

export function defaultLedgerPath(): string {
  return process.env.SINTER_LEDGER ?? join(process.env.SINTER_HOME ?? join(homedir(), ".sinter"), "ledger.db");
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function rowFromDb(r: Record<string, unknown>): LedgerRow {
  return {
    harness: r.harness as HarnessId,
    nativeId: String(r.native_id),
    nativePath: (r.native_path as string) ?? undefined,
    cwd: (r.cwd as string) ?? undefined,
    title: (r.title as string) ?? undefined,
    alias: (r.alias as string) ?? undefined,
    firstPrompt: (r.first_prompt as string) ?? undefined,
    createdAt: (r.created_at as string) ?? undefined,
    updatedAt: (r.updated_at as string) ?? undefined,
    messageCount: num(r.message_count),
    model: (r.model as string) ?? undefined,
    gitBranch: (r.git_branch as string) ?? undefined,
    tokensInput: num(r.tokens_input),
    tokensOutput: num(r.tokens_output),
    tokensReasoning: num(r.tokens_reasoning),
    tokensCacheRead: num(r.tokens_cache_read),
    tokensCacheWrite: num(r.tokens_cache_write),
    cost: num(r.cost),
    parentNativeId: (r.parent_native_id as string) ?? undefined,
    isSubagent: !!r.is_subagent,
    ghost: !!r.ghost,
    host: (r.host as string) ?? undefined,
    scannedAt: (r.scanned_at as string) ?? undefined,
  };
}

function lineageFromDb(r: Record<string, unknown>): LineageRow {
  return {
    harness: r.harness as HarnessId,
    nativeId: String(r.native_id),
    threadId: String(r.thread_id),
    hop: num(r.hop) ?? 0,
    parentHarness: (r.parent_harness as HarnessId) ?? undefined,
    parentNativeId: (r.parent_native_id as string) ?? undefined,
    portedAt: (r.ported_at as string) ?? undefined,
    mode: (r.mode as string) ?? undefined,
  };
}

/**
 * Upsert keyed on (harness, native_id).
 *
 * Identity columns are last-write-wins, but `ported_at` / `mode` are COALESCEd:
 * a record that does not know them (the ancestors named by a later port's
 * chain) must not erase what an earlier, better-informed write already stored.
 */
const LINEAGE_UPSERT_SQL = `
INSERT INTO lineage (
  harness, native_id, thread_id, hop, parent_harness, parent_native_id, ported_at, mode, recorded_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(harness, native_id) DO UPDATE SET
  thread_id        = excluded.thread_id,
  hop              = excluded.hop,
  parent_harness   = excluded.parent_harness,
  parent_native_id = excluded.parent_native_id,
  ported_at        = COALESCE(excluded.ported_at, lineage.ported_at),
  mode             = COALESCE(excluded.mode, lineage.mode),
  recorded_at      = excluded.recorded_at`;

/** SessionSummary → the positional values the upsert statement expects. */
function bindValues(s: SessionSummary, host: string, scannedAt: string): unknown[] {
  return [
    s.harness,
    s.nativeId,
    s.nativePath ?? null,
    s.cwd ?? null,
    s.title ?? null,
    s.firstPrompt ?? null,
    s.createdAt ?? null,
    s.updatedAt ?? null,
    s.messageCount ?? null,
    s.model ?? null,
    s.gitBranch ?? null,
    s.usage?.input ?? null,
    s.usage?.output ?? null,
    s.usage?.reasoning ?? null,
    s.usage?.cacheRead ?? null,
    s.usage?.cacheWrite ?? null,
    s.usage?.costUsd ?? null,
    s.parentNativeId ?? null,
    s.isSubagent ? 1 : 0,
    s.ghost ? 1 : 0,
    host,
    scannedAt,
  ];
}

export class Ledger {
  readonly db: Database;
  readonly path: string;
  private host: string;

  constructor(path: string = defaultLedgerPath()) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
    this.db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", [
      String(SCHEMA_VERSION),
    ]);
    this.host = process.env.SINTER_HOST ?? hostname();
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------ write path

  /** Insert-or-update one summary. Returns what happened. */
  upsert(s: SessionSummary): "inserted" | "updated" | "unchanged" {
    const scannedAt = new Date().toISOString();
    const existing = this.db
      .query("SELECT updated_at, message_count, ghost, title, first_prompt, is_subagent, parent_native_id FROM sessions WHERE harness = ? AND native_id = ?")
      .get(s.harness, s.nativeId) as Record<string, unknown> | null;

    if (
      existing &&
      (existing.updated_at ?? null) === (s.updatedAt ?? null) &&
      (existing.message_count ?? null) === (s.messageCount ?? null) &&
      !!existing.ghost === !!s.ghost &&
      (existing.title ?? null) === (s.title ?? null) &&
      (existing.first_prompt ?? null) === (s.firstPrompt ?? null) &&
      !!existing.is_subagent === !!s.isSubagent &&
      (existing.parent_native_id ?? null) === (s.parentNativeId ?? null)
    ) {
      this.db.run("UPDATE sessions SET scanned_at = ? WHERE harness = ? AND native_id = ?", [
        scannedAt,
        s.harness,
        s.nativeId,
      ]);
      return "unchanged";
    }

    const placeholders = COLUMNS.map(() => "?").join(", ");
    const updates = COLUMNS.filter((c) => c !== "harness" && c !== "native_id")
      .map((c) => `${c} = excluded.${c}`)
      .join(", ");
    this.db.run(
      `INSERT INTO sessions (${COLUMNS.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(harness, native_id) DO UPDATE SET ${updates}`,
      bindValues(s, this.host, scannedAt) as never[],
    );
    this.reindexFts(s.harness, s.nativeId, s.title, s.firstPrompt);
    return existing ? "updated" : "inserted";
  }

  private reindexFts(harness: string, nativeId: string, title?: string, firstPrompt?: string): void {
    const alias = this.db
      .query("SELECT alias FROM session_aliases WHERE harness = ? AND native_id = ?")
      .get(harness, nativeId) as { alias: string } | null;
    const indexedTitle = alias ? `${alias.alias}\n${title ?? ""}` : (title ?? "");

    this.db.run("DELETE FROM sessions_fts WHERE harness = ? AND native_id = ?", [harness, nativeId]);
    this.db.run(
      "INSERT INTO sessions_fts (harness, native_id, title, first_prompt) VALUES (?, ?, ?, ?)",
      [harness, nativeId, indexedTitle, firstPrompt ?? ""],
    );
  }

  /** Set, change, or clear a Sinter-local alias without modifying the source row. */
  setAlias(harness: HarnessId, nativeId: string, alias?: string): void {
    this.db.transaction(() => {
      if (alias === undefined) {
        this.db.run("DELETE FROM session_aliases WHERE harness = ? AND native_id = ?", [harness, nativeId]);
      } else {
        this.db.run(
          `INSERT INTO session_aliases (harness, native_id, alias) VALUES (?, ?, ?)
           ON CONFLICT(harness, native_id) DO UPDATE SET alias = excluded.alias`,
          [harness, nativeId, alias],
        );
      }

      const session = this.db
        .query("SELECT title, first_prompt FROM sessions WHERE harness = ? AND native_id = ?")
        .get(harness, nativeId) as { title: string | null; first_prompt: string | null } | null;
      if (session) {
        this.reindexFts(harness, nativeId, session.title ?? undefined, session.first_prompt ?? undefined);
      } else {
        this.db.run("DELETE FROM sessions_fts WHERE harness = ? AND native_id = ?", [harness, nativeId]);
      }
    })();
  }

  /**
   * Incremental refresh from every adapter's list().
   * An adapter that throws is recorded and skipped — the others still scan, and
   * its existing rows are left untouched (never ghosted on an error).
   */
  async scan(adapters: HarnessAdapter[]): Promise<ScanResult> {
    const result: ScanResult = { harnesses: {}, errors: [] };

    for (const adapter of adapters) {
      const stat: ScanHarnessStat = { seen: 0, inserted: 0, updated: 0, unchanged: 0, ghosts: 0 };
      result.harnesses[adapter.id] = stat;
      const seen: string[] = [];
      let failed = false;

      try {
        for await (const summary of adapter.list()) {
          if (!summary || summary.nativeId === undefined || summary.nativeId === null) continue;
          const s: SessionSummary = { ...summary, harness: summary.harness ?? adapter.id };
          seen.push(s.nativeId);
          stat.seen++;
          const what = this.upsert(s);
          stat[what]++;
          if (s.ghost) stat.ghosts++;
        }
      } catch (err) {
        failed = true;
        result.errors.push({ harness: adapter.id, error: err instanceof Error ? err.message : String(err) });
      }

      if (!failed) {
        // Rows the harness no longer lists are ghosts: the ledger keeps the
        // history after the harness GCs the transcript.
        stat.ghosts += this.markGhosts(adapter.id, seen);
      }
    }
    return result;
  }

  /** Mark every row of `harness` not in `seen` as a ghost. Returns rows flipped. */
  markGhosts(harness: HarnessId, seen: string[]): number {
    const keep = new Set(seen);
    const rows = this.db
      .query("SELECT native_id FROM sessions WHERE harness = ? AND ghost = 0")
      .all(harness) as { native_id: string }[];
    let flipped = 0;
    const stmt = this.db.prepare("UPDATE sessions SET ghost = 1 WHERE harness = ? AND native_id = ?");
    for (const r of rows) {
      if (!keep.has(r.native_id)) {
        stmt.run(harness, r.native_id);
        flipped++;
      }
    }
    return flipped;
  }

  // ------------------------------------------------------------- read path

  get(harness: HarnessId, nativeId: string): LedgerRow | undefined {
    const r = this.db
      .query(`${SESSION_SELECT} WHERE s.harness = ? AND s.native_id = ?`)
      .get(harness, nativeId) as Record<string, unknown> | null;
    return r ? rowFromDb(r) : undefined;
  }

  list(opts: ListOpts = {}): LedgerRow[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.harness) {
      const hs = Array.isArray(opts.harness) ? opts.harness : [opts.harness];
      if (hs.length) {
        where.push(`s.harness IN (${hs.map(() => "?").join(", ")})`);
        params.push(...hs);
      }
    }
    if (opts.cwd) {
      where.push("s.cwd = ?");
      params.push(opts.cwd);
    }
    if (opts.since) {
      where.push("COALESCE(s.updated_at, s.created_at, '') >= ?");
      params.push(opts.since);
    }
    if (opts.includeGhost === false) where.push("s.ghost = 0");
    if (opts.includeSubagents === false) where.push("s.is_subagent = 0");

    const sql =
      SESSION_SELECT +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY COALESCE(s.updated_at, s.created_at, '') DESC, s.native_id DESC" +
      (opts.limit && opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : "");

    return (this.db.query(sql).all(...(params as never[])) as Record<string, unknown>[]).map(rowFromDb);
  }

  /** FTS over title + first prompt. Falls back to a quoted phrase on syntax errors. */
  search(query: string, opts: ListOpts = {}): LedgerRow[] {
    const run = (q: string) =>
      this.db
        .query(
          "SELECT harness, native_id FROM sessions_fts WHERE sessions_fts MATCH ? ORDER BY rank LIMIT 5000",
        )
        .all(q) as { harness: string; native_id: string }[];

    let hits: { harness: string; native_id: string }[];
    try {
      hits = run(query);
    } catch {
      hits = run(`"${query.replace(/"/g, '""')}"`);
    }

    const out: LedgerRow[] = [];
    const harnesses = opts.harness
      ? new Set(Array.isArray(opts.harness) ? opts.harness : [opts.harness])
      : undefined;
    for (const h of hits) {
      const row = this.get(h.harness as HarnessId, h.native_id);
      if (!row) continue;
      if (harnesses && !harnesses.has(row.harness)) continue;
      if (opts.cwd && row.cwd !== opts.cwd) continue;
      if (opts.since && (row.updatedAt ?? row.createdAt ?? "") < opts.since) continue;
      if (opts.includeGhost === false && row.ghost) continue;
      if (opts.includeSubagents === false && row.isSubagent) continue;
      out.push(row);
      if (opts.limit && out.length >= opts.limit) break;
    }
    return out;
  }

  /**
   * Resolve an id prefix across the whole ledger (stricter than first-match:
   * ambiguity is an error the caller must report).
   *
   * Accepts `prefix`, `harness:prefix` and `harness/prefix`.
   */
  resolve(input: string): ResolveResult {
    let harness: string | undefined;
    let prefix = input.trim();
    const m = /^([a-z]+)[:/](.*)$/i.exec(prefix);
    if (m && ["claude", "codex", "devin", "opencode", "zcode", "omp", "pi"].includes(m[1]!.toLowerCase())) {
      harness = m[1]!.toLowerCase();
      prefix = m[2]!;
    }

    const params: unknown[] = [];
    let sql = `${SESSION_SELECT} WHERE lower(s.native_id) LIKE ?`;
    params.push(`${prefix.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`);
    sql += " ESCAPE '\\'";
    if (harness) {
      sql += " AND s.harness = ?";
      params.push(harness);
    }
    sql += " ORDER BY COALESCE(s.updated_at, s.created_at, '') DESC LIMIT 50";

    let candidates = (this.db.query(sql).all(...(params as never[])) as Record<string, unknown>[]).map(
      rowFromDb,
    );

    // Exact id wins over longer ids that merely start with it.
    const exact = candidates.filter((c) => c.nativeId.toLowerCase() === prefix.toLowerCase());
    if (exact.length === 1) return { row: exact[0], candidates: exact };
    if (exact.length > 1) candidates = exact;

    if (candidates.length === 1) return { row: candidates[0], candidates };

    // A parent plus only its own children (claude's "<uuid>/agent-…" sidechains)
    // means the parent — subagents stay addressable by their full id.
    if (candidates.length > 1) {
      const root = candidates.find((r) =>
        candidates.every(
          (c) => c === r || (c.harness === r.harness && c.nativeId.startsWith(`${r.nativeId}/`)),
        ),
      );
      if (root) return { row: root, candidates };
    }
    return { candidates };
  }

  counts(): { harness: string; total: number; ghosts: number }[] {
    return this.db
      .query(
        "SELECT harness, count(*) AS total, sum(ghost) AS ghosts FROM sessions GROUP BY harness ORDER BY harness",
      )
      .all() as { harness: string; total: number; ghosts: number }[];
  }

  countFor(harness: HarnessId): number {
    const r = this.db
      .query("SELECT count(*) AS n FROM sessions WHERE harness = ?")
      .get(harness) as { n: number } | null;
    return r?.n ?? 0;
  }

  // --------------------------------------------------------------- lineage

  /** Idempotent upsert of one link, keyed on (harness, native_id). */
  recordLineage(row: LineageRow): void {
    this.db.run(LINEAGE_UPSERT_SQL, [
      row.harness,
      row.nativeId,
      row.threadId,
      Number.isFinite(row.hop) ? Math.max(0, Math.floor(row.hop)) : 0,
      row.parentHarness ?? null,
      row.parentNativeId ?? null,
      row.portedAt ?? null,
      row.mode ?? null,
      new Date().toISOString(),
    ] as never[]);
  }

  /**
   * Cache a whole chain from one provenance record.
   *
   * `prov.chain` is the ordered ancestry INCLUDING the session just written, so
   * one record is enough to rebuild the thread even when the intermediate
   * stores have been GC'd. Every element gets a row pointing at its
   * predecessor, all sharing `prov.threadId`.
   *
   * `portedAt` / `mode` describe THIS port, so they are only stamped on the
   * session at `prov.hop`; the ancestors keep whatever their own ports recorded.
   * Re-porting back into a harness already in the chain is a normal later hop,
   * not a cycle — it gets its own row under its own new native id.
   */
  recordProvenance(prov: SinterProvenance): void {
    if (!prov?.threadId || !Array.isArray(prov.chain) || !prov.chain.length) return;
    const chain = prov.chain;
    const self = Math.min(Math.max(prov.hop ?? chain.length - 1, 0), chain.length - 1);

    this.db.transaction(() => {
      for (let i = 0; i < chain.length; i++) {
        const hop = chain[i]!;
        const parent = i > 0 ? chain[i - 1] : undefined;
        this.recordLineage({
          harness: hop.harness,
          nativeId: hop.nativeId,
          threadId: prov.threadId,
          hop: i,
          parentHarness: parent?.harness,
          parentNativeId: parent?.nativeId,
          portedAt: i === self ? prov.portedAt || undefined : undefined,
          mode: i === self ? prov.mode : undefined,
        });
      }
    })();
  }

  /** Every lineage link, for grouping sessions into threads. */
  lineage(): LineageRow[] {
    return (
      this.db
        .query("SELECT * FROM lineage ORDER BY thread_id, hop, harness, native_id")
        .all() as Record<string, unknown>[]
    ).map(lineageFromDb);
  }

  /** The links belonging to one thread, ordered by hop. */
  lineageFor(threadId: string): LineageRow[] {
    return (
      this.db
        .query("SELECT * FROM lineage WHERE thread_id = ? ORDER BY hop, harness, native_id")
        .all(threadId) as Record<string, unknown>[]
    ).map(lineageFromDb);
  }

  /** The thread a native session belongs to, if sinter has ever seen it ported. */
  threadIdOf(harness: HarnessId, nativeId: string): string | undefined {
    const r = this.db
      .query("SELECT thread_id FROM lineage WHERE harness = ? AND native_id = ?")
      .get(harness, nativeId) as { thread_id: string } | null;
    return r?.thread_id ?? undefined;
  }

  /** How many lineage links are cached, for `sinter doctor`. */
  lineageCount(): number {
    const r = this.db.query("SELECT count(*) AS n FROM lineage").get() as { n: number } | null;
    return r?.n ?? 0;
  }
}

export function openLedger(path?: string): Ledger {
  return new Ledger(path);
}
