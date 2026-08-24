import { describe, expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";
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

  test("persists corrected subagent classification without a timestamp change", async () => {
    const l = ledger();
    const a = new MockAdapter({ id: "claude", summaries: [summary({ nativeId: "worker", isSubagent: false })] });
    await l.scan([a]);
    a.summaries = [summary({ nativeId: "worker", isSubagent: true, parentNativeId: "parent" })];
    const result = await l.scan([a]);
    expect(result.harnesses.claude!.updated).toBe(1);
    expect(l.get("claude", "worker")).toMatchObject({ isSubagent: true, parentNativeId: "parent" });
    l.close();
  });

  test("persists every corrected summary field without a timestamp or message-count change", async () => {
    const l = ledger();
    const a = new MockAdapter({
      id: "claude",
      summaries: [summary({
        nativeId: "corrected",
        nativePath: "/old/session.jsonl",
        cwd: "/old/project",
        createdAt: "2026-07-01T00:00:00.000Z",
        model: "old-model",
        gitBranch: "old-branch",
        usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, costUsd: 0.01 },
      })],
    });
    await l.scan([a]);
    a.summaries = [summary({
      nativeId: "corrected",
      nativePath: "/new/session.jsonl",
      cwd: "/new/project",
      createdAt: "2026-07-02T00:00:00.000Z",
      model: "new-model",
      gitBranch: "new-branch",
      usage: { input: 10, output: 20, reasoning: 30, cacheRead: 40, cacheWrite: 50, costUsd: 0.5 },
    })];
    const result = await l.scan([a]);
    expect(result.harnesses.claude!.updated).toBe(1);
    expect(l.get("claude", "corrected")).toMatchObject({
      nativePath: "/new/session.jsonl",
      cwd: "/new/project",
      createdAt: "2026-07-02T00:00:00.000Z",
      model: "new-model",
      gitBranch: "new-branch",
      tokensInput: 10,
      tokensOutput: 20,
      tokensReasoning: 30,
      tokensCacheRead: 40,
      tokensCacheWrite: 50,
      cost: 0.5,
    });
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
    // A failed adapter leaves no partial snapshot behind.
    expect(l.get("zcode", "z1")).toBeUndefined();
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

  test("a mid-stream failure rolls back updates as well as inserts", async () => {
    const l = ledger();
    const a = new MockAdapter({ id: "omp", summaries: [summary({ nativeId: "keep", harness: "omp", title: "before" })] });
    await l.scan([a]);
    a.summaries = [
      summary({ nativeId: "keep", harness: "omp", title: "partial update" }),
      summary({ nativeId: "boom", harness: "omp" }),
    ];
    a.throwOnList = "boom";
    const result = await l.scan([a]);
    expect(result.harnesses.omp).toMatchObject({ inserted: 0, updated: 0, unchanged: 0, ghosts: 0 });
    expect(l.get("omp", "keep")!.title).toBe("before");
    l.close();
  });

  test("malformed, duplicate, and cross-harness summaries cannot poison a snapshot", async () => {
    const l = ledger();
    const malformed = new MockAdapter({ id: "claude", summaries: [summary({ nativeId: "" })] });
    const duplicate = new MockAdapter({
      id: "codex",
      summaries: [
        summary({ nativeId: "same", harness: "codex" }),
        summary({ nativeId: "same", harness: "codex", title: "conflict" }),
      ],
    });
    const crossed = new MockAdapter({
      id: "omp",
      summaries: [summary({ nativeId: "wrong", harness: "claude" })],
    });

    const result = await l.scan([malformed, duplicate, crossed]);
    expect(result.errors.map((error) => error.harness)).toEqual(["claude", "codex", "omp"]);
    expect(l.list()).toHaveLength(0);
    l.close();
  });
});

describe("session aliases", () => {
  test("sets, changes, and clears an alias without changing the source row", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "alias-1", title: "source-owned title" }));

    expect(l.get("claude", "alias-1")!.alias).toBeUndefined();
    l.setAlias("claude", "alias-1", "ledger nickname");
    expect(l.get("claude", "alias-1")).toMatchObject({
      alias: "ledger nickname",
      title: "source-owned title",
    });
    expect(l.list().find((row) => row.nativeId === "alias-1")!.alias).toBe("ledger nickname");
    expect(l.resolve("alias-1").row!.alias).toBe("ledger nickname");
    expect(l.search("nickname")[0]).toMatchObject({ nativeId: "alias-1", alias: "ledger nickname" });

    l.setAlias("claude", "alias-1", "changed moniker");
    expect(l.get("claude", "alias-1")!.alias).toBe("changed moniker");
    expect(l.search("nickname")).toHaveLength(0);
    expect(l.search("moniker")[0]).toMatchObject({ nativeId: "alias-1", alias: "changed moniker" });

    l.setAlias("claude", "alias-1");
    expect(l.get("claude", "alias-1")!.alias).toBeUndefined();
    expect(l.search("moniker")).toHaveLength(0);
    expect(l.get("claude", "alias-1")!.title).toBe("source-owned title");
    l.close();
  });

  test("aliases are keyed by harness and native id", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "same" }));
    l.upsert(summary({ nativeId: "same", harness: "codex" }));
    l.setAlias("claude", "same", "claude name");
    l.setAlias("codex", "same", "codex name");

    expect(l.get("claude", "same")!.alias).toBe("claude name");
    expect(l.get("codex", "same")!.alias).toBe("codex name");
    expect(l.list({ harness: "codex" })[0]!.alias).toBe("codex name");
    l.close();
  });

  test("survives changed and unchanged adapter rescans and remains searchable", async () => {
    const l = ledger();
    const a = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "scan-alias", title: "before rescan" })],
    });
    await l.scan([a]);
    l.setAlias("claude", "scan-alias", "durable local name");

    a.summaries = [
      summary({
        nativeId: "scan-alias",
        title: "after rescan",
        updatedAt: "2026-09-01T00:00:00.000Z",
        messageCount: 8,
      }),
    ];
    expect((await l.scan([a])).harnesses.claude!.updated).toBe(1);
    expect((await l.scan([a])).harnesses.claude!.unchanged).toBe(1);
    expect(l.get("claude", "scan-alias")).toMatchObject({
      alias: "durable local name",
      title: "after rescan",
      messageCount: 8,
    });
    expect(l.search("durable")[0]).toMatchObject({ nativeId: "scan-alias", alias: "durable local name" });
    l.close();
  });

  test("can be created before an adapter discovers the source session", async () => {
    const l = ledger();
    l.setAlias("claude", "future", "preassigned name");
    const a = new MockAdapter({ id: "claude", summaries: [summary({ nativeId: "future" })] });
    await l.scan([a]);

    expect(l.get("claude", "future")!.alias).toBe("preassigned name");
    expect(l.search("preassigned").map((row) => row.nativeId)).toEqual(["future"]);
    l.close();
  });
});

describe("session pins", () => {
  test("sets, filters, and clears local bookmarks without changing session rows", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "pin-1", title: "source title" }));
    l.upsert(summary({ nativeId: "plain" }));

    l.setPinned("claude", "pin-1", true, "2026-08-24T01:00:00.000Z");
    expect(l.get("claude", "pin-1")).toMatchObject({
      title: "source title",
      pinnedAt: "2026-08-24T01:00:00.000Z",
    });
    expect(l.list({ pinnedOnly: true }).map((row) => row.nativeId)).toEqual(["pin-1"]);

    l.setPinned("claude", "pin-1", false);
    expect(l.get("claude", "pin-1")!.pinnedAt).toBeUndefined();
    expect(l.list({ pinnedOnly: true })).toEqual([]);
    l.close();
  });

  test("pins are harness-scoped and survive rescans that ghost a session", async () => {
    const l = ledger();
    const adapter = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "same" })],
    });
    await l.scan([adapter]);
    l.upsert(summary({ nativeId: "same", harness: "codex" }));
    l.setPinned("claude", "same", true);
    expect(l.get("codex", "same")!.pinnedAt).toBeUndefined();

    adapter.summaries = [];
    await l.scan([adapter]);
    expect(l.get("claude", "same")).toMatchObject({ ghost: true });
    expect(l.get("claude", "same")!.pinnedAt).toBeTruthy();
    expect(l.list({ pinnedOnly: true })[0]).toMatchObject({ harness: "claude", nativeId: "same" });
    l.close();
  });
});

describe("ghost housekeeping", () => {
  test("prunes only old disposable rows and preserves aliases, pins, and lineage", async () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "plain", ghost: true, title: "plain ghost" }));
    l.upsert(summary({ nativeId: "named", ghost: true, title: "named ghost" }));
    l.upsert(summary({ nativeId: "pinned", ghost: true, title: "pinned ghost" }));
    l.upsert(summary({ nativeId: "noted", ghost: true, title: "noted ghost" }));
    l.upsert(summary({ nativeId: "tagged", ghost: true, title: "tagged ghost" }));
    l.upsert(summary({ nativeId: "fresh", ghost: true, title: "fresh ghost" }));
    l.upsert(summary({ nativeId: "live", title: "live session" }));
    l.setAlias("claude", "named", "keep my name");
    l.setPinned("claude", "pinned", true, "2026-08-01T00:00:00.000Z");
    l.setNote("claude", "noted", "keep this note");
    l.addTags("claude", "tagged", ["keep-tag"]);
    l.recordLineage({ harness: "claude", nativeId: "plain", threadId: "thread-1", hop: 0 });
    l.db.run("UPDATE sessions SET scanned_at = '2026-07-01T00:00:00.000Z' WHERE native_id != 'fresh'");
    l.db.run("UPDATE sessions SET scanned_at = '2026-08-23T00:00:00.000Z' WHERE native_id = 'fresh'");

    const opts = { before: "2026-08-01T00:00:00.000Z" };
    expect(l.ghosts(opts).map((row) => row.nativeId)).toEqual(["named", "noted", "pinned", "plain", "tagged"]);
    expect(l.pruneGhosts(opts).map((row) => row.nativeId)).toEqual(["plain"]);
    expect(l.get("claude", "plain")).toBeUndefined();
    expect(l.search("plain")).toEqual([]);
    expect(l.get("claude", "named")?.alias).toBe("keep my name");
    expect(l.get("claude", "pinned")?.pinnedAt).toBeTruthy();
    expect(l.get("claude", "noted")?.note).toBe("keep this note");
    expect(l.get("claude", "tagged")?.tags).toEqual(["keep-tag"]);
    expect(l.get("claude", "fresh")).toBeDefined();
    expect(l.get("claude", "live")).toBeDefined();
    expect(l.lineageFor("thread-1")).toHaveLength(1);

    const adapter = new MockAdapter({ id: "claude", summaries: [summary({ nativeId: "plain" })] });
    await l.scan([adapter]);
    expect(l.get("claude", "plain")).toMatchObject({ ghost: false });
    expect(l.lineageFor("thread-1")).toHaveLength(1);
    l.close();
  });

  test("filters ghosts by harness and makes repeated pruning idempotent", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "c", ghost: true }));
    l.upsert(summary({ nativeId: "p", harness: "pi", ghost: true }));
    l.db.run("UPDATE sessions SET scanned_at = '2026-07-01T00:00:00.000Z'");
    const opts = { harness: "pi" as const, before: "2026-08-01T00:00:00.000Z" };
    expect(l.pruneGhosts(opts).map((row) => row.nativeId)).toEqual(["p"]);
    expect(l.pruneGhosts(opts)).toEqual([]);
    expect(l.get("claude", "c")).toBeDefined();
    l.close();
  });
});

describe("session tags and notes", () => {
  test("stores searchable metadata without changing native fields", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "meta", title: "native title", firstPrompt: "native prompt" }));
    l.setNote("claude", "meta", "follow up after launch", "2026-08-24T01:00:00.000Z");
    l.addTags("claude", "meta", ["release", "urgent", "release"]);
    expect(l.get("claude", "meta")).toMatchObject({
      title: "native title",
      firstPrompt: "native prompt",
      note: "follow up after launch",
      tags: ["release", "urgent"],
    });
    expect(l.search("launch").map((row) => row.nativeId)).toEqual(["meta"]);
    expect(l.search("urgent").map((row) => row.nativeId)).toEqual(["meta"]);
    expect(l.tagCounts()).toEqual([{ tag: "release", sessions: 1 }, { tag: "urgent", sessions: 1 }]);

    l.removeTags("claude", "meta", ["urgent"]);
    expect(l.get("claude", "meta")?.tags).toEqual(["release"]);
    expect(l.search("urgent")).toEqual([]);
    l.setNote("claude", "meta");
    expect(l.get("claude", "meta")?.note).toBeUndefined();
    expect(l.search("launch")).toEqual([]);
    l.removeTags("claude", "meta");
    expect(l.get("claude", "meta")?.tags).toBeUndefined();
    l.close();
  });

  test("metadata can precede discovery and survives rescans", async () => {
    const l = ledger();
    l.setNote("claude", "future-meta", "discover me later");
    l.addTags("claude", "future-meta", ["backlog"]);
    const adapter = new MockAdapter({ id: "claude", summaries: [summary({ nativeId: "future-meta" })] });
    await l.scan([adapter]);
    expect(l.get("claude", "future-meta")).toMatchObject({ note: "discover me later", tags: ["backlog"] });
    expect(l.search("backlog").map((row) => row.nativeId)).toEqual(["future-meta"]);
    expect((await l.scan([adapter])).harnesses.claude!.unchanged).toBe(1);
    expect(l.get("claude", "future-meta")?.note).toBe("discover me later");
    l.close();
  });
});

describe("saved views", () => {
  test("saves, replaces, lists, and deletes local filter definitions", () => {
    const l = ledger();
    expect(l.listViews()).toEqual([]);
    expect(l.saveView({
      name: "today",
      harnesses: ["claude", "codex"],
      cwd: "/Users/test/proj",
      since: "1d",
      limit: 12,
      includeGhost: false,
      includeSubagents: true,
    }, "2026-08-24T01:00:00.000Z")).toEqual({
      name: "today",
      harnesses: ["claude", "codex"],
      cwd: "/Users/test/proj",
      since: "1d",
      limit: 12,
      includeGhost: false,
      includeSubagents: true,
      updatedAt: "2026-08-24T01:00:00.000Z",
    });
    l.saveView({
      name: "TODAY",
      harnesses: ["pi"],
      includeGhost: true,
      includeSubagents: false,
    }, "2026-08-24T02:00:00.000Z");
    expect(l.listViews()).toHaveLength(1);
    expect(l.getView("today")).toMatchObject({
      name: "today",
      harnesses: ["pi"],
      includeGhost: true,
      updatedAt: "2026-08-24T02:00:00.000Z",
    });
    expect(l.deleteView("Today")).toBe(true);
    expect(l.deleteView("Today")).toBe(false);
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

describe("same-harness instances", () => {
  test("same native id remains independent across stores and metadata", () => {
    const l = ledger();
    l.upsert(summary({ nativeId: "same", instanceId: "personal", title: "personal session" }));
    l.upsert(summary({ nativeId: "same", instanceId: "addvita", title: "work session" }));
    l.setAlias("claude", "same", "private", "personal");
    l.setAlias("claude", "same", "client", "addvita");
    l.setNote("claude", "same", "personal note", undefined, "personal");
    l.setNote("claude", "same", "work note", undefined, "addvita");

    expect(l.get("claude", "same", "personal")).toMatchObject({ title: "personal session", alias: "private" });
    expect(l.get("claude", "same", "addvita")).toMatchObject({ title: "work session", alias: "client" });
    expect(l.resolve("claude@personal:same").row?.instanceId).toBe("personal");
    expect(l.resolve("claude:same").row).toBeUndefined();
    expect(l.search("work note", { instanceId: "addvita" })).toHaveLength(1);
    expect(l.search("work note", { instanceId: "personal" })).toHaveLength(0);
    l.close();
  });

  test("scans and ghosts only the adapter instance snapshot", async () => {
    const l = ledger();
    const personal = new MockAdapter({ instanceId: "personal", summaries: [summary({ nativeId: "p" })] });
    const addvita = new MockAdapter({ instanceId: "addvita", summaries: [summary({ nativeId: "w" })] });
    const first = await l.scan([personal, addvita]);
    expect(first.harnesses["claude@personal"]?.inserted).toBe(1);
    expect(first.harnesses["claude@addvita"]?.inserted).toBe(1);
    personal.summaries = [];
    await l.scan([personal]);
    expect(l.get("claude", "p", "personal")?.ghost).toBe(true);
    expect(l.get("claude", "w", "addvita")?.ghost).toBe(false);
    l.close();
  });

  test("lineage distinguishes matching native ids in matching harnesses", () => {
    const l = ledger();
    l.recordLineage({ harness: "claude", instanceId: "personal", nativeId: "same", threadId: "p", hop: 0 });
    l.recordLineage({ harness: "claude", instanceId: "addvita", nativeId: "same", threadId: "w", hop: 0 });
    expect(l.threadIdOf("claude", "same", "personal")).toBe("p");
    expect(l.threadIdOf("claude", "same", "addvita")).toBe("w");
    expect(l.lineageCount()).toBe(2);
    l.close();
  });
});

describe("persistence", () => {
  test("hardens an existing ledger and its SQLite sidecars to owner-only", async () => {
    const dir = `/tmp/sinter-ledger-permissions-${Bun.randomUUIDv7()}`;
    const path = `${dir}/ledger.db`;
    const initial = new Ledger(path);
    initial.close();
    chmodSync(path, 0o644);

    const reopened = new Ledger(path);
    reopened.upsert(summary({ nativeId: "private-session", firstPrompt: "private prompt" }));
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      expect(statSync(candidate).mode & 0o777).toBe(0o600);
    }
    reopened.close();
    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("survives reopen of an on-disk ledger", async () => {
    const dir = `/tmp/sinter-ledger-test-${Bun.randomUUIDv7()}`;
    const path = `${dir}/ledger.db`;
    const l1 = new Ledger(path);
    l1.upsert(summary({ nativeId: "persist-me", title: "persisted title" }));
    l1.setAlias("claude", "persist-me", "persistent alias");
    l1.close();

    const l2 = new Ledger(path);
    expect(l2.get("claude", "persist-me")).toMatchObject({
      title: "persisted title",
      alias: "persistent alias",
    });
    expect(l2.search("persisted")).toHaveLength(1);
    expect(l2.search("persistent")[0]!.alias).toBe("persistent alias");
    l2.close();
    await Bun.$`rm -rf ${dir}`.quiet();
  });
});
