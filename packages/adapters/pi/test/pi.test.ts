/**
 * pi dialect tests. Offline, fixtures only (CONVENTIONS §10).
 *
 * The point of most of these is the dialect boundary: pi files must read
 * correctly through the shared omp implementation, and pi writes must NOT carry
 * omp-only constructs (title slot, header title, sidecars).
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OMP_DIALECT,
  buildNativeBody,
  listSessions,
  parseSessionContent,
  parseSessionFile,
  peelTitleSlot,
  sidecarDirFor,
  writeNativeSession,
} from "@sinter/adapter-omp";
import { validateSession } from "@sinter/core/util";
import piAdapter, { PI_DIALECT, PiAdapter, parseModelChange, piSessionDirName, readSessionFile } from "../src/index";

const SESSIONS = join(import.meta.dir, "../../../../fixtures/pi/sessions");
const BIG_ID = "synthetic-1293";
const BIG = join(SESSIONS, "--workspace-synthetic--", "2026-08-12T04-11-14-370Z_019ff42a-d042-7de3-95d2-81e608b39ca4.jsonl");
const SMALL_ID = "synthetic-1379";
const SMALL = join(
  SESSIONS,
  "--workspace-synthetic-project--",
  "2026-06-06T04-38-38-444Z_019e9b39-d26c-7cbd-8f86-1c54ffee4a60.jsonl",
);

const readOpts = { dialect: PI_DIALECT };

// ------------------------------------------------------------------ dialect

describe("pi dialect boundary", () => {
  test("pi files have NO 256-byte title slot: line 1 is the header (D2)", async () => {
    for (const path of [BIG, SMALL]) {
      const content = await Bun.file(path).text();
      expect(peelTitleSlot(content).slot).toBeUndefined();
      expect(JSON.parse(content.split("\n")[0]!).type).toBe("session");
    }
  });

  test("pi headers carry no title/titleSource (D3)", async () => {
    const parsed = await parseSessionFile(BIG);
    expect(parsed.header!.version).toBeGreaterThan(0);
    expect(parsed.header!.cwd).toBe("/workspace/synthetic-project");
    expect(parsed.header!.title).toBeUndefined();
    expect(parsed.header!.titleSource).toBeUndefined();
  });

  test("pi model_change is {provider, modelId}, never {model} (D1)", async () => {
    const parsed = await parseSessionFile(SMALL);
    const changes = parsed.entries.filter((e) => e.type === "model_change");
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      expect(typeof c.provider).toBe("string");
      expect(typeof c.modelId).toBe("string");
      expect(c.model).toBeUndefined();
      // Model ids containing slashes must survive intact.
      expect(parseModelChange(c as never).model).toBe(c.modelId as string);
    }
    expect(parseModelChange(changes[0] as never).provider).toBe("fireworks");
    expect(parseModelChange(changes[0] as never).model).toBeTruthy();
  });

  test("pi's cwd encoding is the legacy absolute form only (D4)", () => {
    expect(piSessionDirName("/home/demo")).toBe("--home-demo--");
    expect(piSessionDirName("/home/demo/workspace/sample")).toBe("--home-demo-workspace-sample--");
    // …and it does NOT use omp's home-relative scheme for the same cwd.
    expect(PI_DIALECT.sessionDirName("/home/demo/workspace", "/home/demo", "/tmp")).not.toBe("-Documents");
  });

  test("pi has no sidecar concept", () => {
    expect(PI_DIALECT.hasSidecar).toBe(false);
    expect(PI_DIALECT.hasTitleSlot).toBe(false);
    expect(PI_DIALECT.headerCarriesTitle).toBe(false);
  });
});

// ------------------------------------------------------------------ read

describe("read → SIF", () => {
  test("session envelope; title is derived (pi stores none)", async () => {
    const s = await readSessionFile(BIG, readOpts);
    expect(s.origin.harness).toBe("pi");
    expect(s.origin.nativeId).toBe(BIG_ID);
    expect(s.cwd).toBe("/workspace/synthetic-project");
    expect(s.createdAt).toBeTruthy();
    expect(s.title?.source).toBe("derived");
    expect(s.title?.text.length).toBeGreaterThan(0);
    expect(s.subsessions).toBeUndefined();
    validateSession(s);
  });

  test("the shared message core reads identically: toolResult is a TOP-LEVEL role", async () => {
    const s = await readSessionFile(BIG, readOpts);
    const results = s.entries.filter((e) => e.kind === "toolResult");
    expect(results.length).toBeGreaterThan(5);
    const callNames = new Map<string, string>();
    for (const e of s.entries) {
      if (e.kind !== "assistant") continue;
      for (const p of e.content) if (p.type === "toolCall") callNames.set(p.callId, p.name);
    }
    for (const r of results) {
      if (r.kind !== "toolResult") continue;
      expect(callNames.get(r.callId)).toBe(r.toolName);
    }
  });

  test("model timeline maps to ModelChangeEntry with provider split out", async () => {
    const s = await readSessionFile(SMALL, readOpts);
    const mc = s.entries.filter((e) => e.kind === "modelChange");
    expect(mc.length).toBeGreaterThan(0);
    expect(mc[0]!.kind === "modelChange" && mc[0]!.provider).toBe("fireworks");
    expect(mc[0]!.kind === "modelChange" && mc[0]!.model).toBeTruthy();
  });

  test("pi records real usage — PLAN.md's 'omp/pi have none' is wrong", async () => {
    const s = await readSessionFile(BIG, readOpts);
    expect(s.usage?.input).toBeGreaterThan(0);
    expect(s.usage?.output).toBeGreaterThan(0);
    // pi spells reasoning tokens `usage.reasoning` (omp: `usage.reasoningTokens`).
    expect(s.usage?.reasoning).toBeGreaterThan(0);
    // cost.total is 0 for this provider → never zero-filled into costUsd (§4).
    expect(s.usage?.costUsd).toBeUndefined();
  });

  test("thinking signatures are preserved", async () => {
    const s = await readSessionFile(BIG, readOpts);
    const thinking = s.entries.flatMap((e) => (e.kind === "assistant" ? e.content : [])).filter((p) => p.type === "thinking");
    expect(thinking.length).toBeGreaterThan(0);
  });

  test("tree integrity and fidelity fields", async () => {
    const s = await readSessionFile(BIG, readOpts);
    const ids = new Set(s.entries.map((e) => e.id));
    expect(ids.size).toBe(s.entries.length);
    for (const e of s.entries) {
      if (e.parentId !== null) expect(ids.has(e.parentId)).toBe(true);
      expect(e.origin?.nativeType).toBeTruthy();
      expect(e.raw).toBeDefined();
    }
  });

  test("an omp-shaped model_change also reads (the reader is dialect-tolerant)", async () => {
    const content = [
      '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}',
      '{"type":"model_change","id":"aaaaaaaa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","model":"anthropic/claude-x","role":"default"}',
    ].join("\n");
    const dir = await mkdtemp(join(tmpdir(), "sinter-pi-"));
    const p = join(dir, "2026-01-01T00-00-00-000Z_x.jsonl");
    await Bun.write(p, content);
    const s = await readSessionFile(p, readOpts);
    const mc = s.entries[0]!;
    expect(mc.kind === "modelChange" && mc.provider).toBe("anthropic");
    expect(mc.kind === "modelChange" && mc.model).toBe("claude-x");
    await rm(dir, { recursive: true, force: true });
  });

  test("an omp file read under the pi dialect still parses (omp ⊃ pi)", async () => {
    const ompFile = join(
      import.meta.dir,
      "../../../../fixtures/omp/sessions/-Documents/2026-08-12T13-41-43-938Z_019ff635-1d82-7000-802c-ad79dbbd9bc1.jsonl",
    );
    const s = await readSessionFile(ompFile, readOpts);
    expect(s.entries.length).toBeGreaterThan(100);
    // …but the pi dialect deliberately ignores the omp-only title and sidecars.
    expect(s.subsessions).toBeUndefined();
    expect(s.title?.source).toBe("derived");
  });
});

// ------------------------------------------------------------------ list

describe("list", () => {
  test("enumerates both fixture stores; no subagent rows for pi", async () => {
    const rows = [];
    for await (const r of listSessions(SESSIONS, PI_DIALECT)) rows.push(r);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.harness === "pi")).toBe(true);
    expect(rows.some((r) => r.isSubagent)).toBe(false);
    const big = rows.find((r) => r.nativeId === BIG_ID)!;
    expect(big.cwd).toBe("/workspace/synthetic-project");
    expect(big.title).toBeUndefined();
    expect(big.firstPrompt).toBeTruthy();
    expect(big.model).toBeTruthy();
  });

  test("missing store → empty, not a throw", async () => {
    const rows = [];
    for await (const r of listSessions("/nonexistent/sinter/pi", PI_DIALECT)) rows.push(r);
    expect(rows.length).toBe(0);
  });
});

// ------------------------------------------------------------------ write

describe("write (pi dialect)", () => {
  test("lands in the legacy-absolute dir and emits no title slot", async () => {
    const s = await readSessionFile(BIG, readOpts);
    const dir = await mkdtemp(join(tmpdir(), "sinter-pi-write-"));
    const ref = await writeNativeSession(s, PI_DIALECT, { sessionsDir: dir });
    expect(ref.harness).toBe("pi");
    expect(ref.nativePath!).toContain("--workspace-synthetic-project--");
    const content = await Bun.file(ref.nativePath!).text();
    expect(peelTitleSlot(content).slot).toBeUndefined();
    expect(JSON.parse(content.split("\n")[0]!).type).toBe("session");
    expect(JSON.parse(content.split("\n")[0]!).title).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips back through the reader", async () => {
    const s = await readSessionFile(BIG, readOpts);
    const dir = await mkdtemp(join(tmpdir(), "sinter-pi-rt-"));
    const ref = await writeNativeSession(s, PI_DIALECT, { sessionsDir: dir });
    const back = await readSessionFile(ref.nativePath!, readOpts);
    validateSession(back);
    expect(back.origin.nativeId).toBe(ref.nativeId);
    expect(back.origin.nativeId).not.toBe(BIG_ID); // always a NEW id (§7)
    expect(back.cwd).toBe(s.cwd);
    expect(back.entries.filter((e) => e.kind === "user" && !e.synthetic).length).toBe(
      s.entries.filter((e) => e.kind === "user" && !e.synthetic).length,
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("tool calls flatten to inert text by default (§7)", async () => {
    const s = await readSessionFile(BIG, readOpts);
    const { body } = buildNativeBody(s, PI_DIALECT);
    expect(body).toContain("[historical tool call:");
    expect(body).not.toContain('"role":"toolResult"');
  });

  test("provenance marker names pi as the target and omp/pi as the source", async () => {
    const s = await readSessionFile(BIG, readOpts);
    const prov = parseSessionContent(buildNativeBody(s, PI_DIALECT).body).entries.find(
      (e) => e.type === "custom" && (e as { customType?: string }).customType === "sinter_import",
    ) as unknown as { data: Record<string, unknown> };
    expect(prov.data.sourceHarness).toBe("pi");
    expect(prov.data.sourceNativeId).toBe(BIG_ID);
  });

  test("an omp session ported to pi drops omp-only constructs", async () => {
    const ompFile = join(
      import.meta.dir,
      "../../../../fixtures/omp/sessions/-Documents/2026-08-12T13-41-43-938Z_019ff635-1d82-7000-802c-ad79dbbd9bc1.jsonl",
    );
    const ompSession = await readSessionFile(ompFile, { dialect: OMP_DIALECT });
    expect(ompSession.subsessions!.length).toBe(3);

    const dir = await mkdtemp(join(tmpdir(), "sinter-omp2pi-"));
    const ref = await writeNativeSession(ompSession, PI_DIALECT, { sessionsDir: dir });
    // No title slot, no header title, no sidecar directory.
    const content = await Bun.file(ref.nativePath!).text();
    expect(peelTitleSlot(content).slot).toBeUndefined();
    expect(parseSessionContent(content).header!.title).toBeUndefined();
    expect(ref.created.length).toBe(1);
    await expect(readdir(sidecarDirFor(ref.nativePath!))).rejects.toThrow();
    // Subagent transcripts survive as in-context notes rather than being dropped.
    expect(content).toContain("sinter_subsession");
    await rm(dir, { recursive: true, force: true });
  });

  test("dryRun writes nothing", async () => {
    const s = await readSessionFile(SMALL, readOpts);
    const dir = await mkdtemp(join(tmpdir(), "sinter-pi-dry-"));
    const ref = await writeNativeSession(s, PI_DIALECT, { sessionsDir: dir, dryRun: true });
    expect(ref.created).toEqual([]);
    expect(ref.planned!.length).toBe(1);
    expect(await Bun.file(ref.planned![0]!).exists()).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("write() never touches the source fixture", async () => {
    const before = await Bun.file(BIG).text();
    const s = await readSessionFile(BIG, readOpts);
    const dir = await mkdtemp(join(tmpdir(), "sinter-pi-safe-"));
    await writeNativeSession(s, PI_DIALECT, { sessionsDir: dir });
    expect(await Bun.file(BIG).text()).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ adapter

describe("adapter surface", () => {
  test("resumeCommand uses --session (pi's -r takes no argument)", () => {
    expect(piAdapter.resumeCommand({ harness: "pi", nativeId: "abc" })).toEqual(["pi", "--session", "abc"]);
    expect(piAdapter.id).toBe("pi");
  });

  test("list/read against a fixture-rooted store", async () => {
    const a = new PiAdapter({ sessionsDir: SESSIONS });
    const rows = [];
    for await (const r of a.list()) rows.push(r);
    expect(rows.length).toBe(2);
    const s = await a.read({ harness: "pi", nativeId: BIG_ID });
    expect(s.origin.nativeId).toBe(BIG_ID);
  });

  test("detect returns null when the store is absent (must pass without pi installed)", async () => {
    expect(await new PiAdapter({ sessionsDir: "/nonexistent/sinter" }).detect()).toBeNull();
  });
});
