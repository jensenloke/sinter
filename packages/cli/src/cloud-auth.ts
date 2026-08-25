import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { browserCommand } from "./feedback";

export const DEFAULT_CLOUD_URL = "https://sinter-cloud.vercel.app";
const KEYCHAIN_SERVICE = "app.sinter.cloud";
const KEYCHAIN_ACCOUNT = "default";

export interface CloudIdentity {
  id: string;
  email: string | null;
}

export interface StoredCloudSession {
  schema: "sinter.cloud.credentials.v2";
  provider: "auth0";
  baseUrl: string;
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: CloudIdentity;
}

export interface CloudLoginOptions {
  baseUrl?: string;
  timeoutMs?: number;
  openBrowser?: boolean;
  onUrl?: (url: string) => void;
  onDeviceCode?: (code: string) => void;
}

export interface CloudAuthService {
  login(options?: CloudLoginOptions): Promise<{ user: CloudIdentity; storage: string }>;
  whoami(): Promise<{ user: CloudIdentity; storage: string } | undefined>;
  logout(): Promise<{ hadSession: boolean; revoked: boolean }>;
}

export interface CredentialStore {
  readonly description: string;
  load(): Promise<StoredCloudSession | undefined>;
  save(session: StoredCloudSession): Promise<void>;
  delete(): Promise<void>;
}

interface CommandResult { code: number; stdout: string; stderr: string }
type CommandRunner = (argv: string[]) => Promise<CommandResult>;

async function runCommand(argv: string[]): Promise<CommandResult> {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function validSession(value: unknown): value is StoredCloudSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<StoredCloudSession>;
  return session.schema === "sinter.cloud.credentials.v2" && session.provider === "auth0" &&
    typeof session.baseUrl === "string" &&
    typeof session.issuer === "string" &&
    typeof session.clientId === "string" &&
    typeof session.accessToken === "string" && session.accessToken.length > 0 &&
    typeof session.refreshToken === "string" && session.refreshToken.length > 0 &&
    typeof session.expiresAt === "number" && Number.isFinite(session.expiresAt) &&
    Boolean(session.user) && typeof session.user!.id === "string" &&
    (typeof session.user!.email === "string" || session.user!.email === null);
}

export function cloudCredentialPath(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "sinter", "cloud-auth.json");
}

export function createCredentialStore(options: {
  os?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: CommandRunner;
} = {}): CredentialStore {
  const os = options.os ?? platform();
  const run = options.run ?? runCommand;
  if (os === "darwin") {
    return {
      description: "macOS Keychain",
      async load() {
        const result = await run(["security", "find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"]);
        if (result.code !== 0) return undefined;
        try {
          const parsed: unknown = JSON.parse(result.stdout);
          return validSession(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      },
      async save(session) {
        const result = await run([
          "security", "add-generic-password", "-U", "-a", KEYCHAIN_ACCOUNT,
          "-s", KEYCHAIN_SERVICE, "-w", JSON.stringify(session),
        ]);
        if (result.code !== 0) throw new Error(`Could not save Cloud login to Keychain: ${result.stderr.trim() || "security failed"}`);
      },
      async delete() {
        await run(["security", "delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE]);
      },
    };
  }

  const path = cloudCredentialPath(options.env, options.home);
  return {
    description: `owner-only file ${path}`,
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return validSession(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    async save(session) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await chmod(dirname(path), 0o700);
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(session), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      await chmod(path, 0o600);
    },
    async delete() {
      try { await unlink(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("Cloud URL must use HTTPS (except localhost development)");
  if (url.username || url.password || url.search || url.hash) throw new Error("Cloud URL must not contain credentials, query, or fragment");
  return url.toString().replace(/\/$/, "");
}

interface Auth0Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface DeviceConfig {
  provider: "auth0";
  issuer: string;
  clientId: string;
  audience: string;
  scope: string;
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

function auth0Endpoint(issuer: string, path: string) {
  const base = new URL(issuer);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("Sinter Cloud returned an invalid Auth0 issuer");
  }
  return new URL(path.replace(/^\//, ""), base.toString().replace(/\/?$/, "/")).toString();
}

async function pause(ms: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

async function jsonResponse(response: Response) {
  const value = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  return value;
}

export function createCloudAuthService(options: {
  store?: CredentialStore;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  openUrl?: (url: string) => Promise<void>;
  now?: () => number;
} = {}): CloudAuthService {
  const store = options.store ?? createCredentialStore();
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const openUrl = options.openUrl ?? (async (url) => {
    const result = await runCommand(browserCommand(url));
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not open browser");
  });

  async function identity(baseUrl: string, accessToken: string): Promise<CloudIdentity | undefined> {
    const response = await request(`${baseUrl}/api/cli/session`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401) return undefined;
    if (!response.ok) throw new Error(`Sinter Cloud identity check failed (HTTP ${response.status})`);
    const body = await jsonResponse(response);
    const user = body?.user as Partial<CloudIdentity> | undefined;
    if (!user || typeof user.id !== "string" || (typeof user.email !== "string" && user.email !== null)) {
      throw new Error("Sinter Cloud returned an invalid identity response");
    }
    return { id: user.id, email: user.email };
  }

  async function refresh(session: StoredCloudSession): Promise<StoredCloudSession> {
    const response = await request(auth0Endpoint(session.issuer, "/oauth/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: session.clientId,
        refresh_token: session.refreshToken,
      }),
    });
    if (!response.ok) throw new Error("Cloud session expired; run `sinter login` again");
    const body = await jsonResponse(response);
    if (typeof body?.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new Error("Auth0 returned an invalid refresh response");
    }
    const updated: StoredCloudSession = {
      ...session,
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : session.refreshToken,
      expiresAt: Math.floor(now() / 1000) + body.expires_in,
    };
    await store.save(updated);
    return updated;
  }

  return {
    async login(loginOptions = {}) {
      const baseUrl = normalizeBaseUrl(loginOptions.baseUrl ?? process.env.SINTER_CLOUD_URL ?? DEFAULT_CLOUD_URL);
      const timeoutMs = loginOptions.timeoutMs ?? 10 * 60_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 15 * 60_000) throw new Error("Login timeout must be between 30 seconds and 15 minutes");
      const configResponse = await request(`${baseUrl}/api/cli/config`);
      const configBody = await jsonResponse(configResponse);
      const config = configBody?.auth as Partial<DeviceConfig> | undefined;
      if (!configResponse.ok || config?.provider !== "auth0" || typeof config.issuer !== "string" ||
        typeof config.clientId !== "string" || typeof config.audience !== "string" || typeof config.scope !== "string") {
        throw new Error("Sinter Cloud device login is not configured");
      }
      const codeResponse = await request(auth0Endpoint(config.issuer, "/oauth/device/code"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.clientId, audience: config.audience, scope: config.scope }),
      });
      const code = await jsonResponse(codeResponse) as Partial<DeviceCode> | undefined;
      if (!codeResponse.ok || typeof code?.device_code !== "string" || typeof code.user_code !== "string" ||
        typeof code.verification_uri !== "string" || typeof code.expires_in !== "number") {
        throw new Error("Auth0 could not start device login");
      }
      const verificationUrl = typeof code.verification_uri_complete === "string" ? code.verification_uri_complete : code.verification_uri;
      loginOptions.onDeviceCode?.(code.user_code);
      loginOptions.onUrl?.(verificationUrl);
      if (loginOptions.openBrowser !== false) {
        try { await openUrl(verificationUrl); } catch { /* The printed URL remains usable. */ }
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Cloud login timed out; run `sinter login` to try again")), Math.min(timeoutMs, code.expires_in * 1000));
      const intervalMs = Math.max(1, code.interval ?? 5) * 1000;
      let tokenBody: Record<string, unknown> | undefined;
      try {
        while (!controller.signal.aborted) {
          const tokenResponse = await request(auth0Endpoint(config.issuer, "/oauth/token"), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: code.device_code,
              client_id: config.clientId,
            }),
            signal: controller.signal,
          });
          tokenBody = await jsonResponse(tokenResponse);
          if (tokenResponse.ok) break;
          if (tokenBody?.error === "authorization_pending") { await pause(intervalMs, controller.signal); continue; }
          if (tokenBody?.error === "slow_down") { await pause(intervalMs + 5_000, controller.signal); continue; }
          if (tokenBody?.error === "access_denied") throw new Error("Sinter Cloud login was denied");
          if (tokenBody?.error === "expired_token") throw new Error("Sinter Cloud login code expired; run `sinter login` again");
          throw new Error("Auth0 could not complete device login");
        }
      } finally {
        clearTimeout(timeout);
      }
      if (typeof tokenBody?.access_token !== "string" || typeof tokenBody.refresh_token !== "string" || typeof tokenBody.expires_in !== "number") {
        throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Auth0 returned an invalid device session");
      }
      const callbackSession: Auth0Session = {
        accessToken: tokenBody.access_token,
        refreshToken: tokenBody.refresh_token,
        expiresAt: Math.floor(now() / 1000) + tokenBody.expires_in,
      };
      const user = await identity(baseUrl, callbackSession.accessToken);
      if (!user) throw new Error("Sinter Cloud rejected the returned login session");
      const session: StoredCloudSession = {
        schema: "sinter.cloud.credentials.v2", provider: "auth0", baseUrl,
        issuer: config.issuer, clientId: config.clientId,
        ...callbackSession, user,
      };
      await store.save(session);
      return { user, storage: store.description };
    },

    async whoami() {
      let session = await store.load();
      if (!session) return undefined;
      if (session.expiresAt * 1000 <= now() + 60_000) session = await refresh(session);
      let user = await identity(session.baseUrl, session.accessToken);
      if (!user) {
        session = await refresh(session);
        user = await identity(session.baseUrl, session.accessToken);
      }
      if (!user) throw new Error("Cloud session expired; run `sinter login` again");
      return { user, storage: store.description };
    },

    async logout() {
      const session = await store.load();
      if (!session) return { hadSession: false, revoked: false };
      let revoked = false;
      try {
        const response = await request(`${session.baseUrl}/api/cli/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
        revoked = response.ok;
      } finally {
        await store.delete();
      }
      return { hadSession: true, revoked };
    },
  };
}
