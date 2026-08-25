import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIF_VERSION, validateSession, type SifSession } from "@sinter/core";
import { DevinAdapter } from "../src/index";

let root: string;
let dbPath: string;

function message(role: string, content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    message_id: crypto.randomUUID(),
    role,
    content,
    ...extra,
    metadata: {
      created_at: "2026-08-19T01:00:00.000Z",
      ...((extra.metadata as Record<string, unknown> | undefined) ?? {}),
    },
  });
}

function createStore(): void {
  const db = new Database(dbPath);
  db.run("CREATE TABLE refinery_schema_history(version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT)");
  db.run("INSERT INTO refinery_schema_history VALUES (7, 'messages', '', '')");
  db.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
    model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
    shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT,
    hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT
  )`);
  db.run(`CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
    created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id)
  )`);
  db.run(`CREATE TABLE tool_call_state (
    session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, tool_call_json TEXT,
    tool_call_update_json TEXT, PRIMARY KEY(session_id, tool_call_id)
  )`);
  db.query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "bright-river",
    "/Users/test/project",
    "windsurf",
    "gpt-5-6-sol-medium",
    "accept-edits",
    1787100000,
    1787100300,
    "Fix the parser",
    3,
    0,
    null,
    JSON.stringify(["/Users/test/shared"]),
    0,
    null,
  );
  const insert = db.query("INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at,metadata) VALUES (?, ?, ?, ?, ?, NULL)");
  insert.run("bright-river", 0, null, message("user", "Please fix it", {
    metadata: {
      is_user_input: true,
      created_at: "2026-08-19T01:00:00.000Z",
      extensions: { "chisel/acp-content-blocks": [{ type: "text", text: "Please fix it" }] },
    },
  }), 1787100000);
  insert.run("bright-river", 1, 0, message("assistant", "I will inspect it.", {
    generation_model: "gpt-5-6-sol-medium",
    thinking: { thinking: "trace parser", signature: { opaque: true } },
    tool_calls: [{ id: "call-1", name: "read", arguments: { file_path: "src/a.ts" }, index: 0, kind: "function" }],
    metadata: { created_at: "2026-08-19T01:00:10.000Z", metrics: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 4 }, finish_reason: "tool_use" },
  }), 1787100010);
  insert.run("bright-river", 2, 1, message("tool", "const value = 1;", {
    tool_call_id: "call-1",
    metadata: { created_at: "2026-08-19T01:00:11.000Z", extensions: { "chisel/tool_result_meta": { success: true } } },
  }), 1787100011);
  insert.run("bright-river", 3, 2, message("assistant", "Fixed.", { generation_model: "gpt-5-6-sol-medium" }), 1787100020);
  db.close();
}

function portableSession(): SifSession {
  return {
    sif: SIF_VERSION,
    id: "portable",
    origin: { harness: "omp", nativeId: "source-1" },
    cwd: "/Users/test/imported",
    title: { text: "Imported work", source: "user" },
    createdAt: "2026-08-18T00:00:00.000Z",
    entries: [
      { kind: "user", id: "u1", parentId: null, content: [{ type: "text", text: "Run the check" }] },
      { kind: "assistant", id: "a1", parentId: "u1", content: [{ type: "toolCall", callId: "c1", name: "exec", args: { command: "bun test" } }] },
      { kind: "toolResult", id: "t1", parentId: "a1", callId: "c1", toolName: "exec", content: [{ type: "text", text: "4 pass" }] },
      { kind: "assistant", id: "a2", parentId: "t1", content: [{ type: "text", text: "All checks pass." }] },
    ],
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sinter-devin-test-"));
  dbPath = join(root, "sessions.db");
  createStore();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("DevinAdapter", () => {
  test("detects and cheaply lists the Devin store", async () => {
    const adapter = new DevinAdapter({ dbPath });
    expect(await adapter.detect()).toEqual({
      harness: "devin",
      paths: [dbPath],
      version: "schema-7",
      notes: "SQLite message tree; local Devin CLI sessions",
    });
    const rows = [];
    for await (const row of adapter.list()) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      harness: "devin",
      nativeId: "bright-river",
      cwd: "/Users/test/project",
      title: "Fix the parser",
      firstPrompt: "Please fix it",
      messageCount: 4,
      model: "gpt-5-6-sol-medium",
    });
  });

  test("reads message topology, reasoning, tools, usage, and workspace roots into SIF", async () => {
    const adapter = new DevinAdapter({ dbPath });
    const session = await adapter.read({ harness: "devin", nativeId: "bright-river" });
    expect(session.origin).toEqual({ harness: "devin", nativeId: "bright-river", nativePath: dbPath });
    expect(session.additionalDirs).toEqual(["/Users/test/shared"]);
    expect(session.entries.map((entry) => [entry.kind, entry.id, entry.parentId])).toEqual([
      ["user", "d0", null],
      ["assistant", "d1", "d0"],
      ["toolResult", "d2", "d1"],
      ["assistant", "d3", "d2"],
    ]);
    const assistant = session.entries[1];
    expect(assistant.kind).toBe("assistant");
    if (assistant.kind !== "assistant") throw new Error("expected assistant");
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "trace parser", signature: '{"opaque":true}' },
      { type: "text", text: "I will inspect it." },
      { type: "toolCall", callId: "call-1", name: "read", args: { file_path: "src/a.ts" } },
    ]);
    expect(assistant.usage).toEqual({ input: 12, output: 8, cacheRead: 4 });
    expect(session.usage).toEqual({ input: 12, output: 8, cacheRead: 4 });
    expect(validateSession(session)).toEqual([]);
  });

  test("writes a new resumable session with inert historical tools by default", async () => {
    const adapter = new DevinAdapter({ dbPath });
    const ref = await adapter.write(portableSession(), { mode: "compact" });
    expect(ref.harness).toBe("devin");
    expect(ref.nativeId).toMatch(/^sinter-[0-9a-f]{12}$/);
    expect(ref.created).toEqual([dbPath]);
    expect(adapter.resumeCommand(ref)).toEqual(["devin", "--resume", ref.nativeId]);

    const db = new Database(dbPath, { readonly: true });
    const row = db.query<{ main_chain_id: number; metadata: string }, [string]>("SELECT main_chain_id, metadata FROM sessions WHERE id = ?").get(ref.nativeId)!;
    const messages = db.query<{ role: string; content: string }, [string]>("SELECT json_extract(chat_message, '$.role') AS role, json_extract(chat_message, '$.content') AS content FROM message_nodes WHERE session_id = ? ORDER BY node_id").all(ref.nativeId);
    db.close();
    expect(row.main_chain_id).toBe(2);
    expect(JSON.parse(row.metadata).sinter.chain.at(-1).harness).toBe("devin");
    expect(JSON.parse(row.metadata).sinter.mode).toBe("compact");
    expect(messages.map((item) => item.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[1]!.content).toContain("[historical tool call: exec");
    expect(messages[1]!.content).toContain("4 pass");

    const restored = await adapter.read({ harness: "devin", nativeId: ref.nativeId });
    expect(restored.title?.text).toBe("Imported work");
    expect(restored.preserve?.sinter).toBeDefined();
    expect(validateSession(restored)).toEqual([]);
  });

  test("drops source-provider reasoning state when writing across harnesses", async () => {
    const adapter = new DevinAdapter({ dbPath });
    const session = portableSession();
    session.entries[1] = {
      kind: "assistant",
      id: "a1",
      parentId: "u1",
      model: { provider: "openai-codex", id: "gpt-5.6-terra" },
      content: [
        { type: "thinking", thinking: "provider-bound", signature: "foreign-signature" },
        { type: "text", text: "Portable answer." },
      ],
    };
    session.entries = session.entries.slice(0, 2);
    const ref = await adapter.write(session);
    const db = new Database(dbPath, { readonly: true });
    const assistant = JSON.parse(db.query<{ chat_message: string }, [string]>(
      "SELECT chat_message FROM message_nodes WHERE session_id = ? AND json_extract(chat_message, '$.role') = 'assistant' LIMIT 1",
    ).get(ref.nativeId)!.chat_message);
    db.close();
    expect(assistant.thinking).toBeUndefined();
    expect(assistant.generation_model).toBeUndefined();
    expect(assistant.content).toBe("Portable answer.");
  });

  test("caps oversized foreign histories before Devin attempts automatic compaction", async () => {
    const adapter = new DevinAdapter({ dbPath });
    const session = portableSession();
    session.entries = [{ kind: "user", id: "u0", parentId: null, content: [{ type: "text", text: "Original objective" }] }];
    let parentId = "u0";
    for (let i = 0; i < 240; i++) {
      const id = `a${i}`;
      session.entries.push({ kind: "assistant", id, parentId, content: [{ type: "text", text: `${i}:` + "x".repeat(4_000) }] });
      parentId = id;
    }
    session.entries.push({ kind: "user", id: "latest", parentId, content: [{ type: "text", text: "Latest question" }] });
    const plan = await adapter.planWrite(session);
    expect(plan.context).toMatchObject({
      unit: "bytes",
      limit: 200_000,
      strategy: "opening-and-tail",
    });
    expect(plan.context!.before).toBeGreaterThan(plan.context!.limit);
    expect(plan.context!.after).toBeLessThanOrEqual(plan.context!.limit);
    expect(plan.context!.omittedEntries).toBeGreaterThan(0);
    const ref = await adapter.write(session);
    const db = new Database(dbPath, { readonly: true });
    const stats = db.query<{ nodes: number; bytes: number; main_chain_id: number }, [string]>(`
      SELECT count(m.node_id) AS nodes, sum(length(m.chat_message)) AS bytes, s.main_chain_id
      FROM sessions s JOIN message_nodes m ON m.session_id = s.id WHERE s.id = ? GROUP BY s.id
    `).get(ref.nativeId)!;
    const contents = db.query<{ content: string }, [string]>(
      "SELECT json_extract(chat_message, '$.content') AS content FROM message_nodes WHERE session_id = ? ORDER BY node_id",
    ).all(ref.nativeId).map((row) => row.content);
    db.close();
    expect(stats.nodes).toBeLessThan(session.entries.length);
    expect(stats.bytes).toBe(plan.context!.after);
    expect(stats.bytes).toBeLessThan(210_000);
    expect(stats.main_chain_id).toBe(stats.nodes - 1);
    expect(contents[0]).toBe("Original objective");
    expect(contents.some((content) => content.includes("older messages") && content.includes("omitted"))).toBe(true);
    expect(contents.at(-1)).toBe("Latest question");
  });

  test("same-harness writes preserve Devin settings and the selected active branch", async () => {
    const db = new Database(dbPath);
    db.query("INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at,metadata) VALUES (?, ?, ?, ?, ?, NULL)").run(
      "bright-river",
      4,
      0,
      message("assistant", "Alternate branch."),
      1787100030,
    );
    db.close();
    const adapter = new DevinAdapter({ dbPath });
    const original = await adapter.read({ harness: "devin", nativeId: "bright-river" });
    const ref = await adapter.write(original, { liveTools: true });
    const check = new Database(dbPath, { readonly: true });
    const row = check.query<{ backend_type: string; model: string; agent_mode: string; main_chain_id: number; workspace_dirs: string }, [string]>(
      "SELECT backend_type, model, agent_mode, main_chain_id, workspace_dirs FROM sessions WHERE id = ?",
    ).get(ref.nativeId)!;
    check.close();
    expect(row).toEqual({
      backend_type: "windsurf",
      model: "gpt-5-6-sol-medium",
      agent_mode: "accept-edits",
      main_chain_id: 3,
      workspace_dirs: '["/Users/test/shared"]',
    });
  });

  test("dry-run does not write and live-tools retains call/result records", async () => {
    const adapter = new DevinAdapter({ dbPath });
    const dry = await adapter.write(portableSession(), { dryRun: true });
    expect(dry.created).toEqual([]);
    const live = await adapter.write(portableSession(), { liveTools: true });
    const restored = await adapter.read({ harness: "devin", nativeId: live.nativeId });
    expect(restored.entries.some((entry) => entry.kind === "toolResult")).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    const count = db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM sessions WHERE id = ?").get(dry.nativeId)!.count;
    db.close();
    expect(count).toBe(0);
  });
});
