import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterRegistry } from "../src/adapters";
import type { Ctx } from "../src/commands";
import type { CloudDeviceService } from "../src/cloud-devices";
import { palette } from "../src/format";
import { main, run } from "../src/main";

function commandContext(service: CloudDeviceService) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let scans = 0;
  let ledgerTouches = 0;
  const registry = {
    async load() { scans++; throw new Error("devices must not scan sessions"); },
  } as unknown as AdapterRegistry;
  const ctx: Ctx = {
    registry,
    ledger: () => { ledgerTouches++; throw new Error("devices must not open the ledger"); },
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    pal: palette(false),
    width: 100,
    now: 0,
    writeFile: async () => {},
    readFile: async () => "",
    autoScan: true,
    cloudDevices: service,
  };
  return { ctx, stdout, stderr, scans: () => scans, ledgerTouches: () => ledgerTouches };
}

function fakeService(overrides: Partial<CloudDeviceService> = {}): CloudDeviceService {
  return {
    async register(name) {
      return { status: "registered", name: name ?? "Default Mac", keyStorage: "test keychain", deviceId: "device-1" };
    },
    async list() { return []; },
    async rename() {},
    async revoke() {},
    async pending() { return []; },
    async approve(requestId) { return { requestId, approverDeviceId: "device-1" }; },
    ...overrides,
  };
}

describe("sinter devices commands", () => {
  test("prints a clear approval-required registration response without scanning sessions", async () => {
    const harness = commandContext(fakeService({
      async register(name) {
        return {
          status: "approval_required",
          name: name ?? "Pending Mac",
          keyStorage: "test keychain",
          enrollment: { id: "request-1", requestFingerprint: "abc", expiresAt: "2030-01-01T00:00:00.000Z" },
        };
      },
    }));
    expect(await run(["devices", "register", "--name", "Pending Mac"], harness.ctx)).toBe(0);
    expect(harness.stdout.join("\n")).toContain("Approval required");
    expect(harness.stdout.join("\n")).toContain("request-1");
    expect(harness.scans()).toBe(0);
    expect(harness.ledgerTouches()).toBe(0);
  });

  test("emits versioned JSON for lists and mutations", async () => {
    const calls: string[] = [];
    const harness = commandContext(fakeService({
      async list() {
        return [{ id: "device-1", name: "MacBook", fingerprint: "0123456789abcdef", status: "active" }];
      },
      async rename(id, name) { calls.push(`rename:${id}:${name}`); },
      async revoke(id) { calls.push(`revoke:${id}`); },
      async approve(id) { calls.push(`approve:${id}`); return { requestId: id, approverDeviceId: "device-1" }; },
    }));
    expect(await run(["devices", "list", "--json"], harness.ctx)).toBe(0);
    expect(JSON.parse(harness.stdout.pop()!)).toMatchObject({ schema: "sinter.cloud.devices.v1", ok: true, devices: [{ id: "device-1" }] });
    expect(await run(["devices", "rename", "device-1", "Studio", "--json"], harness.ctx)).toBe(0);
    expect(JSON.parse(harness.stdout.pop()!).schema).toBe("sinter.cloud.device-rename.v1");
    expect(await run(["devices", "revoke", "device-2", "--yes", "--json"], harness.ctx)).toBe(0);
    expect(await run(["devices", "approve", "request-1", "--json"], harness.ctx)).toBe(0);
    expect(calls).toEqual(["rename:device-1:Studio", "revoke:device-2", "approve:request-1"]);
    expect(harness.scans()).toBe(0);
    expect(harness.ledgerTouches()).toBe(0);
  });

  test("returns stable nonzero versioned usage errors", async () => {
    let revoked = false;
    const harness = commandContext(fakeService({ async revoke() { revoked = true; } }));
    expect(await run(["devices", "rename", "only-an-id", "--json"], harness.ctx)).toBe(1);
    expect(JSON.parse(harness.stderr[0]!)).toMatchObject({
      schema: "sinter.error.v1",
      ok: false,
      error: { code: 1, kind: "usage" },
    });
    expect(await run(["devices", "revoke", "device-1", "--json"], harness.ctx)).toBe(1);
    expect(revoked).toBe(false);
    expect(harness.scans()).toBe(0);
    expect(harness.ledgerTouches()).toBe(0);
  });

  test("main treats device commands as account-only and does not create profile config", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sinter-devices-no-config-"));
    const configPath = join(directory, "config.toml");
    const previousConfig = process.env.SINTER_CONFIG;
    const previousUpdate = process.env.SINTER_NO_UPDATE_CHECK;
    process.env.SINTER_CONFIG = configPath;
    process.env.SINTER_NO_UPDATE_CHECK = "1";
    try {
      expect(await main(["devices", "not-an-action"])).toBe(1);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      if (previousConfig === undefined) delete process.env.SINTER_CONFIG;
      else process.env.SINTER_CONFIG = previousConfig;
      if (previousUpdate === undefined) delete process.env.SINTER_NO_UPDATE_CHECK;
      else process.env.SINTER_NO_UPDATE_CHECK = previousUpdate;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
