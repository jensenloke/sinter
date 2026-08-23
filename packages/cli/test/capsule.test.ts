import { describe, expect, test } from "bun:test";
import { session } from "../../ledger/test/mock-adapter";
import {
  CapsuleError,
  decryptCapsule,
  encryptCapsule,
  findSensitiveContent,
  makeCapsulePayload,
} from "../src/capsule";

const PASSPHRASE = "correct horse battery staple";

describe("encrypted session capsules", () => {
  test("round-trips a valid SIF without plaintext metadata in the envelope", () => {
    const source = session("private-native-id");
    source.cwd = "/Users/private/secret-project";
    source.title = { text: "confidential acquisition", source: "user" };
    const serialized = encryptCapsule(makeCapsulePayload(source, "slim", "2026-08-24T00:00:00.000Z"), PASSPHRASE);
    expect(serialized).toContain('"format": "sinter-capsule"');
    expect(serialized).not.toContain("private-native-id");
    expect(serialized).not.toContain("secret-project");
    expect(serialized).not.toContain("confidential acquisition");
    expect(decryptCapsule(serialized, PASSPHRASE)).toEqual(
      makeCapsulePayload(source, "slim", "2026-08-24T00:00:00.000Z"),
    );
  });

  test("uses fresh salt and IV for every encryption", () => {
    const payload = makeCapsulePayload(session("same"), "full", "2026-08-24T00:00:00.000Z");
    expect(encryptCapsule(payload, PASSPHRASE)).not.toBe(encryptCapsule(payload, PASSPHRASE));
  });

  test("fails closed for a wrong passphrase or tampered ciphertext", () => {
    const serialized = encryptCapsule(
      makeCapsulePayload(session("locked"), "compact", "2026-08-24T00:00:00.000Z"),
      PASSPHRASE,
    );
    expect(() => decryptCapsule(serialized, "this passphrase is wrong")).toThrow("wrong passphrase or damaged file");
    const envelope = JSON.parse(serialized);
    envelope.payload = `${envelope.payload.slice(0, -5)}AAAA=`;
    expect(() => decryptCapsule(JSON.stringify(envelope), PASSPHRASE)).toThrow(CapsuleError);
  });

  test("requires a non-trivial passphrase", () => {
    expect(() => encryptCapsule(makeCapsulePayload(session("x"), "slim", new Date(0).toISOString()), "too-short"))
      .toThrow("at least 12 characters");
  });

  test("reports sensitive categories without returning secret values", () => {
    const source = session("secrets");
    source.entries[0] = {
      ...source.entries[0]!,
      kind: "user",
      content: [{ type: "text", text: 'api_key="sk-abcdefghijklmnopqrstuvwxyz123456"' }],
    } as typeof source.entries[0];
    const findings = findSensitiveContent(source);
    expect(findings.map((finding) => finding.category)).toContain("api-key");
    expect(findings.map((finding) => finding.category)).toContain("credential-assignment");
    expect(JSON.stringify(findings)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  test("rejects unsupported versions", () => {
    expect(() => decryptCapsule('{"format":"sinter-capsule","version":2}', PASSPHRASE)).toThrow(
      "unsupported capsule version: 2",
    );
  });
});
