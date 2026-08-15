/**
 * omp/pi session reader. Dialect-tolerant: accepts both shapes of every
 * divergent record (see DIALECTS.md), so pi files parse under this reader
 * unchanged.
 *
 * Strictly read-only (CONVENTIONS §1). Lenient (§2): unparseable lines are
 * skipped, unknown record types become NoteEntry + `raw`.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { PRESERVE_KEY, loadCarry, provenanceOf, readProvenance } from "@sinter/core/lineage";
import type {
  AssistantContentPart,
  AssistantEntry,
  ImagePart,
  SifEntry,
  SifSession,
  SifTitle,
  TextPart,
  ToolResultContentPart,
  Usage,
  UserContentPart,
} from "@sinter/core/sif";
import { SIF_VERSION } from "@sinter/core/sif";
import { addUsage, mintSifId, toIso } from "@sinter/core/util";
import { type Dialect, parseModelChange } from "./dialect";
import {
  type NativeCompactionEntry,
  type NativeCustomMessageEntry,
  type NativeEntry,
  type NativeHeader,
  type NativeMessage,
  type NativeMessageEntry,
  type NativeModelChangeEntry,
  type NativePart,
  type NativeSessionInitEntry,
  type NativeUsage,
  isEntry,
  isHeader,
} from "./native";
import { sidecarDirFor } from "./paths";
import { type TitleSlot, peelTitleSlot } from "./title-slot";

const ARTIFACT_REF = /artifact:\/\/([A-Za-z0-9._\-/]+)/g;
const MAX_INLINED_ARTIFACT_BYTES = 32 * 1024;

export interface ReadOptions {
  dialect: Dialect;
  /** Blob store directory for resolving `blob:sha256:` image refs. */
  blobsDir?: string;
  /** Load `<session>/<Agent>.jsonl` sidecars into `subsessions`. Default true when the dialect has sidecars. */
  loadSubsessions?: boolean;
  /** Inline small `artifact://` spill logs into tool-result text. Default true. */
  resolveArtifacts?: boolean;
  /** Drop `raw` to shrink the result (the `--slim` path). */
  slim?: boolean;
  /**
   * Carry-forward: return the ORIGINAL source entries the port stashed in its
   * provenance record instead of the inert, flattened ones actually stored.
   *
   * Default FALSE — `read()` must reflect what is really in the store, and a
   * caller that resumes this session in omp/pi will see the flattened text, not
   * the original. Porting ONWARD is what wants the carried entries: re-parsing
   * the harness's own `[historical tool call: …]` output and flattening it a
   * second time nests the markers and degrades the transcript on every hop.
   * See `readWithCarry`.
   */
  useCarry?: boolean;
  host?: string;
}

// ------------------------------------------------------------------ parsing

export interface ParsedFile {
  header?: NativeHeader;
  slot?: TitleSlot;
  slotBytes?: number;
  entries: NativeEntry[];
  /** Lines that failed to parse or were neither header/slot/entry. */
  skippedLines: number;
}

/** Lenient parse of a full session body (slot already peeled or not). */
export function parseSessionContent(content: string): ParsedFile {
  const peeled = peelTitleSlot(content);
  const out: ParsedFile = { slot: peeled.slot, slotBytes: peeled.slotBytes, entries: [], skippedLines: 0 };
  for (const rawLine of peeled.body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      out.skippedLines++;
      continue;
    }
    if (!out.header && isHeader(value)) {
      out.header = value;
      continue;
    }
    if (isEntry(value)) {
      out.entries.push(value);
      continue;
    }
    out.skippedLines++;
  }
  // The slot WINS over header.title, and an empty slot title deletes it
  // (session-loader.ts:foldTitleSlot).
  if (out.header && out.slot) {
    if (out.slot.title) {
      out.header.title = out.slot.title;
      if (out.slot.source) out.header.titleSource = out.slot.source;
    } else {
      delete out.header.title;
      delete out.header.titleSource;
    }
  }
  return out;
}

export async function parseSessionFile(path: string): Promise<ParsedFile> {
  return parseSessionContent(await Bun.file(path).text());
}

// ------------------------------------------------------------------ content

function textOf(content: string | NativePart[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && (p as { type?: string }).type === "text")
    .map((p) => String((p as { text?: unknown }).text ?? ""))
    .join("");
}

async function resolveBlob(data: string, blobsDir: string | undefined): Promise<{ data: string; mimeType?: string } | null> {
  const hash = data.startsWith("blob:sha256:") ? data.slice("blob:sha256:".length) : null;
  if (!hash || !/^[a-f0-9]{64}$/.test(hash) || !blobsDir) return null;
  try {
    const buf = Buffer.from(await Bun.file(join(blobsDir, hash)).arrayBuffer());
    // Blobs hold either raw bytes or (for provider transport URLs) a utf8 data: URL.
    const head = buf.subarray(0, 32).toString("utf8");
    if (head.startsWith("data:")) {
      const s = buf.toString("utf8");
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(s);
      if (m) return { data: m[2]!, mimeType: m[1] };
      return null;
    }
    return { data: buf.toString("base64") };
  } catch {
    return null;
  }
}

function normalizeImageData(data: string): { data: string; mimeType?: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(data);
  if (m) return { data: m[2]!, mimeType: m[1] };
  return { data };
}

async function toImagePart(p: NativePart, blobsDir: string | undefined): Promise<ImagePart> {
  const raw = String((p as { data?: unknown }).data ?? "");
  const declaredMime = (p as { mimeType?: string }).mimeType;
  const resolved = await resolveBlob(raw, blobsDir);
  if (resolved) {
    return { type: "image", mimeType: resolved.mimeType ?? declaredMime ?? "image/png", data: resolved.data };
  }
  if (raw.startsWith("blob:sha256:")) {
    // Dangling ref: keep it visible rather than silently dropping (CONVENTIONS §4).
    return { type: "image", mimeType: declaredMime ?? "application/octet-stream", data: "" };
  }
  const norm = normalizeImageData(raw);
  return { type: "image", mimeType: norm.mimeType ?? declaredMime ?? "image/png", data: norm.data };
}

async function userParts(content: string | NativePart[] | undefined, blobsDir?: string): Promise<UserContentPart[]> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: UserContentPart[] = [];
  for (const p of content) {
    const t = (p as { type?: string })?.type;
    if (t === "text") {
      const text = String((p as { text?: unknown }).text ?? "");
      if (text) out.push({ type: "text", text });
    } else if (t === "image") {
      out.push(await toImagePart(p, blobsDir));
    }
  }
  return out;
}

async function assistantParts(
  content: string | NativePart[] | undefined,
  blobsDir: string | undefined,
  callNames: Map<string, string>,
): Promise<AssistantContentPart[]> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: AssistantContentPart[] = [];
  for (const p of content) {
    const t = (p as { type?: string })?.type;
    if (t === "text") {
      const text = String((p as { text?: unknown }).text ?? "");
      // Empty text parts are dropped: they carry nothing and break Claude Code
      // resume downstream (validateSession rejects them). `raw` keeps them.
      if (text) out.push({ type: "text", text });
    } else if (t === "thinking") {
      const thinking = String((p as { thinking?: unknown }).thinking ?? "");
      const sig = (p as { thinkingSignature?: unknown }).thinkingSignature;
      out.push({
        type: "thinking",
        thinking,
        ...(typeof sig === "string" && sig ? { signature: sig } : {}),
      });
    } else if (t === "image") {
      out.push(await toImagePart(p, blobsDir));
    } else if (t === "toolCall") {
      const id = String((p as { id?: unknown }).id ?? "");
      const name = String((p as { name?: unknown }).name ?? "unknown");
      const args = (p as { arguments?: unknown }).arguments;
      const intent = (p as { intent?: unknown }).intent;
      if (id) callNames.set(id, name);
      out.push({
        type: "toolCall",
        callId: id || `call_${out.length}`,
        name,
        args: (args ?? {}) as Record<string, unknown> | string,
        ...(typeof intent === "string" && intent ? { intent } : {}),
      });
    }
  }
  return out;
}

/** omp: `usage.reasoningTokens` · pi: `usage.reasoning`. Never zero-fill (CONVENTIONS §4). */
export function mapUsage(u: NativeUsage | undefined): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const usage: Usage = {};
  const put = (k: keyof Usage, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) usage[k] = v;
  };
  put("input", u.input);
  put("output", u.output);
  put("cacheRead", u.cacheRead);
  put("cacheWrite", u.cacheWrite);
  put("reasoning", u.reasoningTokens ?? u.reasoning);
  // cost.total is 0 for non-billing providers — omit rather than record a fake zero.
  if (typeof u.cost?.total === "number" && u.cost.total > 0) usage.costUsd = u.cost.total;
  return Object.keys(usage).length ? usage : undefined;
}

const STOP_REASONS: Record<string, AssistantEntry["stopReason"]> = {
  stop: "stop",
  endTurn: "stop",
  end_turn: "stop",
  length: "length",
  maxTokens: "length",
  max_tokens: "length",
  toolUse: "toolUse",
  tool_use: "toolUse",
  error: "error",
  aborted: "aborted",
  cancelled: "aborted",
};

function mapStopReason(s: unknown): AssistantEntry["stopReason"] | undefined {
  return typeof s === "string" ? STOP_REASONS[s] : undefined;
}

// ------------------------------------------------------------------ artifacts

async function inlineArtifacts(text: string, sidecarDir: string | undefined): Promise<string> {
  ARTIFACT_REF.lastIndex = 0;
  if (!ARTIFACT_REF.test(text)) return text;
  ARTIFACT_REF.lastIndex = 0;
  const refs = new Set<string>();
  for (const m of text.matchAll(ARTIFACT_REF)) refs.add(m[1]!);
  let out = text;
  for (const ref of refs) {
    if (ref.includes("..")) continue; // never escape the sidecar dir
    let body: string | null = null;
    if (sidecarDir) {
      for (const candidate of [join(sidecarDir, ref), join(sidecarDir, `${ref}.log`)]) {
        try {
          const f = Bun.file(candidate);
          if (await f.exists()) {
            const size = f.size;
            body =
              size > MAX_INLINED_ARTIFACT_BYTES
                ? `${(await f.text()).slice(0, MAX_INLINED_ARTIFACT_BYTES)}\n…[artifact truncated: ${size} bytes]`
                : await f.text();
            break;
          }
        } catch {
          /* fall through to the dangling annotation */
        }
      }
    }
    out +=
      body === null
        ? `\n\n[sinter: dangling artifact ref artifact://${ref} — spill log not found]`
        : `\n\n[sinter: inlined artifact://${ref}]\n${body}`;
  }
  return out;
}

// ------------------------------------------------------------------ tree

/**
 * omp's `resolveParent` pattern (CONVENTIONS §6): when a source record is
 * dropped, its children re-parent to the nearest RETAINED ancestor rather than
 * flattening the branch.
 */
function makeParentResolver(entries: NativeEntry[]) {
  const nativeParent = new Map<string, string | null>();
  for (const e of entries) nativeParent.set(e.id, e.parentId ?? null);
  const retained = new Set<string>();
  return {
    retain: (id: string) => retained.add(id),
    resolve(parentId: string | null | undefined): string | null {
      let cur = parentId ?? null;
      const seen = new Set<string>();
      while (cur !== null) {
        if (seen.has(cur)) return null; // cycle guard
        seen.add(cur);
        if (retained.has(cur)) return cur;
        if (!nativeParent.has(cur)) return null; // dangling
        cur = nativeParent.get(cur) ?? null;
      }
      return null;
    },
  };
}

// ------------------------------------------------------------------ session

export interface SubsessionLink {
  /** Sidecar basename == the omp job id. */
  agentName: string;
  session: SifSession;
}

export interface ReadResult {
  session: SifSession;
  parsed: ParsedFile;
  /** True when `useCarry` actually recovered the source entries. */
  carried?: boolean;
}

export async function readSessionFile(path: string, opts: ReadOptions): Promise<SifSession> {
  return (await readSessionFileDetailed(path, opts)).session;
}

/**
 * Read a ported session with carry-forward: the entries come from the ORIGINAL
 * SIF the port stashed, the identity (origin, cwd, title, provenance) from the
 * store on disk. That is exactly what a further port needs — it extends the
 * chain from this hop while re-flattening the source's real tool calls instead
 * of this store's already-inert text.
 *
 * Falls back to the native (flattened) view whenever there is no recoverable
 * payload — a missing, corrupt, or sidecar-deleted carry is never an error.
 */
export async function readWithCarry(path: string, opts: ReadOptions): Promise<SifSession>;
/**
 * Adapter form: `readWithCarry(ompAdapter, ref)`. Structurally typed so the
 * reader stays free of an import cycle with `adapter.ts`.
 */
export async function readWithCarry(adapter: CarryReadable, ref: CarrySessionRef): Promise<SifSession>;
export async function readWithCarry(
  target: string | CarryReadable,
  arg: ReadOptions | CarrySessionRef,
): Promise<SifSession> {
  if (typeof target === "string") {
    return (await readSessionFileDetailed(target, { ...(arg as ReadOptions), useCarry: true })).session;
  }
  return target.read(arg as CarrySessionRef, { useCarry: true });
}

/** The slice of `SessionRef` this module needs, kept local to avoid a cycle. */
export interface CarrySessionRef {
  nativeId: string;
  nativePath?: string;
}

export interface CarryReadable {
  read(ref: CarrySessionRef, opts?: Partial<ReadOptions>): Promise<SifSession>;
}

export async function readSessionFileDetailed(path: string, opts: ReadOptions): Promise<ReadResult> {
  const parsed = await parseSessionFile(path);
  const loadSubs = opts.loadSubsessions ?? opts.dialect.hasSidecar;
  const subsessions: SubsessionLink[] = loadSubs ? await loadSidecarSubsessions(path, opts) : [];
  const session = await buildSession(parsed, path, opts, subsessions);
  if (!opts.useCarry) return { session, parsed };
  const recovered = await recoverCarry(session, parsed);
  return { session: recovered.session, parsed, carried: recovered.carried };
}

/** The `sinter_import` marker this file was written with, if any. */
function importMarkerIndex(entries: NativeEntry[]): number {
  return entries.findIndex(
    (e) => e.type === "custom" && String((e as { customType?: unknown }).customType ?? "") === "sinter_import",
  );
}

/**
 * Entries the user added in THIS harness after the import — i.e. everything
 * outside the window of records the port itself emitted. Without the window
 * (an older marker that has no `portedEntries`) we cannot tell them apart, so
 * nothing is treated as appended.
 */
function entriesAfterPort(session: SifSession, parsed: ParsedFile): SifEntry[] {
  const idx = importMarkerIndex(parsed.entries);
  if (idx < 0) return [];
  const data = (parsed.entries[idx] as { data?: unknown }).data as { portedEntries?: unknown } | undefined;
  const ported = data?.portedEntries;
  if (typeof ported !== "number" || !Number.isFinite(ported) || ported < 0) return [];
  const portedIds = new Set(parsed.entries.slice(0, idx + 1 + ported).map((e) => e.id));
  // Subsession links are synthesized by the reader, not native records; the
  // carried SIF brings its own.
  return session.entries.filter((e) => e.kind !== "subsession" && !portedIds.has(e.id));
}

async function recoverCarry(session: SifSession, parsed: ParsedFile): Promise<{ session: SifSession; carried: boolean }> {
  const carried = await loadCarry(provenanceOf(session));
  if (!carried?.entries?.length) return { session, carried: false };

  const ids = new Set(carried.entries.map((e) => e.id));
  const tail = carried.entries[carried.entries.length - 1]!.id;
  const appended = entriesAfterPort(session, parsed)
    .filter((e) => !ids.has(e.id))
    // Their parents were the flattened records that carry-forward just
    // replaced; re-anchor them to the end of the recovered transcript.
    .map((e) => (e.parentId !== null && !ids.has(e.parentId) ? { ...e, parentId: tail } : e));

  return {
    session: {
      ...session,
      entries: [...carried.entries, ...appended],
      ...(carried.subsessions?.length ? { subsessions: carried.subsessions } : {}),
      ...(carried.usage ? { usage: carried.usage } : {}),
    },
    carried: true,
  };
}

async function loadSidecarSubsessions(path: string, opts: ReadOptions): Promise<SubsessionLink[]> {
  const dir = sidecarDirFor(path);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SubsessionLink[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const child = join(dir, name);
    try {
      const parsed = await parseSessionFile(child);
      // Never recurse into a nested sidecar: subagents don't spawn sidecar dirs.
      const session = await buildSession(parsed, child, { ...opts, loadSubsessions: false }, []);
      out.push({ agentName: basename(name, ".jsonl"), session });
    } catch {
      /* a damaged sidecar must not fail the parent read */
    }
  }
  return out;
}

/** Where a subagent's link entry belongs: the async-result that delivered it. */
function findSubsessionAnchor(entries: NativeEntry[], agentName: string): string | null {
  for (const e of entries) {
    if (e.type !== "custom_message") continue;
    const cm = e as NativeCustomMessageEntry;
    if (cm.customType !== "async-result") continue;
    const jobs = (cm.details as { jobs?: { jobId?: string }[] } | undefined)?.jobs;
    if (Array.isArray(jobs) && jobs.some((j) => j?.jobId === agentName)) return e.id;
    if (typeof cm.content === "string" && cm.content.includes(`id="${agentName}"`)) return e.id;
  }
  // Fall back to the `task` toolResult that spawned the job.
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = (e as NativeMessageEntry).message;
    if (m?.role === "toolResult" && m.toolName === "task" && textOf(m.content).includes(agentName)) return e.id;
  }
  return null;
}

async function buildSession(
  parsed: ParsedFile,
  path: string,
  opts: ReadOptions,
  subsessions: SubsessionLink[],
): Promise<SifSession> {
  const { dialect } = opts;
  const header = parsed.header;
  const nativeId = header?.id ?? path;
  const sidecarDir = dialect.hasSidecar ? sidecarDirFor(path) : undefined;
  const resolveArtifacts = opts.resolveArtifacts ?? true;

  const entries: SifEntry[] = [];
  const callNames = new Map<string, string>();
  const parents = makeParentResolver(parsed.entries);
  let rollup: Usage | undefined;
  let firstUserText: string | undefined;
  let piSessionName: string | undefined;
  let sessionInit: NativeSessionInitEntry | undefined;
  let lastTs: string | undefined;

  const push = (e: SifEntry, native: NativeEntry) => {
    if (!opts.slim) e.raw = native;
    entries.push(e);
    parents.retain(native.id);
    if (native.timestamp) lastTs = native.timestamp;
  };

  for (const native of parsed.entries) {
    const base = {
      id: native.id,
      parentId: parents.resolve(native.parentId),
      ts: toIso(native.timestamp),
      origin: { nativeType: native.type, nativeId: native.id },
    };

    switch (native.type) {
      case "message": {
        const m: NativeMessage = (native as NativeMessageEntry).message ?? ({} as NativeMessage);
        if (m.role === "user") {
          const content = await userParts(m.content, opts.blobsDir);
          if (firstUserText === undefined) firstUserText = textOf(m.content).trim() || undefined;
          push({ ...base, kind: "user", content }, native);
        } else if (m.role === "assistant") {
          const usage = mapUsage(m.usage);
          rollup = addUsage(rollup, usage);
          const entry: AssistantEntry = {
            ...base,
            kind: "assistant",
            content: await assistantParts(m.content, opts.blobsDir, callNames),
          };
          if (m.provider || m.model) entry.model = { provider: m.provider, id: m.model };
          if (usage) entry.usage = usage;
          const stop = mapStopReason(m.stopReason);
          if (stop) entry.stopReason = stop;
          push(entry, native);
        } else if (m.role === "toolResult") {
          const callId = String(m.toolCallId ?? "");
          // Tool name lives on the call; fall back to the record, then "unknown" (§5).
          const toolName = callNames.get(callId) ?? (typeof m.toolName === "string" ? m.toolName : "unknown");
          let content: ToolResultContentPart[] = [];
          if (typeof m.content === "string") {
            const t = resolveArtifacts ? await inlineArtifacts(m.content, sidecarDir) : m.content;
            if (t) content = [{ type: "text", text: t }];
          } else if (Array.isArray(m.content)) {
            for (const p of m.content) {
              const pt = (p as { type?: string })?.type;
              if (pt === "text") {
                const raw = String((p as { text?: unknown }).text ?? "");
                const t = resolveArtifacts ? await inlineArtifacts(raw, sidecarDir) : raw;
                if (t) content.push({ type: "text", text: t });
              } else if (pt === "image") {
                content.push(await toImagePart(p, opts.blobsDir));
              }
            }
          }
          push(
            {
              ...base,
              kind: "toolResult",
              callId: callId || `orphan_${native.id}`,
              toolName,
              content,
              ...(m.isError ? { isError: true } : {}),
            },
            native,
          );
        } else {
          // bashExecution / pythonExecution / custom / fileMention → keep as a note.
          push(
            { ...base, kind: "note", noteType: `message:${String(m.role ?? "unknown")}`, text: textOf(m.content) || undefined },
            native,
          );
        }
        break;
      }

      case "model_change": {
        const mc = parseModelChange(native as NativeModelChangeEntry);
        push({ ...base, kind: "modelChange", provider: mc.provider, model: mc.model }, native);
        break;
      }

      case "compaction": {
        const c = native as NativeCompactionEntry;
        push({ ...base, kind: "compaction", summary: typeof c.summary === "string" ? c.summary : undefined }, native);
        break;
      }

      case "custom_message": {
        // Participates in LLM context (unlike `custom`) → a synthetic user turn.
        const cm = native as NativeCustomMessageEntry;
        const content = await userParts(cm.content, opts.blobsDir);
        push({ ...base, kind: "user", content, synthetic: true }, native);
        break;
      }

      case "custom": {
        const customType = String((native as { customType?: unknown }).customType ?? "unknown");
        push({ ...base, kind: "note", noteType: `custom:${customType}` }, native);
        break;
      }

      case "session_init": {
        sessionInit = native as NativeSessionInitEntry;
        push(
          { ...base, kind: "note", noteType: "session_init", text: sessionInit.task || undefined },
          native,
        );
        break;
      }

      case "session_info": {
        const name = (native as { name?: unknown }).name;
        if (typeof name === "string" && name) piSessionName = name;
        push({ ...base, kind: "note", noteType: "session_info", text: piSessionName }, native);
        break;
      }

      default: {
        const text =
          typeof (native as { title?: unknown }).title === "string"
            ? String((native as { title?: unknown }).title)
            : undefined;
        push({ ...base, kind: "note", noteType: native.type, text }, native);
      }
    }
  }

  // ---- subsession link entries -------------------------------------------
  const subs: SifSession[] = [];
  for (const { agentName, session: child } of subsessions) {
    subs.push(child);
    const anchor = findSubsessionAnchor(parsed.entries, agentName);
    const anchorIdx = anchor ? entries.findIndex((e) => e.id === anchor) : -1;
    const link: SifEntry = {
      id: `sinter-sub-${agentName}`,
      parentId: anchor ?? entries[entries.length - 1]?.id ?? null,
      ts: child.createdAt,
      kind: "subsession",
      sessionRef: child.origin.nativeId,
      agentName,
      resultText: child.title?.text,
      origin: { nativeType: "sidecar-jsonl", nativeId: child.origin.nativeId },
    };
    if (anchorIdx >= 0) entries.splice(anchorIdx + 1, 0, link);
    else entries.push(link);
  }

  // ---- title --------------------------------------------------------------
  let title: SifTitle | undefined;
  if (dialect.headerCarriesTitle && header?.title) {
    title = { text: header.title, source: header.titleSource === "user" ? "user" : "auto" };
  } else if (piSessionName) {
    title = { text: piSessionName, source: "user" };
  } else if (sessionInit?.agent) {
    title = { text: `${sessionInit.agent}: ${(sessionInit.task ?? "").slice(0, 80)}`.trim(), source: "derived" };
  } else if (firstUserText) {
    title = { text: firstUserText.slice(0, 120), source: "derived" };
  }

  let updatedAt = toIso(lastTs) ?? toIso(header?.timestamp);
  try {
    updatedAt = (await stat(path)).mtime.toISOString();
  } catch {
    /* keep the entry-derived timestamp */
  }

  const session: SifSession = {
    sif: SIF_VERSION,
    id: mintSifId(),
    origin: {
      harness: dialect.harness,
      nativeId,
      nativePath: path,
      ...(opts.host ? { host: opts.host } : {}),
    },
    cwd: header?.cwd ?? "",
    ...(header?.additionalDirectories?.length ? { additionalDirs: header.additionalDirectories } : {}),
    ...(title ? { title } : {}),
    ...(toIso(header?.timestamp) ? { createdAt: toIso(header?.timestamp) } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(rollup ? { usage: rollup } : {}),
    entries,
    ...(subs.length ? { subsessions: subs } : {}),
  };

  const preserve: Record<string, unknown> = {};
  if (parsed.slot) preserve.ompTitleSlot = parsed.slot;
  if (header?.parentSession) preserve.parentSession = header.parentSession;
  if (sessionInit) {
    preserve.sessionInit = {
      agent: sessionInit.agent,
      modelRole: sessionInit.modelRole,
      resolvedModel: sessionInit.resolvedModel,
      tools: sessionInit.tools,
    };
  }
  if (parsed.skippedLines) preserve.skippedLines = parsed.skippedLines;

  // Lineage: round-trip whatever the `sinter_import` marker holds (v0 or v1).
  // A garbage marker yields `undefined` — a bad record must never fail a read.
  const markerIdx = importMarkerIndex(parsed.entries);
  if (markerIdx >= 0) {
    try {
      const prov = readProvenance((parsed.entries[markerIdx] as { data?: unknown }).data);
      if (prov) preserve[PRESERVE_KEY] = prov;
    } catch {
      /* unreadable provenance is simply absent */
    }
  }

  if (Object.keys(preserve).length) session.preserve = preserve;

  return session;
}

/** Exported for tests: the first user text, used for derived titles/firstPrompt. */
export function firstUserPrompt(entries: NativeEntry[]): string | undefined {
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = (e as NativeMessageEntry).message;
    if (m?.role !== "user") continue;
    const t = textOf(m.content).trim();
    if (t) return t;
  }
  return undefined;
}

export { textOf as nativeTextOf };
export type { TextPart };
