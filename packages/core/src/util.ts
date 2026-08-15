import type { SifEntry, SifSession, TextPart, ToolCallPart, Usage } from "./sif";

export function mintSifId(): string {
  return Bun.randomUUIDv7();
}

export function toIso(t: number | string | undefined): string | undefined {
  if (t === undefined || t === null) return undefined;
  if (typeof t === "string") {
    const d = new Date(t);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  // auto-detect seconds vs milliseconds (threshold pattern from omp's codex importer)
  const ms = t < 10_000_000_000 ? t * 1000 : t;
  return new Date(ms).toISOString();
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    input: sum(a.input, b.input),
    output: sum(a.output, b.output),
    reasoning: sum(a.reasoning, b.reasoning),
    cacheRead: sum(a.cacheRead, b.cacheRead),
    cacheWrite: sum(a.cacheWrite, b.cacheWrite),
    costUsd: sum(a.costUsd, b.costUsd),
  };
}

/** Path from root to the given leaf (or to the last entry if omitted). */
export function threadPath(session: SifSession, leafId?: string): SifEntry[] {
  const byId = new Map(session.entries.map((e) => [e.id, e]));
  let leaf = leafId ? byId.get(leafId) : session.entries[session.entries.length - 1];
  const out: SifEntry[] = [];
  while (leaf) {
    out.unshift(leaf);
    leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
  }
  return out;
}

/**
 * Flatten historical tool calls/results into inert text (the CASR /
 * pi-opencode-session-import convergent safety pattern). Used by writers when
 * WriteOpts.liveTools !== true.
 */
export function inertToolText(call: ToolCallPart, resultText?: string): TextPart {
  const args = typeof call.args === "string" ? call.args : JSON.stringify(call.args);
  const clippedArgs = args.length > 2000 ? args.slice(0, 2000) + "…[truncated]" : args;
  const clippedResult =
    resultText && resultText.length > 8000 ? resultText.slice(0, 8000) + "…[truncated]" : resultText;
  return {
    type: "text",
    text:
      `[historical tool call: ${call.name}(${clippedArgs})` +
      (clippedResult !== undefined ? ` → ${clippedResult}` : "") +
      `]`,
  };
}

/**
 * Structural validation. Hard problems (broken tree, duplicate ids, empty text
 * parts, missing identity) throw. Soft problems that legitimately occur on
 * real transcripts (unpaired tool results after compaction, unknowable cwd on
 * control-only sessions) are returned as warnings.
 */
export function validateSession(s: SifSession): string[] {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (s.sif !== "sif/0") problems.push(`unknown sif version ${String(s.sif)}`);
  if (!s.id) problems.push("missing id");
  if (!s.origin?.harness || !s.origin?.nativeId) problems.push("missing origin");
  if (!s.cwd) warnings.push("missing cwd (control-only or truncated session)");
  const ids = new Set<string>();
  const callNames = new Map<string, string>();
  for (const e of s.entries) {
    if (ids.has(e.id)) problems.push(`duplicate entry id ${e.id}`);
    ids.add(e.id);
    if (e.kind === "assistant") {
      for (const p of e.content) {
        if (p.type === "text" && p.text === "")
          problems.push(`empty text part in ${e.id} (breaks Claude Code resume)`);
        if (p.type === "toolCall") callNames.set(p.callId, p.name);
      }
    }
    if (e.kind === "user") {
      for (const p of e.content) {
        if (p.type === "text" && p.text === "")
          problems.push(`empty text part in ${e.id} (breaks Claude Code resume)`);
      }
    }
    if (e.kind === "toolResult" && !callNames.has(e.callId))
      warnings.push(`toolResult ${e.id} references unknown callId ${e.callId} (call likely lost to compaction)`);
  }
  for (const e of s.entries) {
    if (e.parentId !== null && !ids.has(e.parentId))
      problems.push(`entry ${e.id} has dangling parentId ${e.parentId}`);
  }
  if (problems.length) throw new Error(`invalid SIF session:\n  ${problems.join("\n  ")}`);
  return warnings;
}
