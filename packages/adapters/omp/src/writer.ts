/**
 * Native session writer, shared by omp and pi (dialect-parameterised).
 *
 * CONVENTIONS §7: always mint a NEW native id, never touch an existing session,
 * append a provenance marker in the target's native idiom, and default to inert
 * tool flattening unless `opts.liveTools`.
 */

import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeRef, WriteOpts } from "@sinter/core/adapter";
import {
  CARRY_INLINE_MAX,
  type Hop,
  PRESERVE_KEY,
  type SinterProvenance,
  buildProvenance,
  encodeCarry,
  readProvenance,
  storeCarry,
} from "@sinter/core/lineage";
import type { AssistantEntry, SifEntry, SifSession, ToolResultEntry } from "@sinter/core/sif";
import { inertToolText, validateSession } from "@sinter/core/util";
import type { Dialect } from "./dialect";
import { HEADER_SCAN_BYTES } from "./native";
import { sessionDirFor, sessionFileName, sidecarDirFor } from "./paths";
import { serializeTitleSlot } from "./title-slot";

/** Stamped into every provenance record this writer emits. */
export const SINTER_VERSION = "0.1.0";

export interface NativeWriteOpts extends WriteOpts {
  /** Override the store root (used by the offline write self-test). */
  sessionsDir?: string;
  /** omp only: also emit the 256-byte title slot as line 1. Default false. */
  emitTitleSlot?: boolean;
  /** Write subsessions as sidecar `<AgentName>.jsonl` files (omp only). Default true. */
  writeSubsessions?: boolean;
  /**
   * Reuse an already-minted native id instead of minting one here. The only
   * legitimate use is a caller that must know the target id BEFORE it stamps a
   * provenance record with `withProvenance` — never to overwrite a session.
   */
  nativeId?: string;
  /** Provenance to persist verbatim, overriding what this writer would build. */
  provenance?: SinterProvenance;
  /** Stash the source SIF for carry-forward reads. Default true. */
  carry?: boolean;
  /** Root for carry sidecars (`~/.sinter` by default). Tests point this at a temp dir. */
  carryRoot?: string;
  /** Injected for deterministic tests. */
  now?: Date;
  newId?: () => string;
}

/**
 * 8 lowercase hex chars, matching the native entry-id shape.
 *
 * NOT derived from uuid7: a v7's leading hex digits are the millisecond
 * timestamp, so every id minted in the same tick would be identical — the exact
 * "colliding synthetic IDs break the parent chain" failure mode that corrupts
 * Claude Code resume (issue #36583). `used` guarantees uniqueness regardless.
 */
function makeEntryIdFactory(rand?: () => string) {
  const used = new Set<string>();
  return (): string => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const raw = rand ? rand() : crypto.randomUUID();
      const hex = raw.replace(/[^0-9a-f]/gi, "").toLowerCase();
      // uuid7's first 12 hex chars are a timestamp; take from the random tail.
      const id = (hex.length >= 16 ? hex.slice(-8) : hex.padEnd(8, "0").slice(0, 8)) + "";
      const candidate = attempt === 0 ? id : (id.slice(0, 6) + attempt.toString(16).padStart(2, "0")).slice(0, 8);
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    throw new Error("could not mint a unique 8-hex entry id");
  };
}

interface Line {
  obj: Record<string, unknown>;
}

// ------------------------------------------------------------------ lineage

/**
 * A provenance record the CALLER stamped for this write, as opposed to the one
 * `read()` round-tripped off the source store.
 *
 * Both live under `session.preserve.sinter`, so they have to be told apart by
 * what the chain ends at: the source's own record ends at the source and must
 * be EXTENDED by one hop; a caller stamp already ends at the target and is
 * persisted verbatim.
 */
function callerStampedProvenance(session: SifSession): SinterProvenance | undefined {
  const prov = readProvenance(session.preserve?.[PRESERVE_KEY]);
  if (!prov) return undefined;
  const tail = prov.chain[prov.hop];
  if (!tail) return undefined;
  if (tail.harness === session.origin.harness && tail.nativeId === session.origin.nativeId) return undefined;
  return prov;
}

/** The record to stamp into the target store for this port. */
function provenanceFor(session: SifSession, target: Hop, opts: NativeWriteOpts, now: Date): SinterProvenance {
  return (
    opts.provenance ??
    callerStampedProvenance(session) ??
    buildProvenance({
      source: session,
      target,
      sinterVersion: SINTER_VERSION,
      portedAt: now.toISOString(),
      mode: opts.mode,
      inertTools: opts.liveTools !== true,
    })
  );
}

/**
 * Drop the source's own carry blob before carrying the source forward again —
 * otherwise every hop would nest the previous hop's payload and the record
 * would grow exponentially down the chain.
 */
function withoutNestedCarry(session: SifSession): SifSession {
  const prov = session.preserve?.[PRESERVE_KEY];
  if (!prov || typeof prov !== "object") return session;
  const { carry: _c, carryRef: _r, ...rest } = prov as Record<string, unknown>;
  return { ...session, preserve: { ...session.preserve, [PRESERVE_KEY]: rest } };
}

/**
 * Persist the carry-forward payload and merge the resulting fields.
 * `dryRun` must write nothing at all, so a payload too big to inline is simply
 * dropped there rather than spilled to a sidecar.
 */
async function attachCarry(
  prov: SinterProvenance,
  session: SifSession,
  target: Hop,
  opts: NativeWriteOpts,
): Promise<SinterProvenance> {
  if (opts.carry === false) return prov;
  if (prov.carry || prov.carryRef) return prov; // the caller already supplied one
  const payload = withoutNestedCarry(session);
  if (opts.dryRun) {
    const encoded = encodeCarry(payload);
    if (!encoded || encoded.length > CARRY_INLINE_MAX) return prov;
    return { ...prov, carry: encoded, carryBytes: JSON.stringify(payload).length };
  }
  return { ...prov, ...(await storeCarry(payload, target, { root: opts.carryRoot })) };
}

function assistantModelOf(session: SifSession): { provider?: string; model: string } | undefined {
  for (const e of session.entries) {
    if (e.kind === "modelChange" && e.model) return { provider: e.provider, model: e.model };
  }
  for (const e of session.entries) {
    if (e.kind === "assistant" && e.model?.id) return { provider: e.model.provider, model: e.model.id };
  }
  return undefined;
}

function toolResultTextFor(session: SifSession, callId: string): string | undefined {
  for (const e of session.entries) {
    if (e.kind !== "toolResult" || e.callId !== callId) continue;
    const text = e.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    return e.isError ? `[error] ${text}` : text;
  }
  return undefined;
}

/**
 * Build the native JSONL body for a SIF session.
 * Exported so `dryRun` can validate the exact bytes it would have written.
 */
export function buildNativeBody(
  session: SifSession,
  dialect: Dialect,
  opts: NativeWriteOpts = {},
): { body: string; nativeId: string; createdAt: Date; entryCount: number; provenance: SinterProvenance } {
  validateSession(session);
  const entryId = makeEntryIdFactory(opts.newId);
  const now = opts.now ?? new Date();
  // ALWAYS a new native id (§7); `opts.nativeId` only lets a caller pre-mint it.
  const nativeId = opts.nativeId ?? Bun.randomUUIDv7();
  const cwd = opts.cwd ?? session.cwd;
  const liveTools = opts.liveTools === true;
  const lines: Line[] = [];

  // ---- header -------------------------------------------------------------
  const header: Record<string, unknown> = {
    type: "session",
    version: 3,
    id: nativeId,
    timestamp: now.toISOString(),
    cwd,
  };
  if (dialect.headerCarriesTitle && session.title?.text) {
    header.title = session.title.text;
    header.titleSource = session.title.source === "user" ? "user" : "auto";
  }
  if (session.additionalDirs?.length && dialect.harness === "omp") {
    header.additionalDirectories = session.additionalDirs;
  }
  lines.push({ obj: header });

  // ---- entries ------------------------------------------------------------
  // SIF ids → fresh 8-hex native ids, preserving the tree exactly.
  const idMap = new Map<string, string>();
  for (const e of session.entries) idMap.set(e.id, entryId());
  const emitted = new Set<string>();
  const mapParent = (e: SifEntry): string | null => {
    let cur = e.parentId;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      if (emitted.has(cur)) return idMap.get(cur) ?? null;
      cur = session.entries.find((x) => x.id === cur)?.parentId ?? null;
    }
    return null;
  };
  const stamp = (e: SifEntry) => ({
    id: idMap.get(e.id)!,
    parentId: mapParent(e),
    timestamp: e.ts ?? now.toISOString(),
  });
  const emit = (e: SifEntry, obj: Record<string, unknown>) => {
    lines.push({ obj });
    emitted.add(e.id);
  };

  // A model_change first, so the target opens the session on the right model.
  const model = assistantModelOf(session);
  if (model) {
    lines.push({
      obj: {
        type: "model_change",
        id: entryId(),
        parentId: null,
        timestamp: now.toISOString(),
        ...dialect.modelChangeBody(model.provider, model.model),
      },
    });
  }

  // Provenance, in the target's native idiom (a `custom` entry — not in LLM context).
  // The record carries BOTH shapes: the v0 marker fields anything already
  // reading them still finds, and the v1 lineage chain `readProvenance`
  // upgrades to. `data` is mutated below to record the ported window.
  const target: Hop = { harness: dialect.harness, nativeId, ...(opts.instanceId ? { instanceId: opts.instanceId } : {}) };
  const provenance = provenanceFor(session, target, opts, now);
  const provData: Record<string, unknown> = {
    // `sinter` (the version string) is a v0 field too — it comes in with the
    // spread below, which is why it is not repeated here.
    sourceHarness: session.origin.harness,
    sourceNativeId: session.origin.nativeId,
    sourceSifId: session.id,
    importedAt: now.toISOString(),
    liveTools,
    ...(session.origin.host ? { sourceHost: session.origin.host } : {}),
    ...provenance,
  };
  const provLineIndex = lines.length;
  lines.push({
    obj: {
      type: "custom",
      customType: "sinter_import",
      id: entryId(),
      parentId: null,
      timestamp: now.toISOString(),
      data: provData,
    },
  });

  for (const e of session.entries) {
    switch (e.kind) {
      case "user": {
        const content = e.content.map((p) =>
          p.type === "text" ? { type: "text", text: p.text } : { type: "image", data: p.data, mimeType: p.mimeType },
        );
        if (!content.length) break;
        emit(e, { type: "message", ...stamp(e), message: { role: "user", content, timestamp: e.ts ?? now.toISOString() } });
        break;
      }
      case "assistant": {
        const a = e as AssistantEntry;
        const content: Record<string, unknown>[] = [];
        for (const p of a.content) {
          if (p.type === "text") {
            if (p.text) content.push({ type: "text", text: p.text });
          } else if (p.type === "thinking") {
            content.push({
              type: "thinking",
              thinking: p.thinking,
              ...(p.signature ? { thinkingSignature: p.signature } : {}),
            });
          } else if (p.type === "image") {
            content.push({ type: "image", data: p.data, mimeType: p.mimeType });
          } else if (p.type === "toolCall") {
            if (liveTools) {
              content.push({ type: "toolCall", id: p.callId, name: p.name, arguments: p.args });
            } else {
              // Inert flattening: a historical call can never be re-executed.
              content.push({ ...inertToolText(p, toolResultTextFor(session, p.callId)) });
            }
          }
        }
        if (!content.length) break;
        const message: Record<string, unknown> = {
          role: "assistant",
          content,
          timestamp: e.ts ?? now.toISOString(),
        };
        if (a.model?.id) message.model = a.model.id;
        if (a.model?.provider) message.provider = a.model.provider;
        // omp's renderer derefs usage (v3 assistant messages ALWAYS carry it;
        // native stores zero-fill when cost is unknown — same for imports, see
        // omp's claude-session-store.ts). SIF omits usage when the source had
        // none; zero-fill at the native boundary so omp never sees `undefined`.
        const input = a.usage?.input ?? 0;
        const output = a.usage?.output ?? 0;
        const cacheRead = a.usage?.cacheRead ?? 0;
        const cacheWrite = a.usage?.cacheWrite ?? 0;
        message.usage = {
          input,
          output,
          cacheRead,
          cacheWrite,
          totalTokens: input + output + cacheRead + cacheWrite,
          // omp's session index requires usage.cost.total; its own importers
          // zero-fill cost for foreign sessions.
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          ...(a.usage?.reasoning !== undefined
            ? dialect.harness === "omp"
              ? { reasoningTokens: a.usage.reasoning }
              : { reasoning: a.usage.reasoning }
            : {}),
        };
        if (a.stopReason) message.stopReason = a.stopReason;
        emit(e, { type: "message", ...stamp(e), message });
        break;
      }
      case "toolResult": {
        // Without liveTools the result is already folded into the inert call text.
        if (!liveTools) break;
        const t = e as ToolResultEntry;
        emit(e, {
          type: "message",
          ...stamp(e),
          message: {
            role: "toolResult",
            toolCallId: t.callId,
            toolName: t.toolName,
            isError: t.isError ?? false,
            content: t.content.map((p) =>
              p.type === "text" ? { type: "text", text: p.text } : { type: "image", data: p.data, mimeType: p.mimeType },
            ),
            timestamp: e.ts ?? now.toISOString(),
          },
        });
        break;
      }
      case "compaction": {
        emit(e, {
          type: "compaction",
          ...stamp(e),
          summary: e.summary ?? "",
          firstKeptEntryId: idMap.get(e.id)!,
          tokensBefore: 0,
        });
        break;
      }
      case "modelChange": {
        emit(e, { type: "model_change", ...stamp(e), ...dialect.modelChangeBody(e.provider, e.model) });
        break;
      }
      case "subsession": {
        // A note in context, so the ported transcript still reads coherently.
        emit(e, {
          type: "custom",
          customType: "sinter_subsession",
          ...stamp(e),
          data: { sessionRef: e.sessionRef, agentName: e.agentName, resultText: e.resultText },
        });
        break;
      }
      case "note": {
        emit(e, {
          type: "custom",
          customType: `sinter_note:${e.noteType}`,
          ...stamp(e),
          data: { text: e.text },
        });
        break;
      }
    }
  }

  // How many native records this port emitted after the marker. A later read
  // uses it to tell the ported transcript apart from turns the user added in
  // the target harness afterwards, so carry-forward never eats them.
  provData.portedEntries = lines.length - provLineIndex - 1;

  const body = `${lines.map((l) => JSON.stringify(l.obj)).join("\n")}\n`;
  return { body, nativeId, createdAt: now, entryCount: lines.length - 1, provenance };
}

export interface WriteResult extends NativeRef {
  /** The paths that would be written when `dryRun` is set. */
  planned?: string[];
  dryRun?: boolean;
  /** The lineage record stamped into the target store. */
  provenance?: SinterProvenance;
}

export async function writeNativeSession(
  session: SifSession,
  dialect: Dialect,
  opts: NativeWriteOpts = {},
): Promise<WriteResult> {
  const now = opts.now ?? new Date();
  // The native id is minted BEFORE the body so the carry payload can be filed
  // under the target hop it belongs to.
  const nativeId = opts.nativeId ?? Bun.randomUUIDv7();
  const target: Hop = { harness: dialect.harness, nativeId, ...(opts.instanceId ? { instanceId: opts.instanceId } : {}) };
  const provenance = await attachCarry(provenanceFor(session, target, opts, now), session, target, opts);
  const built = buildNativeBody(session, dialect, { ...opts, now, nativeId, provenance });
  const cwd = opts.cwd ?? session.cwd;
  const home = homedir();
  const sessionsDir = opts.sessionsDir ?? join(home, dialect.agentDirRelative, "sessions");
  const dir = opts.sessionsDir
    ? join(opts.sessionsDir, dialect.sessionDirName(cwd, home, tmpdir()))
    : sessionDirFor(dialect, sessionsDir, cwd, home);
  const file = join(dir, sessionFileName(built.createdAt, built.nativeId));

  let body = built.body;
  if (dialect.hasTitleSlot && opts.emitTitleSlot && session.title?.text) {
    body =
      serializeTitleSlot({
        title: session.title.text,
        source: session.title.source === "user" ? "user" : "auto",
        updatedAt: built.createdAt.toISOString(),
      }) + body;
  }

  // The header must land inside the harness's own 4KB scan window or the
  // picker shows a blank row (DIALECTS.md D3).
  const headerEnd = body.indexOf("\n", body.indexOf('{"type":"session"')) + 1;
  if (headerEnd <= 0 || Buffer.byteLength(body.slice(0, headerEnd)) > HEADER_SCAN_BYTES) {
    throw new Error(
      `session header would not land within the first ${HEADER_SCAN_BYTES} bytes — ${dialect.harness} would show a blank session`,
    );
  }

  const created: string[] = [file];
  const subFiles: { path: string; body: string }[] = [];
  const writeSubs = (opts.writeSubsessions ?? true) && dialect.hasSidecar;
  if (writeSubs && session.subsessions?.length) {
    const sidecar = sidecarDirFor(file);
    for (const sub of session.subsessions) {
      const name = (sub.title?.text ?? sub.origin.nativeId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "Subagent";
      // A subagent transcript gets its OWN id and its own provenance — never
      // the parent's pre-minted id or carry payload.
      const subBuilt = buildNativeBody(sub, dialect, {
        ...opts,
        cwd,
        nativeId: undefined,
        provenance: undefined,
        carry: false,
      });
      const path = join(sidecar, `${name}.jsonl`);
      subFiles.push({ path, body: subBuilt.body });
      created.push(path);
    }
  }

  if (opts.dryRun) {
    return {
      harness: dialect.harness,
      nativeId: built.nativeId,
      nativePath: file,
      created: [],
      planned: created,
      dryRun: true,
      provenance: built.provenance,
    };
  }

  await mkdir(dir, { recursive: true });
  await Bun.write(file, body);
  if (subFiles.length) {
    await mkdir(sidecarDirFor(file), { recursive: true });
    for (const s of subFiles) await Bun.write(s.path, s.body);
  }

  return {
    harness: dialect.harness,
    nativeId: built.nativeId,
    nativePath: file,
    created,
    provenance: built.provenance,
  };
}
