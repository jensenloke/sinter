import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SifSession } from "@sinter/core";
import { Ledger } from "@sinter/ledger";
import { MockAdapter, session, summary } from "../../ledger/test/mock-adapter";
import { StaticAdapterRegistry } from "../src/adapters";
import type { Ctx } from "../src/commands";
import { palette } from "../src/format";
import { run } from "../src/main";
import {
  REPOSITORY_BINDING_SCHEMA,
  REPOSITORY_BINDING_PREVIEW_SCHEMA,
  SESSION_TRANSFER_SCHEMA,
  bindSessionToRepository,
  createRepositoryBindingService,
  normalizeRepositoryRemote,
  parseRepositoryBinding,
  parseSessionTransferPayload,
  sanitizeSessionForNetwork,
  serializeSessionTransferPayload,
} from "../src/repository-binding";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "sinter-repository-binding-"));
  directories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr || `git ${args.join(" ")} failed`);
  return stdout.trim();
}

async function createRepository(path: string, remote: string, content = "tracked\n"): Promise<string> {
  mkdirSync(path, { recursive: true });
  await git(path, "init", "--quiet");
  writeFileSync(join(path, "tracked.txt"), content);
  await git(path, "add", "tracked.txt");
  await git(path, "-c", "user.name=Sinter Test", "-c", "user.email=sinter@example.test", "commit", "--quiet", "-m", "initial");
  await git(path, "remote", "add", "origin", remote);
  return git(path, "rev-parse", "HEAD");
}

async function cloneRepository(source: string, target: string, remote: string): Promise<void> {
  await git(tmpdir(), "clone", "--quiet", "--no-hardlinks", source, target);
  await git(target, "remote", "set-url", "origin", remote);
}

function sourceSession(cwd: string, commit: string, remote: string): SifSession {
  return {
    ...session("repository-source"),
    cwd,
    git: { sha: commit, branch: "feature/repository-binding", remote },
    subsessions: [{ ...session("repository-child"), cwd, git: { remote } }],
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("repository remote normalization", () => {
  test("normalizes HTTPS, SSH URL, and SCP-like forms without credentials or URL extras", () => {
    const expected = { host: "github.com", path: "Example/Project" };
    const values = [
      "https://token:secret@GitHub.com:443/Example/Project.git?access_token=hidden#fragment",
      "ssh://git@github.com:22/Example/Project.git",
      "git@GITHUB.COM.:Example/Project.git/?access_token=hidden#fragment",
    ];
    for (const value of values) expect(normalizeRepositoryRemote(value)).toEqual(expected);
    expect(JSON.stringify(values.map(normalizeRepositoryRemote))).not.toContain("secret");
    expect(JSON.stringify(values.map(normalizeRepositoryRemote))).not.toContain("hidden");
  });

  test("keeps a deterministic identity across transport, case, suffix, and credential variants", () => {
    const expected = { host: "git.example.test", path: "Org/Repo" };
    const variants: string[] = [];
    for (const host of ["git.example.test", "GIT.EXAMPLE.TEST."])
      for (const suffix of ["", ".git", ".git/"]) {
        variants.push(`https://token:secret@${host}:443/Org/Repo${suffix}?key=hidden#fragment`);
        variants.push(`ssh://git@${host}:22/Org/Repo${suffix}`);
        variants.push(`git@${host}:Org/Repo${suffix}?key=hidden#fragment`);
      }
    for (const variant of variants) expect(normalizeRepositoryRemote(variant)).toEqual(expected);
    const serialized = JSON.stringify(variants.map(normalizeRepositoryRemote));
    for (const forbidden of ["token", "secret", "hidden", "fragment", ".git"]) expect(serialized).not.toContain(forbidden);
  });

  test("preserves path case and non-default ports while rejecting local or malformed remotes", () => {
    expect(normalizeRepositoryRemote("ssh://git@Git.Example.test:2222/Org/Repo.git")).toEqual({
      host: "git.example.test:2222",
      path: "Org/Repo",
    });
    const ipv6 = { host: "[2001:db8::1]", path: "Org/Repo" };
    expect(normalizeRepositoryRemote("ssh://git@[2001:db8::1]/Org/Repo.git")).toEqual(ipv6);
    expect(normalizeRepositoryRemote("git@[2001:db8::1]:Org/Repo.git")).toEqual(ipv6);
    expect(normalizeRepositoryRemote("ssh://git@[2001:db8::1]:2222/Org/Repo.git")).toEqual({
      host: "[2001:db8::1]:2222",
      path: "Org/Repo",
    });
    expect(() => normalizeRepositoryRemote("/Users/source/private/repo")).toThrow("supported hosted Git remote");
    expect(() => normalizeRepositoryRemote("C:/Users/source/private/repo")).toThrow("supported hosted Git remote");
    expect(() => normalizeRepositoryRemote("C:\\Users\\source\\private\\repo")).toThrow("supported hosted Git remote");
    expect(normalizeRepositoryRemote("https://github.com/%45xample/%50roject.git")).toEqual({ host: "github.com", path: "Example/Project" });
    expect(normalizeRepositoryRemote("https://github.com/org/caf%C3%A9.git")).toEqual(
      normalizeRepositoryRemote("git@github.com:org/café.git"),
    );
    expect(normalizeRepositoryRemote("https://github.com.../Example/Project.git")).toEqual({ host: "github.com", path: "Example/Project" });
    for (const invalid of [
      "https://github.com/org%2F..%2Frepo.git",
      "git@github.com:org%2F..%2Frepo.git",
      "https://github.com:0/Example/Project.git",
      "ssh://github.com:99999/Example/Project.git",
      "git@@github.com:Example/Project.git",
      "git@[2001:db8::1:Example/Project.git",
      "git@host\\alias:Example/Project.git",
      "ssh://git@localhost/Example/Project.git",
      "ssh://git@127.0.0.1/Example/Project.git",
      "ssh://git@[::1]/Example/Project.git",
    ]) expect(() => normalizeRepositoryRemote(invalid)).toThrow();
    expect(() => normalizeRepositoryRemote("https://github.com")).toThrow("repository path");
  });
});

describe("repository binding schema", () => {
  test("strictly parses canonical binding records and rejects traversal or ambiguous identities", () => {
    const value = {
      schema: REPOSITORY_BINDING_SCHEMA,
      remotes: [{ host: "github.com", path: "example/project" }],
      selectedRemote: { host: "github.com", path: "example/project" },
      commit: "a".repeat(40),
      branch: "feature/safe",
      relativeCwd: "packages/frontend",
    };
    expect(parseRepositoryBinding(value)).toEqual(value);
    expect(() => parseRepositoryBinding({ ...value, relativeCwd: "../escape" })).toThrow("relative working directory");
    expect(() => parseRepositoryBinding({ ...value, relativeCwd: "/absolute" })).toThrow("relative working directory");
    expect(() => parseRepositoryBinding({ ...value, extra: true })).toThrow("unsupported fields");
    expect(() => parseRepositoryBinding({ ...value, selectedRemote: { host: "github.com", path: "other/repo" } }))
      .toThrow("selected remote");
    for (const branch of ["   ", "feature/\u0080hidden", "feature/\u2028hidden", "feature/\u202Ehidden", " feature/safe"])
      expect(() => parseRepositoryBinding({ ...value, branch })).toThrow("branch");
    expect(() => parseRepositoryBinding({
      ...value,
      remotes: [{ host: "github.com", path: "z/repo" }, { host: "github.com", path: "A/repo" }],
      selectedRemote: { host: "github.com", path: "z/repo" },
    })).toThrow("canonically sorted");
  });

  test("uses a versioned encrypted payload envelope and rejects legacy or extra fields", () => {
    const binding = parseRepositoryBinding({
      schema: REPOSITORY_BINDING_SCHEMA,
      remotes: [{ host: "github.com", path: "example/project" }],
      selectedRemote: { host: "github.com", path: "example/project" },
      commit: "b".repeat(40),
      relativeCwd: "",
    });
    const safeSession = sanitizeSessionForNetwork({
      ...session("payload"),
      cwd: "/Users/source/private/project",
      git: { remote: "https://token@github.com/example/project.git" },
      preserve: { private: true },
    });
    const serialized = serializeSessionTransferPayload(safeSession, binding);
    expect(parseSessionTransferPayload(serialized)).toEqual({ schema: SESSION_TRANSFER_SCHEMA, repository: binding, session: safeSession });
    expect(serialized).not.toContain("/Users/source/private/project");
    expect(serialized).not.toContain("token@");
    expect(serialized).not.toContain("private");
    expect(() => parseSessionTransferPayload(JSON.stringify(session("legacy")))).toThrow("unsupported session transfer payload");
    expect(() => parseSessionTransferPayload(JSON.stringify({ ...JSON.parse(serialized), extra: true }))).toThrow("unsupported fields");
    expect(() => parseSessionTransferPayload(JSON.stringify(JSON.parse(serialized), null, 2))).toThrow("canonical JSON");
    expect(() => parseSessionTransferPayload(serialized.replace(
      `{"schema":"${SESSION_TRANSFER_SCHEMA}"`,
      `{"schema":"wrong","schema":"${SESSION_TRANSFER_SCHEMA}"`,
    ))).toThrow("canonical JSON");

    const deeplyNested = structuredClone(safeSession);
    let current = deeplyNested;
    for (let depth = 0; depth < 18; depth++) {
      const child = { ...structuredClone(safeSession), id: `nested-${depth}`, subsessions: undefined };
      current.subsessions = [child];
      current = child;
    }
    expect(() => parseSessionTransferPayload(JSON.stringify({
      schema: SESSION_TRANSFER_SCHEMA,
      repository: binding,
      session: deeplyNested,
    }))).toThrow("nested too deeply");
  });
});

describe("repository target resolution", () => {
  test("requires an explicit named source remote when several identities are available", async () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source");
    const commit = await createRepository(sourceRoot, "https://github.com/example/fork.git");
    await git(sourceRoot, "remote", "add", "upstream", "git@github.com:example/project.git");
    const source = sourceSession(sourceRoot, commit, "https://github.com/example/fork.git");
    source.git = { sha: commit, branch: "feature/repository-binding" };
    const service = createRepositoryBindingService();

    await expect(service.source(source)).rejects.toThrow("use --repo-remote <name>");
    const binding = await service.source(source, { remoteName: "upstream" });
    expect(binding.selectedRemote).toEqual({ host: "github.com", path: "example/project" });
    expect(binding.remotes).toEqual([
      { host: "github.com", path: "example/fork" },
      { host: "github.com", path: "example/project" },
    ]);
    await expect(service.source(source, { remoteName: "missing" })).rejects.toThrow("has no supported identity");
    await expect(service.source(sourceSession(sourceRoot, commit, "https://github.com/example/fork.git"), { remoteName: "upstream" }))
      .rejects.toThrow("conflicts with the source session identity");
    await git(sourceRoot, "remote", "remove", "origin");
    await git(sourceRoot, "remote", "remove", "upstream");
    await expect(service.source(source)).rejects.toThrow("source repository has no supported remote identity");
  });

  test("matches one repository at different device paths, reports dirty state, and rewrites every cwd", async () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    const remote = "https://token:secret@GitHub.com/Example/Project.git?hidden=1";
    const commit = await createRepository(sourceRoot, remote);
    mkdirSync(join(sourceRoot, "packages", "frontend"), { recursive: true });
    await cloneRepository(sourceRoot, targetRoot, "git@github.com:Example/Project.git");
    mkdirSync(join(targetRoot, "packages", "frontend"), { recursive: true });
    const dirtyPath = join(targetRoot, "dirty.txt");
    writeFileSync(dirtyPath, "do not modify\n");
    const dirtyBefore = readFileSync(dirtyPath);

    const service = createRepositoryBindingService();
    const source = sourceSession(join(sourceRoot, "packages", "frontend"), commit, remote);
    const binding = await service.source(source);
    expect(binding).toMatchObject({
      schema: REPOSITORY_BINDING_SCHEMA,
      selectedRemote: { host: "github.com", path: "Example/Project" },
      commit,
      relativeCwd: "packages/frontend",
    });
    expect(JSON.stringify(binding)).not.toContain(sourceRoot);
    expect(JSON.stringify(binding)).not.toContain("secret");

    const resolution = await service.resolve(binding, targetRoot, {});
    expect(resolution.preview).toMatchObject({
      schema: REPOSITORY_BINDING_PREVIEW_SCHEMA,
      match: "exact",
      targetRemote: "ssh://github.com/Example/Project",
      commitAvailable: true,
      targetWorktreeDirty: true,
      relativeCwd: "packages/frontend",
      writes: false,
      overrides: { repositoryMismatch: false, missingCommit: false },
    });
    expect(resolution.targetCwd).toBe(realpathSync(join(targetRoot, "packages", "frontend")));
    expect(JSON.stringify(resolution.preview)).not.toContain(sourceRoot);
    expect(JSON.stringify(resolution.preview)).not.toContain("secret");
    expect(readFileSync(dirtyPath)).toEqual(dirtyBefore);

    const rewritten = bindSessionToRepository(sanitizeSessionForNetwork(source), resolution);
    expect(rewritten.cwd).toBe(resolution.targetCwd);
    expect(rewritten.subsessions?.[0]?.cwd).toBe(resolution.targetCwd);
    expect(rewritten.git).toMatchObject({ sha: commit, branch: "feature/repository-binding" });
    expect(rewritten.git?.remote).toBe("ssh://github.com/Example/Project");
    expect(rewritten.git?.remote).not.toContain("secret");
    expect(JSON.stringify(rewritten)).not.toContain(sourceRoot);

    const targetSubdirectory = join(targetRoot, "packages", "frontend");
    rmSync(targetSubdirectory, { recursive: true, force: true });
    writeFileSync(targetSubdirectory, "not a directory\n");
    await expect(service.resolve(binding, targetRoot, {})).rejects.toThrow("not a directory");
    rmSync(targetSubdirectory);
    await expect(service.resolve(binding, targetRoot, {})).rejects.toThrow("subdirectory is missing");
  });

  test("requires dedicated overrides for repository mismatch and missing commits", async () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source-device", "project");
    const mismatchRoot = join(root, "target-device", "project");
    const ambiguousRoot = join(root, "ambiguous-device", "project");
    const missingRoot = join(root, "missing-device", "project");
    const sourceRemote = "https://github.com/example/source.git";
    const commit = await createRepository(sourceRoot, sourceRemote);
    mkdirSync(join(root, "target-device"), { recursive: true });
    mkdirSync(join(root, "ambiguous-device"), { recursive: true });
    await cloneRepository(sourceRoot, mismatchRoot, "https://github.com/example/other.git");
    await cloneRepository(sourceRoot, ambiguousRoot, "https://github.com/example/other.git");
    await git(ambiguousRoot, "remote", "add", "upstream", "https://github.com/example/third.git");
    await createRepository(missingRoot, sourceRemote, "different repository content\n");

    const service = createRepositoryBindingService();
    const binding = await service.source(sourceSession(sourceRoot, commit, sourceRemote));

    await expect(service.resolve(binding, mismatchRoot, {})).rejects.toThrow("repository mismatch");
    const mismatch = await service.resolve(binding, mismatchRoot, { allowRepositoryMismatch: true });
    expect(mismatch.preview.match).toBe("mismatch");
    expect(mismatch.preview.overrides.repositoryMismatch).toBe(true);
    expect(mismatch.provenanceModeSuffix).toContain("repo-mismatch-allowed");
    await expect(service.resolve(binding, ambiguousRoot, { allowRepositoryMismatch: true }))
      .rejects.toThrow("several possible remote identities");

    await expect(service.resolve(binding, missingRoot, {})).rejects.toThrow("source commit is unavailable");
    const missing = await service.resolve(binding, missingRoot, { allowMissingCommit: true });
    expect(missing.preview.match).toBe("exact");
    expect(missing.preview.commitAvailable).toBe(false);
    expect(missing.preview.overrides.missingCommit).toBe(true);
    expect(missing.provenanceModeSuffix).toContain("missing-commit-allowed");
  });

  test("refuses non-Git, unbound, traversal, and symlink-escaped targets", async () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    const unboundRoot = join(root, "unbound");
    const plainRoot = join(root, "plain");
    const outside = join(root, "outside");
    const remote = "https://github.com/example/project.git";
    const commit = await createRepository(sourceRoot, remote);
    mkdirSync(join(sourceRoot, "packages", "frontend"), { recursive: true });
    await cloneRepository(sourceRoot, targetRoot, remote);
    await createRepository(unboundRoot, remote);
    await git(unboundRoot, "remote", "remove", "origin");
    mkdirSync(plainRoot);
    mkdirSync(join(outside, "frontend"), { recursive: true });
    symlinkSync(outside, join(targetRoot, "packages"));

    const service = createRepositoryBindingService();
    const binding = await service.source(sourceSession(join(sourceRoot, "packages", "frontend"), commit, remote));
    await expect(service.resolve(binding, plainRoot, { allowRepositoryMismatch: true })).rejects.toThrow("not a Git repository");
    await expect(service.resolve(binding, unboundRoot, { allowRepositoryMismatch: true })).rejects.toThrow("has no supported remote identity");
    await expect(service.resolve(binding, targetRoot, {})).rejects.toThrow("escapes the target repository");
  });
});

describe("repository-bound direct transfer integration", () => {
  test("uses real Git inspection and encrypted transport before writing the target instance", async () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source-device", "project");
    const targetRoot = join(root, "target-device", "project");
    const sourceCwd = join(sourceRoot, "packages", "frontend");
    const remote = "https://token:secret@github.com/example/project.git?hidden=1";
    await createRepository(sourceRoot, remote);
    mkdirSync(sourceCwd, { recursive: true });
    writeFileSync(join(sourceCwd, "package.json"), "{}\n");
    await git(sourceRoot, "add", "packages/frontend/package.json");
    await git(sourceRoot, "-c", "user.name=Sinter Test", "-c", "user.email=sinter@example.test", "commit", "--quiet", "-m", "frontend");
    const commit = await git(sourceRoot, "rev-parse", "HEAD");
    mkdirSync(join(root, "target-device"), { recursive: true });
    await cloneRepository(sourceRoot, targetRoot, "git@github.com:example/project.git");

    const source = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "real-source", cwd: sourceCwd })],
      sessions: { "real-source": sourceSession(sourceCwd, commit, remote) },
    });
    const target = new MockAdapter({ id: "codex" });
    const senderLedger = new Ledger(":memory:");
    const receiverLedger = new Ledger(":memory:");
    const senderRegistry = new StaticAdapterRegistry([{ instanceId: "personal", adapter: source }]);
    await senderLedger.scan(await senderRegistry.available());
    const senderOutput: string[] = [];
    const receiverOutput: string[] = [];
    const receiverErrors: string[] = [];
    const base = {
      pal: palette(false),
      width: 120,
      now: Date.now(),
      writeFile: async () => { throw new Error("unexpected file write"); },
      readFile: async () => { throw new Error("unexpected file read"); },
      interactive: false,
      repositoryBinding: createRepositoryBindingService(),
    };
    const senderCtx: Ctx = {
      ...base,
      registry: senderRegistry,
      ledger: () => senderLedger,
      out: (line) => senderOutput.push(line),
      err: () => {},
    };
    const receiverCtx: Ctx = {
      ...base,
      registry: new StaticAdapterRegistry([{ instanceId: "work", adapter: target }]),
      ledger: () => receiverLedger,
      out: (line) => receiverOutput.push(line),
      err: (line) => receiverErrors.push(line),
    };

    const receiving = run([
      "receive", "--to", "codex@work", "--cwd", targetRoot, "--bind", "127.0.0.1", "--advertise", "127.0.0.1", "--ttl", "30s", "--yes",
    ], receiverCtx);
    await Bun.sleep(0);
    const locator = receiverOutput.find((line) => line.startsWith("sinter://"));
    expect(locator).toBeDefined();
    expect(await run(["send", "claude@personal:real-source", "--to", locator!], senderCtx)).toBe(0);
    expect(await receiving).toBe(0);
    expect(target.written).toHaveLength(1);
    expect(target.written[0]!.opts).toMatchObject({ instanceId: "work", cwd: realpathSync(join(targetRoot, "packages", "frontend")) });
    expect(target.written[0]!.session.git).toEqual({
      sha: commit,
      branch: "feature/repository-binding",
      remote: "ssh://github.com/example/project",
    });
    const emitted = JSON.stringify([senderOutput, receiverOutput, receiverErrors, target.written[0]]);
    expect(emitted).not.toContain(sourceRoot);
    expect(emitted).not.toContain("token:secret");
    expect(emitted).not.toContain("token@");
    expect(emitted).not.toContain("secret");
    expect(emitted).not.toContain("hidden=1");
    senderLedger.close();
    receiverLedger.close();
  }, 30_000);
});
