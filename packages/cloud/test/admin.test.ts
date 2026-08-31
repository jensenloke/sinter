import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignJWT, jwtVerify } from "jose";
import { UploadEntitlementControl } from "../src/app/admin/upload-entitlement-control";
import type {
  AdminDataSource,
  AdminEntitlementUpdate,
  AdminTokenVerifier,
} from "../src/lib/admin";
import { CLOUD_DEVELOPMENT_LIMITS, CLOUD_SAFETY_CAPS } from "../src/lib/cloud-quota";

const original = {
  domain: process.env.AUTH0_DOMAIN,
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  secret: process.env.AUTH0_SECRET,
};
const issuer = "https://admin.example.test/";
const clientId = "web-client-id";
const actorAccountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const targetAccountId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
let admin: typeof import("../src/lib/admin");

const verifier: AdminTokenVerifier = async (token, options) => (await jwtVerify(
  token,
  keyPair.publicKey,
  {
    issuer: options.issuer,
    audience: options.audience,
    algorithms: [...options.algorithms],
  },
)).payload;

async function signedIdentity(overrides: Record<string, unknown> = {}, audience = clientId) {
  return new SignJWT({
    role: "authenticated",
    email: "admin@example.test",
    email_verified: true,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "admin-test-key" })
    .setIssuer(issuer)
    .setSubject("auth0|admin-one")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keyPair.privateKey);
}

function rawAccount(overrides: Record<string, unknown> = {}) {
  return {
    account_id: targetAccountId,
    email: "member@example.test",
    account_created_at: "2026-08-20T00:00:00.000Z",
    deletion_requested_at: null,
    plan_code: "development",
    entitlement_status: "active",
    uploads_enabled: false,
    unmetered: false,
    storage_limit_bytes: 104857600,
    session_limit: 100,
    capsule_size_limit_bytes: 16777216,
    device_limit: 16,
    entitlement_updated_at: "2026-08-25T00:00:00.000Z",
    retained_storage_bytes: 1024,
    capsule_count: 2,
    reserved_storage_bytes: 512,
    reserved_capsule_count: 1,
    monthly_egress_bytes: 2048,
    usage_period_started_at: "2026-08-01T00:00:00.000Z",
    usage_updated_at: "2026-08-25T01:00:00.000Z",
    active_device_count: 1,
    total_device_count: 2,
    pending_enrollment_count: 1,
    encryption_public_key: "must-not-leak",
    signing_public_key: "must-not-leak",
    possession_proof: "must-not-leak",
    session_title: "must-not-leak",
    ciphertext: "must-not-leak",
    repository: "must-not-leak",
    path: "/must/not/leak",
    ...overrides,
  };
}

function entitlementResult(update: AdminEntitlementUpdate) {
  return {
    account_id: update.targetAccountId,
    plan_code: update.planCode,
    status: update.status,
    uploads_enabled: update.uploadsEnabled,
    unmetered: update.unmetered,
    storage_limit_bytes: update.storageLimitBytes,
    session_limit: update.sessionLimit,
    capsule_size_limit_bytes: update.capsuleSizeLimitBytes,
    device_limit: update.deviceLimit,
    updated_at: "2026-08-25T02:00:00.000Z",
  };
}

function source(overrides: Partial<AdminDataSource> = {}): AdminDataSource {
  return {
    resolveAccountId: async () => ({ data: actorAccountId, error: null }),
    hasSuperAdminRole: async () => ({ data: true, error: null }),
    listAccounts: async () => ({ data: [rawAccount()], error: null }),
    setEntitlement: async (_actor, update) => ({ data: entitlementResult(update), error: null }),
    ...overrides,
  };
}

function updateForm(overrides: Record<string, string | null> = {}) {
  const values: Record<string, string | null> = {
    target_account_id: targetAccountId,
    plan_code: "development",
    status: "active",
    uploads_enabled: "false",
    storage_limit_bytes: "104857600",
    session_limit: "100",
    capsule_size_limit_bytes: "16777216",
    device_limit: "16",
    reason: "Approved development quota adjustment",
    confirmation: `UPDATE ${targetAccountId}`,
    ...overrides,
  };
  const form = new FormData();
  for (const [name, value] of Object.entries(values)) {
    if (value !== null) form.set(name, value);
  }
  return form;
}

beforeAll(async () => {
  process.env.AUTH0_DOMAIN = "admin.example.test";
  process.env.AUTH0_CLIENT_ID = clientId;
  process.env.AUTH0_CLIENT_SECRET = "test-client-secret";
  process.env.AUTH0_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  admin = await import("../src/lib/admin");
});

afterAll(() => {
  for (const [name, value] of [
    ["AUTH0_DOMAIN", original.domain],
    ["AUTH0_CLIENT_ID", original.clientId],
    ["AUTH0_CLIENT_SECRET", original.clientSecret],
    ["AUTH0_SECRET", original.secret],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Auth0 web admin identity", () => {
  test("cryptographically verifies web audience, subject, role, and verified email", async () => {
    await expect(admin.verifyAdminWebIdentity(await signedIdentity(), verifier)).resolves.toEqual({
      issuer,
      subject: "auth0|admin-one",
      email: "admin@example.test",
    });

    await expect(admin.verifyAdminWebIdentity(await signedIdentity({}, "wrong-client"), verifier))
      .rejects.toMatchObject({ code: "access-denied", message: "Access denied." });
    await expect(admin.verifyAdminWebIdentity(await signedIdentity({ role: "member" }), verifier))
      .rejects.toMatchObject({ code: "access-denied" });
    await expect(admin.verifyAdminWebIdentity(await signedIdentity({ email_verified: false }), verifier))
      .rejects.toMatchObject({ code: "access-denied" });
    await expect(admin.verifyAdminWebIdentity(await signedIdentity({ email: "" }), verifier))
      .rejects.toMatchObject({ code: "access-denied" });
  });

  test("fails with a fixed error when the server-only Supabase secret is missing", () => {
    expect(() => admin.createAdminSecretClient({
      NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test",
    })).toThrow(new admin.AdminPortalError("configuration"));
  });
});

describe("super-admin authorization and metadata listing", () => {
  test("checks the account-scoped role before invoking the listing RPC", async () => {
    const calls: string[] = [];
    const denied = source({
      resolveAccountId: async (identity) => {
        calls.push(`identity:${identity.issuer}:${identity.subject}`);
        return { data: actorAccountId, error: null };
      },
      hasSuperAdminRole: async (accountId) => {
        calls.push(`role:${accountId}`);
        return { data: false, error: null };
      },
      listAccounts: async () => {
        calls.push("rpc");
        return { data: [rawAccount()], error: null };
      },
    });

    await expect(admin.loadAdminAccounts(await signedIdentity(), () => denied, verifier))
      .rejects.toMatchObject({ code: "access-denied", message: "Access denied." });
    expect(calls).toEqual([
      `identity:${issuer}:auth0|admin-one`,
      `role:${actorAccountId}`,
    ]);
  });

  test("passes the verified actor account explicitly and allowlists metadata", async () => {
    const calls: string[] = [];
    const allowed = source({
      resolveAccountId: async () => {
        calls.push("identity");
        return { data: actorAccountId, error: null };
      },
      hasSuperAdminRole: async (accountId) => {
        calls.push(`role:${accountId}`);
        return { data: true, error: null };
      },
      listAccounts: async (accountId) => {
        calls.push(`rpc:${accountId}`);
        return { data: [rawAccount()], error: null };
      },
    });

    const accounts = await admin.loadAdminAccounts(await signedIdentity(), () => allowed, verifier);
    expect(calls).toEqual(["identity", `role:${actorAccountId}`, `rpc:${actorAccountId}`]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      account_id: targetAccountId,
      account_email: "member@example.test",
      status: "active",
      capsule_count: 2,
      active_device_count: 1,
      total_device_count: 2,
      pending_enrollment_count: 1,
    });
    const serialized = JSON.stringify(accounts);
    for (const forbidden of [
      "public_key",
      "proof",
      "session_title",
      "ciphertext",
      "repository",
      "/must/not/leak",
      "must-not-leak",
      "SUPABASE_SECRET_KEY",
    ]) expect(serialized).not.toContain(forbidden);
  });

  test("sanitizes listing failures without exposing service details", async () => {
    const failing = source({
      listAccounts: async () => ({
        data: null,
        error: { message: "sensitive function or policy detail" },
      }),
    });
    await expect(admin.loadAdminAccounts(await signedIdentity(), () => failing, verifier))
      .rejects.toMatchObject({
        code: "account-list",
        message: "Account metadata could not be loaded.",
      });
  });
});

describe("super-admin entitlement updates", () => {
  test("requires exact confirmation, a bounded reason, and conservative limits", () => {
    expect(CLOUD_SAFETY_CAPS).toEqual({ capsuleSizeBytes: 67108864, devices: 32 });
    expect(admin.parseAdminEntitlementUpdate(updateForm(), {})).toMatchObject({
      targetAccountId,
      uploadsEnabled: false,
      storageLimitBytes: 104857600,
      sessionLimit: 100,
      capsuleSizeLimitBytes: 16777216,
      deviceLimit: 16,
    });
    for (const form of [
      updateForm({ confirmation: "UPDATE wrong-account" }),
      updateForm({ reason: "" }),
      updateForm({ status: "cancelled" }),
      updateForm({ storage_limit_bytes: "1.5" }),
      updateForm({ storage_limit_bytes: "9007199254740992" }),
      updateForm({ session_limit: "-1" }),
      updateForm({ capsule_size_limit_bytes: "67108865" }),
      updateForm({ device_limit: "33" }),
    ]) expect(() => admin.parseAdminEntitlementUpdate(form, {})).toThrow(new admin.AdminPortalError("invalid-update"));

    const invalidUnmetered = updateForm();
    invalidUnmetered.set("unmetered", "true");
    expect(() => admin.parseAdminEntitlementUpdate(invalidUnmetered, {}))
      .toThrow(new admin.AdminPortalError("invalid-update"));

    const unmetered = updateForm({ storage_limit_bytes: "", session_limit: "" });
    unmetered.set("unmetered", "true");
    expect(admin.parseAdminEntitlementUpdate(unmetered, {})).toMatchObject({
      unmetered: true,
      storageLimitBytes: null,
      sessionLimit: null,
      capsuleSizeLimitBytes: CLOUD_DEVELOPMENT_LIMITS.capsuleSizeBytes,
    });
  });

  test("accepts the upload entitlement only behind the exact injected feature gate", () => {
    const enabledForm = updateForm({ uploads_enabled: "true" });
    expect(() => admin.parseAdminEntitlementUpdate(enabledForm, {}))
      .toThrow(new admin.AdminPortalError("invalid-update"));
    expect(() => admin.parseAdminEntitlementUpdate(enabledForm, {
      SINTER_REAL_UPLOADS_ENABLED: "TRUE",
    })).toThrow(new admin.AdminPortalError("invalid-update"));
    expect(admin.parseAdminEntitlementUpdate(enabledForm, {
      SINTER_REAL_UPLOADS_ENABLED: "true",
    })).toMatchObject({ uploadsEnabled: true, targetAccountId });
    expect(admin.parseAdminEntitlementUpdate(updateForm(), {
      SINTER_REAL_UPLOADS_ENABLED: "true",
    })).toMatchObject({ uploadsEnabled: false });
  });

  test("renders the current account entitlement but locks submissions off with the global gate", () => {
    const locked = renderToStaticMarkup(createElement(UploadEntitlementControl, {
      entitlementEnabled: true,
      featureGateEnabled: false,
    }));
    expect(locked).toContain("Upload entitlement (enabled)");
    expect(locked).toContain("type=\"checkbox\"");
    expect(locked).toContain("checked=\"\"");
    expect(locked).toContain("disabled=\"\"");
    expect(locked).toContain("name=\"uploads_enabled\" value=\"false\"");
    expect(locked).toContain("global upload feature gate is off");

    const available = renderToStaticMarkup(createElement(UploadEntitlementControl, {
      entitlementEnabled: true,
      featureGateEnabled: true,
    }));
    expect(available).toContain("Upload entitlement (enabled)");
    expect(available).toContain("type=\"checkbox\" checked=\"\"");
    expect(available).not.toContain("disabled=\"\"");
    expect(available).toContain("name=\"uploads_enabled\" value=\"true\"");
    expect(available).toContain("global upload feature gate is enabled");
  });

  test("fully rechecks admin access but refuses uploads_enabled=true before the update RPC", async () => {
    const calls: string[] = [];
    const allowed = source({
      resolveAccountId: async () => {
        calls.push("identity");
        return { data: actorAccountId, error: null };
      },
      hasSuperAdminRole: async () => {
        calls.push("role");
        return { data: true, error: null };
      },
      setEntitlement: async () => {
        calls.push("rpc");
        return { data: null, error: null };
      },
    });
    await expect(admin.updateAdminEntitlement(
      await signedIdentity(),
      updateForm({ uploads_enabled: "true" }),
      () => allowed,
      verifier,
      {},
    )).rejects.toMatchObject({ code: "invalid-update" });
    expect(calls).toEqual(["identity", "role"]);
  });

  test("passes a cross-account target only after full admin verification", async () => {
    const calls: string[] = [];
    const allowed = source({
      resolveAccountId: async () => {
        calls.push("identity");
        return { data: actorAccountId, error: null };
      },
      hasSuperAdminRole: async (accountId) => {
        calls.push(`role:${accountId}`);
        return { data: true, error: null };
      },
      setEntitlement: async (accountId, update) => {
        calls.push(`rpc:${accountId}:${update.targetAccountId}:${update.uploadsEnabled}`);
        return { data: entitlementResult(update), error: null };
      },
    });

    await expect(admin.updateAdminEntitlement(
      await signedIdentity(),
      updateForm(),
      () => allowed,
      verifier,
    )).resolves.toMatchObject({ account_id: targetAccountId, uploads_enabled: false });
    expect(calls).toEqual([
      "identity",
      `role:${actorAccountId}`,
      `rpc:${actorAccountId}:${targetAccountId}:false`,
    ]);
  });

  test("passes uploads_enabled=true to the account-scoped audit RPC only when gated", async () => {
    const calls: string[] = [];
    const allowed = source({
      setEntitlement: async (accountId, update) => {
        calls.push(`${accountId}:${update.targetAccountId}:${update.uploadsEnabled}:${update.reason}`);
        return { data: entitlementResult(update), error: null };
      },
    });

    await expect(admin.updateAdminEntitlement(
      await signedIdentity(),
      updateForm({ uploads_enabled: "true" }),
      () => allowed,
      verifier,
      { SINTER_REAL_UPLOADS_ENABLED: "true" },
    )).resolves.toMatchObject({ account_id: targetAccountId, uploads_enabled: true });
    expect(calls).toEqual([
      `${actorAccountId}:${targetAccountId}:true:Approved development quota adjustment`,
    ]);
  });

  test("never invokes an update RPC after account-role denial", async () => {
    const calls: string[] = [];
    const denied = source({
      hasSuperAdminRole: async (accountId) => {
        calls.push(`role:${accountId}`);
        return { data: false, error: null };
      },
      setEntitlement: async () => {
        calls.push("rpc");
        return { data: null, error: null };
      },
    });
    await expect(admin.updateAdminEntitlement(
      await signedIdentity(),
      updateForm(),
      () => denied,
      verifier,
    )).rejects.toMatchObject({ code: "access-denied" });
    expect(calls).toEqual([`role:${actorAccountId}`]);
  });

  test("returns fixed update errors and verifies the returned target scope", async () => {
    const sensitive = source({
      setEntitlement: async () => ({
        data: null,
        error: { message: "token ciphertext session content policy detail" },
      }),
    });
    await expect(admin.updateAdminEntitlement(
      await signedIdentity(),
      updateForm(),
      () => sensitive,
      verifier,
    )).rejects.toMatchObject({
      code: "account-update",
      message: "The entitlement could not be updated.",
    });

    const wrongScope = source({
      setEntitlement: async (_actor, update) => ({
        data: entitlementResult({ ...update, targetAccountId: actorAccountId }),
        error: null,
      }),
    });
    await expect(admin.updateAdminEntitlement(
      await signedIdentity(),
      updateForm(),
      () => wrongScope,
      verifier,
    )).rejects.toMatchObject({
      code: "account-scope",
      message: "The entitlement update could not be verified.",
    });
  });
});
