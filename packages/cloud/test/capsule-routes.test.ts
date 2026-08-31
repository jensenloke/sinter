import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { CliAuthenticationError } from "../src/lib/device-auth";
import type { PublicP256Jwk } from "../src/lib/device-crypto";
import {
  capsuleRequestBodySha256,
  capsuleRequestProofBytes,
} from "../src/lib/capsule-request-proof";
import type {
  CapsuleDataSource,
  CapsuleReservationInput,
  CapsuleRow,
} from "../src/lib/capsule-data-source";
import {
  CAPSULE_DOWNLOAD_REQUEST_SCHEMA,
  CAPSULE_FINALIZE_SCHEMA,
  CAPSULE_RESERVE_SCHEMA,
  createCapsuleDownloadRoute,
  createCapsuleFinalizeRoute,
  createCapsuleRoute,
  createCapsulesRoute,
  type CapsuleHttpDependencies,
} from "../src/lib/capsule-http";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ACCOUNT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const CAPSULE_ID = "AbCdEfGhIjKlMnOpQrStUQ";
const HASH = "a".repeat(64);
const SENDER = "b".repeat(64);
const RECIPIENT = "c".repeat(64);
const NOW = "2026-08-31T00:00:00.000Z";
const signingKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const exportedSigningKey = signingKeys.publicKey.export({ format: "jwk" });
const signingPublicKey: PublicP256Jwk = {
  kty: "EC",
  crv: "P-256",
  x: exportedSigningKey.x!,
  y: exportedSigningKey.y!,
  use: "sig",
  key_ops: ["verify"],
  ext: true,
};

function capsule(overrides: Partial<CapsuleRow> = {}): CapsuleRow {
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
    recipient_fingerprints: [RECIPIENT],
    status: "retained",
    reserved_at: NOW,
    reservation_refreshed_at: NOW,
    reservation_expires_at: "2026-08-31T02:15:00.000Z",
    finalized_at: "2026-08-31T00:01:00.000Z",
    deletion_requested_at: null,
    storage_deleted_at: null,
    expiry_requested_at: null,
    storage_cleanup_completed_at: null,
    expired_at: null,
    ...overrides,
  };
}

function source(overrides: Partial<CapsuleDataSource> = {}): CapsuleDataSource {
  return {
    resolveAccountId: async () => ({ data: ACCOUNT_ID, error: null }),
    loadActiveDevice: async () => ({
      data: {
        id: DEVICE_ID,
        account_id: ACCOUNT_ID,
        fingerprint: SENDER,
        signing_public_key: signingPublicKey,
      },
      error: null,
    }),
    authorizeCapsuleRead: async () => ({ data: true, error: null }),
    claimRequestNonce: async () => ({ data: true, error: null }),
    reserveCapsule: async () => ({ data: null, error: null }),
    finalizeCapsule: async () => ({ data: null, error: null }),
    listCapsules: async () => ({ data: [], error: null }),
    inspectCapsule: async () => ({ data: null, error: null }),
    createDownload: async () => ({ data: null, error: null }),
    deleteCapsule: async () => ({ data: null, error: null }),
    expireReservations: async () => ({ data: [], error: null }),
    expireRequestNonces: async () => ({ data: 0, error: null }),
    ...overrides,
  };
}

function dependencies(data: CapsuleDataSource, overrides: Partial<CapsuleHttpDependencies> = {}) {
  return {
    authenticate: async () => ({
      issuer: "https://auth.example.test/",
      subject: "auth0|capsule-user",
      email: "capsule@example.test",
    }),
    createSource: () => data,
    uploadsEnabled: () => true,
    authorizeDevice: async ({ accountId, deviceId }: { accountId: string; deviceId: string }) => ({
      accountId,
      deviceId,
      device: {
        id: deviceId,
        account_id: accountId,
        fingerprint: SENDER,
        signing_public_key: signingPublicKey,
      },
    }),
    now: () => new Date(NOW),
    ...overrides,
  };
}

function request(path: string, method = "GET", value?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request(`https://cloud.example.test${path}`, {
    method,
    headers: {
      "X-Sinter-Device-Id": DEVICE_ID,
      ...(value === undefined ? {} : { "Content-Type": "application/json" }),
      ...extraHeaders,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

function signedRequest(
  path: string,
  method: "GET" | "POST" | "DELETE",
  value?: unknown,
  options: {
    signedMethod?: string;
    signedPathname?: string;
    signedBody?: Uint8Array;
    timestamp?: string;
    nonce?: string;
    privateKey?: typeof signingKeys.privateKey;
    headers?: Record<string, string>;
  } = {},
) {
  const text = value === undefined ? "" : JSON.stringify(value);
  const bodyBytes = Buffer.from(text, "utf8");
  const timestamp = options.timestamp ?? NOW;
  const nonce = options.nonce ?? Buffer.alloc(32, 9).toString("base64url");
  const signature = sign(
    "sha256",
    capsuleRequestProofBytes({
      deviceId: DEVICE_ID,
      method: options.signedMethod ?? method,
      pathname: options.signedPathname ?? path,
      bodySha256: capsuleRequestBodySha256(options.signedBody ?? bodyBytes),
      timestamp,
      nonce,
    }),
    { key: options.privateKey ?? signingKeys.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  return new Request(`https://cloud.example.test${path}`, {
    method,
    headers: {
      "X-Sinter-Device-Id": DEVICE_ID,
      "X-Sinter-Request-Timestamp": timestamp,
      "X-Sinter-Request-Nonce": nonce,
      "X-Sinter-Request-Signature": signature,
      ...(value === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    ...(value === undefined ? {} : { body: text }),
  });
}

function reservation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schema: CAPSULE_RESERVE_SCHEMA,
    capsuleId: CAPSULE_ID,
    serializedBytes: 1024,
    serializedSha256: HASH,
    outerSchema: "sinter.capsule.v1",
    payloadSchema: "sinter.capsule.session-transfer.v1",
    transferSchema: "sinter.session-transfer.v2",
    senderFingerprint: SENDER,
    recipientFingerprints: [RECIPIENT],
    ...overrides,
  };
}

async function body(response: Response) {
  return await response.json() as Record<string, any>;
}

describe("capsule route authorization and parsing", () => {
  test("fails closed while the explicit server upload gate is disabled", async () => {
    let authenticated = false;
    let wrote = false;
    const data = source({
      reserveCapsule: async () => {
        wrote = true;
        return { data: null, error: null };
      },
    });
    const response = await createCapsulesRoute(dependencies(data, {
      authenticate: async () => {
        authenticated = true;
        throw new Error("must not authenticate");
      },
      uploadsEnabled: () => false,
    })).POST(request("/api/cli/capsules", "POST", reservation()));
    const payload = await body(response);
    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("uploads_disabled");
    expect(authenticated).toBe(false);
    expect(wrote).toBe(false);
  });

  test("sanitizes paired-token authentication configuration errors", async () => {
    const secret = "secret Auth0 backend detail";
    const response = await createCapsulesRoute(dependencies(source(), {
      authenticate: async () => {
        throw new CliAuthenticationError("configuration", secret);
      },
    })).GET(request("/api/cli/capsules"));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await body(response))).not.toContain(secret);
  });

  test("requires the explicit device header before any mutation", async () => {
    let wrote = false;
    const data = source({
      reserveCapsule: async () => {
        wrote = true;
        return { data: null, error: null };
      },
    });
    const withoutDevice = new Request("https://cloud.example.test/api/cli/capsules", {
      method: "POST",
      body: JSON.stringify(reservation()),
    });
    const response = await createCapsulesRoute(dependencies(data)).POST(withoutDevice);
    expect(response.status).toBe(400);
    expect(wrote).toBe(false);
  });

  test("rejects inactive and cross-account devices with zero writes", async () => {
    for (const activeDevice of [null, {
      id: DEVICE_ID,
      account_id: OTHER_ACCOUNT_ID,
      fingerprint: SENDER,
    }]) {
      let wrote = false;
      const data = source({
        loadActiveDevice: async () => ({ data: activeDevice, error: null }),
        reserveCapsule: async () => {
          wrote = true;
          return { data: null, error: null };
        },
      });
      const response = await createCapsulesRoute(dependencies(data, { authorizeDevice: undefined })).POST(
        request("/api/cli/capsules", "POST", reservation()),
      );
      expect(response.status).toBe(403);
      expect(wrote).toBe(false);
    }
  });

  test("rejects sender mismatch, unknown fields, malformed JSON, and oversized bodies without writes", async () => {
    let writes = 0;
    const data = source({
      reserveCapsule: async () => {
        writes += 1;
        return { data: null, error: null };
      },
    });
    const route = createCapsulesRoute(dependencies(data));
    const cases = [
      request("/api/cli/capsules", "POST", reservation({ senderFingerprint: "d".repeat(64) })),
      request("/api/cli/capsules", "POST", reservation({ title: "plaintext title" })),
      new Request("https://cloud.example.test/api/cli/capsules", {
        method: "POST",
        headers: { "X-Sinter-Device-Id": DEVICE_ID },
        body: "{",
      }),
      request(
        "/api/cli/capsules",
        "POST",
        reservation(),
        { "Content-Length": "32769" },
      ),
    ];
    const statuses: number[] = [];
    for (const value of cases) statuses.push((await route.POST(value)).status);
    expect(statuses).toEqual([403, 400, 400, 413]);
    expect(writes).toBe(0);
  });

  test("requires sorted unique recipient fingerprints and bounded serialized size", async () => {
    let wrote = false;
    const data = source({ reserveCapsule: async () => {
      wrote = true;
      return { data: null, error: null };
    } });
    for (const value of [
      reservation({ recipientFingerprints: ["f".repeat(64), RECIPIENT] }),
      reservation({ recipientFingerprints: [RECIPIENT, RECIPIENT] }),
      reservation({ serializedBytes: 64 * 1024 * 1024 + 1 }),
    ]) {
      const response = await createCapsulesRoute(dependencies(data)).POST(
        request("/api/cli/capsules", "POST", value),
      );
      expect(response.status).toBe(400);
    }
    expect(wrote).toBe(false);
  });
});

describe("capsule request proof", () => {
  test("matches the public CLI canonical signing vector", () => {
    const bodyHash = "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93";
    const nonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(capsuleRequestBodySha256(Buffer.from('{"ok":true}', "utf8"))).toBe(bodyHash);
    expect(capsuleRequestProofBytes({
      deviceId: "11111111-1111-4111-8111-111111111111",
      method: "POST",
      pathname: "/api/cli/capsules",
      bodySha256: bodyHash,
      timestamp: "2026-08-31T00:00:00.000Z",
      nonce,
    }).toString("utf8")).toBe(
      `{"bodySha256":"${bodyHash}","deviceId":"11111111-1111-4111-8111-111111111111","method":"POST","nonce":"${nonce}","pathname":"/api/cli/capsules","schema":"sinter.cloud.capsule-request-proof.v1","timestamp":"2026-08-31T00:00:00.000Z"}`,
    );
  });

  test("verifies a valid signed request and claims its nonce before listing", async () => {
    const calls: string[] = [];
    const data = source({
      loadActiveDevice: async () => {
        calls.push("device");
        return {
          data: {
            id: DEVICE_ID,
            account_id: ACCOUNT_ID,
            fingerprint: SENDER,
            signing_public_key: signingPublicKey,
          },
          error: null,
        };
      },
      claimRequestNonce: async (accountId, deviceId, nonce, timestamp) => {
        calls.push("nonce");
        expect({ accountId, deviceId, nonce, timestamp }).toEqual({
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          nonce: Buffer.alloc(32, 9).toString("base64url"),
          timestamp: NOW,
        });
        return { data: true, error: null };
      },
      listCapsules: async () => {
        calls.push("list");
        return { data: [], error: null };
      },
    });
    const response = await createCapsulesRoute(dependencies(data, { authorizeDevice: undefined })).GET(
      signedRequest("/api/cli/capsules", "GET"),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual(["device", "nonce", "list"]);
  });

  test("uses the same signed POST body bytes for proof and strict reservation parsing", async () => {
    const reserved = capsule({ status: "reserved", finalized_at: null });
    const calls: string[] = [];
    const data = source({
      claimRequestNonce: async () => {
        calls.push("nonce");
        return { data: true, error: null };
      },
      reserveCapsule: async (_accountId, _deviceId, input) => {
        calls.push("reserve");
        expect(input).toEqual({
          capsuleId: CAPSULE_ID,
          serializedBytes: 1024,
          serializedSha256: HASH,
          outerSchema: "sinter.capsule.v1",
          payloadSchema: "sinter.capsule.session-transfer.v1",
          transferSchema: "sinter.session-transfer.v2",
          senderFingerprint: SENDER,
          recipientFingerprints: [RECIPIENT],
        });
        return {
          data: { capsule: reserved, signedUploadUrl: "https://storage.example.test/upload" },
          error: null,
        };
      },
    });
    const response = await createCapsulesRoute(dependencies(data, { authorizeDevice: undefined })).POST(
      signedRequest("/api/cli/capsules", "POST", reservation()),
    );
    expect(response.status).toBe(201);
    expect(calls).toEqual(["nonce", "reserve"]);
  });

  test("rejects wrong key, signature, signed path, signed method, and body before nonce claim or mutation", async () => {
    const wrongKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const cases = [
      signedRequest("/api/cli/capsules", "POST", reservation(), { privateKey: wrongKeys.privateKey }),
      signedRequest("/api/cli/capsules", "POST", reservation(), {
        headers: { "X-Sinter-Request-Signature": Buffer.alloc(64, 4).toString("base64url") },
      }),
      signedRequest("/api/cli/capsules", "POST", reservation(), { signedPathname: "/api/cli/capsules/wrong" }),
      signedRequest("/api/cli/capsules", "POST", reservation(), { signedMethod: "DELETE" }),
      signedRequest("/api/cli/capsules", "POST", reservation(), { signedBody: Buffer.from("{}") }),
    ];
    for (const signed of cases) {
      let claimed = false;
      let wrote = false;
      const data = source({
        claimRequestNonce: async () => {
          claimed = true;
          return { data: true, error: null };
        },
        reserveCapsule: async () => {
          wrote = true;
          return { data: null, error: null };
        },
      });
      const response = await createCapsulesRoute(dependencies(data, { authorizeDevice: undefined })).POST(signed);
      expect(response.status).toBe(401);
      expect((await body(response)).error.code).toBe("invalid_request_proof");
      expect(claimed).toBe(false);
      expect(wrote).toBe(false);
    }
  });

  test("rejects stale, future, malformed, wrong-target, and wrong-method proofs with zero downstream operations", async () => {
    const stale = new Date(Date.parse(NOW) - 5 * 60 * 1000 - 1).toISOString();
    const future = new Date(Date.parse(NOW) + 5 * 60 * 1000 + 1).toISOString();
    const requests = [
      signedRequest("/api/cli/capsules", "GET", undefined, { timestamp: stale }),
      signedRequest("/api/cli/capsules", "GET", undefined, { timestamp: future }),
      signedRequest("/api/cli/capsules", "GET", undefined, {
        headers: { "X-Sinter-Request-Nonce": "not-canonical" },
      }),
      signedRequest("/api/cli/capsules", "GET", undefined, {
        headers: { "X-Sinter-Request-Timestamp": "2026-08-31T00:00:00Z" },
      }),
      new Request("https://cloud.example.test/api/cli/capsules", {
        headers: { "X-Sinter-Device-Id": DEVICE_ID },
      }),
      signedRequest("/api/cli/capsules/wrong", "GET"),
      signedRequest("/api/cli/capsules", "POST", reservation()),
    ];
    for (const signed of requests) {
      let claimed = false;
      let listed = false;
      const data = source({
        claimRequestNonce: async () => {
          claimed = true;
          return { data: true, error: null };
        },
        listCapsules: async () => {
          listed = true;
          return { data: [], error: null };
        },
      });
      const response = await createCapsulesRoute(dependencies(data, { authorizeDevice: undefined })).GET(signed);
      expect([400, 401]).toContain(response.status);
      expect(claimed).toBe(false);
      expect(listed).toBe(false);
    }
  });

  test("rejects a duplicate durable nonce before list and sanitizes proof material", async () => {
    const poison = Buffer.alloc(64, 8).toString("base64url");
    let listed = false;
    const data = source({
      claimRequestNonce: async () => ({
        data: null,
        error: { code: "PT409", message: "capsule_request_replay" },
      }),
      listCapsules: async () => {
        listed = true;
        return { data: [], error: null };
      },
    });
    const response = await createCapsulesRoute(dependencies(data, { authorizeDevice: undefined })).GET(
      signedRequest("/api/cli/capsules", "GET", undefined, {
        headers: { "X-Unused-Poison": poison },
      }),
    );
    const payload = await body(response);
    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("request_replay");
    expect(JSON.stringify(payload)).not.toContain(poison);
    expect(listed).toBe(false);
  });
});

describe("fail-safe capsule deletion", () => {
  test("allows signed owner deletion with the global gate disabled across disabled and suspended entitlements", async () => {
    for (const entitlement of ["uploads_disabled", "suspended"]) {
      const calls: string[] = [];
      const data = source({
        claimRequestNonce: async () => {
          calls.push("nonce");
          return { data: true, error: null };
        },
        deleteCapsule: async (accountId, deviceId, id) => {
          calls.push(`delete:${entitlement}`);
          expect({ accountId, deviceId, id }).toEqual({
            accountId: ACCOUNT_ID,
            deviceId: DEVICE_ID,
            id: CAPSULE_ID,
          });
          return {
            data: capsule({
              status: "deleted",
              deletion_requested_at: "2026-08-31T00:02:00.000Z",
              storage_deleted_at: "2026-08-31T00:03:00.000Z",
            }),
            error: null,
          };
        },
      });
      const response = await createCapsuleRoute(dependencies(data, {
        uploadsEnabled: () => false,
        authorizeDevice: undefined,
      })).DELETE(
        signedRequest(`/api/cli/capsules/${CAPSULE_ID}`, "DELETE"),
        { params: { id: CAPSULE_ID } },
      );
      expect(response.status).toBe(200);
      expect(calls).toEqual(["nonce", `delete:${entitlement}`]);
    }
  });

  test("refuses suspended list, inspect, and download before metadata or Storage access", async () => {
    for (const operation of ["list", "inspect", "download"] as const) {
      let accessed = false;
      const data = source({
        authorizeCapsuleRead: async () => ({
          data: null,
          error: { code: "42501", message: "capsule reads are not enabled" },
        }),
        listCapsules: async () => {
          accessed = true;
          return { data: [], error: null };
        },
        inspectCapsule: async () => {
          accessed = true;
          return { data: capsule(), error: null };
        },
        createDownload: async () => {
          accessed = true;
          return { data: null, error: null };
        },
      });
      let response: Response;
      if (operation === "list") {
        response = await createCapsulesRoute(dependencies(data, { authorizeDevice: undefined })).GET(
          signedRequest("/api/cli/capsules", "GET"),
        );
      } else if (operation === "inspect") {
        response = await createCapsuleRoute(dependencies(data, { authorizeDevice: undefined })).GET(
          signedRequest(`/api/cli/capsules/${CAPSULE_ID}`, "GET"),
          { params: { id: CAPSULE_ID } },
        );
      } else {
        response = await createCapsuleDownloadRoute(dependencies(data, { authorizeDevice: undefined })).POST(
          signedRequest(`/api/cli/capsules/${CAPSULE_ID}/download`, "POST", {
            schema: CAPSULE_DOWNLOAD_REQUEST_SCHEMA,
          }),
          { params: { id: CAPSULE_ID } },
        );
      }
      expect(response.status).toBe(403);
      expect((await body(response)).error.code).toBe("operation_not_allowed");
      expect(accessed).toBe(false);
    }
  });

  test("still rejects invalid proof, inactive devices, and cross-account devices when the gate is disabled", async () => {
    const invalidSignature = signedRequest(`/api/cli/capsules/${CAPSULE_ID}`, "DELETE", undefined, {
      headers: { "X-Sinter-Request-Signature": Buffer.alloc(64, 6).toString("base64url") },
    });
    const cases = [
      {
        request: invalidSignature,
        device: {
          id: DEVICE_ID,
          account_id: ACCOUNT_ID,
          fingerprint: SENDER,
          signing_public_key: signingPublicKey,
        },
        status: 401,
      },
      { request: signedRequest(`/api/cli/capsules/${CAPSULE_ID}`, "DELETE"), device: null, status: 403 },
      {
        request: signedRequest(`/api/cli/capsules/${CAPSULE_ID}`, "DELETE"),
        device: {
          id: DEVICE_ID,
          account_id: OTHER_ACCOUNT_ID,
          fingerprint: SENDER,
          signing_public_key: signingPublicKey,
        },
        status: 403,
      },
    ];
    for (const item of cases) {
      let claimed = false;
      let deleted = false;
      const data = source({
        loadActiveDevice: async () => ({ data: item.device, error: null }),
        claimRequestNonce: async () => {
          claimed = true;
          return { data: true, error: null };
        },
        deleteCapsule: async () => {
          deleted = true;
          return { data: null, error: null };
        },
      });
      const response = await createCapsuleRoute(dependencies(data, {
        uploadsEnabled: () => false,
        authorizeDevice: undefined,
      })).DELETE(item.request, { params: { id: CAPSULE_ID } });
      expect(response.status).toBe(item.status);
      expect(claimed).toBe(false);
      expect(deleted).toBe(false);
    }
  });
});

describe("capsule route operations", () => {
  test("reserves a capsule and returns only opaque metadata plus a signed upload URL", async () => {
    let call: { accountId: string; deviceId: string; input: CapsuleReservationInput } | null = null;
    const reserved = capsule({ status: "reserved", finalized_at: null });
    const data = source({
      reserveCapsule: async (accountId, deviceId, input) => {
        call = { accountId, deviceId, input };
        return {
          data: { capsule: reserved, signedUploadUrl: "https://storage.example.test/signed-upload?token=opaque" },
          error: null,
        };
      },
    });
    const response = await createCapsulesRoute(dependencies(data)).POST(
      request("/api/cli/capsules", "POST", reservation()),
    );
    const payload = await body(response);
    expect(response.status).toBe(201);
    expect(call).toMatchObject({ accountId: ACCOUNT_ID, deviceId: DEVICE_ID });
    expect(payload.capsule.id).toBe(CAPSULE_ID);
    expect(payload.upload.method).toBe("PUT");
    expect(payload.capsule.object_path).toBeUndefined();
    expect(payload.capsule.account_id).toBeUndefined();
    expect(payload.capsule.reservationRefreshedAt).toBeUndefined();
    expect(payload.capsule.expiryRequestedAt).toBeUndefined();
    expect(payload.capsule.storageCleanupCompletedAt).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(/title|repository|native_id|transcript|plaintext/i);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("maps disabled entitlement and reservation mismatch to stable sanitized errors", async () => {
    for (const error of [
      { code: "42501", message: "secret entitlement row detail" },
      { code: "PT409", message: "secret conflict detail" },
      { code: "CAPSULE_OBJECT_HASH_MISMATCH", message: "secret uploaded content detail" },
    ]) {
      const response = await createCapsulesRoute(dependencies(source({
        reserveCapsule: async () => ({ data: null, error }),
      }))).POST(request("/api/cli/capsules", "POST", reservation()));
      const payload = await body(response);
      expect(response.status).toBe(error.code === "42501" ? 403 : 409);
      expect(JSON.stringify(payload)).not.toContain(error.message);
    }
  });

  test("lists and inspects only validated account-scoped metadata", async () => {
    const data = source({
      listCapsules: async () => ({ data: [capsule()], error: null }),
      inspectCapsule: async () => ({ data: capsule(), error: null }),
    });
    const listed = await createCapsulesRoute(dependencies(data)).GET(request("/api/cli/capsules"));
    const listBody = await body(listed);
    expect(listed.status).toBe(200);
    expect(listBody.capsules).toHaveLength(1);
    expect(listBody.capsules[0].object_path).toBeUndefined();

    const inspected = await createCapsuleRoute(dependencies(data)).GET(
      request(`/api/cli/capsules/${CAPSULE_ID}`),
      { params: Promise.resolve({ id: CAPSULE_ID }) },
    );
    expect(inspected.status).toBe(200);
    expect((await body(inspected)).capsule.id).toBe(CAPSULE_ID);
  });

  test("hides missing and cross-account capsule inspection", async () => {
    for (const selected of [null, capsule({ account_id: OTHER_ACCOUNT_ID })]) {
      const response = await createCapsuleRoute(dependencies(source({
        inspectCapsule: async () => ({ data: selected, error: null }),
      }))).GET(request(`/api/cli/capsules/${CAPSULE_ID}`), { params: { id: CAPSULE_ID } });
      expect([404, 503]).toContain(response.status);
      expect(JSON.stringify(await body(response))).not.toContain(OTHER_ACCOUNT_ID);
    }
  });

  test("finalizes an exact uploaded object and surfaces idempotent success", async () => {
    let calls = 0;
    const data = source({
      finalizeCapsule: async (accountId, deviceId, id, bytes, hash) => {
        calls += 1;
        expect({ accountId, deviceId, id, bytes, hash }).toEqual({
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          id: CAPSULE_ID,
          bytes: 1024,
          hash: HASH,
        });
        return { data: capsule(), error: null };
      },
    });
    const route = createCapsuleFinalizeRoute(dependencies(data));
    for (let index = 0; index < 2; index += 1) {
      const response = await route.POST(
        request(`/api/cli/capsules/${CAPSULE_ID}/finalize`, "POST", {
          schema: CAPSULE_FINALIZE_SCHEMA,
          serializedBytes: 1024,
          serializedSha256: HASH,
        }),
        { params: { id: CAPSULE_ID } },
      );
      expect(response.status).toBe(200);
      expect((await body(response)).capsule.status).toBe("retained");
    }
    expect(calls).toBe(2);
  });

  test("maps missing, hash-mismatched, and unreadable uploaded objects to stable client errors", async () => {
    for (const item of [
      { code: "CAPSULE_OBJECT_NOT_FOUND", status: 404, publicCode: "capsule_object_not_uploaded" },
      { code: "CAPSULE_OBJECT_HASH_MISMATCH", status: 409, publicCode: "capsule_mismatch" },
      { code: "CAPSULE_OBJECT_READ_FAILED", status: 409, publicCode: "capsule_object_unreadable" },
    ]) {
      const backendDetail = `private ${item.code} detail`;
      const response = await createCapsuleFinalizeRoute(dependencies(source({
        finalizeCapsule: async () => ({
          data: null,
          error: { code: item.code, message: backendDetail },
        }),
      }))).POST(
        request(`/api/cli/capsules/${CAPSULE_ID}/finalize`, "POST", {
          schema: CAPSULE_FINALIZE_SCHEMA,
          serializedBytes: 1024,
          serializedSha256: HASH,
        }),
        { params: { id: CAPSULE_ID } },
      );
      const payload = await body(response);
      expect(response.status).toBe(item.status);
      expect(payload.error.code).toBe(item.publicCode);
      expect(JSON.stringify(payload)).not.toContain(backendDetail);
    }
  });

  test("maps a missing download object to the same stable not-uploaded response", async () => {
    const response = await createCapsuleDownloadRoute(dependencies(source({
      createDownload: async () => ({
        data: null,
        error: { code: "CAPSULE_OBJECT_NOT_FOUND", message: "private storage path" },
      }),
    }))).POST(
      request(`/api/cli/capsules/${CAPSULE_ID}/download`, "POST", {
        schema: CAPSULE_DOWNLOAD_REQUEST_SCHEMA,
      }),
      { params: { id: CAPSULE_ID } },
    );
    const payload = await body(response);
    expect(response.status).toBe(404);
    expect(payload.error.code).toBe("capsule_object_not_uploaded");
    expect(JSON.stringify(payload)).not.toContain("private storage path");
  });

  test("creates a short-lived signed download without leaking Storage paths", async () => {
    const data = source({
      createDownload: async () => ({
        data: {
          capsule: capsule(),
          signedDownloadUrl: "https://storage.example.test/signed-download?token=opaque",
          expiresInSeconds: 60,
        },
        error: null,
      }),
    });
    const response = await createCapsuleDownloadRoute(dependencies(data)).POST(
      request(`/api/cli/capsules/${CAPSULE_ID}/download`, "POST", {
        schema: CAPSULE_DOWNLOAD_REQUEST_SCHEMA,
      }),
      { params: { id: CAPSULE_ID } },
    );
    const payload = await body(response);
    expect(response.status).toBe(200);
    expect(payload.download.expiresInSeconds).toBe(60);
    expect(payload.capsule.object_path).toBeUndefined();
  });

  test("permanently deletes through the data-source state machine", async () => {
    let deleted: unknown;
    const data = source({
      deleteCapsule: async (accountId, deviceId, id) => {
        deleted = { accountId, deviceId, id };
        return {
          data: capsule({
            status: "deleted",
            deletion_requested_at: "2026-08-31T00:02:00.000Z",
            storage_deleted_at: "2026-08-31T00:03:00.000Z",
          }),
          error: null,
        };
      },
    });
    const response = await createCapsuleRoute(dependencies(data)).DELETE(
      request(`/api/cli/capsules/${CAPSULE_ID}`, "DELETE"),
      { params: { id: CAPSULE_ID } },
    );
    expect(response.status).toBe(200);
    expect(deleted).toEqual({ accountId: ACCOUNT_ID, deviceId: DEVICE_ID, id: CAPSULE_ID });
    expect((await body(response)).capsule.status).toBe("deleted");
  });
});
