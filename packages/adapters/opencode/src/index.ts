/**
 * opencode adapter.
 *
 * Store: `~/.local/share/opencode/opencode.db` — a drizzle-managed SQLite
 * database, live and WAL-mode while `opencode` is running. Text lives in the
 * `part` table, not `message` (message.data only carries role/model/usage
 * metadata plus, for assistants, `parentID` pointing at the prompting user
 * message).
 *
 * Ground truth for the writer is a *fresh* `opencode export` (captured in
 * fixtures/opencode/export-sample.json) — old DB rows can carry legacy
 * shapes that fail `opencode import`'s validation (see upstream issue
 * #21941), so the writer's JSON shape is modeled on the live export command,
 * not on hand-reconstructed DB rows.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantContentPart,
  AssistantEntry,
  CompactionEntry,
  HarnessAdapter,
  Hop,
  ModelChangeEntry,
  NativeRef,
  NoteEntry,
  SessionRef,
  SessionSummary,
  SifEntry,
  SifSession,
  SinterProvenance,
  StoreInfo,
  SubsessionEntry,
  ToolCallPart,
  ToolResultEntry,
  Usage,
  UserContentPart,
  UserEntry,
  WriteOpts,
} from "@sinter/core";
import {
  CARRY_INLINE_MAX,
  PRESERVE_KEY,
  SIF_VERSION,
  buildProvenance,
  encodeCarry,
  inertToolText,
  loadCarry,
  mintSifId,
  readProvenance,
  storeCarry,
  toIso,
  validateSession,
} from "@sinter/core";

export const DEFAULT_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");

/** Stamped into every provenance record this adapter writes. */
export const SINTER_VERSION = "0.1.0";

/**
 * Where the sinter provenance record lives inside opencode.
 *
 * opencode's `import` command runs every record through zod before inserting
 * (`Session.Info.parse`, `MessageV2.Info.parse`, `MessageV2.Part.parse` in
 * src/cli/cmd/import.ts), and zod object schemas STRIP unknown keys. So an
 * invented top-level field is silently dropped — only a slot the upstream
 * schema actually declares survives a real `opencode import`.
 *
 * `MessageV2.TextPart` declares `metadata: z.record(z.string(), z.any())` —
 * an open-ended bag on a text part. Parts are stored as `part.data` (a JSON
 * blob column, id/sessionID/messageID hoisted into columns), so anything under
 * `metadata` round-trips through the store AND through opencode's own
 * export → import cycle untouched. It is also invisible to the model:
 * `toModelMessage` only forwards `part.text`, never `part.metadata`.
 *
 * The alternatives were worse:
 *   - `session.info.*` — the session row has fixed columns and `Session.toRow`
 *     ignores anything it doesn't know; the `metadata` column present in newer
 *     stores is not reachable through the import schema.
 *   - a message body — that IS conversation content, so the model would read
 *     a base64 carry blob back as prompt text.
 */
const PROVENANCE_PART_KEY = PRESERVE_KEY; // "sinter", under a text part's `metadata`

// ---------------------------------------------------------------- db access

interface OpenedStore {
  db: Database;
  /** Set when we had to copy the live db to a temp dir (readonly open failed / was busy). */
  cleanupDir?: string;
}

/**
 * Open the store read-only. Per CONVENTIONS.md: never `immutable=1` on a
 * live WAL db (silently reads stale data). We first try a direct readonly
 * open against the live path — bun:sqlite's readonly mode can read a live
 * WAL db fine (verified empirically against the real store) — and only fall
 * back to copying db+wal+shm to a temp dir if that's unavailable (e.g. the
 * fixture path has no WAL sidecars, or the live open throws).
 */
async function openStore(dbPath: string): Promise<OpenedStore> {
  try {
    const db = new Database(dbPath, { readonly: true });
    db.query("select 1").get(); // smoke-test the connection
    return { db };
  } catch {
    const dir = await mkdtemp(join(tmpdir(), "sinter-opencode-"));
    const copyPath = join(dir, "opencode.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = dbPath + suffix;
      if (existsSync(src)) await copyFile(src, copyPath + suffix);
    }
    const db = new Database(copyPath, { readonly: true });
    return { db, cleanupDir: dir };
  }
}

async function closeStore(store: OpenedStore): Promise<void> {
  store.db.close();
  if (store.cleanupDir) await rm(store.cleanupDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- row shapes

interface SessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  slug: string;
  directory: string;
  title: string;
  version: string;
  time_created: number;
  time_updated: number;
  path: string | null;
  agent: string | null;
  model: string | null; // JSON {id, providerID, variant}
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string; // JSON
}

interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string; // JSON
}

function sessionUsage(row: SessionRow): Usage {
  return {
    input: row.tokens_input,
    output: row.tokens_output,
    reasoning: row.tokens_reasoning,
    cacheRead: row.tokens_cache_read,
    cacheWrite: row.tokens_cache_write,
    costUsd: row.cost,
  };
}

function sessionModelString(row: SessionRow): string | undefined {
  if (!row.model) return undefined;
  try {
    const m = JSON.parse(row.model) as { id?: string; providerID?: string };
    return m.providerID && m.id ? `${m.providerID}/${m.id}` : (m.id ?? undefined);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- list()

async function* listSessions(dbPath: string): AsyncIterable<SessionSummary> {
  const store = await openStore(dbPath);
  try {
    // Single SQL over session (+ a cheap correlated subquery for message
    // count) — no per-transcript parsing. Cheap by construction.
    const rows = store.db
      .query<
        SessionRow & { msg_count: number },
        []
      >(
        `SELECT s.*, (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
         FROM session s
         ORDER BY s.time_updated DESC`,
      )
      .all();
    for (const row of rows) {
      yield {
        harness: "opencode",
        nativeId: row.id,
        nativePath: dbPath,
        cwd: row.directory,
        title: row.title || undefined,
        createdAt: toIso(row.time_created),
        updatedAt: toIso(row.time_updated),
        messageCount: row.msg_count,
        model: sessionModelString(row),
        usage: sessionUsage(row),
        parentNativeId: row.parent_id ?? undefined,
        isSubagent: row.parent_id != null,
      };
    }
  } finally {
    await closeStore(store);
  }
}

// ---------------------------------------------------------------- read()

function mapFinish(finish: unknown): AssistantEntry["stopReason"] {
  switch (finish) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "toolUse":
      return "toolUse";
    case "error":
      return "error";
    case "aborted":
      return "aborted";
    default:
      return undefined;
  }
}

function messageTokensToUsage(data: any): Usage | undefined {
  const t = data?.tokens;
  const cost = typeof data?.cost === "number" ? data.cost : undefined;
  if (!t && cost === undefined) return undefined;
  return {
    input: t?.input,
    output: t?.output,
    reasoning: t?.reasoning,
    cacheRead: t?.cache?.read,
    cacheWrite: t?.cache?.write,
    costUsd: cost,
  };
}

function dataUrlPayload(url: string): string {
  const comma = url.indexOf(",");
  return comma === -1 ? url : url.slice(comma + 1);
}

/** Builds the entry list for one session's messages+parts (already fetched). */
function buildEntries(messages: MessageRow[], partsByMessage: Map<string, PartRow[]>): SifEntry[] {
  const entries: SifEntry[] = [];
  let prevEntryId: string | null = null;

  for (const msg of messages) {
    let data: any;
    try {
      data = JSON.parse(msg.data);
    } catch {
      entries.push({
        kind: "note",
        id: msg.id,
        parentId: prevEntryId,
        ts: toIso(msg.time_created),
        origin: { nativeType: "message", nativeId: msg.id },
        raw: msg,
        noteType: "unparseable-message",
      });
      prevEntryId = msg.id;
      continue;
    }

    // The `data` JSON blob in the db does NOT carry id/sessionID/messageID —
    // those are separate row columns (unlike `opencode export`'s output,
    // which merges them in). Merge them here so the rest of this function
    // can treat a part uniformly, and so `raw` matches the export shape.
    const rawParts = (partsByMessage.get(msg.id) ?? []).map((p) => {
      try {
        return { ...JSON.parse(p.data), id: p.id, sessionID: p.session_id, messageID: p.message_id };
      } catch {
        return { type: "unparseable", id: p.id, sessionID: p.session_id, messageID: p.message_id };
      }
    });

    if (data.role === "user") {
      const content: UserContentPart[] = [];
      const extras: { part: any }[] = [];
      for (const part of rawParts) {
        if (part.type === "text" && typeof part.text === "string" && part.text !== "") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "file" && typeof part.url === "string" && part.url.startsWith("data:") && part.mime?.startsWith("image/")) {
          content.push({ type: "image", mimeType: part.mime, data: dataUrlPayload(part.url) });
        } else if (part.type === "patch" || part.type === "compaction" || part.type === "file") {
          extras.push({ part });
        }
      }
      const id = msg.id;
      const parentId = prevEntryId;
      const entry: UserEntry = {
        kind: "user",
        id,
        parentId,
        ts: toIso(msg.time_created),
        origin: { nativeType: "message", nativeId: msg.id },
        raw: { message: data, parts: rawParts },
        content,
      };
      entries.push(entry);
      prevEntryId = id;

      for (const { part } of extras) {
        prevEntryId = pushNoteOrCompaction(entries, part, msg, prevEntryId);
      }
    } else if (data.role === "assistant") {
      const id = msg.id;
      const parentId = typeof data.parentID === "string" ? data.parentID : prevEntryId;
      const content: AssistantContentPart[] = [];
      const toolResults: ToolResultEntry[] = [];
      const extras: { part: any }[] = [];

      for (const part of rawParts) {
        if (part.type === "text" && typeof part.text === "string" && part.text !== "") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "reasoning" && typeof part.text === "string" && part.text !== "") {
          content.push({ type: "thinking", thinking: part.text });
        } else if (part.type === "file" && typeof part.url === "string" && part.mime?.startsWith("image/")) {
          content.push({ type: "image", mimeType: part.mime, data: dataUrlPayload(part.url) });
        } else if (part.type === "tool" && typeof part.tool === "string") {
          const callId: string = part.callID ?? part.id;
          content.push({ type: "toolCall", callId, name: part.tool, args: part.state?.input ?? {} });
          const output = part.state?.output;
          const outText =
            typeof output === "string" ? output : output !== undefined ? JSON.stringify(output) : undefined;
          toolResults.push({
            kind: "toolResult",
            id: `${part.id}:result`,
            parentId: id, // fixed up below to chain after the assistant entry
            ts: toIso(part.state?.time?.end ?? part.state?.time?.start ?? msg.time_created),
            origin: { nativeType: "part", nativeId: part.id },
            raw: part,
            callId,
            toolName: part.tool,
            content: outText !== undefined ? [{ type: "text", text: outText }] : [],
            isError: part.state?.status === "error",
          });
        } else if (part.type === "patch" || part.type === "compaction" || part.type === "file") {
          extras.push({ part });
        }
        // step-start / step-finish: pure step metadata, no first-class SIF
        // shape; preserved in the assistant entry's `raw.parts` above.
      }

      const entry: AssistantEntry = {
        kind: "assistant",
        id,
        parentId,
        ts: toIso(msg.time_created),
        origin: { nativeType: "message", nativeId: msg.id },
        raw: { message: data, parts: rawParts },
        content,
        model: data.providerID || data.modelID ? { provider: data.providerID, id: data.modelID } : undefined,
        usage: messageTokensToUsage(data),
        stopReason: mapFinish(data.finish),
      };
      entries.push(entry);

      let chainId = id;
      for (const tr of toolResults) {
        tr.parentId = chainId;
        entries.push(tr);
        chainId = tr.id;
      }
      for (const { part } of extras) {
        chainId = pushNoteOrCompaction(entries, part, msg, chainId);
      }
      prevEntryId = chainId;
    } else {
      const id = msg.id;
      entries.push({
        kind: "note",
        id,
        parentId: prevEntryId,
        ts: toIso(msg.time_created),
        origin: { nativeType: "message", nativeId: msg.id },
        raw: { message: data, parts: rawParts },
        noteType: `unknown-role:${String(data.role)}`,
      });
      prevEntryId = id;
    }
  }

  return entries;
}

function pushNoteOrCompaction(
  entries: SifEntry[],
  part: any,
  msg: MessageRow,
  parentId: string | null,
): string {
  if (part.type === "compaction") {
    const entry: CompactionEntry = {
      kind: "compaction",
      id: part.id,
      parentId,
      ts: toIso(msg.time_created),
      origin: { nativeType: "part", nativeId: part.id },
      raw: part,
    };
    entries.push(entry);
    return part.id;
  }
  if (part.type === "patch") {
    const files = Array.isArray(part.files) ? part.files : [];
    const entry: NoteEntry = {
      kind: "note",
      id: part.id,
      parentId,
      ts: toIso(msg.time_created),
      origin: { nativeType: "part", nativeId: part.id },
      raw: part,
      noteType: "patch",
      text: `patch touching ${files.length} file(s): ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}`,
    };
    entries.push(entry);
    return part.id;
  }
  // non-image file part (e.g. a non-image attachment)
  const entry: NoteEntry = {
    kind: "note",
    id: part.id,
    parentId,
    ts: toIso(msg.time_created),
    origin: { nativeType: "part", nativeId: part.id },
    raw: part,
    noteType: "file",
    text: part.filename ? `attachment: ${part.filename}` : "attachment",
  };
  entries.push(entry);
  return part.id;
}

/**
 * Recover the provenance record a previous sinter write stamped onto a text
 * part's `metadata.sinter`. Deliberately total: unparseable part JSON is
 * skipped and `readProvenance` returns undefined for anything malformed, so a
 * corrupt marker can never take a read down. The last valid record wins —
 * writes always mint a fresh session, so in practice there is exactly one.
 */
function extractProvenance(parts: PartRow[]): SinterProvenance | undefined {
  let found: SinterProvenance | undefined;
  for (const p of parts) {
    let data: any;
    try {
      data = JSON.parse(p.data);
    } catch {
      continue;
    }
    const raw = data?.metadata?.[PROVENANCE_PART_KEY];
    if (raw === undefined) continue;
    const prov = readProvenance(raw);
    if (prov) found = prov;
  }
  return found;
}

async function readSession(dbPath: string, nativeId: string, depth = 0): Promise<SifSession> {
  const store = await openStore(dbPath);
  try {
    return await readSessionWithStore(store.db, dbPath, nativeId, depth);
  } finally {
    await closeStore(store);
  }
}

async function readSessionWithStore(
  db: Database,
  dbPath: string,
  nativeId: string,
  depth: number,
): Promise<SifSession> {
  const row = db.query<SessionRow, [string]>("SELECT * FROM session WHERE id = ?").get(nativeId);
  if (!row) throw new Error(`opencode: session not found: ${nativeId}`);

  const messages = db
    .query<MessageRow, [string]>("SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id")
    .all(nativeId);

  const parts = db
    .query<PartRow, [string]>("SELECT * FROM part WHERE session_id = ? ORDER BY time_created, id")
    .all(nativeId);
  const partsByMessage = new Map<string, PartRow[]>();
  for (const p of parts) {
    const arr = partsByMessage.get(p.message_id);
    if (arr) arr.push(p);
    else partsByMessage.set(p.message_id, [p]);
  }

  const entries = buildEntries(messages, partsByMessage);

  // Subsessions: children with parent_id = this session. Stub references
  // are always added; full nested SifSessions are embedded one level deep
  // only, to keep read() cheap and bounded (per PLAN.md, 221/499 sessions
  // have a parent — unbounded recursion could touch a meaningful fraction
  // of the whole store).
  const children = db
    .query<{ id: string; title: string }, [string]>(
      "SELECT id, title FROM session WHERE parent_id = ? ORDER BY time_created",
    )
    .all(nativeId);

  const subsessions: SifSession[] = [];
  if (children.length > 0) {
    const anchor = entries.length > 0 ? entries[entries.length - 1]!.id : null;
    for (const child of children) {
      const subEntry: SubsessionEntry = {
        kind: "subsession",
        id: `subsession:${child.id}`,
        parentId: anchor,
        origin: { nativeType: "session", nativeId: child.id },
        sessionRef: child.id,
      };
      entries.push(subEntry);
      if (depth === 0) {
        try {
          subsessions.push(await readSessionWithStore(db, dbPath, child.id, depth + 1));
        } catch {
          // best-effort; the stub SubsessionEntry above still records the link
        }
      }
    }
  }

  let model: { id?: string; providerID?: string } | undefined;
  try {
    model = row.model ? (JSON.parse(row.model) as { id?: string; providerID?: string }) : undefined;
  } catch {
    model = undefined;
  }

  const preserve: Record<string, unknown> = {};
  if (model) preserve.opencode = { agent: row.agent ?? undefined, model };
  const provenance = extractProvenance(parts);
  if (provenance) preserve[PRESERVE_KEY] = provenance;

  const session: SifSession = {
    sif: SIF_VERSION,
    id: mintSifId(),
    origin: { harness: "opencode", nativeId: row.id, nativePath: dbPath },
    cwd: row.directory,
    title: { text: row.title, source: "auto" },
    createdAt: toIso(row.time_created),
    updatedAt: toIso(row.time_updated),
    usage: sessionUsage(row),
    entries,
    ...(subsessions.length > 0 ? { subsessions } : {}),
    ...(Object.keys(preserve).length > 0 ? { preserve } : {}),
  };
  return session;
}

// ------------------------------------------------------- carry-forward read

/** Marks a session whose entries were recovered from a carry payload. */
export const CARRY_PRESERVE_KEY = "sinterCarry" as const;

/**
 * Swap a flattened transcript for the original SIF entries the writer carried
 * forward, when one is recoverable.
 *
 * The native identity (origin, cwd, title, timestamps, usage, provenance) stays
 * exactly as the opencode store has it — only the entry tree is replaced, so a
 * caller still knows which opencode session it is holding.
 *
 * Returns the session untouched when there is no provenance, no carry payload,
 * or the payload is corrupt: the flattened transcript in the store is always a
 * usable answer.
 */
export async function applyCarry(session: SifSession): Promise<SifSession> {
  const prov = readProvenance(session.preserve?.[PRESERVE_KEY]);
  if (!prov) return session;
  const carried = await loadCarry(prov);
  if (!carried || !Array.isArray(carried.entries) || carried.entries.length === 0) return session;

  const { subsessions: _nativeSubsessions, ...rest } = session;
  return {
    ...rest,
    entries: carried.entries,
    ...(carried.subsessions?.length ? { subsessions: carried.subsessions } : {}),
    preserve: {
      ...session.preserve,
      [CARRY_PRESERVE_KEY]: {
        recoveredFrom: carried.origin,
        entries: carried.entries.length,
        via: prov.carryRef ? "sidecar" : "inline",
      },
    },
  };
}

export interface OpencodeReadOpts {
  /**
   * Recover the ORIGINAL source entries from the carry payload instead of the
   * flattened `[historical tool call: …]` transcript actually stored in the db.
   *
   * Off by default, on purpose: `read()` is also what `list`/`show`/`relink`
   * use, and those must report what is really in the opencode store — a default
   * that silently substitutes a different entry tree would make the adapter lie
   * about its own store. Porting is the one caller that wants the original
   * entries (re-flattening an already-flattened transcript is what degrades a
   * multi-hop thread), so it opts in via `readWithCarry()`.
   */
  carry?: boolean;
}

// ---------------------------------------------------------------- write()

let mintCounter = 0;
function mintNativeId(prefix: "ses" | "msg" | "prt"): string {
  // opencode's own id scheme is an implementation detail we don't need to
  // replicate — import accepted an arbitrary "ses_sintertestXXXX..." id
  // verbatim in live testing. We use a distinct "sinter" infix so these are
  // recognizable as sinter-authored if ever inspected directly in the db.
  mintCounter++;
  const rand = crypto.getRandomValues(new Uint8Array(10));
  const hex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_sinter${hex}${mintCounter.toString(16)}`;
}

function textOf(parts: { type: string; text?: string }[] | undefined): string | undefined {
  if (!parts) return undefined;
  const texts = parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text as string);
  return texts.length ? texts.join("\n") : undefined;
}

/**
 * Pure function: builds the opencode-export-shaped JSON payload for a SIF
 * session. Separated from the actual `opencode import` shell-out so it can
 * be unit tested offline against fixtures/opencode/export-sample.json's
 * shape without touching any store.
 */
export function buildOpencodeExport(
  session: SifSession,
  opts: WriteOpts | undefined,
  targetCwd: string,
  lineage?: { sessionId?: string; provenance?: SinterProvenance },
): { payload: any; nativeId: string } {
  const liveTools = opts?.liveTools === true;
  const sessionId = lineage?.sessionId ?? mintNativeId("ses");

  const resultByCallId = new Map<string, ToolResultEntry>();
  for (const e of session.entries) {
    if (e.kind === "toolResult") resultByCallId.set(e.callId, e);
  }

  const messages: any[] = [];
  let lastMessageId: string | null = null;
  let clock = (() => {
    for (const e of session.entries) {
      if (e.ts) {
        const t = Date.parse(e.ts);
        if (!Number.isNaN(t)) return t;
      }
    }
    return Date.now();
  })();
  const nextTs = (e: SifEntry): number => {
    if (e.ts) {
      const t = Date.parse(e.ts);
      if (!Number.isNaN(t) && t >= clock) {
        clock = t + 1;
        return t;
      }
    }
    const t = clock;
    clock += 1000;
    return t;
  };

  function pushUserLike(id: string, ts: number, textParts: string[], firstPartMetadata?: Record<string, unknown>) {
    messages.push({
      info: {
        role: "user",
        time: { created: ts },
        agent: "build",
        model: { providerID: "unknown", modelID: "unknown" },
        summary: { diffs: [] },
        id,
        sessionID: sessionId,
      },
      parts: textParts.map((text, i) => ({
        type: "text",
        text,
        ...(i === 0 && firstPartMetadata ? { metadata: firstPartMetadata } : {}),
        id: mintNativeId("prt"),
        sessionID: sessionId,
        messageID: id,
      })),
    });
    lastMessageId = id;
  }

  // Provenance marker (survives import validation as a plain leading text
  // message — CONVENTIONS.md rule 7 / WriteOpts contract). The human-readable
  // text stays; the machine-readable lineage record rides along in the same
  // part's `metadata.sinter`, which opencode round-trips but never shows to
  // the model (see PROVENANCE_PART_KEY above).
  const provenanceId = mintNativeId("msg");
  const provenanceTs = clock;
  clock += 1000;
  pushUserLike(
    provenanceId,
    provenanceTs,
    [
      `[imported via sinter from ${session.origin.harness}:${session.origin.nativeId} on ${new Date().toISOString().slice(0, 10)}]`,
    ],
    lineage?.provenance ? { [PROVENANCE_PART_KEY]: lineage.provenance } : undefined,
  );

  for (const entry of session.entries) {
    if (entry.kind === "toolResult") continue; // folded into the owning toolCall below
    if (entry.kind === "subsession") {
      const id = mintNativeId("msg");
      const ts = nextTs(entry);
      const ref = `[subsession${entry.agentName ? " " + entry.agentName : ""} -> ${entry.sessionRef}]${
        entry.resultText ? ": " + entry.resultText : ""
      }`;
      pushUserLike(id, ts, [ref]);
      continue;
    }
    if (entry.kind === "modelChange") {
      const id = mintNativeId("msg");
      const ts = nextTs(entry);
      pushUserLike(id, ts, [`[model changed to ${entry.provider ? entry.provider + "/" : ""}${entry.model}]`]);
      continue;
    }
    if (entry.kind === "compaction") {
      const id = mintNativeId("msg");
      const ts = nextTs(entry);
      pushUserLike(id, ts, [`[compaction${entry.summary ? ": " + entry.summary : ""}]`]);
      continue;
    }
    if (entry.kind === "note") {
      const id = mintNativeId("msg");
      const ts = nextTs(entry);
      pushUserLike(id, ts, [`[${entry.noteType}]${entry.text ? " " + entry.text : ""}`]);
      continue;
    }

    if (entry.kind === "user") {
      const id = mintNativeId("msg");
      const ts = nextTs(entry);
      const textParts: string[] = [];
      const fileParts: any[] = [];
      for (const part of entry.content) {
        if (part.type === "text") textParts.push(part.text);
        else if (part.type === "image")
          fileParts.push({
            type: "file",
            mime: part.mimeType,
            filename: "image",
            url: `data:${part.mimeType};base64,${part.data}`,
          });
      }
      messages.push({
        info: {
          role: "user",
          time: { created: ts },
          agent: "build",
          model: { providerID: "unknown", modelID: "unknown" },
          summary: { diffs: [] },
          id,
          sessionID: sessionId,
        },
        parts: [
          ...textParts.map((text) => ({ type: "text", text, id: mintNativeId("prt"), sessionID: sessionId, messageID: id })),
          ...fileParts.map((f) => ({ ...f, id: mintNativeId("prt"), sessionID: sessionId, messageID: id })),
        ],
      });
      lastMessageId = id;
      continue;
    }

    if (entry.kind === "assistant") {
      const id = mintNativeId("msg");
      const ts = nextTs(entry);
      const outParts: any[] = [];
      for (const part of entry.content) {
        // Assistant text/reasoning parts carry part-level time in real exports
        // (user parts don't) — import validation requires it.
        if (part.type === "text") {
          outParts.push({ type: "text", text: part.text, time: { start: ts, end: ts } });
        } else if (part.type === "thinking") {
          outParts.push({ type: "reasoning", text: part.thinking, time: { start: ts, end: ts } });
        } else if (part.type === "image") {
          outParts.push({ type: "file", mime: part.mimeType, filename: "image", url: `data:${part.mimeType};base64,${part.data}` });
        } else if (part.type === "toolCall") {
          const result = resultByCallId.get(part.callId);
          const resultText = textOf(result?.content as any);
          if (liveTools) {
            outParts.push({
              type: "tool",
              tool: part.name,
              callID: part.callId,
              state: {
                status: result ? (result.isError ? "error" : "completed") : "pending",
                input: typeof part.args === "string" ? safeJsonParse(part.args) : part.args,
                output: resultText ?? "",
                title: part.name,
                time: { start: ts, end: ts },
              },
            });
          } else {
            outParts.push({ type: "text", text: inertToolText(part as ToolCallPart, resultText).text, time: { start: ts, end: ts } });
          }
        }
      }
      if (outParts.length === 0) outParts.push({ type: "text", text: "[empty turn]", time: { start: ts, end: ts } });
      messages.push({
        info: {
          parentID: lastMessageId,
          role: "assistant",
          mode: "build",
          agent: "build",
          path: { cwd: targetCwd, root: targetCwd },
          cost: entry.usage?.costUsd ?? 0,
          tokens: {
            total: (entry.usage?.input ?? 0) + (entry.usage?.output ?? 0),
            input: entry.usage?.input ?? 0,
            output: entry.usage?.output ?? 0,
            reasoning: entry.usage?.reasoning ?? 0,
            cache: { read: entry.usage?.cacheRead ?? 0, write: entry.usage?.cacheWrite ?? 0 },
          },
          modelID: entry.model?.id ?? "unknown",
          providerID: entry.model?.provider ?? "unknown",
          time: { created: ts, completed: ts },
          finish: entry.stopReason === "toolUse" ? "tool_calls" : entry.stopReason ?? "stop",
          id,
          sessionID: sessionId,
        },
        parts: outParts.map((p) => ({ ...p, id: mintNativeId("prt"), sessionID: sessionId, messageID: id })),
      });
      lastMessageId = id;
      continue;
    }
  }

  const firstTs = provenanceTs;
  const lastTs = clock;
  const totalUsage = session.usage;

  const payload = {
    info: {
      id: sessionId,
      slug: "sinter-import",
      // NOTE (contract friction, verified live): `opencode import` ignores
      // both of these and instead derives project/directory from the
      // *process cwd* the import command is run in — write() sets that via
      // Bun.spawn's `cwd` option (see below), not via these fields. Kept
      // here anyway to match a real export's shape byte-for-byte.
      projectID: "global",
      directory: targetCwd,
      path: "",
      title: session.title?.text ?? `Imported session (${session.origin.harness})`,
      agent: "build",
      model: { id: "unknown", providerID: "unknown", variant: "default" },
      version: "sinter",
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: totalUsage?.costUsd ?? 0,
      tokens: {
        input: totalUsage?.input ?? 0,
        output: totalUsage?.output ?? 0,
        reasoning: totalUsage?.reasoning ?? 0,
        cache: { read: totalUsage?.cacheRead ?? 0, write: totalUsage?.cacheWrite ?? 0 },
      },
      time: { created: firstTs, updated: lastTs },
    },
    messages,
  };

  return { payload, nativeId: sessionId };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Strip a nested carry blob before carrying a session forward again.
 *
 * Without this, hop N's payload contains hop N-1's payload contains … — the
 * record doubles in size every port and a 4-hop thread carries the same
 * transcript four times over. The carried SIF only needs the ENTRIES; its own
 * ancestry is already in the record we are about to write.
 */
function carrySource(session: SifSession): SifSession {
  const prov = readProvenance(session.preserve?.[PRESERVE_KEY]);
  if (!prov || (!prov.carry && !prov.carryRef)) return session;
  const { carry: _c, carryRef: _r, carryBytes: _b, ...lean } = prov;
  return { ...session, preserve: { ...session.preserve, [PRESERVE_KEY]: lean } };
}

async function captureCarry(
  session: SifSession,
  target: Hop,
  opts: WriteOpts | undefined,
): Promise<Pick<SinterProvenance, "carry" | "carryRef" | "carryBytes">> {
  const payload = carrySource(session);
  if (!opts?.dryRun) return storeCarry(payload, target);
  // A dry run must write NOTHING — not even a carry sidecar. Inline what would
  // have been inlined so the reported record is honest, and drop the payload
  // entirely when it would have needed a file.
  const encoded = encodeCarry(payload);
  if (!encoded || encoded.length > CARRY_INLINE_MAX) return {};
  return { carry: encoded, carryBytes: JSON.stringify(payload).length };
}

/**
 * The provenance record to stamp into the target store.
 *
 * A record already sitting on `session.preserve.sinter` is ambiguous: it is
 * either (a) the SOURCE's own record, round-tripped by whichever adapter read
 * it — the normal case, and exactly what `buildProvenance` wants as input to
 * extend the chain by one hop — or (b) a record the caller built for THIS write
 * via `withProvenance`, which must be persisted as-is.
 *
 * They are told apart by the chain's tail: case (b) already ends at an opencode
 * hop that is not the session's own origin, i.e. it ends at us.
 */
export async function resolveProvenance(
  session: SifSession,
  nativeId: string,
  opts?: WriteOpts,
): Promise<SinterProvenance> {
  const target: Hop = { harness: "opencode", nativeId };
  const preset = readProvenance(session.preserve?.[PRESERVE_KEY]);
  const tail = preset?.chain[preset.chain.length - 1];
  const presetTargetsThisWrite =
    !!preset && tail?.harness === "opencode" && tail.nativeId !== session.origin.nativeId;

  const record = presetTargetsThisWrite
    ? preset!
    : buildProvenance({
        source: session,
        target,
        sinterVersion: SINTER_VERSION,
        portedAt: new Date().toISOString(),
        mode: opts?.mode,
        inertTools: !opts?.liveTools,
      });

  // Never clobber a carry the caller deliberately attached.
  if (record.carry || record.carryRef) return record;
  return { ...record, ...(await captureCarry(session, target, opts)) };
}

/**
 * `buildOpencodeExport` plus the lineage the writer stamps: mints the target
 * id first (the provenance record has to name it), resolves the provenance
 * record and its carry payload, then builds the payload around both.
 */
export async function prepareOpencodeExport(
  session: SifSession,
  opts: WriteOpts | undefined,
  targetCwd: string,
): Promise<{ payload: any; nativeId: string; provenance: SinterProvenance }> {
  const sessionId = mintNativeId("ses");
  const provenance = await resolveProvenance(session, sessionId, opts);
  const { payload } = buildOpencodeExport(session, opts, targetCwd, { sessionId, provenance });
  return { payload, nativeId: sessionId, provenance };
}

async function writeSession(session: SifSession, opts: WriteOpts | undefined, dbPath: string): Promise<NativeRef> {
  validateSession(session);
  const targetCwd = opts?.cwd ?? session.cwd;
  const { payload, nativeId, provenance } = await prepareOpencodeExport(session, opts, targetCwd);

  if (opts?.dryRun) {
    return { harness: "opencode", nativeId, nativePath: dbPath, created: [], provenance };
  }

  const tmpFile = join(tmpdir(), `sinter-opencode-import-${nativeId}.json`);
  await Bun.write(tmpFile, JSON.stringify(payload, null, 2));
  try {
    const proc = Bun.spawn(["opencode", "import", tmpFile], {
      cwd: targetCwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`opencode import failed (exit ${exitCode}): ${stderr || stdout}`);
    }
    const m = stdout.match(/Imported session:\s*(\S+)/);
    // Trust the CLI's own report of the id it used over our minted value —
    // the CLI is the source of truth for what actually landed in the store.
    const importedId = m ? m[1]! : nativeId;
    // The CLI echoes `info.id` back verbatim today, so this is normally a
    // no-op; if a future version ever renames the session on import, keep the
    // record we hand back pointing at the id that actually landed.
    const stamped: SinterProvenance =
      importedId === nativeId
        ? provenance
        : {
            ...provenance,
            chain: provenance.chain.map((h, i) =>
              i === provenance.chain.length - 1 ? { ...h, nativeId: importedId } : h,
            ),
          };
    return {
      harness: "opencode",
      nativeId: importedId,
      nativePath: dbPath,
      created: [importedId],
      provenance: stamped,
    };
  } finally {
    await rm(tmpFile, { force: true });
  }
}

// ---------------------------------------------------------------- adapter

export class OpencodeAdapter implements HarnessAdapter {
  readonly id = "opencode" as const;

  constructor(private readonly dbPath: string = DEFAULT_DB_PATH) {}

  async detect(): Promise<StoreInfo | null> {
    if (!existsSync(this.dbPath)) return null;
    let version: string | undefined;
    try {
      const store = await openStore(this.dbPath);
      try {
        const row = store.db
          .query<{ version: string }, []>("SELECT version FROM session ORDER BY time_updated DESC LIMIT 1")
          .get();
        version = row?.version;
      } finally {
        await closeStore(store);
      }
    } catch {
      // detect() should never throw on a readable-but-odd store
    }
    return { harness: "opencode", paths: [this.dbPath], version, notes: "drizzle SQLite; text lives in `part` rows" };
  }

  list(): AsyncIterable<SessionSummary> {
    return listSessions(this.dbPath);
  }

  /**
   * Native view by default — what is actually stored, with any sinter
   * provenance recovered onto `preserve.sinter`. Pass `{ carry: true }` (or
   * call `readWithCarry`) to get the original pre-flattening entries back.
   */
  async read(ref: SessionRef, opts?: OpencodeReadOpts): Promise<SifSession> {
    const session = await readSession(this.dbPath, ref.nativeId);
    return opts?.carry ? applyCarry(session) : session;
  }

  /**
   * Read with carry-forward: when the session was written by sinter and the
   * carry payload is still recoverable, the returned entries are the ORIGINAL
   * source entries (live tool calls and results, no `[historical tool call: …]`
   * text, no accumulated import markers) rather than this store's flattened
   * copy. This is what a port should read, so a thread does not degrade a
   * little more on every hop.
   */
  readWithCarry(ref: SessionRef): Promise<SifSession> {
    return this.read(ref, { carry: true });
  }

  write(session: SifSession, opts?: WriteOpts): Promise<NativeRef> {
    return writeSession(session, opts, this.dbPath);
  }

  resumeCommand(ref: SessionRef): string[] {
    return ["opencode", "--session", ref.nativeId];
  }
}

export default new OpencodeAdapter();
