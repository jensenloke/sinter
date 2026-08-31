import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CAPSULE_MAX_SERIALIZED_BYTES,
  CAPSULE_SCHEMA,
  CAPSULE_SESSION_PAYLOAD_SCHEMA,
  capsuleRequestBodySha256,
  capsuleRequestProofBytes,
  parseSyntheticCapsule,
} from "@sinter/core";
import {
  CLOUD_CAPSULE_DOWNLOAD_REQUEST_SCHEMA,
  CLOUD_CAPSULE_FINALIZE_SCHEMA,
  CLOUD_CAPSULE_RESERVE_SCHEMA,
  createCloudCapsuleApiClient,
  createCloudCapsuleService,
  type CloudCapsuleApiClient,
  type CloudCapsuleMetadata,
} from "../src/cloud-capsules";
import type { CloudDeviceApiClient, CloudDeviceIdentity } from "../src/cloud-devices";
import type { DeviceCredentialStore } from "../src/device-credentials";
import {
  DEVICE_CRYPTO_SUITE,
  deviceFingerprint,
  generateDeviceKeyMaterial,
  type DeviceKeyMaterial,
} from "../src/device-identity";
import {
  REPOSITORY_BINDING_PREVIEW_SCHEMA,
  REPOSITORY_BINDING_SCHEMA,
  SESSION_TRANSFER_SCHEMA,
  RepositoryBindingError,
  parseSessionTransferPayload,
  sanitizeSessionForNetwork,
  serializeSessionTransferPayload,
  type RepositoryBindingService,
} from "../src/repository-binding";
import { StaticAdapterRegistry, type AdapterRegistry } from "../src/adapters";
import type { Ctx } from "../src/commands";
import { palette } from "../src/format";
import { run } from "../src/main";
import type { CloudCapsuleService, OpenedCloudCapsule } from "../src/cloud-capsules";
import { Ledger } from "@sinter/ledger";
import { MockAdapter, session, summary } from "../../ledger/test/mock-adapter";

const LOCAL_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-30T00:00:00.000Z";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function identity(id: string): Promise<{ material: DeviceKeyMaterial; device: CloudDeviceIdentity }> {
  const generated = await generateDeviceKeyMaterial();
  const material = { ...generated, deviceId: id };
  const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
  return {
    material,
    device: {
      id,
      name: "Synthetic Device",
      fingerprint,
      suite: DEVICE_CRYPTO_SUITE,
      status: "active",
      revokedAt: null,
      encryptionPublicKey: material.encryptionPublicKey,
      signingPublicKey: material.signingPublicKey,
    },
  };
}

function keyStore(material: DeviceKeyMaterial): DeviceCredentialStore {
  return {
    description: "synthetic keys",
    async load() { return material; },
    async save() {},
    async delete() {},
  };
}

function deviceApi(devices: CloudDeviceIdentity[]): CloudDeviceApiClient {
  return {
    async listDevices() { return devices; },
    async listDeviceIdentities() { return devices; },
    async registerDevice() { throw new Error("not used"); },
    async renameDevice() {},
    async revokeDevice() {},
    async listEnrollments() { return []; },
    async approveEnrollment() {},
  };
}

function transferFixture() {
  const repository = {
    schema: REPOSITORY_BINDING_SCHEMA,
    remotes: [{ host: "github.com", path: "example/synthetic" }],
    selectedRemote: { host: "github.com", path: "example/synthetic" },
    commit: "a".repeat(40),
    branch: "feat/synthetic",
    relativeCwd: "",
  } as const;
  const safe = sanitizeSessionForNetwork(session("synthetic-cloud"));
  return parseSessionTransferPayload(serializeSessionTransferPayload(safe, repository));
}

function metadataFrom(input: Record<string, unknown>, status: CloudCapsuleMetadata["status"]): CloudCapsuleMetadata {
  return {
    id: input.capsuleId as string,
    serializedBytes: input.serializedBytes as number,
    serializedSha256: input.serializedSha256 as string,
    outerSchema: input.outerSchema as string,
    payloadSchema: input.payloadSchema as string,
    transferSchema: input.transferSchema as string,
    senderFingerprint: input.senderFingerprint as string,
    recipientFingerprints: input.recipientFingerprints as string[],
    recipientCount: (input.recipientFingerprints as string[]).length,
    status,
    reservedAt: NOW,
    reservationExpiresAt: "2026-08-30T00:10:00.000Z",
    finalizedAt: status === "retained" || status === "deleted" ? NOW : null,
    deletionRequestedAt: status === "deleted" ? NOW : null,
    storageDeletedAt: status === "deleted" ? NOW : null,
    expiredAt: null,
  };
}

function memoryApi() {
  let stored = new Uint8Array();
  let metadata: CloudCapsuleMetadata | undefined;
  const calls: string[] = [];
  let uploadFailure = false;
  let finalizeFailure = false;
  const api: CloudCapsuleApiClient = {
    async request(method, path, body) {
      calls.push(`${method} ${path}`);
      if (method === "POST" && path === "/api/cli/capsules") {
        const input = body as Record<string, unknown>;
        expect(input.schema).toBe(CLOUD_CAPSULE_RESERVE_SCHEMA);
        metadata = metadataFrom(input, "reserved");
        return {
          schema: "sinter.cloud.capsule-reservation.v1",
          ok: true,
          capsule: metadata,
          upload: { url: "https://storage.example.test/signed?token=secret", method: "PUT", contentType: "application/octet-stream" },
        };
      }
      if (method === "POST" && path.endsWith("/finalize")) {
        if (finalizeFailure) throw new Error("synthetic finalize token=secret");
        expect((body as Record<string, unknown>).schema).toBe(CLOUD_CAPSULE_FINALIZE_SCHEMA);
        metadata = { ...metadata!, status: "retained", finalizedAt: NOW };
        return { schema: "sinter.cloud.capsule-finalization.v1", ok: true, capsule: metadata };
      }
      if (method === "GET" && path === "/api/cli/capsules") {
        return { schema: "sinter.cloud.capsules.v1", ok: true, capsules: metadata?.status === "retained" ? [metadata] : [] };
      }
      if (method === "POST" && path.endsWith("/download")) {
        expect((body as Record<string, unknown>).schema).toBe(CLOUD_CAPSULE_DOWNLOAD_REQUEST_SCHEMA);
        return {
          schema: "sinter.cloud.capsule-download.v1",
          ok: true,
          capsule: metadata,
          download: { url: "https://storage.example.test/signed-download?token=secret", expiresInSeconds: 60 },
        };
      }
      if (method === "DELETE") {
        metadata = { ...metadata!, status: "deleted", deletionRequestedAt: NOW, storageDeletedAt: NOW };
        return { schema: "sinter.cloud.capsule-deletion.v1", ok: true, capsule: metadata };
      }
      throw new Error(`unexpected API call ${method} ${path}`);
    },
    async upload(_url, bytes) {
      calls.push("PUT storage");
      if (uploadFailure) throw new Error("synthetic signed URL secret");
      stored = new Uint8Array(bytes);
    },
    async download(_url, expectedBytes, maximumBytes) {
      calls.push("GET storage");
      expect(expectedBytes).toBe(metadata!.serializedBytes);
      expect(maximumBytes).toBe(CAPSULE_MAX_SERIALIZED_BYTES);
      return new Uint8Array(stored);
    },
  };
  return {
    api,
    calls,
    stored: () => stored,
    metadata: () => metadata!,
    setMetadata(next: CloudCapsuleMetadata) { metadata = next; },
    setStored(next: Uint8Array) { stored = new Uint8Array(next); },
    failUpload() { uploadFailure = true; },
    failFinalize() { finalizeFailure = true; },
  };
}

async function serviceHarness() {
  const local = await identity(LOCAL_ID);
  const other = await identity(OTHER_ID);
  const memory = memoryApi();
  const service = createCloudCapsuleService({
    api: memory.api,
    keys: keyStore(local.material),
    devices: deviceApi([other.device, local.device]),
  });
  return { local, other, memory, service };
}

async function pushRetained(harness: Awaited<ReturnType<typeof serviceHarness>>, to?: string) {
  return harness.service.push({
    transfer: transferFixture(),
    manifest: { schema: "sinter.capsule.manifest.v1", title: "Synthetic capsule", harness: "claude" },
    ...(to ? { to } : {}),
  });
}

describe("Cloud capsule request proof client", () => {
  test("signs exact empty-body bytes and sends every required auth and proof header", async () => {
    const local = await identity(LOCAL_ID);
    const calls: Array<{ headers: Headers; body: BodyInit | null | undefined; redirect: RequestRedirect | undefined }> = [];
    const api = createCloudCapsuleApiClient({
      auth: { async apiSession() { return { baseUrl: "https://cloud.example.test", accessToken: "access-secret", idToken: "id-secret" }; } },
      keys: keyStore(local.material),
      now: () => new Date(NOW),
      randomBytes: () => new Uint8Array(32).fill(7),
      fetch: async (_input, init) => {
        calls.push({ headers: new Headers(init?.headers), body: init?.body, redirect: init?.redirect });
        return Response.json({ schema: "sinter.cloud.capsules.v1", ok: true, capsules: [] });
      },
    });
    await api.request("GET", "/api/cli/capsules");
    const headers = calls[0]!.headers;
    expect(headers.get("authorization")).toBe("Bearer access-secret");
    expect(headers.get("x-sinter-id-token")).toBe("id-secret");
    expect(headers.get("x-sinter-device-id")).toBe(LOCAL_ID);
    expect(headers.get("x-sinter-request-timestamp")).toBe(NOW);
    expect(headers.get("x-sinter-request-nonce")).toBe(Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"));
    expect(headers.get("x-sinter-request-signature")).toHaveLength(86);
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.redirect).toBe("error");

    const publicKey = await crypto.subtle.importKey("jwk", local.material.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      Buffer.from(headers.get("x-sinter-request-signature")!, "base64url"),
      new Uint8Array(capsuleRequestProofBytes({
        deviceId: LOCAL_ID,
        method: "GET",
        pathname: "/api/cli/capsules",
        bodySha256: capsuleRequestBodySha256(new Uint8Array()),
        timestamp: NOW,
        nonce: headers.get("x-sinter-request-nonce")!,
      })),
    );
    expect(verified).toBe(true);
  });

  test("binds the proof to canonical exact POST body bytes so tampering fails verification", async () => {
    const local = await identity(LOCAL_ID);
    let captured!: { headers: Headers; bytes: Uint8Array };
    const api = createCloudCapsuleApiClient({
      auth: { async apiSession() { return { baseUrl: "https://cloud.example.test", accessToken: "access", idToken: "id" }; } },
      keys: keyStore(local.material),
      now: () => new Date(NOW),
      randomBytes: () => new Uint8Array(32).fill(9),
      fetch: async (_input, init) => {
        captured = { headers: new Headers(init?.headers), bytes: new Uint8Array(await new Response(init?.body).arrayBuffer()) };
        return Response.json({ schema: "sinter.cloud.capsule-finalization.v1", ok: true, capsule: {} });
      },
    });
    const body = { schema: CLOUD_CAPSULE_FINALIZE_SCHEMA, serializedBytes: 10, serializedSha256: "a".repeat(64) };
    await api.request("POST", "/api/cli/capsules/AAAAAAAAAAAAAAAAAAAAAA/finalize", body);
    expect(new TextDecoder().decode(captured.bytes)).toBe('{"schema":"sinter.cloud.capsule-finalize.v1","serializedBytes":10,"serializedSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}');
    const key = await crypto.subtle.importKey("jwk", local.material.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signature = Buffer.from(captured.headers.get("x-sinter-request-signature")!, "base64url");
    const input = (bytes: Uint8Array) => capsuleRequestProofBytes({
      deviceId: LOCAL_ID,
      method: "POST",
      pathname: "/api/cli/capsules/AAAAAAAAAAAAAAAAAAAAAA/finalize",
      bodySha256: capsuleRequestBodySha256(bytes),
      timestamp: NOW,
      nonce: captured.headers.get("x-sinter-request-nonce")!,
    });
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, new Uint8Array(input(captured.bytes)))).toBe(true);
    const tampered = new TextEncoder().encode(new TextDecoder().decode(captured.bytes).replace(":10", ":11"));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, new Uint8Array(input(tampered)))).toBe(false);
  });

  test("rejects non-root Cloud base URLs before fetch", async () => {
    const local = await identity(LOCAL_ID);
    for (const baseUrl of [
      "https://cloud.example.test/api",
      "https://cloud.example.test/?region=test",
      "https://cloud.example.test/?",
      "https://cloud.example.test/#fragment",
      "https://cloud.example.test/#",
      "https://user:password@cloud.example.test/",
    ]) {
      let fetches = 0;
      const api = createCloudCapsuleApiClient({
        auth: { async apiSession() { return { baseUrl, accessToken: "access-secret", idToken: "id-secret" }; } },
        keys: keyStore(local.material),
        fetch: async () => { fetches++; return new Response(); },
      });
      await expect(api.request("GET", "/api/cli/capsules")).rejects.toThrow("endpoint is invalid");
      expect(fetches).toBe(0);
    }
  });

  test("refuses control, upload, and download redirects with redirect mode error", async () => {
    const local = await identity(LOCAL_ID);
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const api = createCloudCapsuleApiClient({
      auth: { async apiSession() { return { baseUrl: "https://cloud.example.test/", accessToken: "access-secret", idToken: "id-secret" }; } },
      keys: keyStore(local.material),
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        return new Response(null, { status: 302, headers: { Location: "https://redirect.example.test/" } });
      },
    });
    await expect(api.request("GET", "/api/cli/capsules")).rejects.toThrow("capsule API redirect");
    await expect(api.upload("https://storage.example.test/upload?signature=secret", new Uint8Array([1]))).rejects.toThrow("capsule upload redirect");
    await expect(api.download("https://storage.example.test/download?signature=secret", 1, 1)).rejects.toThrow("capsule download redirect");
    expect(calls.map((call) => call.init?.redirect)).toEqual(["error", "error", "error"]);
  });

  test("keeps Auth0 and request-proof headers off distinct signed Storage origins", async () => {
    const local = await identity(LOCAL_ID);
    const calls: Array<{ input: string; headers: Headers }> = [];
    const api = createCloudCapsuleApiClient({
      auth: { async apiSession() { return { baseUrl: "https://cloud.example.test/", accessToken: "access-secret", idToken: "id-secret" }; } },
      keys: keyStore(local.material),
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ input: url, headers: new Headers(init?.headers) });
        if (url.startsWith("https://cloud.example.test/")) {
          return Response.json({ schema: "sinter.cloud.capsules.v1", ok: true, capsules: [] });
        }
        if (init?.method === "PUT") return new Response(null, { status: 200 });
        return new Response(new Uint8Array([7]), { status: 200, headers: { "Content-Length": "1" } });
      },
    });
    await api.request("GET", "/api/cli/capsules");
    await api.upload("https://uploads.storage.example.test/object?signature=upload-secret", new Uint8Array([1]));
    expect(await api.download("https://downloads.storage.example.test/object?signature=download-secret", 1, 1)).toEqual(new Uint8Array([7]));
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer access-secret");
    for (const call of calls.slice(1)) {
      expect(call.input).toStartWith("https://");
      expect(call.headers.get("authorization")).toBeNull();
      expect(call.headers.get("x-sinter-id-token")).toBeNull();
      expect(call.headers.get("x-sinter-device-id")).toBeNull();
      expect(call.headers.get("x-sinter-request-signature")).toBeNull();
    }
  });

  test("streams API JSON with an exact 2 MiB cap, cancellation, and strict decoding", async () => {
    const local = await identity(LOCAL_ID);
    const limit = 2 * 1024 * 1024;
    const exact = new TextEncoder().encode(`{"x":"${"a".repeat(limit - 8)}"}`);
    expect(exact.byteLength).toBe(limit);
    let overflowCancelled = false;
    let declaredCancelled = false;
    const responses = [
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(exact.subarray(0, 1024 * 1024));
          controller.enqueue(exact.subarray(1024 * 1024));
          controller.close();
        },
      })),
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(limit));
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() { overflowCancelled = true; },
      })),
      new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1])); },
        cancel() { declaredCancelled = true; },
      }), { headers: { "Content-Length": String(limit + 1) } }),
      new Response(new Uint8Array([0xff])),
      new Response("not-json"),
    ];
    const api = createCloudCapsuleApiClient({
      auth: { async apiSession() { return { baseUrl: "https://cloud.example.test/", accessToken: "access", idToken: "id" }; } },
      keys: keyStore(local.material),
      fetch: async () => responses.shift()!,
    });
    expect((await api.request("GET", "/api/cli/capsules") as { x: string }).x).toHaveLength(limit - 8);
    await expect(api.request("GET", "/api/cli/capsules")).rejects.toThrow("oversized");
    expect(overflowCancelled).toBe(true);
    await expect(api.request("GET", "/api/cli/capsules")).rejects.toThrow("oversized");
    expect(declaredCancelled).toBe(true);
    await expect(api.request("GET", "/api/cli/capsules")).rejects.toThrow("invalid capsule response");
    await expect(api.request("GET", "/api/cli/capsules")).rejects.toThrow("invalid capsule response");
  });
});

describe("Cloud capsule service", () => {
  test("push creates a real canonical session capsule for all active recipients and verifies final metadata", async () => {
    const harness = await serviceHarness();
    const result = await pushRetained(harness);
    expect(result.operation).toBe("push");
    expect(result.uploaded).toBe(true);
    expect(result.metadata.status).toBe("retained");
    expect(result.metadata.outerSchema).toBe(CAPSULE_SCHEMA);
    expect(result.metadata.payloadSchema).toBe(CAPSULE_SESSION_PAYLOAD_SCHEMA);
    expect(result.metadata.transferSchema).toBe(SESSION_TRANSFER_SCHEMA);
    const serialized = new TextDecoder().decode(harness.memory.stored());
    const capsule = await parseSyntheticCapsule(serialized);
    expect(capsule.recipients.map((recipient) => recipient.fingerprint)).toEqual([
      harness.local.device.fingerprint,
      harness.other.device.fingerprint,
    ].sort());
    expect(result.metadata.serializedBytes).toBe(Buffer.byteLength(serialized));
    expect(result.metadata.serializedSha256).toBe(hash(harness.memory.stored()));
    expect(harness.memory.calls).toEqual([
      "POST /api/cli/capsules",
      "PUT storage",
      `POST /api/cli/capsules/${result.metadata.id}/finalize`,
    ]);
  });

  test("preview includes the current device by default and performs no reserve or upload", async () => {
    const harness = await serviceHarness();
    const result = await harness.service.push({
      transfer: transferFixture(),
      manifest: { schema: "sinter.capsule.manifest.v1" },
      preview: true,
    });
    expect(result.operation).toBe("preview");
    expect(result.uploaded).toBe(false);
    expect(result.metadata.recipientFingerprints).toContain(harness.local.device.fingerprint);
    expect(harness.memory.calls).toEqual([]);
  });

  test("one recipient resolves only by exact device id or exact fingerprint", async () => {
    const byId = await serviceHarness();
    await pushRetained(byId, byId.other.device.id);
    expect((await parseSyntheticCapsule(new TextDecoder().decode(byId.memory.stored()))).recipients.map((entry) => entry.fingerprint)).toEqual([byId.other.device.fingerprint]);

    const byFingerprint = await serviceHarness();
    await pushRetained(byFingerprint, byFingerprint.other.device.fingerprint);
    expect((await parseSyntheticCapsule(new TextDecoder().decode(byFingerprint.memory.stored()))).recipients.map((entry) => entry.fingerprint)).toEqual([byFingerprint.other.device.fingerprint]);

    const missing = await serviceHarness();
    await expect(pushRetained(missing, "not-an-exact-device")).rejects.toThrow("No active device matches");
    expect(missing.memory.calls).toEqual([]);
  });

  test("fails closed after a partial upload and never finalizes", async () => {
    const harness = await serviceHarness();
    harness.memory.failUpload();
    await expect(pushRetained(harness)).rejects.toThrow("upload failed safely");
    expect(harness.memory.calls).toEqual(["POST /api/cli/capsules", "PUT storage"]);
  });

  test("fails closed after upload when finalization fails and redacts the underlying error", async () => {
    const harness = await serviceHarness();
    harness.memory.failFinalize();
    await expect(pushRetained(harness)).rejects.toThrow("finalization failed safely");
    expect(harness.memory.calls).toEqual([
      "POST /api/cli/capsules",
      "PUT storage",
      expect.stringContaining("/finalize"),
    ]);
  });

  test("list returns only strict sanitized server metadata", async () => {
    const harness = await serviceHarness();
    await pushRetained(harness);
    const listed = await harness.service.list();
    expect(listed).toEqual([harness.memory.metadata()]);
    const text = JSON.stringify(listed);
    expect(text).not.toContain("Synthetic capsule");
    expect(text).not.toContain("github.com");
    expect(text).not.toContain("hello world");
    expect(text).not.toContain("signed-download");
  });

  test("inspect downloads, checks exact bytes/hash, verifies sender and decrypts without replay consumption", async () => {
    const harness = await serviceHarness();
    await pushRetained(harness);
    const first = await harness.service.inspect(harness.memory.metadata().id);
    const second = await harness.service.inspect(harness.memory.metadata().id);
    expect(first.manifest.title).toBe("Synthetic capsule");
    expect(first.transfer.schema).toBe(SESSION_TRANSFER_SCHEMA);
    expect(first.transfer.session.entries[0]?.kind).toBe("user");
    expect(first.replayKey).toBe(second.replayKey);
    expect(first.replayKey).toStartWith(`${harness.local.device.fingerprint}:`);
  });

  test("inspect rejects a wrong hash, oversized metadata, inactive sender, and nonrecipient", async () => {
    const wrongHash = await serviceHarness();
    await pushRetained(wrongHash);
    wrongHash.memory.setMetadata({ ...wrongHash.memory.metadata(), serializedSha256: "f".repeat(64) });
    await expect(wrongHash.service.inspect(wrongHash.memory.metadata().id)).rejects.toThrow("hash");

    const oversized = await serviceHarness();
    await pushRetained(oversized);
    oversized.memory.setMetadata({ ...oversized.memory.metadata(), serializedBytes: CAPSULE_MAX_SERIALIZED_BYTES + 1 });
    await expect(oversized.service.inspect(oversized.memory.metadata().id)).rejects.toThrow("incompatible");

    const inactiveSender = await serviceHarness();
    await pushRetained(inactiveSender);
    const receiverService = createCloudCapsuleService({
      api: inactiveSender.memory.api,
      keys: keyStore(inactiveSender.other.material),
      devices: deviceApi([{ ...inactiveSender.other.device }]),
    });
    await expect(receiverService.inspect(inactiveSender.memory.metadata().id)).rejects.toThrow("sender is not");

    const nonrecipient = await serviceHarness();
    await pushRetained(nonrecipient, nonrecipient.other.device.id);
    await expect(nonrecipient.service.inspect(nonrecipient.memory.metadata().id)).rejects.toThrow("not a recipient");
  });

  test("inspect rejects signature tampering even when transport metadata is updated", async () => {
    const harness = await serviceHarness();
    await pushRetained(harness);
    const value = JSON.parse(new TextDecoder().decode(harness.memory.stored())) as { sender: { signature: string } };
    value.sender.signature = `${value.sender.signature[0] === "A" ? "B" : "A"}${value.sender.signature.slice(1)}`;
    const tampered = new TextEncoder().encode(JSON.stringify(value));
    harness.memory.setStored(tampered);
    harness.memory.setMetadata({
      ...harness.memory.metadata(),
      serializedBytes: tampered.byteLength,
      serializedSha256: hash(tampered),
    });
    await expect(harness.service.inspect(harness.memory.metadata().id)).rejects.toThrow("signature verification");
  });

  test("delete requires and returns final deleted state", async () => {
    const harness = await serviceHarness();
    await pushRetained(harness);
    const deleted = await harness.service.delete(harness.memory.metadata().id);
    expect(deleted.status).toBe("deleted");
    expect(deleted.storageDeletedAt).toBe(NOW);
  });
});

const COMMAND_CAPSULE_ID = "AAAAAAAAAAAAAAAAAAAAAA";

function commandMetadata(status: CloudCapsuleMetadata["status"] = "retained"): CloudCapsuleMetadata {
  return {
    id: COMMAND_CAPSULE_ID,
    serializedBytes: 8192,
    serializedSha256: "b".repeat(64),
    outerSchema: CAPSULE_SCHEMA,
    payloadSchema: CAPSULE_SESSION_PAYLOAD_SCHEMA,
    transferSchema: SESSION_TRANSFER_SCHEMA,
    senderFingerprint: "c".repeat(64),
    recipientFingerprints: ["d".repeat(64)],
    recipientCount: 1,
    status,
    reservedAt: NOW,
    reservationExpiresAt: "2026-08-30T00:10:00.000Z",
    finalizedAt: status === "reserved" ? null : NOW,
    deletionRequestedAt: status === "deleted" ? NOW : null,
    storageDeletedAt: status === "deleted" ? NOW : null,
    expiredAt: null,
  };
}

function openedFixture(): OpenedCloudCapsule {
  return {
    metadata: commandMetadata(),
    manifest: { schema: "sinter.capsule.manifest.v1", title: "prompt/content secret /Users/source/private", harness: "claude" },
    transfer: transferFixture(),
    replayKey: `${"d".repeat(64)}:${COMMAND_CAPSULE_ID}:${"e".repeat(64)}:${"f".repeat(64)}`,
  };
}

function commandService(overrides: Partial<CloudCapsuleService> = {}): CloudCapsuleService {
  return {
    async push() { return { operation: "preview", metadata: commandMetadata("reserved"), recipientCount: 1, uploaded: false }; },
    async list() { return [commandMetadata()]; },
    async inspect() { return openedFixture(); },
    async delete() { return commandMetadata("deleted"); },
    ...overrides,
  };
}

function repositoryService(overrides: Partial<RepositoryBindingService> = {}): RepositoryBindingService {
  return {
    async source() { return transferFixture().repository; },
    async resolve(binding, targetRoot, options) {
      const mismatch = options.allowRepositoryMismatch === true;
      const missing = options.allowMissingCommit === true;
      return {
        preview: {
          schema: REPOSITORY_BINDING_PREVIEW_SCHEMA,
          sourceRepository: `${binding.selectedRemote.host}/${binding.selectedRemote.path}`,
          sourceCommit: binding.commit,
          ...(binding.branch ? { sourceBranch: binding.branch } : {}),
          targetRepository: `${binding.selectedRemote.host}/${binding.selectedRemote.path}`,
          targetRemote: "https://github.com/example/synthetic.git",
          targetRoot,
          targetCwd: targetRoot,
          targetHead: "9".repeat(40),
          relativeCwd: binding.relativeCwd,
          match: mismatch ? "mismatch" : "exact",
          commitAvailable: !missing,
          targetWorktreeDirty: false,
          overrides: { repositoryMismatch: mismatch, missingCommit: missing },
          writes: false,
        },
        targetCwd: targetRoot,
        git: { remote: "https://github.com/example/synthetic.git", sha: binding.commit, branch: binding.branch },
        provenanceModeSuffix: `${mismatch ? "-repo-mismatch" : ""}${missing ? "-missing-commit" : ""}`,
      };
    },
    ...overrides,
  };
}

function commandContext(options: {
  registry?: AdapterRegistry;
  ledger?: Ledger;
  cloud?: CloudCapsuleService;
  repository?: RepositoryBindingService;
  confirm?: (question: string) => Promise<boolean>;
  autoScan?: boolean;
} = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ledger = options.ledger ?? new Ledger(":memory:");
  const registry = options.registry ?? new StaticAdapterRegistry([]);
  const ctx: Ctx = {
    registry,
    ledger: () => ledger,
    out: (value) => stdout.push(value),
    err: (value) => stderr.push(value),
    pal: palette(false),
    width: 120,
    now: Date.parse(NOW),
    writeFile: async () => {},
    readFile: async () => "",
    cloudCapsules: options.cloud ?? commandService(),
    repositoryBinding: options.repository ?? repositoryService(),
    ...(options.confirm ? { confirm: options.confirm } : {}),
    ...(options.autoScan === undefined ? {} : { autoScan: options.autoScan }),
  };
  return { ctx, ledger, stdout, stderr };
}

describe("cloud command UX", () => {
  test("list and aliases emit sanitized versioned JSON without scanning sessions or opening the ledger", async () => {
    let scans = 0;
    let ledgerTouches = 0;
    const registry = { async load() { scans++; throw new Error("must not scan"); } } as unknown as AdapterRegistry;
    const output: string[] = [];
    const errors: string[] = [];
    const ctx: Ctx = {
      registry,
      ledger: () => { ledgerTouches++; throw new Error("must not open ledger"); },
      out: (value) => output.push(value),
      err: (value) => errors.push(value),
      pal: palette(false),
      width: 100,
      now: 0,
      writeFile: async () => {},
      readFile: async () => "",
      autoScan: true,
      cloudCapsules: commandService(),
    };
    expect(await run(["cloud", "ls", "--json"], ctx)).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ schema: "sinter.cloud.list-result.v1", ok: true, capsules: [{ id: COMMAND_CAPSULE_ID }] });
    expect(output[0]).not.toContain("title");
    expect(output[0]).not.toContain("repository");
    expect(scans).toBe(0);
    expect(ledgerTouches).toBe(0);
    expect(errors).toEqual([]);
  });

  test("push reuses transfer mode and repository sanitization and has a stable preview schema", async () => {
    const source = new MockAdapter({
      summaries: [summary({ nativeId: "cloud-source" })],
      sessions: { "cloud-source": session("cloud-source") },
    });
    const ledger = new Ledger(":memory:");
    await ledger.scan([source]);
    let pushed: Parameters<CloudCapsuleService["push"]>[0] | undefined;
    const harness = commandContext({
      ledger,
      registry: new StaticAdapterRegistry([source]),
      repository: repositoryService(),
      cloud: commandService({ async push(input) { pushed = input; return { operation: "preview", metadata: commandMetadata("reserved"), recipientCount: 1, uploaded: false }; } }),
    });
    expect(await run(["cloud", "push", "cloud-source", "--mode", "compact", "--to", "all", "--preview", "--json"], harness.ctx)).toBe(0);
    const result = JSON.parse(harness.stdout[0]!);
    expect(result).toMatchObject({ schema: "sinter.cloud.push-preview.v1", ok: true, preview: true, uploaded: false, writes: false, mode: "compact" });
    expect(pushed?.to).toBe("all");
    expect(pushed?.preview).toBe(true);
    expect(pushed?.transfer.schema).toBe(SESSION_TRANSFER_SCHEMA);
    expect(pushed?.transfer.session.cwd).toBe("");
    expect(pushed?.transfer.session.preserve).toBeUndefined();
    expect(pushed?.transfer.session.entries.some((entry) => entry.raw !== undefined)).toBe(false);
    expect(source.written).toEqual([]);
  });

  test("inspect JSON exposes only sanitized metadata and structural transfer summary", async () => {
    const harness = commandContext();
    expect(await run(["cloud", "inspect", COMMAND_CAPSULE_ID, "--json"], harness.ctx)).toBe(0);
    const result = JSON.parse(harness.stdout[0]!);
    expect(result).toMatchObject({
      schema: "sinter.cloud.inspect-result.v1",
      ok: true,
      capsule: { id: COMMAND_CAPSULE_ID },
      manifest: { schema: "sinter.capsule.manifest.v1", harness: "claude" },
      repository: { host: "github.com", path: "example/synthetic" },
      commit: "a".repeat(40),
      relativeCwd: "",
      entryCount: transferFixture().session.entries.length,
      replayConsumed: false,
    });
    expect(result.transfer).toBeUndefined();
    expect(result.replayKey).toBeUndefined();
    const output = harness.stdout[0]!;
    for (const secret of [
      "hello world",
      "prompt/content secret",
      openedFixture().replayKey,
      "/Users/source/private",
      "/Users/test/proj",
      "synthetic-cloud",
    ]) expect(output).not.toContain(secret);
    expect(output).not.toContain("entries");
    expect(output).not.toContain("tokens");
    expect(output).not.toContain("nativeId");
    expect(harness.ledger.acceptCapsuleReplay(openedFixture().replayKey)).toBe(true);
  });

  test("pull targets the exact named instance, rechecks the repository, and rejects replay before a second write", async () => {
    const target = new MockAdapter({ id: "claude", instanceId: "work" });
    let resolves = 0;
    const harness = commandContext({
      registry: new StaticAdapterRegistry([{ harness: "claude", instanceId: "work", adapter: target }]),
      repository: repositoryService({ async resolve(binding, root, options) { resolves++; return repositoryService().resolve(binding, root, options); } }),
    });
    expect(await run(["cloud", "pull", COMMAND_CAPSULE_ID, "--to", "claude@work", "--cwd", "/synthetic/target", "--yes", "--json"], harness.ctx)).toBe(0);
    expect(resolves).toBe(2);
    expect(target.written).toHaveLength(1);
    expect(target.written[0]?.opts?.instanceId).toBe("work");
    expect(target.written[0]?.session.cwd).toBe("/synthetic/target");
    const result = JSON.parse(harness.stdout[0]!);
    expect(result).toMatchObject({
      schema: "sinter.cloud.pull-result.v1",
      ok: true,
      imported: true,
      wrote: true,
      dryRun: false,
      replayConsumed: true,
      target: { harness: "claude", instanceId: "work" },
      preview: {
        schema: "sinter.cloud.pull-preview.v1",
        writes: false,
        repository: {
          sourceRepository: "github.com/example/synthetic",
          sourceCommit: "a".repeat(40),
          targetRepository: "github.com/example/synthetic",
          relativeCwd: "",
          match: "exact",
          commitAvailable: true,
          targetWorktreeDirty: false,
          overrides: { repositoryMismatch: false, missingCommit: false },
          writes: false,
        },
      },
    });
    expect(harness.stdout[0]).not.toContain("/synthetic/target");
    expect(result.preview.repository.targetRoot).toBeUndefined();
    expect(result.preview.repository.targetCwd).toBeUndefined();
    expect(harness.stderr.join("\n")).toContain("Repository binding preview");

    harness.stdout.length = 0;
    expect(await run(["cloud", "pull", COMMAND_CAPSULE_ID, "--to", "claude@work", "--cwd", "/synthetic/target", "--yes", "--json"], harness.ctx)).toBe(1);
    expect(target.written).toHaveLength(1);
    expect(JSON.parse(harness.stderr.at(-1)!)).toMatchObject({ error: { kind: "capsule_replay" } });
  });

  test("dry-run invokes only the dry-run writer and never consumes replay", async () => {
    const target = new MockAdapter({ id: "codex", instanceId: "lab" });
    const harness = commandContext({
      registry: new StaticAdapterRegistry([{ harness: "codex", instanceId: "lab", adapter: target }]),
    });
    expect(await run(["cloud", "pull", COMMAND_CAPSULE_ID, "--to", "codex@lab", "--cwd", "/synthetic/target", "--dry-run", "--json"], harness.ctx)).toBe(0);
    expect(target.written).toHaveLength(1);
    expect(target.written[0]?.opts?.dryRun).toBe(true);
    expect(JSON.parse(harness.stdout[0]!)).toMatchObject({ schema: "sinter.cloud.pull-result.v1", wrote: false, dryRun: true, replayConsumed: false });
    expect(harness.ledger.acceptCapsuleReplay(openedFixture().replayKey)).toBe(true);
  });

  test("refusal and repository failures perform zero target writes and --yes cannot bypass checks", async () => {
    const declinedTarget = new MockAdapter({ id: "claude", instanceId: "declined" });
    const declined = commandContext({
      registry: new StaticAdapterRegistry([{ harness: "claude", instanceId: "declined", adapter: declinedTarget }]),
      confirm: async () => false,
    });
    expect(await run(["cloud", "pull", COMMAND_CAPSULE_ID, "--to", "claude@declined", "--cwd", "/synthetic/target"], declined.ctx)).toBe(1);
    expect(declinedTarget.written).toEqual([]);
    expect(declined.ledger.acceptCapsuleReplay(openedFixture().replayKey)).toBe(true);

    for (const message of ["repository mismatch", "source commit is unavailable"]) {
      const target = new MockAdapter({ id: "claude", instanceId: "blocked" });
      const blocked = commandContext({
        registry: new StaticAdapterRegistry([{ harness: "claude", instanceId: "blocked", adapter: target }]),
        repository: repositoryService({ async resolve() { throw new RepositoryBindingError(message); } }),
      });
      expect(await run(["cloud", "pull", COMMAND_CAPSULE_ID, "--to", "claude@blocked", "--cwd", "/synthetic/target", "--yes"], blocked.ctx)).toBe(1);
      expect(target.written).toEqual([]);
      expect(blocked.stderr.join("\n")).toContain(message);
    }
  });

  test("dedicated repository and missing-commit overrides reach both checks and remain visible in provenance mode", async () => {
    const target = new MockAdapter({ id: "claude", instanceId: "override" });
    const optionsSeen: Array<{ allowRepositoryMismatch?: boolean; allowMissingCommit?: boolean }> = [];
    const harness = commandContext({
      registry: new StaticAdapterRegistry([{ harness: "claude", instanceId: "override", adapter: target }]),
      repository: repositoryService({
        async resolve(binding, root, options) {
          optionsSeen.push(options);
          return repositoryService().resolve(binding, root, options);
        },
      }),
    });
    expect(await run([
      "cloud", "pull", COMMAND_CAPSULE_ID,
      "--to", "claude@override", "--cwd", "/synthetic/target",
      "--allow-repo-mismatch", "--allow-missing-commit", "--yes",
    ], harness.ctx)).toBe(0);
    expect(optionsSeen).toEqual([
      { allowRepositoryMismatch: true, allowMissingCommit: true },
      { allowRepositoryMismatch: true, allowMissingCommit: true },
    ]);
    expect(target.written[0]?.opts?.mode).toBe("cloud-repo-mismatch-missing-commit");
  });

  test("releases only this invocation's replay claim when the target writer fails", async () => {
    const target = new MockAdapter({ id: "claude", instanceId: "retry" });
    const write = target.write.bind(target);
    let attempts = 0;
    target.write = async (value, options) => {
      attempts++;
      if (attempts === 1) throw new Error("synthetic writer failure");
      return write(value, options);
    };
    const harness = commandContext({
      registry: new StaticAdapterRegistry([{ harness: "claude", instanceId: "retry", adapter: target }]),
    });
    const argv = ["cloud", "pull", COMMAND_CAPSULE_ID, "--to", "claude@retry", "--cwd", "/synthetic/target", "--yes"];
    expect(await run(argv, harness.ctx)).toBe(1);
    expect(await run(argv, harness.ctx)).toBe(0);
    expect(target.written).toHaveLength(1);
    expect(await run(argv, harness.ctx)).toBe(1);
    expect(harness.stderr.at(-1)).toContain("replay rejected");
    expect(attempts).toBe(2);
  });

  test("does not release replay claimed by another or previous invocation", async () => {
    const target = new MockAdapter({ id: "claude", instanceId: "owned" });
    const ledger = new Ledger(":memory:");
    expect(ledger.acceptCapsuleReplay(openedFixture().replayKey)).toBe(true);
    const harness = commandContext({
      ledger,
      registry: new StaticAdapterRegistry([{ harness: "claude", instanceId: "owned", adapter: target }]),
    });
    const argv = ["cloud", "pull", COMMAND_CAPSULE_ID, "--to", "claude@owned", "--cwd", "/synthetic/target", "--yes"];
    expect(await run(argv, harness.ctx)).toBe(1);
    expect(await run(argv, harness.ctx)).toBe(1);
    expect(target.written).toEqual([]);
    expect(ledger.acceptCapsuleReplay(openedFixture().replayKey)).toBe(false);
  });

  test("delete requires confirmation and emits a stable final-state JSON result", async () => {
    let deletes = 0;
    const service = commandService({ async delete() { deletes++; return commandMetadata("deleted"); } });
    const declined = commandContext({ cloud: service, confirm: async () => false });
    expect(await run(["cloud", "rm", COMMAND_CAPSULE_ID, "--json"], declined.ctx)).toBe(1);
    expect(deletes).toBe(0);

    const confirmed = commandContext({ cloud: service });
    expect(await run(["cloud", "delete", COMMAND_CAPSULE_ID, "--yes", "--json"], confirmed.ctx)).toBe(0);
    expect(deletes).toBe(1);
    expect(JSON.parse(confirmed.stdout[0]!)).toMatchObject({ schema: "sinter.cloud.delete-result.v1", ok: true, deleted: true, capsule: { status: "deleted" } });
  });

  test("rejects irrelevant and unknown flags per action and alias while allowing global flags", async () => {
    const cases = [
      ["list", "--mode", "compact"],
      ["ls", "--yes"],
      ["inspect", COMMAND_CAPSULE_ID, "--preview"],
      ["pull", COMMAND_CAPSULE_ID, "--mode", "compact"],
      ["delete", COMMAND_CAPSULE_ID, "--dry-run"],
      ["rm", COMMAND_CAPSULE_ID, "--cwd", "/tmp/irrelevant"],
    ];
    for (const argv of cases) {
      const harness = commandContext();
      expect(await run(["cloud", ...argv], harness.ctx)).toBe(1);
      expect(harness.stderr.at(-1)).toContain("is not valid for cloud");
    }
    const unknown = commandContext();
    expect(await run(["cloud", "list", "--unknown-cloud-flag"], unknown.ctx)).toBe(1);
    expect(unknown.stderr.at(-1)).toContain("unknown flag");

    const global = commandContext();
    expect(await run([
      "cloud", "list", "--json", "--profile", "synthetic", "--config", "/tmp/config",
      "--ledger", "/tmp/ledger", "--no-color", "--no-scan", "--no-update-check",
    ], global.ctx)).toBe(0);
  });

  test("cloud help exposes every command, compact push default, and exact pull safeguards", async () => {
    const harness = commandContext();
    expect(await run(["cloud", "push", "--help"], harness.ctx)).toBe(0);
    expect(harness.stdout.join("\n")).toContain("--mode defaults to compact");
    harness.stdout.length = 0;
    expect(await run(["cloud", "pull", "--help"], harness.ctx)).toBe(0);
    expect(harness.stdout.join("\n")).toContain("usage: sinter cloud pull");
    expect(harness.stdout.join("\n")).toContain("--allow-repo-mismatch");
    expect(harness.stdout.join("\n")).toContain("--allow-missing-commit");
    expect(harness.stdout.join("\n")).toContain("--dry-run");
    harness.stdout.length = 0;
    expect(await run(["help", "cloud"], harness.ctx)).toBe(0);
    for (const action of ["push", "list", "inspect", "pull", "delete"]) expect(harness.stdout.join("\n")).toContain(action);
  });
});
