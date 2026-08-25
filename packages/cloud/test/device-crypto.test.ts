import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  DEVICE_APPROVAL_SCHEMA,
  DEVICE_REGISTRATION_SCHEMA,
  DEVICE_SUITE,
  approvalProofData,
  canonicalJson,
  deviceFingerprint,
  parseAndVerifyRegistration,
  parseDeviceApproval,
  registrationProofData,
  validatePublicP256Jwk,
  verifyApprovalSignature,
  type DeviceRegistration,
  type PublicP256Jwk,
} from "../src/lib/device-crypto";

function keys(purpose: "encryption" | "signing") {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const exported = pair.publicKey.export({ format: "jwk" });
  const publicKey: PublicP256Jwk = {
    kty: "EC",
    crv: "P-256",
    x: exported.x!,
    y: exported.y!,
    use: purpose === "encryption" ? "enc" : "sig",
    key_ops: purpose === "encryption" ? [] : ["verify"],
    ext: true,
  };
  return { ...pair, publicKey };
}

function registration() {
  const encryption = keys("encryption");
  const signing = keys("signing");
  const base: Omit<DeviceRegistration, "proof"> = {
    schema: DEVICE_REGISTRATION_SCHEMA,
    name: "Jensen’s MacBook",
    suite: DEVICE_SUITE,
    encryptionPublicKey: encryption.publicKey,
    signingPublicKey: signing.publicKey,
    fingerprint: deviceFingerprint(encryption.publicKey, signing.publicKey),
    nonce: Buffer.alloc(32, 7).toString("base64url"),
  };
  const proof = sign(
    "sha256",
    Buffer.from(canonicalJson(registrationProofData(base))),
    { key: signing.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  return { value: { ...base, proof }, encryption, signing };
}

describe("device canonical crypto", () => {
  test("recursively canonicalizes JSON without changing array order", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: { d: true, c: null } })).toBe(
      '{"a":{"c":null,"d":true},"z":[{"a":1,"b":2}]}',
    );
  });

  test("accepts canonical public P-256 JWKs and a valid registration proof", () => {
    const fixture = registration();
    expect(parseAndVerifyRegistration(fixture.value)).toEqual(fixture.value);
  });

  test("binds both public keys while ignoring optional JWK metadata", () => {
    const fixture = registration();
    const minimalEncryption = {
      crv: fixture.encryption.publicKey.crv,
      kty: fixture.encryption.publicKey.kty,
      x: fixture.encryption.publicKey.x,
      y: fixture.encryption.publicKey.y,
    } as PublicP256Jwk;
    const minimalSigning = {
      crv: fixture.signing.publicKey.crv,
      kty: fixture.signing.publicKey.kty,
      x: fixture.signing.publicKey.x,
      y: fixture.signing.publicKey.y,
    } as PublicP256Jwk;
    expect(deviceFingerprint(fixture.encryption.publicKey, fixture.signing.publicKey))
      .toBe(deviceFingerprint(minimalEncryption, minimalSigning));
    expect(deviceFingerprint(keys("encryption").publicKey, fixture.signing.publicKey))
      .not.toBe(fixture.value.fingerprint);
  });

  test("rejects malformed, private, and wrongly-scoped JWKs", () => {
    const fixture = registration();
    expect(() => validatePublicP256Jwk({
      ...fixture.signing.publicKey,
      d: Buffer.alloc(32).toString("base64url"),
    }, "signing")).toThrow("Invalid device request");
    expect(() => validatePublicP256Jwk({
      ...fixture.signing.publicKey,
      x: "not_base64url!",
    }, "signing")).toThrow("Invalid device request");
    expect(() => validatePublicP256Jwk({
      ...fixture.signing.publicKey,
      key_ops: ["sign"],
    }, "signing")).toThrow("Invalid device request");
  });

  test("rejects an uppercase or mismatched fingerprint", () => {
    const fixture = registration();
    expect(() => parseAndVerifyRegistration({
      ...fixture.value,
      fingerprint: fixture.value.fingerprint.toUpperCase(),
    })).toThrow("Invalid device request");
    expect(() => parseAndVerifyRegistration({
      ...fixture.value,
      fingerprint: "0".repeat(64),
    })).toThrow("Invalid device request");
  });

  test("rejects invalid registration proof, nonce, and non-canonical names", () => {
    const fixture = registration();
    expect(() => parseAndVerifyRegistration({
      ...fixture.value,
      proof: Buffer.alloc(64).toString("base64url"),
    })).toThrow("Invalid device request");
    expect(() => parseAndVerifyRegistration({
      ...fixture.value,
      nonce: Buffer.alloc(8).toString("base64url"),
    })).toThrow("Invalid device request");
    expect(() => parseAndVerifyRegistration({ ...fixture.value, name: " padded " }))
      .toThrow("Invalid device request");
  });

  test("verifies approval signatures over the exact canonical request tuple", () => {
    const approver = keys("signing");
    const requestId = "77777777-7777-4777-8777-777777777777";
    const approverId = "11111111-1111-4111-8111-111111111111";
    const fingerprint = "a".repeat(64);
    const expiresAt = "2026-08-25T10:15:00.000Z";
    const signature = sign(
      "sha256",
      Buffer.from(canonicalJson(approvalProofData(requestId, approverId, fingerprint, expiresAt))),
      { key: approver.privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url");
    const approval = parseDeviceApproval({
      schema: DEVICE_APPROVAL_SCHEMA,
      approverDeviceId: approverId,
      signature,
    });
    expect(() => verifyApprovalSignature(
      approver.publicKey,
      approval,
      requestId,
      fingerprint,
      expiresAt,
    )).not.toThrow();
    expect(() => verifyApprovalSignature(
      approver.publicKey,
      approval,
      requestId,
      "b".repeat(64),
      expiresAt,
    )).toThrow("Invalid device request");
  });
});
