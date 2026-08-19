/**
 * SIF — Sinter Interchange Format, version "sif/0".
 *
 * The canonical session model every adapter reads into and writes from.
 * Entries form a TREE via id/parentId (Claude Code's parentUuid tree is the
 * richest source shape; linear histories are a degenerate chain).
 *
 * Fidelity rules:
 * - Every entry may carry `origin` (native record type/id) and `raw` (the
 *   untouched source record). Lossless by default; strip with --slim.
 * - Non-portable provider state (thinking signatures, encrypted reasoning,
 *   remote-compaction handles) goes in `preserve` as opaque blobs — replayed
 *   only when porting back to the same provider, stripped otherwise.
 * - Never fake data the source doesn't have (e.g. omp/pi have no token
 *   counts — omit `usage`, don't zero-fill).
 */

export type HarnessId = "claude" | "codex" | "devin" | "opencode" | "zcode" | "omp" | "pi";

export const SIF_VERSION = "sif/0";

export interface SifOrigin {
  harness: HarnessId;
  nativeId: string;
  nativePath?: string;
  host?: string;
}

export interface SifGit {
  sha?: string;
  branch?: string;
  remote?: string;
}

export interface SifTitle {
  text: string;
  source: "auto" | "user" | "derived";
}

export interface Usage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
}

// ---------------------------------------------------------------- content

export interface TextPart {
  type: "text";
  text: string;
}

export interface ThinkingPart {
  type: "thinking";
  thinking: string;
  /** Provider-bound opaque signature — non-portable across providers. */
  signature?: string;
}

export interface ImagePart {
  type: "image";
  mimeType: string;
  /** base64 */
  data: string;
}

export interface ToolCallPart {
  type: "toolCall";
  callId: string;
  name: string;
  args: Record<string, unknown> | string;
  /** Short human description of why, when the source records it. */
  intent?: string;
}

export type UserContentPart = TextPart | ImagePart;
export type AssistantContentPart = TextPart | ThinkingPart | ImagePart | ToolCallPart;
export type ToolResultContentPart = TextPart | ImagePart;

// ---------------------------------------------------------------- entries

export interface EntryBase {
  /** Stable within the session. Adapters may derive from native ids. */
  id: string;
  /** null for roots. Forms the tree. */
  parentId: string | null;
  /** ISO timestamp when known. */
  ts?: string;
  origin?: { nativeType?: string; nativeId?: string };
  /** Untouched source record for lossless round-trips. */
  raw?: unknown;
}

export interface UserEntry extends EntryBase {
  kind: "user";
  content: UserContentPart[];
  /** True when injected by tooling rather than typed by the human. */
  synthetic?: boolean;
}

export interface AssistantEntry extends EntryBase {
  kind: "assistant";
  content: AssistantContentPart[];
  model?: { provider?: string; id?: string };
  usage?: Usage;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}

export interface ToolResultEntry extends EntryBase {
  kind: "toolResult";
  callId: string;
  /** Tool name only exists on the call — adapters must carry a callId→name map. */
  toolName: string;
  content: ToolResultContentPart[];
  isError?: boolean;
}

export interface CompactionEntry extends EntryBase {
  kind: "compaction";
  summary?: string;
  /** e.g. Codex keeps the full replaced history inline. */
  replacedHistory?: unknown;
}

export interface ModelChangeEntry extends EntryBase {
  kind: "modelChange";
  provider?: string;
  model: string;
}

export interface SubsessionEntry extends EntryBase {
  kind: "subsession";
  /** Matches SifSession.origin.nativeId of an entry in `subsessions`. */
  sessionRef: string;
  agentName?: string;
  /** The parent-visible result text, when the source records it. */
  resultText?: string;
}

/** System/hook/meta records worth keeping but with no first-class meaning. */
export interface NoteEntry extends EntryBase {
  kind: "note";
  noteType: string;
  text?: string;
}

export type SifEntry =
  | UserEntry
  | AssistantEntry
  | ToolResultEntry
  | CompactionEntry
  | ModelChangeEntry
  | SubsessionEntry
  | NoteEntry;

// ---------------------------------------------------------------- session

export interface SifSession {
  sif: typeof SIF_VERSION;
  /** New uuid7 minted by sinter at export time. */
  id: string;
  origin: SifOrigin;
  cwd: string;
  additionalDirs?: string[];
  git?: SifGit;
  title?: SifTitle;
  createdAt?: string;
  updatedAt?: string;
  /** Rollup across entries, where the source has real numbers. */
  usage?: Usage;
  entries: SifEntry[];
  /** Subagent / sidechain transcripts, first-class. */
  subsessions?: SifSession[];
  /** Opaque provider-bound state, keyed by adapter-defined names. */
  preserve?: Record<string, unknown>;
}

// ---------------------------------------------------------------- summaries

/** Cheap listing row — built from indexes/head-windows, never full parses. */
export interface SessionSummary {
  harness: HarnessId;
  nativeId: string;
  nativePath?: string;
  cwd?: string;
  title?: string;
  firstPrompt?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  model?: string;
  gitBranch?: string;
  usage?: Usage;
  parentNativeId?: string;
  isSubagent?: boolean;
  /** Listed in an index but the backing file/rows are gone (harness GC). */
  ghost?: boolean;
}
