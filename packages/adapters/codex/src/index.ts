/**
 * Codex CLI adapter.
 *
 * Store layout (verified against a 1000+ rollout store spanning 2025-09 → 2026-08):
 *   $CODEX_HOME (default ~/.codex, often a symlink to ~/.codex-main)
 *     sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl   <- transcripts
 *     archived_sessions/rollout-<ISO-ts>-<uuid>.jsonl     <- archived transcripts
 *     state_<N>.sqlite                                    <- thread index (highest N wins)
 *
 * Every rollout line is {timestamp, type, payload}. The stream is DUAL-TRACK:
 *   - `response_item` records are the canonical model-API stream (the truth)
 *   - `event_msg` records are a redundant UI stream
 * We index the canonical texts/call_ids first, then drop the event_msg records
 * that merely echo them, keeping only the event_msg types that add information
 * (MCP calls, web search, rollbacks, goals, aborts, ...).
 */

import { existsSync, readdirSync, statSync, mkdtempSync, copyFileSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  CARRY_INLINE_MAX,
  PRESERVE_KEY,
  SIF_VERSION,
  buildProvenance,
  encodeCarry,
  inertToolText,
  loadCarry,
  mintSifId,
  readJsonl,
  readProvenance,
  storeCarry,
  toIso,
  validateSession,
  type AssistantContentPart,
  type AssistantEntry,
  type HarnessAdapter,
  type HarnessId,
  type Hop,
  type ImagePart,
  type NativeRef,
  type SessionRef,
  type SessionSummary,
  type SifEntry,
  type SifGit,
  type SifSession,
  type SinterProvenance,
  type StoreInfo,
  type TextPart,
  type ThinkingPart,
  type ToolCallPart,
  type ToolResultEntry,
  type Usage,
  type UserContentPart,
  type WriteOpts,
} from "@sinter/core";

// ---------------------------------------------------------------- types

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: any;
}

interface ThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  cwd: string;
  title: string;
  name: string | null;
  first_user_message: string;
  model: string | null;
  model_provider: string;
  tokens_used: number;
  archived: number;
  git_sha: string | null;
  git_branch: string | null;
  git_origin_url: string | null;
  cli_version: string;
  thread_source: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
  agent_path: string | null;
  is_pinned: number;
}

export interface CodexAdapterOptions {
  /** Override the Codex home dir (default: $CODEX_HOME or ~/.codex). */
  home?: string;
  /**
   * Resolve child (subagent) rollouts into `subsessions` when a parent is read.
   * Number = max children to inline; false/0 = sessionRef-only. Default 6.
   */
  resolveSubsessions?: boolean | number;
}

/** Stamped into every provenance record this adapter writes. */
export const SINTER_VERSION = "0.1.0";

export interface CodexReadOpts {
  /**
   * Recover the original carried entries when this codex session was imported
   * by sinter. Default read() stays native so show/relink report what codex
   * actually stores.
   */
  carry?: boolean;
}

const PROVENANCE_META_KEY = "sinter";

// ---------------------------------------------------------------- helpers

function defaultHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** rollout-2026-08-13T07-54-56-<uuid>.jsonl -> {id, createdAt} */
export function parseRolloutFilename(file: string): { id?: string; createdAt?: string } {
  const m = basename(file).match(
    /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-fA-F-]{36})\.jsonl$/,
  );
  if (!m) return {};
  const [, y, mo, d, h, mi, s, id] = m;
  // The filename stamp is local time in some vintages and UTC in others; it is
  // only ever a fallback, so we treat it as naive-local and let real record
  // timestamps win whenever they exist.
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
  return { id, createdAt: isNaN(dt.getTime()) ? undefined : dt.toISOString() };
}

/** Highest-numbered state_<N>.sqlite in the Codex home, if any. */
export function findStateDb(home: string): string | undefined {
  let best: { n: number; path: string } | undefined;
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const m = name.match(/^state_(\d+)\.sqlite$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (!best || n > best.n) best = { n, path: join(home, name) };
  }
  return best?.path;
}

/**
 * Open the thread index read-only. Codex is usually running, so a direct
 * read-only open can fail (WAL recovery needs write access); we then copy
 * db+wal+shm to a temp dir and open the copy. Never `immutable=1` — that
 * silently ignores the WAL and reads stale data.
 */
function openStateDb(dbPath: string): { db: Database; copied?: string } | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    db.query("select count(*) as n from threads").get();
    return { db };
  } catch {
    /* fall through to copy */
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), "sinter-codex-"));
    const target = join(dir, basename(dbPath));
    copyFileSync(dbPath, target);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, target + suffix);
    }
    const db = new Database(target, { readonly: true });
    db.query("select count(*) as n from threads").get();
    return { db, copied: dir };
  } catch {
    return null;
  }
}

function txt(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function parseDataUrl(url: string): ImagePart | undefined {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m) return undefined;
  return { type: "image", mimeType: m[1], data: m[2] };
}

function usageFrom(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const pick = (v: unknown) => (typeof v === "number" ? v : undefined);
  const out: Usage = {
    input: pick(u.input_tokens),
    output: pick(u.output_tokens),
    reasoning: pick(u.reasoning_output_tokens),
    cacheRead: pick(u.cached_input_tokens),
    cacheWrite: pick(u.cache_write_input_tokens),
  };
  for (const k of Object.keys(out) as (keyof Usage)[]) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

/** Unwrap the Rust Result envelope MCP results are serialized with. */
export function unwrapResult(result: any): { value: any; isError?: boolean } {
  if (result && typeof result === "object") {
    if ("Ok" in result) {
      const v = (result as any).Ok;
      const isError = v && typeof v === "object" && v.isError === true ? true : undefined;
      return { value: v, isError };
    }
    if ("Err" in result) return { value: (result as any).Err, isError: true };
  }
  return { value: result };
}

/** MCP content blocks -> plain text. */
function mcpContentText(value: any): string {
  if (value && typeof value === "object" && Array.isArray(value.content)) {
    const parts = value.content
      .map((c: any) => (c && c.type === "text" ? String(c.text ?? "") : txt(c)))
      .filter((s: string) => s.length > 0);
    if (parts.length) return parts.join("\n");
  }
  return txt(value);
}

function normText(s: string): string {
  return s.trim();
}

// ---------------------------------------------------------------- builder

class SessionBuilder {
  entries: SifEntry[] = [];
  private lastId: string | null = null;
  private prevMs = 0;
  private seq = 0;

  /** Append as a child of the current chain head. */
  push<T extends SifEntry>(e: T): T {
    e.parentId = this.lastId;
    this.entries.push(e);
    this.lastId = e.id;
    return e;
  }

  /** Move the chain head (rollback re-parenting). */
  setHead(id: string | null) {
    this.lastId = id;
  }

  get head(): string | null {
    return this.lastId;
  }

  nextId(line: number): string {
    return `c${line}.${this.seq++}`;
  }

  /** Monotonic timestamps: never go backwards, never fabricate one. */
  ts(raw: unknown): string | undefined {
    const iso = toIso(typeof raw === "string" || typeof raw === "number" ? raw : undefined);
    if (!iso) return undefined;
    let ms = new Date(iso).getTime();
    if (ms <= this.prevMs) ms = this.prevMs + 1;
    this.prevMs = ms;
    return new Date(ms).toISOString();
  }
}

// ---------------------------------------------------------------- write()

let writeCounter = 0;
function mintNative(prefix: string): string {
  writeCounter++;
  return `${prefix}_${mintSifId().replace(/-/g, "")}${writeCounter.toString(16)}`;
}

function epochMs(iso: string | undefined, fallback = Date.now()): number {
  if (!iso) return fallback;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
}

function rolloutPath(home: string, nativeId: string, createdMs: number): string {
  const d = new Date(createdMs);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const stamp = d.toISOString().replace(/\.\d{3}Z$/, "").replace(/:/g, "-");
  return join(home, "sessions", yyyy, mm, dd, `rollout-${stamp}-${nativeId}.jsonl`);
}

function line(timestamp: string, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp, type, payload });
}

function firstText(session: SifSession): string {
  for (const e of session.entries) {
    if (e.kind !== "user" || e.synthetic) continue;
    const text = e.content.find((p): p is TextPart => p.type === "text")?.text.trim();
    if (text) return text;
  }
  return session.title?.text ?? "";
}

function modelOf(session: SifSession): { provider: string; model: string } {
  for (const e of session.entries) {
    if (e.kind === "assistant" && e.model?.id) return { provider: e.model.provider ?? "openai", model: e.model.id };
    if (e.kind === "modelChange") return { provider: e.provider ?? "openai", model: e.model };
  }
  return { provider: "openai", model: "unknown" };
}

function resultText(result: ToolResultEntry | undefined): string | undefined {
  if (!result) return undefined;
  const parts = result.content.filter((p): p is TextPart => p.type === "text").map((p) => p.text);
  return parts.length ? parts.join("\n") : undefined;
}

function carrySource(session: SifSession): SifSession {
  const prov = readProvenance(session.preserve?.[PRESERVE_KEY]);
  if (!prov || (!prov.carry && !prov.carryRef)) return session;
  const { carry: _carry, carryRef: _carryRef, carryBytes: _carryBytes, ...lean } = prov;
  return { ...session, preserve: { ...session.preserve, [PRESERVE_KEY]: lean } };
}

async function captureCarry(
  session: SifSession,
  target: Hop,
  opts: WriteOpts | undefined,
): Promise<Pick<SinterProvenance, "carry" | "carryRef" | "carryBytes">> {
  const payload = carrySource(session);
  if (!opts?.dryRun) return storeCarry(payload, target);
  const encoded = encodeCarry(payload);
  if (!encoded || encoded.length > CARRY_INLINE_MAX) return {};
  return { carry: encoded, carryBytes: JSON.stringify(payload).length };
}

async function resolveProvenance(
  session: SifSession,
  nativeId: string,
  opts?: WriteOpts,
): Promise<SinterProvenance> {
  const target: Hop = { harness: "codex", nativeId };
  const preset = readProvenance(session.preserve?.[PRESERVE_KEY]);
  const tail = preset?.chain[preset.chain.length - 1];
  const presetTargetsThisWrite = !!preset && tail?.harness === "codex" && tail.nativeId !== session.origin.nativeId;
  const record = presetTargetsThisWrite
    ? preset!
    : buildProvenance({
        source: session,
        target,
        sinterVersion: SINTER_VERSION,
        portedAt: new Date().toISOString(),
        inertTools: !opts?.liveTools,
      });
  if (record.carry || record.carryRef) return record;
  return { ...record, ...(await captureCarry(session, target, opts)) };
}

interface CodexRolloutBuild {
  body: string;
  firstPrompt: string;
  title: string;
  createdMs: number;
  updatedMs: number;
  model: string;
  provider: string;
}

function buildCodexRollout(
  session: SifSession,
  opts: WriteOpts | undefined,
  targetCwd: string,
  nativeId: string,
  provenance: SinterProvenance,
): CodexRolloutBuild {
  const liveTools = opts?.liveTools === true;
  const byResult = new Map<string, ToolResultEntry>();
  for (const e of session.entries) if (e.kind === "toolResult") byResult.set(e.callId, e);

  const createdMs = epochMs(session.createdAt);
  let clock = createdMs;
  const nextTs = (e?: SifEntry): string => {
    const own = epochMs(e?.ts, clock);
    clock = Math.max(clock + 1, own + 1);
    return new Date(own).toISOString();
  };
  const { provider, model } = modelOf(session);
  const firstPrompt = firstText(session);
  const title = (session.title?.text ?? firstPrompt.slice(0, 80)) || `Imported session (${session.origin.harness})`;

  const out: string[] = [];
  const metaTs = new Date(createdMs).toISOString();
  out.push(
    line(metaTs, "session_meta", {
      session_id: nativeId,
      id: nativeId,
      timestamp: metaTs,
      cwd: targetCwd,
      originator: "sinter",
      cli_version: SINTER_VERSION,
      source: "sinter",
      thread_source: "user",
      model_provider: provider,
      git: session.git
        ? { commit_hash: session.git.sha ?? null, branch: session.git.branch ?? null, repository_url: session.git.remote ?? null }
        : undefined,
      [PROVENANCE_META_KEY]: provenance,
    }),
  );
  out.push(line(metaTs, "turn_context", { cwd: targetCwd, workspace_roots: [targetCwd], model }));

  const pushMessage = (ts: string, role: "user" | "assistant" | "developer", text: string, id = mintNative("msg")) => {
    out.push(line(ts, "response_item", { type: "message", id, role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] }));
  };

  for (const entry of session.entries) {
    if (entry.kind === "toolResult") {
      if (liveTools && !byResult.has(entry.callId)) {
        out.push(line(nextTs(entry), "response_item", { type: "function_call_output", call_id: entry.callId, output: resultText(entry) ?? "" }));
      }
      continue;
    }
    if (entry.kind === "user") {
      const ts = nextTs(entry);
      const role = entry.synthetic ? "developer" : "user";
      const content = entry.content.map((p) =>
        p.type === "text"
          ? { type: "input_text", text: p.text }
          : { type: "input_image", image_url: `data:${p.mimeType};base64,${p.data}` },
      );
      out.push(line(ts, "response_item", { type: "message", id: mintNative("msg"), role, content }));
      continue;
    }
    if (entry.kind === "assistant") {
      const ts = nextTs(entry);
      const textParts: string[] = [];
      for (const part of entry.content) {
        if (part.type === "text") textParts.push(part.text);
        else if (part.type === "thinking")
          out.push(line(ts, "response_item", { type: "reasoning", id: mintNative("rs"), summary: [{ text: part.thinking }] }));
        else if (part.type === "image") textParts.push(`[image: ${part.mimeType}, ${part.data.length} base64 bytes]`);
        else if (part.type === "toolCall") {
          const result = byResult.get(part.callId);
          if (liveTools) {
            const args = typeof part.args === "string" ? part.args : JSON.stringify(part.args);
            out.push(line(ts, "response_item", { type: "function_call", id: mintNative("fc"), call_id: part.callId, name: part.name, arguments: args }));
            if (result) out.push(line(ts, "response_item", { type: "function_call_output", call_id: part.callId, output: resultText(result) ?? "" }));
          } else {
            textParts.push(inertToolText(part, resultText(result)).text);
          }
        }
      }
      if (textParts.length) pushMessage(ts, "assistant", textParts.join("\n\n"));
      continue;
    }
    if (entry.kind === "modelChange") {
      out.push(line(nextTs(entry), "turn_context", { cwd: targetCwd, workspace_roots: [targetCwd], model: entry.model }));
      continue;
    }
    if (entry.kind === "compaction") {
      out.push(line(nextTs(entry), "compacted", { message: entry.summary, replacement_history: entry.replacedHistory }));
      continue;
    }
    if (entry.kind === "subsession") {
      pushMessage(
        nextTs(entry),
        "user",
        `[subsession${entry.agentName ? " " + entry.agentName : ""} -> ${entry.sessionRef}]${entry.resultText ? ": " + entry.resultText : ""}`,
      );
      continue;
    }
    if (entry.kind === "note") {
      pushMessage(nextTs(entry), "user", `[${entry.noteType}]${entry.text ? " " + entry.text : ""}`);
    }
  }

  const updatedMs = Math.max(clock, createdMs);
  return { body: out.join("\n") + "\n", firstPrompt, title, createdMs, updatedMs, model, provider };
}

function insertThreadRow(
  dbPath: string,
  nativeId: string,
  path: string,
  targetCwd: string,
  built: CodexRolloutBuild,
): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(threads)").all().map((r) => r.name));
    const values: Record<string, string | number | null> = {
      id: nativeId,
      rollout_path: path,
      created_at: Math.floor(built.createdMs / 1000),
      updated_at: Math.floor(built.updatedMs / 1000),
      created_at_ms: built.createdMs,
      updated_at_ms: built.updatedMs,
      recency_at: Math.floor(built.updatedMs / 1000),
      recency_at_ms: built.updatedMs,
      source: "sinter",
      model_provider: built.provider,
      cwd: targetCwd,
      title: built.title,
      name: built.title,
      first_user_message: built.firstPrompt,
      preview: built.firstPrompt || built.title,
      sandbox_policy: "workspace-write",
      approval_mode: "on-request",
      tokens_used: 0,
      has_user_event: built.firstPrompt ? 1 : 0,
      archived: 0,
      cli_version: SINTER_VERSION,
      thread_source: "user",
      model: built.model,
      history_mode: "legacy",
      is_pinned: 0,
    };
    const chosen = Object.keys(values).filter((c) => cols.has(c));
    const sql = `INSERT INTO threads (${chosen.join(", ")}) VALUES (${chosen.map(() => "?").join(", ")})`;
    db.query(sql).run(...chosen.map((c) => values[c] ?? null));
  } finally {
    db.close();
  }
}

async function writeSession(session: SifSession, opts: WriteOpts | undefined, home: string): Promise<NativeRef> {
  validateSession(session);
  const targetCwd = opts?.cwd ?? session.cwd;
  const nativeId = mintSifId();
  const provenance = await resolveProvenance(session, nativeId, opts);
  const built = buildCodexRollout(session, opts, targetCwd, nativeId, provenance);
  const path = rolloutPath(home, nativeId, built.createdMs);

  if (opts?.dryRun) return { harness: "codex", nativeId, nativePath: path, created: [], provenance };

  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, built.body);
  const created = [path];
  const dbPath = findStateDb(home);
  if (dbPath) {
    insertThreadRow(dbPath, nativeId, path, targetCwd, built);
    created.push(dbPath);
  }
  return { harness: "codex", nativeId, nativePath: path, created, provenance };
}

async function applyCarry(session: SifSession): Promise<SifSession> {
  const prov = readProvenance(session.preserve?.[PRESERVE_KEY]);
  if (!prov) return session;
  const carried = await loadCarry(prov);
  if (!carried || !Array.isArray(carried.entries) || carried.entries.length === 0) return session;
  return {
    ...session,
    entries: carried.entries,
    ...(carried.subsessions?.length ? { subsessions: carried.subsessions } : {}),
    preserve: {
      ...session.preserve,
      sinterCarry: {
        recoveredFrom: carried.origin,
        entries: carried.entries.length,
        via: prov.carryRef ? "sidecar" : "inline",
      },
    },
  };
}

// ---------------------------------------------------------------- adapter

export class CodexAdapter implements HarnessAdapter {
  readonly id: HarnessId = "codex";
  private readonly home: string;
  private readonly resolveSubsessions: number;

  constructor(opts: CodexAdapterOptions = {}) {
    this.home = opts.home ?? defaultHome();
    const rs = opts.resolveSubsessions ?? 6;
    this.resolveSubsessions = rs === true ? 6 : rs === false ? 0 : Number(rs);
  }

  get sessionsDir(): string {
    return join(this.home, "sessions");
  }
  get archivedDir(): string {
    return join(this.home, "archived_sessions");
  }

  // ------------------------------------------------------------ detect

  async detect(): Promise<StoreInfo | null> {
    const hasSessions = existsSync(this.sessionsDir);
    const dbPath = findStateDb(this.home);
    if (!hasSessions && !dbPath) return null;

    const paths = [hasSessions ? this.sessionsDir : undefined, dbPath, existsSync(this.archivedDir) ? this.archivedDir : undefined].filter(
      Boolean,
    ) as string[];

    let version: string | undefined;
    const notes: string[] = [];
    if (dbPath) {
      const opened = openStateDb(dbPath);
      if (opened) {
        try {
          const row = opened.db
            .query<{ cli_version: string; n: number }, []>(
              "select cli_version, (select count(*) from threads) as n from threads order by updated_at desc limit 1",
            )
            .get();
          if (row?.cli_version) version = row.cli_version;
          if (row?.n !== undefined) notes.push(`${row.n} threads indexed`);
        } catch {
          /* schema drift — detection stays best-effort */
        } finally {
          opened.db.close();
        }
      } else {
        notes.push("thread index present but unreadable; falling back to filename scan");
      }
    } else {
      notes.push("no state_<N>.sqlite found; list() falls back to a filename scan");
    }

    return {
      harness: "codex",
      paths,
      version,
      notes: notes.length ? notes.join("; ") : undefined,
    };
  }

  // ------------------------------------------------------------ list

  async *list(): AsyncIterable<SessionSummary> {
    const dbPath = findStateDb(this.home);
    const opened = dbPath ? openStateDb(dbPath) : null;
    if (!opened) {
      yield* this.listFromFilenames();
      return;
    }
    try {
      const parents = new Map<string, string>();
      try {
        for (const e of opened.db
          .query<{ parent_thread_id: string; child_thread_id: string }, []>(
            "select parent_thread_id, child_thread_id from thread_spawn_edges",
          )
          .all()) {
          parents.set(e.child_thread_id, e.parent_thread_id);
        }
      } catch {
        /* table missing in older stores */
      }

      const rows = opened.db
        .query<ThreadRow, []>(
          `select id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, cwd,
                  title, name, first_user_message, model, model_provider, tokens_used, archived,
                  git_sha, git_branch, git_origin_url, cli_version, thread_source,
                  agent_nickname, agent_role, agent_path, is_pinned
             from threads order by updated_at desc, id desc`,
        )
        .all();

      for (const r of rows) {
        const path = this.resolveRolloutPath(r.rollout_path);
        const title = (r.name && r.name.trim()) || (r.title && r.title.trim()) || undefined;
        const summary: SessionSummary = {
          harness: "codex",
          nativeId: r.id,
          nativePath: path ?? r.rollout_path,
          cwd: r.cwd || undefined,
          title: r.archived ? `${title ?? "(untitled)"} [archived]` : title,
          firstPrompt: r.first_user_message?.trim() || undefined,
          createdAt: toIso(r.created_at_ms ?? r.created_at),
          updatedAt: toIso(r.updated_at_ms ?? r.updated_at),
          model: r.model ?? undefined,
          gitBranch: r.git_branch ?? undefined,
          parentNativeId: parents.get(r.id),
          isSubagent: r.thread_source === "subagent" || parents.has(r.id) || undefined,
        };
        if (!path) summary.ghost = true;
        yield summary;
      }
    } finally {
      opened.db.close();
    }
  }

  /** Fallback when no readable index exists: filenames only, no full parses. */
  private async *listFromFilenames(): AsyncIterable<SessionSummary> {
    const files = [...walkJsonl(this.sessionsDir), ...walkJsonl(this.archivedDir)];
    files.sort();
    for (const f of files) {
      const { id, createdAt } = parseRolloutFilename(f);
      if (!id) continue;
      let updatedAt: string | undefined;
      try {
        updatedAt = new Date(statSync(f).mtimeMs).toISOString();
      } catch {
        /* ignore */
      }
      yield {
        harness: "codex",
        nativeId: id,
        nativePath: f,
        createdAt,
        updatedAt,
        title: f.includes("archived_sessions") ? "(untitled) [archived]" : undefined,
      };
    }
  }

  /**
   * threads.rollout_path is absolute but may point through the ~/.codex ->
   * ~/.codex-main symlink, or at a file that has since been archived/GC'd.
   */
  private resolveRolloutPath(p: string | undefined | null): string | undefined {
    if (!p) return undefined;
    if (existsSync(p)) return p;
    const base = basename(p);
    for (const cand of [
      join(this.archivedDir, base),
      p.replace("/.codex-main/", "/.codex/"),
      p.replace("/.codex/", "/.codex-main/"),
    ]) {
      if (existsSync(cand)) return cand;
    }
    return undefined;
  }

  /** Locate a rollout file by thread id without a full store parse. */
  private findRolloutById(id: string): string | undefined {
    const dbPath = findStateDb(this.home);
    if (dbPath) {
      const opened = openStateDb(dbPath);
      if (opened) {
        try {
          const row = opened.db
            .query<{ rollout_path: string }, [string]>("select rollout_path from threads where id = ?")
            .get(id);
          const resolved = this.resolveRolloutPath(row?.rollout_path);
          if (resolved) return resolved;
        } catch {
          /* fall through */
        } finally {
          opened.db.close();
        }
      }
    }
    const suffix = `-${id}.jsonl`;
    for (const f of [...walkJsonl(this.sessionsDir), ...walkJsonl(this.archivedDir)]) {
      if (f.endsWith(suffix)) return f;
    }
    return undefined;
  }

  // ------------------------------------------------------------ read

  async read(ref: SessionRef, opts?: CodexReadOpts): Promise<SifSession> {
    const path =
      (ref.nativePath && existsSync(ref.nativePath) ? ref.nativePath : undefined) ??
      this.resolveRolloutPath(ref.nativePath) ??
      this.findRolloutById(ref.nativeId);
    if (!path) throw new Error(`codex: no rollout file for session ${ref.nativeId}`);

    const session = await this.readFile(path, ref.nativeId);

    // Attach subagent children (depth 1) when cheap.
    if (this.resolveSubsessions > 0) {
      const children = this.childThreadIds(session.origin.nativeId);
      const pending: string[] = [];
      for (const childId of children) {
        if ((session.subsessions?.length ?? 0) >= this.resolveSubsessions) {
          pending.push(childId);
          continue;
        }
        const childPath = this.findRolloutById(childId);
        if (!childPath) {
          pending.push(childId);
          continue;
        }
        try {
          if (statSync(childPath).size > 8_000_000) {
            pending.push(childId);
            continue;
          }
          const child = await this.readFile(childPath, childId);
          (session.subsessions ??= []).push(child);
        } catch {
          pending.push(childId);
        }
      }
      // Every child gets a SubsessionEntry; unresolved ones are sessionRef-only.
      const alreadyLinked = new Set(
        session.entries.filter((e) => e.kind === "subsession").map((e) => (e as any).sessionRef),
      );
      for (const childId of children) {
        if (alreadyLinked.has(childId)) continue;
        const resolved = session.subsessions?.some((s) => s.origin.nativeId === childId);
        session.entries.push({
          kind: "subsession",
          id: `sub.${childId}`,
          parentId: session.entries[session.entries.length - 1]?.id ?? null,
          sessionRef: childId,
          origin: { nativeType: "thread_spawn_edge", nativeId: childId },
          raw: { child_thread_id: childId, resolved: !!resolved },
        });
      }
      if (pending.length) {
        (session.preserve ??= {}).unresolvedSubsessions = pending;
      }
    }

    return opts?.carry ? applyCarry(session) : session;
  }

  private childThreadIds(threadId: string): string[] {
    const dbPath = findStateDb(this.home);
    if (!dbPath) return [];
    const opened = openStateDb(dbPath);
    if (!opened) return [];
    try {
      return opened.db
        .query<{ child_thread_id: string }, [string]>(
          "select child_thread_id from thread_spawn_edges where parent_thread_id = ?",
        )
        .all(threadId)
        .map((r) => r.child_thread_id);
    } catch {
      return [];
    } finally {
      opened.db.close();
    }
  }

  /** Parse one rollout file into a SIF session. Offline, no index needed. */
  async readFile(path: string, fallbackId?: string): Promise<SifSession> {
    const lines: { value: RolloutLine; line: number }[] = [];
    for await (const l of readJsonl(path)) lines.push(l as { value: RolloutLine; line: number });

    // ---- pass 1: index the canonical (response_item) stream ------------
    const canonicalText = new Set<string>();
    const canonicalCallIds = new Set<string>();
    let hasCompactedRecord = false;
    for (const { value: v } of lines) {
      const p = v.payload;
      if (v.type === "compacted") hasCompactedRecord = true;
      if (v.type !== "response_item" || !p) continue;
      switch (p.type) {
        case "message":
          for (const c of p.content ?? []) {
            const t = c?.text;
            if (typeof t === "string" && t.trim()) canonicalText.add(normText(t));
          }
          break;
        case "reasoning":
          for (const s of p.summary ?? []) if (s?.text) canonicalText.add(normText(String(s.text)));
          for (const c of p.content ?? []) if (c?.text) canonicalText.add(normText(String(c.text)));
          break;
        case "agent_message":
          for (const c of p.content ?? [])
            if (typeof c?.text === "string" && c.text.trim()) canonicalText.add(normText(c.text));
          break;
        default:
          break;
      }
      if (typeof p.call_id === "string") canonicalCallIds.add(p.call_id);
      if (typeof p.id === "string" && /^(ws|ig|fs)_/.test(p.id)) canonicalCallIds.add(p.id);
    }

    // ---- pass 2: build entries ----------------------------------------
    const b = new SessionBuilder();
    const callNames = new Map<string, string>();
    const unknown: Record<string, number> = {};
    const sessionMetas: any[] = [];
    const encryptedAgentMessages: Record<string, unknown[]> = {};

    let rolloutId = fallbackId;
    let sessionId: string | undefined;
    let parentThreadId: string | undefined;
    let forkedFromId: string | undefined;
    let cwd: string | undefined;
    let git: SifGit | undefined;
    let originator: string | undefined;
    let cliVersion: string | undefined;
    let threadSource: string | undefined;
    let agentPath: string | undefined;
    let agentNickname: string | undefined;
    let agentRole: string | undefined;
    let baseInstructions: unknown;
    let contextWindow: number | undefined;
    let currentModel: string | undefined;
    let modelProvider = "openai";
    let title: string | undefined;
    let titleSource: "auto" | "user" | "derived" = "auto";
    let totalUsage: Usage | undefined;
    const additionalDirs = new Set<string>();
    let lastAssistant: AssistantEntry | undefined;
    let provenance: SinterProvenance | undefined;

    const note = (line: number, ts: unknown, noteType: string, text: string | undefined, raw: unknown) =>
      b.push({
        kind: "note",
        id: b.nextId(line),
        parentId: null,
        ts: b.ts(ts),
        noteType,
        text,
        origin: { nativeType: noteType },
        raw,
      });

    const toolCall = (
      line: number,
      ts: unknown,
      nativeType: string,
      part: ToolCallPart,
      raw: unknown,
    ): AssistantEntry => {
      callNames.set(part.callId, part.name);
      const e: AssistantEntry = {
        kind: "assistant",
        id: b.nextId(line),
        parentId: null,
        ts: b.ts(ts),
        content: [part],
        model: currentModel ? { provider: modelProvider, id: currentModel } : undefined,
        origin: { nativeType, nativeId: part.callId },
        raw,
      };
      b.push(e);
      lastAssistant = e;
      return e;
    };

    const toolResult = (
      line: number,
      ts: unknown,
      nativeType: string,
      callId: string,
      text: string,
      raw: unknown,
      isError?: boolean,
    ) =>
      b.push({
        kind: "toolResult",
        id: b.nextId(line),
        parentId: null,
        ts: b.ts(ts),
        callId,
        toolName: callNames.get(callId) ?? "unknown",
        content: text ? [{ type: "text", text } as TextPart] : [],
        isError,
        origin: { nativeType, nativeId: callId },
        raw,
      });

    for (const { value: v, line } of lines) {
      const p = v.payload ?? {};
      const ts = v.timestamp;

      switch (v.type) {
        // ---------------------------------------------------------- meta
        case "session_meta": {
          sessionMetas.push(p);
          if (sessionMetas.length === 1) {
            rolloutId = p.id ?? rolloutId;
            sessionId = p.session_id ?? p.id ?? sessionId;
            parentThreadId = p.parent_thread_id ?? parentThreadId;
            forkedFromId = p.forked_from_id ?? forkedFromId;
            cwd ??= p.cwd;
            originator = p.originator ?? originator;
            cliVersion = p.cli_version ?? cliVersion;
            threadSource = p.thread_source ?? threadSource;
            agentPath = p.agent_path ?? p.source?.subagent?.thread_spawn?.agent_path ?? agentPath;
            agentNickname = p.agent_nickname ?? agentNickname;
            agentRole = p.agent_role ?? agentRole;
            baseInstructions = p.base_instructions ?? p.instructions ?? baseInstructions;
            contextWindow = typeof p.context_window === "number" ? p.context_window : contextWindow;
            modelProvider = p.model_provider ?? modelProvider;
            provenance = readProvenance(p[PROVENANCE_META_KEY]) ?? provenance;
            if (p.git) {
              git = {
                sha: p.git.commit_hash ?? undefined,
                branch: p.git.branch ?? undefined,
                remote: p.git.repository_url ?? undefined,
              };
            }
          } else {
            // Later metas mark compaction/fork boundaries inside one file.
            note(
              line,
              ts,
              "session_meta",
              `session boundary: ${p.id ?? "?"}${p.forked_from_id ? ` (forked from ${p.forked_from_id})` : ""}`,
              v,
            );
          }
          break;
        }

        case "turn_context": {
          if (!cwd && p.cwd) cwd = p.cwd;
          for (const root of p.workspace_roots ?? []) if (typeof root === "string") additionalDirs.add(root);
          if (typeof p.model === "string" && p.model !== currentModel) {
            const previous = currentModel;
            currentModel = p.model;
            if (previous !== undefined) {
              b.push({
                kind: "modelChange",
                id: b.nextId(line),
                parentId: null,
                ts: b.ts(ts),
                provider: modelProvider,
                model: p.model,
                origin: { nativeType: "turn_context" },
                raw: v,
              });
            }
          }
          break;
        }

        case "compacted": {
          b.push({
            kind: "compaction",
            id: b.nextId(line),
            parentId: null,
            ts: b.ts(ts),
            summary: typeof p.message === "string" ? p.message : undefined,
            replacedHistory: p.replacement_history,
            origin: { nativeType: "compacted" },
            raw: v,
          });
          break;
        }

        // -------------------------------------------------- canonical stream
        case "response_item": {
          switch (p.type) {
            case "message": {
              const parts: (UserContentPart | AssistantContentPart)[] = [];
              for (const c of p.content ?? []) {
                if (!c) continue;
                if (c.type === "input_image" || c.type === "output_image") {
                  const img = parseDataUrl(String(c.image_url ?? ""));
                  if (img) parts.push(img);
                  else parts.push({ type: "text", text: `[image: ${txt(c.image_url).slice(0, 120)}]` });
                } else if (typeof c.text === "string") {
                  if (c.text.trim()) parts.push({ type: "text", text: c.text });
                }
              }
              if (!parts.length) {
                note(line, ts, "empty_message", undefined, v);
                break;
              }
              if (p.role === "assistant") {
                const e: AssistantEntry = {
                  kind: "assistant",
                  id: b.nextId(line),
                  parentId: null,
                  ts: b.ts(ts),
                  content: parts as AssistantContentPart[],
                  model: currentModel ? { provider: modelProvider, id: currentModel } : undefined,
                  origin: { nativeType: "response_item:message", nativeId: p.id },
                  raw: v,
                };
                b.push(e);
                lastAssistant = e;
              } else {
                b.push({
                  kind: "user",
                  id: b.nextId(line),
                  parentId: null,
                  ts: b.ts(ts),
                  content: parts as UserContentPart[],
                  synthetic: p.role === "developer" ? true : undefined,
                  origin: { nativeType: `response_item:message:${p.role ?? "user"}`, nativeId: p.id },
                  raw: v,
                });
              }
              break;
            }

            case "reasoning": {
              const thinking: ThinkingPart[] = [];
              for (const s of p.summary ?? [])
                if (typeof s?.text === "string") thinking.push({ type: "thinking", thinking: s.text });
              for (const c of p.content ?? [])
                if (typeof c?.text === "string") thinking.push({ type: "thinking", thinking: c.text });
              if (!thinking.length && p.encrypted_content) thinking.push({ type: "thinking", thinking: "" });
              if (!thinking.length) {
                note(line, ts, "empty_reasoning", undefined, v);
                break;
              }
              // Non-portable provider state — carried, never dropped.
              if (typeof p.encrypted_content === "string") thinking[0].signature = p.encrypted_content;
              const e: AssistantEntry = {
                kind: "assistant",
                id: b.nextId(line),
                parentId: null,
                ts: b.ts(ts),
                content: thinking,
                model: currentModel ? { provider: modelProvider, id: currentModel } : undefined,
                origin: { nativeType: "response_item:reasoning", nativeId: p.id },
                raw: v,
              };
              b.push(e);
              lastAssistant = e;
              break;
            }

            case "function_call": {
              let args: Record<string, unknown> | string;
              try {
                const parsed = JSON.parse(String(p.arguments ?? "{}"));
                args = parsed && typeof parsed === "object" ? parsed : { input: p.arguments };
              } catch {
                args = { input: String(p.arguments ?? "") };
              }
              toolCall(
                line,
                ts,
                "response_item:function_call",
                { type: "toolCall", callId: String(p.call_id), name: String(p.name ?? "unknown"), args },
                v,
              );
              break;
            }

            case "custom_tool_call": {
              let args: Record<string, unknown> | string;
              try {
                const parsed = JSON.parse(String(p.input ?? ""));
                args = parsed && typeof parsed === "object" ? parsed : { input: p.input };
              } catch {
                args = { input: String(p.input ?? "") };
              }
              toolCall(
                line,
                ts,
                "response_item:custom_tool_call",
                { type: "toolCall", callId: String(p.call_id), name: String(p.name ?? "unknown"), args },
                v,
              );
              break;
            }

            case "function_call_output":
            case "custom_tool_call_output": {
              // Codex encodes failures inside the output text, so isError stays
              // undefined unless the payload states it explicitly.
              const out = p.output;
              const text =
                typeof out === "string"
                  ? out
                  : out && typeof out === "object" && typeof out.content === "string"
                    ? out.content
                    : txt(out);
              const isError =
                out && typeof out === "object" && out.success === false ? true : undefined;
              toolResult(line, ts, `response_item:${p.type}`, String(p.call_id), text, v, isError);
              break;
            }

            case "web_search_call": {
              const callId = String(p.call_id ?? p.id ?? `websearch-${line}`);
              const query = p.action?.query ?? p.action?.url ?? p.query;
              toolCall(
                line,
                ts,
                "response_item:web_search_call",
                {
                  type: "toolCall",
                  callId,
                  name: "web_search",
                  args: p.action ?? (query ? { query } : {}),
                },
                v,
              );
              break;
            }

            case "tool_search_call": {
              const callId = String(p.call_id ?? p.id ?? `toolsearch-${line}`);
              toolCall(
                line,
                ts,
                "response_item:tool_search_call",
                { type: "toolCall", callId, name: "tool_search", args: p.arguments ?? {} },
                v,
              );
              break;
            }

            case "tool_search_output": {
              toolResult(
                line,
                ts,
                "response_item:tool_search_output",
                String(p.call_id ?? `toolsearch-${line}`),
                txt(p.output ?? p.results),
                v,
              );
              break;
            }

            case "image_generation_call": {
              const callId = String(p.call_id ?? p.id ?? `imagegen-${line}`);
              toolCall(
                line,
                ts,
                "response_item:image_generation_call",
                {
                  type: "toolCall",
                  callId,
                  name: "image_generation",
                  args: { revised_prompt: p.revised_prompt, status: p.status },
                },
                v,
              );
              if (typeof p.result === "string" && p.result) {
                toolResult(
                  line,
                  ts,
                  "response_item:image_generation_call",
                  callId,
                  `[generated image: ${p.result.length} base64 bytes]`,
                  v,
                );
              }
              break;
            }

            case "agent_message": {
              // Inter-agent message. Direction decides whose turn it is.
              const own = agentPath ?? "/root";
              const outgoing = p.author === own;
              const parts: UserContentPart[] = [];
              const encrypted: unknown[] = [];
              for (const c of p.content ?? []) {
                if (!c) continue;
                if (typeof c.text === "string" && c.text.trim()) parts.push({ type: "text", text: c.text });
                else if (c.type === "encrypted_content") encrypted.push(c.encrypted_content);
              }
              if (!parts.length) parts.push({ type: "text", text: `[agent message ${p.author ?? "?"} → ${p.recipient ?? "?"}]` });
              const id = b.nextId(line);
              if (outgoing) {
                const e: AssistantEntry = {
                  kind: "assistant",
                  id,
                  parentId: null,
                  ts: b.ts(ts),
                  content: parts as AssistantContentPart[],
                  model: currentModel ? { provider: modelProvider, id: currentModel } : undefined,
                  origin: { nativeType: "response_item:agent_message", nativeId: p.id },
                  raw: v,
                };
                b.push(e);
                lastAssistant = e;
              } else {
                b.push({
                  kind: "user",
                  id,
                  parentId: null,
                  ts: b.ts(ts),
                  content: parts,
                  synthetic: true,
                  origin: { nativeType: "response_item:agent_message", nativeId: p.id },
                  raw: v,
                });
              }
              if (encrypted.length) encryptedAgentMessages[id] = encrypted;
              break;
            }

            case "ghost_snapshot": {
              note(line, ts, "ghost_snapshot", `ghost commit ${p.ghost_commit?.id ?? "?"}`, v);
              break;
            }

            default: {
              const key = `response_item:${p.type ?? "?"}`;
              unknown[key] = (unknown[key] ?? 0) + 1;
              note(line, ts, key, undefined, v);
            }
          }
          break;
        }

        // ------------------------------------------------- redundant UI stream
        case "event_msg": {
          switch (p.type) {
            case "user_message": {
              const text = String(p.message ?? "");
              if (!text.trim() || canonicalText.has(normText(text))) break; // dual-track dedupe
              b.push({
                kind: "user",
                id: b.nextId(line),
                parentId: null,
                ts: b.ts(ts),
                content: [{ type: "text", text }],
                origin: { nativeType: "event_msg:user_message" },
                raw: v,
              });
              break;
            }

            case "agent_message": {
              const text = String(p.message ?? "");
              if (!text.trim() || canonicalText.has(normText(text))) break;
              const e: AssistantEntry = {
                kind: "assistant",
                id: b.nextId(line),
                parentId: null,
                ts: b.ts(ts),
                content: [{ type: "text", text }],
                model: currentModel ? { provider: modelProvider, id: currentModel } : undefined,
                origin: { nativeType: "event_msg:agent_message" },
                raw: v,
              };
              b.push(e);
              lastAssistant = e;
              break;
            }

            case "agent_reasoning": {
              const text = String(p.text ?? "");
              if (!text.trim() || canonicalText.has(normText(text))) break;
              const e: AssistantEntry = {
                kind: "assistant",
                id: b.nextId(line),
                parentId: null,
                ts: b.ts(ts),
                content: [{ type: "thinking", thinking: text }],
                model: currentModel ? { provider: modelProvider, id: currentModel } : undefined,
                origin: { nativeType: "event_msg:agent_reasoning" },
                raw: v,
              };
              b.push(e);
              lastAssistant = e;
              break;
            }

            case "token_count": {
              const info = p.info;
              if (!info) break;
              const last = usageFrom(info.last_token_usage);
              if (last && lastAssistant) lastAssistant.usage = last;
              const total = usageFrom(info.total_token_usage);
              if (total) totalUsage = total; // cumulative — keep the latest, never sum
              if (typeof info.model_context_window === "number") contextWindow = info.model_context_window;
              break;
            }

            case "mcp_tool_call_end": {
              const callId = String(p.call_id ?? `mcp-${line}`);
              if (canonicalCallIds.has(callId)) break; // already in the canonical stream
              const inv = p.invocation ?? {};
              const name = inv.server && inv.tool ? `${inv.server}/${inv.tool}` : String(inv.tool ?? "mcp");
              toolCall(
                line,
                ts,
                "event_msg:mcp_tool_call_end",
                { type: "toolCall", callId, name, args: inv.arguments ?? {} },
                v,
              );
              const { value, isError } = unwrapResult(p.result);
              toolResult(line, ts, "event_msg:mcp_tool_call_end", callId, mcpContentText(value), v, isError);
              break;
            }

            case "web_search_end": {
              const callId = String(p.call_id ?? `websearch-${line}`);
              if (canonicalCallIds.has(callId)) break;
              toolCall(
                line,
                ts,
                "event_msg:web_search_end",
                { type: "toolCall", callId, name: "web_search", args: { query: p.query, action: p.action } },
                v,
              );
              toolResult(line, ts, "event_msg:web_search_end", callId, txt(p.results), v);
              break;
            }

            case "thread_name_updated": {
              const name = p.thread_name ?? p.name;
              if (typeof name === "string" && name.trim()) {
                title = name;
                titleSource = "auto";
              }
              break;
            }

            case "thread_rolled_back": {
              // Non-destructive: keep the abandoned branch, re-parent forward
              // entries to the point before the rolled-back turns.
              const turns = Number(p.num_turns ?? 1) || 1;
              const userIdx: number[] = [];
              for (let i = 0; i < b.entries.length; i++) {
                const e = b.entries[i];
                if (e.kind === "user" && !e.synthetic) userIdx.push(i);
              }
              const target = userIdx[userIdx.length - turns];
              const newHead = target === undefined ? null : b.entries[target].parentId;
              b.setHead(newHead);
              note(line, ts, "thread_rolled_back", `rolled back ${turns} turn(s)`, v);
              break;
            }

            case "collab_agent_spawn_end": {
              b.push({
                kind: "subsession",
                id: b.nextId(line),
                parentId: null,
                ts: b.ts(ts),
                sessionRef: String(p.new_thread_id ?? ""),
                agentName: p.new_agent_nickname ?? p.new_agent_role ?? undefined,
                origin: { nativeType: "event_msg:collab_agent_spawn_end", nativeId: p.call_id },
                raw: v,
              });
              break;
            }

            case "turn_aborted": {
              if (lastAssistant) lastAssistant.stopReason = "aborted";
              note(line, ts, "turn_aborted", String(p.reason ?? "aborted"), v);
              break;
            }

            case "thread_goal_updated": {
              note(line, ts, "thread_goal_updated", txt(p.goal?.objective), v);
              break;
            }

            case "thread_settings_applied": {
              note(line, ts, "thread_settings_applied", txt(p.thread_settings?.model), v);
              break;
            }

            case "item_completed": {
              const text = txt(p.item?.text);
              if (text && canonicalText.has(normText(text))) break;
              note(line, ts, `item_completed:${p.item?.type ?? "?"}`, text || undefined, v);
              break;
            }

            case "context_compacted": {
              // Redundant with the top-level `compacted` record when present.
              if (hasCompactedRecord) break;
              b.push({
                kind: "compaction",
                id: b.nextId(line),
                parentId: null,
                ts: b.ts(ts),
                summary: typeof p.message === "string" ? p.message : undefined,
                origin: { nativeType: "event_msg:context_compacted" },
                raw: v,
              });
              break;
            }

            // Pure UI churn already represented by the canonical stream.
            case "task_started":
            case "task_complete":
            case "sub_agent_activity":
            case "agent_reasoning_delta":
            case "agent_message_delta":
            case "agent_reasoning_section_break":
            case "exec_command_begin":
            case "exec_command_output_delta":
            case "mcp_tool_call_begin":
            case "web_search_begin":
            case "patch_apply_begin":
            case "stream_error":
              break;

            case "exec_command_end":
            case "patch_apply_end":
            case "view_image_tool_call":
            case "image_generation_end":
            case "collab_close_end":
            case "collab_waiting_end": {
              const callId = typeof p.call_id === "string" ? p.call_id : undefined;
              if (callId && canonicalCallIds.has(callId)) break; // paired call is canonical
              note(line, ts, `event_msg:${p.type}`, undefined, v);
              break;
            }

            default: {
              const key = `event_msg:${p.type ?? "?"}`;
              unknown[key] = (unknown[key] ?? 0) + 1;
              note(line, ts, key, undefined, v);
            }
          }
          break;
        }

        // Known-but-not-first-class top-level records.
        case "world_state":
          note(line, ts, "world_state", p.state?.agents_md?.directory, v);
          break;

        case "inter_agent_communication_metadata":
          note(line, ts, "inter_agent_communication_metadata", undefined, v);
          break;

        default: {
          const key = `${v.type ?? "?"}`;
          unknown[key] = (unknown[key] ?? 0) + 1;
          note(line, ts, key, undefined, v);
        }
      }
    }

    // ---- session assembly ---------------------------------------------
    const fileMeta = parseRolloutFilename(path);
    const nativeId = rolloutId ?? fileMeta.id ?? basename(path);

    if (!title) {
      // Codex injects <environment_context>/AGENTS.md blocks as user messages —
      // they are not what the session is about.
      const injected = /^(<[a-z_]+>|# AGENTS\.md instructions|<INSTRUCTIONS>)/;
      // Real user turns first; subagent rollouts only ever have injected
      // (synthetic) inbound messages, so fall back to those.
      for (const allowSynthetic of [false, true]) {
        if (title) break;
        for (const e of b.entries) {
          if (e.kind !== "user") continue;
          if (!allowSynthetic && e.synthetic) continue;
          const t = e.content.find((c): c is TextPart => c.type === "text")?.text?.trim();
          if (!t || injected.test(t)) continue;
          const first = t.split("\n").find((l) => l.trim()) ?? t;
          title = first.trim().slice(0, 80);
          titleSource = "derived";
          break;
        }
      }
    }

    const tsEntries = b.entries.filter((e) => e.ts);
    const preserve: Record<string, unknown> = {};
    if (baseInstructions !== undefined) preserve.baseInstructions = baseInstructions;
    if (sessionMetas.length) preserve.sessionMeta = sessionMetas;
    if (Object.keys(unknown).length) preserve.unknownRecordTypes = unknown;
    if (Object.keys(encryptedAgentMessages).length) preserve.encryptedAgentMessages = encryptedAgentMessages;
    if (contextWindow !== undefined) preserve.contextWindow = contextWindow;
    if (originator) preserve.originator = originator;
    if (cliVersion) preserve.cliVersion = cliVersion;
    if (threadSource) preserve.threadSource = threadSource;
    if (sessionId) preserve.sessionId = sessionId;
    if (parentThreadId) preserve.parentThreadId = parentThreadId;
    if (forkedFromId) preserve.forkedFromId = forkedFromId;
    if (provenance) preserve[PRESERVE_KEY] = provenance;
    if (agentPath || agentNickname || agentRole)
      preserve.agent = { path: agentPath, nickname: agentNickname, role: agentRole };

    additionalDirs.delete(cwd ?? "");
    const session: SifSession = {
      sif: SIF_VERSION,
      id: mintSifId(),
      origin: { harness: "codex", nativeId, nativePath: path },
      cwd: cwd ?? "",
      additionalDirs: additionalDirs.size ? [...additionalDirs] : undefined,
      git,
      title: title ? { text: title, source: titleSource } : undefined,
      createdAt: tsEntries[0]?.ts ?? toIso(lines[0]?.value.timestamp) ?? fileMeta.createdAt,
      updatedAt: tsEntries[tsEntries.length - 1]?.ts ?? undefined,
      usage: totalUsage,
      entries: b.entries,
      preserve: Object.keys(preserve).length ? preserve : undefined,
    };
    return session;
  }


  readWithCarry(ref: SessionRef): Promise<SifSession> {
    return this.read(ref, { carry: true });
  }

  write(session: SifSession, opts?: WriteOpts): Promise<NativeRef> {
    return writeSession(session, opts, this.home);
  }
  // ------------------------------------------------------------ resume

  resumeCommand(ref: SessionRef): string[] {
    return ["codex", "resume", ref.nativeId];
  }
}

const adapter = new CodexAdapter();
export default adapter;
