import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessId } from "@sinter/core";
import { CliError } from "./args";

export interface SinterProfile {
  name: string;
  configPath: string;
  /** Harness-specific local store roots; they are never uploaded. */
  stores: Partial<Record<HarnessId, string>>;
}

export interface SinterConfigSummary {
  configPath: string;
  profiles: Array<{ name: string; stores: Partial<Record<HarnessId, string>> }>;
}

const HARNESSES = new Set<HarnessId>(["claude", "codex", "devin", "opencode", "zcode", "omp", "pi"]);

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

/**
 * Read a named, local-only profile. A profile is deliberately a map of store
 * roots, not an account/subscription abstraction: Sinter never sees identity
 * or billing state.
 */
export function loadProfileByName(name: string, configPath: string): SinterProfile {
  if (!existsSync(configPath)) throw new CliError(`profile "${name}" needs config file: ${configPath}`);

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new CliError(`cannot parse config ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const profiles = record(parsed)?.profiles;
  const profile = record(profiles)?.[name];
  const profileRecord = record(profile);
  if (!profileRecord) throw new CliError(`profile "${name}" is not defined in ${configPath}`);
  const rawStores = record(profileRecord.stores);
  if (!rawStores) throw new CliError(`profile "${name}" needs [profiles.${name}.stores]`);

  const stores: Partial<Record<HarnessId, string>> = {};
  for (const [harness, path] of Object.entries(rawStores)) {
    if (!HARNESSES.has(harness as HarnessId)) throw new CliError(`profile "${name}" has unknown harness: ${harness}`);
    if (typeof path !== "string" || !path) throw new CliError(`profile "${name}" store ${harness} must be a path`);
    stores[harness as HarnessId] = path;
  }
  return { name, configPath, stores };
}

/** Parse and validate every configured profile for inspection and diagnostics. */
export function inspectConfig(configPath: string): SinterConfigSummary {
  if (!existsSync(configPath)) throw new CliError(`config file does not exist: ${configPath}`);
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new CliError(`cannot parse config ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const profiles = record(record(parsed)?.profiles);
  if (!profiles || !Object.keys(profiles).length) throw new CliError(`config has no profiles: ${configPath}`);

  return {
    configPath,
    profiles: Object.keys(profiles)
      .sort()
      .map((name) => {
        const profile = loadProfileByName(name, configPath);
        return { name, stores: profile.stores };
      }),
  };
}

export function loadProfile(argv: string[]): SinterProfile | undefined {
  const name = stringFlag(argv, "profile");
  if (!name) return undefined;
  return loadProfileByName(name, stringFlag(argv, "config") ?? defaultConfigPath());
}

export const PROFILE_EXAMPLE = `[profiles.work.stores]
claude = "/Users/me/.claude-work/projects"
codex = "/Users/me/.codex-work"
devin = "/Users/me/.local/share/devin/cli/sessions.db"
`;
