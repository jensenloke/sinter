import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CARRY_INLINE_MAX,
  LINEAGE_VERSION,
  SIF_VERSION,
  PRESERVE_KEY,
  buildProvenance,
  carrySidecarPath,
  decodeCarry,
  encodeCarry,
  loadCarry,
  provenanceOf,
  readProvenance,
  storeCarry,
  withProvenance,
  type Hop,
  type HarnessId,
  type SifSession,
  type SinterProvenance,
} from "../src/index";

// ------------------------------------------------------------------ helpers

const TMP_ROOTS: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "sinter-lineage-"));
  TMP_ROOTS.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

/** Minimal but structurally valid SIF session. */
function session(
  harness: HarnessId,
  nativeId: string,
  opts: { text?: string; preserve?: Record<string, unknown>; host?: string } = {},
): SifSession {
  return {
    sif: "sif/0",
    id: `sif-${harness}-${nativeId}`,
    origin: { harness, nativeId, ...(opts.host ? { host: opts.host } : {}) },
    cwd: "/Users/test/proj",
    createdAt: "2026-08-01T00:00:00.000Z",
    entries: [
      {
        kind: "user",
        id: "e1",
        parentId: null,
        content: [{ type: "text", text: opts.text ?? `hello from ${harness}` }],
      },
    ],
    ...(opts.preserve ? { preserve: opts.preserve } : {}),
  };
}

/** A session as it comes back out of a store: provenance under `preserve`. */
function ported(harness: HarnessId, nativeId: string, prov: SinterProvenance): SifSession {
  return session(harness, nativeId, { preserve: { [PRESERVE_KEY]: prov } });
}

function build(
  source: SifSession,
  target: Hop,
  extra: Partial<Parameters<typeof buildProvenance>[0]> = {},
): SinterProvenance {
  return buildProvenance({
    source,
    target,
    sinterVersion: "0.1.0",
    portedAt: "2026-08-15T12:00:00.000Z",
    ...extra,
  });
}

/** Deterministic PRNG — carry-size tests must not depend on Math.random(). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-";

/** gzip compresses repeated text to nothing; only real entropy grows the blob. */
function highEntropyText(chars: number, rand: () => number): string {
  const out = new Array<string>(chars);
  for (let i = 0; i < chars; i++) out[i] = ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
  return out.join("");
}

function bigSession(harness: HarnessId, nativeId: string): SifSession {
  const rand = seeded(0xc0ffee);
  const s = session(harness, nativeId);
  s.entries = Array.from({ length: 10 }, (_, i) => ({
    kind: "user" as const,
    id: `e${i}`,
    parentId: i === 0 ? null : `e${i - 1}`,
    content: [{ type: "text" as const, text: highEntropyText(60_000, rand) }],
  }));
  return s;
}

/** True when `child` resolves to something inside `root`. */
function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

// ------------------------------------------------------------------ reading

describe("readProvenance", () => {
  test("round-trips a well-formed v1 record", () => {
    const record: SinterProvenance = {
      v: LINEAGE_VERSION,
      sinter: "0.1.0",
      threadId: "thread-abc",
      hop: 1,
      chain: [
        { harness: "codex", nativeId: "A" },
        { harness: "omp", nativeId: "B", host: "mac-mini" },
      ],
      from: { harness: "codex", nativeId: "A" },
      portedAt: "2026-08-15T12:00:00.000Z",
      mode: "slim",
      inertTools: true,
      carryBytes: 4096,
    };

    const parsed = readProvenance(JSON.parse(JSON.stringify(record)))!;
    expect(parsed).toBeDefined();
    expect(parsed.threadId).toBe("thread-abc");
    expect(parsed.hop).toBe(1);
    expect(parsed.chain).toEqual(record.chain);
    expect(parsed.from).toEqual({ harness: "codex", nativeId: "A" });
    expect(parsed.portedAt).toBe("2026-08-15T12:00:00.000Z");
    expect(parsed.mode).toBe("slim");
    expect(parsed.inertTools).toBe(true);
    expect(parsed.carryBytes).toBe(4096);
    expect(parsed.v).toBe(LINEAGE_VERSION);
  });

  test("keeps a sidecar carry reference so the payload is still findable", () => {
    const parsed = readProvenance({
      v: 1,
      sinter: "0.1.0",
      threadId: "t1",
      hop: 1,
      chain: [
        { harness: "codex", nativeId: "A" },
        { harness: "omp", nativeId: "B" },
      ],
      portedAt: "",
      carryRef: "/tmp/sinter/carry/omp/B.sif.json.gz",
      carryBytes: 900_000,
    })!;
    expect(parsed.carryRef).toBe("/tmp/sinter/carry/omp/B.sif.json.gz");
  });

  test("drops carry fields that are not the right type", () => {
    const parsed = readProvenance({
      threadId: "t1",
      chain: [{ harness: "codex", nativeId: "A" }],
      carry: 12,
      carryRef: { path: "nope" },
      carryBytes: "big",
      mode: 7,
      inertTools: "yes",
    })!;
    expect(parsed.carry).toBeUndefined();
    expect(parsed.carryRef).toBeUndefined();
    expect(parsed.carryBytes).toBeUndefined();
    expect(parsed.mode).toBeUndefined();
    expect(parsed.inertTools).toBeUndefined();
    expect(parsed.sinter).toBe("0");
    expect(parsed.portedAt).toBe("");
  });

  test("upgrades the v0 marker to a chain with a derived, stable thread id", () => {
    const marker = {
      sinter: "0.0.1",
      sourceHarness: "claude",
      sourceNativeId: "550e8400-e29b-41d4-a716-446655440000",
      importedAt: "2026-07-01T00:00:00.000Z",
    };

    const first = readProvenance(marker)!;
    expect(first).toBeDefined();
    expect(first.threadId).toBe("legacy:claude:550e8400-e29b-41d4-a716-446655440000");
    expect(first.hop).toBe(1);
    expect(first.from).toEqual({ harness: "claude", nativeId: "550e8400-e29b-41d4-a716-446655440000" });
    expect(first.chain[0]).toEqual({ harness: "claude", nativeId: "550e8400-e29b-41d4-a716-446655440000" });
    expect(first.portedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(first.sinter).toBe("0.0.1");

    // Reading the same marker again must agree on the identity — the id is
    // derived from the parent, never minted.
    const second = readProvenance({ ...marker });
    expect(second!.threadId).toBe(first.threadId);
  });

  test("a v0 marker's ancestry continues into a real chain on the next port", () => {
    const legacy = readProvenance({
      sourceHarness: "claude",
      sourceNativeId: "old-1",
      importedAt: "2026-07-01T00:00:00.000Z",
    })!;
    const src = ported("codex", "mid-1", legacy);
    const prov = build(src, { harness: "omp", nativeId: "new-1" });

    expect(prov.threadId).toBe("legacy:claude:old-1");
    expect(prov.chain).toEqual([
      { harness: "claude", nativeId: "old-1" },
      { harness: "codex", nativeId: "mid-1" },
      { harness: "omp", nativeId: "new-1" },
    ]);
    expect(prov.hop).toBe(2);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "sinter"],
    ["an array", []],
    ["an empty object", {}],
    ["a record with an empty chain", { threadId: "t1", chain: [] }],
    ["a record with a chain of only junk", { threadId: "t1", chain: [1, "x", null, {}] }],
    ["a threadId that is not a string", { threadId: 9, chain: [{ harness: "omp", nativeId: "B" }] }],
    ["a chain that is not an array", { threadId: "t1", chain: { harness: "omp" } }],
    ["a half-written v0 marker", { sinter: "0.0.1", sourceHarness: "claude" }],
  ])("returns undefined rather than throwing for %s", (_label, raw) => {
    expect(() => readProvenance(raw)).not.toThrow();
    expect(readProvenance(raw)).toBeUndefined();
  });

  test("filters non-Hop junk out of a chain and keeps the real hops in order", () => {
    const parsed = readProvenance({
      threadId: "t1",
      hop: 1,
      chain: [
        { harness: "codex", nativeId: "A" },
        null,
        "garbage",
        42,
        { harness: "omp" },
        { nativeId: "no-harness" },
        { harness: "pi", nativeId: 7 },
        { harness: "zcode", nativeId: "C" },
      ],
    })!;
    expect(parsed.chain).toEqual([
      { harness: "codex", nativeId: "A" },
      { harness: "zcode", nativeId: "C" },
    ]);
  });

  test("clamps an out-of-range hop into the chain", () => {
    const chain = [
      { harness: "codex" as const, nativeId: "A" },
      { harness: "omp" as const, nativeId: "B" },
    ];
    expect(readProvenance({ threadId: "t1", hop: 99, chain })!.hop).toBe(1);
    expect(readProvenance({ threadId: "t1", hop: -3, chain })!.hop).toBe(1);
    expect(readProvenance({ threadId: "t1", hop: "2", chain })!.hop).toBe(1);
    expect(readProvenance({ threadId: "t1", chain })!.hop).toBe(1);
    expect(readProvenance({ threadId: "t1", hop: 0, chain })!.hop).toBe(0);
  });

  test("a hop clamped by junk-filtering still points at a real chain element", () => {
    const parsed = readProvenance({
      threadId: "t1",
      hop: 3,
      chain: [{ harness: "codex", nativeId: "A" }, null, null, { harness: "omp", nativeId: "B" }],
    })!;
    expect(parsed.chain[parsed.hop]).toBeDefined();
    expect(parsed.chain[parsed.hop]).toEqual({ harness: "omp", nativeId: "B" });
  });

  test("derives `from` from the chain when the record does not denormalise it", () => {
    const parsed = readProvenance({
      threadId: "t1",
      hop: 2,
      chain: [
        { harness: "codex", nativeId: "A" },
        { harness: "omp", nativeId: "B" },
        { harness: "pi", nativeId: "C" },
      ],
    })!;
    expect(parsed.from).toEqual({ harness: "omp", nativeId: "B" });
  });

  test("leaves `from` undefined at the root of a chain", () => {
    const parsed = readProvenance({
      threadId: "t1",
      hop: 0,
      chain: [{ harness: "codex", nativeId: "A" }],
    })!;
    expect(parsed.from).toBeUndefined();
  });
});

// ------------------------------------------------------------------ writing

describe("buildProvenance", () => {
  test("starts a new thread when the source has never been ported", () => {
    const src = session("codex", "A");
    const prov = build(src, { harness: "omp", nativeId: "B" });

    expect(prov.chain).toEqual([
      { harness: "codex", nativeId: "A" },
      { harness: "omp", nativeId: "B" },
    ]);
    expect(prov.hop).toBe(1);
    expect(prov.threadId).toBeTruthy();
    expect(prov.sinter).toBe("0.1.0");
    expect(prov.portedAt).toBe("2026-08-15T12:00:00.000Z");
    expect(prov.v).toBe(LINEAGE_VERSION);
  });

  test("mints a distinct thread id for each unported source", () => {
    const a = build(session("codex", "A"), { harness: "omp", nativeId: "B" });
    const b = build(session("codex", "A2"), { harness: "omp", nativeId: "B2" });
    expect(a.threadId).not.toBe(b.threadId);
  });

  test("carries the source host onto its hop", () => {
    const prov = build(session("claude", "A", { host: "mac-mini" }), { harness: "omp", nativeId: "B" });
    expect(prov.chain[0]).toEqual({ harness: "claude", nativeId: "A", host: "mac-mini" });
  });

  test("extends an existing thread instead of starting a new one", () => {
    const first = build(session("codex", "A"), { harness: "omp", nativeId: "B" });
    const second = build(ported("omp", "B", first), { harness: "pi", nativeId: "C" });

    expect(second.threadId).toBe(first.threadId);
    expect(second.chain).toHaveLength(first.chain.length + 1);
    expect(second.hop).toBe(first.hop + 1);
    expect(second.chain.slice(0, 2)).toEqual(first.chain);
  });

  test("re-entering a harness already in the chain is a later hop, not a collapse", () => {
    // codex:A -> omp:B -> codex:C
    const hop1 = build(session("codex", "A"), { harness: "omp", nativeId: "B" });
    const hop2 = build(ported("omp", "B", hop1), { harness: "codex", nativeId: "C" });

    expect(hop2.threadId).toBe(hop1.threadId);
    expect(hop2.chain).toEqual([
      { harness: "codex", nativeId: "A" },
      { harness: "omp", nativeId: "B" },
      { harness: "codex", nativeId: "C" },
    ]);
    expect(hop2.chain).toHaveLength(3);
    expect(hop2.hop).toBe(2);
    expect(hop2.from).toEqual({ harness: "omp", nativeId: "B" });
    expect(hop2.chain.map((h) => h.harness)).toEqual(["codex", "omp", "codex"]);

    // And it survives the trip through the store unchanged.
    const reread = readProvenance(JSON.parse(JSON.stringify(hop2)))!;
    expect(reread.chain).toEqual(hop2.chain);
    expect(reread.hop).toBe(2);
    expect(reread.threadId).toBe(hop1.threadId);
  });

  test("returning to the exact same native session is still a new hop", () => {
    const hop1 = build(session("codex", "A"), { harness: "omp", nativeId: "B" });
    const hop2 = build(ported("omp", "B", hop1), { harness: "codex", nativeId: "A" });

    expect(hop2.chain).toHaveLength(3);
    expect(hop2.chain[2]).toEqual({ harness: "codex", nativeId: "A" });
    expect(hop2.hop).toBe(2);
    expect(hop2.threadId).toBe(hop1.threadId);
  });

  test("keeps one thread id and hops in order across a four-hop tour", () => {
    let prov = build(session("claude", "S0"), { harness: "codex", nativeId: "S1" });
    const threadId = prov.threadId;
    const tour: Array<[HarnessId, string]> = [
      ["opencode", "S2"],
      ["claude", "S3"],
      ["codex", "S4"],
    ];
    let current = ported("codex", "S1", prov);
    for (const [harness, nativeId] of tour) {
      prov = build(current, { harness, nativeId });
      current = ported(harness, nativeId, prov);
    }

    expect(prov.threadId).toBe(threadId);
    expect(prov.chain.map((h) => `${h.harness}:${h.nativeId}`)).toEqual([
      "claude:S0",
      "codex:S1",
      "opencode:S2",
      "claude:S3",
      "codex:S4",
    ]);
    expect(prov.hop).toBe(4);
    expect(prov.chain[prov.hop]).toEqual({ harness: "codex", nativeId: "S4" });
  });

  test("does not append the source twice when the prior chain already ends at it", () => {
    // The normal case: the source's own record was written with the source as
    // the chain's tail.
    const prior: SinterProvenance = {
      v: LINEAGE_VERSION,
      sinter: "0.1.0",
      threadId: "t-dedupe",
      hop: 1,
      chain: [
        { harness: "claude", nativeId: "root" },
        { harness: "omp", nativeId: "B" },
      ],
      portedAt: "2026-08-10T00:00:00.000Z",
    };
    const prov = build(ported("omp", "B", prior), { harness: "pi", nativeId: "C" });

    expect(prov.chain).toEqual([
      { harness: "claude", nativeId: "root" },
      { harness: "omp", nativeId: "B" },
      { harness: "pi", nativeId: "C" },
    ]);
    expect(prov.chain.filter((h) => h.nativeId === "B")).toHaveLength(1);
    expect(prov.hop).toBe(2);
  });

  test("appends the source when the prior chain does not end at it", () => {
    // A record whose tail is some other session — the source itself is a new,
    // as-yet-unrecorded link and must be inserted before the target.
    const prior: SinterProvenance = {
      v: LINEAGE_VERSION,
      sinter: "0.1.0",
      threadId: "t-append",
      hop: 0,
      chain: [{ harness: "claude", nativeId: "root" }],
      portedAt: "2026-08-10T00:00:00.000Z",
    };
    const prov = build(ported("codex", "mid", prior), { harness: "pi", nativeId: "C" });

    expect(prov.chain).toEqual([
      { harness: "claude", nativeId: "root" },
      { harness: "codex", nativeId: "mid" },
      { harness: "pi", nativeId: "C" },
    ]);
    expect(prov.hop).toBe(2);
    expect(prov.threadId).toBe("t-append");
  });

  test("a matching harness with a different native id is not deduped", () => {
    const prior: SinterProvenance = {
      v: LINEAGE_VERSION,
      sinter: "0.1.0",
      threadId: "t-x",
      hop: 0,
      chain: [{ harness: "omp", nativeId: "OTHER" }],
      portedAt: "",
    };
    const prov = build(ported("omp", "B", prior), { harness: "pi", nativeId: "C" });
    expect(prov.chain.map((h) => h.nativeId)).toEqual(["OTHER", "B", "C"]);
  });

  test("`from` is always the second-to-last chain element", () => {
    const one = build(session("codex", "A"), { harness: "omp", nativeId: "B" });
    expect(one.from).toEqual(one.chain[one.chain.length - 2]!);
    expect(one.from).toEqual({ harness: "codex", nativeId: "A" });

    const two = build(ported("omp", "B", one), { harness: "codex", nativeId: "C" });
    expect(two.from).toEqual(two.chain[two.chain.length - 2]!);
    expect(two.from).toEqual({ harness: "omp", nativeId: "B" });

    const three = build(ported("codex", "C", two), { harness: "pi", nativeId: "D" });
    expect(three.from).toEqual(three.chain[three.chain.length - 2]!);
    expect(three.from).toEqual({ harness: "codex", nativeId: "C" });
  });

  test("passes the transfer mode and tool-inertness through", () => {
    const prov = build(session("codex", "A"), { harness: "omp", nativeId: "B" }, {
      mode: "compact",
      inertTools: false,
      carry: "Zm9v",
      carryBytes: 3,
    });
    expect(prov.mode).toBe("compact");
    expect(prov.inertTools).toBe(false);
    expect(prov.carry).toBe("Zm9v");
    expect(prov.carryBytes).toBe(3);
  });

  test("ignores unreadable provenance on the source and starts fresh", () => {
    const src = session("codex", "A", { preserve: { [PRESERVE_KEY]: { garbage: true } } });
    const prov = build(src, { harness: "omp", nativeId: "B" });
    expect(prov.chain).toHaveLength(2);
    expect(prov.threadId).not.toContain("garbage");
    expect(prov.threadId).toBeTruthy();
  });

  test("does not mutate the source session's stored chain", () => {
    const first = build(session("codex", "A"), { harness: "omp", nativeId: "B" });
    const snapshot = JSON.parse(JSON.stringify(first));
    const src = ported("omp", "B", first);
    build(src, { harness: "pi", nativeId: "C" });
    expect(first).toEqual(snapshot);
    expect(provenanceOf(src)!.chain).toHaveLength(2);
  });
});

// ------------------------------------------------------------- carry codec

describe("encodeCarry / decodeCarry", () => {
  test("round-trips a session byte-identically", () => {
    const s = session("claude", "round-trip", { text: "keep every ✓ byte — even ünicode" });
    s.title = { text: "a title", source: "user" };
    s.subsessions = [session("claude", "round-trip/agent-1")];
    s.preserve = { anything: { opaque: [1, 2, 3] } };

    const decoded = decodeCarry(encodeCarry(s))!;
    expect(decoded).toEqual(s);
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(s));
  });

  test("compresses — the encoding is not just base64 of the json", () => {
    const s = session("claude", "big", { text: "repeat ".repeat(20_000) });
    const encoded = encodeCarry(s)!;
    expect(encoded.length).toBeLessThan(JSON.stringify(s).length / 10);
    expect(decodeCarry(encoded)).toEqual(s);
  });

  test("returns undefined when the session exceeds maxBytes", () => {
    const s = session("claude", "too-big", { text: "x".repeat(5_000) });
    expect(encodeCarry(s, 100)).toBeUndefined();
    expect(encodeCarry(s, 10 * 1024 * 1024)).toBeDefined();
  });

  test.each([
    ["undefined", undefined],
    ["an empty string", ""],
    ["something that is not base64", "not base64!!"],
    ["valid base64 that is not gzip", Buffer.from("hello world, plainly").toString("base64")],
    [
      "gzip of something that is not json",
      Buffer.from(Bun.gzipSync(new TextEncoder().encode("not json at all"))).toString("base64"),
    ],
    [
      "gzip of json that is not a SIF session",
      Buffer.from(Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ hello: "world" })))).toString(
        "base64",
      ),
    ],
    [
      "gzip of a session whose entries are missing",
      Buffer.from(
        Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ sif: "sif/0", id: "x", entries: null }))),
      ).toString("base64"),
    ],
    [
      "a truncated gzip blob",
      Buffer.from(Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ entries: [] }))))
        .toString("base64")
        .slice(0, 12),
    ],
  ])("returns undefined without throwing for %s", (_label, encoded) => {
    expect(() => decodeCarry(encoded as string | undefined)).not.toThrow();
    expect(decodeCarry(encoded as string | undefined)).toBeUndefined();
  });
});

// ------------------------------------------------------ carry persistence

describe("storeCarry / loadCarry", () => {
  test("inlines a small session and writes no file", async () => {
    const root = tempRoot();
    const s = session("codex", "small-1");
    const target: Hop = { harness: "omp", nativeId: "omp-small-1" };

    const stored = await storeCarry(s, target, { root });
    expect(stored.carry).toBeDefined();
    expect(stored.carryRef).toBeUndefined();
    expect(stored.carryBytes).toBe(JSON.stringify(s).length);
    expect(stored.carry!.length).toBeLessThanOrEqual(CARRY_INLINE_MAX);
    expect(await Bun.file(carrySidecarPath(target.harness, target.nativeId, root)).exists()).toBe(false);

    expect(await loadCarry({ ...baseProv(), ...stored })).toEqual(s);
  });

  test("spills a session whose compressed payload exceeds the inline limit to a sidecar", async () => {
    const root = tempRoot();
    const s = bigSession("codex", "big-1");
    // Guard the fixture itself: if gzip ever gets good enough to squeeze this
    // under the limit the test below would silently stop testing the spill.
    expect(encodeCarry(s)!.length).toBeGreaterThan(CARRY_INLINE_MAX);

    const target: Hop = { harness: "omp", nativeId: "omp-big-1" };
    const stored = await storeCarry(s, target, { root });

    expect(stored.carry).toBeUndefined();
    expect(stored.carryRef).toBe(carrySidecarPath(target.harness, target.nativeId, root));
    expect(stored.carryBytes).toBe(JSON.stringify(s).length);
    expect(await Bun.file(stored.carryRef!).exists()).toBe(true);
    expect(isInside(root, stored.carryRef!)).toBe(true);

    expect(await loadCarry({ ...baseProv(), ...stored })).toEqual(s);
  });

  test("a sidecar for a slash-bearing subagent id still lands inside the carry root", async () => {
    const root = tempRoot();
    const s = bigSession("claude", "sub-1");
    const target: Hop = { harness: "claude", nativeId: "550e8400-e29b-41d4-a716-446655440000/agent-abc" };

    const stored = await storeCarry(s, target, { root });
    expect(stored.carryRef).toBeDefined();
    expect(isInside(root, stored.carryRef!)).toBe(true);
    expect(await Bun.file(stored.carryRef!).exists()).toBe(true);
    expect(await loadCarry({ ...baseProv(), ...stored })).toEqual(s);
  });

  test("returns nothing at all when the session is too big to carry", async () => {
    const root = tempRoot();
    const s = session("codex", "huge");
    const stored = await storeCarry(s, { harness: "omp", nativeId: "B" }, { root, maxBytes: 10 });
    expect(stored).toEqual({});
    expect(await loadCarry({ ...baseProv(), ...stored })).toBeUndefined();
  });

  test("loadCarry returns undefined for a missing or corrupt sidecar and never throws", async () => {
    const root = tempRoot();
    const missing = { ...baseProv(), carryRef: join(root, "carry", "omp", "nope.sif.json.gz") };
    expect(await loadCarry(missing)).toBeUndefined();

    const corruptPath = join(root, "carry", "omp", "corrupt.sif.json.gz");
    await Bun.write(corruptPath, "this is not a gzip stream");
    expect(await loadCarry({ ...baseProv(), carryRef: corruptPath })).toBeUndefined();

    const dirAsFile = { ...baseProv(), carryRef: join(root, "carry") };
    expect(await loadCarry(dirAsFile)).toBeUndefined();
  });

  test("loadCarry returns undefined for no provenance and for provenance with no carry", async () => {
    expect(await loadCarry(undefined)).toBeUndefined();
    expect(await loadCarry(baseProv())).toBeUndefined();
    expect(await loadCarry({ ...baseProv(), carry: "not base64!!" })).toBeUndefined();
  });

  test("a sidecar carry survives the trip through a session's preserve block", async () => {
    const root = tempRoot();
    const s = bigSession("codex", "persisted");
    const target: Hop = { harness: "omp", nativeId: "omp-persisted" };
    const stored = await storeCarry(s, target, { root });
    expect(stored.carryRef).toBeDefined();

    const prov: SinterProvenance = { ...build(s, target), ...stored };
    const written = withProvenance(session("omp", "omp-persisted"), prov);
    // What an adapter actually does: serialise into the store, read back out.
    const reread = provenanceOf(JSON.parse(JSON.stringify(written)) as SifSession)!;

    expect(reread.carryRef).toBe(stored.carryRef);
    expect(await loadCarry(reread)).toEqual(s);
  });
});

function baseProv(): SinterProvenance {
  return {
    v: LINEAGE_VERSION,
    sinter: "0.1.0",
    threadId: "t-carry",
    hop: 1,
    chain: [
      { harness: "codex", nativeId: "A" },
      { harness: "omp", nativeId: "B" },
    ],
    portedAt: "2026-08-15T12:00:00.000Z",
  };
}

// ------------------------------------------------------------- path safety

describe("carrySidecarPath", () => {
  test("puts a plain session under <root>/carry/<harness>/", () => {
    const path = carrySidecarPath("omp", "abc123", "/tmp/sinter-home");
    expect(path).toBe("/tmp/sinter-home/carry/omp/abc123.sif.json.gz");
  });

  test.each([
    ["a claude subagent id", "550e8400-e29b-41d4-a716-446655440000/agent-abc"],
    ["a windows-style separator", "sess\\agent-abc"],
    ["a relative traversal", "../../etc/passwd"],
    ["a windows traversal", "..\\..\\Windows\\System32\\config"],
    ["an absolute path", "/etc/passwd"],
    ["mixed separators and dots", "..//..\\..//root/.ssh/id_rsa"],
    ["a bare dot-dot", ".."],
    ["nested traversal after a uuid", "550e8400/../../../../tmp/pwned"],
  ])("does not let %s escape the carry directory", (_label, nativeId) => {
    const root = "/tmp/sinter-home";
    const path = carrySidecarPath("claude", nativeId, root);
    expect(isInside(`${root}/carry/claude`, path)).toBe(true);
    // The filename must be a single path segment — no separator the caller
    // supplied may survive into it.
    const filename = path.slice(`${root}/carry/claude/`.length);
    expect(filename).not.toContain("/");
    expect(filename).not.toContain("\\");
    expect(path.endsWith(".sif.json.gz")).toBe(true);
  });

  test("honours SINTER_HOME when no explicit root is given", () => {
    const prev = process.env.SINTER_HOME;
    process.env.SINTER_HOME = "/tmp/sinter-env-home";
    try {
      expect(carrySidecarPath("pi", "p1")).toBe("/tmp/sinter-env-home/carry/pi/p1.sif.json.gz");
    } finally {
      if (prev === undefined) delete process.env.SINTER_HOME;
      else process.env.SINTER_HOME = prev;
    }
  });
});

// --------------------------------------------------------- session binding

describe("withProvenance / provenanceOf", () => {
  test("round-trips a record through a session", () => {
    const s = session("omp", "B");
    const prov = build(session("codex", "A"), { harness: "omp", nativeId: "B" });
    const stamped = withProvenance(s, prov);

    expect(stamped.preserve![PRESERVE_KEY]).toEqual(prov);
    expect(provenanceOf(stamped)).toEqual(prov);
    // …and through an actual serialisation, which is what a store does.
    expect(provenanceOf(JSON.parse(JSON.stringify(stamped)) as SifSession)).toEqual(prov);
  });

  test("does not mutate the session it stamps", () => {
    const s = session("omp", "B", { preserve: { opencodeMeta: { keep: "me" } } });
    const snapshot = JSON.parse(JSON.stringify(s));
    const prov = build(session("codex", "A"), { harness: "omp", nativeId: "B" });

    const stamped = withProvenance(s, prov);
    expect(s).toEqual(snapshot);
    expect(s.preserve![PRESERVE_KEY]).toBeUndefined();
    expect(stamped).not.toBe(s);
    expect(stamped.preserve).not.toBe(s.preserve);
  });

  test("keeps other adapters' preserve blobs alongside the record", () => {
    const s = session("omp", "B", { preserve: { opencodeMeta: { keep: "me" } } });
    const prov = build(session("codex", "A"), { harness: "omp", nativeId: "B" });
    const stamped = withProvenance(s, prov);
    expect(stamped.preserve!.opencodeMeta).toEqual({ keep: "me" });
  });

  test("overwrites a previous record rather than nesting a second one", () => {
    const first = build(session("codex", "A"), { harness: "omp", nativeId: "B" });
    const second = build(ported("omp", "B", first), { harness: "pi", nativeId: "C" });
    const stamped = withProvenance(withProvenance(session("pi", "C"), first), second);

    expect(provenanceOf(stamped)).toEqual(second);
    expect(Object.keys(stamped.preserve!)).toEqual([PRESERVE_KEY]);
  });

  test("returns undefined for a session with no provenance at all", () => {
    expect(provenanceOf(session("codex", "A"))).toBeUndefined();
    expect(provenanceOf(session("codex", "A", { preserve: { other: 1 } }))).toBeUndefined();
  });
});

describe("provenanceOf completes the chain with the session's own identity", () => {
  const withMarker = (marker: unknown, harness: HarnessId, nativeId: string): SifSession => ({
    sif: SIF_VERSION,
    id: "sif-x",
    origin: { harness, nativeId },
    cwd: "/proj",
    entries: [],
    preserve: { [PRESERVE_KEY]: marker },
  });

  test("a v0 legacy marker gains the reading session as its final hop", () => {
    const s = withMarker(
      { sinter: "0.0.1", sourceHarness: "codex", sourceNativeId: "cdx-1", importedAt: "2026-01-01T00:00:00.000Z" },
      "omp",
      "omp-9",
    );
    const prov = provenanceOf(s)!;
    // Without this the relinked thread would hold the ancestor but not the
    // session that was actually ported — a one-hop thread that groups nothing.
    expect(prov.chain).toEqual([
      { harness: "codex", nativeId: "cdx-1" },
      { harness: "omp", nativeId: "omp-9" },
    ]);
    expect(prov.hop).toBe(1);
    expect(prov.from).toEqual({ harness: "codex", nativeId: "cdx-1" });
  });

  test("a well-formed record whose chain already ends at the session is untouched", () => {
    const prov = buildProvenance({
      source: {
        sif: SIF_VERSION,
        id: "sif-a",
        origin: { harness: "codex", nativeId: "cdx-1" },
        cwd: "/proj",
        entries: [],
      } as SifSession,
      target: { harness: "omp", nativeId: "omp-9" },
      sinterVersion: "0.1.0",
      portedAt: "2026-01-01T00:00:00.000Z",
    });
    const round = provenanceOf(withMarker(prov, "omp", "omp-9"))!;
    expect(round.chain).toEqual(prov.chain);
    expect(round.hop).toBe(prov.hop);
  });

  test("a chain ending somewhere else is repaired, not replaced", () => {
    const marker = {
      v: 1,
      sinter: "0.1.0",
      threadId: "T",
      hop: 1,
      chain: [
        { harness: "codex", nativeId: "cdx-1" },
        { harness: "omp", nativeId: "some-other-id" },
      ],
      portedAt: "2026-01-01T00:00:00.000Z",
    };
    const prov = provenanceOf(withMarker(marker, "omp", "omp-9"))!;
    expect(prov.threadId).toBe("T");
    expect(prov.chain.map((c) => c.nativeId)).toEqual(["cdx-1", "some-other-id", "omp-9"]);
    expect(prov.hop).toBe(2);
  });

  test("a session with no marker still yields undefined", () => {
    expect(provenanceOf(withMarker(undefined, "omp", "omp-9"))).toBeUndefined();
  });
});
