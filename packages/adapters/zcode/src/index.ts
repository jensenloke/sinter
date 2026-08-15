/**
 * zcode adapter — reader + lister only (v1). zcode is a commercial GLM/Zhipu
 * Electron app (/Applications/ZCode.app) that imitates Claude Code, opencode,
 * and Codex simultaneously. Its store is opencode-shaped SQLite (session /
 * message / part, `sequence`-ordered) plus zcode-specific telemetry
 * (`turn_usage`, `session_entry`). There is no zcode CLI on PATH, so
 * `resumeCommand()` is a best guess — see the EXPERIMENTAL note there.
 *
 * No write() in v1 (reader/lister only, per assignment).
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type {
  HarnessAdapter,
  StoreInfo,
  SessionRef,
  SessionSummary,
  SifSession,
  SifEntry,
  UserEntry,
  AssistantEntry,
  ToolResultEntry,
  CompactionEntry,
  ModelChangeEntry,
  NoteEntry,
  UserContentPart,
  AssistantContentPart,
  SifTitle,
  Usage,
} from "@sinter/core";
import { SIF_VERSION, toIso, mintSifId, addUsage } from "@sinter/core";

const DEFAULT_DB_PATH = join(homedir(), ".zcode", "cli", "db", "db.sqlite");

// ---------------------------------------------------------------- db rows

interface SessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  title_source: string;
  version: string;
  task_type: string;
  trace_id: string | null;
  time_created: number;
  time_updated: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  sequence: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  sequence: number;
  data: string;
}

interface TurnUsageRow {
  session_id: string;
  turn_id: string;
  user_message_id: string | null;
  status: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface SessionEntryRow {
  id: string;
  session_id: string;
  type: string;
  time_created: number;
  data: string;
}

// ---------------------------------------------------------------- db open

/**
 * Open the store read-only. Never immutable=1 on a live WAL database (it
 * silently reads stale data). If the plain readonly open fails (the DB is
 * locked by a live process in a way bun:sqlite can't tolerate), fall back to
 * copying db+wal+shm into a temp dir and opening the copy — never mutates
 * the source store either way.
 */
function openForRead(path: string): { db: Database; cleanup: () => void } {
  try {
    const db = new Database(path, { readonly: true });
    db.query("select 1").get(); // force any locking error to surface now
    return { db, cleanup: () => db.close() };
  } catch {
    const dir = mkdtempSync(join(tmpdir(), "sinter-zcode-"));
    const copyPath = join(dir, "db.sqlite");
    copyFileSync(path, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(path + suffix)) copyFileSync(path + suffix, copyPath + suffix);
    }
    const db = new Database(copyPath, { readonly: true });
    return {
      db,
      cleanup: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }
}

// ---------------------------------------------------------------- mapping helpers

function mapTitleSource(s: string): SifTitle["source"] {
  switch (s) {
    case "custom":
      return "user";
    case "first_input":
      return "derived";
    case "generated":
    case "default":
    default:
      return "auto";
  }
}

function mapStopReason(data: any): AssistantEntry["stopReason"] | undefined {
  if (data?.error) return "error";
  const f = data?.finish;
  if (f === "stop" || f === "completed") return "stop";
  if (f === "length") return "length";
  if (f === "tool-calls" || f === "tool_calls") return "toolUse";
  if (f === "aborted" || f === "cancelled") return "aborted";
  return undefined;
}

/** message.data.tokens -> Usage, omitting when there are no real numbers. */
function usageFromTokens(tokens: any): Usage | undefined {
  if (!tokens) return undefined;
  const input = tokens.input;
  const output = tokens.output;
  const reasoning = tokens.reasoning;
  const cacheRead = tokens.cache?.read;
  const cacheWrite = tokens.cache?.write;
  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  )
    return undefined;
  const total = (input ?? 0) + (output ?? 0) + (reasoning ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (total === 0) return undefined; // omit rather than zero-fill
  return { input, output, reasoning, cacheRead, cacheWrite };
}

function describeError(err: any): string {
  if (!err) return "unknown error";
  const msg = err.data?.message ?? err.message;
  return msg ? `${err.name ?? "Error"}: ${msg}` : (err.name ?? "unknown error");
}

/** Best-effort plain text for a NoteEntry, from a message's text-type parts. */
function plainTextFromParts(parts: { data: any }[]): string | undefined {
  const texts = parts
    .map((p) => p.data)
    .filter((d) => d.type === "text" && typeof d.text === "string" && d.text.length > 0)
    .map((d) => d.text as string);
  if (texts.length) return texts.join("\n");
  return undefined;
}

function summarizeSessionEntry(type: string, data: any): string | undefined {
  switch (type) {
    case "runtime/model_selection":
      return `model selected: ${data.providerId ?? "?"}/${data.modelId ?? "?"}`;
    case "runtime/bash_shell_selection":
      return `shell selected: ${data.label ?? data.path ?? "?"}`;
    case "runtime/workspace_checkpoint":
      return `workspace checkpoint (${data.payload?.fileCount ?? "?"} files)`;
    case "runtime/user_input_auto_resolution":
      return `auto-resolved permission ${data.interactionId ?? ""}`.trim();
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- adapter

export class ZcodeAdapter implements HarnessAdapter {
  readonly id = "zcode" as const;

  constructor(private dbPath: string = DEFAULT_DB_PATH) {}

  async detect(): Promise<StoreInfo | null> {
    if (!existsSync(this.dbPath)) return null;
    let version: string | undefined;
    try {
      const { db, cleanup } = openForRead(this.dbPath);
      try {
        const row = db
          .query(`select app_version from schema_migration order by time_applied desc limit 1`)
          .get() as { app_version: string } | null;
        version = row?.app_version ?? undefined;
      } finally {
        cleanup();
      }
    } catch {
      // best-effort version probe only
    }
    return {
      harness: "zcode",
      paths: [this.dbPath],
      version,
      notes:
        "commercial GLM/Zhipu Electron app (/Applications/ZCode.app); no zcode CLI on PATH — resumeCommand() is unverified",
    };
  }

  async *list(): AsyncIterable<SessionSummary> {
    if (!existsSync(this.dbPath)) return;
    const { db, cleanup } = openForRead(this.dbPath);
    try {
      const sessions = db
        .query(
          `select id, project_id, parent_id, directory, title, title_source, version, task_type, trace_id, time_created, time_updated
           from session order by time_created desc`,
        )
        .all() as SessionRow[];

      // Cheap aggregates: indexed group-bys, no per-row JSON parsing.
      const counts = new Map<string, number>();
      for (const r of db.query(`select session_id, count(*) c from message group by session_id`).all() as {
        session_id: string;
        c: number;
      }[])
        counts.set(r.session_id, r.c);

      const usageRollup = new Map<string, Usage>();
      for (const r of db
        .query(
          `select session_id,
                  sum(input_tokens) i, sum(output_tokens) o, sum(reasoning_tokens) rs,
                  sum(cache_creation_input_tokens) cw, sum(cache_read_input_tokens) cr
           from turn_usage group by session_id`,
        )
        .all() as { session_id: string; i: number; o: number; rs: number; cw: number; cr: number }[]) {
        const total = (r.i ?? 0) + (r.o ?? 0) + (r.rs ?? 0) + (r.cw ?? 0) + (r.cr ?? 0);
        if (total > 0) usageRollup.set(r.session_id, { input: r.i, output: r.o, reasoning: r.rs, cacheWrite: r.cw, cacheRead: r.cr });
      }

      for (const s of sessions) {
        yield {
          harness: "zcode",
          nativeId: s.id,
          nativePath: this.dbPath,
          cwd: s.directory,
          title: s.title,
          createdAt: toIso(s.time_created),
          updatedAt: toIso(s.time_updated),
          messageCount: counts.get(s.id),
          usage: usageRollup.get(s.id),
          parentNativeId: s.parent_id ?? undefined,
          isSubagent: !!s.parent_id,
        };
      }
    } finally {
      cleanup();
    }
  }

  async read(ref: SessionRef): Promise<SifSession> {
    const { db, cleanup } = openForRead(this.dbPath);
    try {
      const session = db.query(`select * from session where id = ?`).get(ref.nativeId) as SessionRow | null;
      if (!session) throw new Error(`zcode: session not found: ${ref.nativeId}`);

      const messages = db
        .query(`select id, session_id, sequence, data from message where session_id = ? order by sequence`)
        .all(session.id) as MessageRow[];

      const allParts = db
        .query(`select id, message_id, session_id, sequence, data from part where session_id = ? order by sequence`)
        .all(session.id) as PartRow[];
      const partsByMessage = new Map<string, { row: PartRow; data: any }[]>();
      for (const p of allParts) {
        let data: any;
        try {
          data = JSON.parse(p.data);
        } catch {
          continue; // skip unparseable part row (lenient parsing)
        }
        const arr = partsByMessage.get(p.message_id) ?? [];
        arr.push({ row: p, data });
        partsByMessage.set(p.message_id, arr);
      }

      const turnUsageRows = db.query(`select * from turn_usage where session_id = ?`).all(session.id) as TurnUsageRow[];
      const turnUsageByTurnId = new Map<string, TurnUsageRow>();
      let sessionUsage: Usage | undefined;
      for (const t of turnUsageRows) {
        turnUsageByTurnId.set(t.turn_id, t);
        const u: Usage = {
          input: t.input_tokens,
          output: t.output_tokens,
          reasoning: t.reasoning_tokens,
          cacheWrite: t.cache_creation_input_tokens,
          cacheRead: t.cache_read_input_tokens,
        };
        const total = (u.input ?? 0) + (u.output ?? 0) + (u.reasoning ?? 0) + (u.cacheWrite ?? 0) + (u.cacheRead ?? 0);
        if (total > 0) sessionUsage = addUsage(sessionUsage, u);
      }

      const entries: SifEntry[] = [];
      const nativeIdToSifId = new Map<string, string>();
      const callIdToName = new Map<string, string>();
      let prevMessageNativeId: string | null = null;

      for (const row of messages) {
        let data: any;
        try {
          data = JSON.parse(row.data);
        } catch {
          prevMessageNativeId = row.id;
          continue; // skip unparseable message row (lenient parsing)
        }

        const msgParts = (partsByMessage.get(row.id) ?? []).sort((a, b) => a.row.sequence - b.row.sequence);
        const nativeParentId: string | null = data.parentID ?? prevMessageNativeId;
        const parentSifId = nativeParentId ? (nativeIdToSifId.get(nativeParentId) ?? null) : null;
        const ts = toIso(data.time?.created ?? row.sequence);
        const origin = { nativeType: `message:${data.role ?? "unknown"}`, nativeId: row.id };
        const raw = { message: data, parts: msgParts.map((p) => p.data) };

        const providerVisibility = data.semantics?.providerVisibility;
        const semanticsKind = data.semantics?.kind;

        const modelChangePart = msgParts.find(
          (p) => p.data.type === "timeline" && p.data.timelineType === "model_change",
        );

        let mainEntry: SifEntry;

        if (modelChangePart) {
          const to = modelChangePart.data.toModel ?? {};
          mainEntry = {
            kind: "modelChange",
            id: mintSifId(),
            parentId: parentSifId,
            ts,
            origin,
            raw,
            provider: to.providerID,
            model: to.modelID ?? "unknown",
          } satisfies ModelChangeEntry;
        } else if (data.role === "user" && semanticsKind === "compact_summary") {
          const compactionPart = msgParts.find((p) => p.data.type === "compaction");
          mainEntry = {
            kind: "compaction",
            id: mintSifId(),
            parentId: parentSifId,
            ts,
            origin,
            raw,
            summary: plainTextFromParts(msgParts),
            replacedHistory: compactionPart?.data,
          } satisfies CompactionEntry;
        } else if (providerVisibility === "hidden") {
          mainEntry = {
            kind: "note",
            id: mintSifId(),
            parentId: parentSifId,
            ts,
            origin,
            raw,
            noteType: semanticsKind ?? `${data.role ?? "unknown"}:hidden`,
            text: plainTextFromParts(msgParts),
          } satisfies NoteEntry;
        } else if (data.role === "user") {
          const content: UserContentPart[] = [];
          for (const p of msgParts) {
            if (p.data.type === "text" && p.data.text) content.push({ type: "text", text: p.data.text });
            else if (p.data.type === "file")
              content.push({ type: "text", text: `[file: ${p.data.mime ?? "unknown"} at ${p.data.url ?? "unknown"}]` });
            else if (p.data.type !== "step-start" && p.data.type !== "step-finish")
              content.push({ type: "text", text: `[unknown zcode part type: ${p.data.type}]` });
          }
          // semantics.origin distinguishes real human input ("real_user")
          // from tooling-injected turns the model still sees (todo/system
          // reminders, background task notifications: "agent_runtime" etc,
          // uiVisibility "hidden" but providerVisibility "visible" — these
          // are real conversational turns, not UI-only markers, so they stay
          // UserEntry rather than becoming NoteEntry; `synthetic` flags them).
          const semanticsOrigin = data.semantics?.origin;
          mainEntry = {
            kind: "user",
            id: mintSifId(),
            parentId: parentSifId,
            ts,
            origin,
            raw,
            content,
            synthetic: semanticsOrigin && semanticsOrigin !== "real_user" ? true : undefined,
          } satisfies UserEntry;
        } else if (data.role === "assistant") {
          const content: AssistantContentPart[] = [];
          const toolParts: typeof msgParts = [];
          for (const p of msgParts) {
            const d = p.data;
            if (d.type === "text") {
              if (d.text) content.push({ type: "text", text: d.text });
            } else if (d.type === "reasoning") {
              if (d.text) content.push({ type: "thinking", thinking: d.text });
            } else if (d.type === "tool") {
              const callId = d.callID;
              const toolName = d.tool ?? callIdToName.get(callId) ?? "unknown";
              callIdToName.set(callId, toolName);
              content.push({ type: "toolCall", callId, name: toolName, args: d.state?.input ?? {}, intent: d.state?.title });
              toolParts.push(p);
            } else if (d.type === "file") {
              content.push({ type: "text", text: `[file: ${d.mime ?? "unknown"} at ${d.url ?? "unknown"}]` });
            } else if (d.type === "step-start" || d.type === "step-finish" || d.type === "compaction") {
              // step markers and compaction (handled via the compact_summary
              // user message above) carry no standalone content
            } else if (d.type === "timeline") {
              content.push({ type: "text", text: `[timeline: ${d.timelineType ?? "event"}]` });
            } else {
              content.push({ type: "text", text: `[unknown zcode part type: ${d.type}]` });
            }
          }
          if (content.length === 0 && data.error) {
            content.push({ type: "text", text: `[error: ${describeError(data.error)}]` });
          }
          const assistantEntry: AssistantEntry = {
            kind: "assistant",
            id: mintSifId(),
            parentId: parentSifId,
            ts,
            origin,
            raw,
            content,
            model: { provider: data.providerID, id: data.modelID },
            usage: usageFromTokens(data.tokens),
            stopReason: mapStopReason(data),
          };
          mainEntry = assistantEntry;

          entries.push(mainEntry);
          nativeIdToSifId.set(row.id, mainEntry.id);
          for (const p of toolParts) {
            const state = p.data.state ?? {};
            const isError = state.status === "error";
            let resultText: string | undefined;
            if (typeof state.output === "string") resultText = state.output;
            else if (state.output !== undefined) resultText = JSON.stringify(state.output);
            else if (state.error) resultText = String(state.error);
            const toolResult: ToolResultEntry = {
              kind: "toolResult",
              id: mintSifId(),
              parentId: mainEntry.id,
              ts: toIso(state.time?.end ?? state.time?.start ?? data.time?.created),
              origin: { nativeType: "part:tool", nativeId: p.row.id },
              raw: p.data,
              callId: p.data.callID,
              toolName: p.data.tool ?? callIdToName.get(p.data.callID) ?? "unknown",
              content: resultText !== undefined ? [{ type: "text", text: resultText }] : [],
              isError,
            };
            entries.push(toolResult);
          }
          prevMessageNativeId = row.id;
          continue;
        } else {
          // unknown role — lenient fallback
          mainEntry = {
            kind: "note",
            id: mintSifId(),
            parentId: parentSifId,
            ts,
            origin,
            raw,
            noteType: `unknown-role:${data.role ?? "?"}`,
            text: plainTextFromParts(msgParts),
          } satisfies NoteEntry;
        }

        entries.push(mainEntry);
        nativeIdToSifId.set(row.id, mainEntry.id);
        prevMessageNativeId = row.id;
      }

      // session_entry rows -> NoteEntry, parented to the turn's user message
      // when a turnId links back to one via turn_usage, else a root note.
      const sessionEntries = db
        .query(`select id, session_id, type, time_created, data from session_entry where session_id = ? order by time_created`)
        .all(session.id) as SessionEntryRow[];
      for (const se of sessionEntries) {
        let data: any;
        try {
          data = JSON.parse(se.data);
        } catch {
          continue;
        }
        let parentSifId: string | null = null;
        const turnId = data.turnId;
        if (turnId) {
          const tu = turnUsageByTurnId.get(turnId);
          if (tu?.user_message_id) parentSifId = nativeIdToSifId.get(tu.user_message_id) ?? null;
        }
        entries.push({
          kind: "note",
          id: mintSifId(),
          parentId: parentSifId,
          ts: toIso(se.time_created),
          origin: { nativeType: `session_entry:${se.type}`, nativeId: se.id },
          raw: data,
          noteType: se.type,
          text: summarizeSessionEntry(se.type, data),
        } satisfies NoteEntry);
      }

      return {
        sif: SIF_VERSION,
        id: mintSifId(),
        origin: { harness: "zcode", nativeId: session.id, nativePath: this.dbPath },
        cwd: session.directory,
        title: { text: session.title, source: mapTitleSource(session.title_source) },
        createdAt: toIso(session.time_created),
        updatedAt: toIso(session.time_updated),
        usage: sessionUsage,
        entries,
      };
    } finally {
      cleanup();
    }
  }

  resumeCommand(ref: SessionRef): string[] {
    // EXPERIMENTAL / UNVERIFIED: there is no zcode CLI on PATH (zcode ships
    // only as /Applications/ZCode.app, an Electron GUI). This is a best
    // guess mirroring the `<binary> --resume <id>` convention used by
    // claude/codex/opencode; it has not been confirmed to work and may not
    // correspond to any real zcode entry point.
    return ["zcode", "--resume", ref.nativeId];
  }
}

export default new ZcodeAdapter();
