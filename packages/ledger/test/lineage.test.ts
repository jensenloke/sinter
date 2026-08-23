import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Ledger, SCHEMA_VERSION } from "../src/index";
import type { LineageRow } from "../src/index";
import type { Hop, SinterProvenance } from "@sinter/core";
import { LINEAGE_VERSION } from "@sinter/core";
import { summary } from "./mock-adapter";

function ledger(): Ledger {
  return new Ledger(":memory:");
}

function hop(harness: string, nativeId: string): Hop {
  return { harness: harness as Hop["harness"], nativeId };
}

function prov(over: Partial<SinterProvenance> & { chain: Hop[] }): SinterProvenance {
  const chain = over.chain;
  const at = over.hop ?? chain.length - 1;
  return {
    v: LINEAGE_VERSION,
    sinter: "0.1.0",
    threadId: "thr-1",
    hop: at,
    from: chain[at - 1],
    portedAt: "2026-08-15T00:00:00.000Z",
    ...over,
  };
}

/** Compact (harness:id@hop<-parent) view, so assertions stay readable. */
function shape(rows: LineageRow[]): string[] {
  return rows.map(
    (r) =>
      `${r.harness}:${r.nativeId}@${r.hop}` +
      (r.parentHarness ? `<-${r.parentHarness}:${r.parentNativeId}` : ""),
  );
}

describe("recordLineage", () => {
  test("inserts a link and reads it back", () => {
    const l = ledger();
    l.recordLineage({
      harness: "omp",
      nativeId: "B",
      threadId: "t",
      hop: 1,
      parentHarness: "codex",
      parentNativeId: "A",
      portedAt: "2026-08-15T00:00:00.000Z",
      mode: "slim",
    });
    expect(l.lineageCount()).toBe(1);
    expect(l.lineageFor("t")[0]).toEqual({
      harness: "omp",
      nativeId: "B",
      threadId: "t",
      hop: 1,
      parentHarness: "codex",
      parentNativeId: "A",
      portedAt: "2026-08-15T00:00:00.000Z",
      mode: "slim",
    });
    l.close();
  });

  test("is idempotent on (harness, native_id)", () => {
    const l = ledger();
    const row: LineageRow = { harness: "pi", nativeId: "p1", threadId: "t", hop: 0 };
    l.recordLineage(row);
    l.recordLineage(row);
    l.recordLineage({ ...row, hop: 3 });
    expect(l.lineageCount()).toBe(1);
    expect(l.lineageFor("t")[0]!.hop).toBe(3);
    l.close();
  });

  test("omits absent optional columns rather than returning null", () => {
    const l = ledger();
    l.recordLineage({ harness: "claude", nativeId: "c1", threadId: "t", hop: 0 });
    const r = l.lineageFor("t")[0]!;
    expect(r.parentHarness).toBeUndefined();
    expect(r.parentNativeId).toBeUndefined();
    expect(r.portedAt).toBeUndefined();
    expect(r.mode).toBeUndefined();
    l.close();
  });
});

describe("recordProvenance", () => {
  test("writes one row per hop, each pointing at its predecessor", () => {
    const l = ledger();
    l.recordProvenance(
      prov({ threadId: "t1", chain: [hop("codex", "A"), hop("omp", "B")], mode: "full" }),
    );

    expect(shape(l.lineageFor("t1"))).toEqual(["codex:A@0", "omp:B@1<-codex:A"]);
    expect(l.lineageCount()).toBe(2);
    expect(l.threadIdOf("codex", "A")).toBe("t1");
    expect(l.threadIdOf("omp", "B")).toBe("t1");
    l.close();
  });

  test("called twice with the same record does not duplicate rows", () => {
    const l = ledger();
    const p = prov({ threadId: "t1", chain: [hop("codex", "A"), hop("omp", "B")] });
    l.recordProvenance(p);
    l.recordProvenance(p);
    l.recordProvenance(p);
    expect(l.lineageCount()).toBe(2);
    expect(shape(l.lineageFor("t1"))).toEqual(["codex:A@0", "omp:B@1<-codex:A"]);
    l.close();
  });

  test("a chain of one records a single root row with no parent", () => {
    const l = ledger();
    l.recordProvenance(prov({ threadId: "solo", chain: [hop("claude", "never-ported")] }));
    const rows = l.lineageFor("solo");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hop: 0, harness: "claude", nativeId: "never-ported" });
    expect(rows[0]!.parentHarness).toBeUndefined();
    expect(rows[0]!.parentNativeId).toBeUndefined();
    l.close();
  });

  test("porting back into a harness already in the chain is a new hop, not a cycle", () => {
    const l = ledger();
    l.recordProvenance(
      prov({ threadId: "t2", chain: [hop("codex", "A"), hop("omp", "B"), hop("codex", "C")] }),
    );
    expect(shape(l.lineageFor("t2"))).toEqual([
      "codex:A@0",
      "omp:B@1<-codex:A",
      "codex:C@2<-omp:B",
    ]);
    expect(l.lineageCount()).toBe(3);
    // Same harness, two distinct native ids, one thread.
    expect(l.threadIdOf("codex", "A")).toBe("t2");
    expect(l.threadIdOf("codex", "C")).toBe("t2");
    l.close();
  });

  test("a growing chain extends the thread in place", () => {
    const l = ledger();
    l.recordProvenance(prov({ threadId: "t3", chain: [hop("claude", "A"), hop("zcode", "B")] }));
    l.recordProvenance(
      prov({ threadId: "t3", chain: [hop("claude", "A"), hop("zcode", "B"), hop("pi", "C")] }),
    );
    expect(l.lineageCount()).toBe(3);
    expect(shape(l.lineageFor("t3"))).toEqual(["claude:A@0", "zcode:B@1<-claude:A", "pi:C@2<-zcode:B"]);
    l.close();
  });

  test("portedAt/mode land on the ported session, and ancestors keep their own", () => {
    const l = ledger();
    l.recordProvenance(
      prov({
        threadId: "t4",
        chain: [hop("codex", "A"), hop("omp", "B")],
        portedAt: "2026-01-01T00:00:00.000Z",
        mode: "slim",
      }),
    );
    // A second port off B: the record knows only about THIS hop's mode/time.
    l.recordProvenance(
      prov({
        threadId: "t4",
        chain: [hop("codex", "A"), hop("omp", "B"), hop("pi", "C")],
        portedAt: "2026-02-02T00:00:00.000Z",
        mode: "digest",
      }),
    );

    const [a, b, c] = l.lineageFor("t4");
    expect(a!.portedAt).toBeUndefined(); // root was never ported INTO
    expect(b).toMatchObject({ portedAt: "2026-01-01T00:00:00.000Z", mode: "slim" });
    expect(c).toMatchObject({ portedAt: "2026-02-02T00:00:00.000Z", mode: "digest" });
    l.close();
  });

  test("ignores a malformed or empty record", () => {
    const l = ledger();
    l.recordProvenance(prov({ threadId: "t", chain: [] }));
    l.recordProvenance({ ...prov({ chain: [hop("pi", "x")] }), threadId: "" });
    expect(l.lineage()).toEqual([]);
    l.close();
  });

  test("last write wins when two records claim the same session for different threads", () => {
    const l = ledger();
    l.recordProvenance(prov({ threadId: "old", chain: [hop("codex", "A"), hop("omp", "B")] }));
    l.recordProvenance(prov({ threadId: "new", chain: [hop("codex", "A"), hop("omp", "B")] }));
    expect(l.threadIdOf("omp", "B")).toBe("new");
    expect(l.lineageFor("old")).toEqual([]);
    expect(l.lineageFor("new")).toHaveLength(2);
    expect(l.lineageCount()).toBe(2);
    l.close();
  });
});

describe("lineage queries", () => {
  test("an empty table returns []", () => {
    const l = ledger();
    expect(l.lineage()).toEqual([]);
    expect(l.lineageFor("nope")).toEqual([]);
    expect(l.threadIdOf("claude", "nope")).toBeUndefined();
    expect(l.lineageCount()).toBe(0);
    l.close();
  });

  test("lineage() spans threads; lineageFor() is scoped and hop-ordered", () => {
    const l = ledger();
    l.recordProvenance(prov({ threadId: "a", chain: [hop("codex", "1"), hop("omp", "2")] }));
    l.recordProvenance(prov({ threadId: "b", chain: [hop("pi", "3")] }));
    expect(l.lineage()).toHaveLength(3);
    expect(l.lineageCount()).toBe(3);
    expect(shape(l.lineageFor("a"))).toEqual(["codex:1@0", "omp:2@1<-codex:1"]);
    expect(shape(l.lineageFor("b"))).toEqual(["pi:3@0"]);
    l.close();
  });

  test("threadIdOf is keyed per harness, not per native id", () => {
    const l = ledger();
    l.recordProvenance(prov({ threadId: "a", chain: [hop("codex", "dup")] }));
    l.recordProvenance(prov({ threadId: "b", chain: [hop("omp", "dup")] }));
    expect(l.threadIdOf("codex", "dup")).toBe("a");
    expect(l.threadIdOf("omp", "dup")).toBe("b");
    l.close();
  });
});

/**
 * The user's real ledger holds thousands of rows they care about. The v2 schema
 * must be purely additive, so this builds a genuine v1 database by hand — the
 * exact DDL v1 shipped, with no `lineage` table — fills it, and reopens it as a
 * v2 Ledger.
 */
const V1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  harness           TEXT NOT NULL,
  native_id         TEXT NOT NULL,
  native_path       TEXT,
  cwd               TEXT,
  title             TEXT,
  first_prompt      TEXT,
  created_at        TEXT,
  updated_at        TEXT,
  message_count     INTEGER,
  model             TEXT,
  git_branch        TEXT,
  tokens_input      INTEGER,
  tokens_output     INTEGER,
  tokens_reasoning  INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  cost              REAL,
  parent_native_id  TEXT,
  is_subagent       INTEGER NOT NULL DEFAULT 0,
  ghost             INTEGER NOT NULL DEFAULT 0,
  host              TEXT,
  scanned_at        TEXT,
  PRIMARY KEY (harness, native_id)
);
CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_cwd_idx      ON sessions(cwd);
CREATE INDEX IF NOT EXISTS sessions_prefix_idx   ON sessions(native_id);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  harness      UNINDEXED,
  native_id    UNINDEXED,
  title,
  first_prompt,
  tokenize = 'unicode61'
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

describe("additive schema migration", () => {
  test("upgrades an existing v1 database in place, preserving every row", async () => {
    const dir = `/tmp/sinter-lineage-migration-${Bun.randomUUIDv7()}`;
    const path = `${dir}/ledger.db`;
    await Bun.$`mkdir -p ${dir}`.quiet();

    // --- a real v1 ledger with rows the user cares about
    const v1 = new Database(path, { create: true });
    v1.exec(V1_SCHEMA_SQL);
    v1.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1')");
    for (let i = 0; i < 250; i++) {
      v1.run(
        "INSERT INTO sessions (harness, native_id, title, first_prompt, updated_at, is_subagent, ghost) VALUES (?, ?, ?, ?, ?, 0, 0)",
        [i % 2 ? "codex" : "claude", `old-${i}`, `precious ${i}`, `prompt ${i}`, "2026-01-01T00:00:00.000Z"],
      );
      v1.run(
        "INSERT INTO sessions_fts (harness, native_id, title, first_prompt) VALUES (?, ?, ?, ?)",
        [i % 2 ? "codex" : "claude", `old-${i}`, `precious ${i}`, `prompt ${i}`],
      );
    }
    expect(
      (v1.query("SELECT count(*) AS n FROM sessions").get() as { n: number }).n,
    ).toBe(250);
    // Proof the fixture really is pre-lineage.
    expect(
      v1.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lineage'").all(),
    ).toEqual([]);
    v1.close();

    // --- open it with the current code
    const l = new Ledger(path);

    // every row survived, untouched
    expect(l.list()).toHaveLength(250);
    expect(l.get("claude", "old-0")!.title).toBe("precious 0");
    expect(l.get("codex", "old-249")!.title).toBe("precious 249");
    expect(l.search("precious")).toHaveLength(250);

    // and the additive lineage, alias, and pin tables exist and work
    expect(l.lineageCount()).toBe(0);
    l.recordProvenance(prov({ threadId: "post", chain: [hop("claude", "old-0"), hop("codex", "old-1")] }));
    expect(shape(l.lineageFor("post"))).toEqual(["claude:old-0@0", "codex:old-1@1<-claude:old-0"]);
    l.setAlias("claude", "old-0", "migration nickname");
    expect(l.get("claude", "old-0")!.alias).toBe("migration nickname");
    expect(l.search("nickname").map((row) => row.nativeId)).toEqual(["old-0"]);
    l.setPinned("claude", "old-0", true, "2026-08-24T01:00:00.000Z");
    expect(l.get("claude", "old-0")!.pinnedAt).toBe("2026-08-24T01:00:00.000Z");

    // version was recorded, not acted on
    const v = l.db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(v.value).toBe(String(SCHEMA_VERSION));
    expect(SCHEMA_VERSION).toBe(4);

    // reopening again is still non-destructive
    l.close();
    const l2 = new Ledger(path);
    expect(l2.list()).toHaveLength(250);
    expect(l2.get("claude", "old-0")!.alias).toBe("migration nickname");
    expect(l2.get("claude", "old-0")!.pinnedAt).toBe("2026-08-24T01:00:00.000Z");
    expect(l2.lineageCount()).toBe(2);
    l2.close();

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("lineage survives reopen alongside sessions", async () => {
    const dir = `/tmp/sinter-lineage-persist-${Bun.randomUUIDv7()}`;
    const path = `${dir}/ledger.db`;
    const l1 = new Ledger(path);
    l1.upsert(summary({ nativeId: "s1" }));
    l1.recordProvenance(prov({ threadId: "keep", chain: [hop("claude", "s1"), hop("omp", "s2")] }));
    l1.close();

    const l2 = new Ledger(path);
    expect(l2.get("claude", "s1")).toBeDefined();
    expect(l2.threadIdOf("omp", "s2")).toBe("keep");
    expect(l2.lineageFor("keep")).toHaveLength(2);
    l2.close();
    await Bun.$`rm -rf ${dir}`.quiet();
  });
});
