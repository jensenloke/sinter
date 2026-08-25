import { afterAll, describe, expect, test } from "bun:test";
import type { CloudProfile, DashboardDataSource } from "../src/lib/supabase/auth0";

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

  test("claims before reading and scopes both reads to the claimed account", async () => {
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
      loadDevices: async (accountId) => {
        calls.push(`devices:${accountId}`);
        return { data: [], error: null };
      },
    };

    const result = await loadDashboardData(token(), (received) => {
      expect(received).toBe(token());
      return source;
    });

    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(calls).toEqual([
      "claim",
      `profile:${ACCOUNT_ID}`,
      `devices:${ACCOUNT_ID}`,
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
      loadDevices: async () => {
        calls.push("devices");
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
});
