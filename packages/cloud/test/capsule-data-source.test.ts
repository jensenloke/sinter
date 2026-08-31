import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CAPSULE_DATABASE,
  CapsuleDataConfigurationError,
  createCapsuleDataSource,
  createCapsuleSecretSupabaseClient,
} from "../src/lib/capsule-data-source";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const CAPSULE_ID = "AbCdEfGhIjKlMnOpQrStUQ";
const OBJECT_BYTES = Buffer.alloc(1024, 7);
const HASH = createHash("sha256").update(OBJECT_BYTES).digest("hex");
const SENDER = "b".repeat(64);
const RECIPIENT = "c".repeat(64);

function rawCapsule(overrides: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT_ID,
    capsule_id: CAPSULE_ID,
    object_path: `${ACCOUNT_ID}/${CAPSULE_ID}.capsule`,
    serialized_bytes: 1024,
    serialized_sha256: HASH,
    outer_schema: "sinter.capsule.v1",
    payload_schema: "sinter.capsule.session-transfer.v1",
    transfer_schema: "sinter.session-transfer.v2",
    sender_fingerprint: SENDER,
    recipient_count: 1,
    status: "reserved",
    reserved_at: "2026-08-31T00:00:00.000Z",
    reservation_refreshed_at: "2026-08-31T00:00:00.000Z",
    reservation_expires_at: "2026-08-31T02:15:00.000Z",
    finalized_at: null,
    deletion_requested_at: null,
    storage_deleted_at: null,
    expiry_requested_at: null,
    storage_cleanup_completed_at: null,
    expired_at: null,
    ...overrides,
  };
}

interface FakeResponse {
  data: any;
  error: { message: string; code?: string; status?: number; statusCode?: string } | null;
}

class Query implements PromiseLike<FakeResponse> {
  constructor(private readonly response: FakeResponse) {}
  select() { return this; }
  eq() { return this; }
  not() { return this; }
  is() { return this; }
  in() { return this; }
  order() { return this; }
  maybeSingle() { return Promise.resolve(this.response); }
  then<TResult1 = FakeResponse, TResult2 = never>(
    onfulfilled?: ((value: FakeResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.response).then(onfulfilled, onrejected);
  }
}

function fakeClient(options: {
  tables?: Record<string, FakeResponse[]>;
  rpcs?: Record<string, FakeResponse[]>;
  info?: FakeResponse[];
  downloads?: FakeResponse[];
  signedUploads?: FakeResponse[];
  signedDownloads?: FakeResponse[];
  removes?: FakeResponse[];
} = {}) {
  const calls: Array<{ kind: string; name: string; value?: unknown }> = [];
  const tables = options.tables ?? {};
  const rpcs = options.rpcs ?? {};
  const info = options.info ?? [];
  const downloads = options.downloads ?? [];
  const signedUploads = options.signedUploads ?? [];
  const signedDownloads = options.signedDownloads ?? [];
  const removes = options.removes ?? [];
  const next = (queue: FakeResponse[] | undefined) => queue?.shift() ?? { data: null, error: null };
  const bucket = {
    createSignedUploadUrl: async (path: string, value: unknown) => {
      calls.push({ kind: "storage", name: "signed-upload", value: { path, value } });
      return next(signedUploads);
    },
    info: async (path: string) => {
      calls.push({ kind: "storage", name: "info", value: path });
      return next(info);
    },
    download: async (path: string) => {
      calls.push({ kind: "storage", name: "download", value: path });
      return next(downloads);
    },
    createSignedUrl: async (path: string, expires: number, value: unknown) => {
      calls.push({ kind: "storage", name: "signed-download", value: { path, expires, value } });
      return next(signedDownloads);
    },
    remove: async (paths: string[]) => {
      calls.push({ kind: "storage", name: "remove", value: paths });
      return next(removes);
    },
  };
  const client = {
    from: (table: string) => {
      calls.push({ kind: "table", name: table });
      return new Query(next(tables[table]));
    },
    rpc: async (name: string, value: unknown) => {
      calls.push({ kind: "rpc", name, value });
      return next(rpcs[name]);
    },
    storage: {
      from: (name: string) => {
        calls.push({ kind: "bucket", name });
        return bucket;
      },
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

function recipientResponse() {
  return {
    data: [{ capsule_id: CAPSULE_ID, recipient_fingerprint: RECIPIENT }],
    error: null,
  };
}

describe("capsule data source", () => {
  test("requires the server-only Supabase secret configuration", () => {
    expect(() => createCapsuleSecretSupabaseClient({})).toThrow(CapsuleDataConfigurationError);
  });

  test("reserves through the atomic RPC before creating a non-upsert signed upload", async () => {
    const fake = fakeClient({
      rpcs: {
        [CAPSULE_DATABASE.reserveRpc]: [{ data: rawCapsule(), error: null }],
      },
      tables: {
        [CAPSULE_DATABASE.recipientsTable]: [recipientResponse()],
      },
      signedUploads: [{ data: { signedUrl: "https://storage.example.test/upload" }, error: null }],
    });
    const source = createCapsuleDataSource(fake.client);
    const result = await source.reserveCapsule(ACCOUNT_ID, DEVICE_ID, {
      capsuleId: CAPSULE_ID,
      serializedBytes: 1024,
      serializedSha256: HASH,
      outerSchema: "sinter.capsule.v1",
      payloadSchema: "sinter.capsule.session-transfer.v1",
      transferSchema: "sinter.session-transfer.v2",
      senderFingerprint: SENDER,
      recipientFingerprints: [RECIPIENT],
    });
    expect(result.error).toBeNull();
    expect(result.data?.capsule.recipient_fingerprints).toEqual([RECIPIENT]);
    expect(result.data?.signedUploadUrl).toContain("/upload");
    expect(fake.calls[0]).toMatchObject({
      kind: "rpc",
      name: CAPSULE_DATABASE.reserveRpc,
      value: {
        p_account_id: ACCOUNT_ID,
        p_actor_device_id: DEVICE_ID,
        p_capsule_id: CAPSULE_ID,
        p_serialized_bytes: 1024,
      },
    });
    expect(fake.calls.find((call) => call.name === "signed-upload")?.value).toEqual({
      path: `${ACCOUNT_ID}/${CAPSULE_ID}.capsule`,
      value: { upsert: false },
    });
  });

  test("loads and validates the active device signing key", async () => {
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = keys.publicKey.export({ format: "jwk" });
    const storedKey = JSON.stringify({
      crv: "P-256",
      kty: "EC",
      x: publicKey.x,
      y: publicKey.y,
    });
    const fake = fakeClient({
      tables: {
        [CAPSULE_DATABASE.devicesTable]: [{
          data: {
            id: DEVICE_ID,
            user_id: ACCOUNT_ID,
            fingerprint: SENDER,
            signing_public_key: storedKey,
          },
          error: null,
        }],
      },
    });
    const loaded = await createCapsuleDataSource(fake.client).loadActiveDevice(ACCOUNT_ID, DEVICE_ID);
    expect(loaded.error).toBeNull();
    expect(loaded.data?.signing_public_key).toMatchObject({ kty: "EC", crv: "P-256" });
  });

  test("checks read entitlement through the scoped service-only RPC", async () => {
    const fake = fakeClient({
      rpcs: {
        [CAPSULE_DATABASE.authorizeReadRpc]: [{ data: true, error: null }],
      },
    });
    const result = await createCapsuleDataSource(fake.client).authorizeCapsuleRead(ACCOUNT_ID, DEVICE_ID);
    expect(result).toEqual({ data: true, error: null });
    expect(fake.calls[0]).toEqual({
      kind: "rpc",
      name: CAPSULE_DATABASE.authorizeReadRpc,
      value: { p_account_id: ACCOUNT_ID, p_device_id: DEVICE_ID },
    });
  });

  test("claims request nonces through the service-only atomic RPC", async () => {
    const fake = fakeClient({
      rpcs: {
        [CAPSULE_DATABASE.claimNonceRpc]: [{ data: true, error: null }],
      },
    });
    const result = await createCapsuleDataSource(fake.client).claimRequestNonce(
      ACCOUNT_ID,
      DEVICE_ID,
      Buffer.alloc(32, 3).toString("base64url"),
      "2026-08-31T00:00:00.000Z",
    );
    expect(result).toEqual({ data: true, error: null });
    expect(fake.calls[0]).toMatchObject({
      kind: "rpc",
      name: CAPSULE_DATABASE.claimNonceRpc,
      value: {
        p_account_id: ACCOUNT_ID,
        p_device_id: DEVICE_ID,
        p_request_timestamp: "2026-08-31T00:00:00.000Z",
      },
    });
  });

  test("stats exact Storage size before finalizing and performs zero RPC writes on mismatch", async () => {
    const fake = fakeClient({
      tables: {
        [CAPSULE_DATABASE.capsulesTable]: [{ data: rawCapsule(), error: null }],
        [CAPSULE_DATABASE.recipientsTable]: [recipientResponse()],
      },
      info: [{ data: { size: 1023 }, error: null }],
    });
    const result = await createCapsuleDataSource(fake.client).finalizeCapsule(
      ACCOUNT_ID,
      DEVICE_ID,
      CAPSULE_ID,
      1024,
      HASH,
    );
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("CAPSULE_OBJECT_SIZE_MISMATCH");
    expect(fake.calls.filter((call) => call.kind === "rpc")).toHaveLength(0);
    expect(fake.calls.some((call) => call.name === "download")).toBe(false);
  });

  test("reports a not-yet-uploaded object without calling finalize", async () => {
    const fake = fakeClient({
      tables: {
        [CAPSULE_DATABASE.capsulesTable]: [{ data: rawCapsule(), error: null }],
        [CAPSULE_DATABASE.recipientsTable]: [recipientResponse()],
      },
      info: [{
        data: null,
        error: { message: "private missing path", code: "NoSuchKey", status: 404, statusCode: "404" },
      }],
    });
    const result = await createCapsuleDataSource(fake.client).finalizeCapsule(
      ACCOUNT_ID,
      DEVICE_ID,
      CAPSULE_ID,
      1024,
      HASH,
    );
    expect(result.error?.code).toBe("CAPSULE_OBJECT_NOT_FOUND");
    expect(JSON.stringify(result)).not.toContain("private missing path");
    expect(fake.calls.filter((call) => call.kind === "rpc")).toHaveLength(0);
  });

  test("rejects same-size wrong content before finalize", async () => {
    const fake = fakeClient({
      tables: {
        [CAPSULE_DATABASE.capsulesTable]: [{ data: rawCapsule(), error: null }],
        [CAPSULE_DATABASE.recipientsTable]: [recipientResponse()],
      },
      info: [{ data: { size: 1024 }, error: null }],
      downloads: [{ data: new Blob([Buffer.alloc(1024, 8)]), error: null }],
    });
    const result = await createCapsuleDataSource(fake.client).finalizeCapsule(
      ACCOUNT_ID,
      DEVICE_ID,
      CAPSULE_ID,
      1024,
      HASH,
    );
    expect(result.error?.code).toBe("CAPSULE_OBJECT_HASH_MISMATCH");
    expect(fake.calls.filter((call) => call.kind === "rpc")).toHaveLength(0);
  });

  test("bounds downloaded streams and sanitizes stream failures before finalize", async () => {
    const oversizedObject = {
      size: 1024,
      stream: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1025));
          controller.close();
        },
      }),
    };
    const failedObject = {
      size: 1024,
      stream: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("secret stream failure"));
        },
      }),
    };
    for (const [object, code] of [
      [oversizedObject, "CAPSULE_OBJECT_SIZE_MISMATCH"],
      [failedObject, "CAPSULE_OBJECT_READ_FAILED"],
    ] as const) {
      const fake = fakeClient({
        tables: {
          [CAPSULE_DATABASE.capsulesTable]: [{ data: rawCapsule(), error: null }],
          [CAPSULE_DATABASE.recipientsTable]: [recipientResponse()],
        },
        info: [{ data: { size: 1024 }, error: null }],
        downloads: [{ data: object, error: null }],
      });
      const result = await createCapsuleDataSource(fake.client).finalizeCapsule(
        ACCOUNT_ID,
        DEVICE_ID,
        CAPSULE_ID,
        1024,
        HASH,
      );
      expect(result.error?.code).toBe(code);
      expect(JSON.stringify(result)).not.toContain("secret stream failure");
      expect(fake.calls.filter((call) => call.kind === "rpc")).toHaveLength(0);
    }
  });

  test("finalizes only after exact Storage size and SHA-256 verification and supports signed retained downloads", async () => {
    const retained = rawCapsule({
      status: "retained",
      finalized_at: "2026-08-31T00:01:00.000Z",
    });
    const fake = fakeClient({
      tables: {
        [CAPSULE_DATABASE.capsulesTable]: [
          { data: rawCapsule(), error: null },
          { data: retained, error: null },
        ],
        [CAPSULE_DATABASE.recipientsTable]: [recipientResponse(), recipientResponse(), recipientResponse()],
      },
      rpcs: {
        [CAPSULE_DATABASE.finalizeRpc]: [{ data: retained, error: null }],
      },
      info: [{ data: { size: 1024 }, error: null }],
      downloads: [{ data: new Blob([OBJECT_BYTES]), error: null }],
      signedDownloads: [{ data: { signedUrl: "https://storage.example.test/download" }, error: null }],
    });
    const source = createCapsuleDataSource(fake.client);
    const finalized = await source.finalizeCapsule(ACCOUNT_ID, DEVICE_ID, CAPSULE_ID, 1024, HASH);
    expect(finalized.data?.status).toBe("retained");
    const infoIndex = fake.calls.findIndex((call) => call.name === "info");
    const downloadIndex = fake.calls.findIndex((call) => call.name === "download");
    const finalizeIndex = fake.calls.findIndex((call) => call.name === CAPSULE_DATABASE.finalizeRpc);
    expect(infoIndex).toBeGreaterThan(-1);
    expect(downloadIndex).toBeGreaterThan(infoIndex);
    expect(finalizeIndex).toBeGreaterThan(downloadIndex);

    const download = await source.createDownload(ACCOUNT_ID, CAPSULE_ID);
    expect(download.data?.expiresInSeconds).toBe(60);
    expect(fake.calls.find((call) => call.name === "signed-download")?.value).toMatchObject({
      expires: 60,
      value: { download: true },
    });
  });

  test("retries delete_pending after Storage removal failure without finalizing counters early", async () => {
    const pending = rawCapsule({
      status: "delete_pending",
      finalized_at: "2026-08-31T00:01:00.000Z",
      deletion_requested_at: "2026-08-31T00:02:00.000Z",
    });
    const deleted = rawCapsule({
      status: "deleted",
      finalized_at: "2026-08-31T00:01:00.000Z",
      deletion_requested_at: "2026-08-31T00:02:00.000Z",
      storage_deleted_at: "2026-08-31T00:03:00.000Z",
    });
    const fake = fakeClient({
      rpcs: {
        [CAPSULE_DATABASE.beginDeleteRpc]: [
          { data: pending, error: null },
          { data: pending, error: null },
        ],
        [CAPSULE_DATABASE.finalizeDeleteRpc]: [{ data: deleted, error: null }],
      },
      tables: {
        [CAPSULE_DATABASE.recipientsTable]: [
          recipientResponse(),
          recipientResponse(),
          recipientResponse(),
        ],
      },
      removes: [
        { data: null, error: { message: "private storage failure" } },
        { data: [], error: null },
      ],
    });
    const source = createCapsuleDataSource(fake.client);
    const failed = await source.deleteCapsule(ACCOUNT_ID, DEVICE_ID, CAPSULE_ID);
    expect(failed.data).toBeNull();
    expect(failed.error).not.toBeNull();
    expect(fake.calls.some((call) => call.name === CAPSULE_DATABASE.finalizeDeleteRpc)).toBe(false);

    const retried = await source.deleteCapsule(ACCOUNT_ID, DEVICE_ID, CAPSULE_ID);
    expect(retried.data?.status).toBe("deleted");
    expect(fake.calls.filter((call) => call.name === CAPSULE_DATABASE.beginDeleteRpc)).toHaveLength(2);
    expect(fake.calls.filter((call) => call.name === "remove")).toHaveLength(2);
    expect(fake.calls.filter((call) => call.name === CAPSULE_DATABASE.finalizeDeleteRpc)).toHaveLength(1);
  });

  test("treats an already-absent object as successful permanent deletion", async () => {
    const pending = rawCapsule({
      status: "delete_pending",
      finalized_at: "2026-08-31T00:01:00.000Z",
      deletion_requested_at: "2026-08-31T00:02:00.000Z",
    });
    const deleted = rawCapsule({
      status: "deleted",
      finalized_at: "2026-08-31T00:01:00.000Z",
      deletion_requested_at: "2026-08-31T00:02:00.000Z",
      storage_deleted_at: "2026-08-31T00:03:00.000Z",
    });
    const fake = fakeClient({
      rpcs: {
        [CAPSULE_DATABASE.beginDeleteRpc]: [{ data: pending, error: null }],
        [CAPSULE_DATABASE.finalizeDeleteRpc]: [{ data: deleted, error: null }],
      },
      tables: {
        [CAPSULE_DATABASE.recipientsTable]: [recipientResponse(), recipientResponse()],
      },
      removes: [{
        data: null,
        error: { message: "private missing path", code: "NoSuchKey", status: 404, statusCode: "404" },
      }],
    });
    const result = await createCapsuleDataSource(fake.client).deleteCapsule(
      ACCOUNT_ID,
      DEVICE_ID,
      CAPSULE_ID,
    );
    expect(result.data?.status).toBe("deleted");
    expect(fake.calls.some((call) => call.name === CAPSULE_DATABASE.finalizeDeleteRpc)).toBe(true);
  });

  test("keeps failed expiry cleanup retryable and confirms missing objects before quota finalization", async () => {
    const expiryPending = rawCapsule({
      status: "expiry_pending",
      expiry_requested_at: "2026-08-31T02:16:00.000Z",
    });
    const expired = rawCapsule({
      status: "expired",
      expiry_requested_at: "2026-08-31T02:16:00.000Z",
      storage_cleanup_completed_at: "2026-08-31T02:17:00.000Z",
      expired_at: "2026-08-31T02:17:00.000Z",
    });
    const fake = fakeClient({
      rpcs: {
        [CAPSULE_DATABASE.expireRpc]: [
          { data: [expiryPending], error: null },
          { data: [expiryPending], error: null },
        ],
        [CAPSULE_DATABASE.finalizeExpiryRpc]: [{ data: expired, error: null }],
      },
      tables: {
        [CAPSULE_DATABASE.recipientsTable]: [
          recipientResponse(),
          recipientResponse(),
          recipientResponse(),
        ],
      },
      removes: [
        { data: null, error: { message: "temporary outage", status: 503, statusCode: "503" } },
        { data: null, error: { message: "already absent", code: "NoSuchKey", status: 404, statusCode: "404" } },
      ],
    });
    const source = createCapsuleDataSource(fake.client);
    const failed = await source.expireReservations(10);
    expect(failed.error?.code).toBe("CAPSULE_STORAGE_REMOVE_FAILED");
    expect(fake.calls.some((call) => call.name === CAPSULE_DATABASE.finalizeExpiryRpc)).toBe(false);

    const retried = await source.expireReservations(10);
    expect(retried.data?.[0]?.status).toBe("expired");
    expect(fake.calls.filter((call) => call.name === CAPSULE_DATABASE.expireRpc)).toHaveLength(2);
    expect(fake.calls.filter((call) => call.name === CAPSULE_DATABASE.finalizeExpiryRpc)).toHaveLength(1);
  });

  test("removes Storage before atomically finalizing deletion and cleans expired objects", async () => {
    const pending = rawCapsule({
      status: "delete_pending",
      finalized_at: "2026-08-31T00:01:00.000Z",
      deletion_requested_at: "2026-08-31T00:02:00.000Z",
    });
    const deleted = rawCapsule({
      status: "deleted",
      finalized_at: "2026-08-31T00:01:00.000Z",
      deletion_requested_at: "2026-08-31T00:02:00.000Z",
      storage_deleted_at: "2026-08-31T00:03:00.000Z",
    });
    const expiryPending = rawCapsule({
      status: "expiry_pending",
      expiry_requested_at: "2026-08-31T02:16:00.000Z",
    });
    const expired = rawCapsule({
      status: "expired",
      expiry_requested_at: "2026-08-31T02:16:00.000Z",
      storage_cleanup_completed_at: "2026-08-31T02:17:00.000Z",
      expired_at: "2026-08-31T02:17:00.000Z",
    });
    const fake = fakeClient({
      rpcs: {
        [CAPSULE_DATABASE.beginDeleteRpc]: [{ data: pending, error: null }],
        [CAPSULE_DATABASE.finalizeDeleteRpc]: [{ data: deleted, error: null }],
        [CAPSULE_DATABASE.expireRpc]: [{ data: [expiryPending], error: null }],
        [CAPSULE_DATABASE.finalizeExpiryRpc]: [{ data: expired, error: null }],
      },
      tables: {
        [CAPSULE_DATABASE.recipientsTable]: [
          recipientResponse(),
          recipientResponse(),
          recipientResponse(),
          recipientResponse(),
        ],
      },
      removes: [{ data: [], error: null }, { data: [], error: null }],
    });
    const source = createCapsuleDataSource(fake.client);
    const result = await source.deleteCapsule(ACCOUNT_ID, DEVICE_ID, CAPSULE_ID);
    expect(result.data?.status).toBe("deleted");
    const removeIndex = fake.calls.findIndex((call) => call.name === "remove");
    const finalizeIndex = fake.calls.findIndex((call) => call.name === CAPSULE_DATABASE.finalizeDeleteRpc);
    expect(finalizeIndex).toBeGreaterThan(removeIndex);

    const reclaimed = await source.expireReservations(10);
    expect(reclaimed.data?.[0]?.status).toBe("expired");
    expect(reclaimed.data?.[0]?.storage_cleanup_completed_at).not.toBeNull();
    expect(fake.calls.filter((call) => call.name === "remove")).toHaveLength(2);
    const expiryFinalizeIndex = fake.calls.findIndex((call) => call.name === CAPSULE_DATABASE.finalizeExpiryRpc);
    const lastRemoveIndex = fake.calls.map((call) => call.name).lastIndexOf("remove");
    expect(expiryFinalizeIndex).toBeGreaterThan(lastRemoveIndex);
  });
});
