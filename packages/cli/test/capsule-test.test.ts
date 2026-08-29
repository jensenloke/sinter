import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPSULE_MANIFEST_SCHEMA,
  CAPSULE_MAX_SERIALIZED_BYTES,
  CAPSULE_PAYLOAD_SCHEMA,
  canonicalCapsuleJson,
  createSyntheticCapsule,
  parseSyntheticCapsule,
  serializeSyntheticCapsule,
} from "@sinter/core";
import {
  CAPSULE_TEST_FIXTURE_MARKER,
  CAPSULE_TEST_RESULT_SCHEMA,
  createCapsuleTestService,
  type CapsuleTestService,
} from "../src/capsule-test";
import type { AdapterRegistry } from "../src/adapters";
import type { CloudDeviceApiClient, CloudDeviceIdentity } from "../src/cloud-devices";
import type { Ctx } from "../src/commands";
import type { DeviceCredentialStore } from "../src/device-credentials";
import {
  DEVICE_CRYPTO_SUITE,
  deviceFingerprint,
  generateDeviceKeyMaterial,
  type DeviceKeyMaterial,
} from "../src/device-identity";
import { palette } from "../src/format";
import { main, run } from "../src/main";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "sinter-capsule-test-"));
}

function keyStore(material: DeviceKeyMaterial): DeviceCredentialStore {
  return {
    description: "isolated test key store",
    async load() { return material; },
    async save() { throw new Error("unexpected save"); },
    async delete() { throw new Error("unexpected delete"); },
  };
}

async function identity(material: DeviceKeyMaterial, id: string, overrides: Partial<CloudDeviceIdentity> = {}): Promise<CloudDeviceIdentity> {
  return {
    id,
    name: `private-device-name-${id}`,
    suite: DEVICE_CRYPTO_SUITE,
    fingerprint: await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey),
    encryptionPublicKey: material.encryptionPublicKey,
    signingPublicKey: material.signingPublicKey,
    revokedAt: null,
    ...overrides,
  };
}

function api(devices: CloudDeviceIdentity[]): CloudDeviceApiClient {
  return {
    async listDevices() { throw new Error("public metadata list must not be used by capsule test"); },
    async listDeviceIdentities() { return structuredClone(devices); },
    async registerDevice() { throw new Error("unexpected registration"); },
    async renameDevice() { throw new Error("unexpected rename"); },
    async revokeDevice() { throw new Error("unexpected revoke"); },
    async listEnrollments() { throw new Error("unexpected enrollment list"); },
    async approveEnrollment() { throw new Error("unexpected approval"); },
  };
}

async function pair() {
  const first = { ...(await generateDeviceKeyMaterial()), deviceId: "device-a" };
  const second = { ...(await generateDeviceKeyMaterial()), deviceId: "device-b" };
  const devices = [await identity(first, "device-a"), await identity(second, "device-b")];
  return {
    first,
    second,
    devices,
    firstService: createCapsuleTestService({ api: api(devices), keys: keyStore(first) }),
    secondService: createCapsuleTestService({ api: api(devices), keys: keyStore(second) }),
  };
}

function standardPayload(text: string = CAPSULE_TEST_FIXTURE_MARKER) {
  return {
    schema: CAPSULE_PAYLOAD_SCHEMA,
    synthetic: true as const,
    sif: {
      sif: "sif/0" as const,
      id: "test-synthetic-id",
      origin: { harness: "codex" as const, nativeId: "test-synthetic-native" },
      cwd: "",
      entries: [{ kind: "note" as const, id: "marker", parentId: null, noteType: text, text }],
    },
  };
}

async function customCapsule(sender: DeviceKeyMaterial, recipients: DeviceKeyMaterial[], text: string = CAPSULE_TEST_FIXTURE_MARKER) {
  return serializeSyntheticCapsule(await createSyntheticCapsule({
    manifest: { schema: CAPSULE_MANIFEST_SCHEMA },
    payload: standardPayload(text),
    sender: {
      encryptionPublicKey: sender.encryptionPublicKey,
      signingPublicKey: sender.signingPublicKey,
      signingPrivateKey: sender.signingPrivateKey,
      fingerprint: await deviceFingerprint(sender.encryptionPublicKey, sender.signingPublicKey),
    },
    recipients: await Promise.all(recipients.map(async (material) => ({
      encryptionPublicKey: material.encryptionPublicKey,
      signingPublicKey: material.signingPublicKey,
      fingerprint: await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey),
    }))),
  }));
}

function writeCapsule(path: string, serialized: string): void {
  writeFileSync(path, serialized, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function commandContext(service: CapsuleTestService) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let scans = 0;
  let ledgerTouches = 0;
  const ctx: Ctx = {
    registry: { async load() { scans++; throw new Error("must not scan"); } } as unknown as AdapterRegistry,
    ledger: () => { ledgerTouches++; throw new Error("must not open ledger"); },
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    pal: palette(false),
    width: 100,
    now: 0,
    writeFile: async () => { throw new Error("generic writer must not be used"); },
    readFile: async () => { throw new Error("generic reader must not be used"); },
    autoScan: true,
    capsuleTest: service,
    repositoryBinding: {
      async source() { throw new Error("capsule test must not inspect a repository"); },
      async resolve() { throw new Error("capsule test must not resolve a repository"); },
    },
  };
  return { ctx, stdout, stderr, scans: () => scans, ledgerTouches: () => ledgerTouches };
}

describe("synthetic local-file capsule diagnostic", () => {
  test("two generated identities round-trip through separate key stores with exact safe metadata", async () => {
    const directory = temporaryDirectory();
    try {
      const setup = await pair();
      const path = join(directory, "diagnostic.capsule.json");
      const created = await setup.firstService.create(path);
      const opened = await setup.secondService.open(path);
      const capsule = await parseSyntheticCapsule(readFileSync(path, "utf8"));

      expect(created).toMatchObject({
        schema: CAPSULE_TEST_RESULT_SCHEMA,
        operation: "create",
        capsuleId: capsule.header.capsuleId,
        senderFingerprint: setup.devices[0]!.fingerprint,
        localRecipientFingerprint: setup.devices[0]!.fingerprint,
        recipientCount: 2,
        filePath: path,
        decryptVerified: true,
        replayRejected: true,
      });
      expect(Object.keys(created).sort()).toEqual([
        "capsuleId",
        "decryptVerified",
        "filePath",
        "fileSha256",
        "localRecipientFingerprint",
        "operation",
        "recipientCount",
        "replayRejected",
        "schema",
        "senderFingerprint",
      ].sort());
      expect(opened).toMatchObject({
        schema: CAPSULE_TEST_RESULT_SCHEMA,
        operation: "open",
        capsuleId: created.capsuleId,
        senderFingerprint: created.senderFingerprint,
        localRecipientFingerprint: setup.devices[1]!.fingerprint,
        recipientCount: 2,
        fileSha256: created.fileSha256,
        decryptVerified: true,
        replayRejected: true,
      });
      expect(capsule.recipients.map((item) => item.fingerprint)).toEqual(
        setup.devices.map((item) => item.fingerprint).sort(),
      );
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const safe = JSON.stringify([created, opened]);
      expect(safe).not.toContain('"d"');
      expect(safe).not.toContain("ciphertext");
      expect(safe).not.toContain(CAPSULE_TEST_FIXTURE_MARKER);
      expect(safe).not.toContain("private-device-name");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects tamper, wrong sender, nonrecipient, and correctly signed different synthetic data", async () => {
    const directory = temporaryDirectory();
    try {
      const setup = await pair();
      const attacker = { ...(await generateDeviceKeyMaterial()), deviceId: "attacker" };
      const path = join(directory, "input.json");

      const valid = await customCapsule(setup.first, [setup.first, setup.second]);
      const tampered = JSON.parse(valid);
      tampered.payload.ciphertext = `${tampered.payload.ciphertext.slice(0, -1)}${tampered.payload.ciphertext.endsWith("A") ? "B" : "A"}`;
      writeCapsule(path, canonicalCapsuleJson(tampered));
      await expect(setup.secondService.open(path)).rejects.toThrow("canonical valid capsule");

      writeCapsule(path, await customCapsule(attacker, [setup.second]));
      await expect(setup.secondService.open(path)).rejects.toThrow("sender is not a current active");

      writeCapsule(path, await customCapsule(setup.first, [setup.first]));
      await expect(setup.secondService.open(path)).rejects.toThrow("decryption or sender verification failed");

      writeCapsule(path, await customCapsule(setup.first, [setup.second], "different-synthetic-fixture"));
      await expect(setup.secondService.open(path)).rejects.toThrow("did not match the exact synthetic fixture");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects missing, revoked, wrong-suite, malformed, and non-exact registry identities", async () => {
    const directory = temporaryDirectory();
    try {
      const setup = await pair();
      const path = join(directory, "valid.json");
      await setup.firstService.create(path);
      const [sender, recipient] = setup.devices;

      for (const devices of [
        [recipient!],
        [{ ...sender!, revokedAt: "2030-01-01T00:00:00.000Z" }, recipient!],
        [{ ...sender!, suite: "wrong-suite" }, recipient!],
      ]) {
        const service = createCapsuleTestService({ api: api(devices), keys: keyStore(setup.second) });
        await expect(service.open(path)).rejects.toThrow("sender is not a current active");
      }

      for (const changedRecipient of [
        { ...recipient!, revokedAt: "2030-01-01T00:00:00.000Z" },
        { ...recipient!, suite: "wrong-suite" },
      ]) {
        const service = createCapsuleTestService({ api: api([sender!, changedRecipient]), keys: keyStore(setup.second) });
        await expect(service.open(path)).rejects.toThrow("local recipient is not an active exact");
      }

      const inconsistent = { ...recipient!, fingerprint: "0".repeat(64) };
      await expect(createCapsuleTestService({ api: api([sender!, inconsistent]), keys: keyStore(setup.second) }).open(path))
        .rejects.toThrow("inconsistent registered device public identities");

      const duplicateId = { ...recipient!, id: sender!.id };
      await expect(createCapsuleTestService({ api: api([sender!, duplicateId]), keys: keyStore(setup.second) }).open(path))
        .rejects.toThrow("invalid registered device identity metadata");

      const withoutRevocationFields = [sender!, recipient!].map((device) => ({ ...device, revokedAt: undefined }));
      await expect(createCapsuleTestService({ api: api(withoutRevocationFields), keys: keyStore(setup.second) }).open(path))
        .resolves.toMatchObject({ operation: "open", localRecipientFingerprint: recipient!.fingerprint });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("requires two devices and enforces create-only output, regular bounded input, and parent existence", async () => {
    const directory = temporaryDirectory();
    try {
      const setup = await pair();
      const oneDevice = createCapsuleTestService({ api: api([setup.devices[0]!]), keys: keyStore(setup.first) });
      await expect(oneDevice.create(join(directory, "one.json"))).rejects.toThrow("at least two active");

      const existing = join(directory, "existing.json");
      writeFileSync(existing, "do-not-overwrite", { mode: 0o600 });
      await expect(setup.firstService.create(existing)).rejects.toThrow("already exists");
      expect(readFileSync(existing, "utf8")).toBe("do-not-overwrite");

      const linkedOutput = join(directory, "linked-output.json");
      symlinkSync(existing, linkedOutput);
      await expect(setup.firstService.create(linkedOutput)).rejects.toThrow("already exists");
      expect(readFileSync(existing, "utf8")).toBe("do-not-overwrite");
      expect(lstatSync(linkedOutput).isSymbolicLink()).toBe(true);

      await expect(setup.firstService.create(join(directory, "missing", "out.json"))).rejects.toThrow("parent directory does not exist");
      await expect(setup.secondService.open(directory)).rejects.toThrow("regular file");
      const symlink = join(directory, "linked.json");
      symlinkSync(existing, symlink);
      await expect(setup.secondService.open(symlink)).rejects.toThrow("regular file");

      const oversized = join(directory, "oversized.json");
      writeFileSync(oversized, "x", { mode: 0o600 });
      truncateSync(oversized, CAPSULE_MAX_SERIALIZED_BYTES + 1);
      await expect(setup.secondService.open(oversized)).rejects.toThrow("exceeds the capsule size limit");

      const subdirectory = join(directory, "subdirectory");
      mkdirSync(subdirectory);
      expect(lstatSync(subdirectory).isDirectory()).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("command injection emits one safe JSON document and never scans, opens the ledger, or accepts malformed usage", async () => {
    const value = {
      schema: CAPSULE_TEST_RESULT_SCHEMA,
      operation: "create" as const,
      capsuleId: "safe-capsule-id",
      senderFingerprint: "a".repeat(64),
      localRecipientFingerprint: "b".repeat(64),
      recipientCount: 2,
      filePath: "/tmp/safe-capsule.json",
      fileSha256: "c".repeat(64),
      decryptVerified: true as const,
      replayRejected: true as const,
    };
    let calls = 0;
    const service: CapsuleTestService = {
      async create(path) { calls++; expect(path).toBe("new.json"); return value; },
      async open() { throw new Error("unexpected open"); },
    };
    const harness = commandContext(service);
    expect(await run(["devices", "capsule-test", "create", "--output", "new.json", "--json"], harness.ctx)).toBe(0);
    expect(harness.stdout).toHaveLength(1);
    expect(JSON.parse(harness.stdout[0]!)).toEqual(value);
    expect(harness.stdout[0]).toContain("\n  \"operation\": \"create\"");
    expect(harness.stdout[0]).not.toContain("ciphertext");
    expect(harness.stdout[0]).not.toContain('"d"');
    expect(harness.stderr).toEqual([]);
    expect(harness.scans()).toBe(0);
    expect(harness.ledgerTouches()).toBe(0);
    expect(calls).toBe(1);

    for (const argv of [
      ["devices", "capsule-test"],
      ["devices", "capsule-test", "create"],
      ["devices", "capsule-test", "create", "--input", "wrong.json"],
      ["devices", "capsule-test", "open", "--input", "x", "extra"],
      ["devices", "capsule-test", "open", "--input", "x", "--output", "y"],
    ]) expect(await run(argv, harness.ctx)).toBe(1);
    expect(calls).toBe(1);
    expect(harness.scans()).toBe(0);
    expect(harness.ledgerTouches()).toBe(0);
  });

  test("reports expected diagnostic failures with a stable JSON error kind", async () => {
    const directory = temporaryDirectory();
    try {
      const setup = await pair();
      const service = createCapsuleTestService({ api: api([setup.devices[0]!]), keys: keyStore(setup.first) });
      const harness = commandContext(service);
      const output = join(directory, "must-not-exist.json");
      expect(await run(["devices", "capsule-test", "create", "--output", output, "--json"], harness.ctx)).toBe(1);
      expect(harness.stdout).toEqual([]);
      expect(harness.stderr).toHaveLength(1);
      expect(JSON.parse(harness.stderr[0]!)).toMatchObject({
        schema: "sinter.error.v1",
        ok: false,
        error: {
          code: 1,
          kind: "capsule_test",
          message: "Capsule diagnostic create requires at least two active initialized exact-suite devices.",
        },
      });
      expect(existsSync(output)).toBe(false);
      expect(harness.scans()).toBe(0);
      expect(harness.ledgerTouches()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("main keeps capsule-test account-only and does not bootstrap profile configuration", async () => {
    const directory = temporaryDirectory();
    const configPath = join(directory, "must-not-exist.toml");
    const previousConfig = process.env.SINTER_CONFIG;
    const previousUpdate = process.env.SINTER_NO_UPDATE_CHECK;
    process.env.SINTER_CONFIG = configPath;
    process.env.SINTER_NO_UPDATE_CHECK = "1";
    const output: string[] = [];
    try {
      const service: CapsuleTestService = {
        async create() {
          return {
            schema: CAPSULE_TEST_RESULT_SCHEMA,
            operation: "create",
            capsuleId: "capsule-id",
            senderFingerprint: "a".repeat(64),
            localRecipientFingerprint: "a".repeat(64),
            recipientCount: 2,
            filePath: join(directory, "new.json"),
            fileSha256: "b".repeat(64),
            decryptVerified: true,
            replayRejected: true,
          };
        },
        async open() { throw new Error("unexpected open"); },
      };
      expect(await main(
        ["devices", "capsule-test", "create", "--output", join(directory, "new.json"), "--json"],
        { capsuleTest: service, out: (line) => output.push(line), err: (line) => output.push(`err:${line}`) },
      )).toBe(0);
      expect(output).toHaveLength(1);
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
