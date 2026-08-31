import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { VERSION } from "../src/main";
import { currentPublishGuardState, publishGuardFailure, type PublishGuardState } from "../scripts/prepublish-guard";

function releasable(overrides: Partial<PublishGuardState> = {}): PublishGuardState {
  return {
    approved: true,
    branch: "main",
    clean: true,
    tags: ["v0.5.0"],
    version: "0.5.0",
    runtimeVersion: "0.5.0",
    registry: "absent",
    ...overrides,
  };
}

describe("release publication guard", () => {
  test("keeps source, package, and development publication state aligned", () => {
    expect(VERSION).toBe(pkg.version);
    expect(pkg.version).toBe("0.5.0-dev.0");
    expect(pkg.private).toBe(true);
    expect(pkg.publishConfig).toEqual({ tag: "next" });
  });

  test("permits only an explicitly approved clean tagged stable main build absent from npm", () => {
    expect(publishGuardFailure(releasable())).toBeUndefined();
    expect(publishGuardFailure(releasable({ approved: false }))).toContain("SINTER_RELEASE_APPROVED=1");
    expect(publishGuardFailure(releasable({ branch: "feat/repository-binding-v2" }))).toContain("only from main");
    expect(publishGuardFailure(releasable({ clean: false }))).toContain("clean worktree");
    expect(publishGuardFailure(releasable({ runtimeVersion: "0.5.1" }))).toContain("versions do not match");
    expect(publishGuardFailure(releasable({ version: "0.5.0-dev.0", runtimeVersion: "0.5.0-dev.0", tags: ["v0.5.0-dev.0"] }))).toContain("development versions");
    expect(publishGuardFailure(releasable({ tags: [] }))).toContain("exact v0.5.0 tag");
    expect(publishGuardFailure(releasable({ registry: "present" }))).toContain("already published");
    expect(publishGuardFailure(releasable({ registry: "unavailable" }))).toContain("could not be verified");
  });

  test("collects branch, worktree, tag, approval, runtime, and registry state through the injected runner", async () => {
    const calls: string[][] = [];
    const state = await currentPublishGuardState({
      approved: true,
      async command(argv) {
        calls.push(argv);
        if (argv[0] === "npm") return { code: 1, stdout: "", stderr: "npm ERR! code E404" };
        if (argv[1] === "branch") return { code: 0, stdout: "main", stderr: "" };
        if (argv[1] === "status") return { code: 0, stdout: "", stderr: "" };
        if (argv[1] === "tag") return { code: 0, stdout: `v${pkg.version}`, stderr: "" };
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      },
    });
    expect(state).toEqual({
      approved: true,
      branch: "main",
      clean: true,
      tags: [`v${pkg.version}`],
      version: pkg.version,
      runtimeVersion: VERSION,
      registry: "absent",
    });
    expect(calls).toHaveLength(4);
  });
});
