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
  test("--no-wait prints clear approval instructions without polling or scanning sessions", async () => {
    let registrationOptions: Parameters<CloudDeviceService["register"]>[1];
    const harness = commandContext(fakeService({
      async register(name, options) {
        registrationOptions = options;
        return {
          status: "approval_required",
          name: name ?? "Pending Mac",
          keyStorage: "test keychain",
          enrollment: { id: "request-1", requestFingerprint: "abc", expiresAt: "2030-01-01T00:00:00.000Z" },
        };
      },
    }));
    expect(await run(["devices", "register", "--name", "Pending Mac", "--no-wait"], harness.ctx)).toBe(0);
    expect(harness.stdout.join("\n")).toContain("Approval required");
    expect(harness.stdout.join("\n")).toContain("request-1");
    expect(harness.stdout.join("\n")).toContain("sinter devices approve request-1");
    expect(registrationOptions?.wait).toBe(false);
    expect(harness.stderr).toEqual([]);
    expect(harness.scans()).toBe(0);
    expect(harness.ledgerTouches()).toBe(0);
  });

  test("human registration prints approval progress to stderr and then success", async () => {
    let timeoutMs: number | undefined;
    const harness = commandContext(fakeService({
      async register(name, options) {
        timeoutMs = options?.timeoutMs;
        await options?.onStatus?.({
          status: "waiting_for_approval",
          requestId: "request-human",
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
        return {
          status: "registered",
          name: name ?? "Waiting Mac",
          keyStorage: "test keychain",
          deviceId: "approved-device",
          device: { id: "approved-device", name: name ?? "Waiting Mac", fingerprint: "abc", status: "active" },
        };
      },
    }));

    expect(await run(["devices", "register", "--name", "Waiting Mac", "--timeout", "90s"], harness.ctx)).toBe(0);
    expect(timeoutMs).toBe(90_000);
    expect(harness.stderr).toEqual([
      "Enrollment request: request-human",
      "Expires: 2030-01-01T00:00:00.000Z",
      "Waiting for approval...",
    ]);
    expect(harness.stdout.join("\n")).toContain("Approved and registered device Waiting Mac (approved-device)");
    expect(harness.stdout.join("\n")).not.toContain("abc");
    expect(harness.scans()).toBe(0);
    expect(harness.ledgerTouches()).toBe(0);
  });

  test("JSON registration emits one final stdout document while progress stays on stderr", async () => {
    const harness = commandContext(fakeService({
      async register(name, options) {
        await options?.onStatus?.({
          status: "waiting_for_approval",
          requestId: "request-json",
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
        return { status: "registered", name: name ?? "JSON Mac", keyStorage: "test keychain", deviceId: "json-device" };
      },
    }));

    expect(await run(["devices", "register", "--name", "JSON Mac", "--json"], harness.ctx)).toBe(0);
    expect(harness.stdout).toHaveLength(1);
    expect(JSON.parse(harness.stdout[0]!)).toMatchObject({
      schema: "sinter.cloud.device-registration-result.v1",
      ok: true,
      status: "registered",
      deviceId: "json-device",
    });
    expect(harness.stderr.join("\n")).toContain("Waiting for approval");
    expect(harness.stdout[0]).not.toContain("Waiting for approval");
  });

  test("validates registration timeout bounds and incompatible wait flags before calling the service", async () => {
    let calls = 0;
    const harness = commandContext(fakeService({ async register(name) { calls++; return { status: "registered", name: name ?? "Mac", keyStorage: "keys", deviceId: "id" }; } }));
    expect(await run(["devices", "register", "--timeout", "4s"], harness.ctx)).toBe(1);
    expect(harness.stderr.pop()).toContain("between 5s and 15m");
    expect(await run(["devices", "register", "--timeout", "16m"], harness.ctx)).toBe(1);
    expect(await run(["devices", "register", "--no-wait", "--timeout", "5s"], harness.ctx)).toBe(1);
    expect(harness.stderr.pop()).toContain("cannot be used with --no-wait");
    expect(calls).toBe(0);
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

  test("device help documents automatic waiting and script controls", async () => {
    const harness = commandContext(fakeService());
    expect(await run(["help", "devices"], harness.ctx)).toBe(0);
    const help = harness.stdout.join("\n");
    expect(help).toContain("--no-wait");
    expect(help).toContain("--timeout 5m");
    expect(help).toContain("waits for an existing device");
    expect(help).toContain("Ctrl+C");
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
