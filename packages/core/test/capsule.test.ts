import { beforeAll, describe, expect, test } from "bun:test";
import {
  CAPSULE_AAD_SCHEMA,
  CAPSULE_HEADER_SCHEMA,
  CAPSULE_LINEAGE_SCHEMA,
  CAPSULE_MANIFEST_CIPHERTEXT_BYTES,
  CAPSULE_MANIFEST_PADDED_BYTES,
  CAPSULE_MANIFEST_SCHEMA,
  CAPSULE_MAX_RECIPIENTS,
  CAPSULE_MAX_SERIALIZED_BYTES,
  CAPSULE_PART_SCHEMA,
  CAPSULE_PAYLOAD_SCHEMA,
  CAPSULE_RECIPIENT_SCHEMA,
  CAPSULE_RFC9180_SUITE_IDS,
  CAPSULE_SCHEMA,
  CAPSULE_SIGNATURE_INPUT_SCHEMA,
  CAPSULE_SUITE,
  CapsuleReplayError,
  MemoryCapsuleReplayGuard,
  canonicalCapsuleJson,
  capsulePartAad,
  capsuleRecipientAad,
  capsuleRecipientFingerprint,
  capsuleReplayKey,
  capsuleSignatureInput,
  createSyntheticCapsule,
  openSyntheticCapsule,
  parseSyntheticCapsule,
  serializeSyntheticCapsule,
  type CapsuleDecryptionIdentity,
  type CapsuleManifest,
  type CapsuleRecipientIdentity,
  type CapsuleSenderIdentity,
  type SyntheticCapsule,
  type SyntheticCapsulePayload,
} from "../src/index";

interface TestIdentity extends CapsuleRecipientIdentity {
  encryptionPrivateKey: JsonWebKey;
  signingPrivateKey: JsonWebKey;
  fingerprint: string;
}

interface CapsuleFixture {
  provenance: Record<string, unknown>;
  senderEncryptionPublicKey: JsonWebKey;
  senderSigningPublicKey: JsonWebKey;
  senderFingerprint: string;
  signatureInputUtf8Base64Url: string;
  signatureInputSha256: string;
  signature: string;
}

const fixture = await Bun.file(new URL("./capsule-vector.json", import.meta.url)).json() as CapsuleFixture;
let senderIdentity: TestIdentity;
let identities: TestIdentity[];

async function identity(): Promise<TestIdentity> {
  const [encryption, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  ]);
  const [encryptionPublicKey, encryptionPrivateKey, signingPublicKey, signingPrivateKey] = await Promise.all([
    crypto.subtle.exportKey("jwk", encryption.publicKey),
    crypto.subtle.exportKey("jwk", encryption.privateKey),
    crypto.subtle.exportKey("jwk", signing.publicKey),
    crypto.subtle.exportKey("jwk", signing.privateKey),
  ]);
  return {
    encryptionPublicKey,
    encryptionPrivateKey,
    signingPublicKey,
    signingPrivateKey,
    fingerprint: await capsuleRecipientFingerprint(encryptionPublicKey, signingPublicKey),
  };
}

beforeAll(async () => {
  [senderIdentity, ...identities] = await Promise.all(Array.from({ length: CAPSULE_MAX_RECIPIENTS + 2 }, identity));
});

function manifest(title = "Synthetic capsule title"): CapsuleManifest {
  return {
    schema: CAPSULE_MANIFEST_SCHEMA,
    title,
    harness: "codex",
    lineage: { schema: CAPSULE_LINEAGE_SCHEMA, threadId: "synthetic-thread", hop: 1 },
  };
}

function payload(text = "Synthetic prompt content"): SyntheticCapsulePayload {
  return {
    schema: CAPSULE_PAYLOAD_SCHEMA,
    synthetic: true,
    sif: {
      sif: "sif/0",
      id: "synthetic-sif-id",
      origin: { harness: "codex", nativeId: "synthetic-native-id" },
      cwd: "/synthetic/project",
      createdAt: "2030-04-05T06:07:08.000Z",
      entries: [{
        kind: "user",
        id: "synthetic-entry-1",
        parentId: null,
        ts: "2030-04-05T06:07:08.000Z",
        content: [{ type: "text", text }],
        synthetic: true,
      }],
    },
  };
}

function recipient(value: TestIdentity): CapsuleRecipientIdentity {
  return {
    encryptionPublicKey: value.encryptionPublicKey,
    signingPublicKey: value.signingPublicKey,
    fingerprint: value.fingerprint,
  };
}

function sender(value = senderIdentity): CapsuleSenderIdentity {
  return {
    encryptionPublicKey: value.encryptionPublicKey,
    signingPublicKey: value.signingPublicKey,
    signingPrivateKey: value.signingPrivateKey,
    fingerprint: value.fingerprint,
  };
}

function opener(value: TestIdentity, expectedSender = senderIdentity): CapsuleDecryptionIdentity {
  return {
    fingerprint: value.fingerprint,
    encryptionPrivateKey: value.encryptionPrivateKey,
    expectedSenderFingerprint: expectedSender.fingerprint,
    senderSigningPublicKey: expectedSender.signingPublicKey,
  };
}

async function capsule(
  recipients: readonly CapsuleRecipientIdentity[] = [recipient(identities[0]!)],
  title?: string,
  text?: string,
): Promise<SyntheticCapsule> {
  return createSyntheticCapsule({ manifest: manifest(title), payload: payload(text), sender: sender(), recipients });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function flip(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] = bytes[0]! ^ 1;
  return bytes.toString("base64url");
}

async function sha256Base64Url(value: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(value))).toString("hex");
}

describe("C2 contract and checked-in fixture", () => {
  test("publishes the suite and canonical AAD/signature contracts", () => {
    expect(CAPSULE_RFC9180_SUITE_IDS).toEqual({ mode: 0, kem: 0x0010, kdf: 0x0001, aead: 0x0002 });
    const header = {
      schema: CAPSULE_HEADER_SCHEMA,
      capsuleId: "ABEiM0RVZneImaq7zN3u_w",
      createdAt: "2030-01-02T03:04:05.000Z",
      suite: CAPSULE_SUITE,
    } as const;
    expect(new TextDecoder().decode(capsulePartAad(header, "manifest"))).toBe(canonicalCapsuleJson({
      schema: CAPSULE_AAD_SCHEMA,
      header,
      part: { schema: CAPSULE_PART_SCHEMA, kind: "manifest" },
    }));
    expect(new TextDecoder().decode(capsuleRecipientAad(header, "a".repeat(64)))).toBe(canonicalCapsuleJson({
      schema: CAPSULE_AAD_SCHEMA,
      header,
      recipient: { schema: CAPSULE_RECIPIENT_SCHEMA, fingerprint: "a".repeat(64) },
    }));
  });

  test("pins stable unsigned signature-input bytes while verifying the nondeterministically signed fixture", async () => {
    const input = new Uint8Array(Buffer.from(fixture.signatureInputUtf8Base64Url, "base64url"));
    const decoded = new TextDecoder().decode(input);
    expect(canonicalCapsuleJson(JSON.parse(decoded))).toBe(decoded);
    expect(decoded).toContain(CAPSULE_SIGNATURE_INPUT_SCHEMA);
    expect(await sha256Base64Url(input)).toBe(fixture.signatureInputSha256);
    expect(await capsuleRecipientFingerprint(fixture.senderEncryptionPublicKey, fixture.senderSigningPublicKey))
      .toBe(fixture.senderFingerprint);
    const key = await crypto.subtle.importKey(
      "jwk", fixture.senderSigningPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new Uint8Array(Buffer.from(fixture.signature, "base64url")),
      new Uint8Array(input),
    )).toBe(true);
    expect(fixture.provenance).toMatchObject({
      kind: "project-generated",
      suite: "P-256/HKDF-SHA256/AES-256-GCM",
      suiteIds: CAPSULE_RFC9180_SUITE_IDS,
      signature: "ECDSA P-256 SHA-256 IEEE-P1363",
    });
    expect(JSON.stringify(fixture)).not.toContain("/Users/");
  });

  test("pins the Phase 1 fingerprint contract to a hardcoded constant", async () => {
    const encryption = {
      kty: "EC", crv: "P-256",
      x: "49pxiy77_9MJD0KXUVHBhCnIBx8UkYM20ckoBf2LL78",
      y: "Mj_WFEsqP5tJKIY1CUqgbX5FcAB_zH8fmyOMoZii1eE",
    };
    const signing = {
      kty: "EC", crv: "P-256",
      x: "r9XYRZ-tq5_2vmZFcQjvZ-L9iv7kotKVKg0DLOKGUlA",
      y: "LMxQRdEY6sxsKQSMOsKlE28UPSAS5S9ZVCbcScDBtho",
    };
    expect(await capsuleRecipientFingerprint(encryption, signing))
      .toBe("2f0d1d031afb81d92c0e36a6a2b6ceaecfe3273bdbc31307d75ca89e140a7ef5");
  });
});

describe("C2 sender authenticity and membership", () => {
  test("round-trips and verifies every sorted recipient, including exactly 32", async () => {
    const all = identities.slice(0, CAPSULE_MAX_RECIPIENTS);
    const value = await capsule(all.slice().reverse().map(recipient));
    expect(value.recipients).toHaveLength(CAPSULE_MAX_RECIPIENTS);
    expect(value.recipients.map((item) => item.fingerprint)).toEqual(all.map((item) => item.fingerprint).sort());
    for (const item of all) {
      expect((await openSyntheticCapsule(value, opener(item))).payload.sif.id).toBe("synthetic-sif-id");
    }
  }, 30_000);

  test("rejects wrong sender, wrong signing key, tampered signature, and private/public forgery", async () => {
    const value = await capsule();
    const wrongSender = identities[1]!;
    await expect(openSyntheticCapsule(value, opener(identities[0]!, wrongSender))).rejects.toThrow(/sender fingerprint/);
    await expect(openSyntheticCapsule(value, { ...opener(identities[0]!), senderSigningPublicKey: wrongSender.signingPublicKey }))
      .rejects.toThrow(/sender key/);
    const tampered = clone(value);
    tampered.sender.signature = flip(tampered.sender.signature);
    await expect(openSyntheticCapsule(tampered, opener(identities[0]!))).rejects.toThrow(/signature verification/);
    await expect(createSyntheticCapsule({
      manifest: manifest(), payload: payload(), recipients: [recipient(identities[0]!)],
      sender: { ...sender(), signingPrivateKey: wrongSender.signingPrivateKey },
    })).rejects.toThrow(/private key does not match/);
  });

  test("rejects sender encryption-key substitution, non-recipients, and envelope tampering", async () => {
    const value = await capsule();
    const substitutedSender = clone(value);
    substitutedSender.sender.encryptionPublicKey = {
      kty: "EC",
      crv: "P-256",
      x: identities[1]!.encryptionPublicKey.x!,
      y: identities[1]!.encryptionPublicKey.y!,
    };
    await expect(openSyntheticCapsule(substitutedSender, opener(identities[0]!)))
      .rejects.toThrow(/sender key/);
    await expect(openSyntheticCapsule(value, opener(identities[1]!)))
      .rejects.toThrow(/no envelope/);

    for (const field of ["encapsulation", "wrappedKey"] as const) {
      const tampered = clone(value);
      tampered.recipients[0]![field] = flip(tampered.recipients[0]![field]);
      await expect(openSyntheticCapsule(tampered, opener(identities[0]!)))
        .rejects.toThrow(/unwrap failed/);
    }
  });

  test("rejects equal encryption/signing public points throughout core", async () => {
    const point = {
      kty: senderIdentity.signingPublicKey.kty,
      crv: senderIdentity.signingPublicKey.crv,
      x: senderIdentity.signingPublicKey.x,
      y: senderIdentity.signingPublicKey.y,
    };
    await expect(capsuleRecipientFingerprint(point, point)).rejects.toThrow(/distinct/);
    await expect(createSyntheticCapsule({
      manifest: manifest(), payload: payload(), recipients: [recipient(identities[0]!)],
      sender: {
        encryptionPublicKey: point,
        signingPublicKey: point,
        signingPrivateKey: senderIdentity.signingPrivateKey,
      },
    })).rejects.toThrow(/distinct/);
  });

  test("authenticates exact membership against removal, addition, and reordering", async () => {
    const first = await capsule(identities.slice(0, 3).map(recipient));
    const removed = clone(first);
    removed.recipients.splice(1, 1);
    await expect(openSyntheticCapsule(removed, opener(identities[0]!))).rejects.toThrow(/signature verification/);

    const second = await capsule(identities.slice(0, 2).map(recipient));
    const added = clone(second);
    added.recipients.push(clone(first.recipients.find((item) => !added.recipients.some((own) => own.fingerprint === item.fingerprint))!));
    added.recipients.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
    await expect(openSyntheticCapsule(added, opener(identities[0]!))).rejects.toThrow(/signature verification/);

    const reordered = clone(first);
    reordered.recipients.reverse();
    await expect(openSyntheticCapsule(reordered, opener(identities[0]!))).rejects.toThrow(/signature verification/);
    await expect(parseSyntheticCapsule(reordered)).rejects.toThrow(/sorted/);
  });

  test("rejects part metadata and ciphertext forgery before plaintext return", async () => {
    const original = await capsule();
    for (const mutate of [
      (value: SyntheticCapsule) => { value.header.createdAt = "2031-01-02T03:04:05.000Z"; },
      (value: SyntheticCapsule) => { value.manifest.ciphertextSha256 = "0".repeat(64); },
      (value: SyntheticCapsule) => { value.payload.nonce = flip(value.payload.nonce); },
      (value: SyntheticCapsule) => { value.payload.ciphertext = flip(value.payload.ciphertext); },
    ]) {
      const changed = clone(original);
      mutate(changed);
      await expect(openSyntheticCapsule(changed, opener(identities[0]!))).rejects.toThrow();
    }
  });
});

describe("C2 manifest privacy and strict parsing", () => {
  test("uses an exact 4 KiB manifest plaintext plus GCM tag without title-length leakage", async () => {
    const short = await capsule(undefined, "x");
    const long = await capsule(undefined, "x".repeat(900));
    expect(CAPSULE_MANIFEST_PADDED_BYTES).toBe(4096);
    expect(short.manifest.ciphertextBytes).toBe(CAPSULE_MANIFEST_CIPHERTEXT_BYTES);
    expect(long.manifest.ciphertextBytes).toBe(CAPSULE_MANIFEST_CIPHERTEXT_BYTES);
    expect(short.manifest.ciphertext.length).toBe(long.manifest.ciphertext.length);
    expect(short.payload.ciphertextBytes).toBe(long.payload.ciphertextBytes);
  });

  test("keeps payload size intentionally observable", async () => {
    const short = await capsule(undefined, undefined, "x");
    const long = await capsule(undefined, undefined, "x".repeat(1000));
    expect(long.payload.ciphertextBytes).toBeGreaterThan(short.payload.ciphertextBytes);
  });

  test("independently rejects equal manifest/payload nonces", async () => {
    const value = await capsule();
    value.payload.nonce = value.manifest.nonce;
    await expect(parseSyntheticCapsule(value)).rejects.toThrow(/nonces must be distinct/);
  });

  test("accepts one canonical string parse and rejects noncanonical strings, deep objects, unpaired surrogates, and unknown fields", async () => {
    const value = await capsule();
    await expect(parseSyntheticCapsule(serializeSyntheticCapsule(value))).resolves.toEqual(value);
    await expect(parseSyntheticCapsule(JSON.stringify(value, null, 2))).rejects.toThrow(/canonical/);
    let deep: unknown = "leaf";
    for (let index = 0; index < 66; index += 1) deep = { nested: deep };
    await expect(parseSyntheticCapsule(deep)).rejects.toThrow(/deep/);
    await expect(parseSyntheticCapsule({ ["\ud800"]: true })).rejects.toThrow(/surrogate/);
    await expect(parseSyntheticCapsule({ ...value, publicTitle: "forbidden" })).rejects.toThrow(/unsupported/);
  });

  test("enforces the 24 MiB serialized string limit before parse", async () => {
    const exact = `"${"x".repeat(CAPSULE_MAX_SERIALIZED_BYTES - 2)}"`;
    expect(Buffer.byteLength(exact)).toBe(CAPSULE_MAX_SERIALIZED_BYTES);
    await expect(parseSyntheticCapsule(exact)).rejects.toThrow(/object/);
    await expect(parseSyntheticCapsule(`${exact} `)).rejects.toThrow(/oversized/);
  });

  test("enforces object serialized-equivalent and decoded budgets", async () => {
    const value = await capsule();
    const oversized = { ...value, padding: "x".repeat(CAPSULE_MAX_SERIALIZED_BYTES) };
    await expect(parseSyntheticCapsule(oversized)).rejects.toThrow(/serialized-equivalent budget/);

    const ciphertext = Buffer.alloc(12 * 1024 * 1024).toString("base64url");
    const decodedHeavy = clone(value);
    decodedHeavy.payload.ciphertext = ciphertext;
    decodedHeavy.payload.ciphertextBytes = 12 * 1024 * 1024;
    decodedHeavy.payload.ciphertextSha256 = "0".repeat(64);
    await expect(parseSyntheticCapsule(decodedHeavy)).rejects.toThrow(/hash mismatch/);
  });

  test("rejects malformed versions, base64url, recipient counts, and fixed manifest-size violations", async () => {
    const malformed = clone(await capsule());
    malformed.manifest.nonce = "not+base64______";
    await expect(parseSyntheticCapsule(malformed)).rejects.toThrow(/base64url/);
    const version = clone(await capsule());
    (version as { schema: string }).schema = `${CAPSULE_SCHEMA}.next`;
    await expect(parseSyntheticCapsule(version)).rejects.toThrow(/Unsupported/);
    const tooMany = clone(await capsule());
    tooMany.recipients = Array.from({ length: CAPSULE_MAX_RECIPIENTS + 1 }, () => clone(tooMany.recipients[0]!));
    await expect(parseSyntheticCapsule(tooMany)).rejects.toThrow(/too many/);
    const manifestSize = clone(await capsule());
    manifestSize.manifest.ciphertext = manifestSize.manifest.ciphertext.slice(0, -2);
    manifestSize.manifest.ciphertextBytes -= 1;
    await expect(parseSyntheticCapsule(manifestSize)).rejects.toThrow(/fixed padded size/);
  });
});

describe("C2 replay and public surface", () => {
  test("supports async guards and rejects a replay only after successful decryption", async () => {
    const value = await capsule();
    const accepted = new Set<string>();
    const guard = {
      async accept(key: string): Promise<boolean> {
        await Promise.resolve();
        if (accepted.has(key)) return false;
        accepted.add(key);
        return true;
      },
    };
    await expect(openSyntheticCapsule(value, opener(identities[0]!), { replayGuard: guard })).resolves.toBeDefined();
    await expect(openSyntheticCapsule(value, opener(identities[0]!), { replayGuard: guard })).rejects.toBeInstanceOf(CapsuleReplayError);
  });

  test("allows exactly one concurrent open through an atomic async guard", async () => {
    const value = await capsule();
    const accepted = new Set<string>();
    const guard = {
      async accept(key: string): Promise<boolean> {
        await Promise.resolve();
        if (accepted.has(key)) return false;
        accepted.add(key);
        return true;
      },
    };
    const results = await Promise.allSettled([
      openSyntheticCapsule(value, opener(identities[0]!), { replayGuard: guard }),
      openSyntheticCapsule(value, opener(identities[0]!), { replayGuard: guard }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  test("scopes the exact replay key contract per opening device", async () => {
    const value = await capsule(identities.slice(0, 2).map(recipient));
    expect(capsuleReplayKey(value, identities[0]!.fingerprint)).toBe([
      identities[0]!.fingerprint,
      value.header.capsuleId,
      value.manifest.ciphertextSha256,
      value.payload.ciphertextSha256,
    ].join(":"));
    const guard = new MemoryCapsuleReplayGuard();
    await expect(openSyntheticCapsule(value, opener(identities[0]!), { replayGuard: guard })).resolves.toBeDefined();
    await expect(openSyntheticCapsule(value, opener(identities[1]!), { replayGuard: guard })).resolves.toBeDefined();
    await expect(openSyntheticCapsule(value, opener(identities[0]!), { replayGuard: guard })).rejects.toBeInstanceOf(CapsuleReplayError);
  });

  test("does not consume replay state after failed decrypt and evicts deterministically when bounded", async () => {
    const value = await capsule();
    const guard = new MemoryCapsuleReplayGuard();
    await expect(openSyntheticCapsule(value, { ...opener(identities[0]!), encryptionPrivateKey: identities[1]!.encryptionPrivateKey }, { replayGuard: guard }))
      .rejects.toThrow(/unwrap failed/);
    await expect(openSyntheticCapsule(value, opener(identities[0]!), { replayGuard: guard })).resolves.toBeDefined();

    const bounded = new MemoryCapsuleReplayGuard(2);
    expect(bounded.accept("a")).toBe(true);
    expect(bounded.accept("b")).toBe(true);
    expect(bounded.accept("c")).toBe(true);
    expect(bounded.accept("a")).toBe(true);
  });

  test("has no production-importable deterministic random or EKM override surface", async () => {
    const source = await Bun.file(new URL("../src/capsule.ts", import.meta.url)).text();
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json() as { exports: Record<string, string> };
    expect(createSyntheticCapsule.length).toBe(1);
    expect(source).not.toContain("CapsuleTestOverrides");
    expect(source).not.toContain("unsafeTestOnly");
    expect(source).not.toContain("hpkeEphemeralKeyMaterial");
    expect(packageJson.exports["./*"]).toBeUndefined();
    expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./adapter", "./jsonl", "./lineage", "./sif", "./util"]);
  });
});
