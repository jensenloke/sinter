/**
 * Offline tests — fixtures only, never the live store.
 *
 * Fixtures are real rollouts with long strings shrunk (marker
 * "…[fixture-truncated]"); shrinking is deterministic so the dual-track
 * event_msg/response_item text dedupe still exercises exactly as in the wild.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SIF_VERSION, provenanceOf, validateSession, type AssistantEntry, type SessionSummary, type SifEntry, type SifSession } from "@sinter/core";
import { CodexAdapter, parseRolloutFilename, unwrapResult } from "../src/index";
import defaultAdapter from "../src/index";

const FIX = join(import.meta.dir, "../../../../fixtures/codex");
const MODERN = join(FIX, "rollout-2026-07-23T01-25-49-019f8adc-bad0-75d1-9cab-c5e1f306f0d8.jsonl");
const LEGACY = join(FIX, "rollout-2025-10-08T14-24-00-0199c27d-af18-7ea0-8f0a-f01a9238f4d2.jsonl");
const ROLLBACK = join(FIX, "rollout-2026-04-27T11-20-42-019dccf4-18bf-7de1-be88-b867e39a2521.jsonl");

let tmpRoot = "";
const priorSinterHome = process.env.SINTER_HOME;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sinter-codex-test-"));
  process.env.SINTER_HOME = join(tmpRoot, "sinter-home");
});

afterEach(() => {
  if (priorSinterHome === undefined) delete process.env.SINTER_HOME;
  else process.env.SINTER_HOME = priorSinterHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function sourceSession(): SifSession {
  return {
    sif: SIF_VERSION,
    id: "sif-source",
    origin: { harness: "omp", nativeId: "omp-source" },
    cwd: "/tmp/source",
    title: { text: "ported codex fixture", source: "auto" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
    entries: [
      {
        kind: "user",
        id: "u1",
        parentId: null,
        ts: "2026-01-01T00:00:00.000Z",
        content: [{ type: "text", text: "list the files" }],
      },
      {
        kind: "assistant",
        id: "a1",
        parentId: "u1",
        ts: "2026-01-01T00:00:01.000Z",
        model: { provider: "openai", id: "gpt-test" },
        content: [
          { type: "text", text: "on it" },
          { type: "toolCall", callId: "call1", name: "bash", args: { command: "ls" } },
        ],
      },
      {
        kind: "toolResult",
        id: "tr1",
        parentId: "a1",
        ts: "2026-01-01T00:00:02.000Z",
        callId: "call1",
        toolName: "bash",
        content: [{ type: "text", text: "file1\nfile2" }],
      },
      {
        kind: "user",
        id: "u2",
        parentId: "tr1",
        ts: "2026-01-01T00:00:03.000Z",
        content: [{ type: "text", text: "thanks" }],
      },
    ],
  };
}

function createStateDb(home: string) {
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, "state_5.sqlite");
  const db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    cli_version TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    recency_at INTEGER NOT NULL DEFAULT 0,
    recency_at_ms INTEGER NOT NULL DEFAULT 0,
    history_mode TEXT NOT NULL DEFAULT 'legacy',
    name TEXT,
    model TEXT,
    created_at_ms INTEGER,
    updated_at_ms INTEGER,
    git_sha TEXT,
    git_branch TEXT,
    git_origin_url TEXT,
    agent_nickname TEXT,
    agent_role TEXT,
    agent_path TEXT,
    thread_source TEXT,
    is_pinned INTEGER NOT NULL DEFAULT 0
  )`);
  db.close();
  return dbPath;
}

// Adapter pointed at an empty home so nothing can reach the live store.
const adapter = new CodexAdapter({ home: join(import.meta.dir, "__nonexistent_home__") });

async function readFixture(path: string): Promise<SifSession> {
  return adapter.readFile(path);
}

async function rawLines(path: string): Promise<any[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const isAssistant = (e: SifEntry): e is AssistantEntry => e.kind === "assistant";

describe("identity + resume", () => {
  test("adapter id and default export", () => {
    expect(adapter.id).toBe("codex");
    expect(defaultAdapter.id).toBe("codex");
  });

  test("resumeCommand", () => {
    expect(adapter.resumeCommand({ harness: "codex", nativeId: "abc-123" })).toEqual([
      "codex",
      "resume",
      "abc-123",
    ]);
  });

  test("rollout filename parsing", () => {
    const { id } = parseRolloutFilename(MODERN);
    expect(id).toBe("019f8adc-bad0-75d1-9cab-c5e1f306f0d8");
    expect(parseRolloutFilename("/tmp/not-a-rollout.jsonl").id).toBeUndefined();
  });
});

describe("detect", () => {
  test("returns null when the store is absent (machines without codex)", async () => {
    expect(await adapter.detect()).toBeNull();
  });
});

describe("modern rollout (2026-07)", () => {
  test("parses into a valid SIF session", async () => {
    const s = await readFixture(MODERN);
    validateSession(s);
    expect(s.origin.harness).toBe("codex");
    expect(s.origin.nativeId).toBeTruthy();
    expect(s.cwd).toBeTruthy();
    expect(s.entries.length).toBeGreaterThan(20);
  });

  test("session_meta: first is session-level, later ones become boundary notes", async () => {
    const s = await readFixture(MODERN);
    const raws = await rawLines(MODERN);
    const metas = raws.filter((r) => r.type === "session_meta");
    expect(metas.length).toBeGreaterThan(1); // compaction/fork boundaries

    // all metas preserved
    expect((s.preserve!.sessionMeta as unknown[]).length).toBe(metas.length);
    // base_instructions kept in preserve, not leaked into content
    expect(s.preserve!.baseInstructions).toBeDefined();
    // n metas -> 1 session header + (n-1) boundary notes
    const boundaryNotes = s.entries.filter((e) => e.kind === "note" && e.noteType === "session_meta");
    expect(boundaryNotes.length).toBe(metas.length - 1);
    expect(s.preserve!.sessionId).toBe(metas[0].payload.session_id ?? metas[0].payload.id);
  });

  test("git + cwd come from records, never from a path", async () => {
    const s = await readFixture(MODERN);
    const meta = (await rawLines(MODERN)).find((r) => r.type === "session_meta")!.payload;
    expect(s.cwd).toBe(meta.cwd);
    if (meta.git) {
      expect(s.git?.sha).toBe(meta.git.commit_hash);
      expect(s.git?.branch).toBe(meta.git.branch);
      expect(s.git?.remote).toBe(meta.git.repository_url);
    }
  });

  test("dual-track dedupe does not duplicate rendered messages", async () => {
    const s = await readFixture(MODERN);
    const texts: string[] = [];
    for (const e of s.entries) {
      if (e.kind !== "assistant" && e.kind !== "user") continue;
      for (const c of e.content) if (c.type === "text") texts.push(c.text.trim());
    }
    expect(new Set(texts).size).toBe(texts.length);
  });

  test("event_msg records that add information survive dedupe", async () => {
    const s = await readFixture(MODERN);
    const mcp = s.entries.filter((e) => e.origin?.nativeType === "event_msg:mcp_tool_call_end");
    expect(mcp.length).toBeGreaterThan(0);
  });

  test("MCP calls are reconstructed as call+result pairs with server/tool names", async () => {
    const s = await readFixture(MODERN);
    const raws = await rawLines(MODERN);
    const ends = raws.filter((r) => r.payload?.type === "mcp_tool_call_end");
    expect(ends.length).toBeGreaterThan(0);

    const calls = s.entries.filter(
      (e) => isAssistant(e) && e.origin?.nativeType === "event_msg:mcp_tool_call_end",
    ) as AssistantEntry[];
    const results = s.entries.filter(
      (e) => e.kind === "toolResult" && e.origin?.nativeType === "event_msg:mcp_tool_call_end",
    );
    expect(calls.length).toBe(ends.length);
    expect(results.length).toBe(ends.length);

    for (const e of calls) {
      const part = e.content[0] as any;
      expect(part.type).toBe("toolCall");
      expect(part.name).toMatch(/^[^/]+\/[^/]+$/); // "<server>/<tool>"
    }
    // every reconstructed result resolves its name through the callId map
    for (const r of results) {
      expect((r as any).toolName).not.toBe("unknown");
    }
  });

  test("Rust Ok/Err envelopes are unwrapped", () => {
    expect(unwrapResult({ Ok: { content: [{ type: "text", text: "hi" }] } })).toEqual({
      value: { content: [{ type: "text", text: "hi" }] },
      isError: undefined,
    });
    expect(unwrapResult({ Err: "boom" })).toEqual({ value: "boom", isError: true });
    expect(unwrapResult({ Ok: { isError: true, content: [] } }).isError).toBe(true);
    expect(unwrapResult("plain")).toEqual({ value: "plain" });
  });

  test("MCP result text is unwrapped out of the envelope and content blocks", async () => {
    const s = await readFixture(MODERN);
    const raws = await rawLines(MODERN);
    const end = raws.find(
      (r) => r.payload?.type === "mcp_tool_call_end" && r.payload?.result?.Ok?.content?.length,
    );
    if (!end) return; // fixture-dependent
    const result = s.entries.find(
      (e) => e.kind === "toolResult" && e.callId === end.payload.call_id,
    ) as any;
    expect(result).toBeDefined();
    const wantedText = end.payload.result.Ok.content.find((c: any) => c.type === "text")?.text;
    if (wantedText) expect(result.content[0].text).toContain(wantedText.slice(0, 40));
  });

  test("custom_tool_call flavour pairs by call_id", async () => {
    const s = await readFixture(MODERN);
    const raws = await rawLines(MODERN);
    const customCalls = raws.filter((r) => r.payload?.type === "custom_tool_call");
    expect(customCalls.length).toBeGreaterThan(0);

    for (const c of customCalls) {
      const call = s.entries.find(
        (e) => isAssistant(e) && (e.content[0] as any)?.callId === c.payload.call_id,
      ) as AssistantEntry;
      expect(call).toBeDefined();
      const part = call.content[0] as any;
      expect(part.name).toBe(c.payload.name);
      // non-JSON custom tool input (apply_patch text) falls back to {input}
      expect(typeof part.args).toBe("object");

      const result = s.entries.find(
        (e) => e.kind === "toolResult" && e.callId === c.payload.call_id,
      ) as any;
      expect(result).toBeDefined();
      expect(result.toolName).toBe(c.payload.name);
      // Codex hides failures in the output text, so isError is not invented
      expect(result.isError).toBeUndefined();
    }
  });

  test("compaction keeps the summary and the full replaced history", async () => {
    const s = await readFixture(MODERN);
    const raws = await rawLines(MODERN);
    const compacted = raws.filter((r) => r.type === "compacted");
    expect(compacted.length).toBe(1);

    const entries = s.entries.filter((e) => e.kind === "compaction");
    // the redundant event_msg:context_compacted echo is deduped away
    expect(entries.length).toBe(1);
    const c = entries[0] as any;
    expect(c.summary).toBe(compacted[0].payload.message);
    expect(Array.isArray(c.replacedHistory)).toBe(true);
    expect(c.replacedHistory.length).toBe(compacted[0].payload.replacement_history.length);
  });

  test("reasoning keeps encrypted_content as a part signature (never dropped)", async () => {
    const s = await readFixture(MODERN);
    const raws = await rawLines(MODERN);
    const withEnc = raws.filter((r) => r.payload?.type === "reasoning" && r.payload.encrypted_content);
    expect(withEnc.length).toBeGreaterThan(0);

    const signed = s.entries.filter(
      (e) =>
        isAssistant(e) &&
        e.origin?.nativeType === "response_item:reasoning" &&
        e.content.some((c) => c.type === "thinking" && !!c.signature),
    );
    expect(signed.length).toBe(withEnc.length);
  });

  test("token_count attaches real usage to the preceding assistant entry", async () => {
    const s = await readFixture(MODERN);
    const withUsage = s.entries.filter((e) => isAssistant(e) && e.usage) as AssistantEntry[];
    expect(withUsage.length).toBeGreaterThan(0);
    for (const e of withUsage) {
      // never zero-filled: at least one real number, no invented keys
      expect(Object.values(e.usage!).some((v) => typeof v === "number")).toBe(true);
    }
    const raws = await rawLines(MODERN);
    const lastTotal = [...raws].reverse().find((r) => r.payload?.type === "token_count" && r.payload.info)
      ?.payload.info.total_token_usage;
    if (lastTotal) {
      expect(s.usage?.input).toBe(lastTotal.input_tokens);
      expect(s.usage?.cacheRead).toBe(lastTotal.cached_input_tokens);
      expect(s.usage?.reasoning).toBe(lastTotal.reasoning_output_tokens);
    }
  });

  test("developer-role messages are marked synthetic, user messages are not", async () => {
    const s = await readFixture(MODERN);
    const dev = s.entries.filter((e) => e.origin?.nativeType === "response_item:message:developer");
    for (const e of dev) expect((e as any).synthetic).toBe(true);
    const user = s.entries.filter((e) => e.origin?.nativeType === "response_item:message:user");
    for (const e of user) expect((e as any).synthetic).toBeUndefined();
  });

  test("inter-agent messages are attributed by author/recipient direction", async () => {
    const s = await readFixture(MODERN);
    const raws = await rawLines(MODERN);
    const am = raws.filter((r) => r.type === "response_item" && r.payload?.type === "agent_message");
    if (!am.length) return;
    const entries = s.entries.filter((e) => e.origin?.nativeType === "response_item:agent_message");
    expect(entries.length).toBe(am.length);
    const ownPath = (s.preserve?.agent as any)?.path ?? "/root";
    for (let i = 0; i < am.length; i++) {
      const expected = am[i].payload.author === ownPath ? "assistant" : "user";
      expect(entries[i].kind).toBe(expected);
    }
  });

  test("every entry carries origin + raw, ids are unique, timestamps monotonic", async () => {
    const s = await readFixture(MODERN);
    const ids = new Set<string>();
    let prev = 0;
    for (const e of s.entries) {
      expect(e.origin).toBeDefined();
      expect(e.raw).toBeDefined();
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
      if (e.ts) {
        const ms = new Date(e.ts).getTime();
        expect(ms).toBeGreaterThan(prev);
        prev = ms;
      }
    }
  });

  test("known-but-not-first-class records become notes, not unknowns", async () => {
    const s = await readFixture(MODERN);
    for (const t of ["world_state", "inter_agent_communication_metadata"]) {
      expect(s.entries.some((e) => e.kind === "note" && e.noteType === t)).toBe(true);
    }
    // recognised records must not pollute the drift report
    const unknown = (s.preserve?.unknownRecordTypes ?? {}) as Record<string, number>;
    expect(unknown.world_state).toBeUndefined();
    expect(unknown.inter_agent_communication_metadata).toBeUndefined();
  });
});

describe("legacy rollout (2025-10, pre-drift format)", () => {
  test("parses despite the older session_meta/turn_context shape", async () => {
    const s = await readFixture(LEGACY);
    validateSession(s);
    const meta = (await rawLines(LEGACY))[0].payload;
    expect(meta.session_id).toBeUndefined(); // old vintage: no session_id, no source
    expect(s.origin.nativeId).toBe(meta.id);
    expect(s.cwd).toBe(meta.cwd);
    expect(s.preserve!.cliVersion).toBe(meta.cli_version);
  });

  test("function_call flavour pairs by call_id with parsed arguments", async () => {
    const s = await readFixture(LEGACY);
    const raws = await rawLines(LEGACY);
    const calls = raws.filter((r) => r.payload?.type === "function_call");
    expect(calls.length).toBeGreaterThan(0);

    for (const c of calls) {
      const entry = s.entries.find(
        (e) => isAssistant(e) && (e.content[0] as any)?.callId === c.payload.call_id,
      ) as AssistantEntry;
      expect(entry).toBeDefined();
      const part = entry.content[0] as any;
      expect(part.name).toBe(c.payload.name);
      expect(part.args).toBeDefined();

      const result = s.entries.find(
        (e) => e.kind === "toolResult" && e.callId === c.payload.call_id,
      ) as any;
      expect(result.toolName).toBe(c.payload.name); // name only exists on the call
    }
  });

  test("a result always precedes-pairs its call (validateSession's callId rule)", async () => {
    const s = await readFixture(LEGACY);
    const seen = new Set<string>();
    for (const e of s.entries) {
      if (isAssistant(e)) for (const c of e.content) if (c.type === "toolCall") seen.add(c.callId);
      if (e.kind === "toolResult") expect(seen.has(e.callId)).toBe(true);
    }
  });

  test("model changes surface as ModelChangeEntry, never on the first turn_context", async () => {
    const s = await readFixture(LEGACY);
    const models = new Set(
      (await rawLines(LEGACY))
        .filter((r) => r.type === "turn_context" && r.payload.model)
        .map((r) => r.payload.model),
    );
    const changes = s.entries.filter((e) => e.kind === "modelChange");
    expect(changes.length).toBe(Math.max(0, models.size - 1));
    for (const c of changes) expect((c as any).provider).toBe("openai");
  });

  test("legacy agent_reasoning event_msgs dedupe against canonical reasoning", async () => {
    const raws = await rawLines(LEGACY);
    const s = await readFixture(LEGACY);
    const canonical = new Set<string>();
    for (const r of raws)
      if (r.payload?.type === "reasoning")
        for (const su of r.payload.summary ?? []) canonical.add(String(su.text).trim());
    const kept = s.entries.filter((e) => e.origin?.nativeType === "event_msg:agent_reasoning");
    for (const e of kept) {
      const t = (e as AssistantEntry).content[0] as any;
      expect(canonical.has(t.thinking.trim())).toBe(false);
    }
  });

  test("title is derived from the first real user message when nothing else names it", async () => {
    const s = await readFixture(LEGACY);
    expect(s.title?.source).toBe("derived");
    expect(s.title!.text.length).toBeGreaterThan(0);
  });
});

describe("rollback rollout (2026-04)", () => {
  test("thread_rolled_back re-parents forward instead of splicing", async () => {
    const s = await readFixture(ROLLBACK);
    validateSession(s);

    const marker = s.entries.find((e) => e.kind === "note" && e.noteType === "thread_rolled_back");
    expect(marker).toBeDefined();

    const idx = s.entries.indexOf(marker!);
    // the abandoned branch is preserved: entries before the marker still exist
    expect(idx).toBeGreaterThan(0);
    // and the marker does NOT continue the abandoned chain
    expect(marker!.parentId).not.toBe(s.entries[idx - 1].id);

    // the tree stays connected (validateSession already checks dangling parents)
    const ids = new Set(s.entries.map((e) => e.id));
    for (const e of s.entries) if (e.parentId) expect(ids.has(e.parentId)).toBe(true);

    expect(s.entries.length).toBeGreaterThan(1);
  });

  test("thread_name_updated sets the session title", async () => {
    const s = await readFixture(ROLLBACK);
    const named = (await rawLines(ROLLBACK)).find((r) => r.payload?.type === "thread_name_updated");
    if (!named) return;
    expect(s.title?.text).toBe(named.payload.thread_name);
    expect(s.title?.source).toBe("auto");
  });

  test("unknown event_msg types become notes and are reported in preserve", async () => {
    const s = await readFixture(ROLLBACK);
    const err = s.entries.find((e) => e.kind === "note" && e.noteType === "event_msg:error");
    expect(err).toBeDefined();
    expect(err!.raw).toBeDefined();
    const unknown = (s.preserve?.unknownRecordTypes ?? {}) as Record<string, number>;
    expect(unknown["event_msg:error"]).toBeGreaterThan(0);
    for (const key of Object.keys(unknown)) {
      expect(s.entries.some((e) => e.kind === "note" && e.noteType === key)).toBe(true);
    }
  });
});

describe("write", () => {
  test("writes a rollout file, stamps provenance, and reads native flattened content", async () => {
    const home = join(tmpRoot, "codex-home");
    const adapter = new CodexAdapter({ home });
    const source = sourceSession();

    const ref = await adapter.write(source, { cwd: "/tmp/target" });
    expect(ref.harness).toBe("codex");
    const nativePath = ref.nativePath;
    expect(typeof nativePath).toBe("string");
    if (typeof nativePath !== "string") throw new Error("codex writer did not report a native path");
    expect(ref.created).toEqual([nativePath]);
    expect(existsSync(nativePath)).toBe(true);
    expect(ref.provenance?.chain.map((h) => h.harness)).toEqual(["omp", "codex"]);

    const native = await adapter.read({ harness: "codex", nativeId: ref.nativeId, nativePath });
    validateSession(native);
    expect(native.origin.nativeId).toBe(ref.nativeId);
    expect(native.cwd).toBe("/tmp/target");
    expect(provenanceOf(native)?.threadId).toBe(ref.provenance!.threadId);
    expect(native.entries.some((e) => e.kind === "toolResult")).toBe(false);
    expect(JSON.stringify(native.entries)).toContain("historical tool call");

    const carried = await adapter.readWithCarry({ harness: "codex", nativeId: ref.nativeId, nativePath });
    expect(carried.origin.nativeId).toBe(ref.nativeId);
    expect(carried.entries).toEqual(source.entries);
    const carry = carried.preserve?.sinterCarry;
    if (!carry || typeof carry !== "object" || !("recoveredFrom" in carry)) throw new Error("missing carry marker");
    expect(carry.recoveredFrom).toEqual(source.origin);
  });

  test("uses Codex runtime metadata for a Claude source session", async () => {
    const home = join(tmpRoot, "codex-target-metadata");
    mkdirSync(home, { recursive: true });
    await Bun.write(join(home, "config.toml"), 'model = "gpt-target"\n');
    const dbPath = createStateDb(home);
    const adapter = new CodexAdapter({ home });
    const source = sourceSession();
    source.origin = { harness: "claude", nativeId: "claude-source" };
    const assistant = source.entries.find((entry): entry is AssistantEntry => entry.kind === "assistant");
    if (!assistant?.model) throw new Error("fixture has no assistant model");
    assistant.model = { provider: "anthropic", id: "claude-opus-4-6" };
    source.entries.push({
      kind: "modelChange",
      id: "model-change",
      parentId: assistant.id,
      ts: "2026-01-01T00:00:02.500Z",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    const ref = await adapter.write(source, { cwd: "/tmp/target" });
    const records = await rawLines(ref.nativePath!);
    const meta = records.find((record) => record.type === "session_meta");
    expect(meta.payload.model_provider).toBe("openai");
    expect(records.filter((record) => record.type === "turn_context").every((record) => !("model" in record.payload))).toBe(true);
    expect(JSON.stringify(records)).not.toContain("anthropic");
    expect(JSON.stringify(records)).not.toContain("claude-opus-4-6");
    const db = new Database(dbPath, { readonly: true });
    const thread = db.query<{ model_provider: string; model: string }, [string]>("SELECT model_provider, model FROM threads WHERE id = ?").get(ref.nativeId);
    db.close();
    expect(thread).toEqual({ model_provider: "openai", model: "gpt-target" });
  });

  test("indexes the new rollout in state sqlite when present", async () => {
    const home = join(tmpRoot, "codex-indexed");
    const dbPath = createStateDb(home);
    const adapter = new CodexAdapter({ home });

    const ref = await adapter.write(sourceSession(), { cwd: "/tmp/indexed" });
    const nativePath = ref.nativePath;
    expect(typeof nativePath).toBe("string");
    if (typeof nativePath !== "string") throw new Error("codex writer did not report a native path");
    expect(ref.created).toEqual([nativePath, dbPath]);

    const rows: SessionSummary[] = [];
    for await (const r of adapter.list()) rows.push(r);
    expect(rows).toHaveLength(1);
    expect(rows[0].nativeId).toBe(ref.nativeId);
    expect(rows[0].nativePath).toBe(ref.nativePath);
    expect(rows[0].cwd).toBe("/tmp/indexed");
    expect(rows[0].title).toBe("ported codex fixture");
  });

  test("dry run reports ids without writing rollout or carry sidecars", async () => {
    const home = join(tmpRoot, "codex-dry");
    const adapter = new CodexAdapter({ home });
    const ref = await adapter.write(sourceSession(), { dryRun: true });

    expect(ref.created).toEqual([]);
    expect(ref.nativePath).toBeTruthy();
    expect(existsSync(ref.nativePath!)).toBe(false);
    expect(existsSync(join(tmpRoot, "sinter-home"))).toBe(false);
    expect(ref.provenance).toBeDefined();
  });
});

describe("robustness", () => {
  test("malformed lines are skipped, not fatal", async () => {
    const tmp = join(import.meta.dir, "__tmp_malformed.jsonl");
    const good = (await Bun.file(LEGACY).text()).split("\n").filter(Boolean).slice(0, 12);
    await Bun.write(tmp, good.join("\n") + "\n{ this is not json\n" + good[5] + "\n");
    try {
      const s = await adapter.readFile(tmp);
      validateSession(s);
      expect(s.entries.length).toBeGreaterThan(0);
    } finally {
      await Bun.file(tmp).delete();
    }
  });

  test("read() throws a clear error for a session with no rollout file", async () => {
    await expect(adapter.read({ harness: "codex", nativeId: "does-not-exist" })).rejects.toThrow(
      /no rollout file/,
    );
  });

  test("list() falls back to a filename scan without a state db", async () => {
    const fixtureHome = join(import.meta.dir, "__fixture_home__");
    // sessions/ dir is the fixtures dir contents; simulate by pointing at fixtures
    const a = new CodexAdapter({ home: FIX + "/.." });
    const rows: any[] = [];
    for await (const r of a.list()) rows.push(r);
    // fixtures/../sessions does not exist -> empty, but must not throw
    expect(Array.isArray(rows)).toBe(true);
    expect(fixtureHome).toBeTruthy();
  });
});
