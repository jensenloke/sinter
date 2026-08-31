import { createClient } from "@supabase/supabase-js";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  type AccountDeletionOperation,
} from "../account-lifecycle";
import { auth0Issuer } from "../auth0";
import { DEVICE_DATABASE } from "../device-data-source";
import {
  developmentEntitlement,
  developmentUsage,
  type CloudEntitlement,
  type CloudUsage,
} from "../cloud-quota";

export interface CloudProfile {
  id: string;
  email: string | null;
  created_at: string;
  deletion_requested_at: string | null;
}

export interface CloudDevice {
  id: string;
  name: string;
  suite: string;
  encryption_public_key: string;
  signing_public_key: string;
  fingerprint: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface CloudDeviceEnrollment {
  id: string;
  name: string;
  suite: string;
  encryption_public_key: string;
  signing_public_key: string;
  fingerprint: string;
  status: "pending" | "approved";
  created_at: string;
  expires_at: string;
}

export interface DashboardData {
  accountId: string;
  profile: CloudProfile;
  entitlement: CloudEntitlement;
  usage: CloudUsage;
  devices: CloudDevice[];
  enrollments: CloudDeviceEnrollment[];
  tokenExpiresAt: number;
}

interface DataResult<T> {
  data: T;
  error: { message: string } | null;
}

export interface DashboardDataSource {
  claimAccount(): Promise<DataResult<string | null>>;
  loadProfile(accountId: string): Promise<DataResult<CloudProfile | null>>;
  loadEntitlement(accountId: string): Promise<DataResult<CloudEntitlement | null>>;
  loadUsage(accountId: string): Promise<DataResult<CloudUsage | null>>;
  loadDevices(accountId: string): Promise<DataResult<CloudDevice[] | null>>;
  loadEnrollments(accountId: string): Promise<DataResult<CloudDeviceEnrollment[] | null>>;
}

export interface AccountDeletionDataSource {
  claimAccount(): Promise<DataResult<string | null>>;
  setDeletionRequestedAt(
    accountId: string,
    deletionRequestedAt: string | null,
    expectedCurrentState: "clear" | "pending",
  ): Promise<DataResult<CloudProfile | null>>;
}

export type DashboardFailureCode =
  | "configuration"
  | "identity-token"
  | "identity-role"
  | "identity-expired"
  | "account-claim"
  | "profile-load"
  | "entitlement-load"
  | "usage-load"
  | "quota-scope"
  | "device-load"
  | "enrollment-load"
  | "account-confirmation"
  | "account-update"
  | "account-state"
  | "account-scope";

const failureMessages: Record<DashboardFailureCode, string> = {
  configuration: "The cloud data connection is not configured for this environment.",
  "identity-token": "Your identity token is not compatible with the cloud data connection.",
  "identity-role": "Your signed-in identity is missing the required data-access role.",
  "identity-expired": "Your identity token has expired. Sign out, then sign in again.",
  "account-claim": "Your cloud account could not be opened safely.",
  "profile-load": "Your account details could not be loaded.",
  "entitlement-load": "Your cloud plan could not be loaded.",
  "usage-load": "Your cloud usage could not be loaded.",
  "quota-scope": "Your cloud quota could not be verified safely.",
  "device-load": "Your devices could not be loaded.",
  "enrollment-load": "Your pending device approvals could not be loaded.",
  "account-confirmation": "Confirm that you understand this creates a deletion request before continuing.",
  "account-update": "Your deletion request could not be changed.",
  "account-state": "No account change was made. Refresh the page and check the current request status.",
  "account-scope": "Your account change could not be verified safely.",
};

export class DashboardDataError extends Error {
  constructor(
    public readonly code: DashboardFailureCode,
    public readonly detail: string,
  ) {
    super(failureMessages[code]);
    this.name = "DashboardDataError";
  }
}

function fail(code: DashboardFailureCode, detail: string): never {
  throw new DashboardDataError(code, detail);
}

export function validateSupabaseIdToken(
  idToken: string,
  expectedIssuer = auth0Issuer(),
  now = Date.now(),
) {
  let header: ReturnType<typeof decodeProtectedHeader>;
  let claims: ReturnType<typeof decodeJwt>;
  try {
    header = decodeProtectedHeader(idToken);
    claims = decodeJwt(idToken);
  } catch {
    return fail("identity-token", "Auth0 session did not contain a readable JWT");
  }

  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    return fail(
      "identity-token",
      `Auth0 ID token must use RS256 with a key ID; received ${header.alg || "no algorithm"}`,
    );
  }
  if (claims.iss !== expectedIssuer || typeof claims.sub !== "string" || !claims.sub) {
    return fail("identity-token", "Auth0 ID token issuer or subject did not match the web session");
  }
  if (claims.role !== "authenticated") {
    return fail("identity-role", "Auth0 ID token did not contain role=authenticated");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) {
    return fail("identity-expired", "Auth0 ID token is expired or missing an expiry");
  }

  return { expiresAt: claims.exp, subject: claims.sub };
}

export function auth0SupabaseClientOptions(idToken: string) {
  return {
    accessToken: async () => idToken,
    auth: { persistSession: false, autoRefreshToken: false },
  };
}

export function createAuth0Client(idToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new DashboardDataError(
    "configuration",
    "NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing",
  );
  return createClient(url, key, auth0SupabaseClientOptions(idToken));
}

export function createDashboardDataSource(idToken: string): DashboardDataSource {
  const supabase = createAuth0Client(idToken);
  return {
    claimAccount: async () => {
      const result = await supabase.rpc("claim_account");
      return result as DataResult<string | null>;
    },
    loadProfile: async (accountId) => {
      const result = await supabase
        .from("profiles")
        .select("id,email,created_at,deletion_requested_at")
        .eq("id", accountId)
        .maybeSingle();
      return result as DataResult<CloudProfile | null>;
    },
    loadEntitlement: async (accountId) => {
      const result = await supabase
        .from("account_entitlements")
        .select("account_id,plan_code,status,uploads_enabled,unmetered,storage_limit_bytes,session_limit,capsule_size_limit_bytes,device_limit,updated_at")
        .eq("account_id", accountId)
        .maybeSingle();
      return result as DataResult<CloudEntitlement | null>;
    },
    loadUsage: async (accountId) => {
      const result = await supabase
        .from("account_usage")
        .select("account_id,retained_storage_bytes,capsule_count,reserved_storage_bytes,reserved_capsule_count,monthly_egress_bytes,period_started_at,updated_at")
        .eq("account_id", accountId)
        .maybeSingle();
      return result as DataResult<CloudUsage | null>;
    },
    loadDevices: async (accountId) => {
      const result = await supabase
        .from(DEVICE_DATABASE.devicesTable)
        .select("id,name,suite:key_suite,encryption_public_key,signing_public_key,fingerprint,created_at,last_seen_at,revoked_at")
        .eq("user_id", accountId)
        .not("key_suite", "is", null)
        .order("created_at", { ascending: false });
      return result as DataResult<CloudDevice[] | null>;
    },
    loadEnrollments: async (accountId) => {
      const result = await supabase
        .from(DEVICE_DATABASE.enrollmentsTable)
        .select("id,name:requested_name,suite:key_suite,encryption_public_key,signing_public_key,fingerprint,status,created_at,expires_at")
        .eq("account_id", accountId)
        .in("status", ["pending", "approved"])
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false });
      return result as DataResult<CloudDeviceEnrollment[] | null>;
    },
  };
}

export function createAccountDeletionDataSource(idToken: string): AccountDeletionDataSource {
  const supabase = createAuth0Client(idToken);
  return {
    claimAccount: async () => {
      const result = await supabase.rpc("claim_account");
      return result as DataResult<string | null>;
    },
    setDeletionRequestedAt: async (accountId, deletionRequestedAt, expectedCurrentState) => {
      const update = supabase
        .from("profiles")
        .update({ deletion_requested_at: deletionRequestedAt })
        .eq("id", accountId);
      const guardedUpdate = expectedCurrentState === "pending"
        ? update.not("deletion_requested_at", "is", null)
        : update.is("deletion_requested_at", null);
      const result = await guardedUpdate
        .select("id,email,created_at,deletion_requested_at")
        .maybeSingle();
      return result as DataResult<CloudProfile | null>;
    },
  };
}

export async function loadDashboardData(
  idToken: string,
  sourceFactory: (token: string) => DashboardDataSource = createDashboardDataSource,
): Promise<DashboardData> {
  const token = validateSupabaseIdToken(idToken);
  const source = sourceFactory(idToken);

  const claimed = await source.claimAccount();
  if (claimed.error || typeof claimed.data !== "string") {
    return fail("account-claim", claimed.error?.message ?? "claim_account returned no account ID");
  }

  const profileResult = await source.loadProfile(claimed.data);
  if (profileResult.error || !profileResult.data) {
    return fail(
      "profile-load",
      profileResult.error?.message ?? "Claimed profile was not visible through RLS",
    );
  }

  const entitlementResult = await source.loadEntitlement(claimed.data);
  if (entitlementResult.error) return fail("entitlement-load", entitlementResult.error.message);
  if (entitlementResult.data && entitlementResult.data.account_id !== claimed.data) {
    return fail("quota-scope", "Entitlement row did not match the claimed account");
  }

  const usageResult = await source.loadUsage(claimed.data);
  if (usageResult.error) return fail("usage-load", usageResult.error.message);
  if (usageResult.data && usageResult.data.account_id !== claimed.data) {
    return fail("quota-scope", "Usage row did not match the claimed account");
  }

  const devicesResult = await source.loadDevices(claimed.data);
  if (devicesResult.error) return fail("device-load", devicesResult.error.message);

  const enrollmentsResult = await source.loadEnrollments(claimed.data);
  if (enrollmentsResult.error) return fail("enrollment-load", enrollmentsResult.error.message);

  return {
    accountId: claimed.data,
    profile: profileResult.data,
    entitlement: entitlementResult.data ?? developmentEntitlement(claimed.data),
    usage: usageResult.data ?? developmentUsage(claimed.data),
    devices: devicesResult.data ?? [],
    enrollments: enrollmentsResult.data ?? [],
    tokenExpiresAt: token.expiresAt,
  };
}

export async function changeAccountDeletionRequest(
  idToken: string,
  operation: AccountDeletionOperation,
  confirmation: string | null,
  sourceFactory: (token: string) => AccountDeletionDataSource = createAccountDeletionDataSource,
  requestedAt = new Date().toISOString(),
): Promise<CloudProfile> {
  validateSupabaseIdToken(idToken);
  if (operation === "request" && confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
    return fail("account-confirmation", "The request confirmation was absent or invalid");
  }

  const source = sourceFactory(idToken);
  const claimed = await source.claimAccount();
  if (claimed.error || typeof claimed.data !== "string" || !claimed.data) {
    return fail("account-claim", claimed.error?.message ?? "claim_account returned no account ID");
  }

  const deletionRequestedAt = operation === "request" ? requestedAt : null;
  const result = await source.setDeletionRequestedAt(
    claimed.data,
    deletionRequestedAt,
    operation === "request" ? "clear" : "pending",
  );
  if (result.error) return fail("account-update", result.error.message);
  if (!result.data) {
    return fail("account-state", "The guarded profile update did not select a row");
  }
  if (result.data.id !== claimed.data) {
    return fail("account-scope", "The updated profile did not match the claimed account ID");
  }

  const requestTimestampMatches = operation === "request"
    && result.data.deletion_requested_at !== null
    && Number.isFinite(Date.parse(result.data.deletion_requested_at))
    && Date.parse(result.data.deletion_requested_at) === Date.parse(requestedAt);
  const stateMatches = operation === "cancel"
    ? result.data.deletion_requested_at === null
    : requestTimestampMatches;
  if (!stateMatches) {
    return fail("account-state", "The updated profile did not contain the requested lifecycle state");
  }

  return result.data;
}
