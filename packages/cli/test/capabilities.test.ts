import { describe, expect, test } from "bun:test";
import type { HarnessAdapter, StoreInfo } from "@sinter/core";
import { MockAdapter } from "../../ledger/test/mock-adapter";
import { StaticAdapterRegistry } from "../src/adapters";
import { adapterCapabilities, CAPABILITIES_SCHEMA } from "../src/capabilities";

describe("adapter capability resolution", () => {
  test("reports behavior, PATH readiness, and known limitations in canonical order", async () => {
    const claude = new MockAdapter({ id: "claude" });
    const zcode = new MockAdapter({ id: "zcode" });
    Object.defineProperty(zcode, "write", { value: undefined });
    const result = await adapterCapabilities(new StaticAdapterRegistry([claude, zcode]), {
      which: (binary) => (binary === "claude" ? "/bin/claude" : null),
    });

    expect(CAPABILITIES_SCHEMA).toBe("sinter.capabilities.v1");
    expect(result.map((row) => row.harness)).toEqual([
      "claude",
      "codex",
      "devin",
      "opencode",
      "zcode",
      "omp",
      "pi",
    ]);
    expect(result[0]).toMatchObject({
      harness: "claude",
      adapter: "available",
      store: "detected",
      read: true,
      write: true,
      resume: "available",
    });
    expect(result[4]).toMatchObject({
      harness: "zcode",
      adapter: "available",
      read: true,
      write: false,
      resume: "unverified",
      limitations: ["read-only adapter", "native resume command is unverified"],
    });
    expect(result[1]).toMatchObject({ adapter: "unavailable", store: "not-checked", read: false });
  });

  test("isolates store detection failures and can skip store I/O for the TUI", async () => {
    const throwing = new MockAdapter({ id: "omp" });
    throwing.detect = async (): Promise<StoreInfo | null> => {
      throw new Error("private path must not escape");
    };
    const registry = new StaticAdapterRegistry([throwing]);
    const checked = await adapterCapabilities(registry, { which: () => null });
    expect(checked.find((row) => row.harness === "omp")).toMatchObject({
      store: "error",
      resume: "binary-missing",
      limitations: ["omp is not on PATH", "local store detection failed"],
    });

    let detects = 0;
    throwing.detect = async () => {
      detects += 1;
      return null;
    };
    const skipped = await adapterCapabilities(registry, { detectStores: false, which: () => null });
    expect(detects).toBe(0);
    expect(skipped.find((row) => row.harness === "omp")?.store).toBe("not-checked");
  });
});
