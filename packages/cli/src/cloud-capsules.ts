import {
  CAPSULE_MANIFEST_SCHEMA,
  CAPSULE_MAX_SERIALIZED_BYTES,
  CAPSULE_SCHEMA,
  CAPSULE_SESSION_PAYLOAD_SCHEMA,
  canonicalCapsuleJson,
  canonicalCapsuleRequestNonce,
  capsuleRecipientFingerprint,
  capsuleReplayKey,
  capsuleRequestBodySha256,
  capsuleRequestProofBytes,
  createSessionCapsule,
  openSessionCapsule,
  parseSyntheticCapsule,
  serializeSyntheticCapsule,
  type CapsuleManifest,
} from "@sinter/core";
import { CliError, EXIT } from "./args";
import { createCloudAuthService, type CloudAuthService } from "./cloud-auth";
import {
  createCloudDeviceApiClient,
  type CloudDeviceApiClient,
  type CloudDeviceIdentity,
} from "./cloud-devices";
import { createDeviceCredentialStore, type DeviceCredentialStore } from "./device-credentials";
import {
  DEVICE_CRYPTO_SUITE,
  validateDeviceKeyMaterial,
  type DeviceKeyMaterial,
} from "./device-identity";
import {
  SESSION_TRANSFER_SCHEMA,
  parseSessionTransferPayload,
  type SessionTransferPayloadV2,
} from "./repository-binding";

export const CLOUD_CAPSULE_RESERVE_SCHEMA = "sinter.cloud.capsule-reserve.v1" as const;
export const CLOUD_CAPSULE_FINALIZE_SCHEMA = "sinter.cloud.capsule-finalize.v1" as const;
export const CLOUD_CAPSULE_DOWNLOAD_REQUEST_SCHEMA = "sinter.cloud.capsule-download-request.v1" as const;

const CLOUD_CAPSULE_LIST_SCHEMA = "sinter.cloud.capsules.v1";
const CLOUD_CAPSULE_METADATA_SCHEMA = "sinter.cloud.capsule-metadata.v1";
const CLOUD_CAPSULE_RESERVATION_SCHEMA = "sinter.cloud.capsule-reservation.v1";
const CLOUD_CAPSULE_FINALIZATION_SCHEMA = "sinter.cloud.capsule-finalization.v1";
const CLOUD_CAPSULE_DOWNLOAD_SCHEMA = "sinter.cloud.capsule-download.v1";
const CLOUD_CAPSULE_DELETION_SCHEMA = "sinter.cloud.capsule-deletion.v1";
const CLOUD_ERROR_SCHEMA = "sinter.cloud.error.v1";
const API_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SCHEMA_PATTERN = /^[a-z][a-z0-9.-]*\.v[0-9]+$/;
const CAPSULE_STATUSES = new Set(["reserved", "retained", "delete_pending", "deleted", "expired"]);

export type CloudCapsuleStatus = "reserved" | "retained" | "delete_pending" | "deleted" | "expired";

export interface CloudCapsuleMetadata {
  id: string;
  serializedBytes: number;
  serializedSha256: string;
  outerSchema: string;
  payloadSchema: string;
  transferSchema: string;
  senderFingerprint: string;
  recipientFingerprints: string[];
  recipientCount: number;
  status: CloudCapsuleStatus;
  reservedAt: string;
  reservationExpiresAt: string;
  finalizedAt: string | null;
  deletionRequestedAt: string | null;
  storageDeletedAt: string | null;
  expiredAt: string | null;
}

export interface CloudCapsuleApiClient {
  request(method: "GET" | "POST" | "DELETE", pathname: string, body?: unknown): Promise<unknown>;
  upload(signedUrl: string, bytes: Uint8Array): Promise<void>;
  download(signedUrl: string, expectedBytes: number, maximumBytes: number): Promise<Uint8Array>;
}

export interface CloudCapsulePushInput {
  transfer: SessionTransferPayloadV2;
  manifest: CapsuleManifest;
  to?: "all" | string;
  preview?: boolean;
}

export interface CloudCapsulePushResult {
  operation: "preview" | "push";
  metadata: CloudCapsuleMetadata;
  recipientCount: number;
  uploaded: boolean;
}

export interface OpenedCloudCapsule {
  metadata: CloudCapsuleMetadata;
  manifest: CapsuleManifest;
  transfer: SessionTransferPayloadV2;
  replayKey: string;
}

export interface CloudCapsuleService {
  push(input: CloudCapsulePushInput): Promise<CloudCapsulePushResult>;
  list(): Promise<CloudCapsuleMetadata[]>;
  inspect(capsuleId: string): Promise<OpenedCloudCapsule>;
  delete(capsuleId: string): Promise<CloudCapsuleMetadata>;
}

class CloudCapsuleFailure extends CliError {
  constructor(message: string) {
    super(message, EXIT.ERROR, "cloud_capsule");
  }
}

function failure(message: string): never {
  throw new CloudCapsuleFailure(message);
}

async function safeApi<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CloudCapsuleFailure) throw error;
    failure(`Cloud capsule ${operation} failed safely.`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failure(`Sinter Cloud returned an invalid ${label}.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) failure(`Sinter Cloud returned an invalid ${label}.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    failure(`Sinter Cloud returned an invalid ${label}.`);
  }
}

function capsuleId(value: unknown): string {
  if (typeof value !== "string" || value.length !== 22 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    failure("Sinter Cloud returned invalid capsule metadata.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 16 || decoded.toString("base64url") !== value) failure("Sinter Cloud returned invalid capsule metadata.");
  return value;
}

function boundedDate(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    failure("Sinter Cloud returned invalid capsule metadata.");
  }
  return value;
}

function parseMetadata(value: unknown): CloudCapsuleMetadata {
  const item = record(value, "capsule metadata");
  exactKeys(item, [
    "id", "serializedBytes", "serializedSha256", "outerSchema", "payloadSchema", "transferSchema",
    "senderFingerprint", "recipientFingerprints", "recipientCount", "status", "reservedAt",
    "reservationExpiresAt", "finalizedAt", "deletionRequestedAt", "storageDeletedAt", "expiredAt",
  ], "capsule metadata");
  if (!Number.isSafeInteger(item.serializedBytes) || (item.serializedBytes as number) < 1 || (item.serializedBytes as number) > 64 * 1024 * 1024
    || typeof item.serializedSha256 !== "string" || !HASH_PATTERN.test(item.serializedSha256)
    || typeof item.outerSchema !== "string" || !SCHEMA_PATTERN.test(item.outerSchema)
    || typeof item.payloadSchema !== "string" || !SCHEMA_PATTERN.test(item.payloadSchema)
    || typeof item.transferSchema !== "string" || !SCHEMA_PATTERN.test(item.transferSchema)
    || typeof item.senderFingerprint !== "string" || !FINGERPRINT_PATTERN.test(item.senderFingerprint)
    || !Array.isArray(item.recipientFingerprints) || item.recipientFingerprints.length < 1 || item.recipientFingerprints.length > 32
    || item.recipientFingerprints.some((entry) => typeof entry !== "string" || !FINGERPRINT_PATTERN.test(entry))
    || !Number.isSafeInteger(item.recipientCount) || item.recipientCount !== item.recipientFingerprints.length
    || typeof item.status !== "string" || !CAPSULE_STATUSES.has(item.status)) {
    failure("Sinter Cloud returned invalid capsule metadata.");
  }
  const recipients = item.recipientFingerprints as string[];
  if (new Set(recipients).size !== recipients.length || recipients.some((entry, index) => index > 0 && recipients[index - 1]! >= entry)) {
    failure("Sinter Cloud returned invalid capsule metadata.");
  }
  return {
    id: capsuleId(item.id),
    serializedBytes: item.serializedBytes as number,
    serializedSha256: item.serializedSha256,
    outerSchema: item.outerSchema,
    payloadSchema: item.payloadSchema,
    transferSchema: item.transferSchema,
    senderFingerprint: item.senderFingerprint,
    recipientFingerprints: [...recipients],
    recipientCount: item.recipientCount as number,
    status: item.status as CloudCapsuleStatus,
    reservedAt: boundedDate(item.reservedAt, false)!,
    reservationExpiresAt: boundedDate(item.reservationExpiresAt, false)!,
    finalizedAt: boundedDate(item.finalizedAt, true),
    deletionRequestedAt: boundedDate(item.deletionRequestedAt, true),
    storageDeletedAt: boundedDate(item.storageDeletedAt, true),
    expiredAt: boundedDate(item.expiredAt, true),
  };
}

function parseSuccess(value: unknown, schema: string, keys: readonly string[]): Record<string, unknown> {
  const body = record(value, "capsule response");
  exactKeys(body, ["schema", "ok", ...keys], "capsule response");
  if (body.schema !== schema || body.ok !== true) failure("Sinter Cloud returned an unsupported capsule response.");
  return body;
}

function sameMetadata(actual: CloudCapsuleMetadata, expected: {
  id: string;
  serializedBytes: number;
  serializedSha256: string;
  senderFingerprint: string;
  recipientFingerprints: readonly string[];
}, status?: CloudCapsuleStatus): boolean {
  return actual.id === expected.id
    && actual.serializedBytes === expected.serializedBytes
    && actual.serializedSha256 === expected.serializedSha256
    && actual.outerSchema === CAPSULE_SCHEMA
    && actual.payloadSchema === CAPSULE_SESSION_PAYLOAD_SCHEMA
    && actual.transferSchema === SESSION_TRANSFER_SCHEMA
    && actual.senderFingerprint === expected.senderFingerprint
    && canonicalCapsuleJson(actual.recipientFingerprints) === canonicalCapsuleJson(expected.recipientFingerprints)
    && (status === undefined || actual.status === status);
}

function safeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    failure("The saved Sinter Cloud endpoint is invalid.");
  }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash || url.href !== `${url.origin}/`) {
    failure("The saved Sinter Cloud endpoint is invalid.");
  }
  return url.origin;
}

function safeSignedUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 16_384) failure("Sinter Cloud returned an invalid storage authorization.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    failure("Sinter Cloud returned an invalid storage authorization.");
  }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.hash || value.includes("#")) {
    failure("Sinter Cloud returned an invalid storage authorization.");
  }
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > API_RESPONSE_MAX_BYTES)) {
    try {
      await response.body?.cancel();
    } catch {}
    failure("Sinter Cloud returned an oversized capsule response.");
  }
  if (!response.body) failure("Sinter Cloud returned an invalid capsule response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > API_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        failure("Sinter Cloud returned an oversized capsule response.");
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof CloudCapsuleFailure) throw error;
    await reader.cancel().catch(() => {});
    failure("Sinter Cloud returned an invalid capsule response.");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failure("Sinter Cloud returned an invalid capsule response.");
  }
  try {
    return JSON.parse(text);
  } catch {
    failure("Sinter Cloud returned an invalid capsule response.");
  }
}

function rejectRedirect(response: Response, operation: string): void {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    failure(`Sinter Cloud refused an unexpected ${operation} redirect.`);
  }
}

function requestFailure(status: number, body: unknown): never {
  const item = record(body, "capsule error response");
  exactKeys(item, ["schema", "ok", "error"], "capsule error response");
  const detail = record(item.error, "capsule error response");
  exactKeys(detail, ["code", "message"], "capsule error response");
  if (item.schema !== CLOUD_ERROR_SCHEMA || item.ok !== false
    || typeof detail.code !== "string" || detail.code.length < 1 || detail.code.length > 80
    || typeof detail.message !== "string" || detail.message.length < 1 || detail.message.length > 200) {
    failure("Sinter Cloud returned an invalid capsule error response.");
  }
  if (status === 401) failure("Cloud session or device request proof was rejected; run `sinter login` again if needed.");
  if (status === 403) failure("Sinter Cloud denied this capsule operation.");
  if (status === 404) failure("Cloud capsule not found.");
  if (status === 409) failure("Cloud capsule state or metadata conflicts with this operation.");
  if (status === 413) failure("Cloud capsule request exceeded the service limit.");
  failure(`Sinter Cloud capsule request failed (HTTP ${status}).`);
}

async function localSigningMaterial(keys: DeviceCredentialStore): Promise<DeviceKeyMaterial> {
  let material: DeviceKeyMaterial | undefined;
  try {
    const loaded = await keys.load();
    if (loaded) material = await validateDeviceKeyMaterial(loaded);
  } catch {
    failure("Local registered device keys are invalid.");
  }
  if (!material) failure("No local registered device keys found; run `sinter devices register` first.");
  if (!material.deviceId || !UUID_PATTERN.test(material.deviceId)) {
    failure("Local device registration is not initialized; run `sinter devices register` first.");
  }
  return material;
}

export function createCloudCapsuleApiClient(options: {
  auth?: Pick<CloudAuthService, "apiSession">;
  keys?: DeviceCredentialStore;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
} = {}): CloudCapsuleApiClient {
  const auth = options.auth ?? createCloudAuthService();
  const keys = options.keys ?? createDeviceCredentialStore();
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const randomBytes = options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));

  return {
    async request(method, pathname, body) {
      const credentials = await auth.apiSession();
      if (!credentials) failure("Not logged in. Run `sinter login`.");
      const material = await localSigningMaterial(keys);
      if (!pathname.startsWith("/api/cli/capsules") || pathname.includes("?") || pathname.includes("#")) {
        failure("Invalid Cloud capsule request target.");
      }
      const bodyBytes = body === undefined
        ? new Uint8Array()
        : new TextEncoder().encode(canonicalCapsuleJson(body));
      const timestamp = now().toISOString();
      const nonce = Buffer.from(randomBytes(32)).toString("base64url");
      try {
        canonicalCapsuleRequestNonce(nonce);
      } catch {
        failure("Could not create a Cloud capsule request proof.");
      }
      const proof = {
        deviceId: material.deviceId!,
        method,
        pathname,
        bodySha256: capsuleRequestBodySha256(bodyBytes),
        timestamp,
        nonce,
      };
      const privateKey = await crypto.subtle.importKey(
        "jwk",
        material.signingPrivateKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      const signature = new Uint8Array(await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        new Uint8Array(capsuleRequestProofBytes(proof)),
      ));
      if (signature.byteLength !== 64) failure("Could not create a Cloud capsule request proof.");
      const headers = new Headers({
        Authorization: `Bearer ${credentials.accessToken}`,
        "X-Sinter-ID-Token": credentials.idToken,
        "X-Sinter-Device-ID": material.deviceId!,
        "X-Sinter-Request-Timestamp": timestamp,
        "X-Sinter-Request-Nonce": nonce,
        "X-Sinter-Request-Signature": Buffer.from(signature).toString("base64url"),
      });
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const baseUrl = safeBaseUrl(credentials.baseUrl);
      let response: Response;
      try {
        response = await request(`${baseUrl}${pathname}`, {
          method,
          headers,
          redirect: "error",
          ...(body === undefined ? {} : { body: bodyBytes }),
        });
      } catch {
        failure("Could not reach Sinter Cloud for this capsule operation.");
      }
      rejectRedirect(response, "capsule API");
      const value = await boundedJson(response);
      if (!response.ok) requestFailure(response.status, value);
      return value;
    },

    async upload(signedUrl, bytes) {
      const url = safeSignedUrl(signedUrl);
      let response: Response;
      try {
        response = await request(url, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(bytes),
          redirect: "error",
        });
      } catch {
        failure("Cloud capsule upload failed safely.");
      }
      rejectRedirect(response, "capsule upload");
      if (!response.ok) failure(`Cloud capsule upload failed (HTTP ${response.status}).`);
    },

    async download(signedUrl, expectedBytes, maximumBytes) {
      const url = safeSignedUrl(signedUrl);
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maximumBytes) {
        failure("Cloud capsule exceeds the local serialized capsule budget.");
      }
      let response: Response;
      try {
        response = await request(url, { method: "GET", redirect: "error" });
      } catch {
        failure("Cloud capsule download failed safely.");
      }
      rejectRedirect(response, "capsule download");
      if (!response.ok) failure(`Cloud capsule download failed (HTTP ${response.status}).`);
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== expectedBytes)) {
        failure("Downloaded Cloud capsule byte count does not match its metadata.");
      }
      if (!response.body) failure("Cloud capsule download returned no body.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          total += item.value.byteLength;
          if (total > expectedBytes || total > maximumBytes) {
            await reader.cancel();
            failure("Downloaded Cloud capsule exceeded its exact byte budget.");
          }
          chunks.push(item.value);
        }
      } catch (error) {
        if (error instanceof CloudCapsuleFailure) throw error;
        failure("Cloud capsule download failed safely.");
      } finally {
        reader.releaseLock();
      }
      if (total !== expectedBytes) failure("Downloaded Cloud capsule byte count does not match its metadata.");
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    },
  };
}

function exactPublicJwk(value: JsonWebKey): Record<string, unknown> {
  return { crv: value.crv, kty: value.kty, x: value.x, y: value.y };
}

function publicKeysEqual(left: JsonWebKey, right: JsonWebKey): boolean {
  return canonicalCapsuleJson(exactPublicJwk(left)) === canonicalCapsuleJson(exactPublicJwk(right));
}

function activeExactSuite(device: CloudDeviceIdentity): boolean {
  return device.suite === DEVICE_CRYPTO_SUITE
    && device.revokedAt === null
    && (device.status === undefined || device.status === "active");
}

async function verifiedActiveDevices(devices: CloudDeviceApiClient): Promise<CloudDeviceIdentity[]> {
  if (!devices.listDeviceIdentities) failure("Sinter Cloud did not provide registered device public identities.");
  let listed: CloudDeviceIdentity[];
  try {
    listed = await devices.listDeviceIdentities();
  } catch (error) {
    if (error instanceof CloudCapsuleFailure) throw error;
    failure("Could not load active Sinter Cloud device identities.");
  }
  const active = listed.filter(activeExactSuite);
  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  for (const device of active) {
    if (!UUID_PATTERN.test(device.id) || ids.has(device.id) || !FINGERPRINT_PATTERN.test(device.fingerprint)) {
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

async function activeContext(keys: DeviceCredentialStore, devices: CloudDeviceApiClient) {
  const [material, active] = await Promise.all([localSigningMaterial(keys), verifiedActiveDevices(devices)]);
  const fingerprint = await capsuleRecipientFingerprint(material.encryptionPublicKey, material.signingPublicKey);
  const local = active.find((candidate) => candidate.id === material.deviceId && candidate.fingerprint === fingerprint);
  if (!local || !publicKeysEqual(local.encryptionPublicKey, material.encryptionPublicKey)
    || !publicKeysEqual(local.signingPublicKey, material.signingPublicKey)) {
    failure("The local device is not an active exact registered device identity.");
  }
  return { material, active, local, fingerprint };
}

function selectRecipients(active: readonly CloudDeviceIdentity[], local: CloudDeviceIdentity, to: string | undefined): CloudDeviceIdentity[] {
  if (to === undefined || to === "all") {
    if (!active.some((device) => device.id === local.id)) failure("The active recipient set does not include the local device.");
    if (active.length > 32) failure("The active recipient set exceeds the capsule recipient limit.");
    return [...active];
  }
  const matches = active.filter((device) => device.id === to || device.fingerprint === to);
  if (matches.length !== 1) failure(matches.length ? "Cloud capsule recipient identifier is ambiguous." : "No active device matches the exact recipient identifier.");
  return matches;
}

function parseListResponse(value: unknown): CloudCapsuleMetadata[] {
  const body = parseSuccess(value, CLOUD_CAPSULE_LIST_SCHEMA, ["capsules"]);
  if (!Array.isArray(body.capsules) || body.capsules.length > 10_000) failure("Sinter Cloud returned an invalid capsule list.");
  const capsules = body.capsules.map(parseMetadata);
  if (capsules.some((capsule) => capsule.status !== "retained")) failure("Sinter Cloud returned an invalid capsule list.");
  return capsules;
}

function parseSingleMetadata(value: unknown, schema: string): CloudCapsuleMetadata {
  return parseMetadata(parseSuccess(value, schema, ["capsule"]).capsule);
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function createCloudCapsuleService(options: {
  api?: CloudCapsuleApiClient;
  auth?: Pick<CloudAuthService, "apiSession">;
  devices?: CloudDeviceApiClient;
  keys?: DeviceCredentialStore;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
} = {}): CloudCapsuleService {
  const keys = options.keys ?? createDeviceCredentialStore();
  const auth = options.auth ?? createCloudAuthService();
  const devices = options.devices ?? createCloudDeviceApiClient({ auth });
  const api = options.api ?? createCloudCapsuleApiClient({ auth, keys, fetch: options.fetch, now: options.now, randomBytes: options.randomBytes });

  return {
    async push(input) {
      const context = await activeContext(keys, devices);
      let transfer: SessionTransferPayloadV2;
      try {
        transfer = parseSessionTransferPayload(canonicalCapsuleJson(input.transfer));
      } catch {
        failure("Cloud push requires a canonical Sinter session transfer v2 object.");
      }
      const recipients = selectRecipients(context.active, context.local, input.to);
      let serialized: string;
      try {
        const capsule = await createSessionCapsule({
          manifest: input.manifest,
          payload: { schema: CAPSULE_SESSION_PAYLOAD_SCHEMA, synthetic: false, transfer },
          sender: {
            encryptionPublicKey: context.material.encryptionPublicKey,
            signingPublicKey: context.material.signingPublicKey,
            signingPrivateKey: context.material.signingPrivateKey,
            fingerprint: context.fingerprint,
          },
          recipients: recipients.map((recipient) => ({
            encryptionPublicKey: recipient.encryptionPublicKey,
            signingPublicKey: recipient.signingPublicKey,
            fingerprint: recipient.fingerprint,
          })),
        });
        serialized = serializeSyntheticCapsule(capsule);
      } catch {
        failure("Could not create a valid encrypted session capsule.");
      }
      const bytes = new TextEncoder().encode(serialized);
      const parsed = await parseSyntheticCapsule(serialized).catch(() => failure("Could not verify the encrypted session capsule."));
      const expected = {
        id: parsed.header.capsuleId,
        serializedBytes: bytes.byteLength,
        serializedSha256: sha256Hex(bytes),
        senderFingerprint: context.fingerprint,
        recipientFingerprints: recipients.map((recipient) => recipient.fingerprint).sort(),
      };
      const provisional: CloudCapsuleMetadata = {
        ...expected,
        outerSchema: CAPSULE_SCHEMA,
        payloadSchema: CAPSULE_SESSION_PAYLOAD_SCHEMA,
        transferSchema: SESSION_TRANSFER_SCHEMA,
        recipientFingerprints: [...expected.recipientFingerprints],
        recipientCount: expected.recipientFingerprints.length,
        status: "reserved",
        reservedAt: parsed.header.createdAt,
        reservationExpiresAt: parsed.header.createdAt,
        finalizedAt: null,
        deletionRequestedAt: null,
        storageDeletedAt: null,
        expiredAt: null,
      };
      if (input.preview) return { operation: "preview", metadata: provisional, recipientCount: recipients.length, uploaded: false };

      const reservation = parseSuccess(await safeApi("reservation", () => api.request("POST", "/api/cli/capsules", {
        schema: CLOUD_CAPSULE_RESERVE_SCHEMA,
        capsuleId: expected.id,
        serializedBytes: expected.serializedBytes,
        serializedSha256: expected.serializedSha256,
        outerSchema: CAPSULE_SCHEMA,
        payloadSchema: CAPSULE_SESSION_PAYLOAD_SCHEMA,
        transferSchema: SESSION_TRANSFER_SCHEMA,
        senderFingerprint: expected.senderFingerprint,
        recipientFingerprints: expected.recipientFingerprints,
      })), CLOUD_CAPSULE_RESERVATION_SCHEMA, ["capsule", "upload"]);
      const reserved = parseMetadata(reservation.capsule);
      if (!sameMetadata(reserved, expected, "reserved")) failure("Sinter Cloud reservation metadata did not match the encrypted capsule.");
      const upload = record(reservation.upload, "capsule upload authorization");
      exactKeys(upload, ["url", "method", "contentType"], "capsule upload authorization");
      if (upload.method !== "PUT" || upload.contentType !== "application/octet-stream") {
        failure("Sinter Cloud returned an unsupported storage authorization.");
      }
      await safeApi("upload", () => api.upload(safeSignedUrl(upload.url), bytes));
      const finalized = parseSingleMetadata(await safeApi("finalization", () => api.request("POST", `/api/cli/capsules/${expected.id}/finalize`, {
        schema: CLOUD_CAPSULE_FINALIZE_SCHEMA,
        serializedBytes: expected.serializedBytes,
        serializedSha256: expected.serializedSha256,
      })), CLOUD_CAPSULE_FINALIZATION_SCHEMA);
      if (!sameMetadata(finalized, expected, "retained") || finalized.finalizedAt === null) {
        failure("Sinter Cloud finalization metadata did not match the encrypted capsule.");
      }
      return { operation: "push", metadata: finalized, recipientCount: recipients.length, uploaded: true };
    },

    async list() {
      await activeContext(keys, devices);
      return parseListResponse(await safeApi("listing", () => api.request("GET", "/api/cli/capsules")));
    },

    async inspect(value) {
      const id = capsuleId(value);
      const context = await activeContext(keys, devices);
      const response = parseSuccess(await safeApi("download authorization", () => api.request("POST", `/api/cli/capsules/${id}/download`, {
        schema: CLOUD_CAPSULE_DOWNLOAD_REQUEST_SCHEMA,
      })), CLOUD_CAPSULE_DOWNLOAD_SCHEMA, ["capsule", "download"]);
      const metadata = parseMetadata(response.capsule);
      if (metadata.id !== id || metadata.status !== "retained" || metadata.serializedBytes > CAPSULE_MAX_SERIALIZED_BYTES
        || metadata.outerSchema !== CAPSULE_SCHEMA || metadata.payloadSchema !== CAPSULE_SESSION_PAYLOAD_SCHEMA
        || metadata.transferSchema !== SESSION_TRANSFER_SCHEMA) {
        failure("Sinter Cloud download metadata is incompatible with this CLI.");
      }
      const download = record(response.download, "capsule download authorization");
      exactKeys(download, ["url", "expiresInSeconds"], "capsule download authorization");
      if (!Number.isSafeInteger(download.expiresInSeconds) || (download.expiresInSeconds as number) < 1 || (download.expiresInSeconds as number) > 600) {
        failure("Sinter Cloud returned an invalid storage authorization.");
      }
      const bytes = await safeApi("download", () => api.download(safeSignedUrl(download.url), metadata.serializedBytes, CAPSULE_MAX_SERIALIZED_BYTES));
      if (sha256Hex(bytes) !== metadata.serializedSha256) failure("Downloaded Cloud capsule hash does not match its metadata.");
      let serialized: string;
      try {
        serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        failure("Downloaded Cloud capsule is not valid UTF-8.");
      }
      const capsule = await parseSyntheticCapsule(serialized).catch(() => failure("Downloaded Cloud capsule is not a canonical valid capsule."));
      const capsuleRecipients = capsule.recipients.map((recipient) => recipient.fingerprint);
      if (!sameMetadata(metadata, {
        id: capsule.header.capsuleId,
        serializedBytes: bytes.byteLength,
        serializedSha256: sha256Hex(bytes),
        senderFingerprint: capsule.sender.fingerprint,
        recipientFingerprints: capsuleRecipients,
      }, "retained")) {
        failure("Downloaded Cloud capsule does not match its server metadata.");
      }
      if (!capsuleRecipients.includes(context.fingerprint)) failure("This local device is not a recipient of the Cloud capsule.");
      const senders = context.active.filter((device) => device.fingerprint === capsule.sender.fingerprint);
      if (senders.length !== 1) failure("Cloud capsule sender is not a current active exact registered device.");
      let opened: Awaited<ReturnType<typeof openSessionCapsule>>;
      try {
        opened = await openSessionCapsule(serialized, {
          fingerprint: context.fingerprint,
          encryptionPrivateKey: context.material.encryptionPrivateKey,
          expectedSenderFingerprint: senders[0]!.fingerprint,
          senderSigningPublicKey: senders[0]!.signingPublicKey,
        });
      } catch {
        failure("Cloud capsule signature verification or local decryption failed.");
      }
      let transfer: SessionTransferPayloadV2;
      try {
        transfer = parseSessionTransferPayload(canonicalCapsuleJson(opened.payload.transfer));
      } catch {
        failure("Cloud capsule does not contain a valid Sinter session transfer v2 object.");
      }
      return {
        metadata,
        manifest: opened.manifest,
        transfer,
        replayKey: capsuleReplayKey(capsule, context.fingerprint),
      };
    },

    async delete(value) {
      const id = capsuleId(value);
      await activeContext(keys, devices);
      const metadata = parseSingleMetadata(await safeApi("deletion", () => api.request("DELETE", `/api/cli/capsules/${id}`)), CLOUD_CAPSULE_DELETION_SCHEMA);
      if (metadata.id !== id || metadata.status !== "deleted" || metadata.storageDeletedAt === null) {
        failure("Sinter Cloud did not confirm final capsule deletion.");
      }
      return metadata;
    },
  };
}

export function cloudCapsuleManifest(harness: CapsuleManifest["harness"], title?: string): CapsuleManifest {
  return {
    schema: CAPSULE_MANIFEST_SCHEMA,
    ...(title ? { title } : {}),
    ...(harness ? { harness } : {}),
  };
}
