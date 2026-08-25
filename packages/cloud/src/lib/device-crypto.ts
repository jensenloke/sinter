import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

export const DEVICE_SUITE = "hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256" as const;
export const DEVICE_REGISTRATION_SCHEMA = "sinter.cloud.device-registration.v1" as const;
export const DEVICE_APPROVAL_SCHEMA = "sinter.cloud.device-approval.v1" as const;
export const DEVICE_UPDATE_SCHEMA = "sinter.cloud.device-update.v1" as const;

export interface PublicP256Jwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  use?: "enc" | "sig";
  key_ops?: [] | ["verify"];
  ext?: true;
}

export interface DeviceRegistration {
  schema: typeof DEVICE_REGISTRATION_SCHEMA;
  name: string;
  suite: typeof DEVICE_SUITE;
  encryptionPublicKey: PublicP256Jwk;
  signingPublicKey: PublicP256Jwk;
  fingerprint: string;
  nonce: string;
  proof: string;
}

export interface DeviceApproval {
  schema: typeof DEVICE_APPROVAL_SCHEMA;
  approverDeviceId: string;
  signature: string;
}

export class DeviceValidationError extends Error {
  constructor(public readonly detail: string) {
    super("Invalid device request");
    this.name = "DeviceValidationError";
  }
}

function invalid(detail: string): never {
  throw new DeviceValidationError(detail);
}

function validateUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid("String contains an unpaired surrogate");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid("String contains an unpaired surrogate");
    }
  }
}

function canonicalValue(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    validateUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("Canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") invalid("Canonical JSON contains an unsupported value");
  if (seen.has(value)) invalid("Canonical JSON cannot contain a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalValue(entry, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid("Canonical JSON requires plain objects");
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => {
      validateUnicode(key);
      return `${JSON.stringify(key)}:${canonicalValue(object[key], seen)}`;
    }).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value, new Set());
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(object: Record<string, unknown>, allowed: readonly string[], label: string) {
  const extras = Object.keys(object).filter((key) => !allowed.includes(key));
  if (extras.length > 0) invalid(`${label} contains unsupported fields`);
}

function decodeBase64Url(value: unknown, label: string, minimum: number, maximum: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    invalid(`${label} must be unpadded base64url`);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return invalid(`${label} is not valid base64url`);
  }
  if (decoded.toString("base64url") !== value || decoded.length < minimum || decoded.length > maximum) {
    invalid(`${label} has an invalid size or encoding`);
  }
  return decoded;
}

export function validatePublicP256Jwk(value: unknown, purpose: "encryption" | "signing"): PublicP256Jwk {
  const label = `${purpose} public key`;
  const jwk = objectValue(value, label);
  exactKeys(jwk, ["kty", "crv", "x", "y", "use", "key_ops", "ext"], label);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") invalid(`${label} must be an EC P-256 key`);
  decodeBase64Url(jwk.x, `${label} x`, 32, 32);
  decodeBase64Url(jwk.y, `${label} y`, 32, 32);

  const expectedUse = purpose === "encryption" ? "enc" : "sig";
  if (jwk.use !== undefined && jwk.use !== expectedUse) invalid(`${label} has an invalid use`);
  if (jwk.ext !== undefined && jwk.ext !== true) invalid(`${label} must be extractable when ext is supplied`);
  if (jwk.key_ops !== undefined) {
    const validOperations = purpose === "encryption"
      ? Array.isArray(jwk.key_ops) && jwk.key_ops.length === 0
      : Array.isArray(jwk.key_ops) && jwk.key_ops.length === 1 && jwk.key_ops[0] === "verify";
    if (!validOperations) invalid(`${label} has invalid key operations`);
  }

  const normalized: PublicP256Jwk = {
    kty: "EC",
    crv: "P-256",
    x: jwk.x as string,
    y: jwk.y as string,
  };
  if (jwk.use !== undefined) normalized.use = expectedUse;
  if (jwk.key_ops !== undefined) normalized.key_ops = purpose === "encryption" ? [] : ["verify"];
  if (jwk.ext !== undefined) normalized.ext = true;

  try {
    createPublicKey({ key: normalized, format: "jwk" });
  } catch {
    invalid(`${label} is not a valid P-256 point`);
  }
  return normalized;
}

export function deviceFingerprint(
  encryptionPublicKey: PublicP256Jwk,
  signingPublicKey: PublicP256Jwk,
): string {
  const publicIdentity = (key: PublicP256Jwk) => ({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
  return createHash("sha256").update(canonicalJson({
    encryptionPublicKey: publicIdentity(encryptionPublicKey),
    signingPublicKey: publicIdentity(signingPublicKey),
  })).digest("hex");
}

function validFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function fingerprintsEqual(left: string, right: string) {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validateName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || [...value].length > 80) {
    return invalid("Device name must contain between 1 and 80 characters");
  }
  validateUnicode(value);
  if (value !== value.trim() || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid("Device name is not canonical");
  }
  return value;
}

function verifyP256Signature(signingPublicKey: PublicP256Jwk, data: unknown, encodedSignature: unknown, label: string) {
  const signature = decodeBase64Url(encodedSignature, label, 64, 64);
  let verified = false;
  try {
    verified = verifySignature(
      "sha256",
      Buffer.from(canonicalJson(data), "utf8"),
      { key: createPublicKey({ key: signingPublicKey, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    verified = false;
  }
  if (!verified) invalid(`${label} did not verify`);
}

export function registrationProofData(registration: Omit<DeviceRegistration, "proof">) {
  return {
    schema: registration.schema,
    name: registration.name,
    suite: registration.suite,
    encryptionPublicKey: registration.encryptionPublicKey,
    signingPublicKey: registration.signingPublicKey,
    fingerprint: registration.fingerprint,
    nonce: registration.nonce,
  };
}

export function parseAndVerifyRegistration(value: unknown): DeviceRegistration {
  const body = objectValue(value, "Registration");
  exactKeys(body, [
    "schema",
    "name",
    "suite",
    "encryptionPublicKey",
    "signingPublicKey",
    "fingerprint",
    "nonce",
    "proof",
  ], "Registration");
  if (body.schema !== DEVICE_REGISTRATION_SCHEMA) invalid("Registration schema is invalid");
  if (body.suite !== DEVICE_SUITE) invalid("Device suite is invalid");

  const encryptionPublicKey = validatePublicP256Jwk(body.encryptionPublicKey, "encryption");
  const signingPublicKey = validatePublicP256Jwk(body.signingPublicKey, "signing");
  const fingerprint = body.fingerprint;
  if (!validFingerprint(fingerprint)) invalid("Device fingerprint must be lowercase hexadecimal SHA-256");
  const calculated = deviceFingerprint(encryptionPublicKey, signingPublicKey);
  if (!fingerprintsEqual(fingerprint, calculated)) invalid("Device fingerprint did not match the public keys");
  decodeBase64Url(body.nonce, "Registration nonce", 16, 64);

  const registration: DeviceRegistration = {
    schema: DEVICE_REGISTRATION_SCHEMA,
    name: validateName(body.name),
    suite: DEVICE_SUITE,
    encryptionPublicKey,
    signingPublicKey,
    fingerprint,
    nonce: body.nonce as string,
    proof: typeof body.proof === "string" ? body.proof : invalid("Registration proof is invalid"),
  };
  verifyP256Signature(
    registration.signingPublicKey,
    registrationProofData(registration),
    registration.proof,
    "Registration proof",
  );
  return registration;
}

export function parseDeviceApproval(value: unknown): DeviceApproval {
  const body = objectValue(value, "Approval");
  exactKeys(body, ["schema", "approverDeviceId", "signature"], "Approval");
  if (body.schema !== DEVICE_APPROVAL_SCHEMA) invalid("Approval schema is invalid");
  if (typeof body.approverDeviceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.approverDeviceId)) {
    invalid("Approver device ID is invalid");
  }
  decodeBase64Url(body.signature, "Approval signature", 64, 64);
  return {
    schema: DEVICE_APPROVAL_SCHEMA,
    approverDeviceId: body.approverDeviceId,
    signature: body.signature as string,
  };
}

export function approvalProofData(
  requestId: string,
  approverDeviceId: string,
  requestFingerprint: string,
  expiresAt: string,
) {
  return {
    schema: DEVICE_APPROVAL_SCHEMA,
    requestId,
    approverDeviceId,
    requestFingerprint,
    expiresAt,
  };
}

export function verifyApprovalSignature(
  signingPublicKeyValue: unknown,
  approval: DeviceApproval,
  requestId: string,
  requestFingerprint: string,
  expiresAt: string,
) {
  if (!validFingerprint(requestFingerprint)) invalid("Stored request fingerprint is invalid");
  const signingPublicKey = validatePublicP256Jwk(signingPublicKeyValue, "signing");
  verifyP256Signature(
    signingPublicKey,
    approvalProofData(requestId, approval.approverDeviceId, requestFingerprint, expiresAt),
    approval.signature,
    "Approval signature",
  );
}

export function parseDeviceUpdate(value: unknown): { name?: string; revoke?: true } {
  const body = objectValue(value, "Device update");
  if (body.action !== undefined) {
    if (body.action === "rename") {
      exactKeys(body, ["action", "name"], "Device update");
      return { name: validateName(body.name) };
    }
    if (body.action === "revoke") {
      exactKeys(body, ["action"], "Device update");
      return { revoke: true };
    }
    return invalid("Device update action is invalid");
  }

  exactKeys(body, ["schema", "name", "revoke"], "Device update");
  if (body.schema !== DEVICE_UPDATE_SCHEMA) invalid("Device update schema is invalid");
  const hasName = body.name !== undefined;
  const hasRevoke = body.revoke !== undefined;
  if (hasName === hasRevoke || (hasRevoke && body.revoke !== true)) {
    invalid("Device update must contain exactly one supported operation");
  }
  return hasName ? { name: validateName(body.name) } : { revoke: true };
}
