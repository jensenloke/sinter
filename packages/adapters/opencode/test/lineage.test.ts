/**
 * Lineage round-tripping for the opencode adapter: does a conversation keep
 * ONE identity across repeated ports, and does its transcript survive the
 * flattening a port applies?
 *
 * These tests never shell out to the real `opencode` CLI (that would write into
 * the user's live store). They pair `prepareOpencodeExport` — the payload
 * `write()` hands to `opencode import` — with `materializeExport`, a faithful
 * stand-in for the importer, and then read the resulting temp db back through
 * the adapter. That is a genuine write → store → read round trip.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRESERVE_KEY,
  SIF_VERSION,
  buildProvenance,
  mintSifId,
  provenanceOf,
  type SifSession,
  type SinterProvenance,
  type WriteOpts,
} from "@sinter/core";
import { OpencodeAdapter, prepareOpencodeExport } from "../src/index";
import { materializeExport } from "./materialize";

let root: string;
let dbSeq = 0;
const previousHome = process.env.SINTER_HOME;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sinter-opencode-lineage-"));
  // Carry sidecars must land in a throwaway dir, never ~/.sinter.
  process.env.SINTER_HOME = join(root, "sinter-home");
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.SINTER_HOME;
  else process.env.SINTER_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

const freshDb = () => join(root, `store-${dbSeq++}.db`);

/** A source transcript with a real tool call, as some other harness would hand it over. */
function sourceSession(): SifSession {
  return {
    sif: SIF_VERSION,
    id: mintSifId(),
    origin: { harness: "codex", nativeId: "cx-1" },
    cwd: "/tmp/proj",
    title: { text: "porting me", source: "auto" },
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
        content: [
          { type: "text", text: "on it" },
          { type: "toolCall", callId: "call1", name: "bash", args: { command: "ls" } },
        ],
        model: { provider: "openai", id: "gpt-x" },
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

/** Port a session into an opencode store, exactly as write() would. */
async function port(
  session: SifSession,
  dbPath: string,
  opts?: WriteOpts,
): Promise<{ nativeId: string; provenance: SinterProvenance }> {
  const { payload, nativeId, provenance } = await prepareOpencodeExport(session, opts, session.cwd ?? "/tmp/proj");
  materializeExport(dbPath, payload);
  return { nativeId, provenance };
}

const allText = (s: SifSession): string =>
  s.entries
    .flatMap((e) => (e.kind === "assistant" || e.kind === "user" ? (e.content as { type: string; text?: string }[]) : []))
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");

const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("write → store → read: provenance round trip", () => {
  test("a ported session comes back with its provenance record intact", async () => {
    const db = freshDb();
    const { nativeId, provenance } = await port(sourceSession(), db);
    const back = await new OpencodeAdapter(db).read({ harness: "opencode", nativeId });

    const recovered = provenanceOf(back);
    expect(recovered).toBeDefined();
    expect(recovered!.threadId).toBe(provenance.threadId);
    expect(recovered!.hop).toBe(1);
    expect(recovered!.chain).toEqual([
      { harness: "codex", nativeId: "cx-1" },
      { harness: "opencode", nativeId },
    ]);
    expect(recovered!.from).toEqual({ harness: "codex", nativeId: "cx-1" });
    expect(recovered!.sinter).toBe("0.1.0");
    expect(recovered!.inertTools).toBe(true);
  });

  test("the record rides in a text part's metadata, not in conversation text", async () => {
    const { payload } = await prepareOpencodeExport(sourceSession(), {}, "/tmp/proj");
    const marker = payload.messages[0].parts[0];
    expect(marker.type).toBe("text");
    expect(marker.metadata[PRESERVE_KEY].threadId).toBeTruthy();
    // The visible text stays the human marker — no JSON, no base64 carry blob.
    expect(marker.text).toContain("imported via sinter from codex:cx-1");
    const everyText = payload.messages.flatMap((m: any) => m.parts.map((p: any) => p.text ?? ""));
    for (const t of everyText) expect(t).not.toContain("threadId");
  });

  test("reading the same session twice agrees on the thread id", async () => {
    const db = freshDb();
    const { nativeId } = await port(sourceSession(), db);
    const adapter = new OpencodeAdapter(db);
    const a = await adapter.read({ harness: "opencode", nativeId });
    const b = await adapter.read({ harness: "opencode", nativeId });
    expect(provenanceOf(a)!.threadId).toBe(provenanceOf(b)!.threadId);
  });
});

describe("multi-hop identity", () => {
  test("three hops share ONE thread id and occupy chain positions 0/1/2/3 in order", async () => {
    const db = freshDb();
    const adapter = new OpencodeAdapter(db);

    const first = await port(sourceSession(), db);
    const readA = await adapter.readWithCarry({ harness: "opencode", nativeId: first.nativeId });
    const second = await port(readA, db);
    const readB = await adapter.readWithCarry({ harness: "opencode", nativeId: second.nativeId });
    const third = await port(readB, db);

    const provs = await Promise.all(
      [first, second, third].map(async (h) =>
        provenanceOf(await adapter.read({ harness: "opencode", nativeId: h.nativeId }))!,
      ),
    );

    // one identity, three hops
    expect(new Set(provs.map((p) => p.threadId)).size).toBe(1);
    expect(provs.map((p) => p.hop)).toEqual([1, 2, 3]);
    expect(provs.map((p) => p.chain.length)).toEqual([2, 3, 4]);

    const final = provs[2]!.chain;
    expect(final.map((h) => h.harness)).toEqual(["codex", "opencode", "opencode", "opencode"]);
    expect(final.map((h) => h.nativeId)).toEqual([
      "cx-1",
      first.nativeId,
      second.nativeId,
      third.nativeId,
    ]);
    // every hop knows its own index within the chain it carries
    for (const p of provs) expect(p.chain[p.hop]!.harness).toBe("opencode");
    expect(provs.map((p) => p.from!.nativeId)).toEqual(["cx-1", first.nativeId, second.nativeId]);
  });

  test("porting back into a harness already in the chain appends a hop, never collapses one", async () => {
    const db = freshDb();
    const adapter = new OpencodeAdapter(db);

    const first = await port(sourceSession(), db);
    const readA = await adapter.readWithCarry({ harness: "opencode", nativeId: first.nativeId });

    // Simulate the intermediate codex hop another adapter would have written.
    const viaCodex: SifSession = {
      ...readA,
      origin: { harness: "codex", nativeId: "cx-2" },
      preserve: {
        ...readA.preserve,
        [PRESERVE_KEY]: buildProvenance({
          source: readA,
          target: { harness: "codex", nativeId: "cx-2" },
          sinterVersion: "0.1.0",
          portedAt: "2026-02-02T00:00:00.000Z",
        }),
      },
    };

    const second = await port(viaCodex, db);
    const prov = provenanceOf(await adapter.read({ harness: "opencode", nativeId: second.nativeId }))!;

    expect(prov.threadId).toBe(first.provenance.threadId);
    expect(prov.chain).toEqual([
      { harness: "codex", nativeId: "cx-1" },
      { harness: "opencode", nativeId: first.nativeId },
      { harness: "codex", nativeId: "cx-2" },
      { harness: "opencode", nativeId: second.nativeId },
    ]);
    expect(prov.hop).toBe(3);
  });

  test("a record the caller built for this write is persisted as-is", async () => {
    const db = freshDb();
    const preset = buildProvenance({
      source: sourceSession(),
      target: { harness: "opencode", nativeId: "ses_caller_minted" },
      sinterVersion: "9.9.9",
      portedAt: "2026-03-03T00:00:00.000Z",
      mode: "compact",
    });
    const session: SifSession = {
      ...sourceSession(),
      preserve: { [PRESERVE_KEY]: preset },
    };
    const { nativeId } = await port(session, db);
    const prov = provenanceOf(await new OpencodeAdapter(db).read({ harness: "opencode", nativeId }))!;
    expect(prov.threadId).toBe(preset.threadId);
    expect(prov.sinter).toBe("9.9.9");
    expect(prov.mode).toBe("compact");
    // The caller's record is stored verbatim, but its chain names a target id
    // the caller invented rather than the one the writer actually minted. A
    // chain must end at the session holding it, so the read repairs the tail.
    expect(prov.chain.slice(0, preset.chain.length)).toEqual(preset.chain);
    expect(prov.chain[prov.chain.length - 1]).toEqual({ harness: "opencode", nativeId });
  });
});

describe("tolerance", () => {
  test("a garbage provenance marker does not break read()", async () => {
    const db = freshDb();
    const { payload } = await prepareOpencodeExport(sourceSession(), {}, "/tmp/proj");
    // Corrupt the record in every way a store realistically can.
    payload.messages[0].parts[0].metadata[PRESERVE_KEY] = { threadId: 42, chain: "not-an-array" };
    payload.messages[0].parts.push({
      type: "text",
      text: "still readable",
      metadata: { [PRESERVE_KEY]: "«truncated json" },
      id: "prt_garbage_1",
      sessionID: payload.info.id,
      messageID: payload.messages[0].info.id,
    });
    const nativeId = materializeExport(db, payload);

    const back = await new OpencodeAdapter(db).read({ harness: "opencode", nativeId });
    expect(provenanceOf(back)).toBeUndefined();
    expect(back.preserve?.[PRESERVE_KEY]).toBeUndefined();
    // the transcript itself is untouched
    expect(allText(back)).toContain("list the files");
    expect(allText(back)).toContain("still readable");
  });

  test("carry recovery falls back to the stored transcript when the payload is unusable", async () => {
    const db = freshDb();
    const { payload } = await prepareOpencodeExport(sourceSession(), {}, "/tmp/proj");
    payload.messages[0].parts[0].metadata[PRESERVE_KEY].carry = "not-base64-gzip!!";
    const nativeId = materializeExport(db, payload);

    const adapter = new OpencodeAdapter(db);
    const back = await adapter.readWithCarry({ harness: "opencode", nativeId });
    expect(provenanceOf(back)).toBeDefined();
    expect(allText(back)).toContain("historical tool call");
    expect(back.preserve?.sinterCarry).toBeUndefined();
  });
});

describe("carry-forward: a thread does not degrade per hop", () => {
  test("read() shows the flattened store; readWithCarry() restores the original entries", async () => {
    const db = freshDb();
    const source = sourceSession();
    const { nativeId } = await port(source, db);
    const adapter = new OpencodeAdapter(db);

    const native = await adapter.read({ harness: "opencode", nativeId });
    expect(native.entries.some((e) => e.kind === "toolResult")).toBe(false);
    expect(allText(native)).toContain("[historical tool call: bash");

    const carried = await adapter.readWithCarry({ harness: "opencode", nativeId });
    expect(carried.entries).toEqual(source.entries);
    expect(carried.origin.nativeId).toBe(nativeId); // native identity is kept
    expect((carried.preserve!.sinterCarry as any).recoveredFrom).toEqual(source.origin);
    expect(allText(carried)).not.toContain("historical tool call");
  });

  test("two hops through carry keep the ORIGINAL entries byte-for-byte; the flattened path loses them", async () => {
    const db = freshDb();
    const adapter = new OpencodeAdapter(db);
    const source = sourceSession();

    const hop1 = await port(source, db);
    const carriedA = await adapter.readWithCarry({ harness: "opencode", nativeId: hop1.nativeId });
    const nativeA = await adapter.read({ harness: "opencode", nativeId: hop1.nativeId });

    // hop 2, two ways: from the carried view, and from the flattened view.
    const goodHop2 = await port(carriedA, db);
    const lossyHop2 = await port(nativeA, db);

    const goodBack = await adapter.readWithCarry({ harness: "opencode", nativeId: goodHop2.nativeId });
    const lossyBack = await adapter.readWithCarry({ harness: "opencode", nativeId: lossyHop2.nativeId });

    // The carried path still holds the real tool call and its result, two hops on.
    expect(goodBack.entries).toEqual(source.entries);
    const goodCall = goodBack.entries.find(
      (e) => e.kind === "assistant" && e.content.some((p) => p.type === "toolCall"),
    );
    expect(goodCall).toBeDefined();
    expect(goodBack.entries.filter((e) => e.kind === "toolResult").length).toBe(1);

    // The flattened path cannot: the tool call is text forever, even with
    // carry recovery, because all hop 2 had left to carry was the flat copy.
    expect(lossyBack.entries.some((e) => e.kind === "toolResult")).toBe(false);
    expect(allText(lossyBack)).toContain("historical tool call");

    // And the flat path accretes an import marker per hop, while the carried
    // path re-flattens the original each time and stays at one.
    const goodStored = await adapter.read({ harness: "opencode", nativeId: goodHop2.nativeId });
    const lossyStored = await adapter.read({ harness: "opencode", nativeId: lossyHop2.nativeId });
    expect(countOf(allText(lossyStored), "imported via sinter")).toBe(2);
    expect(countOf(allText(goodStored), "imported via sinter")).toBe(1);
    expect(countOf(allText(goodBack), "imported via sinter")).toBe(0);
  });

  test("the tool call is flattened exactly once per hop — markers never nest", async () => {
    const db = freshDb();
    const adapter = new OpencodeAdapter(db);

    const hop1 = await port(sourceSession(), db);
    const flatA = allText(await adapter.read({ harness: "opencode", nativeId: hop1.nativeId }));

    const carriedA = await adapter.readWithCarry({ harness: "opencode", nativeId: hop1.nativeId });
    const hop2 = await port(carriedA, db);
    const flatB = allText(await adapter.read({ harness: "opencode", nativeId: hop2.nativeId }));

    const markerA = flatA.match(/\[historical tool call:[^\]]*\]/g)!;
    const markerB = flatB.match(/\[historical tool call:[^\]]*\]/g)!;
    expect(markerA.length).toBe(1);
    expect(markerB.length).toBe(1);
    // hop 2's flattening is identical to hop 1's — no nesting, no re-truncation
    expect(markerB[0]).toBe(markerA[0]);
    expect(markerB[0]).toContain("bash");
    expect(markerB[0]).toContain("file1");
    expect(countOf(flatB, "historical tool call")).toBe(1);
  });

  test("carry payloads do not nest: hop 2's record is not hop 1's record plus a copy", async () => {
    const db = freshDb();
    const adapter = new OpencodeAdapter(db);
    const hop1 = await port(sourceSession(), db);
    const carriedA = await adapter.readWithCarry({ harness: "opencode", nativeId: hop1.nativeId });
    const hop2 = await port(carriedA, db);

    const a = hop1.provenance.carry!.length;
    const b = hop2.provenance.carry!.length;
    expect(b).toBeLessThan(a * 2);
  });
});

describe("carry payload storage and dryRun", () => {
  const bigSession = (): SifSession => {
    // High-entropy text so the carry payload cannot compress under the inline
    // limit — a real write of this session must reach for a sidecar file.
    const noise = Buffer.from(crypto.getRandomValues(new Uint8Array(600_000))).toString("hex");
    return {
      sif: SIF_VERSION,
      id: mintSifId(),
      origin: { harness: "codex", nativeId: "cx-big" },
      cwd: "/tmp/proj",
      entries: [
        { kind: "user", id: "u1", parentId: null, ts: "2026-01-01T00:00:00.000Z", content: [{ type: "text", text: noise }] },
      ],
    };
  };

  test("a dry run writes no files at all — no sidecar, no rows", async () => {
    const home = join(root, "dry-home");
    const saved = process.env.SINTER_HOME;
    process.env.SINTER_HOME = home;
    try {
      const db = freshDb();
      const ref = await new OpencodeAdapter(db).write(bigSession(), { dryRun: true, cwd: "/tmp/proj" });
      expect(ref.created).toEqual([]);
      expect(existsSync(home)).toBe(false);
      expect(existsSync(db)).toBe(false);
      // The record is computed either way, so a dry run still reports it —
      // just without a carry payload, since that would mean a sidecar file.
      expect(ref.provenance!.chain).toEqual([
        { harness: "codex", nativeId: "cx-big" },
        { harness: "opencode", nativeId: ref.nativeId },
      ]);
      expect(ref.provenance!.carryRef).toBeUndefined();
      expect(ref.provenance!.carry).toBeUndefined();
    } finally {
      process.env.SINTER_HOME = saved;
    }
  });

  test("a sidecar-backed carry is still recovered on read", async () => {
    const home = join(root, "sidecar-home");
    const saved = process.env.SINTER_HOME;
    process.env.SINTER_HOME = home;
    try {
      const db = freshDb();
      const source = bigSession();
      const { payload, nativeId, provenance } = await prepareOpencodeExport(source, {}, "/tmp/proj");
      expect(provenance.carryRef).toBeTruthy();
      materializeExport(db, payload);

      const back = await new OpencodeAdapter(db).readWithCarry({ harness: "opencode", nativeId });
      expect(back.entries).toEqual(source.entries);
      expect((back.preserve!.sinterCarry as any).via).toBe("sidecar");
    } finally {
      process.env.SINTER_HOME = saved;
    }
  });

  test("control: the same session written for real DOES spill a carry sidecar", async () => {
    const home = join(root, "wet-home");
    const saved = process.env.SINTER_HOME;
    process.env.SINTER_HOME = home;
    try {
      const { provenance } = await prepareOpencodeExport(bigSession(), {}, "/tmp/proj");
      expect(provenance.carry).toBeUndefined();
      expect(provenance.carryRef).toContain(join(home, "carry", "opencode"));
      expect(existsSync(provenance.carryRef!)).toBe(true);
      expect(readdirSync(join(home, "carry", "opencode")).length).toBe(1);
    } finally {
      process.env.SINTER_HOME = saved;
    }
  });
});
