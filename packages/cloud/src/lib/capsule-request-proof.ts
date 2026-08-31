import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  CAPSULE_REQUEST_MAX_SKEW_MS,
  CAPSULE_REQUEST_SIGNATURE_BYTES,
  canonicalCapsuleRequestNonce,
  canonicalCapsuleRequestTimestamp,
  capsuleRequestProofBytes,
  type CapsuleRequestProofInput,
} from "@sinter/core";
import { validatePublicP256Jwk, type PublicP256Jwk } from "./device-crypto";

export {
  CAPSULE_EMPTY_BODY_SHA256,
  CAPSULE_REQUEST_MAX_SKEW_MS,
  CAPSULE_REQUEST_NONCE_BYTES,
  CAPSULE_REQUEST_PROOF_SCHEMA,
  CAPSULE_REQUEST_SIGNATURE_BYTES,
  CapsuleRequestProofContractError,
  canonicalCapsuleRequestNonce,
  canonicalCapsuleRequestTimestamp,
  capsuleRequestBodySha256,
  capsuleRequestProofBytes,
  capsuleRequestProofPayload,
  type CapsuleRequestProofInput,
} from "@sinter/core";

export class CapsuleRequestProofError extends Error {
  constructor(public readonly kind: "invalid" | "stale") {
    super("Invalid capsule request proof");
    this.name = "CapsuleRequestProofError";
  }
}

function decodeCanonicalSignature(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new CapsuleRequestProofError("invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== CAPSULE_REQUEST_SIGNATURE_BYTES
    || decoded.toString("base64url") !== value
  ) {
    throw new CapsuleRequestProofError("invalid");
  }
  return decoded;
}

export function verifyCapsuleRequestProof(
  signingPublicKey: PublicP256Jwk,
  input: CapsuleRequestProofInput,
  encodedSignature: unknown,
  now: Date,
): void {
  let timestamp: string;
  try {
    timestamp = canonicalCapsuleRequestTimestamp(input.timestamp);
    canonicalCapsuleRequestNonce(input.nonce);
    if (!/^[0-9a-f]{64}$/.test(input.bodySha256)) {
      throw new Error("invalid body hash");
    }
  } catch {
    throw new CapsuleRequestProofError("invalid");
  }
  if (Math.abs(now.getTime() - Date.parse(timestamp)) > CAPSULE_REQUEST_MAX_SKEW_MS) {
    throw new CapsuleRequestProofError("stale");
  }
  const signature = decodeCanonicalSignature(encodedSignature);
  let verified = false;
  try {
    const publicKey = validatePublicP256Jwk(signingPublicKey, "signing");
    verified = verifySignature(
      "sha256",
      capsuleRequestProofBytes(input),
      { key: createPublicKey({ key: publicKey, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    verified = false;
  }
  if (!verified) throw new CapsuleRequestProofError("invalid");
}
