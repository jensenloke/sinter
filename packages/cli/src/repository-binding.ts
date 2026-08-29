import { stat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { validateSession, type SifGit, type SifSession } from "@sinter/core";
import { CliError, EXIT } from "./args";

export const REPOSITORY_BINDING_SCHEMA = "sinter.repository-binding.v1" as const;
export const REPOSITORY_BINDING_PREVIEW_SCHEMA = "sinter.repository-binding-preview.v1" as const;
export const SESSION_TRANSFER_SCHEMA = "sinter.session-transfer.v2" as const;

export interface RepositoryRemote {
  host: string;
  path: string;
}

export interface RepositoryBindingV1 {
  schema: typeof REPOSITORY_BINDING_SCHEMA;
  remotes: readonly RepositoryRemote[];
  selectedRemote: RepositoryRemote;
  commit: string;
  branch?: string;
  relativeCwd: string;
}

export interface RepositoryBindingPreview {
  schema: typeof REPOSITORY_BINDING_PREVIEW_SCHEMA;
  sourceRepository: string;
  sourceCommit: string;
  sourceBranch?: string;
  targetRepository: string;
  targetRoot: string;
  targetCwd: string;
  targetHead: string;
  relativeCwd: string;
  match: "exact" | "mismatch";
  commitAvailable: boolean;
  targetWorktreeDirty: boolean;
  overrides: {
    repositoryMismatch: boolean;
    missingCommit: boolean;
  };
  writes: false;
}

export interface RepositoryTargetResolution {
  preview: RepositoryBindingPreview;
  targetCwd: string;
  git: SifGit;
  provenanceModeSuffix: string;
}

export interface RepositoryResolveOptions {
  allowRepositoryMismatch?: boolean;
  allowMissingCommit?: boolean;
}

export interface SessionTransferPayloadV2 {
  schema: typeof SESSION_TRANSFER_SCHEMA;
  repository: RepositoryBindingV1;
  session: SifSession;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RepositoryBindingDependencies {
  runGit?: (cwd: string, args: string[]) => Promise<CommandResult>;
  realpath?: (path: string) => Promise<string>;
  stat?: typeof stat;
}

export interface RepositoryBindingService {
  source(session: SifSession, options?: { remoteName?: string }): Promise<RepositoryBindingV1>;
  resolve(binding: RepositoryBindingV1, targetRoot: string, options: RepositoryResolveOptions): Promise<RepositoryTargetResolution>;
}

export class RepositoryBindingError extends CliError {
  constructor(message: string) {
    super(message, EXIT.ERROR, "repository_binding");
  }
}

function fail(message: string): never {
  throw new RepositoryBindingError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(`${label} contains unsupported fields`);
}

function safeString(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function normalizedRemotePath(value: string): string {
  if (value.includes("\\")) fail("Git remote is not a supported hosted Git remote");
  let path = value.split(/[?#]/, 1)[0]!.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  path = path.replace(/\/+$/, "");
  if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) fail("Git remote has no valid repository path");
  if (path !== path.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(path)) fail("Git remote repository path is invalid");
  return path;
}

function sanitizeRepositoryRemote(value: string): { identity: RepositoryRemote; url: string } {
  const input = safeString(value, "Git remote", 8192).trim();
  let host: string;
  let path: string;
  let protocol: "https" | "ssh";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      fail("Git remote is not a supported hosted Git remote");
    }
    if (url.protocol !== "https:" && url.protocol !== "ssh:") fail("Git remote is not a supported hosted Git remote");
    protocol = url.protocol === "https:" ? "https" : "ssh";
    host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host) fail("Git remote has no valid hostname");
    const defaultPort = (url.protocol === "https:" && url.port === "443") || (url.protocol === "ssh:" && url.port === "22");
    if (url.port && !defaultPort) host = `${host}:${url.port}`;
    path = normalizedRemotePath(url.pathname);
  } else {
    const match = /^(?:[^@\s/:]+@)?(\[[^\]]+\]|[^:\s/]+):(.+)$/.exec(input);
    if (!match || /^[A-Za-z]$/.test(match[1]!)) fail("Git remote is not a supported hosted Git remote");
    protocol = "ssh";
    host = match[1]!.toLowerCase().replace(/\.$/, "");
    path = normalizedRemotePath(match[2]!);
  }
  if (!/^[a-z0-9._:[\]-]+(?::\d+)?$/i.test(host)) fail("Git remote has no valid hostname");
  return { identity: { host, path }, url: `${protocol}://${host}/${path}` };
}

export function normalizeRepositoryRemote(value: string): RepositoryRemote {
  return sanitizeRepositoryRemote(value).identity;
}

function remoteKey(remote: RepositoryRemote): string {
  return `${remote.host}\n${remote.path}`;
}

function compareRemotes(left: RepositoryRemote, right: RepositoryRemote): number {
  return left.host.localeCompare(right.host) || left.path.localeCompare(right.path);
}

function parseRemote(value: unknown, label: string): RepositoryRemote {
  const item = record(value, label);
  exactKeys(item, ["host", "path"], label);
  const host = safeString(item.host, `${label} host`, 512).toLowerCase();
  const path = safeString(item.path, `${label} path`, 4096);
  if (normalizeRepositoryRemote(`ssh://git@${host}/${path}`).host !== host || normalizedRemotePath(path) !== path) {
    fail(`${label} is not canonical`);
  }
  return { host, path };
}

function relativeWorkingDirectory(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f\\]/.test(value)) {
    fail("Repository relative working directory is invalid");
  }
  if (value === "") return value;
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/")) fail("Repository relative working directory is invalid");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail("Repository relative working directory is invalid");
  return value;
}

function commitValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) fail(`${label} is invalid`);
  return value;
}

export function parseRepositoryBinding(value: unknown): RepositoryBindingV1 {
  const binding = record(value, "Repository binding");
  exactKeys(binding, ["schema", "remotes", "selectedRemote", "commit", "branch", "relativeCwd"], "Repository binding");
  if (binding.schema !== REPOSITORY_BINDING_SCHEMA) fail("Unsupported repository binding schema");
  if (!Array.isArray(binding.remotes) || binding.remotes.length < 1 || binding.remotes.length > 32) fail("Repository binding remotes are invalid");
  const remotes = binding.remotes.map((remote, index) => parseRemote(remote, `Repository remote ${index}`));
  const sorted = [...remotes].sort(compareRemotes);
  if (sorted.some((remote, index) => remoteKey(remote) !== remoteKey(remotes[index]!))) fail("Repository binding remotes are not canonically sorted");
  if (new Set(remotes.map(remoteKey)).size !== remotes.length) fail("Repository binding contains duplicate remotes");
  const selectedRemote = parseRemote(binding.selectedRemote, "Repository selected remote");
  if (!remotes.some((remote) => remoteKey(remote) === remoteKey(selectedRemote))) fail("Repository selected remote is not present in the remote set");
  const branch = binding.branch === undefined ? undefined : safeString(binding.branch, "Repository branch", 1024);
  return {
    schema: REPOSITORY_BINDING_SCHEMA,
    remotes,
    selectedRemote,
    commit: commitValue(binding.commit, "Repository commit"),
    ...(branch ? { branch } : {}),
    relativeCwd: relativeWorkingDirectory(binding.relativeCwd),
  };
}

async function defaultRunGit(cwd: string, args: string[]): Promise<CommandResult> {
  try {
    const process = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } catch {
    return { code: 1, stdout: "", stderr: "" };
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function portableRelative(root: string, candidate: string): string {
  const value = relative(root, candidate);
  if (!inside(root, candidate)) fail("Session working directory is outside its Git repository");
  return relativeWorkingDirectory(value.split(sep).join("/"));
}

function displayRemote(remote: RepositoryRemote): string {
  return `${remote.host}/${remote.path}`;
}

export function sanitizeSessionForNetwork(session: SifSession): SifSession {
  const sanitize = (value: SifSession): SifSession => {
    const { preserve: _preserve, additionalDirs: _additionalDirs, git: _git, ...rest } = value;
    return {
      ...rest,
      cwd: "",
      origin: {
        harness: value.origin.harness,
        ...(value.origin.instanceId ? { instanceId: value.origin.instanceId } : {}),
        nativeId: value.origin.nativeId,
      },
      entries: value.entries.map(({ raw: _raw, ...entry }) => entry),
      ...(value.subsessions ? { subsessions: value.subsessions.map(sanitize) } : {}),
    };
  };
  const safe = sanitize(session);
  validateSession(safe);
  return safe;
}

function assertNetworkSafeSession(session: SifSession): void {
  const inspect = (value: SifSession): void => {
    if (value.cwd !== "" || value.git !== undefined || value.preserve !== undefined || value.additionalDirs !== undefined
      || value.origin.nativePath !== undefined || value.origin.host !== undefined || value.entries.some((entry) => entry.raw !== undefined)) {
      fail("Session transfer payload contains unsupported source-local fields");
    }
    value.subsessions?.forEach(inspect);
  };
  inspect(session);
}

export function serializeSessionTransferPayload(session: SifSession, binding: RepositoryBindingV1): string {
  const repository = parseRepositoryBinding(binding);
  validateSession(session);
  assertNetworkSafeSession(session);
  return JSON.stringify({ schema: SESSION_TRANSFER_SCHEMA, repository, session } satisfies SessionTransferPayloadV2);
}

export function parseSessionTransferPayload(value: string): SessionTransferPayloadV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("Received session transfer payload is invalid JSON");
  }
  const payload = record(parsed, "Session transfer payload");
  if (payload.schema !== SESSION_TRANSFER_SCHEMA) fail("Received unsupported session transfer payload; both devices must use Sinter direct transfer v2");
  exactKeys(payload, ["schema", "repository", "session"], "Session transfer payload");
  const repository = parseRepositoryBinding(payload.repository);
  const session = payload.session as SifSession;
  try {
    validateSession(session);
  } catch {
    fail("Received session transfer payload contains invalid SIF");
  }
  assertNetworkSafeSession(session);
  return { schema: SESSION_TRANSFER_SCHEMA, repository, session };
}

export function bindSessionToRepository(session: SifSession, resolution: RepositoryTargetResolution): SifSession {
  const rewrite = (value: SifSession): SifSession => ({
    ...value,
    cwd: resolution.targetCwd,
    git: { ...resolution.git },
    ...(value.subsessions ? { subsessions: value.subsessions.map(rewrite) } : {}),
  });
  const rewritten = rewrite(session);
  validateSession(rewritten);
  return rewritten;
}

export function createRepositoryBindingService(dependencies: RepositoryBindingDependencies = {}): RepositoryBindingService {
  const runGit = dependencies.runGit ?? defaultRunGit;
  const resolveRealpath = dependencies.realpath ?? realpath;
  const pathStat = dependencies.stat ?? stat;

  const git = async (cwd: string, args: string[], message: string): Promise<string> => {
    const result = await runGit(cwd, args);
    if (result.code !== 0) fail(message);
    return result.stdout.trim();
  };

  const repositoryRoot = async (path: string, label: "source" | "target"): Promise<string> => {
    let cwd: string;
    try {
      cwd = await resolveRealpath(resolve(path));
      if (!(await pathStat(cwd)).isDirectory()) fail(`The ${label} workspace is not a directory`);
    } catch (error) {
      if (error instanceof RepositoryBindingError) throw error;
      fail(`The ${label} workspace is unavailable`);
    }
    const root = await git(cwd, ["rev-parse", "--show-toplevel"], `The ${label} workspace is not a Git repository`);
    try {
      return await resolveRealpath(root);
    } catch {
      fail(`The ${label} Git repository root is unavailable`);
    }
  };

  const remotes = async (root: string): Promise<{
    all: RepositoryRemote[];
    byName: Map<string, RepositoryRemote[]>;
    urls: Map<string, string>;
  }> => {
    const names = lines(await git(root, ["remote"], "Could not inspect Git remotes"));
    const all = new Map<string, RepositoryRemote>();
    const byName = new Map<string, RepositoryRemote[]>();
    const urls = new Map<string, string>();
    for (const name of names) {
      const result = await runGit(root, ["remote", "get-url", "--all", name]);
      if (result.code !== 0) fail("Could not inspect Git remotes");
      const named = new Map<string, RepositoryRemote>();
      for (const value of lines(result.stdout)) {
        try {
          const sanitized = sanitizeRepositoryRemote(value);
          const normalized = sanitized.identity;
          all.set(remoteKey(normalized), normalized);
          named.set(remoteKey(normalized), normalized);
          urls.set(remoteKey(normalized), sanitized.url);
        } catch (error) {
          if (!(error instanceof RepositoryBindingError)) throw error;
        }
      }
      byName.set(name, [...named.values()].sort(compareRemotes));
    }
    return {
      all: [...all.values()].sort(compareRemotes),
      byName,
      urls,
    };
  };

  const targetSubdirectory = async (root: string, relativeCwd: string): Promise<string> => {
    const lexical = relativeCwd ? resolve(root, ...relativeCwd.split("/")) : root;
    if (!inside(root, lexical)) fail("Repository relative working directory escapes the target repository");
    let canonical: string;
    try {
      canonical = await resolveRealpath(lexical);
      if (!(await pathStat(canonical)).isDirectory()) fail("Repository target subdirectory is not a directory");
    } catch (error) {
      if (error instanceof RepositoryBindingError) throw error;
      fail("Repository target subdirectory is missing");
    }
    if (!inside(root, canonical)) fail("Repository relative working directory escapes the target repository");
    return canonical;
  };

  return {
    async source(session, options = {}) {
      if (!session.cwd) fail("The source session has no repository workspace");
      const sourceCwd = await resolveRealpath(resolve(session.cwd)).catch(() => fail("The source session workspace is unavailable"));
      const root = await repositoryRoot(sourceCwd, "source");
      if (!inside(root, sourceCwd)) fail("Session working directory is outside its Git repository");
      const available = await remotes(root);
      if (!available.all.length) fail("The source repository has no supported remote identity");

      let namedRemotes: RepositoryRemote[] | undefined;
      if (options.remoteName !== undefined) {
        const remoteName = safeString(options.remoteName, "Repository remote name", 256);
        if (remoteName.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(remoteName)) fail("Repository remote name is invalid");
        namedRemotes = available.byName.get(remoteName);
        if (!namedRemotes?.length) fail(`Repository remote ${remoteName} has no supported identity`);
        if (namedRemotes.length !== 1) fail(`Repository remote ${remoteName} has several possible identities`);
      }

      let selectedRemote: RepositoryRemote | undefined;
      if (session.git?.remote) {
        let preferred: RepositoryRemote;
        try {
          preferred = normalizeRepositoryRemote(session.git.remote);
        } catch {
          fail("The source session Git remote cannot be sanitized");
        }
        selectedRemote = available.all.find((remote) => remoteKey(remote) === remoteKey(preferred));
        if (!selectedRemote) fail("The source session Git remote does not match the current checkout");
        if (namedRemotes && remoteKey(namedRemotes[0]!) !== remoteKey(selectedRemote)) {
          fail("The explicit repository remote conflicts with the source session identity");
        }
      } else if (namedRemotes) {
        selectedRemote = namedRemotes[0];
      } else if (available.all.length === 1) {
        selectedRemote = available.all[0];
      }
      if (!selectedRemote) fail("The source repository has several possible remote identities; use --repo-remote <name>");

      let commit: string;
      if (session.git?.sha !== undefined) {
        if (!/^[0-9a-fA-F]{7,64}$/.test(session.git.sha)) fail("The source session Git commit is invalid");
        commit = await git(root, ["rev-parse", "--verify", `${session.git.sha}^{commit}`], "The source session Git commit is unavailable locally");
      } else {
        commit = await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], "The source repository has no available commit");
      }
      commit = commitValue(commit.toLowerCase(), "Repository commit");

      let branch = session.git?.branch;
      if (branch !== undefined) branch = safeString(branch, "Repository branch", 1024);
      if (!branch) {
        const current = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
        branch = current.code === 0 && current.stdout.trim() ? safeString(current.stdout.trim(), "Repository branch", 1024) : undefined;
      }

      return parseRepositoryBinding({
        schema: REPOSITORY_BINDING_SCHEMA,
        remotes: available.all,
        selectedRemote,
        commit,
        ...(branch ? { branch } : {}),
        relativeCwd: portableRelative(root, sourceCwd),
      });
    },

    async resolve(bindingValue, targetPath, options) {
      const binding = parseRepositoryBinding(bindingValue);
      const requested = await resolveRealpath(resolve(targetPath)).catch(() => fail("The target workspace is unavailable"));
      const root = await repositoryRoot(requested, "target");
      if (requested !== root) fail("The explicit target workspace must be the Git repository root");
      const available = await remotes(root);
      if (!available.all.length) fail("The target repository has no supported remote identity");

      const exact = available.all.find((remote) => remoteKey(remote) === remoteKey(binding.selectedRemote));
      let selectedTarget: RepositoryRemote;
      let match: "exact" | "mismatch";
      if (exact) {
        selectedTarget = exact;
        match = "exact";
      } else {
        match = "mismatch";
        if (!options.allowRepositoryMismatch) {
          fail(`Refusing repository mismatch: source ${displayRemote(binding.selectedRemote)} does not match the selected target; no session or workspace files were written`);
        }
        if (available.all.length === 1) selectedTarget = available.all[0]!;
        else fail("The target repository has several possible remote identities");
      }

      const targetCwd = await targetSubdirectory(root, binding.relativeCwd);
      const commitResult = await runGit(root, ["cat-file", "-e", `${binding.commit}^{commit}`]);
      const commitAvailable = commitResult.code === 0;
      if (!commitAvailable && !options.allowMissingCommit) {
        fail("The source commit is unavailable in the target repository; no fetch was performed. Use --allow-missing-commit for an explicit context-only import");
      }
      const targetHead = commitValue(
        (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], "The target repository has no available commit")).toLowerCase(),
        "Target repository commit",
      );
      const dirty = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=normal"]);
      if (dirty.code !== 0) fail("Could not inspect the target repository worktree");

      const suffixes: string[] = [];
      if (match === "mismatch") suffixes.push("repo-mismatch-allowed");
      if (!commitAvailable) suffixes.push("missing-commit-allowed");
      const preview: RepositoryBindingPreview = {
        schema: REPOSITORY_BINDING_PREVIEW_SCHEMA,
        sourceRepository: displayRemote(binding.selectedRemote),
        sourceCommit: binding.commit,
        ...(binding.branch ? { sourceBranch: binding.branch } : {}),
        targetRepository: displayRemote(selectedTarget),
        targetRoot: root,
        targetCwd,
        targetHead,
        relativeCwd: binding.relativeCwd,
        match,
        commitAvailable,
        targetWorktreeDirty: dirty.stdout.length > 0,
        overrides: {
          repositoryMismatch: match === "mismatch",
          missingCommit: !commitAvailable,
        },
        writes: false,
      };
      return {
        preview,
        targetCwd,
        git: {
          sha: binding.commit,
          ...(binding.branch ? { branch: binding.branch } : {}),
          remote: available.urls.get(remoteKey(selectedTarget))!,
        },
        provenanceModeSuffix: suffixes.length ? `+${suffixes.join("+")}` : "",
      };
    },
  };
}
