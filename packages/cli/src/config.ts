import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessId, InstanceId } from "@sinter/core";
import { CliError } from "./args";

export interface SinterInstanceConfig {
  /** Globally unique, user-facing instance name from `[instances.<id>]`. */
  id: InstanceId;
  harness: HarnessId;
  /** Harness-specific local store root; it is never uploaded. */
  store: string;
  /** Optional argv prefix used instead of the adapter's default executable. */
  command?: string[];
}

export interface SinterProfile {
  name: string;
  configPath: string;
  /** Legacy harness-specific roots from `[profiles.<name>.stores]`. */
  stores: Partial<Record<HarnessId, string>>;
  /** Named instances selected by `[profiles.<name>] instances = [...]`. */
  instances?: SinterInstanceConfig[];
}

export interface SinterConfigSummary {
  configPath: string;
  profiles: Array<{
    name: string;
    stores: Partial<Record<HarnessId, string>>;
    instances?: SinterInstanceConfig[];
  }>;
}

const HARNESSES = new Set<HarnessId>(["claude", "codex", "devin", "opencode", "zcode", "omp", "pi"]);
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function defaultConfigPath(): string {
  return process.env.SINTER_CONFIG ?? join(homedir(), ".config", "sinter", "config.toml");
}

export function stringFlag(argv: string[], name: string): string | undefined {
  const equals = `--${name}=`;
  const index = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(equals));
  if (index < 0) return undefined;
  const value = argv[index]!;
  if (value.startsWith(equals)) return value.slice(equals.length);
  const next = argv[index + 1];
  if (!next || next.startsWith("-")) throw new CliError(`--${name} needs a value`);
  return next;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) throw new CliError(`config file does not exist: ${configPath}`);
  try {
    return record(Bun.TOML.parse(readFileSync(configPath, "utf8"))) ?? {};
  } catch (err) {
    throw new CliError(`cannot parse config ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseInstances(parsed: Record<string, unknown>, configPath: string): Map<string, SinterInstanceConfig> {
  const result = new Map<string, SinterInstanceConfig>();
  const rawInstances = record(parsed.instances) ?? {};
  for (const [id, value] of Object.entries(rawInstances)) {
    if (!INSTANCE_NAME.test(id))
      throw new CliError(`instance name "${id}" in ${configPath} must contain only letters, numbers, dot, dash, or underscore`);
    const instance = record(value);
    if (!instance) throw new CliError(`instance "${id}" must be a table`);
    const harness = instance.harness;
    if (typeof harness !== "string" || !HARNESSES.has(harness as HarnessId))
      throw new CliError(`instance "${id}" has unknown harness: ${String(harness ?? "")}`);
    const store = instance.store;
    if (typeof store !== "string" || !store.trim()) throw new CliError(`instance "${id}" store must be a path`);

    let command: string[] | undefined;
    if (instance.command !== undefined) {
      if (
        !Array.isArray(instance.command) ||
        instance.command.length === 0 ||
        instance.command.some((part) => typeof part !== "string" || !part)
      )
        throw new CliError(`instance "${id}" command must be a non-empty array of strings`);
      command = [...instance.command] as string[];
    }
    result.set(id, { id, harness: harness as HarnessId, store, ...(command ? { command } : {}) });
  }
  return result;
}

function parseProfile(
  name: string,
  configPath: string,
  parsed: Record<string, unknown>,
  allInstances: Map<string, SinterInstanceConfig>,
): SinterProfile {
  const profileRecord = record(record(parsed.profiles)?.[name]);
  if (!profileRecord) throw new CliError(`profile "${name}" is not defined in ${configPath}`);

  const stores: Partial<Record<HarnessId, string>> = {};
  const rawStores = profileRecord.stores === undefined ? undefined : record(profileRecord.stores);
  if (profileRecord.stores !== undefined && !rawStores)
    throw new CliError(`profile "${name}" [profiles.${name}.stores] must be a table`);
  for (const [harness, path] of Object.entries(rawStores ?? {})) {
    if (!HARNESSES.has(harness as HarnessId)) throw new CliError(`profile "${name}" has unknown harness: ${harness}`);
    if (typeof path !== "string" || !path) throw new CliError(`profile "${name}" store ${harness} must be a path`);
    stores[harness as HarnessId] = path;
  }

  let instances: SinterInstanceConfig[] | undefined;
  if (profileRecord.instances !== undefined) {
    if (!Array.isArray(profileRecord.instances) || profileRecord.instances.some((id) => typeof id !== "string" || !id))
      throw new CliError(`profile "${name}" instances must be an array of instance names`);
    if (new Set(profileRecord.instances).size !== profileRecord.instances.length)
      throw new CliError(`profile "${name}" contains a duplicate instance`);
    instances = profileRecord.instances.map((id) => {
      const found = allInstances.get(id as string);
      if (!found) throw new CliError(`profile "${name}" references unknown instance: ${String(id)}`);
      return { ...found, ...(found.command ? { command: [...found.command] } : {}) };
    });
  }

  if (!Object.keys(stores).length && !instances?.length)
    throw new CliError(`profile "${name}" needs instances = [...] or [profiles.${name}.stores]`);

  for (const instance of instances ?? []) {
    if (instance.id === "default" && stores[instance.harness])
      throw new CliError(`profile "${name}" selects ${instance.harness}@default more than once`);
  }

  // Preserve the exact legacy object shape for callers that predate named
  // instances; `instances` is present only when the new syntax is used.
  return { name, configPath, stores, ...(instances ? { instances } : {}) };
}

/** Read a named local-only profile, including any selected named instances. */
export function loadProfileByName(name: string, configPath: string): SinterProfile {
  if (!existsSync(configPath)) throw new CliError(`profile "${name}" needs config file: ${configPath}`);
  const parsed = parseFile(configPath);
  return parseProfile(name, configPath, parsed, parseInstances(parsed, configPath));
}

/** Parse and validate every configured profile and instance for diagnostics. */
export function inspectConfig(configPath: string): SinterConfigSummary {
  const parsed = parseFile(configPath);
  const profiles = record(parsed.profiles);
  if (!profiles || !Object.keys(profiles).length) throw new CliError(`config has no profiles: ${configPath}`);
  const instances = parseInstances(parsed, configPath);

  return {
    configPath,
    profiles: Object.keys(profiles)
      .sort()
      .map((name) => {
        const profile = parseProfile(name, configPath, parsed, instances);
        return {
          name,
          stores: profile.stores,
          ...(profile.instances ? { instances: profile.instances } : {}),
        };
      }),
  };
}

export function loadProfile(argv: string[]): SinterProfile | undefined {
  const name = stringFlag(argv, "profile");
  if (!name) return undefined;
  return loadProfileByName(name, stringFlag(argv, "config") ?? defaultConfigPath());
}

export const PROFILE_EXAMPLE = `[instances.claude-personal]
harness = "claude"
store = "/Users/me/.claude/projects"
command = ["claude"]

[instances.claude-work]
harness = "claude"
store = "/Users/me/.claude-work/projects"
command = ["claude-addvita"]

[profiles.work]
instances = ["claude-personal", "claude-work"]

# Legacy one-store-per-harness profiles remain supported:
[profiles.legacy.stores]
codex = "/Users/me/.codex-work"
`;
