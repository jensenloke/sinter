import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { validateSession } from "./util";
import type { HarnessId, SifSession } from "./sif";

/** C2 is local-only and synthetic-only. These limits are provisional. */
export const CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES = 16 * 1024 * 1024;
export const CAPSULE_MAX_RECIPIENTS = 32;
export const CAPSULE_MAX_MANIFEST_PLAINTEXT_BYTES = 64 * 1024;
export const CAPSULE_MAX_SERIALIZED_BYTES = 24 * 1024 * 1024;

export const CAPSULE_SCHEMA = "sinter.capsule.v1" as const;
export const CAPSULE_HEADER_SCHEMA = "sinter.capsule.header.v1" as const;
export const CAPSULE_PART_SCHEMA = "sinter.capsule.part.v1" as const;
export const CAPSULE_RECIPIENT_SCHEMA = "sinter.capsule.recipient.v1" as const;
export const CAPSULE_MANIFEST_SCHEMA = "sinter.capsule.manifest.v1" as const;
export const CAPSULE_LINEAGE_SCHEMA = "sinter.capsule.lineage-hint.v1" as const;
export const CAPSULE_PAYLOAD_SCHEMA = "sinter.capsule.synthetic-sif.v1" as const;
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

export interface SyntheticCapsule {
  schema: typeof CAPSULE_SCHEMA;
  header: CapsuleStaticHeader;
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

export interface CapsuleRecipientIdentity {
  encryptionPublicKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
  /** If supplied, it must match the Phase 1 identity fingerprint. */
  fingerprint?: string;
}

export interface CreateSyntheticCapsuleInput {
  manifest: CapsuleManifest;
  payload: SyntheticCapsulePayload;
  recipients: readonly CapsuleRecipientIdentity[];
}

/** Explicitly test-only injection points. Normal callers omit this argument. */
export interface CapsuleTestOverrides {
  randomBytes?: (length: number) => Uint8Array;
  now?: () => Date;
  capsuleId?: string;
  hpkeEphemeralKeyMaterial?: (fingerprint: string, index: number) => Uint8Array;
}

export interface CapsuleDecryptionIdentity {
  fingerprint: string;
  encryptionPrivateKey: JsonWebKey;
}

export interface CapsuleReplayGuard {
  /** Atomically records a replay key, returning false if it was already present. */
  accept(replayKey: string): boolean | Promise<boolean>;
}

export interface OpenSyntheticCapsuleOptions {
  replayGuard?: CapsuleReplayGuard;
}

export interface OpenedSyntheticCapsule {
  manifest: CapsuleManifest;
  payload: SyntheticCapsulePayload;
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

export class MemoryCapsuleReplayGuard implements CapsuleReplayGuard {
  private readonly accepted = new Set<string>();

  accept(replayKey: string): boolean {
    if (this.accepted.has(replayKey)) return false;
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
      if (next < 0xdc00 || next > 0xdfff) invalid(`${label} contains an unpaired surrogate`);
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

function canonicalValue(value: unknown, seen: Set<object>): string {
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
    if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item, seen)).join(",")}]`;
    const object = objectValue(value, "Canonical JSON value");
    return `{${Object.keys(object).sort().map((key) => {
      validateUnicode(key, "Canonical JSON key");
      return `${JSON.stringify(key)}:${canonicalValue(object[key], seen)}`;
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
    invalid("Recipient fingerprint must be lowercase hexadecimal SHA-256");
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
      ? purpose === "encryption" && operations.length > 0 && operations.every((op) => op === "deriveBits" || op === "deriveKey") && new Set(operations).size === operations.length
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

/** Phase 1 contract: SHA-256 lowercase hex over the canonical minimal public identity. */
export async function capsuleRecipientFingerprint(
  encryptionPublicKey: JsonWebKey,
  signingPublicKey: JsonWebKey,
): Promise<string> {
  const encryption = await normalizeP256PublicJwk(encryptionPublicKey, "encryption");
  const signing = await normalizeP256PublicJwk(signingPublicKey, "signing");
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
  if (manifest.title !== undefined) result.title = stringValue(manifest.title, "Capsule manifest title", 1, 1024);
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
      threadId: stringValue(lineage.threadId, "Capsule manifest lineage threadId"),
      hop: lineage.hop as number,
    };
  }
  return result;
}

function validatePayload(value: unknown): SyntheticCapsulePayload {
  const payload = objectValue(value, "Capsule payload");
  exactKeys(payload, ["schema", "synthetic", "sif"], "Capsule payload");
  if (payload.schema !== CAPSULE_PAYLOAD_SCHEMA || payload.synthetic !== true) invalid("Unsupported or nonsynthetic capsule payload");
  validateSif(payload.sif);
  return { schema: CAPSULE_PAYLOAD_SCHEMA, synthetic: true, sif: payload.sif };
}

function secureRandomBytes(length: number, source?: (length: number) => Uint8Array): Uint8Array {
  const bytes = source ? source(length) : crypto.getRandomValues(new Uint8Array(length));
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) invalid(`Random byte source must return exactly ${length} bytes`);
  return new Uint8Array(bytes);
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

export async function createSyntheticCapsule(
  input: CreateSyntheticCapsuleInput,
  unsafeTestOnly: CapsuleTestOverrides = {},
): Promise<SyntheticCapsule> {
  const manifest = validateManifest(input.manifest);
  const payload = validatePayload(input.payload);
  const recipients = await preparedRecipients(input.recipients);
  const createdAt = (unsafeTestOnly.now?.() ?? new Date()).toISOString();
  canonicalTimestamp(createdAt, "Capsule creation time");
  const capsuleId = unsafeTestOnly.capsuleId ?? base64Url(secureRandomBytes(CAPSULE_ID_BYTES, unsafeTestOnly.randomBytes));
  decodeBase64Url(capsuleId, "Capsule ID", CAPSULE_ID_BYTES, CAPSULE_ID_BYTES);
  const header: CapsuleStaticHeader = { schema: CAPSULE_HEADER_SCHEMA, capsuleId, createdAt, suite: CAPSULE_SUITE };

  const manifestPlaintext = encoder.encode(canonicalCapsuleJson(manifest));
  const payloadPlaintext = encoder.encode(canonicalCapsuleJson(payload));
  if (manifestPlaintext.length > CAPSULE_MAX_MANIFEST_PLAINTEXT_BYTES) invalid("Capsule manifest plaintext is oversized");
  if (manifestPlaintext.length + payloadPlaintext.length + 32 > CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES) {
    invalid("Capsule combined ciphertext would exceed the provisional limit");
  }

  const cek = secureRandomBytes(CEK_BYTES, unsafeTestOnly.randomBytes);
  try {
    const manifestNonce = secureRandomBytes(NONCE_BYTES, unsafeTestOnly.randomBytes);
    const payloadNonce = secureRandomBytes(NONCE_BYTES, unsafeTestOnly.randomBytes);
    if (equalBytes(manifestNonce, payloadNonce)) invalid("Capsule manifest and payload nonces must be distinct");
    const [manifestPart, payloadPart] = await Promise.all([
      encryptPart("manifest", manifestPlaintext, cek, manifestNonce, header),
      encryptPart("payload", payloadPlaintext, cek, payloadNonce, header),
    ]);

    const envelopes: CapsuleRecipientEnvelope[] = [];
    for (let index = 0; index < recipients.length; index += 1) {
      const recipient = recipients[index]!;
      const publicKey = await suite.kem.importKey("jwk", recipient.encryptionPublicKey, true);
      const aad = capsuleRecipientAad(header, recipient.fingerprint);
      const ekm = unsafeTestOnly.hpkeEphemeralKeyMaterial?.(recipient.fingerprint, index);
      if (ekm !== undefined && (!(ekm instanceof Uint8Array) || ekm.length !== 32)) invalid("HPKE test ephemeral material must contain exactly 32 bytes");
      const sender = await suite.createSenderContext({
        recipientPublicKey: publicKey,
        info: aad,
        ...(ekm === undefined ? {} : { ekm }),
      });
      const wrappedKey = new Uint8Array(await sender.seal(cek, aad));
      envelopes.push({
        schema: CAPSULE_RECIPIENT_SCHEMA,
        fingerprint: recipient.fingerprint,
        encapsulation: base64Url(new Uint8Array(sender.enc)),
        wrappedKey: base64Url(wrappedKey),
      });
    }

    return {
      schema: CAPSULE_SCHEMA,
      header,
      manifest: manifestPart as SyntheticCapsule["manifest"],
      payload: payloadPart as SyntheticCapsule["payload"],
      recipients: envelopes,
    };
  } finally {
    cek.fill(0);
  }
}

function validatePart(value: unknown, expectedKind: "manifest" | "payload"): { part: CapsuleCiphertextPart; bytes: Uint8Array } {
  const label = `Capsule ${expectedKind} part`;
  const part = objectValue(value, label);
  exactKeys(part, ["schema", "kind", "nonce", "ciphertext", "ciphertextBytes", "ciphertextSha256"], label);
  if (part.schema !== CAPSULE_PART_SCHEMA) invalid(`Unsupported capsule ${expectedKind} part schema`);
  if (part.kind !== expectedKind) invalid(`Capsule ${expectedKind} part kind is invalid`);
  const nonce = stringValue(part.nonce, `${label} nonce`, 16, 16);
  decodeBase64Url(nonce, `${label} nonce`, NONCE_BYTES, NONCE_BYTES);
  if (!Number.isSafeInteger(part.ciphertextBytes) || (part.ciphertextBytes as number) < 16 || (part.ciphertextBytes as number) > CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES) {
    invalid(`${label} byte count is invalid`);
  }
  const ciphertext = decodeBase64Url(part.ciphertext, `${label} ciphertext`, 16, CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES);
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

async function parseCapsuleValue(value: unknown): Promise<{ capsule: SyntheticCapsule; manifestBytes: Uint8Array; payloadBytes: Uint8Array }> {
  const capsule = objectValue(value, "Capsule");
  exactKeys(capsule, ["schema", "header", "manifest", "payload", "recipients"], "Capsule");
  if (capsule.schema !== CAPSULE_SCHEMA) invalid("Unsupported capsule schema");
  const header = validateHeader(capsule.header);
  const manifest = validatePart(capsule.manifest, "manifest");
  const payload = validatePart(capsule.payload, "payload");
  if (manifest.bytes.length + payload.bytes.length > CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES) invalid("Capsule combined ciphertext is oversized");
  if (!Array.isArray(capsule.recipients) || capsule.recipients.length < 1) invalid("Capsule has no recipient envelopes");
  if (capsule.recipients.length > CAPSULE_MAX_RECIPIENTS) invalid("Capsule has too many recipient envelopes");
  const recipients = capsule.recipients.map(validateEnvelope);
  for (let index = 1; index < recipients.length; index += 1) {
    const order = compareFingerprints(recipients[index - 1]!.fingerprint, recipients[index]!.fingerprint);
    if (order === 0) invalid("Capsule contains duplicate recipient fingerprints");
    if (order > 0) invalid("Capsule recipient envelopes are not canonically sorted");
  }
  const [manifestHash, payloadHash] = await Promise.all([sha256Hex(manifest.bytes), sha256Hex(payload.bytes)]);
  if (manifestHash !== manifest.part.ciphertextSha256) invalid("Capsule manifest ciphertext hash mismatch");
  if (payloadHash !== payload.part.ciphertextSha256) invalid("Capsule payload ciphertext hash mismatch");
  return {
    capsule: {
      schema: CAPSULE_SCHEMA,
      header,
      manifest: manifest.part as SyntheticCapsule["manifest"],
      payload: payload.part as SyntheticCapsule["payload"],
      recipients,
    },
    manifestBytes: manifest.bytes,
    payloadBytes: payload.bytes,
  };
}

export async function parseSyntheticCapsule(value: string | unknown): Promise<SyntheticCapsule> {
  let parsed = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > CAPSULE_MAX_SERIALIZED_BYTES) invalid("Serialized capsule is oversized");
    try {
      parsed = JSON.parse(value);
    } catch {
      invalid("Serialized capsule is malformed JSON");
    }
  }
  return (await parseCapsuleValue(parsed)).capsule;
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

export function capsuleReplayKey(capsule: Pick<SyntheticCapsule, "header" | "payload">): string {
  return `${capsule.header.capsuleId}:${capsule.payload.ciphertextSha256}`;
}

export async function openSyntheticCapsule(
  value: string | unknown,
  identity: CapsuleDecryptionIdentity,
  options: OpenSyntheticCapsuleOptions = {},
): Promise<OpenedSyntheticCapsule> {
  const parsed = typeof value === "string" ? await parseSyntheticCapsule(value).then(parseCapsuleValue) : await parseCapsuleValue(value);
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
    if (manifestPlaintext.length > CAPSULE_MAX_MANIFEST_PLAINTEXT_BYTES) invalid("Capsule manifest plaintext is oversized");
    const manifest = validateManifest(parseCanonicalPlaintext(manifestPlaintext, "Capsule manifest"));
    const payload = validatePayload(parseCanonicalPlaintext(payloadPlaintext, "Capsule payload"));

    if (options.replayGuard && !await options.replayGuard.accept(capsuleReplayKey(parsed.capsule))) {
      throw new CapsuleReplayError();
    }
    return { manifest, payload };
  } finally {
    cek.fill(0);
  }
}
