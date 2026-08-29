import { constants, type Stats } from "node:fs";
import { lstat, open, stat, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CAPSULE_MANIFEST_SCHEMA,
  CAPSULE_MAX_SERIALIZED_BYTES,
  CAPSULE_PAYLOAD_SCHEMA,
  CapsuleReplayError,
  MemoryCapsuleReplayGuard,
  canonicalCapsuleJson,
  capsuleRecipientFingerprint,
  createSyntheticCapsule,
  openSyntheticCapsule,
  parseSyntheticCapsule,
  serializeSyntheticCapsule,
  type CapsuleManifest,
  type SyntheticCapsule,
  type SyntheticCapsulePayload,
} from "@sinter/core";
import { CliError, EXIT } from "./args";
import { createCloudDeviceApiClient, type CloudDeviceApiClient, type CloudDeviceIdentity } from "./cloud-devices";
import { createDeviceCredentialStore, type DeviceCredentialStore } from "./device-credentials";
import { DEVICE_CRYPTO_SUITE, validateDeviceKeyMaterial, type DeviceKeyMaterial } from "./device-identity";

export const CAPSULE_TEST_RESULT_SCHEMA = "sinter.devices.capsule-test-result.v1" as const;
export const CAPSULE_TEST_FIXTURE_MARKER = "sinter.synthetic.capsule-test.fixture.v1" as const;
export const CAPSULE_TEST_REPLAY_ENTRIES = 2;

const FIXTURE_MANIFEST: CapsuleManifest = Object.freeze({ schema: CAPSULE_MANIFEST_SCHEMA });
const FIXTURE_PAYLOAD: SyntheticCapsulePayload = Object.freeze({
  schema: CAPSULE_PAYLOAD_SCHEMA,
  synthetic: true,
  sif: {
    sif: "sif/0" as const,
    id: CAPSULE_TEST_FIXTURE_MARKER,
    origin: { harness: "codex" as const, nativeId: CAPSULE_TEST_FIXTURE_MARKER },
    cwd: "",
    entries: [{
      kind: "note" as const,
      id: "sinter-capsule-test-marker-v1",
      parentId: null,
      noteType: CAPSULE_TEST_FIXTURE_MARKER,
      text: CAPSULE_TEST_FIXTURE_MARKER,
    }],
  },
});

export interface CapsuleTestResult {
  schema: typeof CAPSULE_TEST_RESULT_SCHEMA;
  operation: "create" | "open";
  capsuleId: string;
  senderFingerprint: string;
  localRecipientFingerprint: string;
  recipientCount: number;
  filePath: string;
  fileSha256: string;
  decryptVerified: true;
  replayRejected: true;
}

export interface CapsuleTestService {
  create(output: string): Promise<CapsuleTestResult>;
  open(input: string): Promise<CapsuleTestResult>;
}

class CapsuleTestFailure extends CliError {
  constructor(message: string) {
    super(message, EXIT.ERROR, "capsule_test");
  }
}

function failure(message: string): never {
  throw new CapsuleTestFailure(message);
}

function exactPublicJwk(value: JsonWebKey): Record<string, unknown> {
  return { crv: value.crv, kty: value.kty, x: value.x, y: value.y };
}

function publicKeysEqual(left: JsonWebKey, right: JsonWebKey): boolean {
  return canonicalCapsuleJson(exactPublicJwk(left)) === canonicalCapsuleJson(exactPublicJwk(right));
}

function activeExactSuite(device: CloudDeviceIdentity): boolean {
  return device.suite === DEVICE_CRYPTO_SUITE
    && (device.revokedAt === undefined || device.revokedAt === null)
    && (device.status === undefined || device.status === "active");
}

async function verifiedActiveDevices(api: CloudDeviceApiClient): Promise<CloudDeviceIdentity[]> {
  if (!api.listDeviceIdentities) failure("This Sinter Cloud response does not include registered device public identities.");
  const listed = await api.listDeviceIdentities();
  const active = listed.filter(activeExactSuite);
  const fingerprints = new Set<string>();
  const ids = new Set<string>();
  for (const device of active) {
    if (!device.id || ids.has(device.id) || !/^[0-9a-f]{64}$/.test(device.fingerprint)) {
      failure("Sinter Cloud returned invalid registered device identity metadata.");
    }
    ids.add(device.id);
    let derived: string;
    try {
      derived = await capsuleRecipientFingerprint(device.encryptionPublicKey, device.signingPublicKey);
    } catch {
      failure("Sinter Cloud returned invalid registered device public identity material.");
    }
    if (derived !== device.fingerprint || fingerprints.has(device.fingerprint)) {
      failure("Sinter Cloud returned inconsistent registered device public identities.");
    }
    fingerprints.add(device.fingerprint);
  }
  return active.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

async function localIdentity(
  keys: DeviceCredentialStore,
  active: readonly CloudDeviceIdentity[],
): Promise<{ material: DeviceKeyMaterial; device: CloudDeviceIdentity; fingerprint: string }> {
  const loaded = await keys.load();
  if (!loaded) failure("No local registered device keys found; run `sinter devices register` first.");
  let material: DeviceKeyMaterial;
  try {
    material = await validateDeviceKeyMaterial(loaded);
  } catch {
    failure("Local registered device keys are invalid.");
  }
  if (!material.deviceId) failure("Local device registration is not initialized; run `sinter devices register` first.");
  const fingerprint = await capsuleRecipientFingerprint(material.encryptionPublicKey, material.signingPublicKey);
  const device = active.find((candidate) => candidate.id === material.deviceId && candidate.fingerprint === fingerprint);
  if (!device
    || !publicKeysEqual(device.encryptionPublicKey, material.encryptionPublicKey)
    || !publicKeysEqual(device.signingPublicKey, material.signingPublicKey)) {
    failure("The local recipient is not an active exact registered device identity.");
  }
  return { material, device, fingerprint };
}

function assertFixture(opened: Awaited<ReturnType<typeof openSyntheticCapsule>>): void {
  if (canonicalCapsuleJson(opened.manifest) !== canonicalCapsuleJson(FIXTURE_MANIFEST)
    || canonicalCapsuleJson(opened.payload) !== canonicalCapsuleJson(FIXTURE_PAYLOAD)) {
    failure("Capsule diagnostic decrypted data did not match the exact synthetic fixture.");
  }
}

async function verifyTwice(
  capsule: string,
  local: Awaited<ReturnType<typeof localIdentity>>,
  sender: CloudDeviceIdentity,
): Promise<void> {
  const guard = new MemoryCapsuleReplayGuard(CAPSULE_TEST_REPLAY_ENTRIES);
  const identity = {
    fingerprint: local.fingerprint,
    encryptionPrivateKey: local.material.encryptionPrivateKey,
    expectedSenderFingerprint: sender.fingerprint,
    senderSigningPublicKey: sender.signingPublicKey,
  };
  let opened: Awaited<ReturnType<typeof openSyntheticCapsule>>;
  try {
    opened = await openSyntheticCapsule(capsule, identity, { replayGuard: guard });
  } catch {
    failure("Capsule diagnostic decryption or sender verification failed.");
  }
  assertFixture(opened);
  try {
    await openSyntheticCapsule(capsule, identity, { replayGuard: guard });
  } catch (error) {
    if (error instanceof CapsuleReplayError) return;
    failure("Capsule diagnostic replay verification failed.");
  }
  failure("Capsule diagnostic replay was not rejected.");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex");
}

async function ensureOutputParent(path: string): Promise<void> {
  let parent: Stats;
  try {
    parent = await stat(dirname(path));
  } catch {
    failure("Capsule test output parent directory does not exist.");
  }
  if (!parent.isDirectory()) failure("Capsule test output parent is not a directory.");
}

async function writeNewOwnerOnly(path: string, serialized: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") failure("Capsule test output already exists; choose a new file.");
    if (code === "ENOENT") failure("Capsule test output parent directory does not exist.");
    if (error instanceof CapsuleTestFailure) throw error;
    failure("Capsule test output could not be written safely.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readBoundedRegularFile(path: string): Promise<{ serialized: string; bytes: Uint8Array }> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch {
    failure("Capsule test input file could not be opened.");
  }
  if (!before.isFile()) failure("Capsule test input must be a regular file.");
  if (before.size > CAPSULE_MAX_SERIALIZED_BYTES) failure("Capsule test input exceeds the capsule size limit.");

  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const current = await handle.stat();
    if (!current.isFile()) failure("Capsule test input must be a regular file.");
    if (current.dev !== before.dev || current.ino !== before.ino) {
      failure("Capsule test input changed while it was being opened.");
    }
    if (current.size > CAPSULE_MAX_SERIALIZED_BYTES) failure("Capsule test input exceeds the capsule size limit.");

    const buffer = Buffer.allocUnsafe(CAPSULE_MAX_SERIALIZED_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > CAPSULE_MAX_SERIALIZED_BYTES) failure("Capsule test input exceeds the capsule size limit.");

    const after = await handle.stat();
    if (after.dev !== current.dev
      || after.ino !== current.ino
      || after.size !== current.size
      || after.mtimeMs !== current.mtimeMs
      || after.ctimeMs !== current.ctimeMs
      || offset !== current.size) {
      failure("Capsule test input changed while it was being read.");
    }
    const bytes = buffer.subarray(0, offset);
    return { serialized: bytes.toString("utf8"), bytes: new Uint8Array(bytes) };
  } catch (error) {
    if (error instanceof CapsuleTestFailure) throw error;
    failure("Capsule test input file could not be read safely.");
  } finally {
    await handle?.close().catch(() => {});
  }
  failure("Capsule test input file could not be read safely.");
}

function result(
  operation: "create" | "open",
  capsule: SyntheticCapsule,
  localFingerprint: string,
  filePath: string,
  fileSha256: string,
): CapsuleTestResult {
  return {
    schema: CAPSULE_TEST_RESULT_SCHEMA,
    operation,
    capsuleId: capsule.header.capsuleId,
    senderFingerprint: capsule.sender.fingerprint,
    localRecipientFingerprint: localFingerprint,
    recipientCount: capsule.recipients.length,
    filePath,
    fileSha256,
    decryptVerified: true,
    replayRejected: true,
  };
}

export function createCapsuleTestService(options: {
  api?: CloudDeviceApiClient;
  keys?: DeviceCredentialStore;
} = {}): CapsuleTestService {
  const api = options.api ?? createCloudDeviceApiClient();
  const keys = options.keys ?? createDeviceCredentialStore();

  return {
    async create(output) {
      const filePath = resolve(output);
      await ensureOutputParent(filePath);
      try {
        const active = await verifiedActiveDevices(api);
        if (active.length < 2) failure("Capsule diagnostic create requires at least two active initialized exact-suite devices.");
        const local = await localIdentity(keys, active);
        const capsule = await createSyntheticCapsule({
          manifest: FIXTURE_MANIFEST,
          payload: FIXTURE_PAYLOAD,
          sender: {
            encryptionPublicKey: local.material.encryptionPublicKey,
            signingPublicKey: local.material.signingPublicKey,
            signingPrivateKey: local.material.signingPrivateKey,
            fingerprint: local.fingerprint,
          },
          recipients: active.map((device) => ({
            encryptionPublicKey: device.encryptionPublicKey,
            signingPublicKey: device.signingPublicKey,
            fingerprint: device.fingerprint,
          })),
        });
        const serialized = serializeSyntheticCapsule(capsule);
        await verifyTwice(serialized, local, local.device);
        await writeNewOwnerOnly(filePath, serialized);
        return result("create", capsule, local.fingerprint, filePath, await sha256Hex(new TextEncoder().encode(serialized)));
      } catch (error) {
        if (error instanceof CapsuleTestFailure) throw error;
        failure("Capsule diagnostic create failed safely.");
      }
    },

    async open(input) {
      const filePath = resolve(input);
      try {
        const file = await readBoundedRegularFile(filePath);
        let capsule: SyntheticCapsule;
        try {
          capsule = await parseSyntheticCapsule(file.serialized);
        } catch {
          failure("Capsule test input is not a canonical valid capsule.");
        }
        const active = await verifiedActiveDevices(api);
        const local = await localIdentity(keys, active);
        const sender = active.find((device) => device.fingerprint === capsule.sender.fingerprint);
        if (!sender) failure("Capsule sender is not a current active exact-suite registered device.");
        await verifyTwice(file.serialized, local, sender);
        return result("open", capsule, local.fingerprint, filePath, await sha256Hex(file.bytes));
      } catch (error) {
        if (error instanceof CapsuleTestFailure) throw error;
        failure("Capsule diagnostic open failed safely.");
      }
    },
  };
}
