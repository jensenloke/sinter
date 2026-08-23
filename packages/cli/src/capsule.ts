import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { validateSession, type SifSession } from "@sinter/core";
import { TRANSFER_MODES, type TransferMode } from "./transfer";

export const CAPSULE_FORMAT = "sinter-capsule" as const;
export const CAPSULE_PAYLOAD_FORMAT = "sinter-capsule-payload" as const;
export const CAPSULE_VERSION = 1 as const;
const AAD = Buffer.from("sinter-capsule:v1", "utf8");
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export class CapsuleError extends Error {}

export interface CapsuleEnvelopeV1 {
  format: typeof CAPSULE_FORMAT;
  version: typeof CAPSULE_VERSION;
  protection: {
    cipher: "aes-256-gcm";
    kdf: "scrypt";
    salt: string;
    iv: string;
    tag: string;
  };
  payload: string;
}

export interface CapsulePayloadV1 {
  format: typeof CAPSULE_PAYLOAD_FORMAT;
  version: typeof CAPSULE_VERSION;
  createdAt: string;
  kind: "context-only";
  transferMode: TransferMode;
  session: SifSession;
}

export interface SensitiveFinding {
  category: string;
  description: string;
}

const SENSITIVE_PATTERNS: Array<{ category: string; description: string; pattern: RegExp }> = [
  { category: "private-key", description: "private key material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i },
  { category: "aws-access-key", description: "AWS access key identifier", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { category: "github-token", description: "GitHub access token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { category: "api-key", description: "provider-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { category: "bearer-token", description: "Bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i },
  {
    category: "credential-assignment",
    description: "password, API key, client secret, or access token assignment",
    pattern: /(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["']?[^\s"',}]{8,}/i,
  },
];

/** Best-effort review. Categories are returned without ever returning matched values. */
export function findSensitiveContent(session: SifSession): SensitiveFinding[] {
  const texts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      texts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string") texts.push(`${key}=${child}`);
      visit(child);
    }
  };
  visit(session);
  return SENSITIVE_PATTERNS.filter(({ pattern }) => texts.some((text) => pattern.test(text))).map(({ category, description }) => ({
    category,
    description,
  }));
}

function requirePassphrase(passphrase: string): void {
  if (passphrase.length < 12) throw new CapsuleError("capsule passphrase must be at least 12 characters");
}

function strictBase64(value: unknown, bytes: number | undefined, field: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new CapsuleError(`invalid capsule ${field}`);
  const decoded = Buffer.from(value, "base64");
  if (bytes !== undefined && decoded.length !== bytes) throw new CapsuleError(`invalid capsule ${field}`);
  return decoded;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT);
}

export function encryptCapsule(payload: CapsulePayloadV1, passphrase: string): string {
  requirePassphrase(passphrase);
  validateSession(payload.session);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const envelope: CapsuleEnvelopeV1 = {
    format: CAPSULE_FORMAT,
    version: CAPSULE_VERSION,
    protection: {
      cipher: "aes-256-gcm",
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
    payload: ciphertext.toString("base64"),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function parseEnvelope(serialized: string): CapsuleEnvelopeV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new CapsuleError("invalid capsule JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CapsuleError("invalid capsule envelope");
  const envelope = value as Partial<CapsuleEnvelopeV1>;
  if (envelope.format !== CAPSULE_FORMAT) throw new CapsuleError("not a Sinter capsule");
  if (envelope.version !== CAPSULE_VERSION) throw new CapsuleError(`unsupported capsule version: ${String(envelope.version)}`);
  if (!envelope.protection || envelope.protection.cipher !== "aes-256-gcm" || envelope.protection.kdf !== "scrypt")
    throw new CapsuleError("unsupported capsule protection");
  return envelope as CapsuleEnvelopeV1;
}

export function decryptCapsule(serialized: string, passphrase: string): CapsulePayloadV1 {
  requirePassphrase(passphrase);
  const envelope = parseEnvelope(serialized);
  const salt = strictBase64(envelope.protection.salt, 16, "salt");
  const iv = strictBase64(envelope.protection.iv, 12, "iv");
  const tag = strictBase64(envelope.protection.tag, 16, "authentication tag");
  const ciphertext = strictBase64(envelope.payload, undefined, "payload");
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new CapsuleError("cannot decrypt capsule: wrong passphrase or damaged file");
  }

  let value: unknown;
  try {
    value = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new CapsuleError("invalid encrypted capsule payload");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CapsuleError("invalid encrypted capsule payload");
  const payload = value as Partial<CapsulePayloadV1>;
  if (payload.format !== CAPSULE_PAYLOAD_FORMAT || payload.version !== CAPSULE_VERSION || payload.kind !== "context-only")
    throw new CapsuleError("unsupported encrypted capsule payload");
  if (
    !payload.createdAt ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    !payload.transferMode ||
    !TRANSFER_MODES.includes(payload.transferMode) ||
    !payload.session
  )
    throw new CapsuleError("incomplete encrypted capsule payload");
  try {
    validateSession(payload.session);
  } catch {
    throw new CapsuleError("capsule contains an invalid SIF session");
  }
  return payload as CapsulePayloadV1;
}

export function makeCapsulePayload(session: SifSession, transferMode: TransferMode, createdAt: string): CapsulePayloadV1 {
  return {
    format: CAPSULE_PAYLOAD_FORMAT,
    version: CAPSULE_VERSION,
    createdAt,
    kind: "context-only",
    transferMode,
    session,
  };
}
