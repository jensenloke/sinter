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
  schema: "sinter.cloud.credentials.v1",
  baseUrl: "https://cloud.example.test",
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
  test("completes a browser-loopback login, validates identity, and saves it", async () => {
    const store = memoryStore();
    const service = createCloudAuthService({
      store,
      openUrl: async (loginUrl) => {
        const url = new URL(loginUrl);
        const callback = url.searchParams.get("callback")!;
        const state = url.searchParams.get("state")!;
        const response = await fetch(callback, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ state, access_token: "access-one", refresh_token: "refresh-one", expires_at: "2000000000" }),
        });
        expect(response.status).toBe(200);
      },
      fetch: async (input) => {
        expect(String(input)).toBe("https://cloud.example.test/api/cli/session");
        return Response.json({ ok: true, user: USER });
      },
    });
    const result = await service.login({ baseUrl: "https://cloud.example.test", timeoutMs: 30_000 });
    expect(result.user).toEqual(USER);
    expect(store.current?.refreshToken).toBe("refresh-one");
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
        if (url.endsWith("/refresh")) return Response.json({
          accessToken: "access-two", refreshToken: "refresh-two", expiresAt: 3000, user: USER,
        });
        return Response.json({ user: USER });
      },
    });
    expect((await service.whoami())?.user).toEqual(USER);
    expect(store.current?.accessToken).toBe("access-two");
    expect(endpoints.map((url) => url.split("/").at(-1))).toEqual(["refresh", "session"]);
  });

  test("logout removes the local credential even when revocation fails", async () => {
    const store = memoryStore(SESSION);
    const service = createCloudAuthService({ store, fetch: async () => new Response("no", { status: 503 }) });
    expect(await service.logout()).toEqual({ hadSession: true, revoked: false });
    expect(store.deleted).toBe(true);
  });
});
