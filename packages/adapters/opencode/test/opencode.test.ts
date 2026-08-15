import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validateSession, mintSifId, SIF_VERSION, type SifSession } from "@sinter/core";
import { OpencodeAdapter, buildOpencodeExport } from "../src/index";

const MINI_DB = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "opencode", "mini.db");
const EXPORT_SAMPLE = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "opencode", "export-sample.json");
const EXPORT_WITH_TOOLS = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "opencode",
  "export-with-tools.json",
);

const adapter = new OpencodeAdapter(MINI_DB);

const PLAIN_SESSION = "synthetic-1393";
const TOOLS_SESSION = "synthetic-1401";
const CHILD_SESSION = "ses_synthetic_child_0001";

let toolsCache: SifSession | undefined;
const toolsSession = async () => (toolsCache ??= await adapter.read({ harness: "opencode", nativeId: TOOLS_SESSION }));

describe("detect", () => {
  test("finds the fixture db", async () => {
    const info = await adapter.detect();
    expect(info?.harness).toBe("opencode");
    expect(info?.paths).toEqual([MINI_DB]);
    expect(info?.version).toBeTruthy();
  });

  test("returns null when the db is absent", async () => {
    const missing = new OpencodeAdapter(join(MINI_DB, "..", "does-not-exist.db"));
    expect(await missing.detect()).toBeNull();
  });
});

describe("list", () => {
  test("enumerates every session in the store via a single cheap query", async () => {
    const rows = [];
    for await (const r of adapter.list()) rows.push(r);
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.harness).toBe("opencode");
    const plain = rows.find((r) => r.nativeId === PLAIN_SESSION)!;
    expect(plain.title).toMatch(/^Synthetic fixture text/);
    expect(plain.cwd).toBe("/workspace/synthetic-project");
    expect(plain.messageCount).toBeGreaterThan(0);
    expect(plain.usage?.input).toBeGreaterThan(0);
  });

  test("subsession rows carry parent linkage", async () => {
    const rows = [];
    for await (const r of adapter.list()) rows.push(r);
    const child = rows.find((r) => r.nativeId === CHILD_SESSION)!;
    expect(child.isSubagent).toBe(true);
    expect(child.parentNativeId).toBe(PLAIN_SESSION);
  });

  test("cwd comes from the directory column, never inverted from a path escape", async () => {
    const rows = [];
    for await (const r of adapter.list()) rows.push(r);
    for (const r of rows) expect(r.cwd).toBe("/workspace/synthetic-project");
  });
});

describe("read — structure", () => {
  test("produces a valid SIF session", async () => {
    const s = await toolsSession();
    expect(() => validateSession(s)).not.toThrow();
    expect(s.sif).toBe("sif/0");
    expect(s.origin).toMatchObject({ harness: "opencode", nativeId: TOOLS_SESSION });
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
    await expect(adapter.read({ harness: "opencode", nativeId: "ses_nope" })).rejects.toThrow(/not found/);
  });
});

describe("read — tree topology", () => {
  test("fixture contains more than one entry", async () => {
    const s = await toolsSession();
    expect(s.entries.length).toBeGreaterThan(1);
  });

  test("every non-root parentId resolves to a real entry", async () => {
    const s = await toolsSession();
    const ids = new Set(s.entries.map((e) => e.id));
    let roots = 0;
    for (const e of s.entries) {
      if (e.parentId === null) roots++;
      else expect(ids.has(e.parentId)).toBe(true);
    }
    expect(roots).toBeGreaterThanOrEqual(1);
  });
});

describe("read — tool calls and results", () => {
  test("tool parts split into a call on the assistant plus a paired toolResult entry", async () => {
    const s = await toolsSession();
    const calls = new Map<string, string>();
    for (const e of s.entries)
      if (e.kind === "assistant") for (const p of e.content) if (p.type === "toolCall") calls.set(p.callId, p.name);
    expect(calls.size).toBe(2);
    const results = s.entries.filter((e) => e.kind === "toolResult");
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(calls.has(r.callId)).toBe(true);
      expect(r.toolName).toBe(calls.get(r.callId)!);
      expect(r.toolName).not.toBe("unknown");
      expect(r.isError).toBeFalsy();
    }
    expect(new Set(calls.values()).size).toBe(calls.size);
  });

  test("tool result content carries the state.output text", async () => {
    const s = await toolsSession();
    const result = s.entries.find((e) => e.kind === "toolResult") as any;
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBeTruthy();
  });
});

describe("read — reasoning fidelity", () => {
  test("reasoning parts become thinking content on the assistant entry", async () => {
    const s = await toolsSession();
    const thinking = s.entries.flatMap((e) => (e.kind === "assistant" ? e.content : [])).filter((p) => p.type === "thinking");
    expect(thinking.length).toBeGreaterThan(0);
  });
});

describe("read — usage", () => {
  test("token/cost columns roll up onto the session, real zeros included", async () => {
    const s = await toolsSession();
    expect(s.usage?.input).toBeGreaterThan(0);
    expect(s.usage?.output).toBeGreaterThan(0);
    expect(s.usage?.reasoning).toBe(0); // a real recorded zero, not omitted
  });

  test("assistant entries carry model and per-message usage", async () => {
    const s = await toolsSession();
    const a = s.entries.find((e) => e.kind === "assistant" && e.model) as any;
    expect(a.model.provider).toBe("spark-qwen36");
    expect(a.model.id).toBeTruthy();
    expect(a.usage).toBeDefined();
  });
});

describe("read — subsessions", () => {
  test("a session with a child is linked via a subsession entry", async () => {
    const s = await adapter.read({ harness: "opencode", nativeId: PLAIN_SESSION });
    const link = s.entries.find((e) => e.kind === "subsession") as any;
    expect(link).toBeDefined();
    expect(link.sessionRef).toBe(CHILD_SESSION);
  });

  test("the child is embedded one level deep as a full subsession", async () => {
    const s = await adapter.read({ harness: "opencode", nativeId: PLAIN_SESSION });
    expect(s.subsessions?.length).toBe(1);
    const sub = s.subsessions![0]!;
    expect(sub.origin.nativeId).toBe(CHILD_SESSION);
    expect(() => validateSession(sub)).not.toThrow();
  });

  test("the child session is independently readable by its own native id", async () => {
    const sub = await adapter.read({ harness: "opencode", nativeId: CHILD_SESSION });
    expect(sub.entries.length).toBeGreaterThan(0);
    expect(sub.entries[0]!.parentId).toBeNull();
  });
});

describe("resumeCommand", () => {
  test("resumes by native session id via -s/--session", () => {
    expect(adapter.resumeCommand({ harness: "opencode", nativeId: TOOLS_SESSION })).toEqual([
      "opencode",
      "--session",
      TOOLS_SESSION,
    ]);
  });
});

describe("write — shape matches a fresh `opencode export`", () => {
  function makeSifSession(): SifSession {
    return {
      sif: SIF_VERSION,
      id: mintSifId(),
      origin: { harness: "claude", nativeId: "native-abc-123" },
      cwd: "/tmp/some-project",
      title: { text: "a ported session", source: "auto" },
      entries: [
        {
          kind: "user",
          id: "u1",
          parentId: null,
          ts: "2026-01-01T00:00:00.000Z",
          content: [{ type: "text", text: "hello" }],
        },
        {
          kind: "assistant",
          id: "a1",
          parentId: "u1",
          ts: "2026-01-01T00:00:01.000Z",
          content: [
            { type: "text", text: "hi there" },
            { type: "toolCall", callId: "call1", name: "bash", args: { command: "ls" } },
          ],
          model: { provider: "anthropic", id: "claude-x" },
          usage: { input: 10, output: 5 },
        },
        {
          kind: "toolResult",
          id: "tr1",
          parentId: "a1",
          callId: "call1",
          toolName: "bash",
          content: [{ type: "text", text: "file1\nfile2" }],
        },
      ],
    };
  }

  const fs = require("node:fs") as typeof import("node:fs");
  const sample = JSON.parse(fs.readFileSync(EXPORT_SAMPLE, "utf8"));
  const withTools = JSON.parse(fs.readFileSync(EXPORT_WITH_TOOLS, "utf8"));
  // Keys guaranteed across BOTH real exports (e.g. `permission` is present
  // in one fixture but not the other, so it's excluded from the required set).
  const intersectKeys = (a: object, b: object) => new Set([...Object.keys(a)].filter((k) => k in b));
  const infoKeys = intersectKeys(sample.info, withTools.info);
  const userMsgKeys = intersectKeys(
    sample.messages.find((m: any) => m.info.role === "user").info,
    withTools.messages.find((m: any) => m.info.role === "user").info,
  );
  const assistantMsgKeys = intersectKeys(
    sample.messages.find((m: any) => m.info.role === "assistant").info,
    withTools.messages.find((m: any) => m.info.role === "assistant").info,
  );

  test("top-level shape: {info, messages[]}", () => {
    const { payload } = buildOpencodeExport(makeSifSession(), {}, "/tmp/some-project");
    expect(payload).toHaveProperty("info");
    expect(Array.isArray(payload.messages)).toBe(true);
  });

  test("info carries every key common to real exports", () => {
    const { payload } = buildOpencodeExport(makeSifSession(), {}, "/tmp/some-project");
    for (const key of infoKeys) expect(payload.info).toHaveProperty(key);
  });

  test("user message info carries every key common to real exports", () => {
    const { payload } = buildOpencodeExport(makeSifSession(), {}, "/tmp/some-project");
    const userMsg = payload.messages.find((m: any) => m.info.role === "user");
    for (const key of userMsgKeys) expect(userMsg.info).toHaveProperty(key);
  });

  test("assistant message info carries every key common to real exports", () => {
    const { payload } = buildOpencodeExport(makeSifSession(), {}, "/tmp/some-project");
    const assistantMsg = payload.messages.find((m: any) => m.info.role === "assistant");
    for (const key of assistantMsgKeys) expect(assistantMsg.info).toHaveProperty(key);
  });

  test("mints a fresh session id distinct from the source", () => {
    const { payload, nativeId } = buildOpencodeExport(makeSifSession(), {}, "/tmp/some-project");
    expect(payload.info.id).toBe(nativeId);
    expect(nativeId).not.toBe("native-abc-123");
  });

  test("leads with a plain-text sinter provenance message naming the source harness/id", () => {
    const { payload } = buildOpencodeExport(makeSifSession(), {}, "/tmp/some-project");
    const first = payload.messages[0];
    expect(first.info.role).toBe("user");
    expect(first.parts[0].text).toContain("imported via sinter from claude:native-abc-123");
  });

  test("default (no liveTools): historical tool calls flatten to inert text, never a live tool part", () => {
    const { payload } = buildOpencodeExport(makeSifSession(), {}, "/tmp/some-project");
    const allParts = payload.messages.flatMap((m: any) => m.parts);
    expect(allParts.some((p: any) => p.type === "tool")).toBe(false);
    const inert = allParts.find((p: any) => p.type === "text" && p.text.includes("historical tool call"));
    expect(inert).toBeDefined();
    expect(inert.text).toContain("bash");
    expect(inert.text).toContain("file1");
  });

  test("liveTools:true emits a real tool part with paired output", () => {
    const { payload } = buildOpencodeExport(makeSifSession(), { liveTools: true }, "/tmp/some-project");
    const allParts = payload.messages.flatMap((m: any) => m.parts);
    const tool = allParts.find((p: any) => p.type === "tool");
    expect(tool).toBeDefined();
    expect(tool.tool).toBe("bash");
    expect(tool.state.status).toBe("completed");
    expect(tool.state.output).toContain("file1");
  });

  test("every message and part id is unique", () => {
    const { payload } = buildOpencodeExport(makeSifSession(), {}, "/tmp/some-project");
    const ids = [
      payload.info.id,
      ...payload.messages.map((m: any) => m.info.id),
      ...payload.messages.flatMap((m: any) => m.parts.map((p: any) => p.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("assistant parentID chains to the immediately preceding message", () => {
    const { payload } = buildOpencodeExport(makeSifSession(), {}, "/tmp/some-project");
    const idx = payload.messages.findIndex((m: any) => m.info.role === "assistant");
    expect(payload.messages[idx].info.parentID).toBe(payload.messages[idx - 1].info.id);
  });

  test("dryRun writes nothing and creates no rows", async () => {
    const adapterWithWrite = new OpencodeAdapter(MINI_DB);
    const ref = await adapterWithWrite.write(makeSifSession(), { dryRun: true, cwd: "/tmp/some-project" });
    expect(ref.created).toEqual([]);
    expect(ref.harness).toBe("opencode");
  });

  test("respects a tool-parts-with-tools fixture shape too (sanity check against export-with-tools.json)", () => {
    const raw = JSON.parse(require("node:fs").readFileSync(EXPORT_WITH_TOOLS, "utf8"));
    expect(raw.info.id).toBeTruthy();
    expect(Array.isArray(raw.messages)).toBe(true);
    const toolParts = raw.messages.flatMap((m: any) => m.parts).filter((p: any) => p.type === "tool");
    expect(toolParts.length).toBeGreaterThan(0);
  });
});

describe("lenient parsing", () => {
  test("unparseable message json becomes a note, not a crash", async () => {
    const { Database } = await import("bun:sqlite");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sinter-opencode-lenient-"));
    const dbPath = join(dir, "test.db");
    const db = new Database(dbPath, { create: true });
    db.exec(`
      CREATE TABLE session (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text,
        title text, version text, time_created integer, time_updated integer, path text, agent text, model text,
        cost real DEFAULT 0, tokens_input integer DEFAULT 0, tokens_output integer DEFAULT 0,
        tokens_reasoning integer DEFAULT 0, tokens_cache_read integer DEFAULT 0, tokens_cache_write integer DEFAULT 0);
      CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
      CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);
    `);
    db.run(
      "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_x','p','','s','/tmp','t','1.0',1,1)",
    );
    db.run(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_bad','ses_x',1,1,'{not json')",
    );
    db.close();
    try {
      const a = new OpencodeAdapter(dbPath);
      const s = await a.read({ harness: "opencode", nativeId: "ses_x" });
      expect(s.entries.length).toBe(1);
      expect(s.entries[0]!.kind).toBe("note");
      expect((s.entries[0] as any).noteType).toBe("unparseable-message");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
