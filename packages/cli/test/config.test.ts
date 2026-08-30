import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapDefaultConfig, inspectConfig, loadProfile, loadProfileByName } from "../src/config";

const dirs: string[] = [];

function configFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sinter-instance-config-"));
  dirs.push(dir);
  const path = join(dir, "config.toml");
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("named harness instances", () => {
  test("resolves a profile's selected instances with store and argv prefix", () => {
    const path = configFile(`
[instances.claude-personal]
harness = "claude"
store = "/tmp/claude-personal"
command = ["claude"]

[instances.claude-addvita]
harness = "claude"
store = "/tmp/claude-addvita"
command = ["env", "CLAUDE_CONFIG_DIR=/tmp/addvita", "claude"]

[profiles.all]
instances = ["claude-personal", "claude-addvita"]
`);
    expect(loadProfileByName("all", path)).toEqual({
      name: "all",
      configPath: path,
      stores: {},
      instances: [
        {
          id: "claude-personal",
          harness: "claude",
          store: "/tmp/claude-personal",
          command: ["claude"],
        },
        {
          id: "claude-addvita",
          harness: "claude",
          store: "/tmp/claude-addvita",
          command: ["env", "CLAUDE_CONFIG_DIR=/tmp/addvita", "claude"],
        },
      ],
    });
  });

  test("keeps legacy profile objects backward compatible", () => {
    const path = configFile(`[profiles.work.stores]\nclaude = "/tmp/claude"\n`);
    expect(loadProfileByName("work", path)).toEqual({
      name: "work",
      configPath: path,
      stores: { claude: "/tmp/claude" },
    });
  });

  test("allows named instances and legacy roots in separate profiles", () => {
    const path = configFile(`
[instances.work]
harness = "claude"
store = "/tmp/work"

[profiles.named]
instances = ["work"]

[profiles.legacy.stores]
codex = "/tmp/codex"
`);
    const summary = inspectConfig(path);
    expect(summary.profiles.map((profile) => profile.name)).toEqual(["legacy", "named"]);
    expect(summary.profiles[1]!.instances?.[0]).toMatchObject({ id: "work", harness: "claude" });
  });

  test("rejects unknown references, duplicate selections, and invalid commands", () => {
    const unknown = configFile(`[profiles.work]\ninstances = ["missing"]\n`);
    expect(() => loadProfileByName("work", unknown)).toThrow(/unknown instance: missing/);

    const duplicate = configFile(`
[instances.work]
harness = "claude"
store = "/tmp/work"
[profiles.work]
instances = ["work", "work"]
`);
    expect(() => loadProfileByName("work", duplicate)).toThrow(/duplicate instance/);

    const badCommand = configFile(`
[instances.work]
harness = "claude"
store = "/tmp/work"
command = []
[profiles.work]
instances = ["work"]
`);
    expect(() => loadProfileByName("work", badCommand)).toThrow(/command must be a non-empty array/);
  });

  test("rejects an empty profile rather than silently scanning defaults", () => {
    const path = configFile(`[profiles.work]\n`);
    expect(() => loadProfileByName("work", path)).toThrow(/needs instances/);
  });

  test("allows an include-defaults profile and selects default automatically", () => {
    const path = configFile(`[profiles.default]\ninclude_defaults = true\n`);
    expect(loadProfile(["scan", "--config", path])).toEqual({
      name: "default",
      configPath: path,
      stores: {},
      includeDefaults: true,
    });
  });

  test("rejects a non-boolean include_defaults value", () => {
    const path = configFile(`[profiles.default]\ninclude_defaults = "yes"\n`);
    expect(() => loadProfileByName("default", path)).toThrow(/include_defaults must be true or false/);
  });
});

describe("automatic multi-instance bootstrap", () => {
  test("creates a private default config for multiple Claude stores", () => {
    const home = mkdtempSync(join(tmpdir(), "sinter-bootstrap-home-"));
    dirs.push(home);
    for (const directory of [".claude", ".claude-addvita", ".claude-kimi"])
      mkdirSync(join(home, directory, "projects"), { recursive: true });
    const path = join(home, ".config", "sinter", "config.toml");

    expect(bootstrapDefaultConfig(path, home)).toEqual({
      created: true,
      configPath: path,
      instances: ["personal", "addvita", "kimi"],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain(`command = ["env", "CLAUDE_CONFIG_DIR=${home}/.claude-addvita", "claude"]`);
    expect(loadProfile(["scan", "--config", path])).toMatchObject({
      name: "default",
      includeDefaults: true,
      instances: [
        { id: "personal", harness: "claude" },
        { id: "addvita", harness: "claude" },
        { id: "kimi", harness: "claude" },
      ],
    });
  });

  test("does not create for one store or overwrite an existing file", () => {
    const home = mkdtempSync(join(tmpdir(), "sinter-bootstrap-safe-"));
    dirs.push(home);
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    const path = join(home, "config.toml");
    expect(bootstrapDefaultConfig(path, home).created).toBe(false);

    mkdirSync(join(home, ".claude-work", "projects"), { recursive: true });
    writeFileSync(path, "# user-owned\n");
    expect(bootstrapDefaultConfig(path, home).created).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("# user-owned\n");
  });
});
