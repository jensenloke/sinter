import { describe, expect, test } from "bun:test";
import {
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
} from "../src/capsule-request-proof";

const BODY_HASH = "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93";
const NONCE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INPUT = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  method: "POST",
  pathname: "/api/cli/capsules",
  bodySha256: BODY_HASH,
  timestamp: "2026-08-31T00:00:00.000Z",
  nonce: NONCE,
};

describe("capsule request proof contract", () => {
  test("pins the exact body hash, payload, and canonical signing bytes", () => {
    expect(CAPSULE_REQUEST_PROOF_SCHEMA).toBe("sinter.cloud.capsule-request-proof.v1");
    expect(CAPSULE_REQUEST_MAX_SKEW_MS).toBe(300_000);
    expect(CAPSULE_REQUEST_NONCE_BYTES).toBe(32);
    expect(CAPSULE_REQUEST_SIGNATURE_BYTES).toBe(64);
    expect(CAPSULE_EMPTY_BODY_SHA256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(capsuleRequestBodySha256(Buffer.from('{"ok":true}', "utf8"))).toBe(BODY_HASH);
    expect(capsuleRequestBodySha256(new Uint8Array())).toBe(CAPSULE_EMPTY_BODY_SHA256);
    expect(capsuleRequestProofPayload(INPUT)).toEqual({
      schema: "sinter.cloud.capsule-request-proof.v1",
      deviceId: "11111111-1111-4111-8111-111111111111",
      method: "POST",
      pathname: "/api/cli/capsules",
      bodySha256: BODY_HASH,
      timestamp: "2026-08-31T00:00:00.000Z",
      nonce: NONCE,
    });
    expect(capsuleRequestProofBytes(INPUT).toString("utf8")).toBe(
      `{"bodySha256":"${BODY_HASH}","deviceId":"11111111-1111-4111-8111-111111111111","method":"POST","nonce":"${NONCE}","pathname":"/api/cli/capsules","schema":"sinter.cloud.capsule-request-proof.v1","timestamp":"2026-08-31T00:00:00.000Z"}`,
    );
  });

  test("accepts only canonical timestamps and 32-byte unpadded base64url nonces", () => {
    expect(canonicalCapsuleRequestTimestamp(INPUT.timestamp)).toBe(INPUT.timestamp);
    expect(canonicalCapsuleRequestNonce(NONCE)).toBe(NONCE);
    expect(() => canonicalCapsuleRequestTimestamp("2026-08-31T00:00:00Z")).toThrow(CapsuleRequestProofContractError);
    expect(() => canonicalCapsuleRequestNonce(`${NONCE}=`)).toThrow(CapsuleRequestProofContractError);
    expect(() => canonicalCapsuleRequestNonce("short")).toThrow(CapsuleRequestProofContractError);
  });
});
