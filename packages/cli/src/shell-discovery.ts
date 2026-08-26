import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, normalize } from "node:path";
import { CliError } from "./args";
import { isValidInstanceName } from "./config";

export const SHELL_DISCOVERY_SCHEMA = "sinter.config.discover-shell.v1";

export type ShellDiscoveryRejectionReason =
  | "not_candidate"
  | "complex_command"
  | "invalid_instance"
  | "invalid_path"
  | "projects_unavailable"
  | "already_detected"
  | "duplicate_config_dir"
  | "instance_collision";

export interface ShellDiscoveryCandidate {
  instance: string;
  harness: "claude";
  configDir: string;
  store: string;
  command: ["env", string, "claude"];
}

export interface ShellDiscoveryResult {
  shell: "zsh" | "bash";
  candidates: ShellDiscoveryCandidate[];
  rejections: {
    total: number;
    reasons: Partial<Record<ShellDiscoveryRejectionReason, number>>;
  };
  toml: string;
}

export interface ShellAliasRunResult {
  code: number;
  stdout: string;
  stderr?: string;
}

export type ShellAliasRunner = (
  argv: string[],
  options: { env: Record<string, string | undefined> },
) => Promise<ShellAliasRunResult>;

export interface ShellDiscoveryDependencies {
  runner?: ShellAliasRunner;
  env?: Record<string, string | undefined>;
  home?: string;
  configPath?: string;
}

const REJECTION_ORDER: ShellDiscoveryRejectionReason[] = [
  "not_candidate",
  "complex_command",
  "invalid_instance",
  "invalid_path",
  "projects_unavailable",
  "already_detected",
  "duplicate_config_dir",
  "instance_collision",
];

export const SHELL_DISCOVERY_REASON_LABELS: Record<ShellDiscoveryRejectionReason, string> = {
  not_candidate: "not a supported Claude alias",
  complex_command: "complex or unsafe command",
  invalid_instance: "invalid instance name",
  invalid_path: "non-absolute or unsafe config path",
  projects_unavailable: "projects directory missing or unreadable",
  already_detected: "already covered by .claude store discovery",
  duplicate_config_dir: "duplicate config directory",
  instance_collision: "instance name collision",
};

async function defaultRunner(
  argv: string[],
  options: { env: Record<string, string | undefined> },
): Promise<ShellAliasRunResult> {
  const process = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env,
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function validateShell(shell: string | undefined): { path: string; name: "zsh" | "bash" } {
  if (!shell) throw new CliError("shell alias discovery needs --shell or an absolute $SHELL", 1, "shell_discovery");
  if (!isAbsolute(shell)) throw new CliError("--shell must be an absolute path", 1, "shell_discovery");
  const name = basename(shell);
  if (name !== "zsh" && name !== "bash")
    throw new CliError("shell alias discovery supports only zsh or bash", 1, "shell_discovery");
  try {
    if (!statSync(shell).isFile()) throw new Error("not a file");
    accessSync(shell, constants.X_OK);
  } catch {
    throw new CliError("--shell must name an existing executable file", 1, "shell_discovery");
  }
  return { path: shell, name };
}

/**
 * Decode shell words without evaluation. This deliberately supports only
 * ordinary quotes and backslash escaping; operators, comments, and expansion
 * syntax are rejected rather than interpreted.
 */
function shellWords(input: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "single" | "double" | undefined;

  const finish = () => {
    if (!started) return;
    words.push(word);
    word = "";
    started = false;
  };

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    const code = char.charCodeAt(0);
    if (code < 0x20 && char !== " " && char !== "\t") return undefined;
    if (code === 0x7f) return undefined;

    if (quote === "single") {
      if (char === "'") quote = undefined;
      else word += char;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
      } else if (char === "\\") {
        const next = input[++index];
        if (next === undefined || next === "\n" || next === "\r") return undefined;
        word += next;
      } else {
        word += char;
      }
      started = true;
      continue;
    }

    if (char === " " || char === "\t") {
      finish();
      continue;
    }
    if (char === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (char === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (char === "\\") {
      const next = input[++index];
      if (next === undefined || next === "\n" || next === "\r") return undefined;
      word += next;
      started = true;
      continue;
    }
    if (";&|<>()#".includes(char) || char === "$" || char === "`") return undefined;
    word += char;
    started = true;
  }

  if (quote) return undefined;
  finish();
  return words;
}

function parseAliasLine(
  line: string,
): { alias: string; path: string } | { reason: ShellDiscoveryRejectionReason } {
  if (!line || /[\u0000-\u001f\u007f]/.test(line.replaceAll("\t", ""))) return { reason: "complex_command" };
  const declaration = /^(?:alias[ \t]+)?([^= \t]+)=(.+)$/.exec(line.trim());
  if (!declaration) return { reason: "not_candidate" };

  const alias = declaration[1]!;
  const encoded = declaration[2]!.trim();
  if (!(encoded.startsWith("'") || encoded.startsWith('"'))) return { reason: "complex_command" };
  const outer = shellWords(encoded);
  if (!outer || outer.length !== 1) return { reason: "complex_command" };

  const commandText = outer[0]!;
  const looksRelevant = commandText.includes("CLAUDE_CONFIG_DIR=") || commandText.split(/[ \t]+/).includes("claude");
  const command = shellWords(commandText);
  if (!command) return { reason: looksRelevant ? "complex_command" : "not_candidate" };

  let assignment: string | undefined;
  if (command.length === 2 && command[1] === "claude" && command[0]!.startsWith("CLAUDE_CONFIG_DIR=")) {
    assignment = command[0];
  } else if (
    command.length === 3 &&
    command[0] === "env" &&
    command[2] === "claude" &&
    command[1]!.startsWith("CLAUDE_CONFIG_DIR=")
  ) {
    assignment = command[1];
  } else {
    return { reason: looksRelevant ? "complex_command" : "not_candidate" };
  }

  const path = assignment.slice("CLAUDE_CONFIG_DIR=".length);
  if (!path) return { reason: "invalid_path" };
  const instance = alias.startsWith("claude-") ? alias.slice("claude-".length) : alias;
  if (!isValidInstanceName(instance)) return { reason: "invalid_instance" };
  return { alias: instance, path };
}

function safeAbsolutePath(value: string, home: string): string | undefined {
  if (
    /[\u0000-\u001f\u007f;$`|&<>()*?\[\]{}!^]/.test(value) ||
    (value.includes("~") && !value.startsWith("~/"))
  )
    return undefined;
  const expanded = value.startsWith("~/") ? join(home, value.slice(2)) : value;
  if (!isAbsolute(expanded)) return undefined;
  return normalize(expanded);
}

function canonicalCandidate(
  instance: string,
  path: string,
  home: string,
): ShellDiscoveryCandidate | ShellDiscoveryRejectionReason {
  const absolute = safeAbsolutePath(path, home);
  if (!absolute) return "invalid_path";
  try {
    const configDir = realpathSync(absolute);
    if (!statSync(configDir).isDirectory()) return "projects_unavailable";
    const store = join(configDir, "projects");
    if (!statSync(store).isDirectory()) return "projects_unavailable";
    accessSync(store, constants.R_OK);
    return {
      instance,
      harness: "claude",
      configDir,
      store,
      command: ["env", `CLAUDE_CONFIG_DIR=${configDir}`, "claude"],
    };
  } catch {
    return "projects_unavailable";
  }
}

function conventionallyDetectedConfigDirs(home: string): Set<string> {
  const detected = new Set<string>();
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory() || (entry.name !== ".claude" && !entry.name.startsWith(".claude-"))) continue;
      const configDir = join(home, entry.name);
      const projects = join(configDir, "projects");
      try {
        if (!statSync(projects).isDirectory()) continue;
        accessSync(projects, constants.R_OK);
        detected.add(realpathSync(configDir));
      } catch {
        // Unreadable or incomplete conventional stores are not considered detected.
      }
    }
  } catch {
    // A missing/unreadable home simply has no conventional stores to dedupe.
  }
  return detected;
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function shellDiscoveryToml(candidates: ShellDiscoveryCandidate[]): string {
  if (!candidates.length) return "";
  const instances = candidates.map(
    (candidate) =>
      `[instances.${tomlString(candidate.instance)}]\n` +
      `harness = "claude"\n` +
      `store = ${tomlString(candidate.store)}\n` +
      `command = [${candidate.command.map(tomlString).join(", ")}]`,
  );
  return (
    "# Generated from an explicit Sinter shell-alias discovery preview.\n" +
    "# Review these tables before manually merging them into an existing config.\n\n" +
    `${instances.join("\n\n")}\n\n` +
    "[profiles.default]\n" +
    "include_defaults = true\n" +
    `instances = [${candidates.map((candidate) => tomlString(candidate.instance)).join(", ")}]\n`
  );
}

function rejectionSummary(reasons: ShellDiscoveryRejectionReason[]): ShellDiscoveryResult["rejections"] {
  const counts: Partial<Record<ShellDiscoveryRejectionReason, number>> = {};
  for (const reason of REJECTION_ORDER) {
    const count = reasons.filter((candidate) => candidate === reason).length;
    if (count) counts[reason] = count;
  }
  return { total: reasons.length, reasons: counts };
}

/** Execute only the explicit, validated login-shell alias listing and parse it without evaluation. */
export async function discoverClaudeShellAliases(
  requestedShell: string | undefined,
  dependencies: ShellDiscoveryDependencies = {},
): Promise<ShellDiscoveryResult> {
  const environment = dependencies.env ?? process.env;
  const home = dependencies.home ?? environment.HOME;
  if (!home || !isAbsolute(home)) throw new CliError("shell alias discovery needs an absolute home directory", 1, "shell_discovery");
  const shell = validateShell(requestedShell ?? environment.SHELL);
  const result = await (dependencies.runner ?? defaultRunner)([shell.path, "-lic", "alias"], { env: environment });
  if (result.code !== 0)
    throw new CliError(`shell alias listing failed with exit code ${result.code}`, 1, "shell_discovery");

  const reasons: ShellDiscoveryRejectionReason[] = [];
  const parsed: ShellDiscoveryCandidate[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const alias = parseAliasLine(line);
    if ("reason" in alias) {
      reasons.push(alias.reason);
      continue;
    }
    const candidate = canonicalCandidate(alias.alias, alias.path, home);
    if (typeof candidate === "string") reasons.push(candidate);
    else parsed.push(candidate);
  }

  const conventional = conventionallyDetectedConfigDirs(home);
  const uniqueDirectories = new Set<string>();
  const deduplicated: ShellDiscoveryCandidate[] = [];
  for (const candidate of parsed) {
    if (conventional.has(candidate.configDir)) {
      reasons.push("already_detected");
      continue;
    }
    if (uniqueDirectories.has(candidate.configDir)) {
      reasons.push("duplicate_config_dir");
      continue;
    }
    uniqueDirectories.add(candidate.configDir);
    deduplicated.push(candidate);
  }

  const ids = new Map<string, number>();
  for (const candidate of deduplicated) ids.set(candidate.instance, (ids.get(candidate.instance) ?? 0) + 1);
  const candidates = deduplicated.filter((candidate) => {
    if (ids.get(candidate.instance) === 1) return true;
    reasons.push("instance_collision");
    return false;
  });

  return {
    shell: shell.name,
    candidates,
    rejections: rejectionSummary(reasons),
    toml: shellDiscoveryToml(candidates),
  };
}
