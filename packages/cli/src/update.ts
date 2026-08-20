import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_PACKAGE = "@jensenloke/sinter";

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
  fetchLatest?: () => Promise<string | undefined>;
  confirm?: (question: string) => Promise<boolean>;
  install?: () => Promise<number>;
  out?: (message: string) => void;
}

function parseVersion(version: string): { numbers: number[]; prerelease?: string } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!match) return undefined;
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] };
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i]! !== b.numbers[i]!) return a.numbers[i]! > b.numbers[i]!;
  }
  if (!a.prerelease && b.prerelease) return true;
  if (a.prerelease && !b.prerelease) return false;
  return (a.prerelease ?? "") > (b.prerelease ?? "");
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

async function defaultFetchLatest(): Promise<string | undefined> {
  try {
    const response = await fetch("https://registry.npmjs.org/@jensenloke%2Fsinter/latest", {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    const value = await response.json() as { version?: unknown };
    return typeof value.version === "string" ? value.version : undefined;
  } catch {
    return undefined;
  }
}

async function defaultConfirm(question: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${question} `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

async function defaultInstall(): Promise<number> {
  const proc = Bun.spawn(["bun", "add", "--global", `${UPDATE_PACKAGE}@latest`], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  return proc.exited;
}

export async function maybePromptForUpdate(currentVersion: string, options: UpdateCheckOptions = {}): Promise<boolean> {
  const argv = options.argv ?? Bun.argv.slice(2);
  const interactive = options.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
  const disabled = options.disabled ?? (
    process.env.SINTER_NO_UPDATE_CHECK !== undefined ||
    process.env.CI !== undefined ||
    argv.includes("--no-update-check") ||
    argv.some((arg) => ["--version", "-v", "version", "--help", "-h", "help"].includes(arg))
  );
  if (!interactive || disabled) return false;

  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? defaultUpdateCachePath();
  const readCache = options.readCache ?? defaultReadCache;
  const writeCache = options.writeCache ?? defaultWriteCache;
  const fetchLatest = options.fetchLatest ?? defaultFetchLatest;
  let cache = readCache(cachePath);
  if (!cache || now - cache.checkedAt >= UPDATE_CHECK_INTERVAL_MS) {
    const latest = await fetchLatest();
    if (!latest) return false;
    cache = { checkedAt: now, latest };
    writeCache(cachePath, cache);
  }
  if (!isNewerVersion(cache.latest, currentVersion)) return false;
  if (cache.promptedAt !== undefined && now - cache.promptedAt < UPDATE_CHECK_INTERVAL_MS) return false;

  const confirm = options.confirm ?? defaultConfirm;
  const accepted = await confirm(`Sinter ${cache.latest} is available (current ${currentVersion}). Update globally now? [Y/n]`);
  if (!accepted) {
    writeCache(cachePath, { ...cache, promptedAt: now });
    return false;
  }
  const install = options.install ?? defaultInstall;
  const out = options.out ?? ((message: string) => process.stderr.write(message + "\n"));
  let code: number;
  try {
    code = await install();
  } catch (error) {
    out(`Update failed (${error instanceof Error ? error.message : String(error)}). Run: bun add --global ${UPDATE_PACKAGE}@latest`);
    return false;
  }
  if (code !== 0) {
    out(`Update failed (exit ${code}). Run: bun add --global ${UPDATE_PACKAGE}@latest`);
    return false;
  }
  out(`Updated Sinter to ${cache.latest}. Run your command again.`);
  return true;
}
