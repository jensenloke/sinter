export const DEVICE_CRYPTO_SUITE = "hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256" as const;
export const DEVICE_REGISTRATION_SCHEMA = "sinter.cloud.device-registration.v1" as const;
export const DEVICE_APPROVAL_SCHEMA = "sinter.cloud.device-approval.v1" as const;

export interface DeviceKeyMaterial {
  schema: "sinter.cloud.device-keys.v1";
  suite: typeof DEVICE_CRYPTO_SUITE;
  createdAt: string;
  encryptionPublicKey: JsonWebKey;
  encryptionPrivateKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
  signingPrivateKey: JsonWebKey;
  deviceId?: string;
}

export interface DeviceRegistrationPayload {
  schema: typeof DEVICE_REGISTRATION_SCHEMA;
  name: string;
  suite: typeof DEVICE_CRYPTO_SUITE;
  encryptionPublicKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
  fingerprint: string;
  nonce: string;
}

export interface DeviceRegistrationBody extends DeviceRegistrationPayload {
  proof: string;
}

export interface DeviceApprovalMessage {
  schema: typeof DEVICE_APPROVAL_SCHEMA;
  requestId: string;
  approverDeviceId: string;
  requestFingerprint: string;
  expiresAt: string;
}

export interface DeviceApprovalBody {
  schema: typeof DEVICE_APPROVAL_SCHEMA;
  approverDeviceId: string;
  signature: string;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, child]) => child === undefined)) throw new Error("Canonical JSON does not support undefined values");
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalValue(child)}`).join(",")}}`;
  }
  throw new Error(`Canonical JSON does not support ${typeof value} values`);
}

/** Deterministic JSON with object keys sorted recursively and array order preserved. */
export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid local JWK base64url encoding");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("Invalid local JWK base64url encoding");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  bytes.set(decoded);
  return bytes;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function assertEcJwk(value: unknown, kind: "public" | "private", label: string): asserts value is JsonWebKey {
  if (!value || typeof value !== "object") throw new Error(`Invalid local ${label} JWK`);
  const jwk = value as JsonWebKey;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error(`Invalid local ${label} JWK`);
  }
  if (kind === "private" && typeof jwk.d !== "string") throw new Error(`Invalid local ${label} private JWK`);
  if (kind === "public" && jwk.d !== undefined) throw new Error(`Invalid local ${label} public JWK`);
  for (const coordinate of [jwk.x, jwk.y, ...(kind === "private" ? [jwk.d!] : [])]) {
    if (base64UrlBytes(coordinate).length !== 32) throw new Error(`Invalid local ${label} JWK coordinate`);
  }
}

function matchingPublicAndPrivate(publicKey: JsonWebKey, privateKey: JsonWebKey): boolean {
  return publicKey.kty === privateKey.kty && publicKey.crv === privateKey.crv &&
    publicKey.x === privateKey.x && publicKey.y === privateKey.y;
}

export async function validateDeviceKeyMaterial(value: unknown): Promise<DeviceKeyMaterial> {
  if (!value || typeof value !== "object") throw new Error("Invalid local device key credential");
  const keys = value as Partial<DeviceKeyMaterial>;
  if (keys.schema !== "sinter.cloud.device-keys.v1" || keys.suite !== DEVICE_CRYPTO_SUITE ||
    typeof keys.createdAt !== "string" || Number.isNaN(Date.parse(keys.createdAt)) ||
    (keys.deviceId !== undefined && (typeof keys.deviceId !== "string" || keys.deviceId.length === 0))) {
    throw new Error("Invalid local device key credential");
  }
  assertEcJwk(keys.encryptionPublicKey, "public", "encryption public key");
  assertEcJwk(keys.encryptionPrivateKey, "private", "encryption");
  assertEcJwk(keys.signingPublicKey, "public", "signing public key");
  assertEcJwk(keys.signingPrivateKey, "private", "signing");
  if (keys.encryptionPublicKey.x === keys.signingPublicKey.x &&
    keys.encryptionPublicKey.y === keys.signingPublicKey.y) {
    throw new Error("Local device encryption and signing public keys must be distinct");
  }
  if (!matchingPublicAndPrivate(keys.encryptionPublicKey, keys.encryptionPrivateKey) ||
    !matchingPublicAndPrivate(keys.signingPublicKey, keys.signingPrivateKey)) {
    throw new Error("Local device public and private keys do not match");
  }

  try {
    await Promise.all([
      crypto.subtle.importKey("jwk", keys.encryptionPublicKey, { name: "ECDH", namedCurve: "P-256" }, true, []),
      crypto.subtle.importKey("jwk", keys.encryptionPrivateKey, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
      crypto.subtle.importKey("jwk", keys.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
      crypto.subtle.importKey("jwk", keys.signingPrivateKey, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]),
    ]);
  } catch {
    throw new Error("Local device key credential contains unusable P-256 key material");
  }
  return keys as DeviceKeyMaterial;
}

export async function generateDeviceKeyMaterial(now = Date.now()): Promise<DeviceKeyMaterial> {
  const [encryption, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  ]);
  const [encryptionPublicKey, encryptionPrivateKey, signingPublicKey, signingPrivateKey] = await Promise.all([
    crypto.subtle.exportKey("jwk", encryption.publicKey),
    crypto.subtle.exportKey("jwk", encryption.privateKey),
    crypto.subtle.exportKey("jwk", signing.publicKey),
    crypto.subtle.exportKey("jwk", signing.privateKey),
  ]);
  return validateDeviceKeyMaterial({
    schema: "sinter.cloud.device-keys.v1",
    suite: DEVICE_CRYPTO_SUITE,
    createdAt: new Date(now).toISOString(),
    encryptionPublicKey,
    encryptionPrivateKey,
    signingPublicKey,
    signingPrivateKey,
  });
}

export async function deviceFingerprint(encryptionPublicKey: JsonWebKey, signingPublicKey: JsonWebKey): Promise<string> {
  const publicIdentity = (key: JsonWebKey) => ({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
  return Buffer.from(await sha256(canonicalJson({
    encryptionPublicKey: publicIdentity(encryptionPublicKey),
    signingPublicKey: publicIdentity(signingPublicKey),
  }))).toString("hex");
}

async function signCanonical(value: unknown, privateKey: JsonWebKey): Promise<string> {
  assertEcJwk(privateKey, "private", "signing");
  const key = await crypto.subtle.importKey("jwk", privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(canonicalJson(value)),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyCanonicalSignature(value: unknown, signature: string, publicKey: JsonWebKey): Promise<boolean> {
  assertEcJwk(publicKey, "public", "signing public key");
  const key = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlBytes(signature),
      new TextEncoder().encode(canonicalJson(value)),
    );
  } catch {
    return false;
  }
}

export function deviceNonce(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16) throw new Error("Device nonce must contain at least 16 random bytes");
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function createDeviceRegistrationBody(
  keys: DeviceKeyMaterial,
  name: string,
  nonce = deviceNonce(),
): Promise<DeviceRegistrationBody> {
  await validateDeviceKeyMaterial(keys);
  const payload: DeviceRegistrationPayload = {
    schema: DEVICE_REGISTRATION_SCHEMA,
    name,
    suite: DEVICE_CRYPTO_SUITE,
    encryptionPublicKey: keys.encryptionPublicKey,
    signingPublicKey: keys.signingPublicKey,
    fingerprint: await deviceFingerprint(keys.encryptionPublicKey, keys.signingPublicKey),
    nonce,
  };
  return { ...payload, proof: await signCanonical(payload, keys.signingPrivateKey) };
}

export async function createDeviceApprovalBody(
  keys: DeviceKeyMaterial,
  request: { id: string; requestFingerprint: string; expiresAt: string },
): Promise<{ body: DeviceApprovalBody; message: DeviceApprovalMessage }> {
  await validateDeviceKeyMaterial(keys);
  if (!keys.deviceId) throw new Error("This CLI has no registered device identity; run `sinter devices register` first");
  const message: DeviceApprovalMessage = {
    schema: DEVICE_APPROVAL_SCHEMA,
    requestId: request.id,
    approverDeviceId: keys.deviceId,
    requestFingerprint: request.requestFingerprint,
    expiresAt: request.expiresAt,
  };
  return {
    message,
    body: {
      schema: DEVICE_APPROVAL_SCHEMA,
      approverDeviceId: keys.deviceId,
      signature: await signCanonical(message, keys.signingPrivateKey),
    },
  };
}
