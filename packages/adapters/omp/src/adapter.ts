/** Shared HarnessAdapter implementation, parameterised by dialect. */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import type { HarnessAdapter, NativeRef, SessionRef, StoreInfo, WriteOpts } from "@sinter/core/adapter";
import type { SessionSummary, SifSession } from "@sinter/core/sif";
import { OMP_DIALECT, PI_DIALECT, type Dialect } from "./dialect";
import { findSessionPath, listSessions } from "./lister";
import { storeLayout } from "./paths";
import { type ReadOptions, readSessionFile } from "./reader";
import { type NativeWriteOpts, writeNativeSession } from "./writer";

export interface AdapterOptions {
  /** Override the home directory (tests / alternate profiles). */
  home?: string;
  /** Override the sessions root outright. */
  sessionsDir?: string;
  blobsDir?: string;
}

export class JsonlV3Adapter implements HarnessAdapter {
  readonly dialect: Dialect;
  private readonly opts: AdapterOptions;

  constructor(dialect: Dialect, opts: AdapterOptions = {}) {
    this.dialect = dialect;
    this.opts = opts;
  }

  get id() {
    return this.dialect.harness;
  }

  private layout() {
    const home = this.opts.home ?? homedir();
    const base = storeLayout(this.dialect, home);
    return {
      ...base,
      sessionsDir: this.opts.sessionsDir ?? base.sessionsDir,
      blobsDir: this.opts.blobsDir ?? base.blobsDir,
    };
  }

  async detect(): Promise<StoreInfo | null> {
    const { agentDir, sessionsDir, blobsDir } = this.layout();
    try {
      await readdir(sessionsDir);
    } catch {
      return null; // not installed on this machine — a valid outcome
    }
    let version: string | undefined;
    try {
      const pkg = await Bun.file(
        this.dialect.harness === "omp"
          ? `${homedir()}/node_modules/@oh-my-pi/pi-coding-agent/package.json`
          : "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
      ).json();
      if (typeof pkg?.version === "string") version = pkg.version;
    } catch {
      /* version is best-effort and must never be obtained by running the harness */
    }
    return {
      harness: this.dialect.harness,
      paths: [agentDir, sessionsDir, blobsDir],
      ...(version ? { version } : {}),
      notes: this.dialect.hasSidecar
        ? "session v3 JSONL; 256-byte title slot; sidecar subagent transcripts"
        : "session v3 JSONL; no title slot; no sidecar",
    };
  }

  async *list(): AsyncIterable<SessionSummary> {
    yield* listSessions(this.layout().sessionsDir, this.dialect);
  }

  /**
   * The native view by default: what is actually in the store, flattened tool
   * calls and all. Pass `{ useCarry: true }` (or call `readWithCarry`) when the
   * session is about to be ported ONWARD and you want the original,
   * never-flattened entries the previous port carried forward.
   */
  async read(ref: SessionRef, readOpts: Partial<ReadOptions> = {}): Promise<SifSession> {
    const { sessionsDir, blobsDir } = this.layout();
    const path = ref.nativePath ?? (await findSessionPath(sessionsDir, this.dialect, ref.nativeId));
    if (!path) throw new Error(`${this.dialect.harness}: no session found for ${ref.nativeId}`);
    return readSessionFile(path, { dialect: this.dialect, blobsDir, ...readOpts });
  }

  async write(session: SifSession, opts: WriteOpts & NativeWriteOpts = {}): Promise<NativeRef> {
    const sessionsDir = opts.sessionsDir ?? this.layout().sessionsDir;
    return writeNativeSession(session, this.dialect, { ...opts, sessionsDir });
  }

  resumeCommand(ref: SessionRef): string[] {
    return this.dialect.resumeArgv(ref.nativeId);
  }
}

export class OmpAdapter extends JsonlV3Adapter {
  constructor(opts: AdapterOptions = {}) {
    super(OMP_DIALECT, opts);
  }
}

export class PiAdapter extends JsonlV3Adapter {
  constructor(opts: AdapterOptions = {}) {
    super(PI_DIALECT, opts);
  }
}
