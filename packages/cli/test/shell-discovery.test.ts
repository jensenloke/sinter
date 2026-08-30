import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticAdapterRegistry } from "../src/adapters";
import type { Ctx } from "../src/commands";
import { inspectConfig } from "../src/config";
import { palette } from "../src/format";
import { main, run } from "../src/main";
import {
  discoverClaudeShellAliases,
  SHELL_DISCOVERY_SCHEMA,
  type ShellAliasRunner,
  type ShellDiscoveryDependencies,
} from "../src/shell-discovery";

const temporaryDirectories: string[] = [];

interface Fixture {
  root: string;
  home: string;
  shell: string;
  configPath: string;
}

function fixture(shellName: "zsh" | "bash" = "zsh"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "sinter-shell-discovery-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const shell = join(bin, shellName);
  writeFileSync(shell, "#!/bin/sh\nexit 0\n");
  chmodSync(shell, 0o700);
  return { root, home, shell, configPath: join(root, "config", "config.toml") };
}

function addConfigDir(path: string): string {
  mkdirSync(join(path, "projects"), { recursive: true });
  return path;
}

function quoteAliasValue(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function dependencies(
  target: Fixture,
  stdout: string,
  calls: string[][] = [],
  result: { code?: number; stderr?: string } = {},
): ShellDiscoveryDependencies {
  const runner: ShellAliasRunner = async (argv) => {
    calls.push([...argv]);
    return { code: result.code ?? 0, stdout, stderr: result.stderr ?? "" };
  };
  return {
    runner,
    env: { HOME: target.home, SHELL: target.shell, PATH: "/usr/bin:/bin" },
    home: target.home,
    configPath: target.configPath,
  };
}

function commandContext(discovery: ShellDiscoveryDependencies, interactive = false) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let ledgerTouches = 0;
  let scans = 0;
  const registry = new StaticAdapterRegistry([]);
  const originalLoad = registry.load.bind(registry);
  registry.load = async () => {
    scans++;
    return originalLoad();
  };
  const ctx: Ctx = {
    registry,
    ledger: () => {
      ledgerTouches++;
      throw new Error("ledger must stay closed");
    },
    out: (message) => stdout.push(message),
    err: (message) => stderr.push(message),
    pal: palette(false),
    width: 100,
    now: Date.now(),
    writeFile: async () => {
      throw new Error("generic writer must not be used");
    },
    readFile: async () => {
      throw new Error("reader must not be used");
    },
    autoScan: true,
    interactive,
    shellDiscovery: discovery,
  };
  return { ctx, stdout, stderr, scans: () => scans, ledgerTouches: () => ledgerTouches };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("safe Claude shell-alias parsing", () => {
  test.each(["zsh", "bash"] as const)("accepts conservative %s output and spawns exact argv", async (shellName) => {
    const target = fixture(shellName);
    const spaced = addConfigDir(join(target.root, "Claude Client Files"));
    const tilde = addConfigDir(join(target.home, "custom-team"));
    const canonicalSpaced = realpathSync(spaced);
    const canonicalTilde = realpathSync(tilde);
    const calls: string[][] = [];
    const prefix = shellName === "bash" ? "alias " : "";
    const output = [
      `${prefix}claude-client=${quoteAliasValue(`CLAUDE_CONFIG_DIR=\"${spaced}\" claude`)}`,
      `${prefix}claude-team=${quoteAliasValue("env CLAUDE_CONFIG_DIR=~/custom-team claude")}`,
    ].join("\n");

    const result = await discoverClaudeShellAliases(undefined, dependencies(target, output, calls));
    expect(calls).toEqual([[target.shell, "-lic", "alias"]]);
    expect(result.shell).toBe(shellName);
    expect(result.candidates).toEqual([
      {
        instance: "client",
        harness: "claude",
        configDir: canonicalSpaced,
        store: join(canonicalSpaced, "projects"),
        command: ["env", `CLAUDE_CONFIG_DIR=${canonicalSpaced}`, "claude"],
      },
      {
        instance: "team",
        harness: "claude",
        configDir: canonicalTilde,
        store: join(canonicalTilde, "projects"),
        command: ["env", `CLAUDE_CONFIG_DIR=${canonicalTilde}`, "claude"],
      },
    ]);
    expect(result.toml).toContain(`[instances."client"]`);
    expect(result.toml).toContain("include_defaults = true");
  });

  test("accepts ordinary nested single quoting around a path with spaces", async () => {
    const target = fixture("bash");
    const configDir = addConfigDir(join(target.root, "single quoted"));
    const value = `env CLAUDE_CONFIG_DIR='${configDir}' claude`;
    const result = await discoverClaudeShellAliases(target.shell, dependencies(target, `alias custom=${quoteAliasValue(value)}`));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.instance).toBe("custom");
    expect(result.candidates[0]?.configDir).toBe(realpathSync(configDir));
  });

  test("rejects malicious, expanded, and complex aliases without leaking them", async () => {
    const target = fixture();
    const configDir = addConfigDir(join(target.root, "candidate"));
    const marker = "DO_NOT_LEAK_PRIVATE_ALIAS";
    const commands = [
      `CLAUDE_CONFIG_DIR=${configDir} claude --danger`,
      `CLAUDE_CONFIG_DIR=${configDir} claude; touch ${marker}`,
      `CLAUDE_CONFIG_DIR=${configDir} claude && echo ${marker}`,
      `CLAUDE_CONFIG_DIR=${configDir} claude | cat`,
      `CLAUDE_CONFIG_DIR=${configDir} claude > ${marker}`,
      `CLAUDE_CONFIG_DIR=$HOME/custom claude`,
      `CLAUDE_CONFIG_DIR=$(echo ${configDir}) claude`,
      `env EXTRA=1 CLAUDE_CONFIG_DIR=${configDir} claude`,
      `echo ${marker}`,
    ];
    const output = commands.map((command, index) => `claude-bad${index}=${quoteAliasValue(command)}`).join("\n");
    const result = await discoverClaudeShellAliases(target.shell, dependencies(target, output));
    expect(result.candidates).toEqual([]);
    expect(result.rejections.total).toBe(commands.length);
    expect(result.rejections.reasons.complex_command).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("touch");
  });

  test("rejects relative, unsupported, missing, and non-executable shells before running", async () => {
    const target = fixture();
    let runs = 0;
    const deps = dependencies(target, "");
    deps.runner = async () => {
      runs++;
      return { code: 0, stdout: "" };
    };
    await expect(discoverClaudeShellAliases("zsh", deps)).rejects.toThrow("absolute path");

    const fish = join(target.root, "bin", "fish");
    writeFileSync(fish, "#!/bin/sh\n");
    chmodSync(fish, 0o700);
    await expect(discoverClaudeShellAliases(fish, deps)).rejects.toThrow("only zsh or bash");

    const missing = join(target.root, "bin", "bash");
    await expect(discoverClaudeShellAliases(missing, deps)).rejects.toThrow("existing executable");
    writeFileSync(missing, "#!/bin/sh\n");
    chmodSync(missing, 0o600);
    await expect(discoverClaudeShellAliases(missing, deps)).rejects.toThrow("existing executable");
    expect(runs).toBe(0);
  });

  test("deduplicates config dirs and conventional stores, then rejects name collisions", async () => {
    const target = fixture();
    const conventional = addConfigDir(join(target.home, ".claude-work"));
    const shared = addConfigDir(join(target.root, "shared"));
    const collisionOne = addConfigDir(join(target.root, "collision-one"));
    const collisionTwo = addConfigDir(join(target.root, "collision-two"));
    const output = [
      `claude-existing=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${conventional} claude`)}`,
      `claude-shared=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${shared} claude`)}`,
      `shared-copy=${quoteAliasValue(`env CLAUDE_CONFIG_DIR=${shared} claude`)}`,
      `claude-team=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${collisionOne} claude`)}`,
      `team=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${collisionTwo} claude`)}`,
    ].join("\n");
    const result = await discoverClaudeShellAliases(target.shell, dependencies(target, output));
    expect(result.candidates.map((candidate) => candidate.instance)).toEqual(["shared"]);
    expect(result.rejections.reasons.already_detected).toBe(1);
    expect(result.rejections.reasons.duplicate_config_dir).toBe(1);
    expect(result.rejections.reasons.instance_collision).toBe(2);
  });

  test("rejects invalid instance names, controls, and multiline values", async () => {
    const target = fixture();
    const configDir = addConfigDir(join(target.root, "valid-path"));
    const output = [
      `claude-bad/name=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${configDir} claude`)}`,
      `claude-control=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${configDir}\u001b claude`)}`,
      `claude-lines='CLAUDE_CONFIG_DIR=${configDir}\nother claude'`,
    ].join("\n");
    const result = await discoverClaudeShellAliases(target.shell, dependencies(target, output));
    expect(result.candidates).toEqual([]);
    expect(result.rejections.reasons.invalid_instance).toBe(1);
    expect(result.rejections.reasons.complex_command).toBeGreaterThanOrEqual(2);
  });

  test("requires an existing readable projects directory without reading session files", async () => {
    const target = fixture();
    const missingProjects = join(target.root, "missing-projects");
    mkdirSync(missingProjects);
    const output = `claude-missing=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${missingProjects} claude`)}`;
    const result = await discoverClaudeShellAliases(target.shell, dependencies(target, output));
    expect(result.candidates).toEqual([]);
    expect(result.rejections.reasons.projects_unavailable).toBe(1);
  });
});

describe("config discover-shell command", () => {
  test("documents the exact opt-in contract while help and examples stay side-effect free", async () => {
    const target = fixture();
    let shellRuns = 0;
    const deps = dependencies(target, "");
    deps.runner = async () => {
      shellRuns++;
      return { code: 0, stdout: "" };
    };
    const harness = commandContext(deps);
    expect(await run(["config", "--help"], harness.ctx)).toBe(0);
    expect(harness.stdout.join("\n")).toContain("config discover-shell [--shell <absolute-path>] [--write] [--yes] [--json]");
    expect(harness.stdout.join("\n")).toContain("explicit and opt-in");
    harness.stdout.length = 0;
    expect(await run(["config", "example"], harness.ctx)).toBe(0);
    expect(harness.stdout.join("\n")).toContain("[profiles.default]");
    expect(shellRuns).toBe(0);
    expect(harness.scans()).toBe(0);
    expect(harness.ledgerTouches()).toBe(0);
    expect(existsSync(target.configPath)).toBe(false);
  });

  test("previews with a startup-file warning, no raw output, no writes, scans, or ledger", async () => {
    const target = fixture();
    const configDir = addConfigDir(join(target.root, "private-config"));
    const rawSecret = "UNRELATED_PRIVATE_ALIAS_VALUE";
    const output = [
      `claude-client=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${configDir} claude`)}`,
      `unrelated=${quoteAliasValue(`echo ${rawSecret}`)}`,
    ].join("\n");
    const harness = commandContext(dependencies(target, output, [], { stderr: `startup ${rawSecret}` }));

    expect(await run(["config", "discover-shell"], harness.ctx)).toBe(0);
    expect(harness.stderr.join("\n")).toContain("executes zsh/bash startup files");
    expect(harness.stdout.join("\n")).toContain("instance: client");
    expect(harness.stdout.join("\n")).toContain("mergeable TOML");
    expect(harness.stdout.join("\n") + harness.stderr.join("\n")).not.toContain(rawSecret);
    expect(existsSync(target.configPath)).toBe(false);
    expect(harness.scans()).toBe(0);
    expect(harness.ledgerTouches()).toBe(0);
  });

  test("emits a versioned JSON preview containing only accepted candidates and safe counts", async () => {
    const target = fixture("bash");
    const configDir = addConfigDir(join(target.root, "json-config"));
    const harness = commandContext(
      dependencies(target, [
        `alias claude-json=${quoteAliasValue(`env CLAUDE_CONFIG_DIR=${configDir} claude`)}`,
        `alias private=${quoteAliasValue("echo NEVER_PRINT_THIS")}`,
      ].join("\n")),
    );
    expect(await run(["config", "discover-shell", "--json"], harness.ctx)).toBe(0);
    const report = JSON.parse(harness.stdout[0]!);
    expect(report).toMatchObject({
      schema: SHELL_DISCOVERY_SCHEMA,
      ok: true,
      status: "preview",
      shell: "bash",
      candidates: [{ instance: "json", harness: "claude" }],
      rejections: { total: 1, reasons: { not_candidate: 1 } },
    });
    expect(harness.stdout.join("\n")).not.toContain("NEVER_PRINT_THIS");
    expect(harness.stderr).toEqual([]);
  });

  test("creates a valid owner-only config only with explicit non-interactive consent", async () => {
    const target = fixture();
    const configDir = addConfigDir(join(target.root, "write-config"));
    const output = `claude-write=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${configDir} claude`)}`;
    const harness = commandContext(dependencies(target, output));

    expect(await run(["config", "discover-shell", "--write", "--yes", "--json"], harness.ctx)).toBe(0);
    expect(statSync(target.configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(harness.stdout[0]!)).toMatchObject({ schema: SHELL_DISCOVERY_SCHEMA, ok: true, status: "created" });
    expect(inspectConfig(target.configPath).profiles[0]).toMatchObject({
      name: "default",
      includeDefaults: true,
      instances: [{ id: "write", harness: "claude", store: join(realpathSync(configDir), "projects") }],
    });
  });

  test("uses injected interactive confirmation when --yes is omitted", async () => {
    const target = fixture();
    const configDir = addConfigDir(join(target.root, "interactive-config"));
    const harness = commandContext(
      dependencies(target, `claude-interactive=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${configDir} claude`)}`),
      true,
    );
    let question = "";
    harness.ctx.confirm = async (value) => {
      question = value;
      return true;
    };
    expect(await run(["config", "discover-shell", "--write"], harness.ctx)).toBe(0);
    expect(question).toContain("owner-only config");
    expect(existsSync(target.configPath)).toBe(true);
  });

  test("refuses an existing config and returns a manual merge preview without overwriting", async () => {
    const target = fixture();
    const configDir = addConfigDir(join(target.root, "existing-config-candidate"));
    mkdirSync(join(target.root, "config"), { recursive: true });
    writeFileSync(target.configPath, "# user-owned config\n", { mode: 0o640 });
    const before = readFileSync(target.configPath, "utf8");
    const harness = commandContext(
      dependencies(target, `claude-client=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${configDir} claude`)}`),
    );

    expect(await run(["config", "discover-shell", "--write", "--yes", "--json"], harness.ctx)).toBe(1);
    expect(readFileSync(target.configPath, "utf8")).toBe(before);
    expect(statSync(target.configPath).mode & 0o777).toBe(0o640);
    const report = JSON.parse(harness.stdout[0]!);
    expect(report).toMatchObject({ schema: SHELL_DISCOVERY_SCHEMA, ok: false, status: "manual_merge" });
    expect(report.manualMerge).toContain("will not overwrite");
    expect(harness.stderr).toEqual([]);
  });

  test("requires --yes for agent mode and emits a safe versioned error envelope", async () => {
    const target = fixture();
    const configDir = addConfigDir(join(target.root, "needs-consent"));
    const harness = commandContext(
      dependencies(target, `claude-consent=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${configDir} claude`)}`),
    );
    expect(await run(["config", "discover-shell", "--write", "--json"], harness.ctx)).toBe(1);
    expect(existsSync(target.configPath)).toBe(false);
    expect(JSON.parse(harness.stderr[0]!)).toMatchObject({
      schema: "sinter.error.v1",
      ok: false,
      error: { code: 1, kind: "shell_discovery" },
    });
  });

  test("does not leak startup stderr when alias listing fails", async () => {
    const target = fixture();
    const secret = "PRIVATE_STARTUP_FAILURE";
    const harness = commandContext(dependencies(target, "", [], { code: 7, stderr: secret }));
    expect(await run(["config", "discover-shell", "--json"], harness.ctx)).toBe(1);
    const error = JSON.parse(harness.stderr[0]!);
    expect(error).toMatchObject({ schema: "sinter.error.v1", error: { kind: "shell_discovery" } });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  test("main preview bypasses automatic config bootstrap and normal scan never runs discovery", async () => {
    const target = fixture();
    addConfigDir(join(target.home, ".claude"));
    addConfigDir(join(target.home, ".claude-work"));
    const custom = addConfigDir(join(target.root, "main-custom"));
    let shellRuns = 0;
    const deps = dependencies(target, `claude-main=${quoteAliasValue(`CLAUDE_CONFIG_DIR=${custom} claude`)}`);
    const originalRunner = deps.runner!;
    deps.runner = async (argv, options) => {
      shellRuns++;
      return originalRunner(argv, options);
    };
    const harness = commandContext(deps);
    const previousUpdate = process.env.SINTER_NO_UPDATE_CHECK;
    process.env.SINTER_NO_UPDATE_CHECK = "1";
    try {
      expect(await main(["config", "discover-shell", "--json"], {
        ...harness.ctx,
        shellDiscovery: deps,
      })).toBe(0);
      expect(existsSync(target.configPath)).toBe(false);
      expect(shellRuns).toBe(1);

      expect(await run(["scan"], harness.ctx)).toBe(1);
      expect(shellRuns).toBe(1);
    } finally {
      if (previousUpdate === undefined) delete process.env.SINTER_NO_UPDATE_CHECK;
      else process.env.SINTER_NO_UPDATE_CHECK = previousUpdate;
    }
  });
});
