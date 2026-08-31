import { createHash } from "node:crypto";
import { canonicalCapsuleJson } from "./capsule";

export const CAPSULE_REQUEST_PROOF_SCHEMA = "sinter.cloud.capsule-request-proof.v1" as const;
export const CAPSULE_REQUEST_MAX_SKEW_MS = 5 * 60 * 1000;
export const CAPSULE_REQUEST_NONCE_BYTES = 32;
export const CAPSULE_REQUEST_SIGNATURE_BYTES = 64;
export const CAPSULE_EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

export interface CapsuleRequestProofInput {
  deviceId: string;
  method: string;
  pathname: string;
  bodySha256: string;
  timestamp: string;
  nonce: string;
}

export class CapsuleRequestProofContractError extends Error {
  constructor() {
    super("Invalid capsule request proof contract");
    this.name = "CapsuleRequestProofContractError";
  }
}

function invalid(): never {
  throw new CapsuleRequestProofContractError();
}

function decodeCanonicalBase64Url(value: unknown, bytes: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) return invalid();
  return decoded;
}

export function capsuleRequestBodySha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function canonicalCapsuleRequestTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24) return invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return invalid();
  return value;
}

export function canonicalCapsuleRequestNonce(value: unknown): string {
  decodeCanonicalBase64Url(value, CAPSULE_REQUEST_NONCE_BYTES);
  return value as string;
}

export function capsuleRequestProofPayload(input: CapsuleRequestProofInput) {
  return {
    schema: CAPSULE_REQUEST_PROOF_SCHEMA,
    deviceId: input.deviceId,
    method: input.method,
    pathname: input.pathname,
    bodySha256: input.bodySha256,
    timestamp: input.timestamp,
    nonce: input.nonce,
  };
}

export function capsuleRequestProofBytes(input: CapsuleRequestProofInput): Buffer {
  return Buffer.from(canonicalCapsuleJson(capsuleRequestProofPayload(input)), "utf8");
}
