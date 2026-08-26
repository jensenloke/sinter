import { describe, expect, test } from "bun:test";
import {
  Aes128Gcm,
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  DhkemP521HkdfSha512,
  HkdfSha256,
  HkdfSha512,
} from "@hpke/core";

interface HpkeVector {
  provenance: { kind: string; standard: string; source: string; jsonSource?: string; sourceSha256?: string; note: string };
  mode: number;
  kemId: number;
  kdfId: number;
  aeadId: number;
  info: string;
  ikmR: string;
  ikmE: string;
  publicKey: string;
  privateKey: string;
  encapsulation: string;
  aad: string;
  plaintext: string;
  ciphertext: string;
  exporterContext: string;
  exporterLength: number;
  exportedValue: string;
}

const a3 = await Bun.file(new URL("./hpke-rfc9180-a3-vector.json", import.meta.url)).json() as HpkeVector;
const p256Aes256 = await Bun.file(new URL("./hpke-cfrg-p256-aes256-vector.json", import.meta.url)).json() as HpkeVector;
const p521 = await Bun.file(new URL("./hpke-cfrg-p521-aes256-vector.json", import.meta.url)).json() as HpkeVector;
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (value: ArrayBuffer) => Buffer.from(value).toString("hex");

async function exerciseVector(vector: HpkeVector, suite: CipherSuite): Promise<void> {
  const recipientKeys = await suite.kem.deriveKeyPair(bytes(vector.ikmR));
  expect(hex(await suite.kem.serializePublicKey(recipientKeys.publicKey))).toBe(vector.publicKey);
  expect(hex(await suite.kem.serializePrivateKey(recipientKeys.privateKey))).toBe(vector.privateKey);

  const sender = await suite.createSenderContext({
    recipientPublicKey: recipientKeys.publicKey,
    info: bytes(vector.info),
    ekm: bytes(vector.ikmE),
  });
  expect(hex(sender.enc)).toBe(vector.encapsulation);
  expect(hex(await sender.seal(bytes(vector.plaintext), bytes(vector.aad)))).toBe(vector.ciphertext);
  expect(hex(await sender.export(bytes(vector.exporterContext), vector.exporterLength))).toBe(vector.exportedValue);

  const recipient = await suite.createRecipientContext({
    recipientKey: recipientKeys.privateKey,
    enc: bytes(vector.encapsulation),
    info: bytes(vector.info),
  });
  expect(hex(await recipient.open(bytes(vector.ciphertext), bytes(vector.aad)))).toBe(vector.plaintext);
  expect(hex(await recipient.export(bytes(vector.exporterContext), vector.exporterLength))).toBe(vector.exportedValue);
}

describe("authoritative RFC 9180 HPKE interoperability", () => {
  test("keeps Appendix A.3 P-256/HKDF-SHA256/AES-128-GCM coverage", async () => {
    expect(a3.provenance).toMatchObject({ kind: "rfc-published", standard: "RFC 9180 Appendix A.3" });
    expect({ mode: a3.mode, kem: a3.kemId, kdf: a3.kdfId, aead: a3.aeadId })
      .toEqual({ mode: 0, kem: 0x0010, kdf: 0x0001, aead: 0x0001 });
    await exerciseVector(a3, new CipherSuite({
      kem: new DhkemP256HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes128Gcm(),
    }));
  });

  test("matches the exact Sinter P-256/HKDF-SHA256/AES-256-GCM suite", async () => {
    expect(p256Aes256.provenance).toEqual({
      kind: "cfrg-published",
      standard: "RFC 9180 final CFRG test vectors",
      source: "https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/5f503c564da00b0687b3de75f1dfbdfc4079ad31/test-vectors.json",
      sourceSha256: "61fc662f01996cd06d713dacf5e133167bd309a1f329442d53f1e21a47b3ede6",
      note: "Authoritative base-mode P-256/HKDF-SHA256/AES-256-GCM vector selected from the final CFRG JSON cited by RFC 9180; this is the exact Sinter HPKE suite.",
    });
    expect({ mode: p256Aes256.mode, kem: p256Aes256.kemId, kdf: p256Aes256.kdfId, aead: p256Aes256.aeadId })
      .toEqual({ mode: 0, kem: 0x0010, kdf: 0x0001, aead: 0x0002 });
    const { provenance: _provenance, ...constants } = p256Aes256;
    const integrity = Buffer.from(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(constants)),
    )).toString("hex");
    expect(integrity).toBe("baed4e0cb1b7a1643c49d8b28228785884c4d8b1b9219f398019c0941ca3eb53");
    await exerciseVector(p256Aes256, new CipherSuite({
      kem: new DhkemP256HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes256Gcm(),
    }));
  });

  test("exercises authoritative CFRG P-521/HKDF-SHA512/AES-256-GCM constants", async () => {
    expect(p521.provenance).toEqual({
      kind: "cfrg-published",
      standard: "RFC 9180 final CFRG test vectors",
      source: "https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/5f503c564da00b0687b3de75f1dfbdfc4079ad31/test-vectors.json",
      sourceSha256: "61fc662f01996cd06d713dacf5e133167bd309a1f329442d53f1e21a47b3ede6",
      note: "Authoritative base-mode P-521/HKDF-SHA512/AES-256-GCM vector selected from the final CFRG JSON cited by RFC 9180.",
    });
    expect({ mode: p521.mode, kem: p521.kemId, kdf: p521.kdfId, aead: p521.aeadId })
      .toEqual({ mode: 0, kem: 0x0012, kdf: 0x0003, aead: 0x0002 });
    const { provenance: _provenance, ...constants } = p521;
    const integrity = Buffer.from(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(constants)),
    )).toString("hex");
    expect(integrity).toBe("5b92d016acb6b2cef1a9bd34a1edf4a592da55368ac9716f21aeb523fe291e6c");
    await exerciseVector(p521, new CipherSuite({
      kem: new DhkemP521HkdfSha512(),
      kdf: new HkdfSha512(),
      aead: new Aes256Gcm(),
    }));
  });
});
