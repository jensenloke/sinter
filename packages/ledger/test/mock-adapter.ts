/**
 * Mock adapter used by the ledger + CLI tests. The six real adapters are built
 * in parallel by other agents, so nothing here may depend on them.
 */
import type {
  HarnessAdapter,
  HarnessId,
  NativeRef,
  SessionRef,
  SessionSummary,
  SifSession,
  StoreInfo,
  WriteOpts,
} from "@sinter/core";
import { SIF_VERSION, buildProvenance, withProvenance } from "@sinter/core";

export interface MockOpts {
  id?: HarnessId;
  summaries?: SessionSummary[];
  sessions?: Record<string, SifSession>;
  throwOnList?: string;
  detect?: StoreInfo | null;
}

export class MockAdapter implements HarnessAdapter {
  readonly id: HarnessId;
  summaries: SessionSummary[];
  sessions: Record<string, SifSession>;
  throwOnList?: string;
  written: { session: SifSession; opts?: WriteOpts }[] = [];
  private detectInfo: StoreInfo | null;

  constructor(opts: MockOpts = {}) {
    this.id = opts.id ?? "claude";
    this.summaries = opts.summaries ?? [];
    this.sessions = opts.sessions ?? {};
    this.throwOnList = opts.throwOnList;
    this.detectInfo =
      opts.detect === undefined
        ? { harness: this.id, paths: [`/tmp/mock-${this.id}`], version: "0.0.0-mock" }
        : opts.detect;
  }

  async detect(): Promise<StoreInfo | null> {
    return this.detectInfo;
  }

  async *list(): AsyncIterable<SessionSummary> {
    for (const s of this.summaries) {
      if (this.throwOnList && s.nativeId === this.throwOnList) throw new Error(this.throwOnList);
      yield { ...s, harness: s.harness ?? this.id };
    }
    if (this.throwOnList === "*") throw new Error("store unreadable");
  }

  async read(ref: SessionRef): Promise<SifSession> {
    const s = this.sessions[ref.nativeId];
    if (!s) throw new Error(`no such session ${ref.nativeId}`);
    return structuredClone(s);
  }

  /**
   * Mirrors what the real writers do: mint a new native id, stamp a provenance
   * record extending the source's chain, report it on the ref, and make the
   * written session readable back with the record attached. That is what lets
   * the CLI tests exercise multi-hop lineage without a real harness store.
   */
  async write(session: SifSession, opts?: WriteOpts): Promise<NativeRef> {
    this.written.push({ session, opts });
    const nativeId = `new-${this.id}-${this.written.length}`;
    const provenance = buildProvenance({
      source: session,
      target: { harness: this.id, nativeId },
      sinterVersion: "0.1.0-mock",
      portedAt: new Date().toISOString(),
      mode: opts?.mode,
      inertTools: !opts?.liveTools,
    });
    if (!opts?.dryRun) {
      this.sessions[nativeId] = withProvenance(
        { ...structuredClone(session), origin: { harness: this.id, nativeId } },
        provenance,
      );
      // A real store lists what it holds, so a rescan must find the new session.
      this.summaries = [
        ...this.summaries,
        {
          harness: this.id,
          nativeId,
          nativePath: `/tmp/mock-${this.id}/${nativeId}.jsonl`,
          cwd: session.cwd,
          title: session.title?.text,
          createdAt: provenance.portedAt,
          updatedAt: provenance.portedAt,
          messageCount: session.entries.length,
        },
      ];
    }
    return {
      harness: this.id,
      nativeId,
      nativePath: `/tmp/mock-${this.id}/${nativeId}.jsonl`,
      created: [`/tmp/mock-${this.id}/${nativeId}.jsonl`],
      provenance,
    };
  }

  resumeCommand(ref: SessionRef): string[] {
    return [this.id, "--resume", ref.nativeId];
  }
}

export function summary(over: Partial<SessionSummary> & { nativeId: string }): SessionSummary {
  return {
    harness: "claude",
    cwd: "/Users/test/proj",
    title: "a mock session",
    firstPrompt: "hello world",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    messageCount: 4,
    model: "sonnet",
    ...over,
  };
}

export function session(nativeId: string, harness: HarnessId = "claude"): SifSession {
  return {
    sif: SIF_VERSION,
    id: `sif-${nativeId}`,
    origin: { harness, nativeId, nativePath: `/tmp/mock-${harness}/${nativeId}.jsonl` },
    cwd: "/Users/test/proj",
    title: { text: "a mock session", source: "auto" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    entries: [
      {
        kind: "user",
        id: "e1",
        parentId: null,
        ts: "2026-08-01T00:00:00.000Z",
        content: [{ type: "text", text: "hello world" }],
        raw: { native: true },
      },
      {
        kind: "assistant",
        id: "e2",
        parentId: "e1",
        ts: "2026-08-01T00:00:10.000Z",
        model: { id: "sonnet" },
        content: [
          { type: "thinking", thinking: "pondering" },
          { type: "text", text: "hi there" },
          { type: "toolCall", callId: "c1", name: "Read", args: { file: "/tmp/x" } },
        ],
        raw: { native: true },
      },
      {
        kind: "toolResult",
        id: "e3",
        parentId: "e2",
        callId: "c1",
        toolName: "Read",
        content: [{ type: "text", text: "line1\nline2\nline3" }],
        raw: { native: true },
      },
    ],
  };
}
