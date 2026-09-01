/**
 * Transfer modes — how much of a session rides along on a port.
 *
 * Compaction here is DETERMINISTIC: no model call, no network, no API key. Most
 * of a transcript's bulk is `raw` source records and repeated tool output, and
 * both can be dropped mechanically. A model-written `digest` is a later mode;
 * it does not belong in the path that has to work offline.
 *
 * Nothing is ever deleted structurally: entries keep their id/parentId so the
 * tree stays valid, they just lose their payload. That also means a compacted
 * port can still carry the full SIF alongside it for a later hop to recover.
 */

import type {
  AssistantContentPart,
  AssistantEntry,
  CompactionEntry,
  SifEntry,
  SifSession,
  TextPart,
  ToolCallPart,
  ToolResultEntry,
} from "@sinter/core";
import { slimSession } from "./render";

export type TransferMode = "full" | "slim" | "compact";

export const TRANSFER_MODES: TransferMode[] = ["full", "slim", "compact"];

export const MODE_HINT: Record<TransferMode, string> = {
  full: "everything, lossless",
  slim: "drop source records",
  compact: "drop tool noise + thinking",
};

export interface CompactOpts {
  /** Max chars kept from a surviving tool result. */
  resultChars?: number;
  /** Max chars of a tool call's arguments. */
  argChars?: number;
}

export interface TransferStats {
  mode: TransferMode;
  bytesBefore: number;
  bytesAfter: number;
  /** Tool results whose payload was replaced by a marker. */
  resultsCollapsed: number;
  thinkingDropped: number;
  /** Distinct targets (file paths, commands, queries) seen in tool calls. */
  targets: string[];
}

export interface TransferResult {
  session: SifSession;
  stats: TransferStats;
}

// ---------------------------------------------------------------- arg targets

/**
 * The one argument that identifies what a tool call acted on. Tool names differ
 * across harnesses (Read / read_file / view / str_replace_editor), so this keys
 * off argument NAMES, which are far more consistent, and degrades to a clipped
 * JSON blob when nothing matches.
 */
const TARGET_KEYS = [
  "file_path",
  "filePath",
  "path",
  "filename",
  "file",
  "notebook_path",
  "target",
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
  "prompt",
];

export function callTarget(call: ToolCallPart, max = 80): string {
  const args = call.args;
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return clip(args, max);
  if (typeof args === "object") {
    const rec = args as Record<string, unknown>;
    for (const k of TARGET_KEYS) {
      const v = rec[k];
      if (typeof v === "string" && v.trim()) return clip(v.trim(), max);
    }
  }
  return clip(JSON.stringify(args), max);
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)) + "…";
}

const textOf = (parts: { type: string; text?: string }[] | undefined): string =>
  (parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");

function looksLikePath(s: string): boolean {
  return /[/\\]/.test(s) && !/\s/.test(s.trim());
}

// ---------------------------------------------------------------- compaction

/**
 * Mechanical compaction.
 *
 * - user turns: untouched, always. They are the intent, and they are small.
 * - assistant text: untouched.
 * - thinking: dropped (large, model-specific, not portable across harnesses).
 * - tool calls: arguments clipped to their identifying target.
 * - tool results: only the LAST result per (tool, target) survives, clipped;
 *   errors always survive; everything else becomes a one-line marker.
 * - `raw` source records: dropped everywhere.
 */
export function compactSession(session: SifSession, opts: CompactOpts = {}): TransferResult {
  const resultChars = opts.resultChars ?? 600;
  const argChars = opts.argChars ?? 120;

  const bytesBefore = JSON.stringify(session).length;
  let resultsCollapsed = 0;
  let thinkingDropped = 0;
  const targets: string[] = [];
  const seenTarget = new Set<string>();

  // callId → the call that produced it, so a result can name its own target.
  const callById = new Map<string, ToolCallPart>();
  const collect = (s: SifSession): void => {
    for (const e of s.entries) {
      if (e.kind !== "assistant") continue;
      for (const p of e.content) if (p.type === "toolCall") callById.set(p.callId, p);
    }
    for (const sub of s.subsessions ?? []) collect(sub);
  };
  collect(session);

  /**
   * Last-writer-wins over (tool, target): walking BACKWARDS means the first
   * time a key is seen is its final occurrence, which is the one worth keeping.
   */
  const keepResult = new Set<string>();
  const markKeepers = (s: SifSession): void => {
    const seen = new Set<string>();
    for (let i = s.entries.length - 1; i >= 0; i--) {
      const e = s.entries[i]!;
      if (e.kind !== "toolResult") continue;
      const call = callById.get(e.callId);
      const k = `${e.toolName}\\0${call ? callTarget(call, 200) : e.callId}`;
      if (!seen.has(k)) {
        seen.add(k);
        keepResult.add(e.id);
      }
    }
    for (const sub of s.subsessions ?? []) markKeepers(sub);
  };
  markKeepers(session);

  const compactEntry = (e: SifEntry): SifEntry => {
    const { raw: _raw, ...base } = e;

    if (base.kind === "assistant") {
      const a = base as AssistantEntry;
      const content: AssistantContentPart[] = [];
      for (const p of a.content) {
        if (p.type === "thinking") {
          thinkingDropped++;
          continue;
        }
        if (p.type === "toolCall") {
          const target = callTarget(p, argChars);
          if (target && !seenTarget.has(target)) {
            seenTarget.add(target);
            targets.push(target);
          }
          content.push({ ...p, args: target || "" });
          continue;
        }
        content.push(p);
      }
      // An assistant turn that was pure thinking must not end up empty.
      if (!content.length) content.push({ type: "text", text: "[thinking omitted]" } as TextPart);
      return { ...a, content };
    }

    if (base.kind === "compaction") {
      const { replacedHistory: _replacedHistory, ...portable } = base as CompactionEntry;
      return {
        ...portable,
        summary: portable.summary?.trim()
          ? portable.summary
          : "Earlier context was compacted, but its portable summary is not available across harnesses.",
      };
    }

    if (base.kind === "toolResult") {
      const r = base as ToolResultEntry;
      const body = textOf(r.content);
      if (r.isError) {
        return { ...r, content: [{ type: "text", text: clipMultiline(body, resultChars) || "[error]" }] };
      }
      if (keepResult.has(r.id)) {
        return { ...r, content: [{ type: "text", text: clipMultiline(body, resultChars) || "[empty]" }] };
      }
      resultsCollapsed++;
      const call = callById.get(r.callId);
      const target = call ? callTarget(call, 60) : "";
      return {
        ...r,
        content: [
          {
            type: "text",
            text: `[${r.toolName}${target ? ` ${target}` : ""} — output superseded, ${body.length} chars omitted]`,
          },
        ],
      };
    }

    return base as SifEntry;
  };

  const walk = (s: SifSession): SifSession => ({
    ...s,
    entries: s.entries.map(compactEntry),
    subsessions: s.subsessions?.map(walk),
  });

  const out = walk(session);
  const bytesAfter = JSON.stringify(out).length;

  // A header note so the receiving harness (and the human) can see what is missing.
  const files = targets.filter(looksLikePath);
  const note: SifEntry = {
    kind: "note",
    id: "sinter-compaction-note",
    parentId: null,
    noteType: "sinter_compaction",
    text:
      `compacted by sinter before porting: ${resultsCollapsed} superseded tool result(s) and ` +
      `${thinkingDropped} thinking block(s) omitted, source records and provider-private compaction state stripped ` +
      `(${fmtBytes(bytesBefore)} → ${fmtBytes(bytesAfter)}).` +
      (files.length ? ` Files touched: ${files.slice(0, 40).join(", ")}${files.length > 40 ? ", …" : ""}.` : ""),
  };
  // Re-root the original first entry under nothing changes; the note is a
  // sibling root, which the tree validator allows.
  out.entries = [note, ...out.entries];

  return {
    session: out,
    stats: {
      mode: "compact",
      bytesBefore,
      bytesAfter: JSON.stringify(out).length,
      resultsCollapsed,
      thinkingDropped,
      targets,
    },
  };
}

function clipMultiline(s: string, max: number): string {
  if (s.length <= max) return s;
  const lines = s.split("\n").length;
  return s.slice(0, max) + `\n…[${s.length - max} more chars, ${lines} lines]`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Rough token estimate — 4 chars/token is close enough to size a warning. */
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

// ------------------------------------------------------------------ dispatch

export function applyTransfer(
  session: SifSession,
  mode: TransferMode,
  opts: CompactOpts = {},
): TransferResult {
  const bytesBefore = JSON.stringify(session).length;
  if (mode === "compact") return compactSession(session, opts);

  const out = mode === "slim" ? slimSession(session) : session;
  const bytesAfter = mode === "slim" ? JSON.stringify(out).length : bytesBefore;
  return {
    session: out,
    stats: { mode, bytesBefore, bytesAfter, resultsCollapsed: 0, thinkingDropped: 0, targets: [] },
  };
}
