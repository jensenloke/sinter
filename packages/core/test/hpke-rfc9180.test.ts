import { describe, expect, test } from "bun:test";
import {
  Aes128Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";

interface RfcVector {
  provenance: { kind: string; standard: string; source: string; jsonSource: string; note: string };
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

const vector = await Bun.file(new URL("./hpke-rfc9180-a3-vector.json", import.meta.url)).json() as RfcVector;
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (value: ArrayBuffer) => Buffer.from(value).toString("hex");

describe("RFC 9180 Appendix A.3 interoperability", () => {
  test("matches the authoritative base-mode P-256 AES-128 vector", async () => {
    expect(vector.provenance).toMatchObject({
      kind: "rfc-published",
      standard: "RFC 9180 Appendix A.3",
    });
    expect({ mode: vector.mode, kem: vector.kemId, kdf: vector.kdfId, aead: vector.aeadId })
      .toEqual({ mode: 0, kem: 0x0010, kdf: 0x0001, aead: 0x0001 });

    const suite = new CipherSuite({
      kem: new DhkemP256HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes128Gcm(),
    });
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
  });
});
