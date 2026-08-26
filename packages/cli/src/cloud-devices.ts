import { hostname } from "node:os";
import { createCloudAuthService, type CloudAuthService, type CloudApiSession } from "./cloud-auth";
import { createDeviceCredentialStore, type DeviceCredentialStore } from "./device-credentials";
import {
  createDeviceApprovalBody,
  createDeviceRegistrationBody,
  deviceFingerprint,
  generateDeviceKeyMaterial,
  validateDeviceKeyMaterial,
  type DeviceApprovalBody,
  type DeviceRegistrationBody,
} from "./device-identity";

export interface CloudDevice {
  id: string;
  name: string;
  fingerprint: string;
  suite?: string;
  status?: string;
  createdAt?: string;
  lastSeenAt?: string | null;
  revokedAt?: string | null;
}

export interface CloudDeviceEnrollment {
  id: string;
  name?: string;
  requestFingerprint: string;
  expiresAt: string;
  createdAt?: string;
  status?: string;
}

export interface DeviceRegistrationResult {
  status: "registered" | "approval_required";
  device?: CloudDevice;
  deviceId?: string;
  enrollment?: CloudDeviceEnrollment;
}

export interface CloudDeviceApiClient {
  listDevices(): Promise<CloudDevice[]>;
  registerDevice(body: DeviceRegistrationBody): Promise<DeviceRegistrationResult>;
  renameDevice(id: string, name: string): Promise<void>;
  revokeDevice(id: string): Promise<void>;
  listEnrollments(): Promise<CloudDeviceEnrollment[]>;
  approveEnrollment(id: string, body: DeviceApprovalBody): Promise<void>;
}

export interface CloudDeviceService {
  register(name?: string): Promise<DeviceRegistrationResult & { name: string; keyStorage: string }>;
  list(): Promise<CloudDevice[]>;
  rename(id: string, name: string): Promise<void>;
  revoke(id: string): Promise<void>;
  pending(): Promise<CloudDeviceEnrollment[]>;
  approve(requestId: string): Promise<{ requestId: string; approverDeviceId: string }>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseDevice(value: unknown): CloudDevice | undefined {
  const item = record(value);
  if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.fingerprint !== "string") return undefined;
  return {
    id: item.id,
    name: item.name,
    fingerprint: item.fingerprint,
    ...(typeof item.suite === "string" ? { suite: item.suite } : {}),
    ...(typeof item.status === "string" ? { status: item.status } : {}),
    ...(typeof item.createdAt === "string" ? { createdAt: item.createdAt } : {}),
    ...((typeof item.lastSeenAt === "string" || item.lastSeenAt === null) ? { lastSeenAt: item.lastSeenAt as string | null } : {}),
    ...((typeof item.revokedAt === "string" || item.revokedAt === null) ? { revokedAt: item.revokedAt as string | null } : {}),
  };
}

function parseEnrollment(value: unknown): CloudDeviceEnrollment | undefined {
  const item = record(value);
  const requestFingerprint = item?.requestFingerprint ?? item?.fingerprint;
  if (!item || typeof item.id !== "string" || typeof requestFingerprint !== "string" || typeof item.expiresAt !== "string") return undefined;
  return {
    id: item.id,
    requestFingerprint,
    expiresAt: item.expiresAt,
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof item.createdAt === "string" ? { createdAt: item.createdAt } : {}),
    ...(typeof item.status === "string" ? { status: item.status } : {}),
  };
}

function parseArray<T>(body: unknown, key: string, parser: (value: unknown) => T | undefined): T[] {
  const values = record(body)?.[key];
  if (!Array.isArray(values)) throw new Error(`Sinter Cloud returned an invalid ${key} response`);
  const parsed = values.map(parser);
  if (parsed.some((value) => !value)) throw new Error(`Sinter Cloud returned an invalid ${key} response`);
  return parsed as T[];
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  return response.json().catch(() => undefined);
}

export function createCloudDeviceApiClient(options: {
  auth?: Pick<CloudAuthService, "apiSession">;
  session?: () => Promise<CloudApiSession | undefined>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
} = {}): CloudDeviceApiClient {
  const session = options.session ?? (() => (options.auth ?? createCloudAuthService()).apiSession());
  const request = options.fetch ?? globalThis.fetch;

  async function call(path: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
    const credentials = await session();
    if (!credentials) throw new Error("Not logged in. Run `sinter login`.");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${credentials.accessToken}`);
    headers.set("X-Sinter-ID-Token", credentials.idToken);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await request(`${credentials.baseUrl}${path}`, { ...init, headers });
    const body = await responseJson(response);
    if (!response.ok) {
      if (response.status === 401) throw new Error("Cloud session expired; run `sinter login` again");
      if (response.status === 403) throw new Error("Sinter Cloud denied this device operation");
      throw new Error(`Sinter Cloud device request failed (HTTP ${response.status})`);
    }
    return { response, body };
  }

  return {
    async listDevices() {
      return parseArray((await call("/api/cli/devices")).body, "devices", parseDevice);
    },
    async registerDevice(registration) {
      const { response, body } = await call("/api/cli/devices", { method: "POST", body: JSON.stringify(registration) });
      const payload = record(body);
      const approvalRequired = response.status === 202 || payload?.status === "approval_required" || payload?.approvalRequired === true;
      if (approvalRequired) {
        const enrollment = parseEnrollment(payload?.enrollment ?? payload?.request);
        return { status: "approval_required", ...(enrollment ? { enrollment } : {}) };
      }
      const device = parseDevice(payload?.device);
      const deviceId = device?.id ?? (typeof payload?.deviceId === "string" ? payload.deviceId : undefined);
      if (!deviceId) throw new Error("Sinter Cloud returned an invalid device registration response");
      return { status: "registered", deviceId, ...(device ? { device } : {}) };
    },
    async renameDevice(id, name) {
      await call(`/api/cli/devices/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ schema: "sinter.cloud.device-update.v1", name }),
      });
    },
    async revokeDevice(id) {
      await call(`/api/cli/devices/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ schema: "sinter.cloud.device-update.v1", revoke: true }),
      });
    },
    async listEnrollments() {
      return parseArray((await call("/api/cli/device-enrollments")).body, "enrollments", parseEnrollment);
    },
    async approveEnrollment(id, approval) {
      await call(`/api/cli/device-enrollments/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify(approval),
      });
    },
  };
}

function deviceName(value: string | undefined): string {
  const name = (value ?? hostname()).trim().normalize("NFC");
  if (!name) throw new Error("Device name must not be empty");
  if ([...name].length > 80) throw new Error("Device name must be at most 80 characters");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("Device name must not contain control characters");
  return name;
}

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (!id) throw new Error(`${label} must not be empty`);
  return id;
}

export function createCloudDeviceService(options: {
  api?: CloudDeviceApiClient;
  keys?: DeviceCredentialStore;
  now?: () => number;
} = {}): CloudDeviceService {
  const api = options.api ?? createCloudDeviceApiClient();
  const keys = options.keys ?? createDeviceCredentialStore();
  const now = options.now ?? Date.now;

  return {
    async register(requestedName) {
      const name = deviceName(requestedName);
      let material = await keys.load();
      if (!material) {
        material = await generateDeviceKeyMaterial(now());
        await keys.save(material);
      }
      await validateDeviceKeyMaterial(material);
      const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
      const existing = (await api.listDevices()).find((device) =>
        device.fingerprint === fingerprint && device.status !== "revoked" && device.revokedAt == null
      );
      const pending = existing ? undefined : (await api.listEnrollments()).find((request) =>
        request.requestFingerprint === fingerprint
      );
      const result: DeviceRegistrationResult = existing
        ? { status: "registered", device: existing, deviceId: existing.id }
        : pending
          ? { status: "approval_required", enrollment: pending }
          : await api.registerDevice(await createDeviceRegistrationBody(material, name));
      if (result.status === "registered") {
        const deviceId = result.device?.id ?? result.deviceId;
        if (!deviceId) throw new Error("Sinter Cloud did not return the registered device ID");
        if (material.deviceId !== deviceId) await keys.save({ ...material, deviceId });
      }
      return { ...result, name, keyStorage: keys.description };
    },
    list: () => api.listDevices(),
    async rename(id, name) {
      await api.renameDevice(requireId(id, "Device ID"), deviceName(name));
    },
    async revoke(id) {
      const deviceId = requireId(id, "Device ID");
      await api.revokeDevice(deviceId);
      const material = await keys.load();
      if (material?.deviceId === deviceId) await keys.delete();
    },
    pending: () => api.listEnrollments(),
    async approve(requestId) {
      const id = requireId(requestId, "Enrollment request ID");
      const material = await keys.load();
      if (!material) throw new Error("No local device keys found; run `sinter devices register` first");
      const request = (await api.listEnrollments()).find((item) => item.id === id);
      if (!request) throw new Error(`Pending device enrollment not found: ${id}`);
      const approval = await createDeviceApprovalBody(material, request);
      await api.approveEnrollment(id, approval.body);
      return { requestId: id, approverDeviceId: approval.body.approverDeviceId };
    },
  };
}
