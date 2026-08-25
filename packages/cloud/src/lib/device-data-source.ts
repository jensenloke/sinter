import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CliDeviceIdentity } from "./device-auth";
import { canonicalJson, type DeviceRegistration, type PublicP256Jwk } from "./device-crypto";

export const DEVICE_DATABASE = Object.freeze({
  accountIdentitiesTable: "account_identities",
  devicesTable: "devices",
  enrollmentsTable: "device_enrollment_requests",
  bootstrapRpc: "bootstrap_device",
  createEnrollmentRpc: "create_device_enrollment_request",
  approveEnrollmentRpc: "approve_device_enrollment_request",
  completeEnrollmentRpc: "complete_device_enrollment_request",
});

export interface DataResult<T> {
  data: T;
  error: { message: string; code?: string } | null;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  suite: string;
  encryption_public_key: PublicP256Jwk;
  signing_public_key: PublicP256Jwk;
  fingerprint: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface DeviceEnrollmentRow {
  id: string;
  user_id: string;
  name: string;
  suite: string;
  encryption_public_key: PublicP256Jwk;
  signing_public_key: PublicP256Jwk;
  fingerprint: string;
  status: string;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  approver_device_id: string | null;
  completed_device_id: string | null;
}

export interface DeviceDataSource {
  resolveAccountId(identity: CliDeviceIdentity): Promise<DataResult<string | null>>;
  listDevices(accountId: string): Promise<DataResult<DeviceRow[] | null>>;
  listEnrollments(accountId: string): Promise<DataResult<DeviceEnrollmentRow[] | null>>;
  bootstrapDevice(accountId: string, registration: DeviceRegistration): Promise<DataResult<DeviceRow | null>>;
  createEnrollment(
    accountId: string,
    registration: DeviceRegistration,
    expiresAt: string,
  ): Promise<DataResult<DeviceEnrollmentRow | null>>;
  updateDevice(
    accountId: string,
    deviceId: string,
    update: { name?: string; revoked_at?: string },
  ): Promise<DataResult<DeviceRow | null>>;
  loadEnrollment(accountId: string, requestId: string): Promise<DataResult<DeviceEnrollmentRow | null>>;
  loadActiveDevice(accountId: string, deviceId: string): Promise<DataResult<DeviceRow | null>>;
  completeEnrollment(
    accountId: string,
    requestId: string,
    approverDeviceId: string,
    signature: string,
  ): Promise<DataResult<DeviceRow | null>>;
}

export class DeviceDataConfigurationError extends Error {
  constructor(public readonly detail: string) {
    super("Device service is unavailable");
    this.name = "DeviceDataConfigurationError";
  }
}

interface RawDeviceRow {
  id: string;
  user_id: string;
  name: string;
  key_suite: string;
  encryption_public_key: string;
  signing_public_key: string;
  fingerprint: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface RawEnrollmentRow {
  id: string;
  account_id: string;
  requested_name: string;
  key_suite: string;
  encryption_public_key: string;
  signing_public_key: string;
  fingerprint: string;
  status: string;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  approved_by_device_id: string | null;
  device_id: string | null;
}

function errorResult<T>(message: string): DataResult<T> {
  return { data: null as T, error: { message } };
}

function parsedJwk(value: string): PublicP256Jwk {
  return JSON.parse(value) as PublicP256Jwk;
}

function deviceRow(value: RawDeviceRow): DeviceRow {
  return {
    id: value.id,
    user_id: value.user_id,
    name: value.name,
    suite: value.key_suite,
    encryption_public_key: parsedJwk(value.encryption_public_key),
    signing_public_key: parsedJwk(value.signing_public_key),
    fingerprint: value.fingerprint,
    created_at: value.created_at,
    last_seen_at: value.last_seen_at,
    revoked_at: value.revoked_at,
  };
}

function enrollmentRow(value: RawEnrollmentRow): DeviceEnrollmentRow {
  return {
    id: value.id,
    user_id: value.account_id,
    name: value.requested_name,
    suite: value.key_suite,
    encryption_public_key: parsedJwk(value.encryption_public_key),
    signing_public_key: parsedJwk(value.signing_public_key),
    fingerprint: value.fingerprint,
    status: value.status,
    created_at: value.created_at,
    expires_at: value.expires_at,
    approved_at: value.approved_at,
    approver_device_id: value.approved_by_device_id,
    completed_device_id: value.device_id,
  };
}

function first<T>(data: T | T[] | null): T | null {
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

function mapOne<Raw, Mapped>(
  value: unknown,
  mapper: (row: Raw) => Mapped,
): DataResult<Mapped | null> {
  const response = value as DataResult<Raw | Raw[] | null>;
  if (response.error) return { data: null, error: response.error };
  const row = first(response.data);
  if (!row) return { data: null, error: null };
  try {
    return { data: mapper(row), error: null };
  } catch {
    return errorResult<Mapped | null>("Stored device key JSON is invalid");
  }
}

function mapMany<Raw, Mapped>(
  value: unknown,
  mapper: (row: Raw) => Mapped,
): DataResult<Mapped[] | null> {
  const response = value as DataResult<Raw[] | null>;
  if (response.error) return { data: null, error: response.error };
  try {
    return { data: (response.data ?? []).map(mapper), error: null };
  } catch {
    return errorResult<Mapped[] | null>("Stored device key JSON is invalid");
  }
}

function storedPublicJwk(jwk: PublicP256Jwk) {
  return canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

export function createSecretSupabaseClient(
  environment: NodeJS.ProcessEnv = process.env,
): SupabaseClient {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = environment.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new DeviceDataConfigurationError("The Supabase URL or server-only secret key is not configured");
  }
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "sinter-cloud-device-service" } },
  });
}

const DEVICE_COLUMNS = "id,user_id,name,key_suite,encryption_public_key,signing_public_key,fingerprint,created_at,last_seen_at,revoked_at";
const ENROLLMENT_COLUMNS = "id,account_id,requested_name,key_suite,encryption_public_key,signing_public_key,fingerprint,status,created_at,expires_at,approved_at,approved_by_device_id,device_id";

export function createDeviceDataSource(
  client: SupabaseClient = createSecretSupabaseClient(),
): DeviceDataSource {
  return {
    resolveAccountId: async (identity) => {
      const response = await client
        .from(DEVICE_DATABASE.accountIdentitiesTable)
        .select("account_id")
        .eq("issuer", identity.issuer)
        .eq("subject", identity.subject)
        .maybeSingle();
      return {
        data: response.data && typeof response.data.account_id === "string" ? response.data.account_id : null,
        error: response.error,
      };
    },

    listDevices: async (accountId) => mapMany<RawDeviceRow, DeviceRow>(await client
      .from(DEVICE_DATABASE.devicesTable)
      .select(DEVICE_COLUMNS)
      .eq("user_id", accountId)
      .not("key_suite", "is", null)
      .order("created_at", { ascending: false }), deviceRow),

    listEnrollments: async (accountId) => mapMany<RawEnrollmentRow, DeviceEnrollmentRow>(await client
      .from(DEVICE_DATABASE.enrollmentsTable)
      .select(ENROLLMENT_COLUMNS)
      .eq("account_id", accountId)
      .in("status", ["pending", "approved"])
      .order("created_at", { ascending: false }), enrollmentRow),

    bootstrapDevice: async (accountId, registration) => mapOne<RawDeviceRow, DeviceRow>(await client.rpc(
      DEVICE_DATABASE.bootstrapRpc,
      {
        p_account_id: accountId,
        p_name: registration.name,
        p_encryption_public_key: storedPublicJwk(registration.encryptionPublicKey),
        p_signing_public_key: storedPublicJwk(registration.signingPublicKey),
        p_key_suite: registration.suite,
        p_fingerprint: registration.fingerprint,
      },
    ), deviceRow),

    createEnrollment: async (accountId, registration, expiresAt) => mapOne<RawEnrollmentRow, DeviceEnrollmentRow>(await client.rpc(
      DEVICE_DATABASE.createEnrollmentRpc,
      {
        p_account_id: accountId,
        p_requested_name: registration.name,
        p_encryption_public_key: storedPublicJwk(registration.encryptionPublicKey),
        p_signing_public_key: storedPublicJwk(registration.signingPublicKey),
        p_key_suite: registration.suite,
        p_fingerprint: registration.fingerprint,
        p_possession_proof: registration.proof,
        p_expires_at: expiresAt,
      },
    ), enrollmentRow),

    updateDevice: async (accountId, deviceId, update) => mapOne<RawDeviceRow, DeviceRow>(await client
      .from(DEVICE_DATABASE.devicesTable)
      .update(update)
      .eq("user_id", accountId)
      .eq("id", deviceId)
      .select(DEVICE_COLUMNS)
      .maybeSingle(), deviceRow),

    loadEnrollment: async (accountId, requestId) => mapOne<RawEnrollmentRow, DeviceEnrollmentRow>(await client
      .from(DEVICE_DATABASE.enrollmentsTable)
      .select(ENROLLMENT_COLUMNS)
      .eq("account_id", accountId)
      .eq("id", requestId)
      .maybeSingle(), enrollmentRow),

    loadActiveDevice: async (accountId, deviceId) => mapOne<RawDeviceRow, DeviceRow>(await client
      .from(DEVICE_DATABASE.devicesTable)
      .select(DEVICE_COLUMNS)
      .eq("user_id", accountId)
      .eq("id", deviceId)
      .not("key_suite", "is", null)
      .is("revoked_at", null)
      .maybeSingle(), deviceRow),

    completeEnrollment: async (_accountId, requestId, approverDeviceId, signature) => {
      const approved = await client.rpc(DEVICE_DATABASE.approveEnrollmentRpc, {
        p_request_id: requestId,
        p_approving_device_id: approverDeviceId,
        p_approval_signature: signature,
      });
      if (approved.error) return { data: null, error: approved.error };
      return mapOne<RawDeviceRow, DeviceRow>(await client.rpc(
        DEVICE_DATABASE.completeEnrollmentRpc,
        { p_request_id: requestId },
      ), deviceRow);
    },
  };
}
