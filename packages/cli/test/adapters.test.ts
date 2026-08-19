import { describe, expect, test } from "bun:test";
import { DynamicAdapterRegistry, StaticAdapterRegistry, SPECS, pickAdapter } from "../src/adapters";
import { MockAdapter } from "../../ledger/test/mock-adapter";

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
});

describe("StaticAdapterRegistry", () => {
  test("serves known adapters and names unavailable ones", async () => {
    const omp = new MockAdapter({ id: "omp" });
    const reg = new StaticAdapterRegistry([omp], { zcode: "not installed" });
    expect(await reg.get("omp")).toBe(omp);
    await expect(reg.get("zcode")).rejects.toThrow(/adapter not available: zcode/);
    expect((await reg.load()).map((l) => l.id).sort()).toEqual(["omp", "zcode"]);
  });
});
