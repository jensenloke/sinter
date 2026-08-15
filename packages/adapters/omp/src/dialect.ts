/**
 * The omp/pi dialect shim. See DIALECTS.md for the empirical findings this encodes.
 *
 * The reader is deliberately dialect-*tolerant* (it accepts both shapes of every
 * divergent record); only the writer and the store layout are dialect-*specific*.
 */

import type { HarnessId } from "@sinter/core/sif";
import type { NativeModelChangeEntry } from "./native";

export interface Dialect {
  harness: HarnessId;
  /** Store root relative to home, e.g. ".omp/agent". */
  agentDirRelative: string;
  /** Does this dialect write the 256-byte fixed-width title slot as line 1? */
  hasTitleSlot: boolean;
  /** Does the header carry `title` / `titleSource`? */
  headerCarriesTitle: boolean;
  /** Does this dialect keep `<session>.jsonl` + `<session>/` sidecar artifacts? */
  hasSidecar: boolean;
  /** cwd → session directory name. NEVER inverted (CONVENTIONS §3). */
  sessionDirName(cwd: string, home: string, tmpdir: string): string;
  /** Serialize a `model_change` entry body for this dialect. */
  modelChangeBody(provider: string | undefined, modelId: string): Record<string, unknown>;
  /** argv to natively resume a session id. */
  resumeArgv(nativeId: string): string[];
  /** argv to resume from a non-default session dir (used by the write self-test). */
  resumeArgvInDir(nativeId: string, dir: string): string[];
}

/** Escape a path fragment the way both harnesses do: `/`, `\` and `:` → `-`. */
function escapeFragment(s: string): string {
  return s.replace(/[/\\:]/g, "-");
}

/** pi + omp's `abs` scope: `--home-demo-workspace--`. session-paths.ts:36-39 */
export function encodeLegacyAbsoluteDirName(absCwd: string): string {
  return `--${escapeFragment(absCwd.replace(/^[/\\]/, ""))}--`;
}

/** omp's relative scopes. session-paths.ts:41-44 */
export function encodeRelativeDirName(prefix: string, relative: string): string {
  const encoded = escapeFragment(relative);
  if (!encoded) return prefix;
  return prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
}

/**
 * macOS symlink folding, mirroring omp's `resolveEquivalentPath` for the one
 * case that actually moves a directory name: `/tmp` → `/private/tmp`,
 * `/var` → `/private/var`.
 */
export function canonicalizePath(p: string): string {
  if (p === "/tmp" || p.startsWith("/tmp/")) return `/private${p}`;
  if (p === "/var" || p.startsWith("/var/")) return `/private${p}`;
  return p;
}

function relativeTo(base: string, target: string): string {
  const b = base.replace(/\/+$/, "");
  if (target === b) return "";
  if (target.startsWith(`${b}/`)) return target.slice(b.length + 1);
  return "";
}

function isUnder(base: string, target: string): boolean {
  const b = base.replace(/\/+$/, "");
  return target === b || target.startsWith(`${b}/`);
}

/** omp: home-relative first, then tmp-relative, then legacy absolute. session-paths.ts:62-88 */
export function ompSessionDirName(cwd: string, home: string, tmpdir: string): string {
  const c = canonicalizePath(cwd);
  const h = canonicalizePath(home);
  const t = canonicalizePath(tmpdir);
  if (isUnder(h, c)) return encodeRelativeDirName("-", relativeTo(h, c));
  if (isUnder(t, c)) return encodeRelativeDirName("-tmp", relativeTo(t, c));
  return encodeLegacyAbsoluteDirName(c);
}

/** pi: one scheme only. session-manager.js:242-247 */
export function piSessionDirName(cwd: string): string {
  return encodeLegacyAbsoluteDirName(canonicalizePath(cwd));
}

export const OMP_DIALECT: Dialect = {
  harness: "omp",
  agentDirRelative: ".omp/agent",
  hasTitleSlot: true,
  headerCarriesTitle: true,
  hasSidecar: true,
  sessionDirName: ompSessionDirName,
  modelChangeBody(provider, modelId) {
    return { model: provider ? `${provider}/${modelId}` : modelId, role: "default" };
  },
  resumeArgv: (id) => ["omp", "--resume", id],
  resumeArgvInDir: (id, dir) => ["omp", "--session-dir", dir, "--resume", id],
};

export const PI_DIALECT: Dialect = {
  harness: "pi",
  agentDirRelative: ".pi/agent",
  hasTitleSlot: false,
  headerCarriesTitle: false,
  hasSidecar: false,
  sessionDirName: (cwd) => piSessionDirName(cwd),
  modelChangeBody(provider, modelId) {
    return { provider: provider ?? "unknown", modelId };
  },
  // `pi --resume` takes NO argument (opens the picker); `--session` is the addressable form.
  resumeArgv: (id) => ["pi", "--session", id],
  resumeArgvInDir: (id, dir) => ["pi", "--session-dir", dir, "--session", id],
};

/**
 * Read a `model_change` in either dialect.
 * omp: `{model:"provider/modelId"}` · pi: `{provider, modelId}`.
 * Splits on the FIRST `/` only — pi model ids contain slashes
 * (e.g. `fireworks/accounts/fireworks/routers/kimi-k2p6-turbo`).
 */
export function parseModelChange(e: NativeModelChangeEntry): { provider?: string; model: string } {
  if (typeof e.modelId === "string" && e.modelId.length > 0) {
    return { provider: typeof e.provider === "string" ? e.provider : undefined, model: e.modelId };
  }
  const m = typeof e.model === "string" ? e.model : "";
  const slash = m.indexOf("/");
  if (slash > 0) return { provider: m.slice(0, slash), model: m.slice(slash + 1) };
  return { model: m };
}
