import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { auth0Issuer } from "./auth0";
import {
  ADMIN_REASON_LIMITS,
  ADMIN_UPDATE_CONFIRMATION_PREFIX,
  type AdminAccountMetadata,
  type AdminEntitlementMetadata,
} from "./admin-contract";
import { CLOUD_SAFETY_CAPS } from "./cloud-quota";

export {
  ADMIN_REASON_LIMITS,
  ADMIN_UPDATE_CONFIRMATION_PREFIX,
  type AdminAccountMetadata,
  type AdminEntitlementMetadata,
} from "./admin-contract";

export const ADMIN_DATABASE = Object.freeze({
  accountIdentitiesTable: "account_identities",
  isSuperAdminRpc: "admin_is_super_admin",
  listAccountsRpc: "admin_list_accounts",
  setEntitlementRpc: "admin_set_entitlement",
});

export interface AdminWebIdentity {
  issuer: string;
  subject: string;
  email: string;
}

export interface AdminEntitlementUpdate {
  targetAccountId: string;
  planCode: string;
  status: string;
  uploadsEnabled: boolean;
  unmetered: boolean;
  storageLimitBytes: number | null;
  sessionLimit: number | null;
  capsuleSizeLimitBytes: number;
  deviceLimit: number;
  reason: string;
}

interface DataResult<T> {
  data: T;
  error: { message: string } | null;
}

export interface AdminDataSource {
  resolveAccountId(identity: AdminWebIdentity): Promise<DataResult<string | null>>;
  hasSuperAdminRole(accountId: string): Promise<DataResult<boolean>>;
  listAccounts(actorAccountId: string): Promise<DataResult<unknown[] | null>>;
  setEntitlement(
    actorAccountId: string,
    update: AdminEntitlementUpdate,
  ): Promise<DataResult<unknown | null>>;
}

export type AdminTokenVerifier = (
  token: string,
  options: { issuer: string; audience: string; algorithms: readonly ["RS256"] },
) => Promise<JWTPayload>;

export type AdminDataSourceFactory = () => AdminDataSource;

export type AdminFailureCode =
  | "configuration"
  | "access-denied"
  | "account-list"
  | "invalid-update"
  | "account-update"
  | "account-scope";

const ADMIN_FAILURE_MESSAGES: Record<AdminFailureCode, string> = {
  configuration: "Administrative access is unavailable.",
  "access-denied": "Access denied.",
  "account-list": "Account metadata could not be loaded.",
  "invalid-update": "The entitlement update was not accepted.",
  "account-update": "The entitlement could not be updated.",
  "account-scope": "The entitlement update could not be verified.",
};

export class AdminPortalError extends Error {
  constructor(public readonly code: AdminFailureCode) {
    super(ADMIN_FAILURE_MESSAGES[code]);
    this.name = "AdminPortalError";
  }
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(issuer: string) {
  let value = keySets.get(issuer);
  if (!value) {
    value = createRemoteJWKSet(new URL(".well-known/jwks.json", issuer));
    keySets.set(issuer, value);
  }
  return value;
}

const remoteVerifier: AdminTokenVerifier = async (token, options) => {
  const { payload } = await jwtVerify(token, keySet(options.issuer), {
    issuer: options.issuer,
    audience: options.audience,
    algorithms: [...options.algorithms],
  });
  return payload;
};

function audienceMatches(value: JWTPayload["aud"], expected: string) {
  return typeof value === "string" ? value === expected : Array.isArray(value) && value.includes(expected);
}

export async function verifyAdminWebIdentity(
  idToken: string,
  verifier: AdminTokenVerifier = remoteVerifier,
  environment: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<AdminWebIdentity> {
  let issuer: string;
  try {
    issuer = auth0Issuer();
  } catch {
    throw new AdminPortalError("configuration");
  }
  const audience = environment.AUTH0_CLIENT_ID;
  if (!audience) throw new AdminPortalError("configuration");

  try {
    const payload = await verifier(idToken, { issuer, audience, algorithms: ["RS256"] });
    if (
      payload.iss !== issuer
      || !audienceMatches(payload.aud, audience)
      || typeof payload.sub !== "string"
      || !payload.sub
      || payload.role !== "authenticated"
      || payload.email_verified !== true
      || typeof payload.email !== "string"
      || !payload.email.trim()
      || payload.email.length > 320
      || typeof payload.exp !== "number"
      || payload.exp * 1000 <= now
    ) {
      throw new Error("invalid claims");
    }
    return { issuer, subject: payload.sub, email: payload.email };
  } catch {
    throw new AdminPortalError("access-denied");
  }
}

export function createAdminSecretClient(
  environment: NodeJS.ProcessEnv = process.env,
): SupabaseClient {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  const secret = environment.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new AdminPortalError("configuration");
  return createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "sinter-cloud-admin-service" } },
  });
}

export function createAdminDataSource(
  client: SupabaseClient = createAdminSecretClient(),
): AdminDataSource {
  return {
    resolveAccountId: async (identity) => {
      const result = await client
        .from(ADMIN_DATABASE.accountIdentitiesTable)
        .select("account_id")
        .eq("issuer", identity.issuer)
        .eq("subject", identity.subject)
        .maybeSingle();
      return {
        data: result.data && typeof result.data.account_id === "string"
          ? result.data.account_id
          : null,
        error: result.error,
      };
    },
    hasSuperAdminRole: async (accountId) => {
      const result = await client.rpc(ADMIN_DATABASE.isSuperAdminRpc, {
        p_account_id: accountId,
      });
      return {
        data: result.data === true,
        error: result.error,
      };
    },
    listAccounts: async (actorAccountId) => {
      const result = await client.rpc(ADMIN_DATABASE.listAccountsRpc, {
        p_actor_account_id: actorAccountId,
      });
      return result as DataResult<unknown[] | null>;
    },
    setEntitlement: async (actorAccountId, update) => {
      const result = await client.rpc(ADMIN_DATABASE.setEntitlementRpc, {
        p_actor_account_id: actorAccountId,
        p_target_account_id: update.targetAccountId,
        p_plan_code: update.planCode,
        p_status: update.status,
        p_uploads_enabled: update.uploadsEnabled,
        p_unmetered: update.unmetered,
        p_storage_limit_bytes: update.storageLimitBytes,
        p_session_limit: update.sessionLimit,
        p_capsule_size_limit_bytes: update.capsuleSizeLimitBytes,
        p_device_limit: update.deviceLimit,
        p_reason: update.reason,
      });
      return result as DataResult<unknown | null>;
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminPortalError("account-list");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || !value) throw new AdminPortalError("account-list");
  return value;
}

function nullableString(value: unknown) {
  if (value === null) return null;
  return requiredString(value);
}

function requiredBoolean(value: unknown) {
  if (typeof value !== "boolean") throw new AdminPortalError("account-list");
  return value;
}

function nonnegativeInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AdminPortalError("account-list");
  }
  return value;
}

function nullableNonnegativeInteger(value: unknown) {
  return value === null ? null : nonnegativeInteger(value);
}

function entitlementMetadata(value: unknown, failureCode: "account-list" | "account-update"): AdminEntitlementMetadata {
  try {
    const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
    const row = record(candidate);
    return {
      account_id: requiredString(row.account_id),
      plan_code: requiredString(row.plan_code),
      status: requiredString(row.status ?? row.entitlement_status),
      uploads_enabled: requiredBoolean(row.uploads_enabled),
      unmetered: requiredBoolean(row.unmetered),
      storage_limit_bytes: nullableNonnegativeInteger(row.storage_limit_bytes),
      session_limit: nullableNonnegativeInteger(row.session_limit),
      capsule_size_limit_bytes: nonnegativeInteger(row.capsule_size_limit_bytes),
      device_limit: nonnegativeInteger(row.device_limit),
      updated_at: requiredString(row.updated_at ?? row.entitlement_updated_at),
    };
  } catch {
    throw new AdminPortalError(failureCode);
  }
}

export function filterAdminAccountMetadata(value: unknown): AdminAccountMetadata {
  try {
    const row = record(value);
    const entitlement = entitlementMetadata(row, "account-list");
    return {
      ...entitlement,
      account_email: nullableString(row.email !== undefined ? row.email : row.account_email),
      account_created_at: requiredString(row.account_created_at),
      deletion_requested_at: nullableString(row.deletion_requested_at),
      retained_storage_bytes: nonnegativeInteger(row.retained_storage_bytes),
      capsule_count: nonnegativeInteger(row.capsule_count),
      reserved_storage_bytes: nonnegativeInteger(row.reserved_storage_bytes),
      reserved_capsule_count: nonnegativeInteger(row.reserved_capsule_count),
      monthly_egress_bytes: nonnegativeInteger(row.monthly_egress_bytes),
      usage_period_started_at: nullableString(row.usage_period_started_at),
      usage_updated_at: requiredString(row.usage_updated_at),
      active_device_count: nonnegativeInteger(row.active_device_count),
      total_device_count: nonnegativeInteger(row.total_device_count),
      pending_enrollment_count: nonnegativeInteger(row.pending_enrollment_count),
    };
  } catch {
    throw new AdminPortalError("account-list");
  }
}

export async function authorizeSuperAdmin(
  idToken: string,
  sourceFactory: AdminDataSourceFactory = createAdminDataSource,
  verifier: AdminTokenVerifier = remoteVerifier,
): Promise<{ accountId: string; source: AdminDataSource }> {
  const identity = await verifyAdminWebIdentity(idToken, verifier);
  const source = sourceFactory();
  const account = await source.resolveAccountId(identity);
  if (account.error || typeof account.data !== "string" || !account.data) {
    throw new AdminPortalError("access-denied");
  }
  const role = await source.hasSuperAdminRole(account.data);
  if (role.error || role.data !== true) throw new AdminPortalError("access-denied");
  return { accountId: account.data, source };
}

export async function hasSuperAdminAccess(idToken: string) {
  try {
    await authorizeSuperAdmin(idToken);
    return true;
  } catch {
    return false;
  }
}

export async function loadAdminAccounts(
  idToken: string,
  sourceFactory: AdminDataSourceFactory = createAdminDataSource,
  verifier: AdminTokenVerifier = remoteVerifier,
): Promise<AdminAccountMetadata[]> {
  const { accountId, source } = await authorizeSuperAdmin(idToken, sourceFactory, verifier);
  const result = await source.listAccounts(accountId);
  if (result.error || !Array.isArray(result.data)) throw new AdminPortalError("account-list");
  return result.data.map(filterAdminAccountMetadata);
}

function one(formData: FormData, name: string) {
  const values = formData.getAll(name);
  if (values.length !== 1 || typeof values[0] !== "string") {
    throw new AdminPortalError("invalid-update");
  }
  return values[0];
}

function optionalBoolean(formData: FormData, name: string) {
  const values = formData.getAll(name);
  if (values.length === 0) return false;
  if (values.length !== 1 || values[0] !== "true") throw new AdminPortalError("invalid-update");
  return true;
}

function boundedPlanCode(value: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new AdminPortalError("invalid-update");
  return value;
}

function entitlementStatus(value: string) {
  if (value !== "active" && value !== "suspended") throw new AdminPortalError("invalid-update");
  return value;
}

function integerOrNull(value: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === "") return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new AdminPortalError("invalid-update");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new AdminPortalError("invalid-update");
  }
  return parsed;
}

export function realUploadsEnabled(environment: NodeJS.ProcessEnv = process.env) {
  return environment.SINTER_REAL_UPLOADS_ENABLED === "true";
}

export function parseAdminEntitlementUpdate(
  formData: FormData,
  environment: NodeJS.ProcessEnv = process.env,
): AdminEntitlementUpdate {
  const targetAccountId = one(formData, "target_account_id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetAccountId)) {
    throw new AdminPortalError("invalid-update");
  }
  if (one(formData, "confirmation") !== `${ADMIN_UPDATE_CONFIRMATION_PREFIX} ${targetAccountId}`) {
    throw new AdminPortalError("invalid-update");
  }
  const reason = one(formData, "reason").trim();
  if (reason.length < ADMIN_REASON_LIMITS.minimum || reason.length > ADMIN_REASON_LIMITS.maximum) {
    throw new AdminPortalError("invalid-update");
  }
  const uploadsValue = one(formData, "uploads_enabled");
  if (
    (uploadsValue !== "false" && uploadsValue !== "true")
    || (uploadsValue === "true" && !realUploadsEnabled(environment))
  ) {
    throw new AdminPortalError("invalid-update");
  }
  const uploadsEnabled = uploadsValue === "true";

  const unmetered = optionalBoolean(formData, "unmetered");
  const storageLimitBytes = integerOrNull(one(formData, "storage_limit_bytes"));
  const sessionLimit = integerOrNull(one(formData, "session_limit"));
  const capsuleSizeLimitBytes = integerOrNull(
    one(formData, "capsule_size_limit_bytes"),
    CLOUD_SAFETY_CAPS.capsuleSizeBytes,
  );
  const deviceLimit = integerOrNull(one(formData, "device_limit"), CLOUD_SAFETY_CAPS.devices);
  if (
    (unmetered && (storageLimitBytes !== null || sessionLimit !== null))
    || (!unmetered && (storageLimitBytes === null || sessionLimit === null))
    || capsuleSizeLimitBytes === null
    || deviceLimit === null
  ) {
    throw new AdminPortalError("invalid-update");
  }

  return {
    targetAccountId,
    planCode: boundedPlanCode(one(formData, "plan_code")),
    status: entitlementStatus(one(formData, "status")),
    uploadsEnabled,
    unmetered,
    storageLimitBytes,
    sessionLimit,
    capsuleSizeLimitBytes,
    deviceLimit,
    reason,
  };
}

export async function updateAdminEntitlement(
  idToken: string,
  formData: FormData,
  sourceFactory: AdminDataSourceFactory = createAdminDataSource,
  verifier: AdminTokenVerifier = remoteVerifier,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AdminEntitlementMetadata> {
  const { accountId, source } = await authorizeSuperAdmin(idToken, sourceFactory, verifier);
  const update = parseAdminEntitlementUpdate(formData, environment);
  const result = await source.setEntitlement(accountId, update);
  if (result.error || !result.data) throw new AdminPortalError("account-update");
  const changed = entitlementMetadata(result.data, "account-update");
  if (changed.account_id !== update.targetAccountId) throw new AdminPortalError("account-scope");
  return changed;
}
