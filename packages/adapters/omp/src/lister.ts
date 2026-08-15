/**
 * Cheap enumeration (CONVENTIONS: `list()` must never full-parse a transcript).
 *
 * One bounded head read per session file: 4KB is all either harness itself
 * scans for the header (`session-listing.ts:59`, `session-manager.js:256`), and
 * a 16KB window is enough to also catch the first user message for
 * `firstPrompt` without walking the body.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionSummary } from "@sinter/core/sif";
import type { Dialect } from "./dialect";
import { HEADER_SCAN_BYTES, type NativeMessageEntry, isEntry, isHeader } from "./native";
import { nativeIdFromFileName, sidecarDirFor } from "./paths";
import { peelTitleSlot } from "./title-slot";

const HEAD_WINDOW_BYTES = 16 * 1024;

export interface HeadInfo {
  id?: string;
  cwd?: string;
  timestamp?: string;
  title?: string;
  titleSource?: "auto" | "user";
  parentSession?: string;
  firstPrompt?: string;
  model?: string;
  /** Header did not land inside the harness's own 4KB scan window. */
  headerOutOfRange?: boolean;
}

/** Parse whatever is knowable from a bounded head window. */
export function parseHead(head: string, dialect: Dialect): HeadInfo {
  const info: HeadInfo = {};
  const peeled = peelTitleSlot(head);
  const slotBytes = peeled.slotBytes ?? 0;
  let bytesConsumed = slotBytes;

  for (const rawLine of peeled.body.split("\n")) {
    const line = rawLine.trim();
    const lineBytes = Buffer.byteLength(rawLine) + 1;
    if (!line) {
      bytesConsumed += lineBytes;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A truncated final line in the window is expected — stop scanning.
      break;
    }
    if (isHeader(value)) {
      info.id = value.id;
      info.cwd = value.cwd;
      info.timestamp = value.timestamp;
      if (dialect.headerCarriesTitle && typeof value.title === "string") info.title = value.title;
      if (value.titleSource === "auto" || value.titleSource === "user") info.titleSource = value.titleSource;
      if (typeof value.parentSession === "string") info.parentSession = value.parentSession;
      info.headerOutOfRange = bytesConsumed + lineBytes > HEADER_SCAN_BYTES;
      bytesConsumed += lineBytes;
      continue;
    }
    bytesConsumed += lineBytes;
    if (!isEntry(value)) continue;
    if (value.type === "model_change" && !info.model) {
      const v = value as { model?: unknown; provider?: unknown; modelId?: unknown };
      info.model =
        typeof v.modelId === "string"
          ? `${typeof v.provider === "string" ? `${v.provider}/` : ""}${v.modelId}`
          : typeof v.model === "string"
            ? v.model
            : undefined;
    }
    if (value.type === "message" && !info.firstPrompt) {
      const m = (value as NativeMessageEntry).message;
      if (m?.role === "user") {
        const c = m.content;
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c
                  .filter((p) => (p as { type?: string })?.type === "text")
                  .map((p) => String((p as { text?: unknown }).text ?? ""))
                  .join("")
              : "";
        if (text.trim()) info.firstPrompt = text.trim().slice(0, 500);
      }
    }
  }
  // The slot WINS over header.title (session-loader.ts:foldTitleSlot).
  if (peeled.slot) {
    if (peeled.slot.title) {
      info.title = peeled.slot.title;
      if (peeled.slot.source) info.titleSource = peeled.slot.source;
    } else {
      info.title = undefined;
      info.titleSource = undefined;
    }
  }
  return info;
}

export async function readHead(path: string, bytes = HEAD_WINDOW_BYTES): Promise<string> {
  const f = Bun.file(path);
  const slice = f.slice(0, Math.min(bytes, f.size || bytes));
  return await slice.text();
}

async function summarizeFile(path: string, dialect: Dialect, isSubagent: boolean, parentNativeId?: string) {
  const info = parseHead(await readHead(path), dialect);
  let updatedAt: string | undefined;
  try {
    updatedAt = (await stat(path)).mtime.toISOString();
  } catch {
    /* ghost */
  }
  const summary: SessionSummary = {
    harness: dialect.harness,
    nativeId: info.id ?? nativeIdFromFileName(path),
    nativePath: path,
    ...(info.cwd ? { cwd: info.cwd } : {}),
    ...(info.title ? { title: info.title } : {}),
    ...(info.firstPrompt ? { firstPrompt: info.firstPrompt } : {}),
    ...(info.timestamp ? { createdAt: info.timestamp } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(parentNativeId ?? info.parentSession ? { parentNativeId: parentNativeId ?? info.parentSession } : {}),
    ...(isSubagent ? { isSubagent: true } : {}),
  };
  return summary;
}

/** Enumerate every session in the store, plus (omp) sidecar subagent transcripts. */
export async function* listSessions(
  sessionsDir: string,
  dialect: Dialect,
  opts: { includeSubagents?: boolean } = {},
): AsyncGenerator<SessionSummary> {
  const includeSubagents = opts.includeSubagents ?? dialect.hasSidecar;
  let dirs: string[];
  try {
    dirs = await readdir(sessionsDir);
  } catch {
    return; // store not present on this machine — a valid outcome
  }
  for (const dir of dirs.sort()) {
    const encodedDir = join(sessionsDir, dir);
    let files: string[];
    try {
      files = await readdir(encodedDir);
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(encodedDir, file);
      let parent: SessionSummary;
      try {
        parent = await summarizeFile(path, dialect, false);
      } catch {
        continue;
      }
      yield parent;
      if (!includeSubagents) continue;
      let subFiles: string[];
      try {
        subFiles = await readdir(sidecarDirFor(path));
      } catch {
        continue;
      }
      for (const sub of subFiles.sort()) {
        if (!sub.endsWith(".jsonl")) continue;
        try {
          yield await summarizeFile(join(sidecarDirFor(path), sub), dialect, true, parent.nativeId);
        } catch {
          /* skip damaged sidecar */
        }
      }
    }
  }
}

/** Resolve an id (or unambiguous prefix) to a session file path. */
export async function findSessionPath(
  sessionsDir: string,
  dialect: Dialect,
  nativeId: string,
): Promise<string | undefined> {
  const matches: string[] = [];
  for await (const s of listSessions(sessionsDir, dialect)) {
    if (s.nativeId === nativeId) return s.nativePath;
    if (s.nativeId.startsWith(nativeId) && s.nativePath) matches.push(s.nativePath);
  }
  if (matches.length === 1) return matches[0];
  return undefined;
}
