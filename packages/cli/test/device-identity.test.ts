import { describe, expect, test } from "bun:test";
import {
  DEVICE_CRYPTO_SUITE,
  canonicalJson,
  createDeviceApprovalBody,
  createDeviceRegistrationBody,
  deviceFingerprint,
  generateDeviceKeyMaterial,
  validateDeviceKeyMaterial,
  verifyCanonicalSignature,
} from "../src/device-identity";

describe("CLI device identity", () => {
  test("canonicalizes JSON recursively with sorted object keys", () => {
    expect(canonicalJson({ z: 1, a: { d: 4, b: 2 }, list: [{ y: true, x: false }] })).toBe(
      '{"a":{"b":2,"d":4},"list":[{"x":false,"y":true}],"z":1}',
    );
  });

  test("generates and validates separate P-256 ECDH and ECDSA key pairs", async () => {
    const keys = await generateDeviceKeyMaterial(1_900_000_000_000);
    expect(keys.suite).toBe(DEVICE_CRYPTO_SUITE);
    expect(keys.encryptionPublicKey).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(keys.encryptionPrivateKey).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(keys.signingPublicKey).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(keys.signingPrivateKey).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(keys.encryptionPublicKey.d).toBeUndefined();
    expect(keys.signingPublicKey.d).toBeUndefined();
    expect(typeof keys.encryptionPrivateKey.d).toBe("string");
    expect(typeof keys.signingPrivateKey.d).toBe("string");
    expect(await validateDeviceKeyMaterial(keys)).toEqual(keys);
    const fingerprint = await deviceFingerprint(keys.encryptionPublicKey, keys.signingPublicKey);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await deviceFingerprint(
      { crv: keys.encryptionPublicKey.crv, kty: keys.encryptionPublicKey.kty, x: keys.encryptionPublicKey.x, y: keys.encryptionPublicKey.y },
      { crv: keys.signingPublicKey.crv, kty: keys.signingPublicKey.kty, x: keys.signingPublicKey.x, y: keys.signingPublicKey.y },
    )).toBe(fingerprint);

    const other = await generateDeviceKeyMaterial();
    expect(await deviceFingerprint(other.encryptionPublicKey, keys.signingPublicKey)).not.toBe(fingerprint);
    await expect(validateDeviceKeyMaterial({ ...keys, signingPublicKey: other.signingPublicKey })).rejects.toThrow(/do not match/);
  });

  test("signs the canonical registration payload without exposing private JWKs", async () => {
    const keys = await generateDeviceKeyMaterial();
    const body = await createDeviceRegistrationBody(keys, "Jensen Mac", "fixed-registration-nonce");
    const { proof, ...payload } = body;
    expect(body).toMatchObject({
      schema: "sinter.cloud.device-registration.v1",
      name: "Jensen Mac",
      suite: DEVICE_CRYPTO_SUITE,
      nonce: "fixed-registration-nonce",
    });
    expect(proof).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(body)).not.toContain('"d"');
    expect(await verifyCanonicalSignature(payload, proof, keys.signingPublicKey)).toBe(true);
    expect(await verifyCanonicalSignature({ ...payload, name: "tampered" }, proof, keys.signingPublicKey)).toBe(false);
  });

  test("signs the exact enrollment approval message", async () => {
    const keys = { ...(await generateDeviceKeyMaterial()), deviceId: "approver-device" };
    const request = { id: "request-1", requestFingerprint: "abc123", expiresAt: "2030-01-01T00:00:00.000Z" };
    const approval = await createDeviceApprovalBody(keys, request);
    expect(approval.body).toEqual({
      schema: "sinter.cloud.device-approval.v1",
      approverDeviceId: "approver-device",
      signature: expect.any(String),
    });
    expect(approval.message).toEqual({
      schema: "sinter.cloud.device-approval.v1",
      requestId: "request-1",
      approverDeviceId: "approver-device",
      requestFingerprint: "abc123",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(await verifyCanonicalSignature(approval.message, approval.body.signature, keys.signingPublicKey)).toBe(true);
  });
});
