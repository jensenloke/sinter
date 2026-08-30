import { describe, expect, test } from "bun:test";
import { DynamicAdapterRegistry, StaticAdapterRegistry, SPECS, pickAdapter } from "../src/adapters";
import { MockAdapter } from "../../ledger/test/mock-adapter";
import { openLedger } from "@sinter/ledger";

describe("SPECS", () => {
  test("covers all seven harnesses exactly once", () => {
    expect([...SPECS.map((s) => s.id)].sort().join(",")).toBe(
      "claude,codex,devin,omp,opencode,pi,zcode",
    );
  });
});

describe("pickAdapter", () => {
  const a = new MockAdapter({ id: "omp" });
  test("finds a default export", () => {
    expect(pickAdapter({ default: a })).toBe(a);
  });
  test("finds a named `adapter` export", () => {
    expect(pickAdapter({ adapter: a })).toBe(a);
  });
  test("finds any adapter-shaped export", () => {
    expect(pickAdapter({ OmpAdapterInstance: a })).toBe(a);
  });
  test("instantiates a default-exported zero-arg class", () => {
    const got = pickAdapter({ default: MockAdapter });
    expect(got?.id).toBe("claude");
  });
  test("returns undefined for a module with nothing adapter-shaped", () => {
    expect(pickAdapter({ default: { id: "omp" } })).toBeUndefined();
    expect(pickAdapter({})).toBeUndefined();
  });
});

describe("DynamicAdapterRegistry", () => {
  test("a missing package degrades to an error entry, never a throw", async () => {
    const reg = new DynamicAdapterRegistry([
      { id: "claude", pkg: "@sinter/definitely-not-installed" },
    ]);
    const loads = await reg.load();
    expect(loads).toHaveLength(1);
    expect(loads[0]!.adapter).toBeUndefined();
    expect(loads[0]!.error).toBeTruthy();
    expect(await reg.available()).toEqual([]);
    await expect(reg.get("claude")).rejects.toThrow(/adapter not available: claude/);
  });

  test("real packages either load or degrade — never crash the CLI", async () => {
    const reg = new DynamicAdapterRegistry();
    const loads = await reg.load();
    expect(loads).toHaveLength(7);
    for (const l of loads) expect(!!l.adapter || !!l.error).toBe(true);
  });

  test("load() is cached", async () => {
    const reg = new DynamicAdapterRegistry([{ id: "pi", pkg: "@sinter/nope" }]);
    expect(await reg.load()).toBe(await reg.load());
  });

  test("a selected profile is a strict boundary with no default fallbacks", async () => {
    const reg = new DynamicAdapterRegistry(SPECS, {
      name: "claude-only",
      configPath: "/tmp/config.toml",
      stores: { claude: "/tmp/claude" },
    });
    const loads = await reg.load();
    expect(loads.map((load) => `${load.harness}@${load.instanceId}`)).toEqual(["claude@default"]);
    await expect(reg.get("codex")).rejects.toThrow(/not selected/);
  });

  test("includeDefaults preserves other harness discovery without duplicating a named harness", async () => {
    const reg = new DynamicAdapterRegistry(SPECS, {
      name: "default",
      configPath: "/tmp/config.toml",
      stores: {},
      includeDefaults: true,
      instances: [
        { id: "personal", harness: "claude", store: "/tmp/personal" },
        { id: "work", harness: "claude", store: "/tmp/work" },
      ],
    });
    expect((await reg.load()).map((load) => `${load.harness}@${load.instanceId}`).sort()).toEqual([
      "claude@personal",
      "claude@work",
      "codex@default",
      "devin@default",
      "omp@default",
      "opencode@default",
      "pi@default",
      "zcode@default",
    ]);
  });

  test("loads two named instances of the same harness and rejects ambiguous compatibility lookup", async () => {
    const reg = new DynamicAdapterRegistry(SPECS, {
      name: "all",
      configPath: "/tmp/config.toml",
      stores: {},
      instances: [
        { id: "personal", harness: "claude", store: "/tmp/personal", command: ["claude"] },
        { id: "addvita", harness: "claude", store: "/tmp/addvita", command: ["claude-addvita"] },
      ],
    });
    expect((await reg.bindings()).map((binding) => binding.instanceId)).toEqual(["personal", "addvita"]);
    expect((await reg.getInstance("claude", "addvita")).id).toBe("claude");
    await expect(reg.get("claude")).rejects.toThrow(/multiple claude instances/);
    expect(
      await reg.resumeCommand("claude", "addvita", {
        harness: "claude",
        instanceId: "addvita",
        nativeId: "session-1",
      }),
    ).toEqual(["claude-addvita", "--resume", "session-1"]);
  });
});

describe("StaticAdapterRegistry", () => {
  test("serves known adapters and names unavailable ones", async () => {
    const omp = new MockAdapter({ id: "omp" });
    const reg = new StaticAdapterRegistry([omp], { zcode: "not installed" });
    expect(await reg.get("omp")).toMatchObject({ id: "omp", instanceId: "default" });
    await expect(reg.get("zcode")).rejects.toThrow(/adapter not available: zcode/);
    expect((await reg.load()).map((l) => l.id).sort()).toEqual(["omp", "zcode"]);
  });


  test("supports exact instance lookup and multi-part command prefixes", async () => {
    const personal = new MockAdapter({ id: "claude" });
    const work = new MockAdapter({ id: "claude" });
    const reg = new StaticAdapterRegistry([
      { instanceId: "personal", adapter: personal },
      {
        instanceId: "work",
        adapter: work,
        command: ["env", "CLAUDE_CONFIG_DIR=/tmp/work", "claude"],
      },
    ]);
    expect(await reg.getInstance("claude", "work")).toMatchObject({ id: "claude", instanceId: "work" });
    await expect(reg.get("claude")).rejects.toThrow(/multiple claude instances/);
    expect(
      await reg.resumeCommand("claude", "work", { harness: "claude", nativeId: "abc" }),
    ).toEqual(["env", "CLAUDE_CONFIG_DIR=/tmp/work", "claude", "--resume", "abc"]);
  });

  test("available adapters preserve same-harness instance isolation during scans", async () => {
    const personal = new MockAdapter({
      id: "claude",
      summaries: [{ harness: "claude", nativeId: "same-id", title: "personal" }],
    });
    const work = new MockAdapter({
      id: "claude",
      summaries: [{ harness: "claude", nativeId: "same-id", title: "work" }],
    });
    const registry = new StaticAdapterRegistry([
      { instanceId: "personal", adapter: personal },
      { instanceId: "work", adapter: work },
    ]);
    const available = await registry.available();
    expect(available.map((adapter) => adapter.instanceId)).toEqual(["personal", "work"]);

    const ledger = openLedger(":memory:");
    try {
      await ledger.scan(available);
      expect(ledger.get("claude", "same-id", "personal")?.title).toBe("personal");
      expect(ledger.get("claude", "same-id", "work")?.title).toBe("work");
      expect(ledger.list()).toHaveLength(2);
    } finally {
      ledger.close();
    }
  });
});
