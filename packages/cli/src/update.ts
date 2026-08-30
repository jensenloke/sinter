import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, EXIT, flagBool, flagString, parseArgs } from "./args";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_PACKAGE = "@jensenloke/sinter";
export const UPDATE_SCHEMA = "sinter.update.v1";

export type UpdatePackageManager = "bun" | "npm";

interface SemanticVersion {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[];
}

const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const STRICT_SEMVER = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
);

function parseVersion(version: string): SemanticVersion | undefined {
  const match = STRICT_SEMVER.exec(version);
  if (!match) return undefined;
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function isStrictSemver(version: string): boolean {
  return parseVersion(version) !== undefined;
}

/** Returns -1, 0, or 1 using SemVer 2.0.0 precedence (build metadata is ignored). */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) === 1;
}

interface UpdateCache {
  checkedAt: number;
  latest: string;
  promptedAt?: number;
}

export interface UpdateCheckOptions {
  argv?: string[];
  now?: number;
  interactive?: boolean;
  disabled?: boolean;
  cachePath?: string;
  readCache?: (path: string) => UpdateCache | undefined;
  writeCache?: (path: string, cache: UpdateCache) => void;
  fetchLatest?: () => Promise<unknown>;
  out?: (message: string) => void;
}

export function defaultUpdateCachePath(): string {
  return join(process.env.SINTER_HOME ?? join(homedir(), ".sinter"), "update-check.json");
}

function defaultReadCache(path: string): UpdateCache | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value?.checkedAt === "number" && typeof value?.latest === "string") return value;
  } catch {}
  return undefined;
}

function defaultWriteCache(path: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache) + "\n", "utf8");
  } catch {}
}

async function defaultFetchLatest(): Promise<unknown> {
  const response = await fetch("https://registry.npmjs.org/@jensenloke%2Fsinter/latest", {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const value = await response.json() as { version?: unknown };
  return value.version;
}

/**
 * Cached startup notification only. Installation is deliberately reserved for
 * the explicit `sinter update` command, so another command can never replace
 * the running executable as a startup side effect.
 */
export async function maybePromptForUpdate(currentVersion: string, options: UpdateCheckOptions = {}): Promise<boolean> {
  const argv = options.argv ?? Bun.argv.slice(2);
  const interactive = options.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
  const disabled = options.disabled ?? (
    process.env.SINTER_NO_UPDATE_CHECK !== undefined ||
    process.env.CI !== undefined ||
    argv.includes("--no-update-check") ||
    argv.some((arg) => ["--version", "-v", "version", "--help", "-h", "help", "update"].includes(arg))
  );
  if (!interactive || disabled) return false;

  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? defaultUpdateCachePath();
  const readCache = options.readCache ?? defaultReadCache;
  const writeCache = options.writeCache ?? defaultWriteCache;
  const fetchLatest = options.fetchLatest ?? defaultFetchLatest;
  let cache = readCache(cachePath);
  if (!cache || now - cache.checkedAt >= UPDATE_CHECK_INTERVAL_MS || !isStrictSemver(cache.latest)) {
    let latest: unknown;
    try {
      latest = await fetchLatest();
    } catch {
      return false;
    }
    if (typeof latest !== "string" || !isStrictSemver(latest)) return false;
    cache = { checkedAt: now, latest };
    writeCache(cachePath, cache);
  }
  if (!isNewerVersion(cache.latest, currentVersion)) return false;
  if (cache.promptedAt !== undefined && now - cache.promptedAt < UPDATE_CHECK_INTERVAL_MS) return false;

  const out = options.out ?? ((message: string) => process.stderr.write(message + "\n"));
  out(`Sinter ${cache.latest} is available (current ${currentVersion}). Run: sinter update`);
  writeCache(cachePath, { ...cache, promptedAt: now });
  return false;
}

export interface UpdateProcessResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface UpdateProcessOptions {
  capture: boolean;
}

export type UpdateProcessRunner = (
  argv: readonly string[],
  options: UpdateProcessOptions,
) => Promise<UpdateProcessResult>;

export interface UpdateDependencies {
  fetchLatest?: () => Promise<unknown>;
  runProcess?: UpdateProcessRunner;
  resolveCliEntrypoint?: () => string | undefined;
  detectPackageManager?: (entrypointPath: string) => UpdatePackageManager | undefined;
}

export interface UpdateRequest {
  currentVersion: string;
  check: boolean;
  force: boolean;
  json: boolean;
  packageManager?: UpdatePackageManager;
}

export type UpdateStatus = "up-to-date" | "update-available" | "newer-local" | "updated";

export interface UpdateResult {
  schema: typeof UPDATE_SCHEMA;
  ok: true;
  status: UpdateStatus;
  package: typeof UPDATE_PACKAGE;
  currentVersion: string;
  latestVersion: string;
  targetVersion: string;
  packageManager: UpdatePackageManager | null;
  check: boolean;
  forced: boolean;
  installed: boolean;
  verifiedVersion: string | null;
}

export class UpdateCommandError extends CliError {
  constructor(message: string, kind: "registry" | "installation" | "verification" | "version" | "resolution", code: number = EXIT.ERROR) {
    super(message, code, kind);
  }
}

export function detectPackageManagerFromEntrypoint(
  entrypointPath: string,
  home = homedir(),
): UpdatePackageManager | undefined {
  const path = entrypointPath.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/").replace(/\/$/, "");
  const packagePath = "/@jensenloke/sinter/";
  if (!path.includes(packagePath)) return undefined;
  if (/\/(?:\.bun)\/install\/global\/node_modules\/@jensenloke\/sinter\//.test(path)) return "bun";
  if (path.startsWith(`${normalizedHome}/node_modules/@jensenloke/sinter/`)) return "bun";
  if (/\/(?:lib\/node_modules|npm\/node_modules)\/@jensenloke\/sinter\//.test(path)) return "npm";
  return undefined;
}

function defaultResolveCliEntrypoint(): string | undefined {
  const candidate = process.argv[1];
  if (!candidate) return undefined;
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

const defaultRunProcess: UpdateProcessRunner = async (argv, options) => {
  const proc = Bun.spawn([...argv], {
    stdio: ["inherit", options.capture ? "pipe" : "inherit", options.capture ? "pipe" : "inherit"],
  });
  const stdout = options.capture
    ? new Response(proc.stdout as ReadableStream<Uint8Array>).text()
    : Promise.resolve(undefined);
  const stderr = options.capture
    ? new Response(proc.stderr as ReadableStream<Uint8Array>).text()
    : Promise.resolve(undefined);
  const [exitCode, capturedStdout, capturedStderr] = await Promise.all([proc.exited, stdout, stderr]);
  return { exitCode, stdout: capturedStdout, stderr: capturedStderr };
};

function installArgv(packageManager: UpdatePackageManager, version: string): string[] {
  const exactPackage = `${UPDATE_PACKAGE}@${version}`;
  return packageManager === "bun"
    ? ["bun", "add", "--global", exactPackage]
    : ["npm", "install", "--global", exactPackage];
}

function resultFor(
  request: UpdateRequest,
  latestVersion: string,
  status: UpdateStatus,
  packageManager: UpdatePackageManager | null = null,
  installed = false,
  verifiedVersion: string | null = null,
): UpdateResult {
  return {
    schema: UPDATE_SCHEMA,
    ok: true,
    status,
    package: UPDATE_PACKAGE,
    currentVersion: request.currentVersion,
    latestVersion,
    targetVersion: latestVersion,
    packageManager,
    check: request.check,
    forced: request.force,
    installed,
    verifiedVersion,
  };
}

export async function runUpdate(
  request: UpdateRequest,
  dependencies: UpdateDependencies = {},
): Promise<UpdateResult> {
  if (!isStrictSemver(request.currentVersion)) {
    throw new UpdateCommandError(`Current Sinter version is not strict semantic version: ${request.currentVersion}`, "version");
  }

  const fetchLatest = dependencies.fetchLatest ?? defaultFetchLatest;
  let registryValue: unknown;
  try {
    registryValue = await fetchLatest();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UpdateCommandError(`Could not query the npm registry for ${UPDATE_PACKAGE}: ${detail}`, "registry");
  }
  if (typeof registryValue !== "string" || !isStrictSemver(registryValue)) {
    throw new UpdateCommandError(`npm registry returned an invalid version for ${UPDATE_PACKAGE}`, "registry");
  }
  const latestVersion = registryValue;
  const comparison = compareVersions(latestVersion, request.currentVersion)!;
  if (comparison === 0) return resultFor(request, latestVersion, "up-to-date");
  if (comparison < 0 && !request.force) return resultFor(request, latestVersion, "newer-local");
  if (request.check) return resultFor(request, latestVersion, "update-available");

  const resolveEntrypoint = dependencies.resolveCliEntrypoint ?? defaultResolveCliEntrypoint;
  const detectPackageManager = dependencies.detectPackageManager ?? detectPackageManagerFromEntrypoint;
  const entrypointPath = resolveEntrypoint();
  const detectedManager = entrypointPath ? detectPackageManager(entrypointPath) : undefined;
  const packageManager = request.packageManager ?? detectedManager;
  if (!packageManager) {
    const detail = entrypointPath ? ` from ${entrypointPath}` : "";
    throw new UpdateCommandError(
      `Could not determine whether this Sinter executable was installed by bun or npm${detail}. Pass --package-manager bun or --package-manager npm.`,
      "resolution",
      EXIT.AMBIGUOUS,
    );
  }

  const runProcess = dependencies.runProcess ?? defaultRunProcess;
  let installation: UpdateProcessResult;
  try {
    installation = await runProcess(installArgv(packageManager, latestVersion), { capture: request.json });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UpdateCommandError(`Failed to install ${UPDATE_PACKAGE}@${latestVersion} with ${packageManager}: ${detail}`, "installation");
  }
  if (installation.exitCode !== 0) {
    throw new UpdateCommandError(
      `Failed to install ${UPDATE_PACKAGE}@${latestVersion} with ${packageManager} (exit ${installation.exitCode})`,
      "installation",
    );
  }

  let verifiedVersion: string | null = null;
  if (entrypointPath && detectedManager === packageManager) {
    let verification: UpdateProcessResult;
    try {
      verification = await runProcess([process.execPath, entrypointPath, "--version"], { capture: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new UpdateCommandError(`Installed Sinter but could not verify ${entrypointPath}: ${detail}`, "verification");
    }
    const reportedVersion = verification.stdout?.trim();
    if (verification.exitCode !== 0 || reportedVersion !== latestVersion) {
      const reported = reportedVersion && isStrictSemver(reportedVersion) ? reportedVersion : "unreadable";
      throw new UpdateCommandError(
        `Installed ${UPDATE_PACKAGE}@${latestVersion}, but ${entrypointPath} reports ${reported}`,
        "verification",
      );
    }
    verifiedVersion = reportedVersion;
  }

  return resultFor(request, latestVersion, "updated", packageManager, true, verifiedVersion);
}

export interface UpdateCommandContext {
  out: (message: string) => void;
  version?: string;
  update?: UpdateDependencies;
}

function humanUpdateResult(result: UpdateResult): string {
  if (result.status === "up-to-date") return `Sinter ${result.currentVersion} is up to date.`;
  if (result.status === "newer-local") {
    return `Local Sinter ${result.currentVersion} is newer than npm latest ${result.latestVersion}; no update performed. Use --force to install the older published version.`;
  }
  if (result.status === "update-available") {
    const direction = compareVersions(result.latestVersion, result.currentVersion) === -1 ? "published version" : "update";
    return `Sinter ${result.latestVersion} is available as a ${direction} (current ${result.currentVersion}); no install performed.`;
  }
  const verification = result.verifiedVersion
    ? ` Verified ${result.verifiedVersion} at the current executable.`
    : " Executable verification was not available from this invocation.";
  return `Updated Sinter from ${result.currentVersion} to ${result.latestVersion} with ${result.packageManager}.${verification}`;
}

export async function cmdUpdate(argv: string[], ctx: UpdateCommandContext): Promise<number> {
  const args = parseArgs(argv, { booleans: ["check", "force", "json"], strings: ["package-manager"] });
  if (args._.length) throw new CliError("usage: sinter update [--check] [--package-manager bun|npm] [--force] [--json]");
  const packageManagerValue = flagString(args, "package-manager");
  if (packageManagerValue !== undefined && packageManagerValue !== "bun" && packageManagerValue !== "npm") {
    throw new CliError(`bad --package-manager: ${packageManagerValue} (expected bun or npm)`);
  }
  const result = await runUpdate({
    currentVersion: ctx.version ?? "0.0.0",
    check: flagBool(args, "check"),
    force: flagBool(args, "force"),
    json: flagBool(args, "json"),
    packageManager: packageManagerValue,
  }, ctx.update);
  ctx.out(flagBool(args, "json") ? JSON.stringify(result, null, 2) : humanUpdateResult(result));
  return EXIT.OK;
}
