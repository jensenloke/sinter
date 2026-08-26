import { describe, expect, test } from "bun:test";
import {
  createCloudDeviceApiClient,
  createCloudDeviceService,
  type CloudDeviceApiClient,
} from "../src/cloud-devices";
import type { DeviceCredentialStore } from "../src/device-credentials";
import type { DeviceKeyMaterial } from "../src/device-identity";
import {
  createDeviceRegistrationBody,
  DEVICE_CRYPTO_SUITE,
  deviceFingerprint,
  generateDeviceKeyMaterial,
  verifyCanonicalSignature,
} from "../src/device-identity";

function memoryKeyStore(initial: DeviceKeyMaterial) {
  let material = initial;
  let saves = 0;
  let deletes = 0;
  const store: DeviceCredentialStore = {
    description: "test key store",
    async load() { return material; },
    async save(next) { material = next; saves++; },
    async delete() { deletes++; },
  };
  return { store, material: () => material, saves: () => saves, deletes: () => deletes };
}

function inertApi(overrides: Partial<CloudDeviceApiClient> = {}): CloudDeviceApiClient {
  return {
    async listDevices() { return []; },
    async registerDevice() { throw new Error("unexpected registration"); },
    async renameDevice() {},
    async revokeDevice() {},
    async listEnrollments() { return []; },
    async approveEnrollment() {},
    ...overrides,
  };
}

describe("Cloud device API", () => {
  test("uses both Auth0 headers and the versioned endpoint payloads", async () => {
    const keys = await generateDeviceKeyMaterial();
    const registration = await createDeviceRegistrationBody(keys, "Test Mac", "nonce-for-api-test");
    const calls: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
    const api = createCloudDeviceApiClient({
      session: async () => ({ baseUrl: "https://cloud.example.test", accessToken: "api-access-secret", idToken: "id-token-secret" }),
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method, headers: new Headers(init?.headers), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (url.endsWith("/api/cli/devices") && method === "GET") {
          return Response.json({ schema: "sinter.cloud.devices.v1", devices: [
            { id: "device-1", name: "Existing", fingerprint: "fingerprint-1", status: "active" },
          ] });
        }
        if (url.endsWith("/api/cli/devices") && method === "POST") {
          return Response.json({ device: { id: "device-2", name: "Test Mac", fingerprint: registration.fingerprint } }, { status: 201 });
        }
        if (url.endsWith("/api/cli/device-enrollments") && method === "GET") {
          return Response.json({ enrollments: [
            { id: "request-1", name: "New Mac", fingerprint: "request-fingerprint", expiresAt: "2030-01-01T00:00:00.000Z" },
          ] });
        }
        return new Response(null, { status: 204 });
      },
    });

    expect(await api.listDevices()).toHaveLength(1);
    expect((await api.registerDevice(registration)).status).toBe("registered");
    await api.renameDevice("device/2", "Renamed");
    await api.revokeDevice("device/2");
    expect(await api.listEnrollments()).toHaveLength(1);
    await api.approveEnrollment("request/1", {
      schema: "sinter.cloud.device-approval.v1",
      approverDeviceId: "device-1",
      signature: "base64url-signature",
    });

    expect(calls.map((call) => [call.method, call.url.replace("https://cloud.example.test", "")])).toEqual([
      ["GET", "/api/cli/devices"],
      ["POST", "/api/cli/devices"],
      ["PATCH", "/api/cli/devices/device%2F2"],
      ["PATCH", "/api/cli/devices/device%2F2"],
      ["GET", "/api/cli/device-enrollments"],
      ["POST", "/api/cli/device-enrollments/request%2F1/approve"],
    ]);
    for (const call of calls) {
      expect(call.headers.get("Authorization")).toBe("Bearer api-access-secret");
      expect(call.headers.get("X-Sinter-ID-Token")).toBe("id-token-secret");
    }
    expect(calls[1]?.body).toEqual(registration);
    expect(JSON.stringify(calls[1]?.body)).not.toContain('"d"');
    expect(calls[2]?.body).toEqual({ schema: "sinter.cloud.device-update.v1", name: "Renamed" });
    expect(calls[3]?.body).toEqual({ schema: "sinter.cloud.device-update.v1", revoke: true });
    expect(calls[5]?.body).toEqual({
      schema: "sinter.cloud.device-approval.v1",
      approverDeviceId: "device-1",
      signature: "base64url-signature",
    });
  });

  test("surfaces approval-required registration without treating it as an HTTP error", async () => {
    const keys = await generateDeviceKeyMaterial();
    const api = createCloudDeviceApiClient({
      session: async () => ({ baseUrl: "https://cloud.example.test", accessToken: "access", idToken: "id" }),
      fetch: async () => Response.json({
        status: "approval_required",
        request: { id: "request-2", fingerprint: "fingerprint-2", expiresAt: "2030-02-01T00:00:00.000Z" },
      }, { status: 202 }),
    });
    expect(await api.registerDevice(await createDeviceRegistrationBody(keys, "Pending"))).toEqual({
      status: "approval_required",
      enrollment: { id: "request-2", requestFingerprint: "fingerprint-2", expiresAt: "2030-02-01T00:00:00.000Z" },
    });
  });
});

describe("Cloud device service", () => {
  test("persists the returned device id and signs approval over server request fields", async () => {
    let material: DeviceKeyMaterial = { ...(await generateDeviceKeyMaterial()), deviceId: "approver-1" };
    let saved = 0;
    let approvalBody: Parameters<CloudDeviceApiClient["approveEnrollment"]>[1] | undefined;
    const keyStore: DeviceCredentialStore = {
      description: "test key store",
      async load() { return material; },
      async save(next) { material = next; saved++; },
      async delete() {},
    };
    const api: CloudDeviceApiClient = {
      async listDevices() { return []; },
      async registerDevice(body) {
        return {
          status: "registered",
          deviceId: "registered-2",
          device: { id: "registered-2", name: body.name, fingerprint: body.fingerprint, suite: body.suite, status: "active" },
        };
      },
      async renameDevice() {},
      async revokeDevice() {},
      async listEnrollments() {
        return [{ id: "request-1", requestFingerprint: "requested-fingerprint", expiresAt: "2030-03-01T00:00:00.000Z" }];
      },
      async approveEnrollment(_id, body) { approvalBody = body; },
    };
    const service = createCloudDeviceService({ api, keys: keyStore });
    const approval = await service.approve("request-1");
    expect(approval).toEqual({ requestId: "request-1", approverDeviceId: "approver-1" });
    expect(await verifyCanonicalSignature({
      schema: "sinter.cloud.device-approval.v1",
      requestId: "request-1",
      approverDeviceId: "approver-1",
      requestFingerprint: "requested-fingerprint",
      expiresAt: "2030-03-01T00:00:00.000Z",
    }, approvalBody!.signature, material.signingPublicKey)).toBe(true);

    const result = await service.register("Registered Mac");
    expect(result.status).toBe("registered");
    expect(material.deviceId).toBe("registered-2");
    expect(saved).toBe(1);
  });

  test("rejects same-point local keys before registration or lookup calls", async () => {
    const generated = await generateDeviceKeyMaterial();
    const material: DeviceKeyMaterial = {
      ...generated,
      signingPublicKey: { ...generated.encryptionPublicKey },
      signingPrivateKey: { ...generated.encryptionPrivateKey },
    };
    let apiCalls = 0;
    const keyStore: DeviceCredentialStore = {
      description: "test key store",
      async load() { return material; },
      async save() {},
      async delete() {},
    };
    const api: CloudDeviceApiClient = {
      async listDevices() { apiCalls++; return []; },
      async registerDevice() { apiCalls++; return { status: "registered", deviceId: "unexpected" }; },
      async renameDevice() {},
      async revokeDevice() {},
      async listEnrollments() { apiCalls++; return []; },
      async approveEnrollment() {},
    };

    await expect(createCloudDeviceService({ api, keys: keyStore }).register("Invalid Mac"))
      .rejects.toThrow("Local device encryption and signing public keys must be distinct");
    expect(apiCalls).toBe(0);
  });

  test("reuses a pending enrollment for the same local fingerprint", async () => {
    const material: DeviceKeyMaterial = await generateDeviceKeyMaterial();
    let registrationCalls = 0;
    const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
    const keyStore: DeviceCredentialStore = {
      description: "test key store",
      async load() { return material; },
      async save() {},
      async delete() {},
    };
    const api: CloudDeviceApiClient = {
      async listDevices() { return []; },
      async registerDevice() {
        registrationCalls++;
        return { status: "registered", deviceId: "unexpected" };
      },
      async renameDevice() {},
      async revokeDevice() {},
      async listEnrollments() {
        return [{ id: "pending-request", requestFingerprint: fingerprint, expiresAt: "2030-01-01T00:00:00.000Z" }];
      },
      async approveEnrollment() {},
    };

    const result = await createCloudDeviceService({ api, keys: keyStore }).register("Pending Mac", { wait: false });
    expect(result).toMatchObject({ status: "approval_required", enrollment: { id: "pending-request" } });
    expect(registrationCalls).toBe(0);
  });

  test("claims an approved local key by matching its registered fingerprint", async () => {
    let material: DeviceKeyMaterial = await generateDeviceKeyMaterial();
    let registrationCalls = 0;
    const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
    const keyStore: DeviceCredentialStore = {
      description: "test key store",
      async load() { return material; },
      async save(next) { material = next; },
      async delete() {},
    };
    const api: CloudDeviceApiClient = {
      async listDevices() {
        return [{ id: "approved-device", name: "Approved Mac", fingerprint, suite: DEVICE_CRYPTO_SUITE, status: "active", revokedAt: null }];
      },
      async registerDevice() {
        registrationCalls++;
        return { status: "registered", deviceId: "unexpected" };
      },
      async renameDevice() {},
      async revokeDevice() {},
      async listEnrollments() { return []; },
      async approveEnrollment() {},
    };

    const result = await createCloudDeviceService({ api, keys: keyStore }).register("Approved Mac");
    expect(result.status).toBe("registered");
    expect(material.deviceId).toBe("approved-device");
    expect(registrationCalls).toBe(0);
  });

  test("registers the first device immediately and verifies identity before saving its id", async () => {
    const material = await generateDeviceKeyMaterial();
    const keys = memoryKeyStore(material);
    let registrationCalls = 0;
    const api = inertApi({
      async registerDevice(body) {
        registrationCalls++;
        return {
          status: "registered",
          device: { id: "first-device", name: body.name, fingerprint: body.fingerprint, suite: body.suite, status: "active" },
        };
      },
    });

    const result = await createCloudDeviceService({ api, keys: keys.store }).register("First Mac");
    expect(result).toMatchObject({ status: "registered", deviceId: "first-device" });
    expect(keys.material().deviceId).toBe("first-device");
    expect(keys.saves()).toBe(1);
    expect(registrationCalls).toBe(1);
  });

  test("waits through two polls after approval is required and auto-saves the approved device", async () => {
    const material = await generateDeviceKeyMaterial();
    const keys = memoryKeyStore(material);
    const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
    let now = Date.parse("2026-08-25T10:00:00.000Z");
    const enrollment = { id: "request-auto", requestFingerprint: fingerprint, expiresAt: new Date(now + 60_000).toISOString() };
    let deviceLists = 0;
    let enrollmentLists = 0;
    let registrationCalls = 0;
    const statuses: unknown[] = [];
    const approved = { id: "approved-auto", name: "Second Mac", fingerprint, suite: DEVICE_CRYPTO_SUITE, status: "active" };
    const api = inertApi({
      async listDevices() {
        deviceLists++;
        return deviceLists >= 3 ? [approved] : [];
      },
      async listEnrollments() {
        enrollmentLists++;
        return enrollmentLists === 1 ? [] : [enrollment];
      },
      async registerDevice() {
        registrationCalls++;
        return { status: "approval_required", enrollment };
      },
    });
    const service = createCloudDeviceService({
      api,
      keys: keys.store,
      now: () => now,
      pollIntervalMs: 100,
      pause: async (ms) => { now += ms; },
    });

    const result = await service.register("Second Mac", { onStatus: (status) => { statuses.push(status); } });
    expect(result).toMatchObject({ status: "registered", deviceId: "approved-auto" });
    expect(keys.material().deviceId).toBe("approved-auto");
    expect(deviceLists).toBe(3);
    expect(enrollmentLists).toBe(2);
    expect(registrationCalls).toBe(1);
    expect(statuses).toEqual([{ status: "waiting_for_approval", requestId: "request-auto", expiresAt: enrollment.expiresAt }]);
  });

  test("--no-wait service mode returns approval-required without polling or duplicating the request", async () => {
    const material = await generateDeviceKeyMaterial();
    const keys = memoryKeyStore(material);
    const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
    const enrollment = { id: "request-script", requestFingerprint: fingerprint, expiresAt: "2030-01-01T00:00:00.000Z" };
    let deviceLists = 0;
    let enrollmentLists = 0;
    let registrationCalls = 0;
    let pauses = 0;
    const api = inertApi({
      async listDevices() { deviceLists++; return []; },
      async listEnrollments() { enrollmentLists++; return []; },
      async registerDevice() { registrationCalls++; return { status: "approval_required", enrollment }; },
    });
    const result = await createCloudDeviceService({
      api,
      keys: keys.store,
      pause: async () => { pauses++; },
    }).register("Script Mac", { wait: false });

    expect(result.status).toBe("approval_required");
    expect(deviceLists).toBe(1);
    expect(enrollmentLists).toBe(1);
    expect(registrationCalls).toBe(1);
    expect(pauses).toBe(0);
  });

  test("times out at the caller deadline and expires at the earlier server deadline", async () => {
    for (const scenario of ["timeout", "expiry"] as const) {
      const material = await generateDeviceKeyMaterial();
      const keys = memoryKeyStore(material);
      const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
      let now = Date.parse("2026-08-25T10:00:00.000Z");
      const expiresIn = scenario === "expiry" ? 50 : 10_000;
      const enrollment = { id: `request-${scenario}`, requestFingerprint: fingerprint, expiresAt: new Date(now + expiresIn).toISOString() };
      let enrollmentLists = 0;
      const api = inertApi({
        async listEnrollments() { enrollmentLists++; return enrollmentLists === 1 ? [enrollment] : [enrollment]; },
      });
      const service = createCloudDeviceService({
        api,
        keys: keys.store,
        now: () => now,
        pollIntervalMs: 5_000,
        pause: async (ms) => { now += ms; },
      });
      const registration = service.register("Waiting Mac", { timeoutMs: 5_000 });
      if (scenario === "timeout") await expect(registration).rejects.toThrow("Timed out waiting for device approval");
      else await expect(registration).rejects.toThrow("Device enrollment expired or disappeared");
      expect(keys.material().deviceId).toBeUndefined();
      expect(keys.deletes()).toBe(0);
    }
  });

  test("fails with the fixed rerun error when the enrollment disappears before a device matches", async () => {
    const material = await generateDeviceKeyMaterial();
    const keys = memoryKeyStore(material);
    const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
    const enrollment = { id: "request-gone", requestFingerprint: fingerprint, expiresAt: "2030-01-01T00:00:00.000Z" };
    let enrollmentLists = 0;
    let registrationCalls = 0;
    const api = inertApi({
      async listEnrollments() { enrollmentLists++; return enrollmentLists === 1 ? [enrollment] : []; },
      async registerDevice() { registrationCalls++; throw new Error("must not create another request"); },
    });

    await expect(createCloudDeviceService({ api, keys: keys.store }).register("Gone Mac"))
      .rejects.toThrow("Rerun `sinter devices register`");
    expect(registrationCalls).toBe(0);
    expect(keys.deletes()).toBe(0);
  });

  test("abort stops polling without deleting the pending request or local keys", async () => {
    const material = await generateDeviceKeyMaterial();
    const keys = memoryKeyStore(material);
    const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
    const enrollment = { id: "request-abort", requestFingerprint: fingerprint, expiresAt: "2030-01-01T00:00:00.000Z" };
    const controller = new AbortController();
    let enrollmentLists = 0;
    const api = inertApi({
      async listEnrollments() { enrollmentLists++; return [enrollment]; },
    });
    const service = createCloudDeviceService({
      api,
      keys: keys.store,
      pause: async () => { controller.abort(new Error("private abort reason")); },
    });

    await expect(service.register("Abort Mac", { signal: controller.signal })).rejects.toThrow("Stopped waiting for device approval");
    expect(enrollmentLists).toBeGreaterThanOrEqual(2);
    expect(keys.material().deviceId).toBeUndefined();
    expect(keys.deletes()).toBe(0);
  });

  test.each(["network token=secret", "HTTP 503 proof=secret"])("sanitizes polling failure: %s", async (privateError) => {
    const material = await generateDeviceKeyMaterial();
    const keys = memoryKeyStore(material);
    const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
    const enrollment = { id: "request-failure", requestFingerprint: fingerprint, expiresAt: "2030-01-01T00:00:00.000Z" };
    let deviceLists = 0;
    const api = inertApi({
      async listDevices() {
        deviceLists++;
        if (deviceLists > 1) throw new Error(privateError);
        return [];
      },
      async listEnrollments() { return [enrollment]; },
    });

    const registration = createCloudDeviceService({ api, keys: keys.store }).register("Failure Mac");
    await expect(registration).rejects.toThrow("Could not check device approval");
    await expect(registration).rejects.not.toThrow(privateError);
    expect(keys.deletes()).toBe(0);
  });

  test("ignores other fingerprints but rejects an exact-fingerprint suite mismatch before saving", async () => {
    const material = await generateDeviceKeyMaterial();
    const keys = memoryKeyStore(material);
    const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
    const enrollment = { id: "request-suite", requestFingerprint: fingerprint, expiresAt: "2030-01-01T00:00:00.000Z" };
    let deviceLists = 0;
    const api = inertApi({
      async listDevices() {
        deviceLists++;
        if (deviceLists === 1) return [{ id: "other", name: "Other", fingerprint: "f".repeat(64), suite: DEVICE_CRYPTO_SUITE, status: "active" }];
        return [{ id: "bad-suite", name: "Bad", fingerprint, suite: "unexpected-suite", status: "active" }];
      },
      async listEnrollments() { return [enrollment]; },
    });

    await expect(createCloudDeviceService({ api, keys: keys.store }).register("Suite Mac"))
      .rejects.toThrow("unexpected cryptographic suite");
    expect(keys.material().deviceId).toBeUndefined();
    expect(keys.saves()).toBe(0);
  });

  test("rejects a mismatched immediate registration response without saving its id", async () => {
    const material = await generateDeviceKeyMaterial();
    const keys = memoryKeyStore(material);
    const api = inertApi({
      async registerDevice(body) {
        return {
          status: "registered",
          device: { id: "wrong-device", name: body.name, fingerprint: "0".repeat(64), suite: DEVICE_CRYPTO_SUITE, status: "active" },
        };
      },
    });

    await expect(createCloudDeviceService({ api, keys: keys.store }).register("Mismatch Mac"))
      .rejects.toThrow("unexpected registered device identity");
    expect(keys.material().deviceId).toBeUndefined();
    expect(keys.saves()).toBe(0);
  });

  test("rejects concurrent registration in one service instance without creating a duplicate request", async () => {
    const material = await generateDeviceKeyMaterial();
    const keys = memoryKeyStore(material);
    const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
    const enrollment = { id: "request-concurrent", requestFingerprint: fingerprint, expiresAt: "2030-01-01T00:00:00.000Z" };
    let registrationCalls = 0;
    let enrollmentLists = 0;
    let enteredPause!: () => void;
    const pauseStarted = new Promise<void>((resolve) => { enteredPause = resolve; });
    const controller = new AbortController();
    const api = inertApi({
      async listEnrollments() { enrollmentLists++; return enrollmentLists === 1 ? [] : [enrollment]; },
      async registerDevice() { registrationCalls++; return { status: "approval_required", enrollment }; },
    });
    const service = createCloudDeviceService({
      api,
      keys: keys.store,
      pause: async (_ms, signal) => {
        enteredPause();
        await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    });

    const first = service.register("Concurrent Mac", { signal: controller.signal });
    await pauseStarted;
    await expect(service.register("Concurrent Mac", { wait: false })).rejects.toThrow("already in progress");
    expect(registrationCalls).toBe(1);
    controller.abort();
    await expect(first).rejects.toThrow("Stopped waiting for device approval");
  });
});
