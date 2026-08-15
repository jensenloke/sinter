/**
 * Offline tests. Fixtures only — never the live store (CONVENTIONS §10).
 * Detection tests may stat live paths but must pass where omp isn't installed.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSession } from "@sinter/core/util";
import {
  OMP_DIALECT,
  OmpAdapter,
  PI_DIALECT,
  buildNativeBody,
  encodeLegacyAbsoluteDirName,
  listSessions,
  ompSessionDirName,
  parseHead,
  parseModelChange,
  parseSessionContent,
  type NativeEntry,
  type NativeMessageEntry,
  parseSessionFile,
  peelTitleSlot,
  readHead,
  readSessionFile,
  serializeTitleSlot,
  sidecarDirFor,
  writeNativeSession,
} from "../src/index";

const FIXTURES = join(import.meta.dir, "../../../../fixtures/omp");
const SESSIONS = join(FIXTURES, "sessions");
const SESSION_ID = "synthetic-1064";
const SESSION_FILE = join(SESSIONS, "-Documents", "2026-08-12T13-41-43-938Z_019ff635-1d82-7000-802c-ad79dbbd9bc1.jsonl");

const readOpts = { dialect: OMP_DIALECT };

// ------------------------------------------------------------------ title slot

describe("title slot", () => {
  test("fixture carries a synthetic title record", async () => {
    const content = await Bun.file(SESSION_FILE).text();
    const first = JSON.parse(content.split("\n")[0]!);
    expect(first.type).toBe("title");
  });

  test("a file without a slot is passed through untouched", () => {
    const body = '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/"}\n';
    const peeled = peelTitleSlot(body);
    expect(peeled.slot).toBeUndefined();
    expect(peeled.body).toBe(body);
  });

  test("serialization is exactly 256 bytes and round-trips", () => {
    for (const title of ["", "short", "a".repeat(400), "日本語のタイトル".repeat(40), "emoji 🎈🎈🎈"]) {
      const line = serializeTitleSlot({ title, source: "auto", updatedAt: "2026-08-12T14:14:20.868Z" });
      expect(Buffer.byteLength(line)).toBe(256);
      const parsed = peelTitleSlot(line);
      expect(parsed.slot).toBeDefined();
      expect(title.startsWith(parsed.slot!.title)).toBe(true);
    }
  });

  test("truncation never splits a multi-byte code point", () => {
    const line = serializeTitleSlot({ title: "🎈".repeat(200), source: "user", updatedAt: "2026-08-12T14:14:20.868Z" });
    expect(Buffer.byteLength(line)).toBe(256);
    const slot = peelTitleSlot(line).slot!;
    expect([...slot.title].every((c) => c === "🎈")).toBe(true);
    expect(slot.title.length % 2).toBe(0); // no lone surrogate
  });

  test("the slot wins over header.title; an empty slot deletes it", () => {
    const header = '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/","title":"from header","titleSource":"auto"}';
    const withSlot = serializeTitleSlot({ title: "from slot", source: "user", updatedAt: "2026-01-01T00:00:00.000Z" }) + header + "\n";
    expect(parseSessionContent(withSlot).header!.title).toBe("from slot");
    expect(parseSessionContent(withSlot).header!.titleSource).toBe("user");

    const emptySlot = serializeTitleSlot({ title: "", updatedAt: "2026-01-01T00:00:00.000Z" }) + header + "\n";
    expect(parseSessionContent(emptySlot).header!.title).toBeUndefined();
  });
});

// ------------------------------------------------------------------ parsing

describe("native parsing", () => {
  test("header, entries and skipped lines", async () => {
    const parsed = await parseSessionFile(SESSION_FILE);
    expect(parsed.header).toBeDefined();
    expect(parsed.header!.id).toBe(SESSION_ID);
    expect(parsed.header!.version).toBeGreaterThan(0);
    expect(parsed.header!.cwd).toBe("/workspace/synthetic-project");
    expect(parsed.entries.length).toBeGreaterThan(0);
    expect(parsed.skippedLines).toBeLessThanOrEqual(1);
  });

  test("malformed lines are skipped, not fatal", () => {
    const content = [
      '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/"}',
      "{not json at all",
      '{"type":"custom","customType":"k","id":"aaaaaaaa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z"}',
      "",
      "]]]",
    ].join("\n");
    const parsed = parseSessionContent(content);
    expect(parsed.header).toBeDefined();
    expect(parsed.entries.length).toBe(1);
    expect(parsed.skippedLines).toBe(2);
  });

  test("model_change parses in BOTH dialects (DIALECTS.md D1)", () => {
    expect(parseModelChange({ type: "model_change", id: "a", parentId: null, timestamp: "", model: "alibaba-model-studio/qwen3.8-max-preview" })).toEqual({
      provider: "alibaba-model-studio",
      model: "qwen3.8-max-preview",
    });
    expect(parseModelChange({ type: "model_change", id: "a", parentId: null, timestamp: "", provider: "fireworks", modelId: "accounts/fireworks/routers/kimi-k2p6-turbo" })).toEqual({
      provider: "fireworks",
      model: "accounts/fireworks/routers/kimi-k2p6-turbo",
    });
    // Only the FIRST slash separates provider from model id.
    expect(parseModelChange({ type: "model_change", id: "a", parentId: null, timestamp: "", model: "fireworks/accounts/fireworks/routers/kimi" })).toEqual({
      provider: "fireworks",
      model: "accounts/fireworks/routers/kimi",
    });
  });
});

// ------------------------------------------------------------------ reading

describe("read → SIF", () => {
  test("session envelope", async () => {
    const s = await readSessionFile(SESSION_FILE, readOpts);
    expect(s.sif).toBe("sif/0");
    expect(s.origin.harness).toBe("omp");
    expect(s.origin.nativeId).toBe(SESSION_ID);
    expect(s.cwd).toBe("/workspace/synthetic-project");
    expect(s.title?.text).toMatch(/^Synthetic fixture text/);
    expect(s.createdAt).toBeTruthy();
    expect(s.updatedAt).toBeTruthy();
    validateSession(s);
  });

  test("entry tree: every parentId resolves, roots are null", async () => {
    const s = await readSessionFile(SESSION_FILE, readOpts);
    const ids = new Set(s.entries.map((e) => e.id));
    for (const e of s.entries) {
      if (e.parentId !== null) expect(ids.has(e.parentId)).toBe(true);
    }
    expect(s.entries.filter((e) => e.parentId === null).length).toBeGreaterThanOrEqual(1);
    // The source is a real tree, not a flattened chain: ids are unique.
    expect(ids.size).toBe(s.entries.length);
  });

  test("toolResult is a TOP-LEVEL role and pairs with its call by id", async () => {
    const s = await readSessionFile(SESSION_FILE, readOpts);
    const results = s.entries.filter((e) => e.kind === "toolResult");
    expect(results.length).toBeGreaterThan(20);

    const callNames = new Map<string, string>();
    for (const e of s.entries) {
      if (e.kind !== "assistant") continue;
      for (const p of e.content) if (p.type === "toolCall") callNames.set(p.callId, p.name);
    }
    expect(callNames.size).toBeGreaterThan(20);
    for (const r of results) {
      if (r.kind !== "toolResult") continue;
      expect(callNames.get(r.callId)).toBe(r.toolName);
      expect(r.toolName).not.toBe("unknown");
    }
    expect(results.some((r) => r.kind === "toolResult" && r.isError)).toBe(true);
  });

  test("a result whose call is unknown gets toolName 'unknown' (CONVENTIONS §5)", async () => {
    const content = [
      '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}',
      '{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"toolResult","toolCallId":"orphan","content":[{"type":"text","text":"hi"}]}}',
    ].join("\n");
    const dir = await mkdtemp(join(tmpdir(), "sinter-omp-"));
    const p = join(dir, "2026-01-01T00-00-00-000Z_x.jsonl");
    await Bun.write(p, content);
    const s = await readSessionFile(p, readOpts);
    const r = s.entries.find((e) => e.kind === "toolResult");
    expect(r && r.kind === "toolResult" && r.toolName).toBe("unknown");
    await rm(dir, { recursive: true, force: true });
  });

  test("custom → NoteEntry (not in LLM context); custom_message → synthetic user (in context)", async () => {
    const s = await readSessionFile(SESSION_FILE, readOpts);
    const notes = s.entries.filter((e) => e.kind === "note");
    expect(notes.some((n) => n.kind === "note" && n.noteType === "custom:tool_execution_start")).toBe(true);
    expect(notes.some((n) => n.kind === "note" && n.noteType === "custom:session_exit")).toBe(true);
    expect(notes.some((n) => n.kind === "note" && n.noteType === "title_change")).toBe(true);

    const synthetic = s.entries.filter((e) => e.kind === "user" && e.synthetic);
    expect(synthetic.length).toBe(1);
    expect(synthetic[0]!.origin?.nativeType).toBe("custom_message");
  });

  test("unknown record types survive as NoteEntry + raw (CONVENTIONS §2)", async () => {
    const content = [
      '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}',
      '{"type":"a_type_from_the_future","id":"aaaaaaaa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","payload":42}',
    ].join("\n");
    const dir = await mkdtemp(join(tmpdir(), "sinter-omp-"));
    const p = join(dir, "2026-01-01T00-00-00-000Z_x.jsonl");
    await Bun.write(p, content);
    const s = await readSessionFile(p, readOpts);
    expect(s.entries[0]!.kind).toBe("note");
    expect(s.entries[0]!.kind === "note" && s.entries[0]!.noteType).toBe("a_type_from_the_future");
    expect((s.entries[0]!.raw as { payload: number }).payload).toBe(42);
    await rm(dir, { recursive: true, force: true });
  });

  test("compaction maps to CompactionEntry with its summary", async () => {
    const content = [
      '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}',
      '{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
      '{"type":"compaction","id":"bbbbbbbb","parentId":"aaaaaaaa","timestamp":"2026-01-01T00:01:00.000Z","summary":"we did things","firstKeptEntryId":"aaaaaaaa","tokensBefore":40000}',
      '{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","timestamp":"2026-01-01T00:02:00.000Z","message":{"role":"user","content":[{"type":"text","text":"continue"}]}}',
    ].join("\n");
    const dir = await mkdtemp(join(tmpdir(), "sinter-omp-"));
    const p = join(dir, "2026-01-01T00-00-00-000Z_x.jsonl");
    await Bun.write(p, content);
    const s = await readSessionFile(p, readOpts);
    const c = s.entries.find((e) => e.kind === "compaction");
    expect(c).toBeDefined();
    expect(c!.kind === "compaction" && c!.summary).toBe("we did things");
    expect(c!.parentId).toBe("aaaaaaaa");
    expect(s.entries.find((e) => e.id === "cccccccc")!.parentId).toBe("bbbbbbbb");
    expect((c!.raw as { tokensBefore: number }).tokensBefore).toBe(40000);
    await rm(dir, { recursive: true, force: true });
  });

  test("dropped records re-parent children to the nearest retained ancestor (§6)", async () => {
    // A dangling parentId (the referenced entry never appears) resolves to null
    // rather than corrupting the tree.
    const content = [
      '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}',
      '{"type":"message","id":"aaaaaaaa","parentId":"deadbeef","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"orphan"}]}}',
      '{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","timestamp":"2026-01-01T00:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"child"}]}}',
    ].join("\n");
    const dir = await mkdtemp(join(tmpdir(), "sinter-omp-"));
    const p = join(dir, "2026-01-01T00-00-00-000Z_x.jsonl");
    await Bun.write(p, content);
    const s = await readSessionFile(p, readOpts);
    expect(s.entries.find((e) => e.id === "aaaaaaaa")!.parentId).toBeNull();
    expect(s.entries.find((e) => e.id === "bbbbbbbb")!.parentId).toBe("aaaaaaaa");
    validateSession(s);
    await rm(dir, { recursive: true, force: true });
  });

  test("usage is mapped from real numbers only, never zero-filled (§4)", async () => {
    const s = await readSessionFile(SESSION_FILE, readOpts);
    expect(s.usage?.input).toBeGreaterThan(0);
    expect(s.usage?.output).toBeGreaterThan(0);
    // cost.total is 0 in the fixture (non-billing provider) → costUsd omitted.
    expect(s.usage?.costUsd).toBeUndefined();
    const withUsage = s.entries.filter((e) => e.kind === "assistant" && e.usage);
    expect(withUsage.length).toBeGreaterThan(10);
  });

  test("thinking signatures ride in the part's `signature` field (§4)", async () => {
    const s = await readSessionFile(SESSION_FILE, readOpts);
    const thinking = s.entries.flatMap((e) => (e.kind === "assistant" ? e.content : [])).filter((p) => p.type === "thinking");
    expect(thinking.length).toBeGreaterThan(5);
    expect(thinking.some((p) => p.type === "thinking" && typeof p.signature === "string")).toBe(true);
  });

  test("every entry carries origin {nativeType, nativeId} and raw (§4)", async () => {
    const s = await readSessionFile(SESSION_FILE, readOpts);
    for (const e of s.entries) {
      if (e.kind === "subsession") continue; // synthesized by sinter, not a native record
      expect(e.origin?.nativeType).toBeTruthy();
      expect(e.origin?.nativeId).toBe(e.id);
      expect(e.raw).toBeDefined();
    }
  });

  test("slim drops raw", async () => {
    const s = await readSessionFile(SESSION_FILE, { ...readOpts, slim: true });
    expect(s.entries.every((e) => e.raw === undefined)).toBe(true);
  });
});

// ------------------------------------------------------------------ subagents

describe("sidecar subagents", () => {
  test("sidecar dir is the session path minus .jsonl", () => {
    expect(sidecarDirFor("/a/b/2026_x.jsonl")).toBe("/a/b/2026_x");
  });

  test("each sidecar transcript loads into subsessions with its own native id", async () => {
    const s = await readSessionFile(SESSION_FILE, readOpts);
    expect(s.subsessions?.length).toBe(3);
    const ids = s.subsessions!.map((x) => x.origin.nativeId);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id.startsWith("synthetic-"))).toBe(true);
    for (const sub of s.subsessions!) {
      expect(sub.origin.harness).toBe("omp");
      expect(sub.entries.length).toBeGreaterThan(10);
      // A subagent file's own title slot is peeled too.
      expect(sub.entries.some((e) => e.kind === "note" && e.noteType === "session_init")).toBe(true);
      validateSession(sub);
    }
  });

  test("subagent context (agent/modelRole) is preserved from session_init", async () => {
    const s = await readSessionFile(SESSION_FILE, readOpts);
    const sub = s.subsessions![0]!;
    expect((sub.preserve?.sessionInit as { agent?: string }).agent).toBeTruthy();
    expect((sub.preserve?.sessionInit as { modelRole?: string }).modelRole).toBeTruthy();
  });

  test("a SubsessionEntry links each sidecar into the parent tree at its async-result", async () => {
    const s = await readSessionFile(SESSION_FILE, readOpts);
    const links = s.entries.filter((e) => e.kind === "subsession");
    expect(links.length).toBe(3);
    const names = links.map((l) => (l.kind === "subsession" ? l.agentName : "")).sort();
    expect(names).toEqual(["DashboardEcosystem", "InteropEfforts", "OpencodeSessions"]);
    const refs = new Set(s.subsessions!.map((x) => x.origin.nativeId));
    for (const l of links) expect(refs.has(l.kind === "subsession" ? l.sessionRef : "")).toBe(true);
    // Anchored, not appended: at least one link sits before the final entry.
    expect(s.entries.findIndex((e) => e.kind === "subsession")).toBeLessThan(s.entries.length - 1);
    validateSession(s);
  });

  test("loadSubsessions:false skips sidecar IO", async () => {
    const s = await readSessionFile(SESSION_FILE, { ...readOpts, loadSubsessions: false });
    expect(s.subsessions).toBeUndefined();
    expect(s.entries.some((e) => e.kind === "subsession")).toBe(false);
  });
});

// ------------------------------------------------------------------ artifacts / blobs

describe("blob and artifact refs", () => {
  async function fixture(lines: string[], extra?: (dir: string, sessionPath: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "sinter-omp-"));
    const p = join(dir, "2026-01-01T00-00-00-000Z_x.jsonl");
    await Bun.write(p, lines.join("\n"));
    if (extra) await extra(dir, p);
    return { dir, p };
  }
  const HEADER = '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}';

  test("blob:sha256 image refs resolve to inline base64", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const hash = new Bun.SHA256().update(bytes).digest("hex");
    const { dir, p } = await fixture(
      [
        HEADER,
        `{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"image","data":"blob:sha256:${hash}","mimeType":"image/png"}]}}`,
      ],
      async (d) => {
        await Bun.write(join(d, "blobs", hash), bytes);
      },
    );
    const s = await readSessionFile(p, { ...readOpts, blobsDir: join(dir, "blobs") });
    const img = s.entries[0]!.kind === "user" ? s.entries[0]!.content[0] : undefined;
    expect(img?.type).toBe("image");
    expect(img && img.type === "image" && img.data).toBe(bytes.toString("base64"));
    expect(img && img.type === "image" && img.mimeType).toBe("image/png");
    await rm(dir, { recursive: true, force: true });
  });

  test("a dangling blob ref is annotated, not silently dropped", async () => {
    const hash = "0".repeat(64);
    const { dir, p } = await fixture([
      HEADER,
      `{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"image","data":"blob:sha256:${hash}"}]}}`,
    ]);
    const s = await readSessionFile(p, { ...readOpts, blobsDir: join(dir, "blobs") });
    const img = s.entries[0]!.kind === "user" ? s.entries[0]!.content[0] : undefined;
    expect(img?.type).toBe("image");
    expect(img && img.type === "image" && img.data).toBe("");
    // raw still carries the original ref for round-tripping.
    expect(JSON.stringify(s.entries[0]!.raw)).toContain(hash);
    await rm(dir, { recursive: true, force: true });
  });

  test("artifact:// refs in tool results inline the spill log when present", async () => {
    const { dir, p } = await fixture(
      [
        HEADER,
        '{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash"}]}}',
        '{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"output spilled to artifact://7.bash"}]}}',
      ],
      async (_d, sessionPath) => {
        await Bun.write(join(sidecarDirFor(sessionPath), "7.bash.log"), "the spilled bytes");
      },
    );
    const s = await readSessionFile(p, readOpts);
    const r = s.entries.find((e) => e.kind === "toolResult")!;
    const text = r.kind === "toolResult" ? r.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
    expect(text).toContain("inlined artifact://7.bash");
    expect(text).toContain("the spilled bytes");
    await rm(dir, { recursive: true, force: true });
  });

  test("a dangling artifact:// ref is annotated", async () => {
    const { dir, p } = await fixture([
      HEADER,
      '{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash"}]}}',
      '{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"see artifact://99.bash"}]}}',
    ]);
    const s = await readSessionFile(p, readOpts);
    const r = s.entries.find((e) => e.kind === "toolResult")!;
    const text = r.kind === "toolResult" ? r.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
    expect(text).toContain("dangling artifact ref");
    await rm(dir, { recursive: true, force: true });
  });

  test("artifact refs cannot escape the sidecar dir", async () => {
    const { dir, p } = await fixture([
      HEADER,
      '{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash"}]}}',
      '{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"artifact://../../../../etc/passwd"}]}}',
    ]);
    const s = await readSessionFile(p, readOpts);
    const r = s.entries.find((e) => e.kind === "toolResult")!;
    const text = r.kind === "toolResult" ? r.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
    expect(text).not.toContain("root:");
    await rm(dir, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ list

describe("list", () => {
  test("enumerates fixture sessions and their subagents from head windows only", async () => {
    const rows = [];
    for await (const r of listSessions(SESSIONS, OMP_DIALECT)) rows.push(r);
    expect(rows.length).toBe(4); // 1 session + 3 sidecars
    const parent = rows.find((r) => !r.isSubagent)!;
    expect(parent.nativeId).toBe(SESSION_ID);
    expect(parent.cwd).toBe("/workspace/synthetic-project");
    expect(parent.title).toMatch(/^Synthetic fixture text/);
    expect(parent.model).toBeTruthy();
    expect(parent.firstPrompt).toBeTruthy();
    const subs = rows.filter((r) => r.isSubagent);
    expect(subs.length).toBe(3);
    for (const s of subs) expect(s.parentNativeId).toBe(SESSION_ID);
  });

  test("a missing store yields nothing rather than throwing", async () => {
    const rows = [];
    for await (const r of listSessions("/nonexistent/sinter/store", OMP_DIALECT)) rows.push(r);
    expect(rows.length).toBe(0);
  });

  test("parseHead flags a header pushed out of the 4KB scan window", () => {
    const bigCwd = "/x".repeat(3000);
    const head = `{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${bigCwd}"}\n`;
    expect(parseHead(head, OMP_DIALECT).headerOutOfRange).toBe(true);
  });
});

// ------------------------------------------------------------------ paths

describe("cwd → dir encoding (never inverted, DIALECTS.md D4)", () => {
  const home = "/home/demo";
  const tmp = "/var/folders/xx/T";

  test("omp: home-relative first", () => {
    expect(ompSessionDirName("/home/demo/workspace", home, tmp)).toBe("-workspace");
    expect(ompSessionDirName("/home/demo/workspace/synthetic-project", home, tmp)).toBe("-workspace-synthetic-project");
    expect(ompSessionDirName("/home/demo", home, tmp)).toBe("-");
  });

  test("omp: tmp scope, then legacy absolute", () => {
    expect(ompSessionDirName("/var/folders/xx/T/proj", home, tmp)).toBe("-tmp-proj");
    expect(ompSessionDirName("/opt/homebrew/x", home, tmp)).toBe("--opt-homebrew-x--");
  });

  test("omp canonicalizes /tmp → /private/tmp like resolveEquivalentPath", () => {
    expect(ompSessionDirName("/tmp", home, "/nonexistent")).toBe("--private-tmp--");
  });

  test("pi: always legacy absolute", () => {
    expect(PI_DIALECT.sessionDirName("/home/demo", home, tmp)).toBe("--home-demo--");
    expect(PI_DIALECT.sessionDirName("/home/demo/workspace/sample", home, tmp)).toBe("--home-demo-workspace-sample--");
    expect(encodeLegacyAbsoluteDirName("/opt/x")).toBe("--opt-x--");
  });

  test("the two dialects disagree for the same cwd — which is exactly the point", () => {
    expect(ompSessionDirName("/home/demo/workspace", home, tmp)).not.toBe(
      PI_DIALECT.sessionDirName("/home/demo/workspace", home, tmp),
    );
  });
});

// ------------------------------------------------------------------ write

describe("write", () => {
  async function sample() {
    return await readSessionFile(SESSION_FILE, readOpts);
  }

  test("mints a NEW native id and never reuses the source's (§7)", async () => {
    const s = await sample();
    const a = buildNativeBody(s, OMP_DIALECT);
    const b = buildNativeBody(s, OMP_DIALECT);
    expect(a.nativeId).not.toBe(SESSION_ID);
    expect(a.nativeId).not.toBe(b.nativeId);
  });

  test("emits a header omp/pi can parse, within the 4KB scan window", async () => {
    const s = await sample();
    const { body } = buildNativeBody(s, OMP_DIALECT);
    const parsed = parseSessionContent(body);
    expect(parsed.header!.type).toBe("session");
    expect(parsed.header!.version).toBe(3);
    expect(parsed.header!.cwd).toBe("/workspace/synthetic-project");
    expect(parsed.header!.title).toMatch(/^Synthetic fixture text/);
    expect(Buffer.byteLength(body.slice(0, body.indexOf("\n") + 1))).toBeLessThan(4096);
    expect(parsed.skippedLines).toBe(0);
  });

  test("pi's header carries NO title (DIALECTS.md D3)", async () => {
    const s = await sample();
    const parsed = parseSessionContent(buildNativeBody(s, PI_DIALECT).body);
    expect(parsed.header!.title).toBeUndefined();
    expect(parsed.header!.titleSource).toBeUndefined();
  });

  test("model_change is written in each dialect's own shape (D1)", async () => {
    const s = await sample();
    const omp = parseSessionContent(buildNativeBody(s, OMP_DIALECT).body).entries.find((e) => e.type === "model_change")!;
    expect(typeof omp.model).toBe("string");
    expect(omp.modelId).toBeUndefined();

    const pi = parseSessionContent(buildNativeBody(s, PI_DIALECT).body).entries.find((e) => e.type === "model_change")!;
    expect(typeof pi.provider).toBe("string");
    expect(typeof pi.modelId).toBe("string");
    expect(pi.model).toBeUndefined();
  });

  test("historical tool calls are flattened to inert text by default (§7)", async () => {
    const s = await sample();
    const { body } = buildNativeBody(s, OMP_DIALECT);
    expect(body).toContain("[historical tool call:");
    for (const e of parseSessionContent(body).entries) {
      if (e.type !== "message") continue;
      const m = (e as unknown as { message: { role: string; content?: unknown } }).message;
      expect(m.role).not.toBe("toolResult");
      if (Array.isArray(m.content)) {
        expect(m.content.some((p) => (p as { type?: string }).type === "toolCall")).toBe(false);
      }
    }
  });

  test("liveTools:true re-emits native toolCall + toolResult records", async () => {
    const s = await sample();
    const parsed = parseSessionContent(buildNativeBody(s, OMP_DIALECT, { liveTools: true }).body);
    const results = parsed.entries.filter((e) => e.type === "message" && (e as unknown as { message: { role: string } }).message.role === "toolResult");
    expect(results.length).toBeGreaterThan(20);
    expect(JSON.stringify(parsed.entries)).toContain('"toolCall"');
  });

  test("every assistant message carries usage — native omp requires the field on all of them", async () => {
    const s = await sample();
    const stripped = structuredClone(s);
    for (const e of stripped.entries) if (e.kind === "assistant") delete e.usage;
    const isAssistantMessage = (e: NativeEntry): e is NativeMessageEntry & { message: { role: "assistant" } } => {
      if (e.type !== "message") return false;
      if (typeof e.message !== "object" || e.message === null) return false;
      return "role" in e.message ? e.message.role === "assistant" : false;
    };
    const assistant = parseSessionContent(buildNativeBody(stripped, OMP_DIALECT).body).entries.filter(isAssistantMessage);
    expect(assistant.length).toBeGreaterThan(0);
    for (const e of assistant) {
      const u = e.message.usage;
      expect(u).toBeDefined();
      if (!u) continue;
      for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
        expect(Number.isFinite(u[k])).toBe(true);
      }
    }
  });

  test("appends a sinter provenance custom entry (§7)", async () => {
    const s = await sample();
    const prov = parseSessionContent(buildNativeBody(s, OMP_DIALECT).body).entries.find(
      (e) => e.type === "custom" && (e as { customType?: string }).customType === "sinter_import",
    ) as { data: Record<string, unknown> } | undefined;
    expect(prov).toBeDefined();
    expect(prov!.data.sourceHarness).toBe("omp");
    expect(prov!.data.sourceNativeId).toBe(s.origin.nativeId);
    expect(prov!.data.liveTools).toBe(false);
  });

  test("the written tree keeps the source topology (fresh 8-hex ids, no collisions)", async () => {
    const s = await sample();
    const entries = parseSessionContent(buildNativeBody(s, OMP_DIALECT).body).entries;
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.size).toBe(entries.length);
    for (const e of entries) {
      expect(e.id).toMatch(/^[0-9a-f]{8}$/);
      if (e.parentId !== null) expect(ids.has(e.parentId)).toBe(true);
    }
  });

  test("round-trips: written omp bytes read back into an equivalent SIF shape", async () => {
    const s = await sample();
    const dir = await mkdtemp(join(tmpdir(), "sinter-omp-write-"));
    const ref = await writeNativeSession(s, OMP_DIALECT, { sessionsDir: dir, writeSubsessions: false });
    expect(ref.nativePath!.endsWith(".jsonl")).toBe(true);

    const back = await readSessionFile(ref.nativePath!, readOpts);
    validateSession(back);
    expect(back.origin.nativeId).toBe(ref.nativeId);
    expect(back.cwd).toBe(s.cwd);
    expect(back.title?.text).toBe(s.title?.text);
    const userTurns = (x: typeof s) => x.entries.filter((e) => e.kind === "user").length;
    expect(userTurns(back)).toBe(userTurns(s));
    await rm(dir, { recursive: true, force: true });
  });

  test("dryRun reports paths and writes nothing", async () => {
    const s = await sample();
    const dir = await mkdtemp(join(tmpdir(), "sinter-omp-dry-"));
    const ref = await writeNativeSession(s, OMP_DIALECT, { sessionsDir: dir, dryRun: true });
    expect(ref.dryRun).toBe(true);
    expect(ref.created).toEqual([]);
    expect(ref.planned!.length).toBe(4); // session + 3 sidecars
    expect(await Bun.file(ref.planned![0]!).exists()).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("subsessions are written as sidecar transcripts omp can find", async () => {
    const s = await sample();
    const dir = await mkdtemp(join(tmpdir(), "sinter-omp-sub-"));
    const ref = await writeNativeSession(s, OMP_DIALECT, { sessionsDir: dir });
    expect(ref.created.length).toBe(4);
    for (const p of ref.created.slice(1)) {
      expect(p.startsWith(sidecarDirFor(ref.nativePath!))).toBe(true);
      expect(parseSessionContent(await Bun.file(p).text()).header!.type).toBe("session");
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("emitTitleSlot produces a byte-exact 256-byte line 1", async () => {
    const s = await sample();
    const dir = await mkdtemp(join(tmpdir(), "sinter-omp-slot-"));
    const ref = await writeNativeSession(s, OMP_DIALECT, { sessionsDir: dir, emitTitleSlot: true, writeSubsessions: false });
    const content = await Bun.file(ref.nativePath!).text();
    expect(Buffer.byteLength(content.slice(0, content.indexOf("\n") + 1))).toBe(256);
    expect(parseSessionContent(content).header!.title).toBe(s.title!.text);
    await rm(dir, { recursive: true, force: true });
  });

  test("write() never touches an existing session file", async () => {
    const s = await sample();
    const before = await Bun.file(SESSION_FILE).text();
    const dir = await mkdtemp(join(tmpdir(), "sinter-omp-safe-"));
    await writeNativeSession(s, OMP_DIALECT, { sessionsDir: dir });
    expect(await Bun.file(SESSION_FILE).text()).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ adapter

describe("adapter surface", () => {
  test("resumeCommand", () => {
    expect(new OmpAdapter().resumeCommand({ harness: "omp", nativeId: "abc" })).toEqual(["omp", "--resume", "abc"]);
  });

  test("list/read against a fixture-rooted store", async () => {
    const a = new OmpAdapter({ sessionsDir: SESSIONS });
    const rows = [];
    for await (const r of a.list()) rows.push(r);
    expect(rows.length).toBe(4);
    const s = await a.read({ harness: "omp", nativeId: SESSION_ID });
    expect(s.origin.nativeId).toBe(SESSION_ID);
  });

  test("detect returns null when the store is absent (must pass without omp installed)", async () => {
    expect(await new OmpAdapter({ sessionsDir: "/nonexistent/sinter" }).detect()).toBeNull();
  });
});
