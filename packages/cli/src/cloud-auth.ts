import { randomBytes, timingSafeEqual } from "node:crypto";
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
  schema: "sinter.cloud.credentials.v1";
  baseUrl: string;
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
  return session.schema === "sinter.cloud.credentials.v1" &&
    typeof session.baseUrl === "string" &&
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

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface CallbackSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function waitForBrowserSession(state: string, timeoutMs: number, onReady: (callback: string) => Promise<void>) {
  let resolveSession!: (session: CallbackSession) => void;
  let rejectSession!: (error: Error) => void;
  const received = new Promise<CallbackSession>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });
  let settled = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback" || request.method !== "POST") return new Response("Not found", { status: 404 });
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > 24_576) return new Response("Request too large", { status: 413 });
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.startsWith("application/x-www-form-urlencoded")) return new Response("Unsupported request", { status: 415 });
      const body = await request.text();
      if (body.length > 24_576) return new Response("Request too large", { status: 413 });
      const form = new URLSearchParams(body);
      if (!safeEqual(form.get("state") ?? "", state)) return new Response("Login state did not match", { status: 403 });
      const accessToken = form.get("access_token") ?? "";
      const refreshToken = form.get("refresh_token") ?? "";
      const expiresAt = Number(form.get("expires_at"));
      if (!accessToken || accessToken.length > 16_384 || !refreshToken || refreshToken.length > 8192 || !Number.isFinite(expiresAt)) {
        return new Response("Invalid session", { status: 400 });
      }
      if (!settled) {
        settled = true;
        resolveSession({ accessToken, refreshToken, expiresAt });
      }
      return new Response("<!doctype html><title>Sinter login complete</title><style>body{font:18px system-ui;display:grid;place-items:center;min-height:90vh;background:#0d0f0e;color:#f4f1e8}</style><p>Sinter is connected. You can close this tab.</p>", {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" },
      });
    },
  });
  const timer = setTimeout(() => {
    if (!settled) rejectSession(new Error("Cloud login timed out; run `sinter login` to try again"));
  }, timeoutMs);
  try {
    await onReady(`http://127.0.0.1:${server.port}/callback`);
    return await received;
  } finally {
    clearTimeout(timer);
    await server.stop(true);
  }
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
    const response = await request(`${session.baseUrl}/api/cli/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (!response.ok) throw new Error("Cloud session expired; run `sinter login` again");
    const body = await jsonResponse(response);
    const user = body?.user as Partial<CloudIdentity> | undefined;
    if (
      typeof body?.accessToken !== "string" || typeof body.refreshToken !== "string" ||
      typeof body.expiresAt !== "number" || !user || typeof user.id !== "string" ||
      (typeof user.email !== "string" && user.email !== null)
    ) throw new Error("Sinter Cloud returned an invalid refresh response");
    const updated: StoredCloudSession = {
      schema: "sinter.cloud.credentials.v1", baseUrl: session.baseUrl,
      accessToken: body.accessToken, refreshToken: body.refreshToken,
      expiresAt: body.expiresAt, user: { id: user.id, email: user.email },
    };
    await store.save(updated);
    return updated;
  }

  return {
    async login(loginOptions = {}) {
      const baseUrl = normalizeBaseUrl(loginOptions.baseUrl ?? process.env.SINTER_CLOUD_URL ?? DEFAULT_CLOUD_URL);
      const timeoutMs = loginOptions.timeoutMs ?? 10 * 60_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 15 * 60_000) throw new Error("Login timeout must be between 30 seconds and 15 minutes");
      const state = randomBytes(32).toString("base64url");
      const callbackSession = await waitForBrowserSession(state, timeoutMs, async (callback) => {
        const url = `${baseUrl}/cli/login?${new URLSearchParams({ callback, state })}`;
        loginOptions.onUrl?.(url);
        if (loginOptions.openBrowser !== false) {
          try { await openUrl(url); } catch { /* The printed URL remains usable. */ }
        }
      });
      const user = await identity(baseUrl, callbackSession.accessToken);
      if (!user) throw new Error("Sinter Cloud rejected the returned login session");
      const session: StoredCloudSession = {
        schema: "sinter.cloud.credentials.v1", baseUrl,
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
