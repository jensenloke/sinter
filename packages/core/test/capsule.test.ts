import { beforeAll, describe, expect, test } from "bun:test";
import {
  CAPSULE_AAD_SCHEMA,
  CAPSULE_HEADER_SCHEMA,
  CAPSULE_LINEAGE_SCHEMA,
  CAPSULE_MANIFEST_SCHEMA,
  CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES,
  CAPSULE_MAX_RECIPIENTS,
  CAPSULE_PART_SCHEMA,
  CAPSULE_PAYLOAD_SCHEMA,
  CAPSULE_RECIPIENT_SCHEMA,
  CAPSULE_RFC9180_SUITE_IDS,
  CAPSULE_SCHEMA,
  CAPSULE_SUITE,
  CapsuleReplayError,
  MemoryCapsuleReplayGuard,
  canonicalCapsuleJson,
  capsulePartAad,
  capsuleRecipientAad,
  capsuleRecipientFingerprint,
  createSyntheticCapsule,
  openSyntheticCapsule,
  parseSyntheticCapsule,
  serializeSyntheticCapsule,
  type CapsuleManifest,
  type CapsuleRecipientIdentity,
  type P256PrivateJwk,
  type P256PublicJwk,
  type SyntheticCapsule,
  type SyntheticCapsulePayload,
} from "../src/index";

interface TestIdentity extends CapsuleRecipientIdentity {
  encryptionPublicKey: JsonWebKey;
  encryptionPrivateKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
  fingerprint: string;
}

interface VectorFixture {
  provenance: {
    kind: string;
    generator: string;
    implementation: string;
    standard: string;
    suiteIds: { mode: number; kem: number; kdf: number; aead: number };
    note: string;
  };
  inputs: {
    capsuleId: string;
    createdAt: string;
    recipientEncryptionPublicKey: P256PublicJwk;
    recipientEncryptionPrivateKey: P256PrivateJwk;
    recipientSigningPublicKey: P256PublicJwk;
    randomStreamStartHex: string;
    hpkeEphemeralIkmHex: string;
    manifest: CapsuleManifest;
    payload: SyntheticCapsulePayload;
  };
  expected: { fingerprint: string; serializedUtf8Base64Url: string };
}

const vector = await Bun.file(new URL("./capsule-vector.json", import.meta.url)).json() as VectorFixture;
const enc = new TextEncoder();
let identities: TestIdentity[];

function syntheticManifest(title = "Synthetic capsule title"): CapsuleManifest {
  return {
    schema: CAPSULE_MANIFEST_SCHEMA,
    title,
    harness: "codex",
    lineage: { schema: CAPSULE_LINEAGE_SCHEMA, threadId: "synthetic-thread", hop: 1 },
  };
}

function syntheticPayload(text = "Synthetic prompt content"): SyntheticCapsulePayload {
  return {
    schema: CAPSULE_PAYLOAD_SCHEMA,
    synthetic: true,
    sif: {
      sif: "sif/0",
      id: "synthetic-sif-id",
      origin: { harness: "codex", nativeId: "synthetic-native-id" },
      cwd: "/synthetic/project",
      createdAt: "2030-04-05T06:07:08.000Z",
      entries: [
        {
          kind: "user",
          id: "synthetic-entry-1",
          parentId: null,
          ts: "2030-04-05T06:07:08.000Z",
          content: [{ type: "text", text }],
          synthetic: true,
        },
      ],
    },
  };
}

async function identity(): Promise<TestIdentity> {
  const [encryption, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  ]);
  const [encryptionPublicKey, encryptionPrivateKey, signingPublicKey] = await Promise.all([
    crypto.subtle.exportKey("jwk", encryption.publicKey),
    crypto.subtle.exportKey("jwk", encryption.privateKey),
    crypto.subtle.exportKey("jwk", signing.publicKey),
  ]);
  return {
    encryptionPublicKey,
    encryptionPrivateKey,
    signingPublicKey,
    fingerprint: await capsuleRecipientFingerprint(encryptionPublicKey, signingPublicKey),
  };
}

beforeAll(async () => {
  identities = await Promise.all([identity(), identity(), identity()]);
});

function recipient(value: TestIdentity): CapsuleRecipientIdentity {
  return {
    encryptionPublicKey: value.encryptionPublicKey,
    signingPublicKey: value.signingPublicKey,
    fingerprint: value.fingerprint,
  };
}

async function capsule(recipients = [recipient(identities[0]!)], title?: string, text?: string): Promise<SyntheticCapsule> {
  return createSyntheticCapsule({
    manifest: syntheticManifest(title),
    payload: syntheticPayload(text),
    recipients,
  });
}

function openIdentity(value: TestIdentity, fingerprint = value.fingerprint) {
  return { fingerprint, encryptionPrivateKey: value.encryptionPrivateKey };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function flipBase64Url(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] = bytes[0]! ^ 1;
  return bytes.toString("base64url");
}

async function hash(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(Buffer.from(value, "base64url")))).toString("hex");
}

async function expectRejected(value: unknown, pattern?: RegExp): Promise<void> {
  const assertion = expect(openSyntheticCapsule(value, openIdentity(identities[0]!))).rejects;
  if (pattern) await assertion.toThrow(pattern);
  else await assertion.toThrow();
}

function deletePath(value: unknown, path: string): void {
  const parts = path.split(".");
  let parent = value as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  delete parent[parts.at(-1)!];
}

describe("C2 schemas and deterministic vector", () => {
  test("publishes the exact RFC 9180 suite identifiers and canonical AAD contract", () => {
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

  test("matches the checked-in project-generated deterministic vector byte-for-byte", async () => {
    let offset = 0;
    const randomBytes = (length: number) => {
      const bytes = Uint8Array.from({ length }, (_, index) => (0x40 + offset + index) & 0xff);
      offset += length;
      return bytes;
    };
    const generated = await createSyntheticCapsule({
      manifest: vector.inputs.manifest,
      payload: vector.inputs.payload,
      recipients: [{
        encryptionPublicKey: vector.inputs.recipientEncryptionPublicKey,
        signingPublicKey: vector.inputs.recipientSigningPublicKey,
      }],
    }, {
      capsuleId: vector.inputs.capsuleId,
      now: () => new Date(vector.inputs.createdAt),
      randomBytes,
      hpkeEphemeralKeyMaterial: () => new Uint8Array(Buffer.from(vector.inputs.hpkeEphemeralIkmHex, "hex")),
    });
    const serialized = serializeSyntheticCapsule(generated);
    expect(generated.recipients[0]!.fingerprint).toBe(vector.expected.fingerprint);
    expect(Buffer.from(serialized).toString("base64url")).toBe(vector.expected.serializedUtf8Base64Url);
    expect(await openSyntheticCapsule(serialized, {
      fingerprint: vector.expected.fingerprint,
      encryptionPrivateKey: vector.inputs.recipientEncryptionPrivateKey,
    })).toEqual({ manifest: vector.inputs.manifest, payload: vector.inputs.payload });
  });

  test("labels the vector accurately and contains synthetic data only", () => {
    expect(vector.provenance).toEqual({
      kind: "project-generated",
      generator: "@sinter/core createSyntheticCapsule",
      implementation: "@hpke/core@1.9.0",
      standard: "RFC 9180",
      suiteIds: CAPSULE_RFC9180_SUITE_IDS,
      note: "Self-generated deterministic project vector; not an RFC-published test vector.",
    });
    const fixtureText = JSON.stringify(vector);
    expect(vector.inputs.payload.synthetic).toBe(true);
    expect(fixtureText).not.toContain("/Users/");
    expect(fixtureText).not.toContain("github.com/");
    expect(fixtureText).not.toContain("messageCount");
    expect(fixtureText.toLowerCase()).toContain("synthetic");
  });
});

describe("C2 encryption and identity", () => {
  test("round-trips a synthetic SIF payload and encrypted manifest", async () => {
    const value = await capsule();
    const opened = await openSyntheticCapsule(serializeSyntheticCapsule(value), openIdentity(identities[0]!));
    expect(opened).toEqual({ manifest: syntheticManifest(), payload: syntheticPayload() });
  });

  test("decrypts independently for every recipient and sorts envelopes by fingerprint", async () => {
    const value = await capsule([recipient(identities[2]!), recipient(identities[0]!), recipient(identities[1]!)]);
    expect(value.recipients.map((item) => item.fingerprint)).toEqual(
      identities.map((item) => item.fingerprint).sort(),
    );
    for (const item of identities) {
      expect((await openSyntheticCapsule(value, openIdentity(item))).payload.sif.id).toBe("synthetic-sif-id");
    }
  });

  test("matches the Phase 1 canonical minimal-key fingerprint contract", async () => {
    const item = identities[0]!;
    const minimal = (key: JsonWebKey) => ({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
    const canonical = canonicalCapsuleJson({
      encryptionPublicKey: minimal(item.encryptionPublicKey),
      signingPublicKey: minimal(item.signingPublicKey),
    });
    const expected = Buffer.from(await crypto.subtle.digest("SHA-256", enc.encode(canonical))).toString("hex");
    expect(await capsuleRecipientFingerprint(item.encryptionPublicKey, item.signingPublicKey)).toBe(expected);
  });

  test("serialized public data leaks no manifest or SIF plaintext", async () => {
    const secrets = [
      "PRIVATE SYNTHETIC TITLE 9ebc",
      "PRIVATE SYNTHETIC PROMPT 84ba",
      "/private/synthetic/repository-77",
      "synthetic-native-secret-31",
    ];
    const payload = syntheticPayload(secrets[1]);
    payload.sif.cwd = secrets[2]!;
    payload.sif.origin.nativeId = secrets[3]!;
    const value = await createSyntheticCapsule({
      manifest: syntheticManifest(secrets[0]),
      payload,
      recipients: [recipient(identities[0]!)],
    });
    const serialized = serializeSyntheticCapsule(value);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('"title"');
    expect(serialized).not.toContain('"harness":"codex"');
    expect(serialized).not.toContain("messageCount");
    expect(Object.keys(JSON.parse(serialized)).sort()).toEqual(["header", "manifest", "payload", "recipients", "schema"]);
  });

  test("rejects a missing recipient and a wrong private key", async () => {
    const value = await capsule();
    await expect(openSyntheticCapsule(value, openIdentity(identities[1]!))).rejects.toThrow(/no envelope/);
    await expect(openSyntheticCapsule(value, {
      fingerprint: identities[0]!.fingerprint,
      encryptionPrivateKey: identities[1]!.encryptionPrivateKey,
    })).rejects.toThrow(/unwrap failed/);
  });

  test("rejects duplicate identities at creation and duplicate or unsorted envelopes on parse", async () => {
    await expect(capsule([recipient(identities[0]!), recipient(identities[0]!)])).rejects.toThrow(/duplicate/);
    const one = await capsule();
    const duplicate = clone(one);
    duplicate.recipients.push(clone(duplicate.recipients[0]!));
    await expect(parseSyntheticCapsule(duplicate)).rejects.toThrow(/duplicate/);
    const several = await capsule([recipient(identities[0]!), recipient(identities[1]!)]);
    several.recipients.reverse();
    await expect(parseSyntheticCapsule(several)).rejects.toThrow(/sorted/);
  });

  test("normalizes accepted metadata but rejects malformed JWKs and mismatched fingerprints", async () => {
    const item = identities[0]!;
    await expect(capsuleRecipientFingerprint(
      { ...item.encryptionPublicKey, d: (item.encryptionPrivateKey as JsonWebKey).d },
      item.signingPublicKey,
    )).rejects.toThrow(/unsupported fields|private/);
    await expect(createSyntheticCapsule({
      manifest: syntheticManifest(),
      payload: syntheticPayload(),
      recipients: [{ ...recipient(item), fingerprint: item.fingerprint.toUpperCase() }],
    })).rejects.toThrow(/lowercase/);
    await expect(createSyntheticCapsule({
      manifest: syntheticManifest(),
      payload: syntheticPayload(),
      recipients: [{ ...recipient(item), fingerprint: "0".repeat(64) }],
    })).rejects.toThrow(/does not match/);
    await expect(openSyntheticCapsule(await capsule(), {
      fingerprint: item.fingerprint,
      encryptionPrivateKey: { ...item.encryptionPrivateKey, d: undefined },
    })).rejects.toThrow();
  });
});

describe("C2 authenticated binding and tamper rejection", () => {
  test("rejects tampering of every public value field", async () => {
    const original = await capsule();
    const mutations: Array<(value: SyntheticCapsule) => void> = [
      (value) => { (value as { schema: string }).schema = "sinter.capsule.v2"; },
      (value) => { (value.header as { schema: string }).schema = "sinter.capsule.header.v2"; },
      (value) => { value.header.capsuleId = Buffer.alloc(16, 9).toString("base64url"); },
      (value) => { value.header.createdAt = "2031-01-02T03:04:05.000Z"; },
      (value) => { (value.header as { suite: string }).suite = "unsupported"; },
      (value) => { (value.manifest as { schema: string }).schema = "sinter.capsule.part.v2"; },
      (value) => { (value.manifest as { kind: string }).kind = "payload"; },
      (value) => { value.manifest.nonce = flipBase64Url(value.manifest.nonce); },
      (value) => { value.manifest.ciphertext = flipBase64Url(value.manifest.ciphertext); },
      (value) => { value.manifest.ciphertextBytes += 1; },
      (value) => { value.manifest.ciphertextSha256 = "0".repeat(64); },
      (value) => { (value.payload as { schema: string }).schema = "sinter.capsule.part.v2"; },
      (value) => { (value.payload as { kind: string }).kind = "manifest"; },
      (value) => { value.payload.nonce = flipBase64Url(value.payload.nonce); },
      (value) => { value.payload.ciphertext = flipBase64Url(value.payload.ciphertext); },
      (value) => { value.payload.ciphertextBytes += 1; },
      (value) => { value.payload.ciphertextSha256 = "0".repeat(64); },
      (value) => { (value.recipients[0] as { schema: string }).schema = "sinter.capsule.recipient.v2"; },
      (value) => { value.recipients[0]!.fingerprint = "0".repeat(64); },
      (value) => { value.recipients[0]!.encapsulation = flipBase64Url(value.recipients[0]!.encapsulation); },
      (value) => { value.recipients[0]!.wrappedKey = flipBase64Url(value.recipients[0]!.wrappedKey); },
    ];
    for (const mutate of mutations) {
      const changed = clone(original);
      mutate(changed);
      await expectRejected(changed);
    }
  });

  test("rejects every missing public field", async () => {
    const original = await capsule();
    const paths = [
      "schema", "header", "manifest", "payload", "recipients",
      "header.schema", "header.capsuleId", "header.createdAt", "header.suite",
      "manifest.schema", "manifest.kind", "manifest.nonce", "manifest.ciphertext", "manifest.ciphertextBytes", "manifest.ciphertextSha256",
      "payload.schema", "payload.kind", "payload.nonce", "payload.ciphertext", "payload.ciphertextBytes", "payload.ciphertextSha256",
      "recipients.0.schema", "recipients.0.fingerprint", "recipients.0.encapsulation", "recipients.0.wrappedKey",
    ];
    for (const path of paths) {
      const changed = clone(original);
      deletePath(changed, path);
      await expect(parseSyntheticCapsule(changed), path).rejects.toThrow();
    }
  });

  test("rejects ciphertext tampering even when the attacker recomputes public hashes", async () => {
    for (const kind of ["manifest", "payload"] as const) {
      const changed = clone(await capsule());
      changed[kind].ciphertext = flipBase64Url(changed[kind].ciphertext);
      changed[kind].ciphertextSha256 = await hash(changed[kind].ciphertext);
      await expectRejected(changed, /authentication failed/);
    }
  });

  test("rejects truncated ciphertext with internally consistent count and hash", async () => {
    const changed = clone(await capsule());
    const bytes = Buffer.from(changed.payload.ciphertext, "base64url").subarray(0, -1);
    changed.payload.ciphertext = bytes.toString("base64url");
    changed.payload.ciphertextBytes = bytes.length;
    changed.payload.ciphertextSha256 = await hash(changed.payload.ciphertext);
    await expectRejected(changed, /authentication failed/);
  });

  test("binds manifest and payload roles so complete part swaps fail", async () => {
    const changed = clone(await capsule());
    const manifestFields = {
      nonce: changed.manifest.nonce,
      ciphertext: changed.manifest.ciphertext,
      ciphertextBytes: changed.manifest.ciphertextBytes,
      ciphertextSha256: changed.manifest.ciphertextSha256,
    };
    Object.assign(changed.manifest, {
      nonce: changed.payload.nonce,
      ciphertext: changed.payload.ciphertext,
      ciphertextBytes: changed.payload.ciphertextBytes,
      ciphertextSha256: changed.payload.ciphertextSha256,
    });
    Object.assign(changed.payload, manifestFields);
    await expectRejected(changed, /authentication failed/);
  });

  test("binds parts, envelopes, and CEK wraps to the capsule ID and static header", async () => {
    const first = await capsule();
    const second = await capsule();
    const swappedPart = clone(first);
    swappedPart.payload = clone(second.payload);
    await expectRejected(swappedPart);
    const swappedEnvelope = clone(first);
    swappedEnvelope.recipients[0] = clone(second.recipients[0]!);
    await expectRejected(swappedEnvelope, /unwrap failed/);
  });
});

describe("C2 malformed, bounded, and versioned parsing", () => {
  test("rejects malformed JSON, base64url, truncation, and unknown fields", async () => {
    await expect(parseSyntheticCapsule("{"), "malformed JSON").rejects.toThrow(/malformed JSON/);
    const malformed = clone(await capsule());
    malformed.manifest.nonce = "not+base64______";
    await expect(parseSyntheticCapsule(malformed)).rejects.toThrow(/base64url/);
    const badEncapsulation = clone(await capsule());
    badEncapsulation.recipients[0]!.encapsulation = badEncapsulation.recipients[0]!.encapsulation.slice(1);
    await expect(parseSyntheticCapsule(badEncapsulation)).rejects.toThrow(/invalid length|invalid size/);
    const extra = clone(await capsule()) as SyntheticCapsule & { title?: string };
    extra.title = "public plaintext forbidden";
    await expect(parseSyntheticCapsule(extra)).rejects.toThrow(/unsupported fields/);
  });

  test("rejects noncanonical and invalid timestamps before cryptography", async () => {
    for (const createdAt of ["2030-01-02T03:04:05Z", "2030-02-30T03:04:05.000Z", "not-a-time"]) {
      const changed = clone(await capsule());
      changed.header.createdAt = createdAt;
      await expect(parseSyntheticCapsule(changed)).rejects.toThrow(/timestamp|noncanonical|invalid/);
    }
  });

  test("rejects oversized individual metadata and the 16 MiB combined ciphertext cap", async () => {
    const metadata = clone(await capsule());
    metadata.payload.ciphertextBytes = CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES + 1;
    await expect(parseSyntheticCapsule(metadata)).rejects.toThrow(/byte count/);

    const combined = clone(await capsule());
    const halfPlusOne = CAPSULE_MAX_COMBINED_CIPHERTEXT_BYTES / 2 + 1;
    const oversizedCiphertext = Buffer.alloc(halfPlusOne).toString("base64url");
    for (const part of [combined.manifest, combined.payload]) {
      part.ciphertext = oversizedCiphertext;
      part.ciphertextBytes = halfPlusOne;
      part.ciphertextSha256 = "0".repeat(64);
    }
    await expect(parseSyntheticCapsule(combined)).rejects.toThrow(/combined ciphertext/);
  });

  test("rejects more than 32 recipient envelopes before envelope processing", async () => {
    const changed = clone(await capsule());
    changed.recipients = Array.from({ length: CAPSULE_MAX_RECIPIENTS + 1 }, () => clone(changed.recipients[0]!));
    await expect(parseSyntheticCapsule(changed)).rejects.toThrow(/too many/);
    await expect(capsule(Array.from({ length: CAPSULE_MAX_RECIPIENTS + 1 }, () => recipient(identities[0]!)))).rejects.toThrow(/too many/);
  });

  test("rejects unsupported outer, header, part, recipient, manifest, lineage, payload, and SIF versions", async () => {
    const versionPaths: Array<[string, (value: SyntheticCapsule) => void]> = [
      ["outer", (value) => { (value as { schema: string }).schema = `${CAPSULE_SCHEMA}.next`; }],
      ["header", (value) => { (value.header as { schema: string }).schema = `${CAPSULE_HEADER_SCHEMA}.next`; }],
      ["part", (value) => { (value.payload as { schema: string }).schema = `${CAPSULE_PART_SCHEMA}.next`; }],
      ["recipient", (value) => { (value.recipients[0] as { schema: string }).schema = `${CAPSULE_RECIPIENT_SCHEMA}.next`; }],
    ];
    const original = await capsule();
    for (const [, mutate] of versionPaths) {
      const changed = clone(original);
      mutate(changed);
      await expect(parseSyntheticCapsule(changed)).rejects.toThrow(/Unsupported/);
    }
    await expect(createSyntheticCapsule({
      manifest: { ...syntheticManifest(), schema: "sinter.capsule.manifest.v2" } as never,
      payload: syntheticPayload(),
      recipients: [recipient(identities[0]!)],
    })).rejects.toThrow(/manifest schema/);
    await expect(createSyntheticCapsule({
      manifest: { ...syntheticManifest(), lineage: { ...syntheticManifest().lineage!, schema: "sinter.capsule.lineage-hint.v2" } } as never,
      payload: syntheticPayload(),
      recipients: [recipient(identities[0]!)],
    })).rejects.toThrow(/lineage schema/);
    await expect(createSyntheticCapsule({
      manifest: syntheticManifest(),
      payload: { ...syntheticPayload(), schema: "sinter.capsule.synthetic-sif.v2" } as never,
      recipients: [recipient(identities[0]!)],
    })).rejects.toThrow(/nonsynthetic/);
    const badSif = syntheticPayload();
    (badSif.sif as { sif: string }).sif = "sif/1";
    await expect(createSyntheticCapsule({
      manifest: syntheticManifest(), payload: badSif, recipients: [recipient(identities[0]!)],
    })).rejects.toThrow(/SIF.*schema/);
  });

  test("strictly rejects unknown decrypted manifest, payload, and nested SIF fields at creation", async () => {
    await expect(createSyntheticCapsule({
      manifest: { ...syntheticManifest(), repository: "forbidden-shape" } as never,
      payload: syntheticPayload(),
      recipients: [recipient(identities[0]!)],
    })).rejects.toThrow(/unsupported fields/);
    await expect(createSyntheticCapsule({
      manifest: syntheticManifest(),
      payload: { ...syntheticPayload(), extra: true } as never,
      recipients: [recipient(identities[0]!)],
    })).rejects.toThrow(/unsupported fields/);
    const payload = syntheticPayload() as SyntheticCapsulePayload & { sif: SyntheticCapsulePayload["sif"] & { messageCount?: number } };
    payload.sif.messageCount = 1;
    await expect(createSyntheticCapsule({
      manifest: syntheticManifest(), payload, recipients: [recipient(identities[0]!)],
    })).rejects.toThrow(/unsupported fields/);
  });
});

describe("C2 replay guard", () => {
  test("accepts a valid capsule once and rejects its capsule-id + payload-hash replay", async () => {
    const value = await capsule();
    const guard = new MemoryCapsuleReplayGuard();
    await expect(openSyntheticCapsule(value, openIdentity(identities[0]!), { replayGuard: guard })).resolves.toBeDefined();
    await expect(openSyntheticCapsule(value, openIdentity(identities[0]!), { replayGuard: guard })).rejects.toBeInstanceOf(CapsuleReplayError);
  });

  test("does not claim stateless cryptography alone detects replay", async () => {
    const value = await capsule();
    await expect(openSyntheticCapsule(value, openIdentity(identities[0]!))).resolves.toBeDefined();
    await expect(openSyntheticCapsule(value, openIdentity(identities[0]!))).resolves.toBeDefined();
  });
});
