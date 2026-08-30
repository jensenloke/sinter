import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  /** Keep default discovery enabled for harnesses not represented above. */
  includeDefaults?: boolean;
}

export interface SinterConfigSummary {
  configPath: string;
  profiles: Array<{
    name: string;
    stores: Partial<Record<HarnessId, string>>;
    instances?: SinterInstanceConfig[];
    includeDefaults?: boolean;
  }>;
}

export interface ConfigBootstrapResult {
  created: boolean;
  configPath: string;
  instances: string[];
}

const HARNESSES = new Set<HarnessId>(["claude", "codex", "devin", "opencode", "zcode", "omp", "pi"]);
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidInstanceName(value: string): boolean {
  return INSTANCE_NAME.test(value);
}

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
    if (!isValidInstanceName(id))
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
  const includeDefaults = profileRecord.include_defaults ?? false;
  if (typeof includeDefaults !== "boolean")
    throw new CliError(`profile "${name}" include_defaults must be true or false`);
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

  if (!Object.keys(stores).length && !instances?.length && !includeDefaults)
    throw new CliError(`profile "${name}" needs instances = [...] or [profiles.${name}.stores]`);

  for (const instance of instances ?? []) {
    if (instance.id === "default" && stores[instance.harness])
      throw new CliError(`profile "${name}" selects ${instance.harness}@default more than once`);
  }

  // Preserve the exact legacy object shape for callers that predate named
  // instances; `instances` is present only when the new syntax is used.
  return {
    name,
    configPath,
    stores,
    ...(instances ? { instances } : {}),
    ...(includeDefaults ? { includeDefaults: true } : {}),
  };
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
          ...(profile.includeDefaults ? { includeDefaults: true } : {}),
        };
      }),
  };
}

export function loadProfile(argv: string[]): SinterProfile | undefined {
  const name = stringFlag(argv, "profile");
  const configPath = stringFlag(argv, "config") ?? defaultConfigPath();
  if (name) return loadProfileByName(name, configPath);
  if (!existsSync(configPath)) return undefined;
  const parsed = parseFile(configPath);
  if (!record(parsed.profiles)?.default) return undefined;
  return parseProfile("default", configPath, parsed, parseInstances(parsed, configPath));
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Exclusively create an owner-only config; an existing target is never changed. */
export function createOwnerOnlyConfig(configPath: string, contents: string): boolean {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if (existsSync(configPath)) return false;
    throw new CliError(`cannot create config ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Create a conservative default config when more than one Claude Code store is
 * present. This is intentionally create-only: Sinter never rewrites a user's
 * config during discovery.
 */
export function bootstrapDefaultConfig(
  configPath = defaultConfigPath(),
  home = homedir(),
): ConfigBootstrapResult {
  if (existsSync(configPath)) return { created: false, configPath, instances: [] };

  let directories: string[];
  try {
    directories = readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === ".claude" || entry.name.startsWith(".claude-")))
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(home, name, "projects")))
      .sort((left, right) => {
        if (left === ".claude") return -1;
        if (right === ".claude") return 1;
        return left.localeCompare(right);
      });
  } catch {
    return { created: false, configPath, instances: [] };
  }
  if (directories.length < 2) return { created: false, configPath, instances: [] };

  const used = new Set<string>();
  const discovered = directories.map((directory) => {
    const base = directory === ".claude" ? "personal" : directory.slice(".claude-".length);
    const safeBase = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "claude";
    let id = safeBase;
    for (let suffix = 2; used.has(id); suffix++) id = `${safeBase}-${suffix}`;
    used.add(id);
    return { id, directory, store: join(home, directory, "projects") };
  });

  const sections = discovered.map(({ id, directory, store }) => {
    const command =
      directory === ".claude"
        ? `["claude"]`
        : `["env", ${tomlString(`CLAUDE_CONFIG_DIR=${join(home, directory)}`)}, "claude"]`;
    return `[instances.${id}]\nharness = "claude"\nstore = ${tomlString(store)}\ncommand = ${command}`;
  });
  const contents = `# Generated by Sinter after detecting multiple Claude Code stores.\n# Sinter never overwrites this file automatically.\n\n${sections.join("\n\n")}\n\n[profiles.default]\ninclude_defaults = true\ninstances = [${discovered.map(({ id }) => tomlString(id)).join(", ")}]\n`;

  if (!createOwnerOnlyConfig(configPath, contents)) return { created: false, configPath, instances: [] };
  return { created: true, configPath, instances: discovered.map(({ id }) => id) };
}

export const PROFILE_EXAMPLE = `[instances.personal]
harness = "claude"
store = "/Users/me/.claude/projects"
command = ["claude"]

[instances.work]
harness = "claude"
store = "/Users/me/.claude-work/projects"
command = ["env", "CLAUDE_CONFIG_DIR=/Users/me/.claude-work", "claude"]

[profiles.default]
include_defaults = true
instances = ["personal", "work"]

# Legacy one-store-per-harness profiles remain supported:
[profiles.legacy.stores]
codex = "/Users/me/.codex-work"
`;
