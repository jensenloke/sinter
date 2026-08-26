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
  deviceFingerprint,
  generateDeviceKeyMaterial,
  verifyCanonicalSignature,
} from "../src/device-identity";

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
      async registerDevice() { return { status: "registered", deviceId: "registered-2" }; },
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

    const result = await createCloudDeviceService({ api, keys: keyStore }).register("Pending Mac");
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
        return [{ id: "approved-device", name: "Approved Mac", fingerprint, status: "active", revokedAt: null }];
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
});
