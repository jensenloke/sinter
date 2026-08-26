import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  DEVICE_APPROVAL_SCHEMA,
  DEVICE_REGISTRATION_SCHEMA,
  DEVICE_SUITE,
  canonicalJson,
  approvalProofData,
  deviceFingerprint,
  registrationProofData,
  type DeviceRegistration,
  type PublicP256Jwk,
} from "../src/lib/device-crypto";
import type {
  DeviceDataSource,
  DeviceEnrollmentRow,
  DeviceRow,
} from "../src/lib/device-data-source";

process.env.AUTH0_DOMAIN ||= "devices.example.test";
process.env.AUTH0_AUDIENCE ||= "https://api.example.test";
process.env.AUTH0_CLI_CLIENT_ID ||= "native-client";
process.env.AUTH0_CLIENT_ID ||= "web-client";
process.env.AUTH0_CLIENT_SECRET ||= "test-client-secret";
process.env.AUTH0_SECRET ||= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const {
  createDevicesRoute,
  createDevicePatchRoute,
  createEnrollmentsRoute,
  createEnrollmentApprovalRoute,
} = await import("../src/lib/device-http");

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ACCOUNT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-08-25T10:00:00.000Z");
const EXPIRES_AT = "2026-08-25T10:15:00.000Z";
const identity = async () => ({
  issuer: "https://devices.example.test/",
  subject: "auth0|device-user",
  email: "verified@example.test",
});

function keys(purpose: "encryption" | "signing") {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const exported = pair.publicKey.export({ format: "jwk" });
  const publicKey: PublicP256Jwk = {
    kty: "EC",
    crv: "P-256",
    x: exported.x!,
    y: exported.y!,
    use: purpose === "encryption" ? "enc" : "sig",
    key_ops: purpose === "encryption" ? [] : ["verify"],
    ext: true,
  };
  return { ...pair, publicKey };
}

function registrationFixture(name = "New laptop", options: { samePoint?: boolean } = {}) {
  const signing = keys("signing");
  const encryption = options.samePoint
    ? {
        ...signing,
        publicKey: {
          ...signing.publicKey,
          use: "enc" as const,
          key_ops: [] as [],
        },
      }
    : keys("encryption");
  const base: Omit<DeviceRegistration, "proof"> = {
    schema: DEVICE_REGISTRATION_SCHEMA,
    name,
    suite: DEVICE_SUITE,
    encryptionPublicKey: encryption.publicKey,
    signingPublicKey: signing.publicKey,
    fingerprint: deviceFingerprint(encryption.publicKey, signing.publicKey),
    nonce: Buffer.alloc(32, 5).toString("base64url"),
  };
  const proof = sign(
    "sha256",
    Buffer.from(canonicalJson(registrationProofData(base))),
    { key: signing.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  return { registration: { ...base, proof }, encryption, signing };
}

const registeredKeys = {
  encryption: keys("encryption"),
  signing: keys("signing"),
};

function deviceRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: DEVICE_ID,
    user_id: ACCOUNT_ID,
    name: "Existing laptop",
    suite: DEVICE_SUITE,
    encryption_public_key: registeredKeys.encryption.publicKey,
    signing_public_key: registeredKeys.signing.publicKey,
    fingerprint: deviceFingerprint(
      registeredKeys.encryption.publicKey,
      registeredKeys.signing.publicKey,
    ),
    created_at: "2026-08-20T00:00:00.000Z",
    last_seen_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function enrollmentRow(
  registration = registrationFixture().registration,
  overrides: Partial<DeviceEnrollmentRow> = {},
): DeviceEnrollmentRow {
  return {
    id: REQUEST_ID,
    user_id: ACCOUNT_ID,
    name: registration.name,
    suite: DEVICE_SUITE,
    encryption_public_key: registration.encryptionPublicKey,
    signing_public_key: registration.signingPublicKey,
    fingerprint: registration.fingerprint,
    status: "pending",
    created_at: NOW.toISOString(),
    expires_at: EXPIRES_AT,
    approved_at: null,
    approver_device_id: null,
    completed_device_id: null,
    ...overrides,
  };
}

function source(overrides: Partial<DeviceDataSource> = {}): DeviceDataSource {
  return {
    resolveAccountId: async () => ({ data: ACCOUNT_ID, error: null }),
    listDevices: async () => ({ data: [], error: null }),
    listEnrollments: async () => ({ data: [], error: null }),
    bootstrapDevice: async () => ({ data: null, error: null }),
    createEnrollment: async () => ({ data: null, error: null }),
    updateDevice: async () => ({ data: null, error: null }),
    loadEnrollment: async () => ({ data: null, error: null }),
    loadActiveDevice: async () => ({ data: null, error: null }),
    completeEnrollment: async () => ({ data: null, error: null }),
    ...overrides,
  };
}

function jsonRequest(path: string, body: unknown, method = "POST") {
  return new Request(`https://cloud.example.test${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function body(response: Response) {
  return await response.json() as Record<string, any>;
}

function deps(dataSource: DeviceDataSource) {
  return { authenticate: identity, createSource: () => dataSource, now: () => NOW };
}

function approvalSignature(
  privateKey: ReturnType<typeof keys>["privateKey"],
  fingerprint: string,
  expiresAt = EXPIRES_AT,
) {
  return sign(
    "sha256",
    Buffer.from(canonicalJson(approvalProofData(REQUEST_ID, DEVICE_ID, fingerprint, expiresAt))),
    { key: privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
}

describe("device registration and listing routes", () => {
  test("bootstraps the first-ever device through the service-only RPC boundary", async () => {
    const fixture = registrationFixture();
    const calls: string[] = [];
    const data = source({
      listDevices: async (accountId) => {
        calls.push(`list:${accountId}`);
        return { data: [], error: null };
      },
      bootstrapDevice: async (accountId, registration) => {
        calls.push(`bootstrap:${accountId}`);
        expect(registration).toEqual(fixture.registration);
        return {
          data: deviceRow({
            name: registration.name,
            encryption_public_key: registration.encryptionPublicKey,
            signing_public_key: registration.signingPublicKey,
            fingerprint: registration.fingerprint,
          }),
          error: null,
        };
      },
    });
    const response = await createDevicesRoute(deps(data)).POST(
      jsonRequest("/api/cli/devices", fixture.registration),
    );
    const payload = await body(response);
    expect(response.status).toBe(201);
    expect(payload.status).toBe("registered");
    expect(payload.device.user_id).toBeUndefined();
    expect(payload.device.signingPublicKey.d).toBeUndefined();
    expect(calls).toEqual([`list:${ACCOUNT_ID}`, `bootstrap:${ACCOUNT_ID}`]);
  });

  test("creates an expiring pending enrollment when an active device exists", async () => {
    const fixture = registrationFixture();
    const data = source({
      listDevices: async () => ({ data: [deviceRow()], error: null }),
      createEnrollment: async (accountId, registration, expiresAt) => {
        expect(accountId).toBe(ACCOUNT_ID);
        expect(expiresAt).toBe(EXPIRES_AT);
        return { data: enrollmentRow(registration, { expires_at: expiresAt }), error: null };
      },
    });
    const response = await createDevicesRoute(deps(data)).POST(
      jsonRequest("/api/cli/devices", fixture.registration),
    );
    const payload = await body(response);
    expect(response.status).toBe(202);
    expect(payload).toMatchObject({
      status: "approval_required",
      request: { id: REQUEST_ID, requestFingerprint: fixture.registration.fingerprint, expiresAt: EXPIRES_AT },
    });
    expect(JSON.stringify(payload)).not.toContain(fixture.registration.proof);
    expect(JSON.stringify(payload)).not.toContain(fixture.registration.nonce);
  });

  test("does not bootstrap recovery after every historical device was revoked", async () => {
    const fixture = registrationFixture();
    let wrote = false;
    const data = source({
      listDevices: async () => ({ data: [deviceRow({ revoked_at: NOW.toISOString() })], error: null }),
      bootstrapDevice: async () => {
        wrote = true;
        return { data: null, error: null };
      },
      createEnrollment: async () => {
        wrote = true;
        return { data: null, error: null };
      },
    });
    const response = await createDevicesRoute(deps(data)).POST(
      jsonRequest("/api/cli/devices", fixture.registration),
    );
    const payload = await body(response);
    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("device_recovery_unavailable");
    expect(wrote).toBe(false);
  });

  test("rejects same-point registration before device lookup or any write", async () => {
    const fixture = registrationFixture("Invalid laptop", { samePoint: true });
    let listed = false;
    let wrote = false;
    const data = source({
      listDevices: async () => {
        listed = true;
        return { data: [], error: null };
      },
      bootstrapDevice: async () => {
        wrote = true;
        return { data: null, error: null };
      },
      createEnrollment: async () => {
        wrote = true;
        return { data: null, error: null };
      },
    });
    const response = await createDevicesRoute(deps(data)).POST(
      jsonRequest("/api/cli/devices", fixture.registration),
    );
    expect(response.status).toBe(400);
    expect(listed).toBe(false);
    expect(wrote).toBe(false);
  });

  test("verifies registration proof before any write", async () => {
    const fixture = registrationFixture();
    let wrote = false;
    const data = source({
      listDevices: async () => ({ data: [], error: null }),
      bootstrapDevice: async () => {
        wrote = true;
        return { data: null, error: null };
      },
    });
    const response = await createDevicesRoute(deps(data)).POST(
      jsonRequest("/api/cli/devices", {
        ...fixture.registration,
        proof: Buffer.alloc(64).toString("base64url"),
      }),
    );
    expect(response.status).toBe(400);
    expect(wrote).toBe(false);
  });

  test("fails closed when the explicit issuer+subject account mapping is missing", async () => {
    let listed = false;
    const data = source({
      resolveAccountId: async (received) => {
        expect(received.subject).toBe("auth0|device-user");
        return { data: null, error: null };
      },
      listDevices: async () => {
        listed = true;
        return { data: [], error: null };
      },
    });
    const response = await createDevicesRoute(deps(data)).GET(
      new Request("https://cloud.example.test/api/cli/devices"),
    );
    expect(response.status).toBe(403);
    expect(listed).toBe(false);
  });

  test("lists only public metadata and public JWKs", async () => {
    const data = source({ listDevices: async () => ({ data: [deviceRow()], error: null }) });
    const response = await createDevicesRoute(deps(data)).GET(
      new Request("https://cloud.example.test/api/cli/devices"),
    );
    const payload = await body(response);
    expect(response.status).toBe(200);
    expect(payload.devices[0].user_id).toBeUndefined();
    expect(payload.devices[0].signing_public_key).toBeUndefined();
    expect(payload.devices[0].signingPublicKey).toEqual(registeredKeys.signing.publicKey);
    expect(payload.devices[0].signingPublicKey.d).toBeUndefined();
  });

  test("PATCH sends only a scoped rename or revoke update", async () => {
    const updates: unknown[] = [];
    const data = source({
      updateDevice: async (accountId, deviceId, update) => {
        updates.push({ accountId, deviceId, update });
        return { data: deviceRow({ name: "Renamed" }), error: null };
      },
    });
    const response = await createDevicePatchRoute(deps(data)).PATCH(
      jsonRequest(`/api/cli/devices/${DEVICE_ID}`, {
        action: "rename",
        name: "Renamed",
      }, "PATCH"),
      { params: { id: DEVICE_ID } },
    );
    expect(response.status).toBe(200);
    expect(updates).toEqual([{ accountId: ACCOUNT_ID, deviceId: DEVICE_ID, update: { name: "Renamed" } }]);
  });
});

describe("device approval route", () => {
  test("completes a valid approval through the service-only atomic RPC", async () => {
    const enrollment = enrollmentRow();
    const signature = approvalSignature(
      registeredKeys.signing.privateKey,
      enrollment.fingerprint,
    );
    let completion: unknown;
    const data = source({
      loadEnrollment: async () => ({ data: enrollment, error: null }),
      loadActiveDevice: async () => ({ data: deviceRow(), error: null }),
      completeEnrollment: async (accountId, requestId, approverDeviceId, receivedSignature) => {
        completion = { accountId, requestId, approverDeviceId, receivedSignature };
        return { data: deviceRow({ id: "22222222-2222-4222-8222-222222222222" }), error: null };
      },
    });
    const response = await createEnrollmentApprovalRoute(deps(data)).POST(
      jsonRequest(`/api/cli/device-enrollments/${REQUEST_ID}/approve`, {
        schema: DEVICE_APPROVAL_SCHEMA,
        approverDeviceId: DEVICE_ID,
        signature,
      }),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );
    expect(response.status).toBe(200);
    expect(completion).toEqual({
      accountId: ACCOUNT_ID,
      requestId: REQUEST_ID,
      approverDeviceId: DEVICE_ID,
      receivedSignature: signature,
    });
  });

  test("retries an approved but unclaimed enrollment with the same approver", async () => {
    const enrollment = enrollmentRow(undefined, {
      status: "approved",
      approved_at: "2026-08-25T09:59:00.000Z",
      approver_device_id: DEVICE_ID,
    });
    const signature = approvalSignature(
      registeredKeys.signing.privateKey,
      enrollment.fingerprint,
    );
    let completed = false;
    const data = source({
      loadEnrollment: async () => ({ data: enrollment, error: null }),
      loadActiveDevice: async () => ({ data: deviceRow(), error: null }),
      completeEnrollment: async () => {
        completed = true;
        return { data: deviceRow({ id: "22222222-2222-4222-8222-222222222222" }), error: null };
      },
    });
    const response = await createEnrollmentApprovalRoute(deps(data)).POST(
      jsonRequest(`/api/cli/device-enrollments/${REQUEST_ID}/approve`, {
        schema: DEVICE_APPROVAL_SCHEMA,
        approverDeviceId: DEVICE_ID,
        signature,
      }),
      { params: { id: REQUEST_ID } },
    );
    expect(response.status).toBe(200);
    expect(completed).toBe(true);
  });

  test("rejects invalid approval signatures without calling completion", async () => {
    const enrollment = enrollmentRow();
    let completed = false;
    const data = source({
      loadEnrollment: async () => ({ data: enrollment, error: null }),
      loadActiveDevice: async () => ({ data: deviceRow(), error: null }),
      completeEnrollment: async () => {
        completed = true;
        return { data: deviceRow(), error: null };
      },
    });
    const response = await createEnrollmentApprovalRoute(deps(data)).POST(
      jsonRequest(`/api/cli/device-enrollments/${REQUEST_ID}/approve`, {
        schema: DEVICE_APPROVAL_SCHEMA,
        approverDeviceId: DEVICE_ID,
        signature: Buffer.alloc(64).toString("base64url"),
      }),
      { params: { id: REQUEST_ID } },
    );
    expect(response.status).toBe(403);
    expect(completed).toBe(false);
  });

  test("hides cross-account enrollment requests", async () => {
    let loadedApprover = false;
    const data = source({
      loadEnrollment: async (accountId) => {
        expect(accountId).toBe(ACCOUNT_ID);
        return { data: null, error: null };
      },
      loadActiveDevice: async () => {
        loadedApprover = true;
        return { data: deviceRow({ user_id: OTHER_ACCOUNT_ID }), error: null };
      },
    });
    const response = await createEnrollmentApprovalRoute(deps(data)).POST(
      jsonRequest(`/api/cli/device-enrollments/${REQUEST_ID}/approve`, {
        schema: DEVICE_APPROVAL_SCHEMA,
        approverDeviceId: DEVICE_ID,
        signature: Buffer.alloc(64).toString("base64url"),
      }),
      { params: { id: REQUEST_ID } },
    );
    expect(response.status).toBe(404);
    expect(loadedApprover).toBe(false);
  });

  test("rejects revoked or cross-account approvers", async () => {
    const enrollment = enrollmentRow();
    for (const approver of [
      null,
      deviceRow({ user_id: OTHER_ACCOUNT_ID }),
      deviceRow({ revoked_at: "2026-08-24T00:00:00.000Z" }),
    ]) {
      const data = source({
        loadEnrollment: async () => ({ data: enrollment, error: null }),
        loadActiveDevice: async () => ({ data: approver, error: null }),
      });
      const response = await createEnrollmentApprovalRoute(deps(data)).POST(
        jsonRequest(`/api/cli/device-enrollments/${REQUEST_ID}/approve`, {
          schema: DEVICE_APPROVAL_SCHEMA,
          approverDeviceId: DEVICE_ID,
          signature: Buffer.alloc(64).toString("base64url"),
        }),
        { params: { id: REQUEST_ID } },
      );
      expect(response.status).toBe(403);
    }
  });

  test("rejects expired and replayed enrollment requests before loading an approver", async () => {
    for (const enrollment of [
      enrollmentRow(undefined, { expires_at: NOW.toISOString() }),
      enrollmentRow(undefined, {
        status: "claimed",
        approved_at: "2026-08-25T09:59:00.000Z",
        approver_device_id: DEVICE_ID,
        completed_device_id: DEVICE_ID,
      }),
    ]) {
      let loadedApprover = false;
      const data = source({
        loadEnrollment: async () => ({ data: enrollment, error: null }),
        loadActiveDevice: async () => {
          loadedApprover = true;
          return { data: deviceRow(), error: null };
        },
      });
      const response = await createEnrollmentApprovalRoute(deps(data)).POST(
        jsonRequest(`/api/cli/device-enrollments/${REQUEST_ID}/approve`, {
          schema: DEVICE_APPROVAL_SCHEMA,
          approverDeviceId: DEVICE_ID,
          signature: Buffer.alloc(64).toString("base64url"),
        }),
        { params: { id: REQUEST_ID } },
      );
      expect(response.status).toBe(409);
      expect(loadedApprover).toBe(false);
    }
  });

  test("lists live pending and retryable approved requests without proof material", async () => {
    const fixture = registrationFixture();
    const live = enrollmentRow(fixture.registration);
    const approved = enrollmentRow(fixture.registration, {
      id: "77777777-7777-4777-8777-777777777777",
      status: "approved",
      approved_at: "2026-08-25T09:59:00.000Z",
      approver_device_id: DEVICE_ID,
    });
    const data = source({
      listEnrollments: async () => ({
        data: [
          live,
          approved,
          enrollmentRow(fixture.registration, { id: "88888888-8888-4888-8888-888888888888", expires_at: NOW.toISOString() }),
        ],
        error: null,
      }),
    });
    const response = await createEnrollmentsRoute(deps(data)).GET(
      new Request("https://cloud.example.test/api/cli/device-enrollments"),
    );
    const payload = await body(response);
    expect(response.status).toBe(200);
    expect(payload.enrollments).toHaveLength(2);
    expect(payload.enrollments.map((item: { status: string }) => item.status)).toEqual(["pending", "approved"]);
    expect(payload.enrollments[0].user_id).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(fixture.registration.proof);
    expect(JSON.stringify(payload)).not.toContain(fixture.registration.nonce);
  });
});

describe("sanitized device service failures", () => {
  test("does not return database details", async () => {
    const sensitive = "postgres policy detail with internal table name";
    const data = source({ listDevices: async () => ({ data: null, error: { message: sensitive } }) });
    const response = await createDevicesRoute(deps(data)).GET(
      new Request("https://cloud.example.test/api/cli/devices"),
    );
    const serialized = JSON.stringify(await body(response));
    expect(response.status).toBe(503);
    expect(serialized).not.toContain(sensitive);
    expect(serialized).toContain("Device service is unavailable");
  });

  test("fails closed without the server secret and never leaks a supplied secret", async () => {
    const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousSecret = process.env.SUPABASE_SECRET_KEY;
    const sentinel = "never-return-this-server-secret";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_SECRET_KEY = sentinel;
    try {
      const fixture = registrationFixture();
      const response = await createDevicesRoute({ authenticate: identity }).POST(
        jsonRequest("/api/cli/devices", fixture.registration),
      );
      const serialized = JSON.stringify(await body(response));
      expect(response.status).toBe(503);
      expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain("SUPABASE_SECRET_KEY");
      expect(serialized).toContain("configuration");
    } finally {
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
      if (previousSecret === undefined) delete process.env.SUPABASE_SECRET_KEY;
      else process.env.SUPABASE_SECRET_KEY = previousSecret;
    }
  });
});
