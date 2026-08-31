import { describe, expect, test } from "bun:test";
import {
  CAPSULE_CLEANUP_BATCH_LIMIT,
  CAPSULE_CLEANUP_SCHEMA,
  CAPSULE_NONCE_CLEANUP_BATCH_LIMIT,
  createCapsuleCleanupHandler,
} from "../src/lib/capsule-cleanup";

const SECRET = "capsule-cleanup-test-secret";

function request(authorization?: string) {
  return new Request("https://cloud.example.test/api/cron/capsules", {
    headers: authorization ? { authorization } : undefined,
  });
}

async function payload(response: Response) {
  return await response.json() as {
    schema: string;
    ok: boolean;
    expiredReservations: number;
    expiredRequestNonces: number;
  };
}

function expectStableResponse(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("capsule cleanup cron", () => {
  test("rejects missing and wrong secrets without creating a data source", async () => {
    let sourceCalls = 0;
    const handler = createCapsuleCleanupHandler({
      cronSecret: () => SECRET,
      createSource: () => {
        sourceCalls += 1;
        throw new Error("must not create source");
      },
    });

    for (const candidate of [undefined, "Bearer wrong", SECRET, "Basic capsule-cleanup-test-secret"]) {
      const response = await handler(request(candidate));
      expect(response.status).toBe(401);
      expect(await payload(response)).toEqual({
        schema: CAPSULE_CLEANUP_SCHEMA,
        ok: false,
        expiredReservations: 0,
        expiredRequestNonces: 0,
      });
      expectStableResponse(response);
    }
    expect(sourceCalls).toBe(0);

    const missingConfiguration = createCapsuleCleanupHandler({
      cronSecret: () => undefined,
      createSource: () => {
        sourceCalls += 1;
        throw new Error("must not create source");
      },
    });
    const response = await missingConfiguration(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(401);
    expect(sourceCalls).toBe(0);
  });

  test("returns a sanitized configuration failure", async () => {
    const poison = "SUPABASE_SECRET_KEY object/path ciphertext fingerprint";
    const handler = createCapsuleCleanupHandler({
      cronSecret: () => SECRET,
      createSource: () => {
        throw new Error(poison);
      },
    });

    const response = await handler(request(`Bearer ${SECRET}`));
    const body = await payload(response);
    expect(response.status).toBe(503);
    expect(body).toEqual({
      schema: CAPSULE_CLEANUP_SCHEMA,
      ok: false,
      expiredReservations: 0,
      expiredRequestNonces: 0,
    });
    expect(JSON.stringify(body)).not.toContain(poison);
    expectStableResponse(response);
  });

  test("runs a bounded cleanup with uploads gated off and returns only the success count", async () => {
    let receivedLimit = 0;
    let receivedNonceLimit = 0;
    const poison = "/account/object/path ciphertext-hash sender-fingerprint";
    const handler = createCapsuleCleanupHandler({
      cronSecret: () => SECRET,
      createSource: () => ({
        expireReservations: async (limit) => {
          receivedLimit = limit ?? 0;
          return { data: [{ object_path: poison }, { serialized_sha256: poison }], error: null };
        },
        expireRequestNonces: async (limit) => {
          receivedNonceLimit = limit ?? 0;
          return { data: 7, error: null };
        },
      }),
    });

    const previousUploadGate = process.env.SINTER_REAL_UPLOADS_ENABLED;
    process.env.SINTER_REAL_UPLOADS_ENABLED = "false";
    const response = await handler(request(`Bearer ${SECRET}`));
    if (previousUploadGate === undefined) delete process.env.SINTER_REAL_UPLOADS_ENABLED;
    else process.env.SINTER_REAL_UPLOADS_ENABLED = previousUploadGate;
    const body = await payload(response);
    expect(response.status).toBe(200);
    expect(receivedLimit).toBe(CAPSULE_CLEANUP_BATCH_LIMIT);
    expect(receivedNonceLimit).toBe(CAPSULE_NONCE_CLEANUP_BATCH_LIMIT);
    expect(body).toEqual({
      schema: CAPSULE_CLEANUP_SCHEMA,
      ok: true,
      expiredReservations: 2,
      expiredRequestNonces: 7,
    });
    expect(JSON.stringify(body)).not.toContain(poison);
    expectStableResponse(response);
  });

  test("reports partial and transient failures without leaking cleanup metadata", async () => {
    const poison = "bucket/private/object serialized_sha256 fingerprint backend policy detail";
    const partial = createCapsuleCleanupHandler({
      cronSecret: () => SECRET,
      createSource: () => ({
        expireReservations: async () => ({
          data: [{ object_path: poison }],
          error: { code: "STORAGE_TRANSIENT", message: poison },
        }),
        expireRequestNonces: async () => ({ data: 3, error: null }),
      }),
    });
    const partialResponse = await partial(request(`Bearer ${SECRET}`));
    const partialBody = await payload(partialResponse);
    expect(partialResponse.status).toBe(502);
    expect(partialBody).toEqual({
      schema: CAPSULE_CLEANUP_SCHEMA,
      ok: false,
      expiredReservations: 1,
      expiredRequestNonces: 3,
    });
    expect(JSON.stringify(partialBody)).not.toContain(poison);
    expectStableResponse(partialResponse);

    const transient = createCapsuleCleanupHandler({
      cronSecret: () => SECRET,
      createSource: () => ({
        expireReservations: async () => {
          throw new Error(poison);
        },
        expireRequestNonces: async () => ({ data: 0, error: null }),
      }),
    });
    const transientResponse = await transient(request(`Bearer ${SECRET}`));
    const transientBody = await payload(transientResponse);
    expect(transientResponse.status).toBe(502);
    expect(transientBody.expiredReservations).toBe(0);
    expect(JSON.stringify(transientBody)).not.toContain(poison);
    expectStableResponse(transientResponse);
  });
});
