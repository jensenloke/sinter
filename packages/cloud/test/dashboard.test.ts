import { afterAll, describe, expect, test } from "bun:test";
import { ACCOUNT_DELETION_CONFIRMATION } from "../src/lib/account-lifecycle";
import {
  CLOUD_DEVELOPMENT_LIMITS,
  developmentEntitlement,
  developmentUsage,
  quotaDisplayData,
} from "../src/lib/cloud-quota";
import { dashboardFailureCopy } from "../src/lib/private-alpha";
import type {
  AccountDeletionDataSource,
  CloudProfile,
  DashboardDataSource,
} from "../src/lib/supabase/auth0";

const originalAuth0Env = {
  domain: process.env.AUTH0_DOMAIN,
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  secret: process.env.AUTH0_SECRET,
};
process.env.AUTH0_DOMAIN = "tenant.example.test";
process.env.AUTH0_CLIENT_ID = "test-client";
process.env.AUTH0_CLIENT_SECRET = "test-client-secret";
process.env.AUTH0_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const {
  DashboardDataError,
  auth0SupabaseClientOptions,
  changeAccountDeletionRequest,
  loadDashboardData,
  validateSupabaseIdToken,
} = await import("../src/lib/supabase/auth0");

const ISSUER = "https://tenant.example.test/";
const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";
const PROFILE: CloudProfile = {
  id: ACCOUNT_ID,
  email: "jensen@example.test",
  created_at: "2026-08-25T00:00:00.000Z",
  deletion_requested_at: null,
};
const REQUESTED_AT = "2026-08-25T08:30:00.000Z";
function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(header: Record<string, unknown> = { alg: "RS256", kid: "key-one" }) {
  return `${encode(header)}.${encode({
    iss: ISSUER,
    sub: "google-oauth2|user-one",
    role: "authenticated",
    exp: 2_000_000_000,
  })}.signature`;
}

afterAll(() => {
  const entries = [
    ["AUTH0_DOMAIN", originalAuth0Env.domain],
    ["AUTH0_CLIENT_ID", originalAuth0Env.clientId],
    ["AUTH0_CLIENT_SECRET", originalAuth0Env.clientSecret],
    ["AUTH0_SECRET", originalAuth0Env.secret],
  ] as const;
  for (const [name, value] of entries) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Supabase Auth0 dashboard boundary", () => {
  test("rejects a symmetric ID token before database access", () => {
    expect(() => validateSupabaseIdToken(token({ alg: "HS256", kid: "key-one" }), ISSUER, 1_900_000_000_000))
      .toThrow(new DashboardDataError("identity-token", "Auth0 ID token must use RS256 with a key ID; received HS256"));
  });

  test("rejects an ID token without a key ID before database access", () => {
    expect(() => validateSupabaseIdToken(token({ alg: "RS256" }), ISSUER, 1_900_000_000_000))
      .toThrow(new DashboardDataError("identity-token", "Auth0 ID token must use RS256 with a key ID; received RS256"));
  });

  test("forwards the exact ID token to Supabase", async () => {
    const idToken = token();
    expect(await auth0SupabaseClientOptions(idToken).accessToken()).toBe(idToken);
  });

  test("keeps the existing-member claim and scoped dashboard path unchanged", async () => {
    process.env.AUTH0_DOMAIN = "tenant.example.test";
    const calls: string[] = [];
    const source: DashboardDataSource = {
      claimAccount: async () => {
        calls.push("claim");
        return { data: ACCOUNT_ID, error: null };
      },
      loadProfile: async (accountId) => {
        calls.push(`profile:${accountId}`);
        return { data: PROFILE, error: null };
      },
      loadEntitlement: async (accountId) => {
        calls.push(`entitlement:${accountId}`);
        return { data: null, error: null };
      },
      loadUsage: async (accountId) => {
        calls.push(`usage:${accountId}`);
        return { data: null, error: null };
      },
      loadDevices: async (accountId) => {
        calls.push(`devices:${accountId}`);
        return { data: [], error: null };
      },
      loadEnrollments: async (accountId) => {
        calls.push(`enrollments:${accountId}`);
        return { data: [], error: null };
      },
    };

    const result = await loadDashboardData(token(), (received) => {
      expect(received).toBe(token());
      return source;
    });

    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(result.entitlement).toMatchObject({
      account_id: ACCOUNT_ID,
      plan_code: "development",
      uploads_enabled: false,
      storage_limit_bytes: 0,
      session_limit: 0,
    });
    expect(result.usage).toMatchObject({
      account_id: ACCOUNT_ID,
      retained_storage_bytes: 0,
      capsule_count: 0,
    });
    expect(calls).toEqual([
      "claim",
      `profile:${ACCOUNT_ID}`,
      `entitlement:${ACCOUNT_ID}`,
      `usage:${ACCOUNT_ID}`,
      `devices:${ACCOUNT_ID}`,
      `enrollments:${ACCOUNT_ID}`,
    ]);
  });

  test("does not read profile or devices when account claiming fails", async () => {
    process.env.AUTH0_DOMAIN = "tenant.example.test";
    const calls: string[] = [];
    const source: DashboardDataSource = {
      claimAccount: async () => {
        calls.push("claim");
        return { data: null, error: { message: "No suitable key or wrong key type" } };
      },
      loadProfile: async () => {
        calls.push("profile");
        return { data: PROFILE, error: null };
      },
      loadEntitlement: async () => {
        calls.push("entitlement");
        return { data: null, error: null };
      },
      loadUsage: async () => {
        calls.push("usage");
        return { data: null, error: null };
      },
      loadDevices: async () => {
        calls.push("devices");
        return { data: [], error: null };
      },
      loadEnrollments: async () => {
        calls.push("enrollments");
        return { data: [], error: null };
      },
    };

    try {
      await loadDashboardData(token(), () => source);
      throw new Error("expected account claim failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardDataError);
      expect((error as { code: string }).code).toBe("account-claim");
    }
    expect(calls).toEqual(["claim"]);
  });

  test("describes a closed claim as private-alpha access without enumerating identity", () => {
    const copy = dashboardFailureCopy("account-claim", "sensitive database or identity detail");

    expect(copy.eyebrow).toBe("CLOUD PRIVATE ALPHA");
    expect(copy.heading).toContain("existing members");
    expect(copy.description).toContain("No Cloud account was created");
    expect(JSON.stringify(copy)).not.toContain("sensitive database");
    expect(JSON.stringify(copy)).not.toContain("email");
  });

  test("fails closed when quota metadata does not match the claimed account", async () => {
    const otherAccountId = "22222222-2222-2222-2222-222222222222";
    const calls: string[] = [];
    const source: DashboardDataSource = {
      claimAccount: async () => ({ data: ACCOUNT_ID, error: null }),
      loadProfile: async () => ({ data: PROFILE, error: null }),
      loadEntitlement: async (accountId) => {
        calls.push(`entitlement:${accountId}`);
        return { data: developmentEntitlement(accountId), error: null };
      },
      loadUsage: async (accountId) => {
        calls.push(`usage:${accountId}`);
        return { data: developmentUsage(otherAccountId), error: null };
      },
      loadDevices: async () => {
        calls.push("devices");
        return { data: [], error: null };
      },
      loadEnrollments: async () => ({ data: [], error: null }),
    };

    await expect(loadDashboardData(token(), () => source)).rejects.toMatchObject({
      code: "quota-scope",
      message: "Your cloud quota could not be verified safely.",
    });
    expect(calls).toEqual([
      `entitlement:${ACCOUNT_ID}`,
      `usage:${ACCOUNT_ID}`,
    ]);
  });

  test("keeps per-capsule and device safety caps visible for unmetered administrators", () => {
    const entitlement = {
      ...developmentEntitlement(ACCOUNT_ID),
      plan_code: "administrator",
      status: "active",
      unmetered: true,
      storage_limit_bytes: null,
      session_limit: null,
      capsule_size_limit_bytes: null,
      device_limit: null,
    };
    const display = quotaDisplayData(entitlement, developmentUsage(ACCOUNT_ID));

    expect(display).toMatchObject({
      planLabel: "Unmetered administrator",
      retainedStorageLabel: "0 bytes",
      sessionUsageLabel: "0",
      storageLimitLabel: "Unmetered",
      sessionLimitLabel: "Unmetered",
      capsuleSafetyLabel: "16 MiB",
      deviceSafetyLabel: CLOUD_DEVELOPMENT_LIMITS.devices.toLocaleString("en"),
      uploadsLabel: "Disabled",
    });
  });
});

describe("Supabase Auth0 account deletion boundary", () => {
  test("authorizes the ID token before constructing a data source", async () => {
    let sourceConstructed = false;
    try {
      await changeAccountDeletionRequest(
        token({ alg: "HS256", kid: "key-one" }),
        "request",
        ACCOUNT_DELETION_CONFIRMATION,
        () => {
          sourceConstructed = true;
          throw new Error("must not construct source");
        },
        REQUESTED_AT,
      );
      throw new Error("expected identity-token failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardDataError);
      expect((error as { code: string }).code).toBe("identity-token");
    }
    expect(sourceConstructed).toBe(false);
  });

  test("requires explicit request confirmation before account claiming", async () => {
    let sourceConstructed = false;
    try {
      await changeAccountDeletionRequest(
        token(),
        "request",
        null,
        () => {
          sourceConstructed = true;
          throw new Error("must not construct source");
        },
        REQUESTED_AT,
      );
      throw new Error("expected account-confirmation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardDataError);
      expect((error as { code: string }).code).toBe("account-confirmation");
    }
    expect(sourceConstructed).toBe(false);
  });

  test("claims first and scopes a deletion request to the claimed account", async () => {
    const calls: string[] = [];
    const source: AccountDeletionDataSource = {
      claimAccount: async () => {
        calls.push("claim");
        return { data: ACCOUNT_ID, error: null };
      },
      setDeletionRequestedAt: async (accountId, deletionRequestedAt, expectedCurrentState) => {
        calls.push(`update:${accountId}:${expectedCurrentState}`);
        expect(deletionRequestedAt).toBe(REQUESTED_AT);
        return {
          data: { ...PROFILE, deletion_requested_at: REQUESTED_AT },
          error: null,
        };
      },
    };

    const result = await changeAccountDeletionRequest(
      token(),
      "request",
      ACCOUNT_DELETION_CONFIRMATION,
      (received) => {
        expect(received).toBe(token());
        return source;
      },
      REQUESTED_AT,
    );

    expect(result.deletion_requested_at).toBe(REQUESTED_AT);
    expect(calls).toEqual([
      "claim",
      `update:${ACCOUNT_ID}:clear`,
    ]);
  });

  test("cancels only a pending request on the claimed account", async () => {
    const calls: string[] = [];
    const source: AccountDeletionDataSource = {
      claimAccount: async () => {
        calls.push("claim");
        return { data: ACCOUNT_ID, error: null };
      },
      setDeletionRequestedAt: async (accountId, deletionRequestedAt, expectedCurrentState) => {
        calls.push(`update:${accountId}:${expectedCurrentState}`);
        expect(deletionRequestedAt).toBeNull();
        return { data: PROFILE, error: null };
      },
    };

    const result = await changeAccountDeletionRequest(
      token(),
      "cancel",
      null,
      () => source,
      REQUESTED_AT,
    );

    expect(result.deletion_requested_at).toBeNull();
    expect(calls).toEqual([
      "claim",
      `update:${ACCOUNT_ID}:pending`,
    ]);
  });

  test("does not update when account claiming fails", async () => {
    const calls: string[] = [];
    const source: AccountDeletionDataSource = {
      claimAccount: async () => {
        calls.push("claim");
        return { data: null, error: { message: "claim detail" } };
      },
      setDeletionRequestedAt: async () => {
        calls.push("update");
        return { data: PROFILE, error: null };
      },
    };

    try {
      await changeAccountDeletionRequest(
        token(),
        "request",
        ACCOUNT_DELETION_CONFIRMATION,
        () => source,
        REQUESTED_AT,
      );
      throw new Error("expected account-claim failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardDataError);
      expect((error as { code: string }).code).toBe("account-claim");
    }
    expect(calls).toEqual(["claim"]);
  });

  test("rejects replayed or stale guarded updates that select no row", async () => {
    const source: AccountDeletionDataSource = {
      claimAccount: async () => ({ data: ACCOUNT_ID, error: null }),
      setDeletionRequestedAt: async () => ({ data: null, error: null }),
    };

    try {
      await changeAccountDeletionRequest(
        token(),
        "request",
        ACCOUNT_DELETION_CONFIRMATION,
        () => source,
        REQUESTED_AT,
      );
      throw new Error("expected account-state failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardDataError);
      expect((error as { code: string }).code).toBe("account-state");
    }
  });

  test("fails closed when an update returns a different account", async () => {
    const source: AccountDeletionDataSource = {
      claimAccount: async () => ({ data: ACCOUNT_ID, error: null }),
      setDeletionRequestedAt: async () => ({
        data: {
          ...PROFILE,
          id: "22222222-2222-2222-2222-222222222222",
          deletion_requested_at: REQUESTED_AT,
        },
        error: null,
      }),
    };

    try {
      await changeAccountDeletionRequest(
        token(),
        "request",
        ACCOUNT_DELETION_CONFIRMATION,
        () => source,
        REQUESTED_AT,
      );
      throw new Error("expected account-scope failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardDataError);
      expect((error as { code: string }).code).toBe("account-scope");
    }
  });

  test("sanitizes database update failures", async () => {
    const source: AccountDeletionDataSource = {
      claimAccount: async () => ({ data: ACCOUNT_ID, error: null }),
      setDeletionRequestedAt: async () => ({
        data: null,
        error: { message: "sensitive database policy detail" },
      }),
    };

    try {
      await changeAccountDeletionRequest(
        token(),
        "cancel",
        null,
        () => source,
        REQUESTED_AT,
      );
      throw new Error("expected account-update failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardDataError);
      expect((error as { code: string }).code).toBe("account-update");
      expect((error as Error).message).toBe("Your deletion request could not be changed.");
      expect((error as Error).message).not.toContain("database policy");
    }
  });
});
