/**
 * Native on-disk record shapes for the omp/pi session-v3 JSONL format.
 *
 * Transcribed from:
 *   omp  ~/node_modules/@oh-my-pi/pi-coding-agent/src/session/session-entries.ts
 *   pi   .../@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts
 *
 * See DIALECTS.md for the divergences. Everything here is `?`-heavy on purpose:
 * these are undocumented internals and parsing must be lenient (CONVENTIONS §2).
 */

export const SESSION_TITLE_SLOT_BYTES = 256;
export const CURRENT_SESSION_VERSION = 3;
/** Both harnesses only scan this many bytes for the header. */
export const HEADER_SCAN_BYTES = 4096;

export type TitleSource = "auto" | "user";

/** omp only: fixed-width mutable first line. Valid JSON, but not a session entry. */
export interface TitleSlot {
  type: "title";
  v: 1;
  title: string;
  source?: TitleSource;
  updatedAt: string;
  pad: string;
}

export interface NativeHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  /** omp only */
  title?: string;
  /** omp only */
  titleSource?: TitleSource;
  /** omp only */
  additionalDirectories?: string[];
  parentSession?: string;
  [k: string]: unknown;
}

export interface NativeEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [k: string]: unknown;
}

// ------------------------------------------------------------------ content

export interface NativeTextPart {
  type: "text";
  text: string;
}
export interface NativeThinkingPart {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}
export interface NativeImagePart {
  type: "image";
  /** base64, a `data:` URL, or a `blob:sha256:<64hex>` ref into the blob store. */
  data: string;
  mimeType?: string;
}
export interface NativeToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: unknown;
  /** omp only */
  intent?: string;
  [k: string]: unknown;
}
export type NativePart =
  | NativeTextPart
  | NativeThinkingPart
  | NativeImagePart
  | NativeToolCallPart
  | { type: string; [k: string]: unknown };

export interface NativeUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** pi */
  reasoning?: number;
  /** omp */
  reasoningTokens?: number;
  totalTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

export interface NativeMessage {
  /** `toolResult` is a TOP-LEVEL role in this format, not a content part. */
  role: "user" | "assistant" | "toolResult" | string;
  content?: string | NativePart[];
  timestamp?: string;
  // assistant
  api?: string;
  provider?: string;
  model?: string;
  usage?: NativeUsage;
  stopReason?: string;
  // toolResult
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  [k: string]: unknown;
}

export interface NativeMessageEntry extends NativeEntryBase {
  type: "message";
  message: NativeMessage;
}

export interface NativeModelChangeEntry extends NativeEntryBase {
  type: "model_change";
  /** omp: "provider/modelId" */
  model?: string;
  /** pi */
  provider?: string;
  /** pi */
  modelId?: string;
  role?: string;
}

export interface NativeCompactionEntry extends NativeEntryBase {
  type: "compaction";
  summary?: string;
  shortSummary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  details?: unknown;
}

export interface NativeCustomEntry extends NativeEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface NativeCustomMessageEntry extends NativeEntryBase {
  type: "custom_message";
  customType: string;
  content: string | NativePart[];
  details?: unknown;
  display?: boolean;
}

/** omp only: first entry of a subagent sidecar transcript. */
export interface NativeSessionInitEntry extends NativeEntryBase {
  type: "session_init";
  systemPrompt?: string;
  task?: string;
  tools?: string[];
  agent?: string;
  modelRole?: string;
  resolvedModel?: string;
}

export type NativeEntry = NativeEntryBase;
export type NativeRecord = TitleSlot | NativeHeader | NativeEntry;

// ------------------------------------------------------------------ guards

export function isTitleSlot(v: unknown): v is TitleSlot {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.type === "title" &&
    r.v === 1 &&
    typeof r.title === "string" &&
    typeof r.updatedAt === "string" &&
    typeof r.pad === "string" &&
    (r.source === undefined || r.source === "auto" || r.source === "user")
  );
}

export function isHeader(v: unknown): v is NativeHeader {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return r.type === "session" && typeof r.id === "string";
}

export function isEntry(v: unknown): v is NativeEntry {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.type === "string" && typeof r.id === "string" && r.type !== "session" && r.type !== "title";
}
