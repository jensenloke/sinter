/** Store layout helpers for the omp/pi JSONL stores. */

import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Dialect } from "./dialect";

export interface StoreLayout {
  /** e.g. ~/.omp/agent */
  agentDir: string;
  /** e.g. ~/.omp/agent/sessions */
  sessionsDir: string;
  /** e.g. ~/.omp/agent/blobs */
  blobsDir: string;
}

export function storeLayout(dialect: Dialect, home = homedir()): StoreLayout {
  const agentDir = join(home, dialect.agentDirRelative);
  return {
    agentDir,
    sessionsDir: join(agentDir, "sessions"),
    blobsDir: join(agentDir, "blobs"),
  };
}

/** Session directory for a cwd, per the dialect's (lossy, never-inverted) encoding. */
export function sessionDirFor(dialect: Dialect, sessionsDir: string, cwd: string, home = homedir()): string {
  return join(sessionsDir, dialect.sessionDirName(cwd, home, tmpdir()));
}

/**
 * omp file-safe ISO stamp: `2026-08-12T13-41-43-938Z`.
 * `:` and `.` become `-` so the name is valid on every filesystem.
 */
export function fileSafeIso(d: Date): string {
  return d.toISOString().replace(/:/g, "-").replace(/\./g, "-");
}

export function sessionFileName(createdAt: Date, id: string): string {
  return `${fileSafeIso(createdAt)}_${id}.jsonl`;
}

/**
 * Sidecar artifacts directory: the session path with `.jsonl` stripped.
 * `session-manager.ts:99` / `session-storage.ts:441`: `sessionPath.slice(0, -6)`.
 */
export function sidecarDirFor(sessionPath: string): string {
  return sessionPath.endsWith(".jsonl") ? sessionPath.slice(0, -6) : `${sessionPath}.artifacts`;
}

/** `<ts>_<uuid7>.jsonl` → the uuid7, falling back to the whole basename. */
export function nativeIdFromFileName(path: string): string {
  const base = basename(path).replace(/\.jsonl$/, "");
  const underscore = base.indexOf("_");
  return underscore >= 0 ? base.slice(underscore + 1) : base;
}

/** The escaped cwd directory name a session file sits in (opaque — never inverted). */
export function encodedDirOf(sessionPath: string): string {
  return basename(dirname(sessionPath));
}
