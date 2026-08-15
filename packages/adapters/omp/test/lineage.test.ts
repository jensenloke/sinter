/**
 * Session lineage across ports: provenance stamping, multi-hop chains, and
 * carry-forward of the original SIF.
 *
 * Offline only — every write goes to a temp store and every carry sidecar to a
 * temp `carryRoot`, never `~/.omp`, `~/.pi` or `~/.sinter` (CONVENTIONS §10).
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESERVE_KEY, type SinterProvenance, buildProvenance, provenanceOf, withProvenance } from "@sinter/core/lineage";
import { SIF_VERSION, type SifEntry, type SifSession } from "@sinter/core/sif";
import { validateSession } from "@sinter/core/util";
import {
  OMP_DIALECT,
  OmpAdapter,
  PI_DIALECT,
  type Dialect,
  buildNativeBody,
  parseSessionContent,
  readSessionFile,
  readWithCarry,
  writeNativeSession,
} from "../src/index";

const CWD = "/home/demo/workspace";

async function tempStore(tag: string) {
  const root = await mkdtemp(join(tmpdir(), `sinter-lineage-${tag}-`));
  return {
    sessionsDir: join(root, "sessions"),
    carryRoot: join(root, "sinter-home"),
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** A source session as it would arrive from the codex adapter. */
function codexSession(resultText = "ok"): SifSession {
  const entries: SifEntry[] = [
    { id: "e1", parentId: null, ts: "2026-08-01T00:00:00.000Z", kind: "user", content: [{ type: "text", text: "list the repo" }] },
    {
      id: "e2",
      parentId: "e1",
      ts: "2026-08-01T00:00:01.000Z",
      kind: "assistant",
      model: { provider: "openai", id: "gpt-5.4" },
      content: [
        { type: "text", text: "running ls" },
        { type: "toolCall", callId: "call-1", name: "bash", args: { command: "ls -la" } },
      ],
    },
    {
      id: "e3",
      parentId: "e2",
      ts: "2026-08-01T00:00:02.000Z",
      kind: "toolResult",
      callId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: resultText }],
    },
    { id: "e4", parentId: "e3", ts: "2026-08-01T00:00:03.000Z", kind: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  return {
    sif: SIF_VERSION,
    id: "sif-codex-1",
    origin: { harness: "codex", nativeId: "codex-native-1" },
    cwd: CWD,
    title: { text: "port me", source: "user" },
    createdAt: "2026-08-01T00:00:00.000Z",
    entries,
  };
}

function markerData(body: string): Record<string, unknown> | undefined {
  const e = parseSessionContent(body).entries.find(
    (x) => x.type === "custom" && (x as { customType?: string }).customType === "sinter_import",
  ) as { data?: Record<string, unknown> } | undefined;
  return e?.data;
}

const MARKERS = /\[historical tool call:[\s\S]*?\]/g;
/** One marker opened inside another — the nesting a re-flatten would produce. */
const NESTED = /\[historical tool call:(?:(?!\]).)*\[historical tool call:/s;

// ------------------------------------------------------------------ round trip

describe("provenance round trip", () => {
  for (const dialect of [OMP_DIALECT, PI_DIALECT] as Dialect[]) {
    test(`${dialect.harness}: write → read recovers the record with a stable threadId`, async () => {
      const store = await tempStore(dialect.harness);
      const source = codexSession();
      const ref = await writeNativeSession(source, dialect, { ...store });

      const back = await readSessionFile(ref.nativePath!, { dialect });
      validateSession(back);
      const prov = provenanceOf(back)!;
      expect(prov).toBeDefined();
      expect(prov.threadId).toBe(ref.provenance!.threadId);
      expect(prov.hop).toBe(1);
      expect(prov.chain).toEqual([
        { harness: "codex", nativeId: "codex-native-1" },
        { harness: dialect.harness, nativeId: ref.nativeId },
      ]);
      expect(prov.from).toEqual({ harness: "codex", nativeId: "codex-native-1" });
      expect(prov.inertTools).toBe(true);
      expect(prov.portedAt).toBeTruthy();
      expect(back.preserve![PRESERVE_KEY]).toBeDefined();
      await store.cleanup();
    });
  }

  test("the v0 marker fields survive alongside the v1 record", async () => {
    const source = codexSession();
    const data = markerData(buildNativeBody(source, OMP_DIALECT).body)!;
    // v0 — anything already reading these keeps working.
    expect(data.sourceHarness).toBe("codex");
    expect(data.sourceNativeId).toBe("codex-native-1");
    expect(data.sourceSifId).toBe("sif-codex-1");
    expect(data.liveTools).toBe(false);
    expect(typeof data.importedAt).toBe("string");
    // v1.
    expect(data.v).toBe(1);
    expect(data.sinter).toBe("0.1.0");
    expect(typeof data.threadId).toBe("string");
    expect(Array.isArray(data.chain)).toBe(true);
  });

  test("mode is recorded when the caller passes one", async () => {
    const data = markerData(buildNativeBody(codexSession(), OMP_DIALECT, { mode: "compact" }).body)!;
    expect(data.mode).toBe("compact");
  });

  test("liveTools:true records inertTools:false", async () => {
    const data = markerData(buildNativeBody(codexSession(), OMP_DIALECT, { liveTools: true }).body)!;
    expect(data.inertTools).toBe(false);
    expect(data.liveTools).toBe(true);
  });

  test("a record the caller stamped with withProvenance is persisted verbatim", async () => {
    const store = await tempStore("stamped");
    const source = codexSession();
    // The caller pre-mints the target id so the record it stamps is truthful.
    const nativeId = "019ff700-0000-7000-8000-000000000abc";
    const stamped = withProvenance(
      source,
      buildProvenance({
        source,
        target: { harness: "omp", nativeId },
        sinterVersion: "9.9.9",
        portedAt: "2026-08-14T00:00:00.000Z",
        mode: "digest",
      }),
    );
    const ref = await writeNativeSession(stamped, OMP_DIALECT, { ...store, nativeId });
    const prov = provenanceOf(await readSessionFile(ref.nativePath!, { dialect: OMP_DIALECT }))!;
    expect(ref.nativeId).toBe(nativeId);
    expect(prov.sinter).toBe("9.9.9");
    expect(prov.portedAt).toBe("2026-08-14T00:00:00.000Z");
    expect(prov.mode).toBe("digest");
    expect(prov.chain[prov.hop]).toEqual({ harness: "omp", nativeId });
    await store.cleanup();
  });
});

// ------------------------------------------------------------------ multi-hop

describe("multi-hop chains", () => {
  test("codex → omp → omp is ONE thread with hops 0/1/2", async () => {
    const store = await tempStore("multihop");
    const source = codexSession();

    const hop1 = await writeNativeSession(source, OMP_DIALECT, { ...store });
    const read1 = await readSessionFile(hop1.nativePath!, { dialect: OMP_DIALECT });
    const hop2 = await writeNativeSession(read1, OMP_DIALECT, { ...store });
    const read2 = await readSessionFile(hop2.nativePath!, { dialect: OMP_DIALECT });

    const p1 = provenanceOf(read1)!;
    const p2 = provenanceOf(read2)!;
    expect(p1.threadId).toBe(p2.threadId);
    expect(p1.hop).toBe(1);
    expect(p2.hop).toBe(2);
    expect(p2.chain).toEqual([
      { harness: "codex", nativeId: "codex-native-1" },
      { harness: "omp", nativeId: hop1.nativeId },
      { harness: "omp", nativeId: hop2.nativeId },
    ]);
    expect(p2.chain.map((_, i) => i)).toEqual([0, 1, 2]);
    expect(p2.from).toEqual({ harness: "omp", nativeId: hop1.nativeId });
    await store.cleanup();
  });

  test("re-porting into a harness already in the chain APPENDS a hop", async () => {
    const store = await tempStore("report");
    const source = codexSession();

    const hopOmp = await writeNativeSession(source, OMP_DIALECT, { ...store });
    const readOmp = await readSessionFile(hopOmp.nativePath!, { dialect: OMP_DIALECT });
    const hopPi = await writeNativeSession(readOmp, PI_DIALECT, { ...store });
    const readPi = await readSessionFile(hopPi.nativePath!, { dialect: PI_DIALECT });
    const backToOmp = await writeNativeSession(readPi, OMP_DIALECT, { ...store });
    const readBack = await readSessionFile(backToOmp.nativePath!, { dialect: OMP_DIALECT });

    const prov = provenanceOf(readBack)!;
    expect(prov.threadId).toBe(provenanceOf(readOmp)!.threadId);
    expect(prov.hop).toBe(3);
    expect(prov.chain.map((h) => h.harness)).toEqual(["codex", "omp", "pi", "omp"]);
    // Two omp hops, two DIFFERENT native sessions — not collapsed into one.
    expect(prov.chain[3]!.nativeId).not.toBe(prov.chain[1]!.nativeId);
    expect(new Set(prov.chain.map((h) => h.nativeId)).size).toBe(4);
    await store.cleanup();
  });

  test("a session that was never ported starts a fresh thread", async () => {
    const store = await tempStore("fresh");
    const a = await writeNativeSession(codexSession(), OMP_DIALECT, { ...store });
    const b = await writeNativeSession(codexSession(), OMP_DIALECT, { ...store });
    expect(a.provenance!.threadId).not.toBe(b.provenance!.threadId);
    expect(a.provenance!.hop).toBe(1);
    await store.cleanup();
  });
});

// ------------------------------------------------------------------ tolerance

describe("bad markers never break a read", () => {
  const HEADER = '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}';
  const USER =
    '{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}';

  for (const [label, data] of [
    ["a string", '"not an object"'],
    ["null", "null"],
    ["unrelated keys", '{"lol":true,"chain":"not an array"}'],
    ["a chain of non-hops", '{"threadId":"t","chain":[1,2,3]}'],
    ["a number", "42"],
  ] as const) {
    test(`corrupt data (${label}) is dropped, the session still reads`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "sinter-lineage-bad-"));
      const p = join(dir, "2026-01-01T00-00-00-000Z_x.jsonl");
      await Bun.write(
        p,
        [
          HEADER,
          `{"type":"custom","customType":"sinter_import","id":"bbbbbbbb","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","data":${data}}`,
          USER,
        ].join("\n"),
      );
      const s = await readSessionFile(p, { dialect: OMP_DIALECT });
      validateSession(s);
      expect(provenanceOf(s)).toBeUndefined();
      expect(s.entries.some((e) => e.kind === "user")).toBe(true);
      // A carry read of the same file degrades to the native view, never throws.
      const carried = await readWithCarry(p, { dialect: OMP_DIALECT });
      expect(carried.entries.length).toBe(s.entries.length);
      await rm(dir, { recursive: true, force: true });
    });
  }

  test("a v0-only marker still yields a usable record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sinter-lineage-v0-"));
    const p = join(dir, "2026-01-01T00-00-00-000Z_x.jsonl");
    await Bun.write(
      p,
      [
        HEADER,
        '{"type":"custom","customType":"sinter_import","id":"bbbbbbbb","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","data":{"sinter":"0.0.1","sourceHarness":"claude","sourceNativeId":"legacy-1","importedAt":"2026-01-01T00:00:00.000Z"}}',
        USER,
      ].join("\n"),
    );
    const prov = provenanceOf(await readSessionFile(p, { dialect: OMP_DIALECT }))!;
    expect(prov.threadId).toBe("legacy:claude:legacy-1");
    // The v0 marker names only the SOURCE — it predates the chain format and
    // never knew the id the writer minted. `provenanceOf` completes it with the
    // session's own identity, so the thread contains both ends rather than an
    // ancestor pointing at nothing.
    expect(prov.chain).toEqual([
      { harness: "claude", nativeId: "legacy-1" },
      { harness: "omp", nativeId: "x" },
    ]);
    expect(prov.hop).toBe(1);
    expect(prov.from).toEqual({ harness: "claude", nativeId: "legacy-1" });
    await rm(dir, { recursive: true, force: true });
  });

  test("a carryRef pointing at a deleted sidecar falls back to the native view", async () => {
    const store = await tempStore("lostcarry");
    const source = codexSession("x".repeat(64));
    const ref = await writeNativeSession(source, OMP_DIALECT, { ...store });
    // Rewrite the marker with a carryRef that does not exist.
    const lines = (await Bun.file(ref.nativePath!).text()).split("\n");
    const patched = lines.map((l) => {
      if (!l.includes('"sinter_import"')) return l;
      const obj = JSON.parse(l) as { data: Record<string, unknown> };
      delete obj.data.carry;
      obj.data.carryRef = join(store.root, "gone", "nothing.sif.json.gz");
      return JSON.stringify(obj);
    });
    await Bun.write(ref.nativePath!, patched.join("\n"));

    const carried = await readWithCarry(ref.nativePath!, { dialect: OMP_DIALECT });
    validateSession(carried);
    expect(carried.entries.some((e) => e.kind === "toolResult")).toBe(false); // native, flattened
    expect(provenanceOf(carried)!.carryRef).toBeTruthy();
    await store.cleanup();
  });
});

// ------------------------------------------------------------------ carry-forward

describe("carry-forward", () => {
  // 9 KB so the inert flattening has to truncate it (inertToolText clips at 8000).
  const LONG = `${"o".repeat(9000)}TAIL`;

  test("the native read stays native; carry recovers the ORIGINAL entries", async () => {
    const store = await tempStore("carry");
    const source = codexSession(LONG);
    const ref = await writeNativeSession(source, OMP_DIALECT, { ...store });

    const native = await readSessionFile(ref.nativePath!, { dialect: OMP_DIALECT });
    const nativeText = JSON.stringify(native.entries);
    expect(native.entries.some((e) => e.kind === "toolResult")).toBe(false);
    expect(native.entries.flatMap((e) => (e.kind === "assistant" ? e.content : [])).some((p) => p.type === "toolCall")).toBe(
      false,
    );
    expect(nativeText).toContain("[historical tool call:");
    expect(nativeText).toContain("…[truncated]");
    expect(nativeText).not.toContain("TAIL"); // the tail is gone for good

    const carried = await readWithCarry(ref.nativePath!, { dialect: OMP_DIALECT });
    validateSession(carried);
    // Entry-for-entry the ORIGINAL source, including the live call and the full result.
    expect(carried.entries).toEqual(source.entries);
    // …but the identity is this store's, so a further port extends the chain here.
    expect(carried.origin.harness).toBe("omp");
    expect(carried.origin.nativeId).toBe(ref.nativeId);
    expect(provenanceOf(carried)!.threadId).toBe(ref.provenance!.threadId);
    await store.cleanup();
  });

  test("two hops via carry do NOT degrade or double-flatten the tool call", async () => {
    const store = await tempStore("nodegrade");
    const source = codexSession(LONG);

    const hop1 = await writeNativeSession(source, OMP_DIALECT, { ...store });
    const hop1Body = await Bun.file(hop1.nativePath!).text();
    const hop1Markers = hop1Body.match(MARKERS) ?? [];
    expect(hop1Markers.length).toBe(1);

    // Hop 2 from the CARRIED view: re-flattened from the original, not from
    // this store's own inert text.
    const carried = await readWithCarry(hop1.nativePath!, { dialect: OMP_DIALECT });
    const hop2 = await writeNativeSession(carried, PI_DIALECT, { ...store });
    const hop2Body = await Bun.file(hop2.nativePath!).text();
    const hop2Markers = hop2Body.match(MARKERS) ?? [];
    expect(hop2Markers.length).toBe(1);
    expect(hop2Markers[0]).toBe(hop1Markers[0]!); // identical, not a flatten of a flatten
    expect(NESTED.test(hop2Body)).toBe(false);

    // Hop 3, still from carry: the original entries are STILL intact.
    const carried2 = await readWithCarry(hop2.nativePath!, { dialect: PI_DIALECT });
    expect(carried2.entries).toEqual(source.entries);
    const hop3 = await writeNativeSession(carried2, OMP_DIALECT, { ...store });
    const hop3Body = await Bun.file(hop3.nativePath!).text();
    expect((hop3Body.match(MARKERS) ?? []).length).toBe(1);
    expect(NESTED.test(hop3Body)).toBe(false);
    expect(provenanceOf(await readSessionFile(hop3.nativePath!, { dialect: OMP_DIALECT }))!.hop).toBe(3);

    // The native path, by contrast, cannot get the call back at ANY hop: even a
    // same-harness move with liveTools has nothing left to re-emit.
    const nativeRead = await readSessionFile(hop1.nativePath!, { dialect: OMP_DIALECT });
    const live = buildNativeBody(nativeRead, OMP_DIALECT, { liveTools: true }).body;
    expect(live).not.toContain('"toolCall"');
    expect(live).not.toContain("TAIL");
    // From carry, liveTools restores the real call and the untruncated result.
    const liveCarried = buildNativeBody(carried, OMP_DIALECT, { liveTools: true }).body;
    expect(liveCarried).toContain('"toolCall"');
    expect(liveCarried).toContain("TAIL");
    await store.cleanup();
  });

  test("turns added in the target harness after the import survive a carry read", async () => {
    const store = await tempStore("appended");
    const source = codexSession(LONG);
    const ref = await writeNativeSession(source, OMP_DIALECT, { ...store });

    // A turn typed in omp after the import parents onto the last ported record.
    const body = await Bun.file(ref.nativePath!).text();
    const lastNativeId = parseSessionContent(body).entries.at(-1)!.id;
    const appended = JSON.stringify({
      type: "message",
      id: "ffffffff",
      parentId: lastNativeId,
      timestamp: "2026-08-02T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "a turn typed in omp" }] },
    });
    await Bun.write(ref.nativePath!, `${body.trimEnd()}\n${appended}\n`);

    const carried = await readWithCarry(ref.nativePath!, { dialect: OMP_DIALECT });
    validateSession(carried);
    expect(carried.entries.slice(0, source.entries.length)).toEqual(source.entries);
    const last = carried.entries[carried.entries.length - 1]!;
    expect(last.kind === "user" && last.content[0]!.type === "text" && last.content[0]!.text).toBe("a turn typed in omp");
    // Re-anchored to the recovered transcript rather than left dangling.
    expect(last.parentId).toBe("e4");
    await store.cleanup();
  });

  test("carry:false writes no payload and read() falls back to the native view", async () => {
    const store = await tempStore("nocarry");
    const ref = await writeNativeSession(codexSession(LONG), OMP_DIALECT, { ...store, carry: false });
    expect(ref.provenance!.carry).toBeUndefined();
    expect(ref.provenance!.carryRef).toBeUndefined();
    const carried = await readWithCarry(ref.nativePath!, { dialect: OMP_DIALECT });
    expect(carried.entries.some((e) => e.kind === "toolResult")).toBe(false);
    await store.cleanup();
  });

  test("the adapter exposes the same choice via read({useCarry})", async () => {
    const store = await tempStore("adapter");
    const source = codexSession(LONG);
    const ref = await writeNativeSession(source, OMP_DIALECT, { ...store });
    const adapter = new OmpAdapter({ sessionsDir: store.sessionsDir });

    const native = await adapter.read({ harness: "omp", nativeId: ref.nativeId });
    expect(native.entries.some((e) => e.kind === "toolResult")).toBe(false);
    const carried = await adapter.read({ harness: "omp", nativeId: ref.nativeId }, { useCarry: true });
    expect(carried.entries).toEqual(source.entries);
    await store.cleanup();
  });

  test("a payload too big to inline spills to a sidecar under carryRoot, and reads back", async () => {
    const store = await tempStore("sidecar");
    const bytes = new Uint8Array(600 * 1024);
    crypto.getRandomValues(bytes);
    const source = codexSession();
    source.entries.push({
      id: "e5",
      parentId: "e4",
      ts: "2026-08-01T00:00:04.000Z",
      kind: "user",
      // Random base64: gzip cannot shrink it below the inline ceiling.
      content: [{ type: "text", text: Buffer.from(bytes).toString("base64") }],
    });

    const ref = await writeNativeSession(source, OMP_DIALECT, { ...store });
    expect(ref.provenance!.carry).toBeUndefined();
    expect(ref.provenance!.carryRef!.startsWith(join(store.carryRoot, "carry", "omp"))).toBe(true);
    expect(await Bun.file(ref.provenance!.carryRef!).exists()).toBe(true);
    // The oversized blob is NOT inside the harness's own JSONL line.
    expect(Buffer.byteLength(await Bun.file(ref.nativePath!).text())).toBeLessThan(2 * 1024 * 1024);

    const carried = await readWithCarry(ref.nativePath!, { dialect: OMP_DIALECT });
    expect(carried.entries).toEqual(source.entries);
    await store.cleanup();
  });

  test("carry does not compound: hop 2's payload does not nest hop 1's", async () => {
    const store = await tempStore("compound");
    const source = codexSession(LONG);
    const hop1 = await writeNativeSession(source, OMP_DIALECT, { ...store });
    const carried = await readWithCarry(hop1.nativePath!, { dialect: OMP_DIALECT });
    const hop2 = await writeNativeSession(carried, OMP_DIALECT, { ...store });

    const c1 = hop1.provenance!.carry!.length;
    const c2 = hop2.provenance!.carry!.length;
    expect(c2).toBeLessThan(c1 * 2);
    // The stashed payload keeps the chain but drops the previous blob.
    const inner = (await readWithCarry(hop2.nativePath!, { dialect: OMP_DIALECT })).preserve?.[PRESERVE_KEY] as
      | SinterProvenance
      | undefined;
    expect(inner?.chain.length).toBe(3);
    await store.cleanup();
  });
});

// ------------------------------------------------------------------ dry run

describe("dryRun", () => {
  test("writes ZERO files — no session, no sidecars, no carry payload", async () => {
    const store = await tempStore("dry");
    const bytes = new Uint8Array(600 * 1024);
    crypto.getRandomValues(bytes);
    const source = codexSession();
    source.entries.push({
      id: "e5",
      parentId: "e4",
      kind: "user",
      content: [{ type: "text", text: Buffer.from(bytes).toString("base64") }],
    });

    const ref = await writeNativeSession(source, OMP_DIALECT, { ...store, dryRun: true });
    expect(ref.dryRun).toBe(true);
    expect(ref.created).toEqual([]);
    expect(ref.planned!.length).toBe(1);
    for (const p of ref.planned!) expect(await Bun.file(p).exists()).toBe(false);
    // A dry run would have needed a sidecar for this payload; it wrote none.
    expect(ref.provenance!.carryRef).toBeUndefined();
    expect(ref.provenance!.carry).toBeUndefined();
    await expect(readdir(store.carryRoot)).rejects.toThrow();
    await expect(readdir(store.sessionsDir)).rejects.toThrow();
    await store.cleanup();
  });

  test("a small payload still inlines on a dry run, so the reported bytes are real", async () => {
    const store = await tempStore("dry-small");
    const ref = await writeNativeSession(codexSession(), OMP_DIALECT, { ...store, dryRun: true });
    expect(ref.provenance!.carry).toBeTruthy();
    await expect(readdir(store.carryRoot)).rejects.toThrow();
    await store.cleanup();
  });
});
