import { describe, expect, test } from "bun:test";
import { Ledger } from "../src/index";
import { MockAdapter, summary } from "./mock-adapter";

function ledger(): Ledger {
  return new Ledger(":memory:");
}

describe("upsert", () => {
  test("inserts, then reports unchanged, then updated", () => {
    const l = ledger();
    const s = summary({ nativeId: "aaa111" });
    expect(l.upsert(s)).toBe("inserted");
    expect(l.upsert(s)).toBe("unchanged");
    expect(l.upsert({ ...s, updatedAt: "2026-08-02T00:00:00.000Z", messageCount: 9 })).toBe("updated");

    const row = l.get("claude", "aaa111")!;
    expect(row.messageCount).toBe(9);
    expect(row.cwd).toBe("/Users/test/proj");
    expect(row.ghost).toBe(false);
    expect(row.host).toBeTruthy();
    expect(row.scannedAt).toBeTruthy();
    l.close();
  });

  test("stores usage columns and omits what the source lacks", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "u1", usage: { input: 100, output: 20, costUsd: 0.5 } }));
    const row = l.get("claude", "u1")!;
    expect(row.tokensInput).toBe(100);
    expect(row.tokensOutput).toBe(20);
    expect(row.cost).toBeCloseTo(0.5);
    expect(row.tokensReasoning).toBeUndefined();
    l.close();
  });

  test("same native id in two harnesses are distinct rows", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "dup" }));
    l.upsert(summary({ nativeId: "dup", harness: "codex" }));
    expect(l.list()).toHaveLength(2);
    expect(l.get("codex", "dup")!.harness).toBe("codex");
    l.close();
  });
});

describe("scan", () => {
  test("incrementally upserts from adapters and counts per harness", async () => {
    const l = ledger();
    const claude = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "c1" }), summary({ nativeId: "c2" })],
    });
    const codex = new MockAdapter({
      id: "codex",
      summaries: [summary({ nativeId: "x1", harness: "codex" })],
    });

    const r1 = await l.scan([claude, codex]);
    expect(r1.harnesses.claude!.inserted).toBe(2);
    expect(r1.harnesses.codex!.inserted).toBe(1);
    expect(r1.errors).toHaveLength(0);

    const r2 = await l.scan([claude, codex]);
    expect(r2.harnesses.claude!.unchanged).toBe(2);
    expect(r2.harnesses.claude!.inserted).toBe(0);
    l.close();
  });

  test("marks rows as ghost once the harness stops listing them", async () => {
    const l = ledger();
    const a = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "g1" }), summary({ nativeId: "g2" })],
    });
    await l.scan([a]);
    a.summaries = [summary({ nativeId: "g1" })];
    const r = await l.scan([a]);
    expect(r.harnesses.claude!.ghosts).toBe(1);
    expect(l.get("claude", "g2")!.ghost).toBe(true);
    expect(l.get("claude", "g1")!.ghost).toBe(false);
    // ledger history survives harness GC
    expect(l.list()).toHaveLength(2);
    expect(l.list({ includeGhost: false })).toHaveLength(1);
    l.close();
  });

  test("adapter-reported ghosts are honoured", async () => {
    const l = ledger();
    const a = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "gh", ghost: true })],
    });
    const r = await l.scan([a]);
    expect(r.harnesses.claude!.ghosts).toBe(1);
    expect(l.get("claude", "gh")!.ghost).toBe(true);
    l.close();
  });

  test("a throwing adapter is recorded and the others still scan", async () => {
    const l = ledger();
    const bad = new MockAdapter({
      id: "zcode",
      summaries: [summary({ nativeId: "z1", harness: "zcode" }), summary({ nativeId: "boom", harness: "zcode" })],
      throwOnList: "boom",
    });
    const good = new MockAdapter({ id: "omp", summaries: [summary({ nativeId: "o1", harness: "omp" })] });

    const r = await l.scan([bad, good]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.harness).toBe("zcode");
    expect(r.harnesses.omp!.inserted).toBe(1);
    // partial rows before the throw are kept
    expect(l.get("zcode", "z1")).toBeDefined();
    l.close();
  });

  test("a failing adapter never ghosts its existing rows", async () => {
    const l = ledger();
    const a = new MockAdapter({ id: "omp", summaries: [summary({ nativeId: "keep", harness: "omp" })] });
    await l.scan([a]);
    a.summaries = [];
    a.throwOnList = "*";
    await l.scan([a]);
    expect(l.get("omp", "keep")!.ghost).toBe(false);
    l.close();
  });
});

describe("list filters", () => {
  const seed = (l: Ledger) => {
    l.upsert(summary({ nativeId: "old", updatedAt: "2026-01-01T00:00:00.000Z" }));
    l.upsert(summary({ nativeId: "new", updatedAt: "2026-08-10T00:00:00.000Z" }));
    l.upsert(summary({ nativeId: "other", cwd: "/Users/test/elsewhere" }));
    l.upsert(summary({ nativeId: "cdx", harness: "codex" }));
    l.upsert(summary({ nativeId: "sub", isSubagent: true, parentNativeId: "new" }));
  };

  test("orders newest first and filters by harness/cwd/since/limit", () => {
    const l = ledger();
    seed(l);
    expect(l.list()[0]!.nativeId).toBe("new");
    expect(l.list({ harness: "codex" }).map((r) => r.nativeId)).toEqual(["cdx"]);
    expect(l.list({ cwd: "/Users/test/elsewhere" }).map((r) => r.nativeId)).toEqual(["other"]);
    expect(l.list({ since: "2026-06-01T00:00:00.000Z" }).map((r) => r.nativeId)).not.toContain("old");
    expect(l.list({ limit: 2 })).toHaveLength(2);
    expect(l.list({ includeSubagents: false }).map((r) => r.nativeId)).not.toContain("sub");
    l.close();
  });
});

describe("fts search", () => {
  test("matches title and first prompt, and reindexes on update", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "f1", title: "porting sessions across harnesses" }));
    l.upsert(summary({ nativeId: "f2", title: "unrelated", firstPrompt: "please fix the sqlite ledger" }));

    expect(l.search("porting").map((r) => r.nativeId)).toEqual(["f1"]);
    expect(l.search("sqlite").map((r) => r.nativeId)).toEqual(["f2"]);
    expect(l.search("harnesses OR sqlite")).toHaveLength(2);

    l.upsert(summary({ nativeId: "f1", title: "totally different topic", updatedAt: "2026-09-01T00:00:00.000Z" }));
    expect(l.search("porting")).toHaveLength(0);
    expect(l.search("different").map((r) => r.nativeId)).toEqual(["f1"]);
    l.close();
  });

  test("survives fts syntax garbage by falling back to a phrase", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "q1", title: "fix the thing" }));
    expect(() => l.search('fix "the')).not.toThrow();
    expect(l.search("fix the").map((r) => r.nativeId)).toEqual(["q1"]);
    l.close();
  });

  test("honours filters", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "s1", title: "shared word" }));
    l.upsert(summary({ nativeId: "s2", harness: "codex", title: "shared word" }));
    expect(l.search("shared", { harness: "codex" }).map((r) => r.nativeId)).toEqual(["s2"]);
    expect(l.search("shared", { limit: 1 })).toHaveLength(1);
    l.close();
  });
});

describe("prefix resolution", () => {
  const seed = (l: Ledger) => {
    l.upsert(summary({ nativeId: "abc123-def" }));
    l.upsert(summary({ nativeId: "abc999-xyz" }));
    l.upsert(summary({ nativeId: "zzz000", harness: "codex" }));
  };

  test("resolves an unambiguous prefix", () => {
    const l = ledger();
    seed(l);
    const r = l.resolve("abc123");
    expect(r.row?.nativeId).toBe("abc123-def");
    l.close();
  });

  test("ambiguity returns candidates and no row", () => {
    const l = ledger();
    seed(l);
    const r = l.resolve("abc");
    expect(r.row).toBeUndefined();
    expect(r.candidates.map((c) => c.nativeId).sort()).toEqual(["abc123-def", "abc999-xyz"]);
    l.close();
  });

  test("not found returns nothing", () => {
    const l = ledger();
    seed(l);
    expect(l.resolve("nope").candidates).toHaveLength(0);
    l.close();
  });

  test("harness scoping disambiguates", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "same-id" }));
    l.upsert(summary({ nativeId: "same-id", harness: "codex" }));
    expect(l.resolve("same-id").row).toBeUndefined();
    expect(l.resolve("codex:same-id").row?.harness).toBe("codex");
    expect(l.resolve("claude/same").row?.harness).toBe("claude");
    l.close();
  });

  test("an exact id beats longer ids that share the prefix", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "abc" }));
    l.upsert(summary({ nativeId: "abcdef" }));
    expect(l.resolve("abc").row?.nativeId).toBe("abc");
    l.close();
  });

  test("a parent plus only its own subagents resolves to the parent", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "0a45e9b9-fe0d" }));
    l.upsert(summary({ nativeId: "0a45e9b9-fe0d/agent-111", isSubagent: true, parentNativeId: "0a45e9b9-fe0d" }));
    l.upsert(summary({ nativeId: "0a45e9b9-fe0d/agent-222", isSubagent: true, parentNativeId: "0a45e9b9-fe0d" }));
    expect(l.resolve("0a45e9b9").row?.nativeId).toBe("0a45e9b9-fe0d");
    // subagents stay addressable
    expect(l.resolve("0a45e9b9-fe0d/agent-11").row?.nativeId).toBe("0a45e9b9-fe0d/agent-111");
    // an unrelated sibling id makes it ambiguous again
    l.upsert(summary({ nativeId: "0a45e9b9-ffff" }));
    expect(l.resolve("0a45e9b9").row).toBeUndefined();
    l.close();
  });

  test("is case-insensitive and safe against LIKE wildcards", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "ABCdef" }));
    l.upsert(summary({ nativeId: "x%y" }));
    expect(l.resolve("abcd").row?.nativeId).toBe("ABCdef");
    expect(l.resolve("%").candidates).toHaveLength(0);
    expect(l.resolve("x%").row?.nativeId).toBe("x%y");
    l.close();
  });
});

describe("counts", () => {
  test("per-harness totals and ghosts", async () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "a" }));
    l.upsert(summary({ nativeId: "b", ghost: true }));
    l.upsert(summary({ nativeId: "c", harness: "pi" }));
    const c = l.counts();
    expect(c.find((x) => x.harness === "claude")).toMatchObject({ total: 2, ghosts: 1 });
    expect(l.countFor("pi")).toBe(1);
    l.close();
  });
});

describe("persistence", () => {
  test("survives reopen of an on-disk ledger", async () => {
    const dir = `/tmp/sinter-ledger-test-${Bun.randomUUIDv7()}`;
    const path = `${dir}/ledger.db`;
    const l1 = new Ledger(path);
    l1.upsert(summary({ nativeId: "persist-me", title: "persisted title" }));
    l1.close();

    const l2 = new Ledger(path);
    expect(l2.get("claude", "persist-me")!.title).toBe("persisted title");
    expect(l2.search("persisted")).toHaveLength(1);
    l2.close();
    await Bun.$`rm -rf ${dir}`.quiet();
  });
});
