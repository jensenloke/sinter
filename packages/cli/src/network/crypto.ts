import { decodeBase64Url, encodeBase64Url } from "./locator";

const encoder = new TextEncoder();
const PROTOCOL_SALT = encoder.encode("sinter.direct-transfer.v1");

function source(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export interface TransferKeys {
  encryption: CryptoKey;
  requestAuthentication: CryptoKey;
  receiptAuthentication: CryptoKey;
}

export async function deriveTransferKeys(capability: Uint8Array): Promise<TransferKeys> {
  const material = await crypto.subtle.importKey("raw", source(capability), "HKDF", false, ["deriveKey"]);
  const derive = (info: string, algorithm: AesKeyGenParams | HmacImportParams, usages: KeyUsage[]) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: source(PROTOCOL_SALT), info: source(encoder.encode(info)) },
      material,
      algorithm,
      false,
      usages,
    );
  return {
    encryption: await derive("payload-encryption", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    requestAuthentication: await derive("request-authentication", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign", "verify"]),
    receiptAuthentication: await derive("receipt-authentication", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign", "verify"]),
  };
}

export async function encryptPayload(payload: Uint8Array, metadata: Uint8Array, key: CryptoKey): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: source(nonce), additionalData: source(metadata), tagLength: 128 }, key, source(payload));
  return { nonce, ciphertext: new Uint8Array(encrypted) };
}

export async function decryptPayload(ciphertext: Uint8Array, nonce: Uint8Array, metadata: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: source(nonce), additionalData: source(metadata), tagLength: 128 }, key, source(ciphertext));
  return new Uint8Array(clear);
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export async function signRequest(key: CryptoKey, nonce: Uint8Array, metadata: Uint8Array, ciphertext: Uint8Array): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, source(concatenate(nonce, metadata, ciphertext)));
  return encodeBase64Url(new Uint8Array(signature));
}

export async function verifyRequest(key: CryptoKey, signature: string, nonce: Uint8Array, metadata: Uint8Array, ciphertext: Uint8Array): Promise<boolean> {
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(signature);
  } catch {
    return false;
  }
  return decoded.byteLength === 32 && crypto.subtle.verify("HMAC", key, source(decoded), source(concatenate(nonce, metadata, ciphertext)));
}

export async function digestTransfer(ciphertext: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", source(ciphertext)));
}

export async function signReceipt(key: CryptoKey, transferId: string, digest: Uint8Array): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, source(concatenate(encoder.encode(transferId), digest)));
  return encodeBase64Url(new Uint8Array(signature));
}

export async function verifyReceipt(key: CryptoKey, signature: string, transferId: string, digest: Uint8Array): Promise<boolean> {
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(signature);
  } catch {
    return false;
  }
  return decoded.byteLength === 32 && crypto.subtle.verify("HMAC", key, source(decoded), source(concatenate(encoder.encode(transferId), digest)));
}
