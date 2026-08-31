import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { validateSession } from "./util";
import type { HarnessId, SifSession } from "./sif";

/** Capsule transport remains local-only. Payload ciphertext length remains intentionally observable. */
export const CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES = 16 * 1024 * 1024;
export const CAPSULE_MAX_RECIPIENTS = 32;
export const CAPSULE_MANIFEST_PADDED_BYTES = 4 * 1024;
export const CAPSULE_MANIFEST_CIPHERTEXT_BYTES = CAPSULE_MANIFEST_PADDED_BYTES + 16;
export const CAPSULE_MAX_MANIFEST_TITLE_BYTES = 1024;
export const CAPSULE_MAX_LINEAGE_THREAD_ID_BYTES = 1024;
export const CAPSULE_MAX_SERIALIZED_BYTES = 24 * 1024 * 1024;
export const CAPSULE_MEMORY_REPLAY_MAX_ENTRIES = 4096;

export const CAPSULE_SCHEMA = "sinter.capsule.v1" as const;
export const CAPSULE_HEADER_SCHEMA = "sinter.capsule.header.v1" as const;
export const CAPSULE_PART_SCHEMA = "sinter.capsule.part.v1" as const;
export const CAPSULE_RECIPIENT_SCHEMA = "sinter.capsule.recipient.v1" as const;
export const CAPSULE_SENDER_SCHEMA = "sinter.capsule.sender.v1" as const;
export const CAPSULE_SIGNATURE_INPUT_SCHEMA = "sinter.capsule.signature-input.v1" as const;
export const CAPSULE_MANIFEST_SCHEMA = "sinter.capsule.manifest.v1" as const;
export const CAPSULE_LINEAGE_SCHEMA = "sinter.capsule.lineage-hint.v1" as const;
export const CAPSULE_PAYLOAD_SCHEMA = "sinter.capsule.synthetic-sif.v1" as const;
export const CAPSULE_SESSION_PAYLOAD_SCHEMA = "sinter.capsule.session-transfer.v1" as const;
export const CAPSULE_AAD_SCHEMA = "sinter.capsule.aad.v1" as const;
export const CAPSULE_SUITE = "HPKE-v1-Base-DHKEM(P-256,HKDF-SHA256)-HKDF-SHA256-AES-256-GCM" as const;
export const CAPSULE_RFC9180_SUITE_IDS = Object.freeze({ mode: 0, kem: 0x0010, kdf: 0x0001, aead: 0x0002 });

const CAPSULE_ID_BYTES = 16;
const CEK_BYTES = 32;
const NONCE_BYTES = 12;
const HPKE_ENCAPSULATION_BYTES = 65;
const HPKE_WRAPPED_CEK_BYTES = CEK_BYTES + 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const harnesses = new Set<HarnessId>(["claude", "codex", "devin", "opencode", "zcode", "omp", "pi"]);
const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

export interface P256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface P256PrivateJwk extends P256PublicJwk {
  d: string;
}

export interface CapsuleStaticHeader {
  schema: typeof CAPSULE_HEADER_SCHEMA;
  capsuleId: string;
  createdAt: string;
  suite: typeof CAPSULE_SUITE;
}

export interface CapsuleCiphertextPart {
  schema: typeof CAPSULE_PART_SCHEMA;
  kind: "manifest" | "payload";
  nonce: string;
  ciphertext: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
}

export interface CapsuleRecipientEnvelope {
  schema: typeof CAPSULE_RECIPIENT_SCHEMA;
  fingerprint: string;
  encapsulation: string;
  wrappedKey: string;
}

export interface CapsuleSenderBlock {
  schema: typeof CAPSULE_SENDER_SCHEMA;
  fingerprint: string;
  encryptionPublicKey: P256PublicJwk;
  signature: string;
}

export interface SyntheticCapsule {
  schema: typeof CAPSULE_SCHEMA;
  header: CapsuleStaticHeader;
  sender: CapsuleSenderBlock;
  manifest: CapsuleCiphertextPart & { kind: "manifest" };
  payload: CapsuleCiphertextPart & { kind: "payload" };
  recipients: CapsuleRecipientEnvelope[];
}

export interface CapsuleLineageHint {
  schema: typeof CAPSULE_LINEAGE_SCHEMA;
  threadId: string;
  hop: number;
}

export interface CapsuleManifest {
  schema: typeof CAPSULE_MANIFEST_SCHEMA;
  title?: string;
  harness?: HarnessId;
  lineage?: CapsuleLineageHint;
}

export interface SyntheticCapsulePayload {
  schema: typeof CAPSULE_PAYLOAD_SCHEMA;
  synthetic: true;
  sif: SifSession;
}

export type CapsuleJsonValue = null | boolean | number | string | CapsuleJsonValue[] | CapsuleJsonObject;

export interface CapsuleJsonObject {
  [key: string]: CapsuleJsonValue;
}

export interface SessionCapsulePayload<TTransfer extends object = CapsuleJsonObject> {
  schema: typeof CAPSULE_SESSION_PAYLOAD_SCHEMA;
  synthetic: false;
  transfer: TTransfer;
}

export type SessionCapsule = SyntheticCapsule;

export interface CapsuleRecipientIdentity {
  encryptionPublicKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
  /** If supplied, it must match the Phase 1 identity fingerprint. */
  fingerprint?: string;
}

export interface CapsuleSenderIdentity {
  encryptionPublicKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
  signingPrivateKey: JsonWebKey;
  /** If supplied, it must match the Phase 1 identity fingerprint. */
  fingerprint?: string;
}

export interface CreateSyntheticCapsuleInput {
  manifest: CapsuleManifest;
  payload: SyntheticCapsulePayload;
  sender: CapsuleSenderIdentity;
  recipients: readonly CapsuleRecipientIdentity[];
}

export interface CreateSessionCapsuleInput<TTransfer extends object = CapsuleJsonObject> {
  manifest: CapsuleManifest;
  payload: SessionCapsulePayload<TTransfer>;
  sender: CapsuleSenderIdentity;
  recipients: readonly CapsuleRecipientIdentity[];
}

export interface CapsuleDecryptionIdentity {
  fingerprint: string;
  encryptionPrivateKey: JsonWebKey;
  expectedSenderFingerprint: string;
  senderSigningPublicKey: JsonWebKey;
}

export interface CapsuleReplayGuard {
  /** Atomically records a replay key, returning false if it was already present. */
  accept(replayKey: string): boolean | Promise<boolean>;
}

export interface OpenSyntheticCapsuleOptions {
  replayGuard?: CapsuleReplayGuard;
}

export interface OpenSessionCapsuleOptions {
  replayGuard?: CapsuleReplayGuard;
}

export interface OpenedSyntheticCapsule {
  manifest: CapsuleManifest;
  payload: SyntheticCapsulePayload;
}

export interface OpenedSessionCapsule {
  manifest: CapsuleManifest;
  payload: SessionCapsulePayload;
}

export class CapsuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapsuleValidationError";
  }
}

export class CapsuleReplayError extends Error {
  constructor() {
    super("Capsule replay rejected");
    this.name = "CapsuleReplayError";
  }
}

/** Process-local, nonpersistent replay protection with bounded FIFO eviction. */
export class MemoryCapsuleReplayGuard implements CapsuleReplayGuard {
  private readonly accepted = new Set<string>();

  constructor(private readonly maxEntries = CAPSULE_MEMORY_REPLAY_MAX_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) invalid("Replay guard maximum must be a positive safe integer");
  }

  accept(replayKey: string): boolean {
    if (this.accepted.has(replayKey)) return false;
    if (this.accepted.size >= this.maxEntries) this.accepted.delete(this.accepted.values().next().value!);
    this.accepted.add(replayKey);
    return true;
  }

  clear(): void {
    this.accepted.clear();
  }
}

function invalid(message: string): never {
  throw new CapsuleValidationError(message);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${label} contains unsupported fields`);
}

function validateUnicode(value: string, label: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) invalid(`${label} contains an unpaired surrogate`);
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid(`${label} contains an unpaired surrogate`);
    }
  }
}

function stringValue(value: unknown, label: string, min = 1, max = 4096): string {
  if (typeof value !== "string" || value.length < min || value.length > max) invalid(`${label} has an invalid length`);
  validateUnicode(value, label);
  return value;
}

function canonicalValue(value: unknown, seen: Set<object>, depth = 0): string {
  if (depth > 64) invalid("Canonical JSON is nested too deeply");
  if (value === null) return "null";
  if (typeof value === "string") {
    validateUnicode(value, "Canonical JSON string");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("Canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") invalid("Canonical JSON contains an unsupported value");
  if (seen.has(value)) invalid("Canonical JSON cannot contain a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item, seen, depth + 1)).join(",")}]`;
    const object = objectValue(value, "Canonical JSON value");
    return `{${Object.keys(object).sort().map((key) => {
      validateUnicode(key, "Canonical JSON key");
      return `${JSON.stringify(key)}:${canonicalValue(object[key], seen, depth + 1)}`;
    }).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Deterministic JSON used for the static header, all AAD, and plaintext encoding. */
export function canonicalCapsuleJson(value: unknown): string {
  return canonicalValue(value, new Set());
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: unknown, label: string, minimum: number, maximum: number): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) invalid(`${label} must be unpadded base64url`);
  if (value.length > Math.ceil(maximum * 4 / 3) + 1) invalid(`${label} is oversized`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || decoded.length < minimum || decoded.length > maximum) {
    invalid(`${label} has an invalid size or encoding`);
  }
  return new Uint8Array(decoded);
}

function hexSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid(`${label} must be lowercase hexadecimal SHA-256`);
  return value;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex");
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    invalid(`${label} must be a canonical UTC timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid(`${label} is invalid or noncanonical`);
  return value;
}

function fingerprintValue(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    invalid("Identity fingerprint must be lowercase hexadecimal SHA-256");
  }
  return value;
}

function compareFingerprints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function normalizeJwkShape(value: unknown, purpose: "encryption" | "signing", privateKey: boolean): P256PublicJwk | P256PrivateJwk {
  const label = `${purpose} ${privateKey ? "private" : "public"} key`;
  const jwk = objectValue(value, label);
  exactKeys(jwk, ["kty", "crv", "x", "y", ...(privateKey ? ["d"] : []), "use", "key_ops", "ext", "alg"], label);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") invalid(`${label} must be an EC P-256 JWK`);
  const x = stringValue(jwk.x, `${label} x`, 43, 43);
  const y = stringValue(jwk.y, `${label} y`, 43, 43);
  decodeBase64Url(x, `${label} x`, 32, 32);
  decodeBase64Url(y, `${label} y`, 32, 32);
  const expectedUse = purpose === "encryption" ? "enc" : "sig";
  if (jwk.use !== undefined && jwk.use !== expectedUse) invalid(`${label} has an invalid use`);
  if (jwk.ext !== undefined && jwk.ext !== true) invalid(`${label} has an invalid ext value`);
  if (jwk.alg !== undefined) invalid(`${label} must not select a JWK algorithm`);
  if (jwk.key_ops !== undefined) {
    if (!Array.isArray(jwk.key_ops) || !jwk.key_ops.every((operation) => typeof operation === "string")) {
      invalid(`${label} has invalid key operations`);
    }
    const operations = jwk.key_ops as string[];
    const valid = privateKey
      ? purpose === "encryption"
        ? operations.length > 0 && operations.every((op) => op === "deriveBits" || op === "deriveKey") && new Set(operations).size === operations.length
        : operations.length === 1 && operations[0] === "sign"
      : purpose === "encryption" ? operations.length === 0 : operations.length === 1 && operations[0] === "verify";
    if (!valid) invalid(`${label} has invalid key operations`);
  }
  if (!privateKey) {
    if ("d" in jwk) invalid(`${label} must not contain private material`);
    return { kty: "EC", crv: "P-256", x, y };
  }
  const d = stringValue(jwk.d, `${label} d`, 43, 43);
  decodeBase64Url(d, `${label} d`, 32, 32);
  return { kty: "EC", crv: "P-256", x, y, d };
}

export async function normalizeP256PublicJwk(value: unknown, purpose: "encryption" | "signing"): Promise<P256PublicJwk> {
  const normalized = normalizeJwkShape(value, purpose, false) as P256PublicJwk;
  try {
    if (purpose === "encryption") await suite.kem.importKey("jwk", normalized, true);
    else await crypto.subtle.importKey("jwk", normalized, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  } catch {
    invalid(`${purpose} public key is not a valid P-256 point`);
  }
  return normalized;
}

export async function normalizeP256EncryptionPrivateJwk(value: unknown): Promise<P256PrivateJwk> {
  const normalized = normalizeJwkShape(value, "encryption", true) as P256PrivateJwk;
  try {
    await suite.kem.importKey("jwk", normalized, false);
  } catch {
    invalid("Encryption private key is not usable P-256 key material");
  }
  return normalized;
}

async function normalizeP256SigningPrivateJwk(value: unknown): Promise<P256PrivateJwk> {
  const normalized = normalizeJwkShape(value, "signing", true) as P256PrivateJwk;
  try {
    await crypto.subtle.importKey("jwk", normalized, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  } catch {
    invalid("Signing private key is not usable P-256 key material");
  }
  return normalized;
}

function assertDistinctPublicPoints(encryption: P256PublicJwk, signing: P256PublicJwk): void {
  if (encryption.x === signing.x && encryption.y === signing.y) invalid("Encryption and signing public points must be distinct");
}

/** Phase 1 contract: SHA-256 lowercase hex over the canonical minimal public identity. */
export async function capsuleRecipientFingerprint(
  encryptionPublicKey: JsonWebKey,
  signingPublicKey: JsonWebKey,
): Promise<string> {
  const encryption = await normalizeP256PublicJwk(encryptionPublicKey, "encryption");
  const signing = await normalizeP256PublicJwk(signingPublicKey, "signing");
  assertDistinctPublicPoints(encryption, signing);
  return sha256Hex(encoder.encode(canonicalCapsuleJson({
    encryptionPublicKey: encryption,
    signingPublicKey: signing,
  })));
}

function validateHeader(value: unknown): CapsuleStaticHeader {
  const header = objectValue(value, "Capsule header");
  exactKeys(header, ["schema", "capsuleId", "createdAt", "suite"], "Capsule header");
  if (header.schema !== CAPSULE_HEADER_SCHEMA) invalid("Unsupported capsule header schema");
  if (header.suite !== CAPSULE_SUITE) invalid("Unsupported capsule crypto suite");
  const capsuleId = stringValue(header.capsuleId, "Capsule ID", 22, 22);
  decodeBase64Url(capsuleId, "Capsule ID", CAPSULE_ID_BYTES, CAPSULE_ID_BYTES);
  return {
    schema: CAPSULE_HEADER_SCHEMA,
    capsuleId,
    createdAt: canonicalTimestamp(header.createdAt, "Capsule creation time"),
    suite: CAPSULE_SUITE,
  };
}

function aadBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalCapsuleJson(value));
}

/** AAD = canonical UTF-8 JSON of {schema,header,part:{schema,kind}}. */
export function capsulePartAad(header: CapsuleStaticHeader, kind: "manifest" | "payload"): Uint8Array {
  return aadBytes({
    schema: CAPSULE_AAD_SCHEMA,
    header: validateHeader(header),
    part: { schema: CAPSULE_PART_SCHEMA, kind },
  });
}

/** HPKE info and HPKE AEAD AAD both use canonical UTF-8 JSON of {schema,header,recipient:{schema,fingerprint}}. */
export function capsuleRecipientAad(header: CapsuleStaticHeader, fingerprint: string): Uint8Array {
  return aadBytes({
    schema: CAPSULE_AAD_SCHEMA,
    header: validateHeader(header),
    recipient: { schema: CAPSULE_RECIPIENT_SCHEMA, fingerprint: fingerprintValue(fingerprint) },
  });
}

function validateJsonValue(value: unknown, label: string, seen = new Set<object>(), depth = 0): void {
  if (depth > 64) invalid(`${label} is nested too deeply`);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string") validateUnicode(value, label);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${label} contains a non-finite number`);
    return;
  }
  if (!value || typeof value !== "object") invalid(`${label} is not JSON data`);
  if (seen.has(value)) invalid(`${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) validateJsonValue(item, label, seen, depth + 1);
    } else {
      const object = objectValue(value, label);
      for (const [key, item] of Object.entries(object)) {
        validateUnicode(key, label);
        validateJsonValue(item, label, seen, depth + 1);
      }
    }
  } finally {
    seen.delete(value);
  }
}

function optionalString(value: unknown, label: string, max = 4096): void {
  if (value !== undefined) stringValue(value, label, 1, max);
}

function utf8BoundedString(value: unknown, label: string, maxBytes: number): string {
  const text = stringValue(value, label, 1, maxBytes);
  if (encoder.encode(text).length > maxBytes) invalid(`${label} exceeds its UTF-8 byte limit`);
  return text;
}

function validateUsage(value: unknown, label: string): void {
  const usage = objectValue(value, label);
  exactKeys(usage, ["input", "output", "reasoning", "cacheRead", "cacheWrite", "costUsd"], label);
  for (const [key, amount] of Object.entries(usage)) {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) invalid(`${label}.${key} is invalid`);
  }
}

function validateContentPart(value: unknown, label: string, allowed: readonly string[]): void {
  const part = objectValue(value, label);
  if (typeof part.type !== "string" || !allowed.includes(part.type)) invalid(`${label} has an invalid type`);
  switch (part.type) {
    case "text":
      exactKeys(part, ["type", "text"], label);
      stringValue(part.text, `${label}.text`, 1, CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES);
      break;
    case "thinking":
      exactKeys(part, ["type", "thinking", "signature"], label);
      stringValue(part.thinking, `${label}.thinking`, 1, CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES);
      optionalString(part.signature, `${label}.signature`);
      break;
    case "image":
      exactKeys(part, ["type", "mimeType", "data"], label);
      stringValue(part.mimeType, `${label}.mimeType`, 1, 255);
      stringValue(part.data, `${label}.data`, 1, CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES);
      break;
    case "toolCall":
      exactKeys(part, ["type", "callId", "name", "args", "intent"], label);
      stringValue(part.callId, `${label}.callId`);
      stringValue(part.name, `${label}.name`);
      if (typeof part.args === "string") stringValue(part.args, `${label}.args`, 0, CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES);
      else validateJsonValue(part.args, `${label}.args`);
      optionalString(part.intent, `${label}.intent`);
      break;
  }
}

function validateEntry(value: unknown, index: number): void {
  const label = `SIF entry ${index}`;
  const entry = objectValue(value, label);
  const base = ["kind", "id", "parentId", "ts", "origin", "raw"];
  stringValue(entry.id, `${label}.id`);
  if (entry.parentId !== null) stringValue(entry.parentId, `${label}.parentId`);
  if (entry.ts !== undefined) canonicalTimestamp(entry.ts, `${label}.ts`);
  if (entry.origin !== undefined) {
    const origin = objectValue(entry.origin, `${label}.origin`);
    exactKeys(origin, ["nativeType", "nativeId"], `${label}.origin`);
    optionalString(origin.nativeType, `${label}.origin.nativeType`);
    optionalString(origin.nativeId, `${label}.origin.nativeId`);
  }
  if (entry.raw !== undefined) validateJsonValue(entry.raw, `${label}.raw`);
  switch (entry.kind) {
    case "user":
      exactKeys(entry, [...base, "content", "synthetic"], label);
      if (entry.synthetic !== undefined && typeof entry.synthetic !== "boolean") invalid(`${label}.synthetic is invalid`);
      if (!Array.isArray(entry.content)) invalid(`${label}.content must be an array`);
      entry.content.forEach((part, i) => validateContentPart(part, `${label}.content[${i}]`, ["text", "image"]));
      break;
    case "assistant":
      exactKeys(entry, [...base, "content", "model", "usage", "stopReason"], label);
      if (!Array.isArray(entry.content)) invalid(`${label}.content must be an array`);
      entry.content.forEach((part, i) => validateContentPart(part, `${label}.content[${i}]`, ["text", "thinking", "image", "toolCall"]));
      if (entry.model !== undefined) {
        const model = objectValue(entry.model, `${label}.model`);
        exactKeys(model, ["provider", "id"], `${label}.model`);
        optionalString(model.provider, `${label}.model.provider`);
        optionalString(model.id, `${label}.model.id`);
      }
      if (entry.usage !== undefined) validateUsage(entry.usage, `${label}.usage`);
      if (entry.stopReason !== undefined && !["stop", "length", "toolUse", "error", "aborted"].includes(entry.stopReason as string)) invalid(`${label}.stopReason is invalid`);
      break;
    case "toolResult":
      exactKeys(entry, [...base, "callId", "toolName", "content", "isError"], label);
      stringValue(entry.callId, `${label}.callId`);
      stringValue(entry.toolName, `${label}.toolName`);
      if (!Array.isArray(entry.content)) invalid(`${label}.content must be an array`);
      entry.content.forEach((part, i) => validateContentPart(part, `${label}.content[${i}]`, ["text", "image"]));
      if (entry.isError !== undefined && typeof entry.isError !== "boolean") invalid(`${label}.isError is invalid`);
      break;
    case "compaction":
      exactKeys(entry, [...base, "summary", "replacedHistory"], label);
      optionalString(entry.summary, `${label}.summary`, CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES);
      if (entry.replacedHistory !== undefined) validateJsonValue(entry.replacedHistory, `${label}.replacedHistory`);
      break;
    case "modelChange":
      exactKeys(entry, [...base, "provider", "model"], label);
      optionalString(entry.provider, `${label}.provider`);
      stringValue(entry.model, `${label}.model`);
      break;
    case "subsession":
      exactKeys(entry, [...base, "sessionRef", "agentName", "resultText"], label);
      stringValue(entry.sessionRef, `${label}.sessionRef`);
      optionalString(entry.agentName, `${label}.agentName`);
      optionalString(entry.resultText, `${label}.resultText`, CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES);
      break;
    case "note":
      exactKeys(entry, [...base, "noteType", "text"], label);
      stringValue(entry.noteType, `${label}.noteType`);
      optionalString(entry.text, `${label}.text`, CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES);
      break;
    default:
      invalid(`${label} has an invalid kind`);
  }
}

function validateSif(value: unknown, depth = 0): asserts value is SifSession {
  if (depth > 16) invalid("Synthetic SIF subsessions are nested too deeply");
  const sif = objectValue(value, "Synthetic SIF");
  exactKeys(sif, ["sif", "id", "origin", "cwd", "additionalDirs", "git", "title", "createdAt", "updatedAt", "usage", "entries", "subsessions", "preserve"], "Synthetic SIF");
  if (sif.sif !== "sif/0") invalid("Synthetic SIF has an unsupported schema");
  stringValue(sif.id, "Synthetic SIF id");
  const origin = objectValue(sif.origin, "Synthetic SIF origin");
  exactKeys(origin, ["harness", "instanceId", "nativeId", "nativePath", "host"], "Synthetic SIF origin");
  if (!harnesses.has(origin.harness as HarnessId)) invalid("Synthetic SIF origin harness is invalid");
  stringValue(origin.nativeId, "Synthetic SIF origin nativeId");
  optionalString(origin.instanceId, "Synthetic SIF origin instanceId");
  optionalString(origin.nativePath, "Synthetic SIF origin nativePath", CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES);
  optionalString(origin.host, "Synthetic SIF origin host");
  if (typeof sif.cwd !== "string") invalid("Synthetic SIF cwd is invalid");
  validateUnicode(sif.cwd, "Synthetic SIF cwd");
  if (sif.additionalDirs !== undefined) {
    if (!Array.isArray(sif.additionalDirs)) invalid("Synthetic SIF additionalDirs must be an array");
    sif.additionalDirs.forEach((dir, index) => stringValue(dir, `Synthetic SIF additionalDirs[${index}]`));
  }
  if (sif.git !== undefined) {
    const git = objectValue(sif.git, "Synthetic SIF git");
    exactKeys(git, ["sha", "branch", "remote"], "Synthetic SIF git");
    optionalString(git.sha, "Synthetic SIF git.sha");
    optionalString(git.branch, "Synthetic SIF git.branch");
    optionalString(git.remote, "Synthetic SIF git.remote");
  }
  if (sif.title !== undefined) {
    const title = objectValue(sif.title, "Synthetic SIF title");
    exactKeys(title, ["text", "source"], "Synthetic SIF title");
    stringValue(title.text, "Synthetic SIF title.text", 1, 1024);
    if (!["auto", "user", "derived"].includes(title.source as string)) invalid("Synthetic SIF title.source is invalid");
  }
  if (sif.createdAt !== undefined) canonicalTimestamp(sif.createdAt, "Synthetic SIF createdAt");
  if (sif.updatedAt !== undefined) canonicalTimestamp(sif.updatedAt, "Synthetic SIF updatedAt");
  if (sif.usage !== undefined) validateUsage(sif.usage, "Synthetic SIF usage");
  if (!Array.isArray(sif.entries)) invalid("Synthetic SIF entries must be an array");
  sif.entries.forEach(validateEntry);
  if (sif.subsessions !== undefined) {
    if (!Array.isArray(sif.subsessions)) invalid("Synthetic SIF subsessions must be an array");
    sif.subsessions.forEach((child) => validateSif(child, depth + 1));
  }
  if (sif.preserve !== undefined) {
    objectValue(sif.preserve, "Synthetic SIF preserve");
    validateJsonValue(sif.preserve, "Synthetic SIF preserve");
  }
  try {
    validateSession(value as SifSession);
  } catch {
    invalid("Synthetic SIF failed structural validation");
  }
}

function validateManifest(value: unknown): CapsuleManifest {
  const manifest = objectValue(value, "Capsule manifest");
  exactKeys(manifest, ["schema", "title", "harness", "lineage"], "Capsule manifest");
  if (manifest.schema !== CAPSULE_MANIFEST_SCHEMA) invalid("Unsupported capsule manifest schema");
  const result: CapsuleManifest = { schema: CAPSULE_MANIFEST_SCHEMA };
  if (manifest.title !== undefined) result.title = utf8BoundedString(manifest.title, "Capsule manifest title", CAPSULE_MAX_MANIFEST_TITLE_BYTES);
  if (manifest.harness !== undefined) {
    if (!harnesses.has(manifest.harness as HarnessId)) invalid("Capsule manifest harness is invalid");
    result.harness = manifest.harness as HarnessId;
  }
  if (manifest.lineage !== undefined) {
    const lineage = objectValue(manifest.lineage, "Capsule manifest lineage");
    exactKeys(lineage, ["schema", "threadId", "hop"], "Capsule manifest lineage");
    if (lineage.schema !== CAPSULE_LINEAGE_SCHEMA) invalid("Unsupported capsule lineage schema");
    if (!Number.isSafeInteger(lineage.hop) || (lineage.hop as number) < 0) invalid("Capsule manifest lineage hop is invalid");
    result.lineage = {
      schema: CAPSULE_LINEAGE_SCHEMA,
      threadId: utf8BoundedString(lineage.threadId, "Capsule manifest lineage threadId", CAPSULE_MAX_LINEAGE_THREAD_ID_BYTES),
      hop: lineage.hop as number,
    };
  }
  return result;
}

function validateSyntheticPayload(value: unknown): SyntheticCapsulePayload {
  const payload = objectValue(value, "Capsule payload");
  if (payload.schema !== CAPSULE_PAYLOAD_SCHEMA || payload.synthetic !== true) invalid("Unsupported or nonsynthetic capsule payload");
  exactKeys(payload, ["schema", "synthetic", "sif"], "Capsule payload");
  validateSif(payload.sif);
  return { schema: CAPSULE_PAYLOAD_SCHEMA, synthetic: true, sif: payload.sif };
}

function validateSessionPayload(value: unknown): SessionCapsulePayload {
  const payload = objectValue(value, "Capsule payload");
  if (payload.schema !== CAPSULE_SESSION_PAYLOAD_SCHEMA || payload.synthetic !== false) invalid("Unsupported or synthetic capsule payload");
  exactKeys(payload, ["schema", "synthetic", "transfer"], "Capsule payload");
  const transfer = objectValue(payload.transfer, "Session capsule transfer");
  validateJsonValue(transfer, "Session capsule transfer");
  return { schema: CAPSULE_SESSION_PAYLOAD_SCHEMA, synthetic: false, transfer: transfer as CapsuleJsonObject };
}

function secureRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function preparedRecipients(recipients: readonly CapsuleRecipientIdentity[]): Promise<Array<{
  fingerprint: string;
  encryptionPublicKey: P256PublicJwk;
}>> {
  if (!Array.isArray(recipients) || recipients.length < 1) invalid("Capsule requires at least one recipient");
  if (recipients.length > CAPSULE_MAX_RECIPIENTS) invalid("Capsule has too many recipients");
  const prepared = await Promise.all(recipients.map(async (recipient, index) => {
    const value = objectValue(recipient, `Recipient ${index}`);
    exactKeys(value, ["encryptionPublicKey", "signingPublicKey", "fingerprint"], `Recipient ${index}`);
    const encryptionPublicKey = await normalizeP256PublicJwk(value.encryptionPublicKey, "encryption");
    const signingPublicKey = await normalizeP256PublicJwk(value.signingPublicKey, "signing");
    const fingerprint = await capsuleRecipientFingerprint(encryptionPublicKey, signingPublicKey);
    if (value.fingerprint !== undefined && fingerprintValue(value.fingerprint) !== fingerprint) invalid(`Recipient ${index} fingerprint does not match its public identity`);
    return { fingerprint, encryptionPublicKey };
  }));
  prepared.sort((left, right) => compareFingerprints(left.fingerprint, right.fingerprint));
  for (let i = 1; i < prepared.length; i += 1) {
    if (prepared[i - 1]!.fingerprint === prepared[i]!.fingerprint) invalid("Capsule contains duplicate recipient fingerprints");
  }
  return prepared;
}

async function preparedSender(value: CapsuleSenderIdentity): Promise<{
  fingerprint: string;
  encryptionPublicKey: P256PublicJwk;
  signingPublicKey: P256PublicJwk;
  signingPrivateKey: P256PrivateJwk;
}> {
  const sender = objectValue(value, "Sender");
  exactKeys(sender, ["encryptionPublicKey", "signingPublicKey", "signingPrivateKey", "fingerprint"], "Sender");
  const encryptionPublicKey = await normalizeP256PublicJwk(sender.encryptionPublicKey, "encryption");
  const signingPublicKey = await normalizeP256PublicJwk(sender.signingPublicKey, "signing");
  assertDistinctPublicPoints(encryptionPublicKey, signingPublicKey);
  const signingPrivateKey = await normalizeP256SigningPrivateJwk(sender.signingPrivateKey);
  if (signingPrivateKey.x !== signingPublicKey.x || signingPrivateKey.y !== signingPublicKey.y) {
    invalid("Sender signing private key does not match its signing public key");
  }
  const fingerprint = await capsuleRecipientFingerprint(encryptionPublicKey, signingPublicKey);
  if (sender.fingerprint !== undefined && fingerprintValue(sender.fingerprint) !== fingerprint) {
    invalid("Sender fingerprint does not match its public identity");
  }
  return { fingerprint, encryptionPublicKey, signingPublicKey, signingPrivateKey };
}

async function encryptPart(
  kind: "manifest" | "payload",
  plaintext: Uint8Array,
  cek: Uint8Array,
  nonce: Uint8Array,
  header: CapsuleStaticHeader,
): Promise<CapsuleCiphertextPart> {
  const context = suite.aead.createEncryptionContext(cek);
  const ciphertext = new Uint8Array(await context.seal(nonce, plaintext, capsulePartAad(header, kind)));
  return {
    schema: CAPSULE_PART_SCHEMA,
    kind,
    nonce: base64Url(nonce),
    ciphertext: base64Url(ciphertext),
    ciphertextBytes: ciphertext.length,
    ciphertextSha256: await sha256Hex(ciphertext),
  };
}

function signaturePartMetadata(part: CapsuleCiphertextPart): Omit<CapsuleCiphertextPart, "ciphertext"> {
  return {
    schema: part.schema,
    kind: part.kind,
    nonce: part.nonce,
    ciphertextBytes: part.ciphertextBytes,
    ciphertextSha256: part.ciphertextSha256,
  };
}

/** Canonical signed bytes bind sender identity, static header, part metadata, and exact sorted membership. */
export function capsuleSignatureInput(capsule: Pick<SyntheticCapsule, "header" | "sender" | "manifest" | "payload" | "recipients">): Uint8Array {
  return encoder.encode(canonicalCapsuleJson({
    schema: CAPSULE_SIGNATURE_INPUT_SCHEMA,
    sender: {
      schema: capsule.sender.schema,
      fingerprint: capsule.sender.fingerprint,
      encryptionPublicKey: capsule.sender.encryptionPublicKey,
    },
    header: capsule.header,
    manifest: signaturePartMetadata(capsule.manifest),
    payload: signaturePartMetadata(capsule.payload),
    recipientFingerprints: capsule.recipients.map((recipient) => recipient.fingerprint),
  }));
}

function paddedManifestPlaintext(manifest: CapsuleManifest): Uint8Array {
  const json = encoder.encode(canonicalCapsuleJson(manifest));
  if (json.length > CAPSULE_MANIFEST_PADDED_BYTES - 4) invalid("Capsule manifest exceeds its padded envelope");
  const padded = secureRandomBytes(CAPSULE_MANIFEST_PADDED_BYTES);
  new DataView(padded.buffer, padded.byteOffset, padded.byteLength).setUint32(0, json.length);
  padded.set(json, 4);
  return padded;
}

async function createCapsule(
  input: { manifest: CapsuleManifest; payload: unknown; sender: CapsuleSenderIdentity; recipients: readonly CapsuleRecipientIdentity[] },
  validatePayload: (value: unknown) => SyntheticCapsulePayload | SessionCapsulePayload,
): Promise<SyntheticCapsule> {
  const manifest = validateManifest(input.manifest);
  const payload = validatePayload(input.payload);
  const [senderIdentity, recipients] = await Promise.all([preparedSender(input.sender), preparedRecipients(input.recipients)]);
  const createdAt = new Date().toISOString();
  canonicalTimestamp(createdAt, "Capsule creation time");
  const capsuleId = base64Url(secureRandomBytes(CAPSULE_ID_BYTES));
  const header: CapsuleStaticHeader = { schema: CAPSULE_HEADER_SCHEMA, capsuleId, createdAt, suite: CAPSULE_SUITE };

  const manifestPlaintext = paddedManifestPlaintext(manifest);
  const payloadPlaintext = encoder.encode(canonicalCapsuleJson(payload));
  if (CAPSULE_MANIFEST_CIPHERTEXT_BYTES + payloadPlaintext.length + 16 > CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES) {
    invalid("Capsule combined ciphertext would exceed the provisional limit");
  }

  const cek = secureRandomBytes(CEK_BYTES);
  try {
    const manifestNonce = secureRandomBytes(NONCE_BYTES);
    const payloadNonce = secureRandomBytes(NONCE_BYTES);
    if (equalBytes(manifestNonce, payloadNonce)) invalid("Capsule manifest and payload nonces must be distinct");
    const [manifestPart, payloadPart] = await Promise.all([
      encryptPart("manifest", manifestPlaintext, cek, manifestNonce, header),
      encryptPart("payload", payloadPlaintext, cek, payloadNonce, header),
    ]);

    const envelopes: CapsuleRecipientEnvelope[] = [];
    for (const recipient of recipients) {
      const publicKey = await suite.kem.importKey("jwk", recipient.encryptionPublicKey, true);
      const aad = capsuleRecipientAad(header, recipient.fingerprint);
      const context = await suite.createSenderContext({ recipientPublicKey: publicKey, info: aad });
      const wrappedKey = new Uint8Array(await context.seal(cek, aad));
      envelopes.push({
        schema: CAPSULE_RECIPIENT_SCHEMA,
        fingerprint: recipient.fingerprint,
        encapsulation: base64Url(new Uint8Array(context.enc)),
        wrappedKey: base64Url(wrappedKey),
      });
    }

    const capsule: SyntheticCapsule = {
      schema: CAPSULE_SCHEMA,
      header,
      sender: {
        schema: CAPSULE_SENDER_SCHEMA,
        fingerprint: senderIdentity.fingerprint,
        encryptionPublicKey: senderIdentity.encryptionPublicKey,
        signature: "",
      },
      manifest: manifestPart as SyntheticCapsule["manifest"],
      payload: payloadPart as SyntheticCapsule["payload"],
      recipients: envelopes,
    };
    const signingKey = await crypto.subtle.importKey(
      "jwk",
      senderIdentity.signingPrivateKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      new Uint8Array(capsuleSignatureInput(capsule)),
    ));
    if (signature.length !== 64) invalid("Sender signature is not IEEE-P1363 P-256 format");
    capsule.sender.signature = base64Url(signature);
    return capsule;
  } finally {
    cek.fill(0);
  }
}

export async function createSyntheticCapsule(input: CreateSyntheticCapsuleInput): Promise<SyntheticCapsule> {
  return createCapsule(input, validateSyntheticPayload);
}

export async function createSessionCapsule<TTransfer extends object>(input: CreateSessionCapsuleInput<TTransfer>): Promise<SessionCapsule> {
  return createCapsule(input, validateSessionPayload);
}

function validatePart(value: unknown, expectedKind: "manifest" | "payload"): { part: CapsuleCiphertextPart; bytes: Uint8Array } {
  const label = `Capsule ${expectedKind} part`;
  const part = objectValue(value, label);
  exactKeys(part, ["schema", "kind", "nonce", "ciphertext", "ciphertextBytes", "ciphertextSha256"], label);
  if (part.schema !== CAPSULE_PART_SCHEMA) invalid(`Unsupported capsule ${expectedKind} part schema`);
  if (part.kind !== expectedKind) invalid(`Capsule ${expectedKind} part kind is invalid`);
  const nonce = stringValue(part.nonce, `${label} nonce`, 16, 16);
  decodeBase64Url(nonce, `${label} nonce`, NONCE_BYTES, NONCE_BYTES);
  const maximum = expectedKind === "manifest" ? CAPSULE_MANIFEST_CIPHERTEXT_BYTES : CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES;
  if (!Number.isSafeInteger(part.ciphertextBytes) || (part.ciphertextBytes as number) < 16 || (part.ciphertextBytes as number) > maximum) {
    invalid(`${label} byte count is invalid`);
  }
  if (expectedKind === "manifest" && part.ciphertextBytes !== CAPSULE_MANIFEST_CIPHERTEXT_BYTES) {
    invalid("Capsule manifest ciphertext must use the fixed padded size");
  }
  const ciphertext = decodeBase64Url(part.ciphertext, `${label} ciphertext`, 16, maximum);
  if (ciphertext.length !== part.ciphertextBytes) invalid(`${label} byte count does not match its ciphertext`);
  return {
    part: {
      schema: CAPSULE_PART_SCHEMA,
      kind: expectedKind,
      nonce,
      ciphertext: part.ciphertext as string,
      ciphertextBytes: ciphertext.length,
      ciphertextSha256: hexSha256(part.ciphertextSha256, `${label} hash`),
    },
    bytes: ciphertext,
  };
}

function validateEnvelope(value: unknown, index: number): CapsuleRecipientEnvelope {
  const label = `Recipient envelope ${index}`;
  const envelope = objectValue(value, label);
  exactKeys(envelope, ["schema", "fingerprint", "encapsulation", "wrappedKey"], label);
  if (envelope.schema !== CAPSULE_RECIPIENT_SCHEMA) invalid("Unsupported recipient envelope schema");
  const encapsulation = stringValue(envelope.encapsulation, `${label} encapsulation`, 87, 87);
  const wrappedKey = stringValue(envelope.wrappedKey, `${label} wrapped key`, 64, 64);
  decodeBase64Url(encapsulation, `${label} encapsulation`, HPKE_ENCAPSULATION_BYTES, HPKE_ENCAPSULATION_BYTES);
  decodeBase64Url(wrappedKey, `${label} wrapped key`, HPKE_WRAPPED_CEK_BYTES, HPKE_WRAPPED_CEK_BYTES);
  return {
    schema: CAPSULE_RECIPIENT_SCHEMA,
    fingerprint: fingerprintValue(envelope.fingerprint),
    encapsulation,
    wrappedKey,
  };
}

async function validateSenderBlock(value: unknown): Promise<{ sender: CapsuleSenderBlock; signatureBytes: Uint8Array }> {
  const sender = objectValue(value, "Capsule sender");
  exactKeys(sender, ["schema", "fingerprint", "encryptionPublicKey", "signature"], "Capsule sender");
  if (sender.schema !== CAPSULE_SENDER_SCHEMA) invalid("Unsupported capsule sender schema");
  const signature = stringValue(sender.signature, "Capsule sender signature", 86, 86);
  const signatureBytes = decodeBase64Url(signature, "Capsule sender signature", 64, 64);
  return {
    sender: {
      schema: CAPSULE_SENDER_SCHEMA,
      fingerprint: fingerprintValue(sender.fingerprint),
      encryptionPublicKey: await normalizeP256PublicJwk(sender.encryptionPublicKey, "encryption"),
      signature,
    },
    signatureBytes,
  };
}

type ParsedCapsule = {
  capsule: SyntheticCapsule;
  manifestBytes: Uint8Array;
  payloadBytes: Uint8Array;
  signatureBytes: Uint8Array;
};

async function parseCapsuleValue(
  value: unknown,
  enforceCanonicalRecipientOrder = true,
  serializedBudgetChecked = false,
): Promise<ParsedCapsule> {
  if (!serializedBudgetChecked) {
    const serializedEquivalent = encoder.encode(canonicalCapsuleJson(value)).length;
    if (serializedEquivalent > CAPSULE_MAX_SERIALIZED_BYTES) invalid("Capsule object exceeds its serialized-equivalent budget");
  }
  const capsule = objectValue(value, "Capsule");
  exactKeys(capsule, ["schema", "header", "sender", "manifest", "payload", "recipients"], "Capsule");
  if (capsule.schema !== CAPSULE_SCHEMA) invalid("Unsupported capsule schema");
  const header = validateHeader(capsule.header);
  const sender = await validateSenderBlock(capsule.sender);
  const manifest = validatePart(capsule.manifest, "manifest");
  const payload = validatePart(capsule.payload, "payload");
  if (manifest.part.nonce === payload.part.nonce) invalid("Capsule manifest and payload nonces must be distinct");
  if (manifest.bytes.length + payload.bytes.length > CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES) invalid("Capsule combined ciphertext is oversized");
  if (!Array.isArray(capsule.recipients) || capsule.recipients.length < 1) invalid("Capsule has no recipient envelopes");
  if (capsule.recipients.length > CAPSULE_MAX_RECIPIENTS) invalid("Capsule has too many recipient envelopes");
  const recipients = capsule.recipients.map(validateEnvelope);
  for (let index = 1; index < recipients.length; index += 1) {
    const order = compareFingerprints(recipients[index - 1]!.fingerprint, recipients[index]!.fingerprint);
    if (order === 0) invalid("Capsule contains duplicate recipient fingerprints");
    if (enforceCanonicalRecipientOrder && order > 0) invalid("Capsule recipient envelopes are not canonically sorted");
  }
  const decodedBytes = manifest.bytes.length + payload.bytes.length + sender.signatureBytes.length
    + recipients.length * (HPKE_ENCAPSULATION_BYTES + HPKE_WRAPPED_CEK_BYTES);
  if (decodedBytes > CAPSULE_MAX_SERIALIZED_BYTES) invalid("Capsule object exceeds its decoded-byte budget");
  const [manifestHash, payloadHash] = await Promise.all([sha256Hex(manifest.bytes), sha256Hex(payload.bytes)]);
  if (manifestHash !== manifest.part.ciphertextSha256) invalid("Capsule manifest ciphertext hash mismatch");
  if (payloadHash !== payload.part.ciphertextSha256) invalid("Capsule payload ciphertext hash mismatch");
  return {
    capsule: {
      schema: CAPSULE_SCHEMA,
      header,
      sender: sender.sender,
      manifest: manifest.part as SyntheticCapsule["manifest"],
      payload: payload.part as SyntheticCapsule["payload"],
      recipients,
    },
    manifestBytes: manifest.bytes,
    payloadBytes: payload.bytes,
    signatureBytes: sender.signatureBytes,
  };
}

async function parseCapsuleInput(value: string | unknown, enforceCanonicalRecipientOrder = true): Promise<ParsedCapsule> {
  if (typeof value !== "string") return parseCapsuleValue(value, enforceCanonicalRecipientOrder);
  if (Buffer.byteLength(value, "utf8") > CAPSULE_MAX_SERIALIZED_BYTES) invalid("Serialized capsule is oversized");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid("Serialized capsule is malformed JSON");
  }
  if (canonicalCapsuleJson(parsed) !== value) invalid("Serialized capsule is not canonical JSON");
  return parseCapsuleValue(parsed, enforceCanonicalRecipientOrder, true);
}

export async function parseSyntheticCapsule(value: string | unknown): Promise<SyntheticCapsule> {
  return (await parseCapsuleInput(value)).capsule;
}

export function serializeSyntheticCapsule(capsule: SyntheticCapsule): string {
  return canonicalCapsuleJson(capsule);
}

function parseCanonicalPlaintext(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    invalid(`${label} plaintext is not valid UTF-8`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid(`${label} plaintext is not valid JSON`);
  }
  if (canonicalCapsuleJson(value) !== text) invalid(`${label} plaintext is not canonical JSON`);
  return value;
}

function parsePaddedManifest(bytes: Uint8Array): CapsuleManifest {
  if (bytes.length !== CAPSULE_MANIFEST_PADDED_BYTES) invalid("Capsule manifest padded plaintext has an invalid size");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (length < 1 || length > CAPSULE_MANIFEST_PADDED_BYTES - 4) invalid("Capsule manifest padding envelope has an invalid length");
  return validateManifest(parseCanonicalPlaintext(bytes.subarray(4, 4 + length), "Capsule manifest"));
}

function assertCanonicalRecipientOrder(recipients: readonly CapsuleRecipientEnvelope[]): void {
  for (let index = 1; index < recipients.length; index += 1) {
    if (compareFingerprints(recipients[index - 1]!.fingerprint, recipients[index]!.fingerprint) > 0) {
      invalid("Capsule recipient envelopes are not canonically sorted");
    }
  }
}

async function verifySender(parsed: ParsedCapsule, identity: CapsuleDecryptionIdentity): Promise<void> {
  const expected = fingerprintValue(identity.expectedSenderFingerprint);
  if (parsed.capsule.sender.fingerprint !== expected) invalid("Capsule sender fingerprint does not match the expected sender");
  const signingPublicKey = await normalizeP256PublicJwk(identity.senderSigningPublicKey, "signing");
  const derived = await capsuleRecipientFingerprint(parsed.capsule.sender.encryptionPublicKey, signingPublicKey);
  if (derived !== expected) invalid("Capsule sender key does not match the expected sender fingerprint");
  const key = await crypto.subtle.importKey(
    "jwk",
    signingPublicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new Uint8Array(parsed.signatureBytes),
    new Uint8Array(capsuleSignatureInput(parsed.capsule)),
  );
  if (!valid) invalid("Capsule sender signature verification failed");
}

export function capsuleReplayKey(
  capsule: Pick<SyntheticCapsule, "header" | "manifest" | "payload">,
  openerFingerprint: string,
): string {
  return `${fingerprintValue(openerFingerprint)}:${capsule.header.capsuleId}:${capsule.manifest.ciphertextSha256}:${capsule.payload.ciphertextSha256}`;
}

async function openCapsule<TPayload extends SyntheticCapsulePayload | SessionCapsulePayload>(
  value: string | unknown,
  identity: CapsuleDecryptionIdentity,
  options: OpenSyntheticCapsuleOptions | OpenSessionCapsuleOptions,
  validatePayload: (value: unknown) => TPayload,
): Promise<{ manifest: CapsuleManifest; payload: TPayload }> {
  const parsed = await parseCapsuleInput(value, false);
  await verifySender(parsed, identity);
  assertCanonicalRecipientOrder(parsed.capsule.recipients);
  const expectedFingerprint = fingerprintValue(identity.fingerprint);
  const envelope = parsed.capsule.recipients.find((recipient) => recipient.fingerprint === expectedFingerprint);
  if (!envelope) invalid("Capsule has no envelope for the expected recipient");
  const privateJwk = await normalizeP256EncryptionPrivateJwk(identity.encryptionPrivateKey);
  const privateKey = await suite.kem.importKey("jwk", privateJwk, false);
  const recipientAad = capsuleRecipientAad(parsed.capsule.header, expectedFingerprint);
  let cek: Uint8Array;
  try {
    const recipient = await suite.createRecipientContext({
      recipientKey: privateKey,
      enc: decodeBase64Url(envelope.encapsulation, "HPKE encapsulation", HPKE_ENCAPSULATION_BYTES, HPKE_ENCAPSULATION_BYTES),
      info: recipientAad,
    });
    cek = new Uint8Array(await recipient.open(
      decodeBase64Url(envelope.wrappedKey, "HPKE wrapped key", HPKE_WRAPPED_CEK_BYTES, HPKE_WRAPPED_CEK_BYTES),
      recipientAad,
    ));
  } catch {
    invalid("Capsule recipient key unwrap failed");
  }
  if (cek.length !== CEK_BYTES) {
    cek.fill(0);
    invalid("Capsule unwrapped content key has an invalid size");
  }

  try {
    const decryptPart = async (part: CapsuleCiphertextPart, ciphertext: Uint8Array): Promise<Uint8Array> => {
      try {
        const context = suite.aead.createEncryptionContext(cek);
        return new Uint8Array(await context.open(
          decodeBase64Url(part.nonce, `${part.kind} nonce`, NONCE_BYTES, NONCE_BYTES),
          ciphertext,
          capsulePartAad(parsed.capsule.header, part.kind),
        ));
      } catch {
        invalid(`Capsule ${part.kind} authentication failed`);
      }
    };

    const [manifestPlaintext, payloadPlaintext] = await Promise.all([
      decryptPart(parsed.capsule.manifest, parsed.manifestBytes),
      decryptPart(parsed.capsule.payload, parsed.payloadBytes),
    ]);
    const manifest = parsePaddedManifest(manifestPlaintext);
    const payload = validatePayload(parseCanonicalPlaintext(payloadPlaintext, "Capsule payload"));

    if (options.replayGuard && !await options.replayGuard.accept(capsuleReplayKey(parsed.capsule, expectedFingerprint))) {
      throw new CapsuleReplayError();
    }
    return { manifest, payload };
  } finally {
    cek.fill(0);
  }
}

export async function openSyntheticCapsule(
  value: string | unknown,
  identity: CapsuleDecryptionIdentity,
  options: OpenSyntheticCapsuleOptions = {},
): Promise<OpenedSyntheticCapsule> {
  return openCapsule(value, identity, options, validateSyntheticPayload);
}

export async function openSessionCapsule(
  value: string | unknown,
  identity: CapsuleDecryptionIdentity,
  options: OpenSessionCapsuleOptions = {},
): Promise<OpenedSessionCapsule> {
  return openCapsule(value, identity, options, validateSessionPayload);
}
