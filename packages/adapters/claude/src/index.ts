/**
 * Claude Code adapter — reads ~/.claude/projects/<escaped-cwd>/<session>.jsonl.
 *
 * Shape notes (verified against a live 268-file store, CC v2.1.x):
 * - No session-meta header. Metadata is denormalized onto every record
 *   (uuid, parentUuid, sessionId, timestamp, cwd, gitBranch, version, ...).
 * - Records form a TREE via uuid/parentUuid (rewind/fork produce real branches).
 * - Assistant messages are SPLIT one content block per JSONL record, all sharing
 *   the same `message.id` and a duplicated `message.usage`. We keep one SIF
 *   entry per native record (topology fidelity) and attach `usage` only to the
 *   first record of each message.id so rollups don't multiply.
 * - Tool results are `user` records carrying {type:"tool_result"} blocks plus a
 *   structured `toolUseResult` field; they map to ToolResultEntry, not UserEntry.
 * - Control records (no uuid/timestamp): ai-title, custom-title, last-prompt,
 *   mode, permission-mode, agent-setting, agent-name, bridge-session, pr-link,
 *   frame-link, queue-operation, file-history-snapshot/delta. They can't live in
 *   the tree, so they're kept verbatim in `preserve.controlRecords`.
 * - Subagents live in <session-uuid>/subagents/agent-<id>.jsonl with a sibling
 *   agent-<id>.meta.json {agentType, description, toolUseId, spawnDepth} that
 *   links them to the parent's Task tool_use id.
 * - Oversized tool output spills to <session-uuid>/tool-results/<id>.txt and the
 *   inline content becomes a <persisted-output> preview; we record the spill
 *   paths in `preserve.toolResultSpills` rather than inlining megabytes.
 */

import {
  readdirSync,
  existsSync,
  statSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import {
  addUsage,
  buildProvenance,
  CARRY_INLINE_MAX,
  encodeCarry,
  inertToolText,
  loadCarry,
  mintSifId,
  PRESERVE_KEY,
  readJsonl,
  readProvenance,
  storeCarry,
  toIso,
  validateSession,
  type AssistantContentPart,
  type HarnessAdapter,
  type Hop,
  type NativeRef,
  type SessionRef,
  type SessionSummary,
  type SifEntry,
  type SifSession,
  type SinterProvenance,
  type StoreInfo,
  type ToolResultEntry,
  type ToolResultContentPart,
  type Usage,
  type UserContentPart,
  type WriteOpts,
  SIF_VERSION,
} from "@sinter/core";

// ------------------------------------------------------------------ helpers

type Rec = Record<string, any>;

/** CC sometimes stringifies booleans on `system` records ("false"). */
function truthy(v: unknown): boolean {
  return v === true || v === "true";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function clip(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) : s;
}

const STOP_REASON: Record<string, "stop" | "length" | "toolUse" | "error" | "aborted"> = {
  tool_use: "toolUse",
  max_tokens: "length",
  end_turn: "stop",
  stop_sequence: "stop",
  refusal: "error",
};

/** Record types with no uuid — cannot participate in the tree. */
const CONTROL_TYPES = new Set([
  "ai-title",
  "custom-title",
  "last-prompt",
  "mode",
  "permission-mode",
  "agent-setting",
  "agent-name",
  "bridge-session",
  "pr-link",
  "frame-link",
  "queue-operation",
  "file-history-snapshot",
  "file-history-delta",
  "summary",
]);

function mapUsage(u: Rec | undefined): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const out: Usage = {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  const reasoning = num(u.output_tokens_details?.thinking_tokens);
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  if (reasoning !== undefined) out.reasoning = reasoning;
  return Object.keys(out).length ? out : undefined;
}

/** Pull plain text out of any content shape (string | block array). */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (Array.isArray(content)) {
    const parts = content
      .map((b: Rec) => (typeof b === "string" ? b : b?.type === "text" ? b.text : undefined))
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

const SPILL_RE = /Full output saved to:\s*(\S+)/;

// --------------------------------------------------------------- converter

interface ConvertResult {
  entries: SifEntry[];
  cwd?: string;
  gitBranch?: string;
  version?: string;
  title?: string;
  titleSource?: "auto" | "user";
  firstTs?: string;
  lastTs?: string;
  usage?: Usage;
  lastPromptLeafUuid?: string;
  provenance?: SinterProvenance;
  controlRecords: unknown[];
  spills: { callId: string; path: string }[];
  /** native tool_use id -> id of the SIF entry holding that toolCall */
  toolCallEntryId: Map<string, string>;
  /** native tool_use id -> result text, for SubsessionEntry.resultText */
  toolResultText: Map<string, string>;
  unknownTypes: Map<string, number>;
}

/**
 * Convert one JSONL transcript (main session or subagent file) into SIF entries.
 * Parent topology is preserved; records that yield no entry re-parent their
 * children onto the nearest retained ancestor.
 */
async function convertFile(path: string): Promise<ConvertResult> {
  const res: ConvertResult = {
    entries: [],
    controlRecords: [],
    spills: [],
    toolCallEntryId: new Map(),
    toolResultText: new Map(),
    unknownTypes: new Map(),
  };

  const recs: { r: Rec; line: number }[] = [];
  for await (const l of readJsonl(path)) {
    const r = l.value as Rec;
    if (r && typeof r === "object") recs.push({ r, line: l.line });
  }

  // pass 1 — source parent map + control records + session-level metadata
  const srcParent = new Map<string, string | null>();
  for (const { r } of recs) {
    const type = str(r.type);
    const uuid = str(r.uuid);
    if (uuid) {
      // compact_boundary records root themselves but carry logicalParentUuid;
      // prefer it so a compacted thread stays connected. `raw` keeps the truth.
      srcParent.set(uuid, str(r.parentUuid) ?? str(r.logicalParentUuid) ?? null);
      if (!res.cwd) res.cwd = str(r.cwd);
      if (!res.version) res.version = str(r.version);
      const branch = str(r.gitBranch);
      if (branch) res.gitBranch = branch;
      const ts = toIso(str(r.timestamp));
      if (ts) {
        if (!res.firstTs) res.firstTs = ts;
        res.lastTs = ts;
      }
      continue;
    }
    if (type === "sinter_import") res.provenance = readProvenance(r.data) ?? res.provenance;
    if (type === "ai-title") {
      const t = str(r.aiTitle);
      if (t && res.titleSource !== "user") ((res.title = t), (res.titleSource = "auto"));
    } else if (type === "custom-title") {
      const t = str(r.customTitle);
      if (t) ((res.title = t), (res.titleSource = "user"));
    } else if (type === "last-prompt") {
      res.lastPromptLeafUuid = str(r.leafUuid) ?? res.lastPromptLeafUuid;
    }
    if (!res.cwd) res.cwd = str(r.cwd);
    if (type && !CONTROL_TYPES.has(type)) res.unknownTypes.set(type, (res.unknownTypes.get(type) ?? 0) + 1);
    res.controlRecords.push(r);
  }

  // pass 2 — build entries
  /** source uuid -> id of the LAST SIF entry produced for it (children attach here) */
  const tail = new Map<string, string>();
  /** source uuids that produced no entry -> resolved parent id (for re-parenting) */
  const passthrough = new Map<string, string | null>();
  const seenUsageMessages = new Set<string>();

  const resolveParent = (uuid: string | null | undefined): string | null => {
    let cur = uuid ?? null;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const t = tail.get(cur);
      if (t) return t;
      // a dropped record already resolved to its nearest retained ancestor
      if (passthrough.has(cur)) return passthrough.get(cur) ?? null;
      cur = srcParent.get(cur) ?? null;
    }
    return null;
  };

  for (const { r, line } of recs) {
    const uuid = str(r.uuid);
    if (!uuid) continue; // control record, already captured
    const type = str(r.type) ?? "unknown";
    const ts = toIso(str(r.timestamp));
    const parentId = resolveParent(str(r.parentUuid) ?? str(r.logicalParentUuid));
    const produced: SifEntry[] = [];
    let seq = 0;
    const nextId = () => (seq++ === 0 ? uuid : `${uuid}#${seq}`);
    const base = (nativeType: string) => ({
      ts,
      origin: { nativeType, nativeId: uuid },
      raw: r,
    });

    const msg: Rec | undefined = r.message && typeof r.message === "object" ? r.message : undefined;
    const blocks: Rec[] = Array.isArray(msg?.content) ? msg!.content : [];

    if (type === "user") {
      if (truthy(r.isCompactSummary)) {
        produced.push({
          kind: "compaction",
          id: nextId(),
          parentId,
          summary: contentText(msg?.content),
          ...base(type),
        });
      } else if (typeof msg?.content === "string" || blocks.length === 0) {
        const text = contentText(msg?.content);
        if (text !== undefined) {
          produced.push({
            kind: "user",
            id: nextId(),
            parentId,
            content: [{ type: "text", text }],
            ...(truthy(r.isMeta) ? { synthetic: true } : {}),
            ...base(type),
          });
        }
      } else {
        // may mix tool_result blocks with plain user content
        let pending: UserContentPart[] = [];
        const flushUser = () => {
          if (!pending.length) return;
          produced.push({
            kind: "user",
            id: nextId(),
            parentId,
            content: pending,
            ...(truthy(r.isMeta) ? { synthetic: true } : {}),
            ...base(type),
          });
          pending = [];
        };
        for (const b of blocks) {
          if (b?.type === "tool_result") {
            flushUser();
            const callId = str(b.tool_use_id) ?? `unknown-${uuid}-${seq}`;
            const content: ToolResultContentPart[] = [];
            if (typeof b.content === "string") {
              if (b.content.length) content.push({ type: "text", text: b.content });
            } else if (Array.isArray(b.content)) {
              for (const cb of b.content as Rec[]) {
                if (cb?.type === "text" && typeof cb.text === "string" && cb.text.length)
                  content.push({ type: "text", text: cb.text });
                else if (cb?.type === "image" && cb.source?.data)
                  content.push({
                    type: "image",
                    mimeType: str(cb.source.media_type) ?? "application/octet-stream",
                    data: String(cb.source.data),
                  });
              }
            }
            const flat = content
              .map((c) => (c.type === "text" ? c.text : ""))
              .join("\n");
            const spill = SPILL_RE.exec(flat);
            if (spill?.[1]) res.spills.push({ callId, path: spill[1] });
            if (flat) res.toolResultText.set(callId, flat);
            produced.push({
              kind: "toolResult",
              id: nextId(),
              parentId,
              callId,
              toolName: "unknown", // filled in by the callId->name pass below
              content,
              ...(b.is_error === true ? { isError: true } : {}),
              ...base(type),
            });
          } else if (b?.type === "text" && typeof b.text === "string" && b.text.length) {
            pending.push({ type: "text", text: b.text });
          } else if (b?.type === "image" && b.source?.data) {
            pending.push({
              type: "image",
              mimeType: str(b.source.media_type) ?? "application/octet-stream",
              data: String(b.source.data),
            });
          }
        }
        flushUser();
      }
    } else if (type === "assistant") {
      const fallback = blocks.find((b) => b?.type === "fallback");
      if (fallback) {
        produced.push({
          kind: "modelChange",
          id: nextId(),
          parentId,
          provider: "anthropic",
          model: str(fallback.to?.model) ?? str(msg?.model) ?? "unknown",
          ...base(type),
        });
      } else {
        const content: AssistantContentPart[] = [];
        for (const b of blocks) {
          if (b?.type === "text" && typeof b.text === "string" && b.text.length) {
            content.push({ type: "text", text: b.text });
          } else if (b?.type === "thinking") {
            content.push({
              type: "thinking",
              thinking: typeof b.thinking === "string" ? b.thinking : "",
              ...(str(b.signature) ? { signature: str(b.signature)! } : {}),
            });
          } else if (b?.type === "tool_use") {
            const callId = str(b.id) ?? `call-${uuid}-${content.length}`;
            content.push({
              type: "toolCall",
              callId,
              name: str(b.name) ?? "unknown",
              args: (b.input ?? {}) as Record<string, unknown>,
            });
          } else if (b?.type === "image" && b.source?.data) {
            content.push({
              type: "image",
              mimeType: str(b.source.media_type) ?? "application/octet-stream",
              data: String(b.source.data),
            });
          }
        }
        // usage is duplicated on every split record of a message — count once
        const msgId = str(msg?.id);
        let usage: Usage | undefined;
        if (!msgId || !seenUsageMessages.has(msgId)) {
          usage = mapUsage(msg?.usage);
          if (msgId) seenUsageMessages.add(msgId);
          if (usage) res.usage = addUsage(res.usage, usage);
        }
        const stop = str(msg?.stop_reason);
        const id = nextId();
        for (const p of content) if (p.type === "toolCall") res.toolCallEntryId.set(p.callId, id);
        produced.push({
          kind: "assistant",
          id,
          parentId,
          content,
          ...(str(msg?.model) ? { model: { provider: "anthropic", id: str(msg!.model)! } } : {}),
          ...(usage ? { usage } : {}),
          ...(stop ? { stopReason: STOP_REASON[stop] ?? "stop" } : {}),
          ...base(type),
        });
      }
    } else if (type === "attachment") {
      const a: Rec = r.attachment ?? {};
      produced.push({
        kind: "note",
        id: nextId(),
        parentId,
        noteType: `attachment:${str(a.type) ?? "unknown"}`,
        text:
          contentText(a.content) ??
          str(a.stdout) ??
          str(a.hookName) ??
          str(a.filePath) ??
          undefined,
        ...base(type),
      });
    } else if (type === "system") {
      produced.push({
        kind: "note",
        id: nextId(),
        parentId,
        noteType: `system:${str(r.subtype) ?? "unknown"}`,
        text: contentText(r.content),
        ...base(type),
      });
    } else {
      res.unknownTypes.set(type, (res.unknownTypes.get(type) ?? 0) + 1);
      produced.push({
        kind: "note",
        id: nextId(),
        parentId,
        noteType: `unknown:${type}`,
        text: contentText(r.content) ?? contentText(msg?.content),
        ...base(type),
      });
    }

    if (!produced.length) {
      // dropped record: children re-parent onto its nearest retained ancestor
      passthrough.set(uuid, parentId);
      void line;
      continue;
    }
    // chain multi-entry records so nothing is orphaned
    for (let i = 1; i < produced.length; i++) produced[i]!.parentId = produced[i - 1]!.id;
    res.entries.push(...produced);
    tail.set(uuid, produced[produced.length - 1]!.id);
  }

  // pass 3 — tool names live only on the call
  const nameByCall = new Map<string, string>();
  for (const e of res.entries)
    if (e.kind === "assistant")
      for (const p of e.content) if (p.type === "toolCall") nameByCall.set(p.callId, p.name);
  for (const e of res.entries)
    if (e.kind === "toolResult") e.toolName = nameByCall.get(e.callId) ?? "unknown";

  return res;
}
export const SINTER_VERSION = "0.1.0";

export interface ClaudeReadOpts {
  /** Recover carried source entries for an onward sinter port. */
  carry?: boolean;
}

function projectDir(root: string, cwd: string): string {
  return join(root, cwd.replace(/\//g, "-"));
}

function resultText(result: ToolResultEntry | undefined): string | undefined {
  if (!result) return undefined;
  const text = result.content.filter((part) => part.type === "text").map((part) => part.text);
  return text.length ? text.join("\n") : undefined;
}

function carrySource(session: SifSession): SifSession {
  const prov = readProvenance(session.preserve?.[PRESERVE_KEY]);
  if (!prov || (!prov.carry && !prov.carryRef)) return session;
  const { carry: _carry, carryRef: _carryRef, carryBytes: _carryBytes, ...lean } = prov;
  return { ...session, preserve: { ...session.preserve, [PRESERVE_KEY]: lean } };
}

async function resolveProvenance(
  session: SifSession,
  nativeId: string,
  opts?: WriteOpts,
): Promise<SinterProvenance> {
  const target: Hop = { harness: "claude", nativeId };
  const prior = readProvenance(session.preserve?.[PRESERVE_KEY]);
  const tail = prior?.chain[prior.chain.length - 1];
  const targetsThisWrite = !!prior && tail?.harness === "claude" && tail.nativeId !== session.origin.nativeId;
  const record = targetsThisWrite
    ? prior!
    : buildProvenance({
        source: session,
        target,
        sinterVersion: SINTER_VERSION,
        portedAt: new Date().toISOString(),
        mode: opts?.mode,
        inertTools: !opts?.liveTools,
      });
  if (record.carry || record.carryRef) return record;

  const payload = carrySource(session);
  if (!opts?.dryRun) return { ...record, ...(await storeCarry(payload, target)) };
  const encoded = encodeCarry(payload);
  if (!encoded || encoded.length > CARRY_INLINE_MAX) return record;
  return { ...record, carry: encoded, carryBytes: JSON.stringify(payload).length };
}

interface ClaudeTranscript {
  body: string;
  firstPrompt: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

function buildClaudeTranscript(
  session: SifSession,
  nativeId: string,
  targetCwd: string,
  provenance: SinterProvenance,
  liveTools: boolean,
): ClaudeTranscript {
  const byResult = new Map<string, ToolResultEntry>();
  for (const entry of session.entries) if (entry.kind === "toolResult") byResult.set(entry.callId, entry);

  const createdAt = session.createdAt ?? new Date().toISOString();
  let priorMs = Date.parse(createdAt);
  const timestampFor = (entry?: SifEntry): string => {
    const candidate = entry?.ts ? Date.parse(entry.ts) : Number.NaN;
    const ms = Number.isFinite(candidate) ? Math.max(candidate, priorMs + 1) : priorMs + 1;
    priorMs = ms;
    return new Date(ms).toISOString();
  };
  const uuidByEntry = new Map<string, string>();
  const out: string[] = [];
  let firstPrompt = session.title?.text ?? "";
  for (const entry of session.entries) {
    if (entry.kind !== "user" || entry.synthetic) continue;
    const text = entry.content.find((part) => part.type === "text");
    if (text?.type === "text" && text.text) {
      firstPrompt = text.text;
      break;
    }
  }
  const title = (session.title?.text ?? firstPrompt.slice(0, 80)) || `Imported session (${session.origin.harness})`;
  const common = (uuid: string, parentUuid: string | null, timestamp: string) => ({
    uuid,
    parentUuid,
    isSidechain: false,
    cwd: targetCwd,
    sessionId: nativeId,
    timestamp,
    version: "2.1.228",
    ...(session.git?.branch ? { gitBranch: session.git.branch } : {}),
  });

  out.push(JSON.stringify({ type: "sinter_import", sessionId: nativeId, timestamp: createdAt, data: provenance }));
  out.push(JSON.stringify({ type: "custom-title", sessionId: nativeId, customTitle: title }));

  for (const entry of session.entries) {
    const parentUuid = entry.parentId ? uuidByEntry.get(entry.parentId) ?? null : null;
    if (entry.kind === "toolResult" && !liveTools) {
      uuidByEntry.set(entry.id, parentUuid ?? mintSifId());
      continue;
    }
    const uuid = mintSifId();
    uuidByEntry.set(entry.id, uuid);
    const timestamp = timestampFor(entry);

    if (entry.kind === "user") {
      const content = entry.content.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image", source: { media_type: part.mimeType, data: part.data } },
      );
      out.push(
        JSON.stringify({
          ...common(uuid, parentUuid, timestamp),
          type: "user",
          ...(entry.synthetic ? { isMeta: true } : {}),
          message: { role: "user", content },
        }),
      );
      continue;
    }
    if (entry.kind === "assistant") {
      const content: unknown[] = [];
      for (const part of entry.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "thinking") content.push({ type: "thinking", thinking: part.thinking, ...(part.signature ? { signature: part.signature } : {}) });
        else if (part.type === "image") content.push({ type: "image", source: { media_type: part.mimeType, data: part.data } });
        else if (part.type === "toolCall") {
          const result = byResult.get(part.callId);
          if (liveTools) content.push({ type: "tool_use", id: part.callId, name: part.name, input: part.args });
          else content.push(inertToolText(part, resultText(result)));
        }
      }
      out.push(
        JSON.stringify({
          ...common(uuid, parentUuid, timestamp),
          type: "assistant",
          message: {
            id: mintSifId(),
            role: "assistant",
            model: entry.model?.id ?? "unknown",
            content: content.length ? content : [{ type: "text", text: "[empty turn]" }],
            stop_reason: entry.stopReason === "toolUse" ? "tool_use" : entry.stopReason ?? "end_turn",
            ...(entry.usage ? { usage: entry.usage } : {}),
          },
        }),
      );
      continue;
    }
    if (entry.kind === "toolResult") {
      out.push(
        JSON.stringify({
          ...common(uuid, parentUuid, timestamp),
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: entry.callId,
                content: resultText(entry) ?? "",
                ...(entry.isError ? { is_error: true } : {}),
              },
            ],
          },
        }),
      );
      continue;
    }
    if (entry.kind === "compaction") {
      out.push(JSON.stringify({ ...common(uuid, parentUuid, timestamp), type: "user", isCompactSummary: true, message: { role: "user", content: entry.summary ?? "" } }));
      continue;
    }
    if (entry.kind === "modelChange") {
      out.push(JSON.stringify({ ...common(uuid, parentUuid, timestamp), type: "assistant", message: { role: "assistant", model: entry.model, content: [{ type: "fallback", to: { model: entry.model } }] } }));
      continue;
    }
    const text =
      entry.kind === "subsession"
        ? `[subsession${entry.agentName ? " " + entry.agentName : ""} -> ${entry.sessionRef}]${entry.resultText ? ": " + entry.resultText : ""}`
        : `[${entry.noteType}]${entry.text ? " " + entry.text : ""}`;
    out.push(JSON.stringify({ ...common(uuid, parentUuid, timestamp), type: "system", subtype: "sinter", content: text }));
  }

  const leafUuid = uuidByEntry.get(session.entries[session.entries.length - 1]?.id ?? "") ?? null;
  out.push(JSON.stringify({ type: "last-prompt", sessionId: nativeId, leafUuid }));
  return { body: out.join("\n") + "\n", firstPrompt, title, createdAt, updatedAt: new Date(priorMs).toISOString() };
}

function updateIndex(dir: string, nativeId: string, path: string, built: ClaudeTranscript, targetCwd: string, branch?: string): string {
  const indexPath = join(dir, "sessions-index.json");
  let existing: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(indexPath, "utf8"));
    if (parsed && typeof parsed === "object" && "entries" in parsed && Array.isArray(parsed.entries)) existing = parsed.entries;
  } catch {
    // A missing or malformed index is replaced with a valid one; the transcript is authoritative.
  }
  const entry = {
    sessionId: nativeId,
    fullPath: path,
    fileMtime: Date.parse(built.updatedAt),
    firstPrompt: built.firstPrompt || "No prompt",
    summary: built.title,
    messageCount: built.body.split("\n").filter(Boolean).length,
    created: built.createdAt,
    modified: built.updatedAt,
    gitBranch: branch ?? "",
    projectPath: targetCwd,
    isSidechain: false,
  };
  const entries = [...existing.filter((row) => !(row && typeof row === "object" && "sessionId" in row && row.sessionId === nativeId)), entry];
  const tempPath = `${indexPath}.${mintSifId()}.tmp`;
  writeFileSync(tempPath, JSON.stringify({ version: 1, entries }, null, 2) + "\n");
  renameSync(tempPath, indexPath);
  return indexPath;
}

async function writeSession(session: SifSession, opts: WriteOpts | undefined, root: string): Promise<NativeRef> {
  validateSession(session);
  const targetCwd = opts?.cwd ?? session.cwd;
  const nativeId = mintSifId();
  const provenance = await resolveProvenance(session, nativeId, opts);
  const built = buildClaudeTranscript(session, nativeId, targetCwd, provenance, opts?.liveTools === true);
  const dir = projectDir(root, targetCwd);
  const path = join(dir, `${nativeId}.jsonl`);

  if (opts?.dryRun) return { harness: "claude", nativeId, nativePath: path, created: [], provenance };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, built.body);
  const indexPath = updateIndex(dir, nativeId, path, built, targetCwd, session.git?.branch);
  return { harness: "claude", nativeId, nativePath: path, created: [path, indexPath], provenance };
}

async function applyCarry(session: SifSession): Promise<SifSession> {
  const provenance = readProvenance(session.preserve?.[PRESERVE_KEY]);
  if (!provenance) return session;
  const carried = await loadCarry(provenance);
  if (!carried || !carried.entries.length) return session;
  return {
    ...session,
    entries: carried.entries,
    ...(carried.subsessions?.length ? { subsessions: carried.subsessions } : {}),
    preserve: {
      ...session.preserve,
      sinterCarry: { recoveredFrom: carried.origin, entries: carried.entries.length, via: provenance.carryRef ? "sidecar" : "inline" },
    },
  };
}


// ---------------------------------------------------------------- adapter

export interface ClaudeAdapterOptions {
  /** Store root; defaults to ~/.claude/projects. Tests point this at fixtures. */
  root?: string;
}

interface IndexRow {
  sessionId?: string;
  fullPath?: string;
  fileMtime?: number;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = "claude" as const;
  readonly root: string;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.root = opts.root ?? join(homedir(), ".claude", "projects");
  }

  async detect(): Promise<StoreInfo | null> {
    if (!existsSync(this.root)) return null;
    let stat;
    try {
      stat = statSync(this.root);
    } catch {
      return null;
    }
    if (!stat.isDirectory()) return null;
    return {
      harness: "claude",
      paths: [this.root],
      version: this.peekVersion(),
      notes: "JSONL tree transcripts; subagents in <session>/subagents/",
    };
  }

  /** Cheapest possible version sniff: head of one transcript. */
  private peekVersion(): string | undefined {
    for (const dir of this.projectDirs().slice(0, 5)) {
      for (const f of this.sessionFiles(dir).slice(0, 3)) {
        const head = readHead(f.path, 64 * 1024);
        const m = /"version":"([^"]+)"/.exec(head);
        if (m) return m[1];
      }
    }
    return undefined;
  }

  private projectDirs(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const n of names) {
      const p = join(this.root, n);
      try {
        if (statSync(p).isDirectory()) out.push(p);
      } catch {
        /* raced away */
      }
    }
    return out.sort();
  }

  private sessionFiles(dir: string): { id: string; path: string }[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => ({ id: n.slice(0, -".jsonl".length), path: join(dir, n) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private subagentFiles(dir: string, sessionId: string): { agentId: string; path: string }[] {
    const sub = join(dir, sessionId, "subagents");
    if (!existsSync(sub)) return [];
    let names: string[];
    try {
      names = readdirSync(sub);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl"))
      .map((n) => ({ agentId: n.slice("agent-".length, -".jsonl".length), path: join(sub, n) }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  async *list(): AsyncIterable<SessionSummary> {
    for (const dir of this.projectDirs()) {
      const files = this.sessionFiles(dir);
      const byId = new Map(files.map((f) => [f.id, f]));
      const emitted = new Set<string>();

      // 1) native per-project index — the cheap path
      const indexPath = join(dir, "sessions-index.json");
      if (existsSync(indexPath)) {
        let rows: IndexRow[] = [];
        try {
          const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
          if (Array.isArray(parsed?.entries)) rows = parsed.entries;
        } catch {
          rows = [];
        }
        for (const row of rows) {
          const id = str(row.sessionId);
          if (!id || emitted.has(id)) continue;
          emitted.add(id);
          const known = byId.get(id);
          const path = known?.path ?? str(row.fullPath);
          const ghost = !(path && existsSync(path));
          let s: SessionSummary = {
            harness: "claude",
            nativeId: id,
            ...(path ? { nativePath: path } : {}),
            ...(str(row.projectPath) ? { cwd: row.projectPath! } : {}),
            ...(str(row.summary) ? { title: row.summary! } : {}),
            ...(str(row.firstPrompt) ? { firstPrompt: clip(row.firstPrompt!) } : {}),
            ...(toIso(str(row.created)) ? { createdAt: toIso(str(row.created))! } : {}),
            ...(toIso(row.modified ?? row.fileMtime) ? { updatedAt: toIso(row.modified ?? row.fileMtime)! } : {}),
            ...(num(row.messageCount) !== undefined ? { messageCount: row.messageCount } : {}),
            ...(str(row.gitBranch) ? { gitBranch: row.gitBranch! } : {}),
            ...(row.isSidechain ? { isSubagent: true } : {}),
            ...(ghost ? { ghost: true } : {}),
          };
          // The index omits native title records and does not reliably identify
          // top-level Agent Team workers. Augment live rows from bounded windows.
          if (!ghost && path) s = this.summaryFromWindows(id, path, s);
          yield s;
          if (!ghost && known) yield* this.subagentSummaries(dir, id);
        }
      }

      // 2) files the index doesn't know about — bounded head/tail scan only
      for (const f of files) {
        if (emitted.has(f.id)) continue;
        emitted.add(f.id);
        yield this.summaryFromWindows(f.id, f.path);
        yield* this.subagentSummaries(dir, f.id);
      }
    }
  }

  private *subagentSummaries(dir: string, sessionId: string): Generator<SessionSummary> {
    for (const { agentId, path } of this.subagentFiles(dir, sessionId)) {
      const meta = readAgentMeta(path);
      const s = this.summaryFromWindows(`${sessionId}/agent-${agentId}`, path);
      s.isSubagent = true;
      s.parentNativeId = sessionId;
      if (!s.title && typeof meta?.description === "string") s.title = meta.description;
      yield s;
    }
  }

  /** Reads bounded windows at both ends of a transcript — never a full parse. */
  private summaryFromWindows(
    nativeId: string,
    path: string,
    base?: SessionSummary,
  ): SessionSummary {
    const out: SessionSummary = base
      ? { ...base, harness: "claude", nativeId, nativePath: path }
      : { harness: "claude", nativeId, nativePath: path };
    const { head, tail, mtimeMs } = readWindows(path, 32 * 1024);
    let aiTitle: string | undefined;
    let customTitle: string | undefined;
    let agentName: string | undefined;
    let nativeFirstPrompt: string | undefined;
    let teamAgent = false;

    for (const window of tail ? [head, tail] : [head]) {
      for (const line of window.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        let r: Rec;
        try {
          r = JSON.parse(t);
        } catch {
          continue; // a window boundary may split a JSONL record
        }
        if (!out.cwd && str(r.cwd)) out.cwd = r.cwd;
        if (!out.gitBranch && str(r.gitBranch)) out.gitBranch = r.gitBranch;
        if (!out.createdAt && str(r.timestamp)) out.createdAt = toIso(str(r.timestamp));
        if (str(r.aiTitle)) aiTitle = r.aiTitle;
        if (str(r.customTitle)) customTitle = r.customTitle;
        if (str(r.agentName)) {
          agentName = r.agentName;
          // Agent Team subprocesses are top-level files with isSidechain=false;
          // unlike a main team lead, their native message records have agentName.
          if (r.uuid || r.type !== "agent-name") teamAgent = true;
        }
        if (str(r.teamName) && str(r.agentId)) teamAgent = true;
        if (!out.model && str(r.message?.model)) out.model = r.message.model;
        if (!nativeFirstPrompt && r.type === "user" && !r.toolUseResult) {
          const text = contentText(r.message?.content);
          if (text) nativeFirstPrompt = text;
        }
      }
    }

    if (nativeFirstPrompt && !out.firstPrompt) out.firstPrompt = clip(nativeFirstPrompt);
    if (/^\s*<teammate-message(?:\s|>)/.test(nativeFirstPrompt ?? out.firstPrompt ?? "")) teamAgent = true;
    if (teamAgent) out.isSubagent = true;
    // Explicit native titles beat both the index summary and an agent name.
    // Custom titles always win, regardless of which bounded window contained it.
    if (customTitle) out.title = customTitle;
    else if (aiTitle) out.title = aiTitle;
    else if (teamAgent && agentName) out.title = agentName;
    else if (teamAgent && out.title && /^\s*<teammate-message(?:\s|>)/.test(out.title))
      delete out.title;
    if (mtimeMs !== undefined) out.updatedAt = toIso(mtimeMs);
    return out;
  }

  /** projectPath as the index recorded it — a stored cwd, not a de-escaped dir name. */
  private indexProjectPath(dir: string, sessionId: string): string | undefined {
    const indexPath = join(dir, "sessions-index.json");
    if (!existsSync(indexPath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
      const row = (parsed?.entries as IndexRow[] | undefined)?.find((e) => e?.sessionId === sessionId);
      return str(row?.projectPath);
    } catch {
      return undefined;
    }
  }

  /** Locate `<id>.jsonl` (or `<session>/agent-<id>.jsonl`) anywhere in the store. */
  private resolvePath(ref: SessionRef): string | null {
    if (ref.nativePath && existsSync(ref.nativePath)) return ref.nativePath;
    const id = ref.nativeId;
    const slash = id.indexOf("/");
    if (slash > 0) {
      const parent = id.slice(0, slash);
      const agentFile = id.slice(slash + 1);
      for (const dir of this.projectDirs()) {
        const p = join(dir, parent, "subagents", `${agentFile}.jsonl`);
        if (existsSync(p)) return p;
      }
      return null;
    }
    for (const dir of this.projectDirs()) {
      const p = join(dir, `${id}.jsonl`);
      if (existsSync(p)) return p;
    }
    return null;
  }

  async read(ref: SessionRef, opts?: ClaudeReadOpts): Promise<SifSession> {
    const path = this.resolvePath(ref);
    if (!path) throw new Error(`claude: session not found: ${ref.nativeId}`);
    const conv = await convertFile(path);

    const sessionId = basename(path, ".jsonl").replace(/^agent-/, "");
    const isSubagentFile = basename(dirname(path)) === "subagents";
    const nativeId = isSubagentFile
      ? `${basename(dirname(dirname(path)))}/agent-${sessionId}`
      : sessionId;

    const session: SifSession = {
      sif: SIF_VERSION,
      id: mintSifId(),
      origin: { harness: "claude", nativeId, nativePath: path },
      // never invert the escaped dir name; fall back only to the index's
      cwd: conv.cwd ?? this.indexProjectPath(dirname(path), sessionId) ?? "",
      entries: conv.entries,
    };
    if (conv.gitBranch) session.git = { branch: conv.gitBranch };
    if (conv.title) session.title = { text: conv.title, source: conv.titleSource ?? "auto" };
    if (conv.firstTs) session.createdAt = conv.firstTs;
    if (conv.lastTs) session.updatedAt = conv.lastTs;
    if (conv.usage) session.usage = conv.usage;

    const preserve: Record<string, unknown> = {};
    if (conv.lastPromptLeafUuid) preserve.lastPromptLeafUuid = conv.lastPromptLeafUuid;
    if (conv.controlRecords.length) preserve.controlRecords = conv.controlRecords;
    if (conv.spills.length) preserve.toolResultSpills = conv.spills;
    if (conv.version) preserve.claudeVersion = conv.version;

    // --- subagents (only for main-session files) -------------------------
    if (conv.provenance) preserve[PRESERVE_KEY] = conv.provenance;
    if (!isSubagentFile) {
      const dir = dirname(path);
      const subs = this.subagentFiles(dir, sessionId);
      if (subs.length) {
        session.subsessions = [];
        for (const { agentId, path: subPath } of subs) {
          const subConv = await convertFile(subPath);
          const subNativeId = `${sessionId}/agent-${agentId}`;
          const meta = readAgentMeta(subPath);
          const sub: SifSession = {
            sif: SIF_VERSION,
            id: mintSifId(),
            origin: { harness: "claude", nativeId: subNativeId, nativePath: subPath },
            cwd: subConv.cwd ?? session.cwd,
            entries: subConv.entries,
          };
          if (subConv.firstTs) sub.createdAt = subConv.firstTs;
          if (subConv.lastTs) sub.updatedAt = subConv.lastTs;
          if (subConv.usage) sub.usage = subConv.usage;
          if (subConv.gitBranch) sub.git = { branch: subConv.gitBranch };
          if (meta?.description)
            sub.title = { text: String(meta.description), source: "derived" };
          const subPreserve: Record<string, unknown> = { agentId };
          if (meta) subPreserve.agentMeta = meta;
          if (subConv.controlRecords.length) subPreserve.controlRecords = subConv.controlRecords;
          if (subConv.spills.length) subPreserve.toolResultSpills = subConv.spills;
          sub.preserve = subPreserve;
          session.subsessions.push(sub);

          // parent-side linkage: meta.toolUseId points at the Task tool_use
          const toolUseId = str(meta?.toolUseId);
          const anchorId = toolUseId ? conv.toolCallEntryId.get(toolUseId) : undefined;
          const entry: SifEntry = {
            kind: "subsession",
            id: `subsession:${agentId}`,
            parentId: anchorId ?? null,
            sessionRef: subNativeId,
            ...(str(meta?.agentType) ? { agentName: str(meta!.agentType)! } : {}),
            ...(toolUseId && conv.toolResultText.get(toolUseId)
              ? { resultText: conv.toolResultText.get(toolUseId)! }
              : {}),
            origin: { nativeType: "subagent-file", nativeId: subNativeId },
            raw: meta ?? { agentId },
            ...(sub.createdAt ? { ts: sub.createdAt } : {}),
          };
          const at = anchorId ? session.entries.findIndex((e) => e.id === anchorId) : -1;
          if (at >= 0) session.entries.splice(at + 1, 0, entry);
          else session.entries.push(entry);
        }
      }
    }

    if (Object.keys(preserve).length) session.preserve = preserve;
    return opts?.carry ? applyCarry(session) : session;
  }


  readWithCarry(ref: SessionRef): Promise<SifSession> {
    return this.read(ref, { carry: true });
  }

  write(session: SifSession, opts?: WriteOpts): Promise<NativeRef> {
    return writeSession(session, opts, this.root);
  }
  resumeCommand(ref: SessionRef): string[] {
    const id = ref.nativeId.includes("/") ? ref.nativeId.split("/")[0]! : ref.nativeId;
    return ["claude", "--resume", id];
  }
}

// ------------------------------------------------------------------- utils

/** True partial read — session transcripts reach tens of MB. */
function readHead(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function readWindows(
  path: string,
  bytes: number,
): { head: string; tail: string; mtimeMs?: number } {
  let fd: number | undefined;
  try {
    const st = statSync(path);
    fd = openSync(path, "r");
    const headSize = Math.min(bytes, st.size);
    const headBuffer = Buffer.alloc(headSize);
    const headBytes = readSync(fd, headBuffer, 0, headSize, 0);
    let tail = "";
    if (st.size > bytes) {
      const tailSize = Math.min(bytes, st.size);
      const tailBuffer = Buffer.alloc(tailSize);
      const tailBytes = readSync(fd, tailBuffer, 0, tailSize, st.size - tailSize);
      tail = tailBuffer.subarray(0, tailBytes).toString("utf8");
    }
    return {
      head: headBuffer.subarray(0, headBytes).toString("utf8"),
      tail,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return { head: "", tail: "" };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function readAgentMeta(jsonlPath: string): Rec | undefined {
  const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(metaPath)) return undefined;
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return undefined;
  }
}

export default new ClaudeAdapter();
