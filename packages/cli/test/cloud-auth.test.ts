import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloudCredentialPath,
  createCloudAuthService,
  createCredentialStore,
  type CredentialStore,
  type StoredCloudSession,
} from "../src/cloud-auth";

const USER = { id: "user-1", email: "jensen@example.test" };
const SESSION: StoredCloudSession = {
  schema: "sinter.cloud.credentials.v2",
  provider: "auth0",
  baseUrl: "https://cloud.example.test",
  issuer: "https://tenant.example.test/",
  clientId: "cli-client",
  accessToken: "access-one",
  refreshToken: "refresh-one",
  expiresAt: 2_000_000_000,
  user: USER,
};

function memoryStore(initial?: StoredCloudSession): CredentialStore & { current?: StoredCloudSession; deleted: boolean } {
  return {
    description: "test keychain",
    current: initial,
    deleted: false,
    async load() { return this.current; },
    async save(session) { this.current = session; },
    async delete() { this.current = undefined; this.deleted = true; },
  };
}

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Cloud credential storage", () => {
  test("uses macOS Keychain and never falls back to a plaintext file", async () => {
    let saved = "";
    const calls: string[][] = [];
    const store = createCredentialStore({
      os: "darwin",
      run: async (argv) => {
        calls.push(argv);
        if (argv[1] === "add-generic-password") saved = argv.at(-1)!;
        if (argv[1] === "find-generic-password") return { code: 0, stdout: saved, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await store.save(SESSION);
    expect(await store.load()).toEqual(SESSION);
    await store.delete();
    expect(store.description).toBe("macOS Keychain");
    expect(calls.map((call) => call[1])).toEqual(["add-generic-password", "find-generic-password", "delete-generic-password"]);
  });

  test("uses an owner-only file on platforms without a native implementation", async () => {
    const home = mkdtempSync(join(tmpdir(), "sinter-cloud-auth-"));
    temporary.push(home);
    const store = createCredentialStore({ os: "linux", home, env: {} });
    await store.save(SESSION);
    const path = cloudCredentialPath({}, home);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(SESSION);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await store.delete();
    expect(await store.load()).toBeUndefined();
  });
});

describe("Cloud auth service", () => {
  test("completes Auth0 device login, validates identity, and saves it", async () => {
    const store = memoryStore();
    const opened: string[] = [];
    const deviceCodes: string[] = [];
    const service = createCloudAuthService({
      store,
      now: () => 1_900_000_000_000,
      openUrl: async (loginUrl) => { opened.push(loginUrl); },
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/cli/config")) return Response.json({ auth: {
          provider: "auth0", issuer: "https://tenant.example.test/", clientId: "cli-client",
          audience: "https://api.example.test", scope: "openid profile email offline_access",
        } });
        if (url.endsWith("/oauth/device/code")) return Response.json({
          device_code: "device-secret", user_code: "STONE-RIVER",
          verification_uri: "https://tenant.example.test/activate",
          verification_uri_complete: "https://tenant.example.test/activate?user_code=STONE-RIVER",
          expires_in: 300, interval: 1,
        });
        if (url.endsWith("/oauth/token")) return Response.json({
          access_token: "access-one", refresh_token: "refresh-one", expires_in: 3600,
        });
        if (url.endsWith("/api/cli/session")) return Response.json({ ok: true, user: USER });
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const result = await service.login({
      baseUrl: "https://cloud.example.test", timeoutMs: 30_000,
      onDeviceCode: (code) => deviceCodes.push(code),
    });
    expect(result.user).toEqual(USER);
    expect(store.current?.refreshToken).toBe("refresh-one");
    expect(store.current?.provider).toBe("auth0");
    expect(deviceCodes).toEqual(["STONE-RIVER"]);
    expect(opened).toEqual(["https://tenant.example.test/activate?user_code=STONE-RIVER"]);
  });

  test("refreshes an expiring session before verifying whoami", async () => {
    const store = memoryStore({ ...SESSION, expiresAt: 100 });
    const endpoints: string[] = [];
    const service = createCloudAuthService({
      store,
      now: () => 200_000,
      fetch: async (input) => {
        const url = String(input);
        endpoints.push(url);
        if (url.endsWith("/oauth/token")) return Response.json({
          access_token: "access-two", refresh_token: "refresh-two", expires_in: 3000,
        });
        return Response.json({ user: USER });
      },
    });
    expect((await service.whoami())?.user).toEqual(USER);
    expect(store.current?.accessToken).toBe("access-two");
    expect(endpoints.map((url) => url.split("/").at(-1))).toEqual(["token", "session"]);
  });

  test("logout removes the local credential even when revocation fails", async () => {
    const store = memoryStore(SESSION);
    const service = createCloudAuthService({ store, fetch: async () => new Response("no", { status: 503 }) });
    expect(await service.logout()).toEqual({ hadSession: true, revoked: false });
    expect(store.deleted).toBe(true);
  });
});
