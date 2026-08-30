import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterRegistry } from "../src/adapters";
import { main, makeCtx, run, VERSION } from "../src/main";
import {
  UPDATE_CHECK_INTERVAL_MS,
  UpdateCommandError,
  compareVersions,
  detectPackageManagerFromEntrypoint,
  isNewerVersion,
  isStrictSemver,
  maybePromptForUpdate,
  runUpdate,
  type UpdateDependencies,
  type UpdateRequest,
} from "../src/update";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function request(overrides: Partial<UpdateRequest> = {}): UpdateRequest {
  return {
    currentVersion: "1.2.3",
    check: false,
    force: false,
    json: false,
    ...overrides,
  };
}

describe("strict semantic versions", () => {
  test("compares stable, prerelease, and build versions with SemVer precedence", () => {
    expect(isNewerVersion("0.1.5", "0.1.4")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0-beta.11")).toBe(true);
    expect(compareVersions("1.0.0-beta.11", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0+build.2", "1.0.0+build.1")).toBe(0);
  });

  test("rejects loose, malformed, and non-canonical versions", () => {
    for (const version of ["v1.2.3", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "latest", " 1.2.3"])
      expect(isStrictSemver(version)).toBe(false);
    expect(isStrictSemver("1.2.3-rc.1+build.5")).toBe(true);
    expect(compareVersions("latest", "1.2.3")).toBeUndefined();
  });
});

describe("startup update notification", () => {
  test("does nothing outside an interactive terminal or for the explicit update command", async () => {
    let fetched = 0;
    const options = { fetchLatest: async () => (fetched++, "1.2.4") };
    expect(await maybePromptForUpdate("1.2.3", { ...options, interactive: false })).toBe(false);
    expect(await maybePromptForUpdate("1.2.3", { ...options, interactive: true, argv: ["update"] })).toBe(false);
    expect(fetched).toBe(0);
  });

  test("only prints an instruction and never installs from another command", async () => {
    const output: string[] = [];
    let written: unknown;
    const now = UPDATE_CHECK_INTERVAL_MS + 100;
    expect(await maybePromptForUpdate("1.2.3", {
      interactive: true,
      disabled: false,
      now,
      readCache: () => ({ checkedAt: 0, latest: "1.2.3" }),
      writeCache: (_path, value) => void (written = value),
      fetchLatest: async () => "1.2.4",
      out: (message) => output.push(message),
    })).toBe(false);
    expect(output).toEqual(["Sinter 1.2.4 is available (current 1.2.3). Run: sinter update"]);
    expect(written).toEqual({ checkedAt: now, latest: "1.2.4", promptedAt: now });
  });

  test("silently ignores registry errors and malformed cached or remote versions", async () => {
    let output = "";
    expect(await maybePromptForUpdate("1.2.3", {
      interactive: true,
      disabled: false,
      readCache: () => ({ checkedAt: Date.now(), latest: "latest" }),
      fetchLatest: async () => "v1.2.4",
      out: (message) => void (output = message),
    })).toBe(false);
    expect(output).toBe("");
  });
});

describe("explicit update operation", () => {
  test("--check reports an available exact version without resolving or running an installer", async () => {
    let resolved = false;
    let ran = false;
    const result = await runUpdate(request({ check: true, packageManager: "bun" }), {
      fetchLatest: async () => "1.3.0",
      resolveCliEntrypoint: () => (resolved = true, undefined),
      runProcess: async () => (ran = true, { exitCode: 0 }),
    });
    expect(result).toMatchObject({
      schema: "sinter.update.v1",
      status: "update-available",
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      check: true,
      installed: false,
      packageManager: null,
    });
    expect(resolved).toBe(false);
    expect(ran).toBe(false);
  });

  test("equal versions are up to date and never install, even with --force", async () => {
    let ran = false;
    const result = await runUpdate(request({ force: true, packageManager: "npm" }), {
      fetchLatest: async () => "1.2.3",
      runProcess: async () => (ran = true, { exitCode: 0 }),
    });
    expect(result.status).toBe("up-to-date");
    expect(result.installed).toBe(false);
    expect(ran).toBe(false);
  });

  test("a newer local build is not downgraded by default", async () => {
    let ran = false;
    const result = await runUpdate(request({ currentVersion: "2.0.0", packageManager: "npm" }), {
      fetchLatest: async () => "1.9.9",
      runProcess: async () => (ran = true, { exitCode: 0 }),
    });
    expect(result.status).toBe("newer-local");
    expect(result.installed).toBe(false);
    expect(ran).toBe(false);
  });

  test("--force permits an exact published downgrade", async () => {
    const calls: readonly string[][] = [];
    const result = await runUpdate(request({ currentVersion: "2.0.0", force: true, packageManager: "npm" }), {
      fetchLatest: async () => "1.9.9",
      runProcess: async (argv) => ((calls as string[][]).push([...argv]), { exitCode: 0 }),
    });
    expect(calls).toEqual([["npm", "install", "--global", "@jensenloke/sinter@1.9.9"]]);
    expect(result).toMatchObject({ status: "updated", installed: true, forced: true, latestVersion: "1.9.9" });
  });

  test.each([
    ["bun", ["bun", "add", "--global", "@jensenloke/sinter@1.3.0"]],
    ["npm", ["npm", "install", "--global", "@jensenloke/sinter@1.3.0"]],
  ] as const)("uses exact argv with no shell interpolation for %s", async (packageManager, expected) => {
    const calls: string[][] = [];
    await runUpdate(request({ packageManager }), {
      fetchLatest: async () => "1.3.0",
      resolveCliEntrypoint: () => undefined,
      runProcess: async (argv) => (calls.push([...argv]), { exitCode: 0 }),
    });
    expect(calls).toEqual([[...expected]]);
    expect(calls[0]!.join(" ")).not.toContain("latest");
  });

  test("detects bun and npm only from clear resolved global layouts", () => {
    expect(detectPackageManagerFromEntrypoint("/Users/me/.bun/install/global/node_modules/@jensenloke/sinter/dist/main.js", "/Users/me")).toBe("bun");
    expect(detectPackageManagerFromEntrypoint("/Users/me/node_modules/@jensenloke/sinter/dist/main.js", "/Users/me")).toBe("bun");
    expect(detectPackageManagerFromEntrypoint("/opt/homebrew/lib/node_modules/@jensenloke/sinter/dist/main.js", "/Users/me")).toBe("npm");
    expect(detectPackageManagerFromEntrypoint("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@jensenloke\\sinter\\dist\\main.js", "C:\\Users\\me")).toBe("npm");
    expect(detectPackageManagerFromEntrypoint("/work/sinter/packages/cli/src/main.ts", "/Users/me")).toBeUndefined();
    expect(detectPackageManagerFromEntrypoint("/work/node_modules/@jensenloke/sinter/dist/main.js", "/Users/me")).toBeUndefined();
  });

  test("refuses ambiguous or workspace layouts and asks for an explicit package manager", async () => {
    const error = await runUpdate(request(), {
      fetchLatest: async () => "1.3.0",
      resolveCliEntrypoint: () => "/work/sinter/packages/cli/src/main.ts",
    }).catch((value) => value);
    expect(error).toBeInstanceOf(UpdateCommandError);
    expect(error).toMatchObject({ code: 2, kind: "resolution" });
    expect(error.message).toContain("Pass --package-manager bun or --package-manager npm");
  });

  const registryFailures: Array<[string, () => Promise<unknown>]> = [
    ["malformed string", async () => "latest"],
    ["non-string", async () => ({ version: "1.3.0" })],
    ["request error", async () => { throw new Error("offline"); }],
  ];

  test.each(registryFailures)("reports a stable registry error for %s", async (_name, fetchLatest) => {
    const error = await runUpdate(request({ check: true }), { fetchLatest }).catch((value) => value);
    expect(error).toBeInstanceOf(UpdateCommandError);
    expect(error).toMatchObject({ code: 1, kind: "registry" });
    expect(error.message).toContain("npm registry");
  });

  test("reports installer exceptions and nonzero exits", async () => {
    const thrown = await runUpdate(request({ packageManager: "bun" }), {
      fetchLatest: async () => "1.3.0",
      runProcess: async () => { throw new Error("spawn denied"); },
    }).catch((value) => value);
    expect(thrown).toMatchObject({ code: 1, kind: "installation" });
    expect(thrown.message).toContain("spawn denied");

    const nonzero = await runUpdate(request({ packageManager: "npm" }), {
      fetchLatest: async () => "1.3.0",
      runProcess: async () => ({ exitCode: 7 }),
    }).catch((value) => value);
    expect(nonzero).toMatchObject({ code: 1, kind: "installation" });
    expect(nonzero.message).toContain("exit 7");
  });

  test("verifies the exact resolved executable and fails on a post-install mismatch", async () => {
    const entrypoint = "/opt/homebrew/lib/node_modules/@jensenloke/sinter/dist/main.js";
    const calls: string[][] = [];
    const error = await runUpdate(request(), {
      fetchLatest: async () => "1.3.0",
      resolveCliEntrypoint: () => entrypoint,
      runProcess: async (argv) => {
        calls.push([...argv]);
        return calls.length === 1 ? { exitCode: 0 } : { exitCode: 0, stdout: "1.2.3\n" };
      },
    }).catch((value) => value);
    expect(calls).toEqual([
      ["npm", "install", "--global", "@jensenloke/sinter@1.3.0"],
      [process.execPath, entrypoint, "--version"],
    ]);
    expect(error).toMatchObject({ code: 1, kind: "verification" });
    expect(error.message).toContain("reports 1.2.3");
  });

  test("records successful executable verification", async () => {
    const entrypoint = "/Users/me/.bun/install/global/node_modules/@jensenloke/sinter/dist/main.js";
    let calls = 0;
    const result = await runUpdate(request(), {
      fetchLatest: async () => "1.3.0",
      resolveCliEntrypoint: () => entrypoint,
      runProcess: async () => (++calls === 1 ? { exitCode: 0 } : { exitCode: 0, stdout: "1.3.0\n" }),
    });
    expect(result).toMatchObject({ packageManager: "bun", verifiedVersion: "1.3.0", installed: true });
  });
});

describe("update command dispatch", () => {
  function commandHarness(update: UpdateDependencies, version = "1.2.3") {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let scans = 0;
    let ledgerTouches = 0;
    const ctx = makeCtx({
      version,
      update,
      out: (message) => stdout.push(message),
      err: (message) => stderr.push(message),
      registry: { load: async () => (scans++, []) } as unknown as AdapterRegistry,
      ledger: () => { ledgerTouches++; throw new Error("ledger must not be touched"); },
      autoScan: true,
    });
    return { ctx, stdout, stderr, scans: () => scans, ledgerTouches: () => ledgerTouches };
  }

  test("renders update help without querying, scanning, or touching the ledger", async () => {
    let fetched = false;
    const harness = commandHarness({ fetchLatest: async () => (fetched = true, "1.3.0") });
    expect(await run(["update", "--help"], harness.ctx)).toBe(0);
    expect(harness.stdout.join("\n")).toContain("usage: sinter update");
    expect(harness.stdout.join("\n")).toContain("--package-manager bun|npm");
    expect(fetched).toBe(false);
    expect(harness.scans()).toBe(0);
    expect(harness.ledgerTouches()).toBe(0);
  });

  test("emits human and versioned JSON results without scanning or touching config/ledger state", async () => {
    const human = commandHarness({ fetchLatest: async () => "1.3.0" });
    expect(await run(["update", "--check"], human.ctx)).toBe(0);
    expect(human.stdout.join("\n")).toContain("no install performed");
    expect(human.scans()).toBe(0);
    expect(human.ledgerTouches()).toBe(0);

    const json = commandHarness({ fetchLatest: async () => "1.2.3" });
    expect(await run(["update", "--check", "--json"], json.ctx)).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      schema: "sinter.update.v1",
      ok: true,
      status: "up-to-date",
      package: "@jensenloke/sinter",
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      targetVersion: "1.2.3",
      packageManager: null,
      check: true,
      forced: false,
      installed: false,
      verifiedVersion: null,
    });
    expect(json.stderr).toEqual([]);
  });

  test("uses versioned JSON errors with stable update kinds", async () => {
    const harness = commandHarness({ fetchLatest: async () => "latest" });
    expect(await run(["update", "--check", "--json"], harness.ctx)).toBe(1);
    expect(JSON.parse(harness.stderr[0]!)).toMatchObject({
      schema: "sinter.error.v1",
      ok: false,
      error: { code: 1, kind: "registry" },
    });
    expect(harness.stdout).toEqual([]);
  });

  test("validates package managers and positional arguments", async () => {
    const harness = commandHarness({ fetchLatest: async () => "1.3.0" });
    expect(await run(["update", "--package-manager", "pnpm"], harness.ctx)).toBe(1);
    expect(harness.stderr.join("\n")).toContain("expected bun or npm");
  });

  test("main does not create profile configuration for update", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sinter-update-no-config-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.toml");
    const previousConfig = process.env.SINTER_CONFIG;
    process.env.SINTER_CONFIG = configPath;
    const stdout: string[] = [];
    try {
      expect(await main(["update", "--check"], {
        out: (message) => stdout.push(message),
        err: () => {},
        update: { fetchLatest: async () => VERSION },
      })).toBe(0);
      expect(existsSync(configPath)).toBe(false);
      expect(stdout.join("\n")).toContain("up to date");
    } finally {
      if (previousConfig === undefined) delete process.env.SINTER_CONFIG;
      else process.env.SINTER_CONFIG = previousConfig;
    }
  });
});
