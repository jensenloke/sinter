import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@sinter/ledger";
import { StaticAdapterRegistry } from "../src/adapters";
import { loadProfile } from "../src/config";
import { palette } from "../src/format";
import type { Ctx } from "../src/commands";
import { run } from "../src/main";
import { MockAdapter, session, summary } from "../../ledger/test/mock-adapter";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

interface Harness {
  ctx: Ctx;
  ledger: Ledger;
  claude: MockAdapter;
  omp: MockAdapter;
  stdout: string[];
  stderr: string[];
  written: Record<string, string>;
  execed: string[][];
  files: Record<string, string>;
  out(): string;
  err(): string;
}

function harness(): Harness {
  const ledger = new Ledger(":memory:");
  const claude = new MockAdapter({
    id: "claude",
    summaries: [
      summary({ nativeId: "aaa11111-1111", title: "porting sessions between harnesses" }),
      summary({ nativeId: "aaa22222-2222", title: "unrelated work", cwd: "/Users/test/other" }),
      summary({ nativeId: "bbb33333-3333", title: "old thing", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ],
    sessions: {
      "aaa11111-1111": session("aaa11111-1111"),
      "aaa22222-2222": session("aaa22222-2222"),
      "bbb33333-3333": session("bbb33333-3333"),
    },
  });
  const omp = new MockAdapter({
    id: "omp",
    summaries: [summary({ nativeId: "omp-1", harness: "omp", title: "omp session" })],
    sessions: { "omp-1": session("omp-1", "omp") },
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const written: Record<string, string> = {};
  const execed: string[][] = [];
  const files: Record<string, string> = {};

  const ctx: Ctx = {
    registry: new StaticAdapterRegistry([claude, omp], { zcode: "cannot find module" }),
    ledger: () => ledger,
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    pal: palette(false),
    width: 100,
    now: NOW,
    writeFile: async (p, c) => void (written[p] = c),
    readFile: async (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    },
    exec: async (argv) => {
      execed.push(argv);
      return 0;
    },
  };

  return {
    ctx,
    ledger,
    claude,
    omp,
    stdout,
    stderr,
    written,
    execed,
    files,
    out: () => stdout.join("\n"),
    err: () => stderr.join("\n"),
  };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

async function scan() {
  return run(["scan"], h.ctx);
}

describe("CLI conventions", () => {
  test("renders command-specific help without touching the ledger", async () => {
    expect(await run(["port", "--help"], h.ctx)).toBe(0);
    expect(h.out()).toContain("usage: sinter port");
    expect(h.out()).toContain("Creates a new target session");
    expect(h.out()).not.toContain("one ledger for every coding-agent session");
  });

  test("explains local-only storage and unsupported desktop surfaces", async () => {
    expect(await run(["privacy"], h.ctx)).toBe(0);
    expect(h.out()).toContain("does not upload transcripts");
    expect(h.out()).toContain("zcode: read-only");
    expect(h.out()).toContain("ChatGPT.app / Codex desktop: future work");
  });

  test("loads named, harness-root profiles", () => {
    const dir = mkdtempSync(join(tmpdir(), "sinter-profile-"));
    const config = join(dir, "config.toml");
    writeFileSync(config, `[profiles.work.stores]\nclaude = \"/tmp/claude-work/projects\"\ncodex = \"/tmp/codex-work\"\n`);
    try {
      expect(loadProfile(["--profile", "work", "--config", config])).toEqual({
        name: "work",
        configPath: config,
        stores: { claude: "/tmp/claude-work/projects", codex: "/tmp/codex-work" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("setup", () => {
  test("--yes detects and scans without opening the menu", async () => {
    expect(await run(["setup", "--yes"], h.ctx)).toBe(0);
    expect(h.out()).toContain("Detected local stores:");
    expect(h.out()).toContain("claude:");
    expect(h.ledger.list()).toHaveLength(4);
  });

  test("leaves the ledger untouched when confirmation declines", async () => {
    h.ctx.confirm = async () => false;
    expect(await run(["setup"], h.ctx)).toBe(0);
    expect(h.out()).toContain("Setup cancelled");
    expect(h.ledger.list()).toHaveLength(0);
  });
});

describe("scan", () => {
  test("populates the ledger and reports per-harness counts", async () => {
    expect(await scan()).toBe(0);
    expect(h.out()).toContain("claude");
    expect(h.out()).toMatch(/claude\s+3\s+3/);
    expect(h.ledger.list()).toHaveLength(4);
  });

  test("names unavailable adapters on stderr without failing", async () => {
    expect(await scan()).toBe(0);
    expect(h.err()).toContain("adapter not available: zcode");
  });

  test("a throwing adapter is an error exit but the others still scan", async () => {
    h.omp.throwOnList = "*";
    expect(await scan()).toBe(1);
    expect(h.err()).toContain("scan error [omp]");
    expect(h.ledger.list({ harness: "claude" })).toHaveLength(3);
  });

  test("with no adapters at all it errors clearly", async () => {
    h.ctx.registry = new StaticAdapterRegistry([], { claude: "not installed" });
    expect(await scan()).toBe(1);
    expect(h.err()).toContain("no adapters available");
  });
});

describe("ls", () => {
  test("tabulates newest first with short ids and ~-shortened cwd", async () => {
    await scan();
    expect(await run(["ls"], h.ctx)).toBe(0);
    const out = h.out();
    expect(out).toContain("HARNESS");
    expect(out).toContain("aaa11111");
    expect(out).toContain("porting sessions between harnesses");
    expect(out.split("\n").every((l) => l.length <= 100)).toBe(true);
  });

  test("filters by harness, cwd, since and limit", async () => {
    await scan();
    h.stdout.length = 0;
    await run(["ls", "--harness", "omp"], h.ctx);
    expect(h.out()).toContain("omp session");
    expect(h.out()).not.toContain("porting sessions");

    h.stdout.length = 0;
    await run(["ls", "--cwd", "/Users/test/other"], h.ctx);
    expect(h.out()).toContain("unrelated work");
    expect(h.out()).not.toContain("porting sessions");

    h.stdout.length = 0;
    await run(["ls", "--since", "7d"], h.ctx);
    expect(h.out()).not.toContain("old thing");

    h.stdout.length = 0;
    await run(["ls", "--limit", "1"], h.ctx);
    expect(h.out().split("\n")).toHaveLength(2); // header + 1
  });

  test("--json dumps rows", async () => {
    await scan();
    h.stdout.length = 0;
    await run(["ls", "--json", "--limit", "1"], h.ctx);
    const rows = JSON.parse(h.out());
    expect(rows[0].nativeId).toBeTruthy();
  });

  test("bad flags and values are exit 1", async () => {
    expect(await run(["ls", "--bogus"], h.ctx)).toBe(1);
    expect(await run(["ls", "--limit", "0"], h.ctx)).toBe(1);
    expect(await run(["ls", "--harness", "cursor"], h.ctx)).toBe(1);
  });
});

describe("search", () => {
  test("FTS matches titles and prints the same table", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["search", "porting"], h.ctx)).toBe(0);
    expect(h.out()).toContain("aaa11111");
    expect(h.out()).not.toContain("unrelated work");
  });

  test("needs a query", async () => {
    expect(await run(["search"], h.ctx)).toBe(1);
    expect(h.err()).toContain("usage: sinter search");
  });
});

describe("rename", () => {
  test("sets a searchable local alias that survives rescans", async () => {
    await scan();
    expect(await run(["rename", "aaa11111", "Important review"], h.ctx)).toBe(0);
    expect(h.ledger.get("claude", "aaa11111-1111")!.alias).toBe("Important review");
    await scan();
    expect(h.ledger.get("claude", "aaa11111-1111")!.alias).toBe("Important review");
    h.stdout.length = 0;
    expect(await run(["search", "Important review"], h.ctx)).toBe(0);
    expect(h.out()).toContain("Important review");
  });

  test("clears aliases explicitly and rejects a missing alias", async () => {
    await scan();
    await run(["rename", "aaa11111", "Temporary"], h.ctx);
    expect(await run(["rename", "aaa11111", "--clear"], h.ctx)).toBe(0);
    expect(h.ledger.get("claude", "aaa11111-1111")!.alias).toBeUndefined();
    expect(await run(["rename", "aaa11111"], h.ctx)).toBe(1);
  });
});

describe("show", () => {
  test("renders a transcript for a prefix", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["show", "aaa11111"], h.ctx)).toBe(0);
    expect(h.out()).toContain("● assistant");
    expect(h.out()).toContain("→ Read(");
  });

  test("ambiguous prefixes exit 2 and list candidates", async () => {
    await scan();
    expect(await run(["show", "aaa"], h.ctx)).toBe(2);
    expect(h.err()).toContain("ambiguous");
    expect(h.err()).toContain("aaa11111");
    expect(h.err()).toContain("aaa22222");
  });

  test("unknown prefixes exit 2", async () => {
    await scan();
    expect(await run(["show", "zzzz"], h.ctx)).toBe(2);
    expect(h.err()).toContain("no session matches");
  });

  test("harness-scoped ids resolve", async () => {
    await scan();
    expect(await run(["show", "omp:omp-1"], h.ctx)).toBe(0);
  });

  test("--json dumps SIF", async () => {
    await scan();
    h.stdout.length = 0;
    await run(["show", "aaa11111", "--json"], h.ctx);
    const s = JSON.parse(h.out());
    expect(s.sif).toBe("sif/0");
    expect(s.entries).toHaveLength(3);
  });

  test("an unavailable adapter is reported, not crashed", async () => {
    await scan();
    h.ledger.upsert(summary({ nativeId: "zc-1", harness: "zcode" }));
    expect(await run(["show", "zc-1"], h.ctx)).toBe(1);
    expect(h.err()).toContain("adapter not available: zcode");
  });
});

describe("export", () => {
  test("writes SIF to a file", async () => {
    await scan();
    expect(await run(["export", "aaa11111", "-o", "/tmp/x.sif.json"], h.ctx)).toBe(0);
    const s = JSON.parse(h.written["/tmp/x.sif.json"]!);
    expect(s.origin.nativeId).toBe("aaa11111-1111");
    expect(s.entries[0].raw).toBeDefined();
  });

  test("--slim strips raw", async () => {
    await scan();
    await run(["export", "aaa11111", "--slim", "-o", "/tmp/slim.json"], h.ctx);
    const s = JSON.parse(h.written["/tmp/slim.json"]!);
    expect(s.entries[0].raw).toBeUndefined();
  });

  test("without -o it goes to stdout", async () => {
    await scan();
    h.stdout.length = 0;
    await run(["export", "aaa11111"], h.ctx);
    expect(JSON.parse(h.out()).sif).toBe("sif/0");
  });
});

describe("import", () => {
  test("validates then writes into the target harness and prints the resume command", async () => {
    h.files["/tmp/in.json"] = JSON.stringify(session("src-1"));
    expect(await run(["import", "/tmp/in.json", "--to", "omp"], h.ctx)).toBe(0);
    expect(h.omp.written).toHaveLength(1);
    expect(h.out()).toContain("omp:new-omp-1");
    expect(h.out()).toContain("omp --resume new-omp-1");
    expect(h.err()).toContain("wrote omp:new-omp-1");
  });

  test("passes cwd / --live-tools / --dry-run through to the writer", async () => {
    h.files["/tmp/in.json"] = JSON.stringify(session("src-1"));
    await run(
      ["import", "/tmp/in.json", "--to", "omp", "--cwd", "/tmp/target", "--live-tools", "--dry-run"],
      h.ctx,
    );
    expect(h.omp.written[0]!.opts).toMatchObject({
      cwd: "/tmp/target",
      liveTools: true,
      dryRun: true,
    });
    expect(h.err()).toContain("would write");
  });

  test("invalid SIF is rejected", async () => {
    const bad = session("bad");
    (bad.entries[0] as { content: { type: "text"; text: string }[] }).content = [{ type: "text", text: "" }];
    h.files["/tmp/bad.json"] = JSON.stringify(bad);
    expect(await run(["import", "/tmp/bad.json", "--to", "omp"], h.ctx)).toBe(1);
    expect(h.err()).toContain("invalid SIF session");
  });

  test("missing file / missing --to are errors", async () => {
    expect(await run(["import", "/tmp/nope.json", "--to", "omp"], h.ctx)).toBe(1);
    expect(h.err()).toContain("cannot read SIF file");
    h.files["/tmp/in.json"] = JSON.stringify(session("src-1"));
    expect(await run(["import", "/tmp/in.json"], h.ctx)).toBe(1);
    expect(h.err()).toContain("needs --to");
  });

  test("an unavailable target adapter degrades", async () => {
    h.files["/tmp/in.json"] = JSON.stringify(session("src-1"));
    expect(await run(["import", "/tmp/in.json", "--to", "zcode"], h.ctx)).toBe(1);
    expect(h.err()).toContain("adapter not available: zcode");
  });
});

describe("port", () => {
  test("reads from one harness and writes into another", async () => {
    await scan();
    expect(await run(["port", "aaa11111", "--to", "omp"], h.ctx)).toBe(0);
    expect(h.omp.written[0]!.session.origin.nativeId).toBe("aaa11111-1111");
    expect(h.out()).toContain("omp --resume new-omp-1");
    expect(h.err()).toContain("porting claude:aaa11111-111 → omp");
  });

  test("carries a Sinter alias into the target native title", async () => {
    await scan();
    h.ledger.setAlias("claude", "aaa11111-1111", "Review complete");
    await run(["port", "aaa11111", "--to", "omp"], h.ctx);
    expect(h.omp.written[0]!.session.title).toEqual({ text: "Review complete", source: "user" });
  });

  test("ambiguity still exits 2", async () => {
    await scan();
    expect(await run(["port", "aaa", "--to", "omp"], h.ctx)).toBe(2);
  });
});

describe("resume", () => {
  test("same harness just prints the native command", async () => {
    await scan();
    expect(await run(["resume", "aaa11111"], h.ctx)).toBe(0);
    expect(h.out()).toContain("claude --resume aaa11111-1111");
    expect(h.omp.written).toHaveLength(0);
  });

  test("--in another harness ports first, then prints the target command", async () => {
    await scan();
    expect(await run(["resume", "aaa11111", "--in", "omp"], h.ctx)).toBe(0);
    expect(h.omp.written).toHaveLength(1);
    expect(h.out()).toContain("omp --resume new-omp-1");
  });

  test("--in the origin harness is a no-op port", async () => {
    await scan();
    await run(["resume", "aaa11111", "--in", "claude"], h.ctx);
    expect(h.out()).toContain("claude --resume aaa11111-1111");
  });

  test("--exec spawns instead of printing", async () => {
    await scan();
    expect(await run(["resume", "aaa11111", "--exec"], h.ctx)).toBe(0);
    expect(h.execed).toEqual([["claude", "--resume", "aaa11111-1111"]]);
  });

  test("resuming a ghost row in place is refused", async () => {
    await scan();
    h.claude.summaries = h.claude.summaries.filter((s) => s.nativeId !== "aaa11111-1111");
    await scan();
    expect(await run(["resume", "aaa11111"], h.ctx)).toBe(2);
    expect(h.err()).toContain("ghost row");
  });
});

describe("doctor", () => {
  test("lists detected stores, versions, ledger counts and unavailable adapters", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["doctor"], h.ctx)).toBe(0);
    const out = h.out();
    expect(out).toContain("claude");
    expect(out).toContain("0.0.0-mock");
    expect(out).toContain("unavailable adapters:");
    expect(out).toContain("zcode: cannot find module");
    expect(out).toContain("ledger:");
  });

  test("an absent store is reported, not fatal", async () => {
    h.omp = new MockAdapter({ id: "omp", detect: null });
    h.ctx.registry = new StaticAdapterRegistry([h.claude, h.omp]);
    expect(await run(["doctor"], h.ctx)).toBe(0);
    expect(h.out()).toContain("absent");
  });

  test("a throwing detect() is caught", async () => {
    const broken = new MockAdapter({ id: "pi" });
    broken.detect = async () => {
      throw new Error("store corrupt");
    };
    h.ctx.registry = new StaticAdapterRegistry([broken]);
    expect(await run(["doctor"], h.ctx)).toBe(0);
    expect(h.out()).toContain("detect failed: store corrupt");
  });
});

describe("dispatch", () => {
  test("help and version", async () => {
    expect(await run([], h.ctx)).toBe(0);
    expect(h.out()).toContain("usage: sinter [command]");
    h.stdout.length = 0;
    expect(await run(["--version"], h.ctx)).toBe(0);
    expect(h.out()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("per-command --help", async () => {
    expect(await run(["ls", "--help"], h.ctx)).toBe(0);
    expect(h.out()).toContain("usage: sinter");
  });

  test("unknown commands exit 1", async () => {
    expect(await run(["frobnicate"], h.ctx)).toBe(1);
    expect(h.err()).toContain("unknown command: frobnicate");
  });

  test("`list` is an alias for ls", async () => {
    await scan();
    expect(await run(["list", "--limit", "1"], h.ctx)).toBe(0);
  });
});
