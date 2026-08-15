import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSession, threadPath, type SifSession } from "@sinter/core";
import { ClaudeAdapter } from "../src/index";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "claude", "projects");
const adapter = new ClaudeAdapter({ root: FIXTURES });

const TOOLS_SESSION = "c52eb7c1-baef-404e-80bb-5607dcf73983";
const SUB_SESSION = "ec1e8c0f-f3b3-4d83-b2f8-4b68a073a9df";
const SUB_AGENT = "a72d6e87943536c36";

let toolsCache: SifSession | undefined;
const toolsSession = async () =>
  (toolsCache ??= await adapter.read({ harness: "claude", nativeId: TOOLS_SESSION }));
let subCache: SifSession | undefined;
const subSession = async () =>
  (subCache ??= await adapter.read({ harness: "claude", nativeId: SUB_SESSION }));

describe("detect", () => {
  test("finds the fixture store", async () => {
    const info = await adapter.detect();
    expect(info?.harness).toBe("claude");
    expect(info?.paths).toEqual([FIXTURES]);
    expect(info?.version).toMatch(/^\d+\./);
  });

  test("returns null when the store is absent", async () => {
    const missing = new ClaudeAdapter({ root: join(FIXTURES, "does-not-exist") });
    expect(await missing.detect()).toBeNull();
  });
});

describe("list", () => {
  test("enumerates indexed, unindexed and subagent sessions", async () => {
    const rows = [];
    for await (const r of adapter.list()) rows.push(r);
    const ids = rows.map((r) => r.nativeId);

    expect(ids).toContain(TOOLS_SESSION); // no index in that project dir -> head scan
    expect(ids).toContain(SUB_SESSION); // via sessions-index.json
    expect(ids).toContain(`${SUB_SESSION}/agent-${SUB_AGENT}`);
    for (const r of rows) expect(r.harness).toBe("claude");
  });

  test("index rows whose file is gone are marked ghost", async () => {
    const rows = [];
    for await (const r of adapter.list()) rows.push(r);
    const ghost = rows.find((r) => r.ghost);
    expect(ghost?.ghost).toBe(true);
    const live = rows.find((r) => r.nativeId === SUB_SESSION);
    expect(live?.ghost).toBeUndefined();
    expect(live?.title).toBeTruthy();
    expect(live?.cwd).toBe("/workspace/synthetic-project");
  });

  test("head-scanned rows get cwd from records, never from the dir name", async () => {
    const rows = [];
    for await (const r of adapter.list()) rows.push(r);
    const row = rows.find((r) => r.nativeId === TOOLS_SESSION)!;
    expect(row.cwd).toBe("/workspace/synthetic-project");
    expect(row.firstPrompt).toBeTruthy();
    expect(row.updatedAt).toBeTruthy();
  });

  test("subagent rows carry parent linkage", async () => {
    const rows = [];
    for await (const r of adapter.list()) rows.push(r);
    const sub = rows.find((r) => r.nativeId === `${SUB_SESSION}/agent-${SUB_AGENT}`)!;
    expect(sub.isSubagent).toBe(true);
    expect(sub.parentNativeId).toBe(SUB_SESSION);
    expect(sub.title).toBeTruthy();
  });
});

describe("read — structure", () => {
  test("produces a valid SIF session", async () => {
    const s = await toolsSession();
    expect(() => validateSession(s)).not.toThrow();
    expect(s.sif).toBe("sif/0");
    expect(s.origin).toMatchObject({ harness: "claude", nativeId: TOOLS_SESSION });
    expect(s.cwd).toBe("/workspace/synthetic-project");
    expect(s.createdAt).toBeTruthy();
    expect(s.updatedAt).toBeTruthy();
  });

  test("every entry carries origin and raw", async () => {
    const s = await toolsSession();
    for (const e of s.entries) {
      expect(e.origin?.nativeId).toBeTruthy();
      expect(e.raw).toBeDefined();
    }
  });

  test("throws on an unknown session id", async () => {
    await expect(adapter.read({ harness: "claude", nativeId: "nope" })).rejects.toThrow(/not found/);
  });
});

describe("read — tree topology", () => {
  test("entry ids match source uuids and parents resolve", async () => {
    const s = await toolsSession();
    const ids = new Set(s.entries.map((e) => e.id));
    let roots = 0;
    for (const e of s.entries) {
      if (e.parentId === null) roots++;
      else expect(ids.has(e.parentId)).toBe(true);
    }
    expect(roots).toBeGreaterThanOrEqual(1);
  });

  test("branch topology is preserved, not flattened to a chain", async () => {
    const s = await toolsSession();
    const childCount = new Map<string, number>();
    for (const e of s.entries)
      if (e.parentId) childCount.set(e.parentId, (childCount.get(e.parentId) ?? 0) + 1);
    // Claude splits one assistant message into several records and hangs each
    // tool result off its own tool_use record -> real branching must survive.
    const branching = [...childCount.values()].filter((n) => n > 1).length;
    expect(branching).toBeGreaterThan(0);
  });

  test("threadPath walks from a leaf back to a root", async () => {
    const s = await toolsSession();
    const path = threadPath(s);
    expect(path.length).toBeGreaterThan(1);
    expect(path[0]!.parentId).toBeNull();
  });

  test("no entry is its own ancestor", async () => {
    const s = await toolsSession();
    const byId = new Map(s.entries.map((e) => [e.id, e]));
    for (const e of s.entries) {
      const seen = new Set<string>([e.id]);
      let cur = e.parentId;
      while (cur) {
        expect(seen.has(cur)).toBe(false);
        seen.add(cur);
        cur = byId.get(cur)?.parentId ?? null;
      }
    }
  });
});

describe("read — tool calls and results", () => {
  test("every tool result pairs with its call and inherits the tool name", async () => {
    const s = await toolsSession();
    const calls = new Map<string, string>();
    for (const e of s.entries)
      if (e.kind === "assistant")
        for (const p of e.content) if (p.type === "toolCall") calls.set(p.callId, p.name);
    const results = s.entries.filter((e) => e.kind === "toolResult");
    expect(results.length).toBeGreaterThan(5);
    for (const r of results) {
      expect(calls.has(r.callId)).toBe(true);
      expect(r.toolName).toBe(calls.get(r.callId)!);
      expect(r.toolName).not.toBe("unknown");
    }
  });

  test("tool results are toolResult entries, never user entries", async () => {
    const s = await toolsSession();
    for (const e of s.entries) {
      if (e.kind !== "user") continue;
      const raw = e.raw as any;
      const blocks = Array.isArray(raw?.message?.content) ? raw.message.content : [];
      expect(blocks.some((b: any) => b?.type === "tool_result")).toBe(false);
    }
  });

  test("tool call args are preserved", async () => {
    const s = await toolsSession();
    const call = s.entries
      .flatMap((e) => (e.kind === "assistant" ? e.content : []))
      .find((p) => p.type === "toolCall" && p.name === "Read");
    expect(call).toBeDefined();
    expect((call as any).args).toBeTypeOf("object");
  });
});

describe("read — thinking fidelity", () => {
  test("thinking parts keep their provider signature", async () => {
    const s = await toolsSession();
    const thinking = s.entries
      .flatMap((e) => (e.kind === "assistant" ? e.content : []))
      .filter((p) => p.type === "thinking") as { thinking: string; signature?: string }[];
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking.every((t) => typeof t.signature === "string" && t.signature.length > 20)).toBe(
      true,
    );
  });
});

describe("read — usage", () => {
  test("usage is counted once per message.id, not per split record", async () => {
    const s = await toolsSession();
    const withUsage = s.entries.filter((e) => e.kind === "assistant" && e.usage);
    const msgIds = new Set(
      s.entries
        .filter((e) => e.kind === "assistant")
        .map((e) => (e.raw as any)?.message?.id)
        .filter(Boolean),
    );
    expect(withUsage.length).toBe(msgIds.size);
    expect(s.usage?.output).toBeGreaterThan(0);
    expect(s.usage?.input).toBeGreaterThanOrEqual(0);
  });

  test("model is recorded on assistant entries", async () => {
    const s = await toolsSession();
    const a = s.entries.find((e) => e.kind === "assistant" && e.model) as any;
    expect(a.model.provider).toBe("anthropic");
    expect(a.model.id).toBeTruthy();
  });
});

describe("read — notes and control records", () => {
  test("attachment and system records become notes, keeping the tree dense", async () => {
    const s = await toolsSession();
    const notes = s.entries.filter((e) => e.kind === "note");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.kind === "note" && n.noteType.length > 0)).toBe(true);
    expect(notes.some((n) => n.kind === "note" && n.noteType.startsWith("attachment:"))).toBe(true);
  });

  test("uuid-less control records are preserved, not dropped", async () => {
    const s = await toolsSession();
    const control = s.preserve?.controlRecords as any[];
    expect(Array.isArray(control)).toBe(true);
    const types = new Set(control.map((r) => r.type));
    expect(types.has("mode")).toBe(true);
    expect(types.has("permission-mode")).toBe(true);
    expect(types.has("last-prompt")).toBe(true);
  });

  test("last-prompt leaf (the resume head) is captured", async () => {
    const s = await toolsSession();
    expect(typeof s.preserve?.lastPromptLeafUuid).toBe("string");
    // the head pointer must name a record we actually kept
    const ids = new Set(s.entries.map((e) => e.id));
    expect(ids.has(s.preserve!.lastPromptLeafUuid as string)).toBe(true);
  });

  test("harness version is preserved", async () => {
    const s = await toolsSession();
    expect(String(s.preserve?.claudeVersion)).toMatch(/^\d+\./);
  });
});

describe("read — subagents", () => {
  test("subagent transcript is loaded as a subsession", async () => {
    const s = await subSession();
    expect(s.subsessions?.length).toBe(1);
    const sub = s.subsessions![0]!;
    expect(sub.origin.nativeId).toBe(`${SUB_SESSION}/agent-${SUB_AGENT}`);
    expect(sub.entries.length).toBeGreaterThan(3);
    expect(sub.preserve?.agentId).toBe(SUB_AGENT);
    expect(() => validateSession(sub)).not.toThrow();
  });

  test("subsession entry links the parent Task call to the subagent file", async () => {
    const s = await subSession();
    const link = s.entries.find((e) => e.kind === "subsession") as any;
    expect(link).toBeDefined();
    expect(link.sessionRef).toBe(s.subsessions![0]!.origin.nativeId);
    expect(link.agentName).toBeTruthy();

    // it hangs off the assistant entry carrying the matching Task tool_use
    const meta = link.raw as any;
    const anchor = s.entries.find((e) => e.id === link.parentId) as any;
    expect(anchor.kind).toBe("assistant");
    expect(
      anchor.content.some((p: any) => p.type === "toolCall" && p.callId === meta.toolUseId),
    ).toBe(true);
    // and the parent-visible result text came back with it
    expect(typeof link.resultText).toBe("string");
  });

  test("subagent file is readable directly by its composite id", async () => {
    const sub = await adapter.read({
      harness: "claude",
      nativeId: `${SUB_SESSION}/agent-${SUB_AGENT}`,
    });
    expect(sub.origin.nativeId).toBe(`${SUB_SESSION}/agent-${SUB_AGENT}`);
    expect(sub.subsessions).toBeUndefined();
    expect(sub.entries[0]!.parentId).toBeNull();
    expect((sub.entries[0]!.raw as any).isSidechain).toBe(true);
  });

  test("the sidechain session itself is valid and cwd comes from records", async () => {
    const s = await subSession();
    expect(() => validateSession(s)).not.toThrow();
    expect(s.cwd).toBe("/workspace/synthetic-project");
    expect(s.subsessions![0]!.cwd).toBe("/workspace/synthetic-project");
  });
});

describe("resumeCommand", () => {
  test("resumes by native session id", () => {
    expect(adapter.resumeCommand({ harness: "claude", nativeId: TOOLS_SESSION })).toEqual([
      "claude",
      "--resume",
      TOOLS_SESSION,
    ]);
  });

  test("a subagent resumes through its parent session", () => {
    expect(
      adapter.resumeCommand({ harness: "claude", nativeId: `${SUB_SESSION}/agent-${SUB_AGENT}` }),
    ).toEqual(["claude", "--resume", SUB_SESSION]);
  });
});

describe("write", () => {
  test("writes a resumeable indexed session with provenance and carry-forward", async () => {
    const root = mkdtempSync(join(tmpdir(), "sinter-claude-write-"));
    const oldSinterHome = process.env.SINTER_HOME;
    process.env.SINTER_HOME = join(root, "sinter-home");
    try {
      const source = await toolsSession();
      const target = new ClaudeAdapter({ root: join(root, "projects") });
      const ref = await target.write(source, { cwd: "/tmp/ported-claude" });
      const nativePath = ref.nativePath;
      expect(typeof nativePath).toBe("string");
      if (typeof nativePath !== "string") throw new Error("writer did not report a transcript path");
      expect(ref.created).toHaveLength(2);

      const native = await target.read({ harness: "claude", nativeId: ref.nativeId, nativePath });
      validateSession(native);
      expect(native.cwd).toBe("/tmp/ported-claude");
      expect(native.origin.nativeId).toBe(ref.nativeId);
      expect(native.preserve?.sinter).toBeDefined();
      expect(native.entries.some((entry) => entry.kind === "toolResult")).toBe(false);
      expect(JSON.stringify(native.entries)).toContain("historical tool call");

      const carried = await target.readWithCarry({ harness: "claude", nativeId: ref.nativeId, nativePath });
      expect(carried.entries).toEqual(source.entries);
      expect((carried.preserve?.sinterCarry as { recoveredFrom?: unknown } | undefined)?.recoveredFrom).toEqual(source.origin);

      const rows: string[] = [];
      for await (const row of target.list()) rows.push(row.nativeId);
      expect(rows).toContain(ref.nativeId);
    } finally {
      if (oldSinterHome === undefined) delete process.env.SINTER_HOME;
      else process.env.SINTER_HOME = oldSinterHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry run writes neither Claude files nor carry sidecars", async () => {
    const root = mkdtempSync(join(tmpdir(), "sinter-claude-dry-"));
    const oldSinterHome = process.env.SINTER_HOME;
    process.env.SINTER_HOME = join(root, "sinter-home");
    try {
      const target = new ClaudeAdapter({ root: join(root, "projects") });
      const ref = await target.write(await toolsSession(), { dryRun: true });
      expect(ref.created).toEqual([]);
      expect(ref.nativePath).toBeDefined();
      expect(existsSync(ref.nativePath!)).toBe(false);
      expect(existsSync(process.env.SINTER_HOME!)).toBe(false);
    } finally {
      if (oldSinterHome === undefined) delete process.env.SINTER_HOME;
      else process.env.SINTER_HOME = oldSinterHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("synthetic edge cases", () => {
  /** Builds a throwaway store so rare shapes stay covered offline. */
  async function withStore(
    name: string,
    records: unknown[],
    fn: (s: SifSession) => void,
    opts: { validate?: boolean } = {},
  ) {
    const root = join(import.meta.dir, `tmp-${name}`);
    const dir = join(root, "-home-demo-tmp");
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const id = "dddddddd-0000-4000-8000-000000000000";
    writeFileSync(join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n"));
    try {
      const s = await new ClaudeAdapter({ root }).read({ harness: "claude", nativeId: id });
      if (opts.validate !== false) validateSession(s);
      fn(s);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const u = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;

  test("compaction summaries become compaction entries, not user turns", async () => {
    await withStore(
      "compact",
      [
        { type: "user", uuid: u(1), parentUuid: null, cwd: "/tmp/z", message: { content: "go" } },
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: u(2),
          parentUuid: null,
          logicalParentUuid: u(1),
          content: "Conversation compacted",
          compactMetadata: { trigger: "manual" },
        },
        {
          type: "user",
          uuid: u(3),
          parentUuid: u(2),
          isCompactSummary: true,
          message: { content: "This session is being continued…" },
        },
      ],
      (s) => {
        const c = s.entries.find((e) => e.kind === "compaction") as any;
        expect(c.summary).toContain("continued");
        // compact_boundary roots itself natively; logicalParentUuid keeps the thread joined
        const boundary = s.entries.find((e) => e.id === u(2))!;
        expect(boundary.parentId).toBe(u(1));
        expect(s.entries.filter((e) => e.parentId === null).length).toBe(1);
      },
    );
  });

  test("a model fallback block becomes a modelChange entry", async () => {
    await withStore(
      "fallback",
      [
        { type: "user", uuid: u(1), parentUuid: null, cwd: "/tmp/z", message: { content: "go" } },
        {
          type: "assistant",
          uuid: u(2),
          parentUuid: u(1),
          message: {
            id: "msg_1",
            model: "claude-fable-5",
            content: [{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } }],
          },
        },
      ],
      (s) => {
        const m = s.entries.find((e) => e.kind === "modelChange") as any;
        expect(m.model).toBe("claude-opus-4-8");
        expect(m.provider).toBe("anthropic");
      },
    );
  });

  test("spilled tool output is recorded by path instead of inlined", async () => {
    await withStore(
      "spill",
      [
        { type: "user", uuid: u(1), parentUuid: null, cwd: "/tmp/z", message: { content: "go" } },
        {
          type: "assistant",
          uuid: u(2),
          parentUuid: u(1),
          message: {
            id: "msg_1",
            model: "claude-opus-4-8",
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "ls" } }],
          },
        },
        {
          type: "user",
          uuid: u(3),
          parentUuid: u(2),
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_x",
                content:
                  "<persisted-output>\nOutput too large (14.8KB). Full output saved to: /tmp/z/tool-results/toolu_x.txt\n\nPreview…",
              },
            ],
          },
          toolUseResult: { stdout: "…" },
        },
      ],
      (s) => {
        expect(s.preserve?.toolResultSpills).toEqual([
          { callId: "toolu_x", path: "/tmp/z/tool-results/toolu_x.txt" },
        ]);
        const tr = s.entries.find((e) => e.kind === "toolResult") as any;
        expect(tr.toolName).toBe("Bash");
        expect(tr.raw.toolUseResult).toBeDefined();
      },
    );
  });

  test("an orphaned tool result keeps the contract's unknown tool name", async () => {
    await withStore(
      "orphan",
      [
        {
          type: "user",
          uuid: u(1),
          parentUuid: null,
          cwd: "/tmp/z",
          message: {
            content: [
              { type: "text", text: "here" },
              { type: "tool_result", tool_use_id: "toolu_gone", content: "x", is_error: true },
            ],
          },
        },
      ],
      (s) => {
        // one record -> a user entry plus a tool result, chained so nothing orphans
        expect(s.entries.map((e) => e.kind)).toEqual(["user", "toolResult"]);
        expect(s.entries[1]!.parentId).toBe(s.entries[0]!.id);
        const tr = s.entries[1] as any;
        expect(tr.toolName).toBe("unknown");
        expect(tr.isError).toBe(true);
        // An unpaired result is legitimate (its call may be lost to compaction):
        // validateSession surfaces it as a warning, not an error.
        const warnings = validateSession(s);
        expect(warnings.some((w) => /unknown callId/.test(w))).toBe(true);
      },
      { validate: false },
    );
  });

  test("cwd falls back to the index projectPath, never to the escaped dir name", async () => {
    const root = join(import.meta.dir, "tmp-cwd");
    const dir = join(root, "-home-demo-workspace-thing");
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const id = "eeeeeeee-0000-4000-8000-000000000000";
    writeFileSync(
      join(dir, `${id}.jsonl`),
      JSON.stringify({ type: "user", uuid: u(1), parentUuid: null, message: { content: "hi" } }),
    );
    writeFileSync(
      join(dir, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        entries: [{ sessionId: id, projectPath: "/home/demo/workspace/thing-with-dashes" }],
      }),
    );
    try {
      const s = await new ClaudeAdapter({ root }).read({ harness: "claude", nativeId: id });
      expect(s.cwd).toBe("/home/demo/workspace/thing-with-dashes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stop reasons map onto the SIF vocabulary", async () => {
    const cases: [string, string][] = [
      ["tool_use", "toolUse"],
      ["max_tokens", "length"],
      ["end_turn", "stop"],
      ["stop_sequence", "stop"],
    ];
    await withStore(
      "stops",
      [
        { type: "user", uuid: u(1), parentUuid: null, cwd: "/tmp/z", message: { content: "go" } },
        ...cases.map(([native], i) => ({
          type: "assistant",
          uuid: u(i + 2),
          parentUuid: u(1),
          message: {
            id: `msg_${i}`,
            model: "claude-opus-4-8",
            stop_reason: native,
            content: [{ type: "text", text: native }],
          },
        })),
      ],
      (s) => {
        const got = s.entries
          .filter((e) => e.kind === "assistant")
          .map((e) => (e as any).stopReason);
        expect(got).toEqual(cases.map(([, sif]) => sif));
      },
    );
  });
});

describe("lenient parsing", () => {
  test("unknown record types survive as notes with raw attached", async () => {
    const dir = join(import.meta.dir, "tmp-lenient", "-home-demo-tmp");
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const uuidA = "11111111-1111-4111-8111-111111111111";
    const uuidB = "22222222-2222-4222-8222-222222222222";
    writeFileSync(
      join(dir, "aaaaaaaa-0000-4000-8000-000000000000.jsonl"),
      [
        JSON.stringify({
          type: "user",
          uuid: uuidA,
          parentUuid: null,
          cwd: "/tmp/x",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "hi" },
        }),
        "{ this is not json",
        JSON.stringify({
          type: "brand-new-record-type",
          uuid: uuidB,
          parentUuid: uuidA,
          timestamp: "2026-01-01T00:00:01.000Z",
          content: "from the future",
        }),
        JSON.stringify({ type: "brand-new-control", sessionId: "x" }),
      ].join("\n"),
    );
    try {
      const a = new ClaudeAdapter({ root: join(import.meta.dir, "tmp-lenient") });
      const s = await a.read({
        harness: "claude",
        nativeId: "aaaaaaaa-0000-4000-8000-000000000000",
      });
      expect(() => validateSession(s)).not.toThrow();
      expect(s.entries.length).toBe(2); // malformed line skipped, not fatal
      const note = s.entries[1] as any;
      expect(note.kind).toBe("note");
      expect(note.noteType).toBe("unknown:brand-new-record-type");
      expect(note.parentId).toBe(uuidA);
      expect(note.raw.type).toBe("brand-new-record-type");
      expect((s.preserve?.controlRecords as any[]).some((r) => r.type === "brand-new-control")).toBe(
        true,
      );
    } finally {
      rmSync(join(import.meta.dir, "tmp-lenient"), { recursive: true, force: true });
    }
  });

  test("children re-parent onto the nearest retained ancestor when a record is dropped", async () => {
    const dir = join(import.meta.dir, "tmp-reparent", "-home-demo-tmp");
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const a = "aaaaaaaa-1111-4111-8111-111111111111";
    const b = "bbbbbbbb-2222-4222-8222-222222222222"; // empty user record -> dropped
    const c = "cccccccc-3333-4333-8333-333333333333";
    writeFileSync(
      join(dir, "bbbbbbbb-0000-4000-8000-000000000000.jsonl"),
      [
        { type: "user", uuid: a, parentUuid: null, cwd: "/tmp/y", message: { content: "root" } },
        { type: "user", uuid: b, parentUuid: a, message: { content: [] } },
        { type: "user", uuid: c, parentUuid: b, message: { content: "leaf" } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    try {
      const ad = new ClaudeAdapter({ root: join(import.meta.dir, "tmp-reparent") });
      const s = await ad.read({
        harness: "claude",
        nativeId: "bbbbbbbb-0000-4000-8000-000000000000",
      });
      expect(s.entries.map((e) => e.id)).toEqual([a, c]);
      expect(s.entries[1]!.parentId).toBe(a); // not a dangling pointer at b
      expect(() => validateSession(s)).not.toThrow();
    } finally {
      rmSync(join(import.meta.dir, "tmp-reparent"), { recursive: true, force: true });
    }
  });
});
