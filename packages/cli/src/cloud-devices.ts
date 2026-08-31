import { hostname } from "node:os";
import { createCloudAuthService, type CloudAuthService, type CloudApiSession } from "./cloud-auth";
import { createDeviceCredentialStore, type DeviceCredentialStore } from "./device-credentials";
import {
  createDeviceApprovalBody,
  createDeviceRegistrationBody,
  DEVICE_CRYPTO_SUITE,
  deviceFingerprint,
  generateDeviceKeyMaterial,
  validateDeviceKeyMaterial,
  type DeviceApprovalBody,
  type DeviceRegistrationBody,
  type DeviceKeyMaterial,
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

/** Full registered public identity for internal cryptographic operations only. */
export interface CloudDeviceIdentity extends CloudDevice {
  encryptionPublicKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
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

export interface DeviceRegistrationStatus {
  status: "waiting_for_approval";
  requestId: string;
  expiresAt: string;
}

export interface DeviceRegistrationOptions {
  wait?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStatus?: (status: DeviceRegistrationStatus) => void | Promise<void>;
}

export interface CloudDeviceApiClient {
  listDevices(options?: { signal?: AbortSignal }): Promise<CloudDevice[]>;
  /** Uses the same endpoint but retains public JWKs for internal cryptographic operations. */
  listDeviceIdentities?(options?: { signal?: AbortSignal }): Promise<CloudDeviceIdentity[]>;
  registerDevice(body: DeviceRegistrationBody): Promise<DeviceRegistrationResult>;
  renameDevice(id: string, name: string): Promise<void>;
  revokeDevice(id: string): Promise<void>;
  listEnrollments(options?: { signal?: AbortSignal }): Promise<CloudDeviceEnrollment[]>;
  approveEnrollment(id: string, body: DeviceApprovalBody): Promise<void>;
}

export interface CloudDeviceService {
  register(name?: string, options?: DeviceRegistrationOptions): Promise<DeviceRegistrationResult & { name: string; keyStorage: string }>;
  list(): Promise<CloudDevice[]>;
  rename(id: string, name: string): Promise<void>;
  revoke(id: string): Promise<void>;
  pending(): Promise<CloudDeviceEnrollment[]>;
  approve(requestId: string): Promise<{ requestId: string; approverDeviceId: string }>;
}

export const DEVICE_REGISTRATION_MIN_TIMEOUT_MS = 5_000;
export const DEVICE_REGISTRATION_MAX_TIMEOUT_MS = 15 * 60_000;
export const DEVICE_REGISTRATION_POLL_INTERVAL_MS = 2_000;

const REGISTRATION_EXPIRED_MESSAGE = "Device enrollment expired or disappeared before approval. Rerun `sinter devices register`. Local device keys were left intact.";
const REGISTRATION_TIMEOUT_MESSAGE = "Timed out waiting for device approval. Rerun `sinter devices register` to continue; the enrollment request and local device keys were left intact.";
const REGISTRATION_ABORTED_MESSAGE = "Stopped waiting for device approval. The enrollment request and local device keys were left intact.";
const REGISTRATION_POLL_FAILED_MESSAGE = "Could not check device approval. The enrollment request and local device keys were left intact; rerun `sinter devices register` to continue.";

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

function parsePublicP256Jwk(value: unknown, purpose: "encryption" | "signing"): JsonWebKey | undefined {
  const jwk = record(value);
  if (!jwk || Object.keys(jwk).some((key) => !["kty", "crv", "x", "y", "use", "key_ops", "ext"].includes(key))) return undefined;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return undefined;
  const expectedUse = purpose === "encryption" ? "enc" : "sig";
  if (jwk.use !== undefined && jwk.use !== expectedUse) return undefined;
  if (jwk.ext !== undefined && jwk.ext !== true) return undefined;
  if (jwk.key_ops !== undefined) {
    const valid = purpose === "encryption"
      ? Array.isArray(jwk.key_ops) && jwk.key_ops.length === 0
      : Array.isArray(jwk.key_ops) && jwk.key_ops.length === 1 && jwk.key_ops[0] === "verify";
    if (!valid) return undefined;
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

function parseDeviceIdentity(value: unknown): CloudDeviceIdentity | undefined {
  const item = record(value);
  const device = parseDevice(value);
  const encryptionPublicKey = parsePublicP256Jwk(item?.encryptionPublicKey, "encryption");
  const signingPublicKey = parsePublicP256Jwk(item?.signingPublicKey, "signing");
  if (!device || !encryptionPublicKey || !signingPublicKey) return undefined;
  return { ...device, encryptionPublicKey, signingPublicKey };
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
    let response: Response;
    try {
      response = await request(`${credentials.baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new Error("Could not reach Sinter Cloud for this device operation");
    }
    const body = await responseJson(response);
    if (!response.ok) {
      if (response.status === 401) throw new Error("Cloud session expired; run `sinter login` again");
      if (response.status === 403) throw new Error("Sinter Cloud denied this device operation");
      throw new Error(`Sinter Cloud device request failed (HTTP ${response.status})`);
    }
    return { response, body };
  }

  return {
    async listDevices(options) {
      return parseArray((await call("/api/cli/devices", { signal: options?.signal })).body, "devices", parseDevice);
    },
    async listDeviceIdentities(options) {
      return parseArray((await call("/api/cli/devices", { signal: options?.signal })).body, "devices", parseDeviceIdentity);
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
    async listEnrollments(options) {
      return parseArray((await call("/api/cli/device-enrollments", { signal: options?.signal })).body, "enrollments", parseEnrollment);
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

function activeDeviceForFingerprint(devices: CloudDevice[], fingerprint: string): CloudDevice | undefined {
  const matching = devices.filter((device) =>
    device.fingerprint === fingerprint &&
    (device.status === undefined || device.status === "active") &&
    device.revokedAt == null
  );
  const unexpected = matching.find((device) => device.suite !== DEVICE_CRYPTO_SUITE);
  if (unexpected) {
    throw new Error("Sinter Cloud returned a device with an unexpected cryptographic suite; the local device ID was not saved");
  }
  return matching[0];
}

function verifiedRegisteredDevice(result: DeviceRegistrationResult, fingerprint: string): CloudDevice {
  const device = result.device;
  if (!device || (device.id !== result.deviceId && result.deviceId !== undefined)) {
    throw new Error("Sinter Cloud did not return complete registered device identity; the local device ID was not saved");
  }
  if (device.fingerprint !== fingerprint || device.suite !== DEVICE_CRYPTO_SUITE) {
    throw new Error("Sinter Cloud returned an unexpected registered device identity; the local device ID was not saved");
  }
  return device;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error(REGISTRATION_ABORTED_MESSAGE);
}

async function defaultPause(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(REGISTRATION_ABORTED_MESSAGE));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function createCloudDeviceService(options: {
  api?: CloudDeviceApiClient;
  keys?: DeviceCredentialStore;
  now?: () => number;
  pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
} = {}): CloudDeviceService {
  const api = options.api ?? createCloudDeviceApiClient();
  const keys = options.keys ?? createDeviceCredentialStore();
  const now = options.now ?? Date.now;
  const pause = options.pause ?? defaultPause;
  const pollIntervalMs = options.pollIntervalMs ?? DEVICE_REGISTRATION_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error("Device registration poll interval must be positive");
  let registrationInProgress = false;

  async function polledDevices(signal: AbortSignal | undefined): Promise<CloudDevice[]> {
    throwIfAborted(signal);
    try {
      return await api.listDevices({ signal });
    } catch {
      throwIfAborted(signal);
      throw new Error(REGISTRATION_POLL_FAILED_MESSAGE);
    }
  }

  async function polledEnrollments(signal: AbortSignal | undefined): Promise<CloudDeviceEnrollment[]> {
    throwIfAborted(signal);
    try {
      return await api.listEnrollments({ signal });
    } catch {
      throwIfAborted(signal);
      throw new Error(REGISTRATION_POLL_FAILED_MESSAGE);
    }
  }

  async function saveVerifiedDevice(material: DeviceKeyMaterial, device: CloudDevice): Promise<DeviceRegistrationResult> {
    if (material.deviceId !== device.id) await keys.save({ ...material, deviceId: device.id });
    return { status: "registered", device, deviceId: device.id };
  }

  async function waitForApproval(
    material: DeviceKeyMaterial,
    fingerprint: string,
    enrollment: CloudDeviceEnrollment,
    registration: DeviceRegistrationOptions,
  ): Promise<DeviceRegistrationResult> {
    if (enrollment.requestFingerprint !== fingerprint) {
      throw new Error("Sinter Cloud returned an enrollment for an unexpected device fingerprint");
    }
    const expiresAt = Date.parse(enrollment.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error("Sinter Cloud returned an invalid device enrollment expiry");
    const timeoutMs = registration.timeoutMs ?? DEVICE_REGISTRATION_MAX_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < DEVICE_REGISTRATION_MIN_TIMEOUT_MS || timeoutMs > DEVICE_REGISTRATION_MAX_TIMEOUT_MS) {
      throw new Error("Device registration wait timeout must be between 5s and 15m");
    }
    const startedAt = now();
    const deadline = Math.min(expiresAt, startedAt + timeoutMs);
    await registration.onStatus?.({ status: "waiting_for_approval", requestId: enrollment.id, expiresAt: enrollment.expiresAt });

    while (true) {
      throwIfAborted(registration.signal);
      const current = now();
      if (current >= expiresAt) throw new Error(REGISTRATION_EXPIRED_MESSAGE);
      if (current >= deadline) throw new Error(REGISTRATION_TIMEOUT_MESSAGE);

      let device = activeDeviceForFingerprint(await polledDevices(registration.signal), fingerprint);
      if (device) return saveVerifiedDevice(material, device);

      const enrollments = await polledEnrollments(registration.signal);
      const pending = enrollments.find((item) =>
        item.id === enrollment.id && item.requestFingerprint === fingerprint
      );
      if (!pending) {
        device = activeDeviceForFingerprint(await polledDevices(registration.signal), fingerprint);
        if (device) return saveVerifiedDevice(material, device);
        throw new Error(REGISTRATION_EXPIRED_MESSAGE);
      }

      const delay = Math.min(pollIntervalMs, deadline - now());
      if (delay <= 0) continue;
      try {
        await pause(delay, registration.signal);
      } catch {
        throwIfAborted(registration.signal);
        throw new Error(REGISTRATION_POLL_FAILED_MESSAGE);
      }
    }
  }

  return {
    async register(requestedName, registration = {}) {
      if (registrationInProgress) throw new Error("Device registration is already in progress in this CLI process");
      registrationInProgress = true;
      try {
        const name = deviceName(requestedName);
        let material = await keys.load();
        if (!material) {
          material = await generateDeviceKeyMaterial(now());
          await keys.save(material);
        }
        await validateDeviceKeyMaterial(material);
        const fingerprint = await deviceFingerprint(material.encryptionPublicKey, material.signingPublicKey);
        const existing = activeDeviceForFingerprint(await api.listDevices(), fingerprint);
        if (existing) {
          const result = await saveVerifiedDevice(material, existing);
          return { ...result, name, keyStorage: keys.description };
        }

        const pending = (await api.listEnrollments()).find((request) => request.requestFingerprint === fingerprint);
        const result: DeviceRegistrationResult = pending
          ? { status: "approval_required", enrollment: pending }
          : await api.registerDevice(await createDeviceRegistrationBody(material, name));
        if (result.status === "registered") {
          const device = verifiedRegisteredDevice(result, fingerprint);
          const saved = await saveVerifiedDevice(material, device);
          return { ...saved, name, keyStorage: keys.description };
        }
        if (!result.enrollment) throw new Error("Sinter Cloud did not return the device enrollment request");
        if (registration.wait === false) return { ...result, name, keyStorage: keys.description };
        const approved = await waitForApproval(material, fingerprint, result.enrollment, registration);
        return { ...approved, name, keyStorage: keys.description };
      } finally {
        registrationInProgress = false;
      }
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
