import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  CARRY_INLINE_MAX,
  PRESERVE_KEY,
  SIF_VERSION,
  addUsage,
  buildProvenance,
  encodeCarry,
  inertToolText,
  loadCarry,
  mintSifId,
  readProvenance,
  storeCarry,
  toIso,
  validateSession,
  type AssistantContentPart,
  type HarnessAdapter,
  type NativeRef,
  type SessionRef,
  type SessionSummary,
  type SifEntry,
  type SifSession,
  type SinterProvenance,
  type StoreInfo,
  type TextPart,
  type ToolResultEntry,
  type Usage,
  type UserContentPart,
  type WriteOpts,
  type WritePlan,
} from "@sinter/core";

type Rec = Record<string, any>;

interface SessionRow {
  id: string;
  working_directory: string;
  backend_type: string;
  model: string;
  agent_mode: string;
  created_at: number;
  last_activity_at: number;
  title: string | null;
  main_chain_id: number | null;
  workspace_dirs: string | null;
  hidden: number;
  metadata: string | null;
}

interface MessageRow {
  node_id: number;
  parent_node_id: number | null;
  chat_message: string;
  created_at: number;
  metadata: string | null;
}

export interface DevinAdapterOptions {
  dbPath?: string;
  dataDir?: string;
}

export const SINTER_VERSION = "0.1.0";

function defaultDataDir(): string {
  return join(homedir(), ".local", "share", "devin", "cli");
}

function json(value: unknown): Rec | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Rec;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface OpenedDb {
  db: Database;
  copiedDir?: string;
}

function openRead(dbPath: string): OpenedDb | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    db.query("SELECT count(*) AS count FROM sessions").get();
    return { db };
  } catch {
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(tmpdir(), "sinter-devin-"));
      const target = join(dir, basename(dbPath));
      copyFileSync(dbPath, target);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, target + suffix);
      }
      const db = new Database(target, { readonly: true });
      db.query("SELECT count(*) AS count FROM sessions").get();
      return { db, copiedDir: dir };
    } catch {
      if (dir) rmSync(dir, { recursive: true, force: true });
      return null;
    }
  }
}

function closeRead(opened: OpenedDb): void {
  opened.db.close();
  if (opened.copiedDir) rmSync(opened.copiedDir, { recursive: true, force: true });
}

function isoFromMessage(message: Rec | undefined, fallback: number): string | undefined {
  return toIso(str(message?.metadata?.created_at) ?? fallback);
}

function usageFrom(message: Rec): Usage | undefined {
  const metrics = json(message.metadata?.metrics) ?? message.metadata?.metrics;
  if (!metrics || typeof metrics !== "object") return undefined;
  const usage: Usage = {
    input: num(metrics.input_tokens),
    output: num(metrics.output_tokens),
    reasoning: num(metrics.reasoning_tokens),
    cacheRead: num(metrics.cache_read_tokens),
    cacheWrite: num(metrics.cache_creation_tokens),
    costUsd: num(metrics.cost_usd),
  };
  for (const key of Object.keys(usage) as (keyof Usage)[]) if (usage[key] === undefined) delete usage[key];
  return Object.keys(usage).length ? usage : undefined;
}

function contentParts(message: Rec): UserContentPart[] {
  const blocks = message.metadata?.extensions?.["chisel/acp-content-blocks"];
  if (Array.isArray(blocks)) {
    const parts: UserContentPart[] = [];
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.length) {
        parts.push({ type: "text", text: block.text });
      } else if (block?.type === "image" && typeof block.data === "string") {
        parts.push({ type: "image", mimeType: str(block.mimeType) ?? str(block.mime_type) ?? "application/octet-stream", data: block.data });
      }
    }
    if (parts.length) return parts;
  }
  const content = str(message.content);
  return content ? [{ type: "text", text: content }] : [];
}

function stopReason(value: unknown): "stop" | "length" | "toolUse" | "error" | "aborted" | undefined {
  if (value === "length" || value === "max_tokens") return "length";
  if (value === "tool_use" || value === "toolUse") return "toolUse";
  if (value === "error") return "error";
  if (value === "aborted" || value === "cancelled") return "aborted";
  if (typeof value === "string" && value) return "stop";
  return undefined;
}

function provenanceFrom(row: SessionRow): SinterProvenance | undefined {
  return readProvenance(json(row.metadata)?.sinter);
}

function parseRows(row: SessionRow, rows: MessageRow[], dbPath: string): SifSession {
  const callNames = new Map<string, string>();
  for (const native of rows) {
    const message = json(native.chat_message);
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const id = str(call?.id);
      if (id) callNames.set(id, str(call?.name) ?? "unknown");
    }
  }

  const entries: SifEntry[] = [];
  let usage: Usage | undefined;
  for (const native of rows) {
    const message = json(native.chat_message);
    const id = `d${native.node_id}`;
    const parentId = native.parent_node_id === null ? null : `d${native.parent_node_id}`;
    const ts = isoFromMessage(message, native.created_at);
    const raw = { ...native, chat_message: message ?? native.chat_message };
    const origin = { nativeType: str(message?.role) ?? "unknown", nativeId: str(message?.message_id) ?? String(native.node_id) };

    if (!message) {
      entries.push({ kind: "note", id, parentId, ts, noteType: "invalid-json", text: native.chat_message, raw, origin });
      continue;
    }
    if (message.role === "user") {
      const content = contentParts(message);
      if (content.length) entries.push({ kind: "user", id, parentId, ts, content, raw, origin });
      else entries.push({ kind: "note", id, parentId, ts, noteType: "empty-user", raw, origin });
      continue;
    }
    if (message.role === "assistant") {
      const content: AssistantContentPart[] = [];
      const thinking = str(message.thinking?.thinking);
      if (thinking) {
        const signature = message.thinking?.signature;
        content.push({ type: "thinking", thinking, ...(signature ? { signature: typeof signature === "string" ? signature : JSON.stringify(signature) } : {}) });
      }
      const text = str(message.content);
      if (text) content.push({ type: "text", text });
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const callId = str(call?.id) ?? `call-${native.node_id}-${content.length}`;
          content.push({ type: "toolCall", callId, name: str(call?.name) ?? "unknown", args: call?.arguments ?? {} });
        }
      }
      const entryUsage = usageFrom(message);
      usage = addUsage(usage, entryUsage);
      entries.push({
        kind: "assistant",
        id,
        parentId,
        ts,
        content,
        ...(str(message.generation_model) || row.model ? { model: { provider: "devin", id: str(message.generation_model) ?? row.model } } : {}),
        ...(entryUsage ? { usage: entryUsage } : {}),
        ...(stopReason(message.metadata?.finish_reason) ? { stopReason: stopReason(message.metadata?.finish_reason) } : {}),
        raw,
        origin,
      });
      continue;
    }
    if (message.role === "tool") {
      const callId = str(message.tool_call_id) ?? `unknown-${native.node_id}`;
      const text = str(message.content);
      entries.push({
        kind: "toolResult",
        id,
        parentId,
        ts,
        callId,
        toolName: callNames.get(callId) ?? "unknown",
        content: text ? [{ type: "text", text }] : [],
        ...(message.metadata?.extensions?.["chisel/tool_result_meta"]?.success === false ? { isError: true } : {}),
        raw,
        origin,
      });
      continue;
    }
    entries.push({ kind: "note", id, parentId, ts, noteType: str(message.role) ?? "unknown", text: str(message.content), raw, origin });
  }

  let workspaceDirs: string[] | undefined;
  try {
    const parsed = row.workspace_dirs ? JSON.parse(row.workspace_dirs) : undefined;
    if (Array.isArray(parsed)) workspaceDirs = parsed.filter((value): value is string => typeof value === "string");
  } catch {}
  const preserve: Record<string, unknown> = {
    devin: {
      backendType: row.backend_type,
      model: row.model,
      agentMode: row.agent_mode,
      mainChainId: row.main_chain_id,
      workspaceDirs,
    },
  };
  const provenance = provenanceFrom(row);
  if (provenance) preserve[PRESERVE_KEY] = provenance;
  return {
    sif: SIF_VERSION,
    id: mintSifId(),
    origin: { harness: "devin", nativeId: row.id, nativePath: dbPath },
    cwd: row.working_directory,
    ...(workspaceDirs?.length ? { additionalDirs: workspaceDirs } : {}),
    ...(row.title ? { title: { text: row.title, source: "user" } as const } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.last_activity_at),
    ...(usage ? { usage } : {}),
    entries,
    preserve,
  };
}

function resultText(result: ToolResultEntry | undefined): string | undefined {
  if (!result) return undefined;
  const text = result.content.filter((part): part is TextPart => part.type === "text").map((part) => part.text);
  return text.length ? text.join("\n") : undefined;
}

function carrySource(session: SifSession): SifSession {
  const provenance = readProvenance(session.preserve?.[PRESERVE_KEY]);
  if (!provenance || (!provenance.carry && !provenance.carryRef)) return session;
  const { carry: _carry, carryRef: _carryRef, carryBytes: _carryBytes, ...lean } = provenance;
  return { ...session, preserve: { ...session.preserve, [PRESERVE_KEY]: lean } };
}

async function buildWriteProvenance(session: SifSession, nativeId: string, opts?: WriteOpts): Promise<SinterProvenance> {
  const target = { harness: "devin" as const, nativeId };
  const prior = readProvenance(session.preserve?.[PRESERVE_KEY]);
  const tail = prior?.chain[prior.chain.length - 1];
  const record = prior && tail?.harness === "devin" && tail.nativeId !== session.origin.nativeId
    ? prior
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

export interface NativeMessage {
  nodeId: number;
  parentNodeId: number | null;
  createdAt: number;
  message: Rec;
}

export const DEVIN_HISTORY_MAX_BYTES = 200_000;

interface NativeBuild {
  messages: NativeMessage[];
  nodeByEntry: Map<string, number | null>;
}

function nativeMessages(session: SifSession, opts?: WriteOpts): NativeBuild {
  const sameHarness = session.origin.harness === "devin";
  const byResult = new Map<string, ToolResultEntry>();
  for (const entry of session.entries) if (entry.kind === "toolResult") byResult.set(entry.callId, entry);
  const nodeByEntry = new Map<string, number>();
  const parentByDropped = new Map<string, number | null>();
  const out: NativeMessage[] = [];
  const resolveParent = (id: string | null): number | null => {
    let current = id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const node = nodeByEntry.get(current);
      if (node !== undefined) return node;
      if (parentByDropped.has(current)) return parentByDropped.get(current) ?? null;
      const entry = session.entries.find((candidate) => candidate.id === current);
      current = entry?.parentId ?? null;
    }
    return null;
  };
  const push = (entry: SifEntry, role: string, content: string, extra: Rec = {}) => {
    const nodeId = out.length;
    const sourceTime = entry.ts ? Date.parse(entry.ts) : Number.NaN;
    const createdAt = Math.floor((Number.isFinite(sourceTime) ? sourceTime : Date.now()) / 1000);
    const metadata: Rec = { created_at: new Date(createdAt * 1000).toISOString() };
    if (role === "user") metadata.is_user_input = entry.kind === "user" && !entry.synthetic;
    const message = { message_id: crypto.randomUUID(), role, content, ...extra, metadata: { ...metadata, ...(extra.metadata ?? {}) } };
    out.push({ nodeId, parentNodeId: resolveParent(entry.parentId), createdAt, message });
    nodeByEntry.set(entry.id, nodeId);
  };

  for (const entry of session.entries) {
    if (entry.kind === "user") {
      const text = entry.content.map((part) => part.type === "text" ? part.text : `[image: ${part.mimeType}, ${part.data.length} base64 bytes]`).join("\n\n");
      push(entry, entry.synthetic ? "system" : "user", text || "[empty message]");
    } else if (entry.kind === "assistant") {
      const text: string[] = [];
      const calls: Rec[] = [];
      for (const part of entry.content) {
        if (part.type === "text") text.push(part.text);
        else if (part.type === "thinking") continue;
        else if (part.type === "image") text.push(`[image: ${part.mimeType}, ${part.data.length} base64 bytes]`);
        else if (opts?.liveTools) calls.push({ id: part.callId, name: part.name, arguments: part.args, index: calls.length, kind: "function" });
        else text.push(inertToolText(part, resultText(byResult.get(part.callId))).text);
      }
      const thinking = entry.content.find((part) => part.type === "thinking");
      push(entry, "assistant", text.join("\n\n"), {
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(sameHarness && thinking?.type === "thinking" ? { thinking: { thinking: thinking.thinking, signature: thinking.signature } } : {}),
        ...(sameHarness && entry.model?.id ? { generation_model: entry.model.id } : {}),
      });
    } else if (entry.kind === "toolResult") {
      if (opts?.liveTools) push(entry, "tool", resultText(entry) ?? "", { tool_call_id: entry.callId });
      else parentByDropped.set(entry.id, resolveParent(entry.parentId));
    } else if (entry.kind === "compaction") {
      push(entry, "system", entry.summary ?? "[conversation compacted]");
    } else if (entry.kind === "modelChange") {
      push(entry, "system", `[model changed to ${entry.model}]`);
    } else if (entry.kind === "subsession") {
      push(entry, "system", `[subsession${entry.agentName ? ` ${entry.agentName}` : ""}: ${entry.sessionRef}]${entry.resultText ? ` ${entry.resultText}` : ""}`);
    } else {
      push(entry, "system", `[${entry.noteType}]${entry.text ? ` ${entry.text}` : ""}`);
    }
  }
  const activeNodes = new Map<string, number | null>(nodeByEntry);
  for (const [entryId, parentNode] of parentByDropped) activeNodes.set(entryId, parentNode);
  return { messages: out, nodeByEntry: activeNodes };
}

function messageBytes(message: NativeMessage): number {
  return Buffer.byteLength(JSON.stringify(message.message));
}

function clipNativeMessage(message: NativeMessage, maxBytes = 40_000): NativeMessage {
  if (messageBytes(message) <= maxBytes) return message;
  const copy = structuredClone(message);
  delete copy.message.thinking;
  if (Array.isArray(copy.message.tool_calls)) {
    copy.message.tool_calls = copy.message.tool_calls.map((call: Rec) => ({ ...call, arguments: "[arguments omitted by Sinter]" }));
  }
  const content = str(copy.message.content) ?? "";
  const suffix = `\n…[${Math.max(0, Buffer.byteLength(content) - maxBytes)} bytes omitted by Sinter]`;
  copy.message.content = content.slice(0, Math.max(0, maxBytes - suffix.length)) + suffix;
  return copy;
}

export function capNativeHistory(
  messages: NativeMessage[],
  mainChainId: number | null,
  maxBytes = DEVIN_HISTORY_MAX_BYTES,
): { messages: NativeMessage[]; mainChainId: number | null; omitted: number; bytesBefore: number; bytesAfter: number } {
  const byNode = new Map(messages.map((message) => [message.nodeId, message]));
  const active: NativeMessage[] = [];
  const seen = new Set<number>();
  let node = mainChainId === null ? undefined : byNode.get(mainChainId);
  while (node && !seen.has(node.nodeId)) {
    seen.add(node.nodeId);
    active.unshift(node);
    node = node.parentNodeId === null ? undefined : byNode.get(node.parentNodeId);
  }
  const bytesBefore = active.reduce((sum, message) => sum + messageBytes(message), 0);
  if (bytesBefore <= maxBytes) return { messages, mainChainId, omitted: 0, bytesBefore, bytesAfter: bytesBefore };

  const firstUser = active.find((message) => message.message.role === "user");
  const retainedFirst = firstUser ? clipNativeMessage(firstUser) : undefined;
  const reserve = (retainedFirst ? messageBytes(retainedFirst) : 0) + 1_000;
  let remaining = Math.max(40_000, maxBytes - reserve);
  const tail: NativeMessage[] = [];
  for (let i = active.length - 1; i >= 0; i--) {
    const candidate = active[i]!;
    if (candidate === firstUser) continue;
    const clipped = clipNativeMessage(candidate);
    const size = messageBytes(clipped);
    if (size > remaining && tail.length) break;
    tail.unshift(clipped);
    remaining -= Math.min(size, remaining);
    if (remaining <= 0) break;
  }

  const omitted = Math.max(0, active.length - tail.length - (retainedFirst ? 1 : 0));
  const createdAt = retainedFirst?.createdAt ?? tail[0]?.createdAt ?? Math.floor(Date.now() / 1000);
  const note: NativeMessage = {
    nodeId: -1,
    parentNodeId: null,
    createdAt,
    message: {
      message_id: crypto.randomUUID(),
      role: "system",
      content: `[Sinter retained the opening request and recent history; ${omitted} older messages (${bytesBefore} bytes total before trimming) were omitted to fit Devin's inference context. The source session remains unchanged; the transferred SIF is retained through Sinter carry data when it is within the carry limit.]`,
      metadata: { created_at: new Date(createdAt * 1000).toISOString() },
    },
  };
  const selected = [...(retainedFirst ? [retainedFirst] : []), note, ...tail];
  const capped = selected.map((message, index) => ({ ...message, nodeId: index, parentNodeId: index ? index - 1 : null }));
  const bytesAfter = capped.reduce((sum, message) => sum + messageBytes(message), 0);
  return { messages: capped, mainChainId: capped[capped.length - 1]?.nodeId ?? null, omitted, bytesBefore, bytesAfter };
}

interface NativeWritePlan {
  messages: NativeMessage[];
  mainChainId: number | null;
  context?: WritePlan["context"];
}

function planNativeWrite(session: SifSession, opts?: WriteOpts): NativeWritePlan {
  const native = nativeMessages(session, opts);
  let messages = native.messages;
  const devinState = session.origin.harness === "devin" ? json(session.preserve?.devin) : undefined;
  const priorMain = num(devinState?.mainChainId);
  let mainChainId: number | null = priorMain === undefined
    ? messages[messages.length - 1]?.nodeId ?? null
    : native.nodeByEntry.get(`d${priorMain}`) ?? messages[messages.length - 1]?.nodeId ?? null;
  if (session.origin.harness === "devin") return { messages, mainChainId };
  const capped = capNativeHistory(messages, mainChainId);
  messages = capped.messages;
  mainChainId = capped.mainChainId;
  return {
    messages,
    mainChainId,
    context: {
      unit: "bytes",
      limit: DEVIN_HISTORY_MAX_BYTES,
      before: capped.bytesBefore,
      after: capped.bytesAfter,
      omittedEntries: capped.omitted,
      strategy: capped.bytesBefore > DEVIN_HISTORY_MAX_BYTES ? "opening-and-tail" : "none",
    },
  };
}

function columns(db: Database, table: string): Set<string> {
  return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function insertDynamic(db: Database, table: string, available: Set<string>, values: Record<string, unknown>): void {
  const chosen = Object.keys(values).filter((key) => available.has(key));
  db.query(`INSERT INTO ${table} (${chosen.join(", ")}) VALUES (${chosen.map(() => "?").join(", ")})`).run(...chosen.map((key) => values[key] as any));
}

export class DevinAdapter implements HarnessAdapter {
  readonly id = "devin" as const;
  readonly dbPath: string;

  constructor(opts: DevinAdapterOptions = {}) {
    const dataDir = opts.dataDir ?? defaultDataDir();
    this.dbPath = opts.dbPath ?? join(dataDir, "sessions.db");
  }

  async detect(): Promise<StoreInfo | null> {
    if (!existsSync(this.dbPath)) return null;
    const opened = openRead(this.dbPath);
    if (!opened) return null;
    const db = opened.db;
    try {
      const migration = db.query<{ version: number }, []>("SELECT max(version) AS version FROM refinery_schema_history").get();
      return { harness: "devin", paths: [this.dbPath], version: migration?.version ? `schema-${migration.version}` : undefined, notes: "SQLite message tree; local Devin CLI sessions" };
    } catch {
      return { harness: "devin", paths: [this.dbPath], notes: "SQLite message tree; local Devin CLI sessions" };
    } finally {
      closeRead(opened);
    }
  }

  async *list(): AsyncIterable<SessionSummary> {
    const opened = openRead(this.dbPath);
    if (!opened) return;
    const db = opened.db;
    try {
      const rows = db.query<SessionRow & { message_count: number; first_prompt: string | null }, []>(`
        SELECT s.*,
          (SELECT count(*) FROM message_nodes m WHERE m.session_id = s.id) AS message_count,
          (SELECT json_extract(m.chat_message, '$.content') FROM message_nodes m
            WHERE m.session_id = s.id AND json_extract(m.chat_message, '$.role') = 'user'
            ORDER BY m.node_id LIMIT 1) AS first_prompt
        FROM sessions s WHERE s.hidden = 0 ORDER BY s.last_activity_at DESC
      `).all();
      for (const row of rows) {
        yield {
          harness: "devin",
          nativeId: row.id,
          nativePath: this.dbPath,
          cwd: row.working_directory,
          title: row.title ?? undefined,
          firstPrompt: row.first_prompt ?? undefined,
          createdAt: toIso(row.created_at),
          updatedAt: toIso(row.last_activity_at),
          messageCount: row.message_count,
          model: row.model || undefined,
        };
      }
    } finally {
      closeRead(opened);
    }
  }

  async read(ref: SessionRef): Promise<SifSession> {
    const dbPath = ref.nativePath && existsSync(ref.nativePath) ? ref.nativePath : this.dbPath;
    const opened = openRead(dbPath);
    if (!opened) throw new Error(`devin: cannot open session store ${dbPath}`);
    const db = opened.db;
    try {
      const row = db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(ref.nativeId);
      if (!row) throw new Error(`devin: no session ${ref.nativeId}`);
      const rows = db.query<MessageRow, [string]>("SELECT node_id, parent_node_id, chat_message, created_at, metadata FROM message_nodes WHERE session_id = ? ORDER BY node_id").all(ref.nativeId);
      return parseRows(row, rows, dbPath);
    } finally {
      closeRead(opened);
    }
  }

  async readWithCarry(ref: SessionRef): Promise<SifSession> {
    const native = await this.read(ref);
    const carried = await loadCarry(readProvenance(native.preserve?.[PRESERVE_KEY]));
    return carried ?? native;
  }

  async planWrite(session: SifSession, opts?: WriteOpts): Promise<WritePlan> {
    validateSession(session);
    return { context: planNativeWrite(session, opts).context };
  }

  async write(session: SifSession, opts?: WriteOpts): Promise<NativeRef> {
    validateSession(session);
    const nativeId = `sinter-${mintSifId().replace(/-/g, "").slice(-12)}`;
    const provenance = await buildWriteProvenance(session, nativeId, opts);
    if (opts?.dryRun) return { harness: "devin", nativeId, nativePath: this.dbPath, created: [], provenance };
    if (!existsSync(this.dbPath)) throw new Error(`devin: session store not found: ${this.dbPath}`);
    const native = planNativeWrite(session, opts);
    const messages = native.messages;
    const mainChainId = native.mainChainId;
    const devinState = session.origin.harness === "devin" ? json(session.preserve?.devin) : undefined;
    const sourceCreated = session.createdAt ? Date.parse(session.createdAt) : Number.NaN;
    const created = Math.floor((Number.isFinite(sourceCreated) ? sourceCreated : Date.now()) / 1000);
    const updated = Math.max(created, ...messages.map((message) => message.createdAt));
    const db = new Database(this.dbPath);
    try {
      db.run("PRAGMA busy_timeout = 5000");
      const sessionColumns = columns(db, "sessions");
      const messageColumns = columns(db, "message_nodes");
      db.transaction(() => {
        insertDynamic(db, "sessions", sessionColumns, {
          id: nativeId,
          working_directory: opts?.cwd ?? session.cwd,
          backend_type: str(devinState?.backendType) ?? "windsurf",
          model: str(devinState?.model) ?? "",
          agent_mode: str(devinState?.agentMode) ?? "",
          created_at: created,
          last_activity_at: updated,
          title: session.title?.text ?? `Imported ${session.origin.harness} session`,
          main_chain_id: mainChainId,
          shell_last_seen_index: 0,
          cogs_json: null,
          workspace_dirs: JSON.stringify(session.additionalDirs ?? (Array.isArray(devinState?.workspaceDirs) ? devinState.workspaceDirs : [])),
          hidden: 0,
          metadata: JSON.stringify({ sinter: provenance }),
        });
        for (const item of messages) {
          insertDynamic(db, "message_nodes", messageColumns, {
            session_id: nativeId,
            node_id: item.nodeId,
            parent_node_id: item.parentNodeId,
            chat_message: JSON.stringify(item.message),
            created_at: item.createdAt,
            metadata: null,
          });
        }
      })();
    } finally {
      db.close();
    }
    return { harness: "devin", nativeId, nativePath: this.dbPath, created: [this.dbPath], provenance };
  }

  resumeCommand(ref: SessionRef): string[] {
    return ["devin", "--resume", ref.nativeId];
  }
}

const adapter = new DevinAdapter();
export default adapter;
