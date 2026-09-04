import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@sinter/ledger";
import { StaticAdapterRegistry, type AdapterRegistry } from "../src/adapters";
import { loadProfile } from "../src/config";
import { palette } from "../src/format";
import type { Ctx } from "../src/commands";
import { run } from "../src/main";
import { MockAdapter, session, summary } from "../../ledger/test/mock-adapter";
import { CodexAdapter } from "@sinter/adapter-codex";
import type { HarnessAdapter, SifSession, WriteOpts, WritePlan } from "@sinter/core";
import {
  REPOSITORY_BINDING_PREVIEW_SCHEMA,
  REPOSITORY_BINDING_SCHEMA,
  RepositoryBindingError,
  sanitizeSessionForNetwork,
  serializeSessionTransferPayload,
  type RepositoryBindingService,
} from "../src/repository-binding";
import { sendTransfer } from "../src/network";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

interface Harness {
  ctx: Ctx;
  ledger: Ledger;
  claude: MockAdapter;
  omp: MockAdapter;
  stdout: string[];
  stderr: string[];
  written: Record<string, string>;
  execed: string[][];
  files: Record<string, string>;
  out(): string;
  err(): string;
}

function harness(): Harness {
  const ledger = new Ledger(":memory:");
  const claude = new MockAdapter({
    id: "claude",
    summaries: [
      summary({ nativeId: "aaa11111-1111", title: "porting sessions between harnesses" }),
      summary({ nativeId: "aaa22222-2222", title: "unrelated work", cwd: "/Users/test/other" }),
      summary({ nativeId: "bbb33333-3333", title: "old thing", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ],
    sessions: {
      "aaa11111-1111": session("aaa11111-1111"),
      "aaa22222-2222": session("aaa22222-2222"),
      "bbb33333-3333": session("bbb33333-3333"),
    },
  });
  const omp = new MockAdapter({
    id: "omp",
    summaries: [summary({ nativeId: "omp-1", harness: "omp", title: "omp session" })],
    sessions: { "omp-1": session("omp-1", "omp") },
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const written: Record<string, string> = {};
  const execed: string[][] = [];
  const files: Record<string, string> = {};

  const ctx: Ctx = {
    registry: new StaticAdapterRegistry([claude, omp], { zcode: "cannot find module" }),
    ledger: () => ledger,
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    pal: palette(false),
    width: 100,
    now: NOW,
    writeFile: async (p, c) => void (written[p] = c),
    readFile: async (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    },
    exec: async (argv) => {
      execed.push(argv);
      return 0;
    },
  };

  return {
    ctx,
    ledger,
    claude,
    omp,
    stdout,
    stderr,
    written,
    execed,
    files,
    out: () => stdout.join("\n"),
    err: () => stderr.join("\n"),
  };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

async function scan(target?: Harness) {
  return run(["scan"], (target ?? h).ctx);
}

function repositoryFixture() {
  const commit = "b".repeat(40);
  return {
    schema: REPOSITORY_BINDING_SCHEMA,
    remotes: [{ host: "github.com", path: "example/project" }],
    selectedRemote: { host: "github.com", path: "example/project" },
    commit,
    branch: "feature/repository-binding",
    relativeCwd: "",
  } as const;
}

describe("CLI conventions", () => {
  test("verifies and repairs the local ledger", async () => {
    expect(await run(["ledger", "verify", "--json"], h.ctx)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({
      schema: "sinter.ledger-verify.v1",
      healthy: true,
      fts: { missing: 0, orphaned: 0 },
    });
    h.stdout.length = 0;
    expect(await run(["ledger", "repair"], h.ctx)).toBe(1);
    expect(h.err()).toContain("refusing to repair without --yes");
    h.stdout.length = 0;
    expect(await run(["ledger", "repair", "--yes", "--no-backup", "--json"], h.ctx)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({
      schema: "sinter.ledger-repair.v1",
      after: { healthy: true },
    });
  });

  test("backs up a file ledger and rejects unknown ledger actions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinter-ledger-cli-"));
    const path = join(dir, "ledger.db");
    const destination = join(dir, "backup.sqlite");
    const fileLedger = new Ledger(path);
    const ctx = { ...h.ctx, ledger: () => fileLedger };
    try {
      expect(await run(["ledger", "backup", "--output", destination, "--json"], ctx)).toBe(0);
      expect(JSON.parse(h.out())).toMatchObject({
        schema: "sinter.ledger-backup.v1",
        path: destination,
        ledger: path,
      });
    } finally {
      fileLedger.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await run(["ledger", "nuke"], h.ctx)).toBe(1);
  });

  test("renders command-specific help without touching the ledger", async () => {
    expect(await run(["port", "--help"], h.ctx)).toBe(0);
    expect(h.out()).toContain("usage: sinter port");
    expect(h.out()).toContain("Creates a new target session");
    expect(h.out()).not.toContain("one ledger for every coding-agent session");
    h.stdout.length = 0;
    expect(await run(["receive", "--help"], h.ctx)).toBe(0);
    expect(h.out()).toContain("--cwd <repository-root>");
    expect(h.out()).toContain("--allow-repo-mismatch");
    expect(h.out()).toContain("--allow-missing-commit");
    expect(h.out()).toContain("rejects legacy v1 session payloads");
    expect(h.out()).toContain("versioned listener record");
    expect(h.out()).toContain("versioned completion record");
    h.stdout.length = 0;
    expect(await run(["send", "--help"], h.ctx)).toBe(0);
    expect(h.out()).toContain("--repo-remote <name>");
    expect(h.out()).toContain("source absolute working directory");
  });

  test("groups top-level help by user job", async () => {
    expect(await run(["--help"], h.ctx)).toBe(0);
    for (const heading of ["interactive", "find and inspect", "organize locally", "move and continue", "setup and maintenance", "support and interfaces"])
      expect(h.out()).toContain(`\n${heading}\n`);
  });

  test("documents an agent-safe named-instance workflow on stdout", async () => {
    expect(await run(["help", "instances"], h.ctx)).toBe(0);
    expect(h.out()).toContain("claude@personal:<id>");
    expect(h.out()).toContain("stdout contains requested results");
    expect(h.err()).toBe("");
  });

  test("reports unknown help topics on stderr with a non-zero exit", async () => {
    expect(await run(["help", "unknown-topic"], h.ctx)).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toContain("unknown help topic");
  });

  test("explains local-only storage and unsupported desktop surfaces", async () => {
    expect(await run(["privacy"], h.ctx)).toBe(0);
    expect(h.out()).toContain("does not upload transcripts");
    expect(h.out()).toContain("owner read/write only");
    expect(h.out()).toContain("zcode: read-only");
    expect(h.out()).toContain("ChatGPT.app / Codex desktop: future work");
  });

  test("documents optional Cloud account commands", async () => {
    expect(await run(["login", "--help"], h.ctx)).toBe(0);
    expect(h.out()).toContain("macOS Keychain");
    h.stdout.length = 0;
    expect(await run(["whoami", "--help"], h.ctx)).toBe(0);
    expect(h.out()).toContain("never scans local sessions");
  });

  test("rejects auto for direct send and Cloud push", async () => {
    await scan();
    expect(await run(["send", "aaa11111", "--to", "sinter://transfer/test", "--mode", "auto"], h.ctx)).toBe(1);
    expect(h.err()).toContain("unknown --mode: auto (known: full, slim, compact)");
    h.stderr.length = 0;
    expect(await run(["cloud", "push", "aaa11111", "--mode", "auto"], h.ctx)).toBe(1);
    expect(h.err()).toContain("unknown --mode: auto (known: full, slim, compact)");
  });

  test("reports Cloud identity and logout through an injected credential service", async () => {
    h.ctx.cloudAuth = {
      login: async () => ({ user: { id: "user-1", email: "jensen@example.test" }, storage: "test keychain" }),
      whoami: async () => ({ user: { id: "user-1", email: "jensen@example.test" }, storage: "test keychain" }),
      logout: async () => ({ hadSession: true, revoked: true }),
      apiSession: async () => undefined,
    };
    expect(await run(["whoami", "--json"], h.ctx)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ ok: true, loggedIn: true, user: { email: "jensen@example.test" } });
    h.stdout.length = 0;
    expect(await run(["logout"], h.ctx)).toBe(0);
    expect(h.out()).toContain("Logged out");
  });

  test("loads named, harness-root profiles", () => {
    const dir = mkdtempSync(join(tmpdir(), "sinter-profile-"));
    const config = join(dir, "config.toml");
    writeFileSync(config, `[profiles.work.stores]\nclaude = \"/tmp/claude-work/projects\"\ncodex = \"/tmp/codex-work\"\n`);
    try {
      expect(loadProfile(["--profile", "work", "--config", config])).toEqual({
        name: "work",
        configPath: config,
        stores: { claude: "/tmp/claude-work/projects", codex: "/tmp/codex-work" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("named harness instances", () => {
  test("routes scans, reads, same-harness ports, metadata, and resume through the exact instance", async () => {
    const personal = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "same-native", title: "personal title" })],
      sessions: { "same-native": { ...session("same-native"), title: { text: "personal title", source: "auto" } } },
    });
    const work = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "same-native", title: "work title" })],
      sessions: { "same-native": { ...session("same-native"), title: { text: "work title", source: "auto" } } },
    });
    const ledger = new Ledger(":memory:");
    const output: string[] = [];
    const ctx: Ctx = {
      ...h.ctx,
      ledger: () => ledger,
      out: (line) => output.push(line),
      registry: new StaticAdapterRegistry([
        { instanceId: "personal", adapter: personal, command: ["claude-personal"] },
        { instanceId: "work", adapter: work, command: ["claude-work"] },
      ]),
    };

    expect(await run(["scan"], ctx)).toBe(0);
    expect(ledger.list()).toHaveLength(2);
    output.length = 0;
    expect(await run(["show", "claude@personal:same"], ctx)).toBe(0);
    expect(output.join("\n")).toContain("personal title");
    expect(await run(["rename", "claude@personal:same", "mine"], ctx)).toBe(0);
    expect(ledger.get("claude", "same-native", "personal")?.alias).toBe("mine");
    expect(ledger.get("claude", "same-native", "work")?.alias).toBeUndefined();

    output.length = 0;
    expect(await run(["port", "claude@personal:same", "--to", "claude@work"], ctx)).toBe(0);
    expect(work.written).toHaveLength(1);
    expect(work.written[0]!.opts?.instanceId).toBe("work");
    expect(output.join("\n")).toContain("claude@work:new-claude-1");

    output.length = 0;
    expect(await run(["resume", "claude@work:same"], ctx)).toBe(0);
    expect(output.join("\n")).toContain("claude-work --resume same-native");
    ledger.close();
  });

  test("plans a named target port through that instance adapter", async () => {
    const personal = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "source-native" })],
      sessions: { "source-native": session("source-native") },
    });
    const work = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "target-native" })],
      sessions: { "target-native": session("target-native") },
    });
    const planned: WriteOpts[] = [];
    const output: string[] = [];
    Object.assign(work, {
      async planWrite(_session: SifSession, opts?: WriteOpts): Promise<WritePlan> {
        planned.push(opts ?? {});
        return { context: { unit: "bytes", limit: 100_000, before: 1_000, after: 1_000, omittedEntries: 0, strategy: "none" } };
      },
    });
    const ledger = new Ledger(":memory:");
    const ctx: Ctx = {
      ...h.ctx,
      ledger: () => ledger,
      out: (line) => output.push(line),
      registry: new StaticAdapterRegistry([
        { instanceId: "personal", adapter: personal, command: ["claude-personal"] },
        { instanceId: "work", adapter: work, command: ["claude-work"] },
      ]),
    };
    await run(["scan"], ctx);
    expect(await run(["port", "claude@personal:source", "--to", "claude@work", "--preview", "--json"], ctx)).toBe(0);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.instanceId).toBe("work");
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ target: { instanceId: "work" }, requestedMode: "auto" });
    ledger.close();
  });

  test("send v2 preview exposes only sanitized repository binding metadata", async () => {
    const sourcePath = "/Users/source/private/project";
    const source = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "source-preview", cwd: sourcePath })],
      sessions: {
        "source-preview": {
          ...session("source-preview"),
          cwd: sourcePath,
          git: { remote: "https://token:secret@github.com/example/project.git?hidden=1" },
        },
      },
    });
    const ledger = new Ledger(":memory:");
    await ledger.scan(await new StaticAdapterRegistry([{ instanceId: "personal", adapter: source }]).available());
    const output: string[] = [];
    const ctx: Ctx = {
      ...h.ctx,
      ledger: () => ledger,
      out: (line) => output.push(line),
      registry: new StaticAdapterRegistry([{ instanceId: "personal", adapter: source }]),
      repositoryBinding: {
        async source(_session, options) {
          expect(options).toEqual({ remoteName: "upstream" });
          return repositoryFixture();
        },
        async resolve() { throw new Error("preview must not resolve a target"); },
      },
    };
    expect(await run([
      "send", "claude@personal:source-preview", "--to", "unused-locator", "--repo-remote", "upstream", "--preview", "--json",
    ], ctx)).toBe(0);
    expect(output).toHaveLength(1);
    const preview = JSON.parse(output[0]!);
    expect(preview.repository).toEqual({
      selectedRemote: "github.com/example/project",
      commit: "b".repeat(40),
      branch: "feature/repository-binding",
      relativeCwd: "",
    });
    expect(preview).toMatchObject({ schema: "sinter.send.preview.v1", transportEncryption: "on-send", sends: false });
    expect(preview.payloadBytes).toBeGreaterThan(0);
    expect(output[0]).not.toContain(sourcePath);
    expect(output[0]).not.toContain("token");
    expect(output[0]).not.toContain("secret");
    expect(output[0]).not.toContain("hidden");
    ledger.close();
  });

  test("send/receive v2 binds the encrypted session to an explicit matching target repository", async () => {
    const sourcePath = "/Users/source/private/project/packages/frontend";
    const targetRoot = "/Users/target/Code/project";
    const targetCwd = `${targetRoot}/packages/frontend`;
    const commit = "a".repeat(40);
    const repository = {
      schema: REPOSITORY_BINDING_SCHEMA,
      remotes: [{ host: "github.com", path: "example/project" }],
      selectedRemote: { host: "github.com", path: "example/project" },
      commit,
      branch: "feature/repository-binding",
      relativeCwd: "packages/frontend",
    } as const;
    const preview = {
      schema: REPOSITORY_BINDING_PREVIEW_SCHEMA,
      sourceRepository: "github.com/example/project",
      sourceCommit: commit,
      sourceBranch: "feature/repository-binding",
      targetRepository: "github.com/example/project",
      targetRemote: "https://github.com/example/project",
      targetRoot,
      targetCwd,
      targetHead: commit,
      relativeCwd: "packages/frontend",
      match: "exact" as const,
      commitAvailable: true,
      targetWorktreeDirty: true,
      overrides: { repositoryMismatch: false, missingCommit: false },
      writes: false as const,
    };
    const source = new MockAdapter({
      id: "claude",
      summaries: [summary({ nativeId: "source-one", cwd: sourcePath })],
      sessions: {
        "source-one": {
          ...session("source-one"),
          cwd: sourcePath,
          git: { sha: commit, branch: "feature/repository-binding", remote: "https://token@github.com/example/project.git" },
          preserve: { secretProviderState: "drop-me" },
        },
      },
    });
    const target = new MockAdapter({ id: "codex" });
    const senderLedger = new Ledger(":memory:");
    const receiverLedger = new Ledger(":memory:");
    await senderLedger.scan(await new StaticAdapterRegistry([{ instanceId: "personal", adapter: source }]).available());
    const receiverOut: string[] = [];
    const receiverErr: string[] = [];
    const senderOut: string[] = [];
    const sourceBinding: RepositoryBindingService = {
      async source() { return repository; },
      async resolve() { throw new Error("sender must not resolve a target"); },
    };
    const targetBinding: RepositoryBindingService = {
      async source() { throw new Error("receiver must not inspect a source"); },
      async resolve(value, path, options) {
        expect(value).toEqual(repository);
        expect(path).toBe(targetRoot);
        expect(options).toEqual({ allowRepositoryMismatch: false, allowMissingCommit: false });
        return {
          preview,
          targetCwd,
          git: { sha: commit, branch: repository.branch, remote: "https://github.com/example/project" },
          provenanceModeSuffix: "",
        };
      },
    };
    const receiverCtx: Ctx = {
      ...h.ctx,
      ledger: () => receiverLedger,
      out: (line) => receiverOut.push(line),
      err: (line) => receiverErr.push(line),
      registry: new StaticAdapterRegistry([{ instanceId: "work", adapter: target, command: ["codex-work"] }]),
      repositoryBinding: targetBinding,
      interactive: false,
    };
    const senderCtx: Ctx = {
      ...h.ctx,
      ledger: () => senderLedger,
      out: (line) => senderOut.push(line),
      registry: new StaticAdapterRegistry([{ instanceId: "personal", adapter: source }]),
      repositoryBinding: sourceBinding,
    };

    const receiving = run([
      "receive", "--to", "codex@work", "--cwd", targetRoot, "--bind", "127.0.0.1", "--advertise", "127.0.0.1", "--ttl", "30s", "--yes", "--json",
    ], receiverCtx);
    await Bun.sleep(0);
    const listener = JSON.parse(receiverOut[0]!);
    expect(listener).toMatchObject({ schema: "sinter.receive.listener.v1", listening: true, target: "codex@work" });
    const sendCode = await run(["send", "claude@personal:source", "--to", listener.locator, "--json"], senderCtx);
    expect({ sendCode, senderError: h.stderr.join("\n"), receiverOutput: receiverOut }).toMatchObject({ sendCode: 0 });
    expect(await receiving).toBe(0);
    expect(receiverOut).toHaveLength(2);
    expect(JSON.parse(receiverOut[1]!)).toMatchObject({
      schema: "sinter.receive.result.v1",
      ok: true,
      imported: true,
      wrote: true,
      target: { harness: "codex", instanceId: "work", nativeId: "new-codex-1" },
      preview: { schema: REPOSITORY_BINDING_PREVIEW_SCHEMA, writes: false },
    });
    expect(target.written).toHaveLength(1);
    expect(target.written[0]!.opts).toMatchObject({ instanceId: "work", cwd: targetCwd, mode: "network-compact" });
    expect(target.written[0]!.session).toMatchObject({
      cwd: targetCwd,
      git: { sha: commit, branch: repository.branch, remote: "https://github.com/example/project" },
    });
    expect(target.written[0]!.session.preserve).toBeUndefined();
    expect(target.written[0]!.session.origin.nativePath).toBeUndefined();
    expect(target.written[0]!.session.entries.every((entry) => entry.raw === undefined)).toBe(true);
    expect(JSON.stringify(target.written[0]!.session)).not.toContain(sourcePath);
    expect(JSON.stringify(target.written[0]!.session)).not.toContain("token@");
    expect(receiverErr.join("\n")).toContain("Repository binding preview");
    expect(receiverErr.join("\n")).toContain("target harness");
    expect(receiverErr.join("\n")).toContain("codex@work");
    expect(receiverErr.join("\n")).toContain("target worktree");
    expect(receiverErr.join("\n")).not.toContain(sourcePath);
    expect(receiverErr.join("\n")).not.toContain("token@");
    expect(senderOut).toHaveLength(1);
    expect(JSON.parse(senderOut[0]!)).toMatchObject({ schema: "sinter.send.result.v1", ok: true });
    senderLedger.close();
    receiverLedger.close();
  });

  test("receive v2 requires an explicit target repository before listening", async () => {
    const target = new MockAdapter({ id: "codex" });
    const output: string[] = [];
    const errors: string[] = [];
    const ctx: Ctx = {
      ...h.ctx,
      out: (line) => output.push(line),
      err: (line) => errors.push(line),
      registry: new StaticAdapterRegistry([{ instanceId: "work", adapter: target }]),
    };
    expect(await run(["receive", "--to", "codex@work", "--bind", "127.0.0.1", "--yes"], ctx)).toBe(1);
    expect(output.some((line) => line.startsWith("sinter://"))).toBe(false);
    expect(errors.join("\n")).toContain("requires --cwd <repository-root>");
    expect(target.written).toHaveLength(0);
  });

  test("receive v2 rejects legacy v1 payloads before repository or adapter writes", async () => {
    const target = new MockAdapter({ id: "codex" });
    const output: string[] = [];
    const errors: string[] = [];
    let repositoryCalls = 0;
    const ctx: Ctx = {
      ...h.ctx,
      out: (line) => output.push(line),
      err: (line) => errors.push(line),
      registry: new StaticAdapterRegistry([{ instanceId: "work", adapter: target }]),
      repositoryBinding: {
        async source() { throw new Error("unexpected source inspection"); },
        async resolve() { repositoryCalls++; throw new Error("unexpected target inspection"); },
      },
    };
    const receiving = run([
      "receive", "--to", "codex@work", "--cwd", "/target/repository", "--bind", "127.0.0.1", "--advertise", "127.0.0.1", "--ttl", "30s", "--yes",
    ], ctx);
    await Bun.sleep(0);
    const locator = output.find((line) => line.startsWith("sinter://"));
    expect(locator).toBeDefined();
    await expect(sendTransfer(locator!, new TextEncoder().encode(JSON.stringify(session("legacy"))), {
      metadata: { schema: "sinter.session.v1", mode: "compact" },
    })).rejects.toThrow("receiver_rejected_transfer");
    expect(await receiving).toBe(1);
    expect(errors.join("\n")).toContain("both devices must use Sinter direct transfer v2");
    expect(repositoryCalls).toBe(0);
    expect(target.written).toHaveLength(0);
  });

  test("non-interactive receive still requires --yes after repository preview", async () => {
    const repository = repositoryFixture();
    const payload = new TextEncoder().encode(serializeSessionTransferPayload(sanitizeSessionForNetwork(session("source")), repository));
    const target = new MockAdapter({ id: "codex" });
    const output: string[] = [];
    const errors: string[] = [];
    const targetRoot = "/target/repository";
    const preview = {
      schema: REPOSITORY_BINDING_PREVIEW_SCHEMA,
      sourceRepository: "github.com/example/project",
      sourceCommit: repository.commit,
      sourceBranch: repository.branch,
      targetRepository: "github.com/example/project",
      targetRemote: "https://github.com/example/project",
      targetRoot,
      targetCwd: targetRoot,
      targetHead: repository.commit,
      relativeCwd: "",
      match: "exact" as const,
      commitAvailable: true,
      targetWorktreeDirty: false,
      overrides: { repositoryMismatch: false, missingCommit: false },
      writes: false as const,
    };
    const ctx: Ctx = {
      ...h.ctx,
      interactive: false,
      out: (line) => output.push(line),
      err: (line) => errors.push(line),
      registry: new StaticAdapterRegistry([{ instanceId: "work", adapter: target }]),
      repositoryBinding: {
        async source() { throw new Error("unexpected source inspection"); },
        async resolve() {
          return {
            preview,
            targetCwd: targetRoot,
            git: { sha: repository.commit, branch: repository.branch, remote: "https://github.com/example/project" },
            provenanceModeSuffix: "",
          };
        },
      },
    };
    const receiving = run([
      "receive", "--to", "codex@work", "--cwd", targetRoot, "--bind", "127.0.0.1", "--advertise", "127.0.0.1", "--ttl", "30s",
    ], ctx);
    await Bun.sleep(0);
    const locator = output.find((line) => line.startsWith("sinter://"));
    await expect(sendTransfer(locator!, payload, { metadata: { schema: "sinter.session.v2", mode: "compact" } }))
      .rejects.toThrow("receiver_rejected_transfer");
    expect(await receiving).toBe(1);
    expect(errors.join("\n")).toContain("receive needs an interactive terminal; use --yes");
    expect(errors.join("\n")).toContain("Repository binding preview");
    expect(target.written).toHaveLength(0);
  });

  test("--yes cannot bypass mismatch and dedicated overrides remain visible in provenance", async () => {
    const repository = repositoryFixture();
    const payload = new TextEncoder().encode(serializeSessionTransferPayload(sanitizeSessionForNetwork(session("source")), repository));
    const refusedTarget = new MockAdapter({ id: "codex" });
    const refusedOutput: string[] = [];
    const refusedErrors: string[] = [];
    const refusedCtx: Ctx = {
      ...h.ctx,
      out: (line) => refusedOutput.push(line),
      err: (line) => refusedErrors.push(line),
      registry: new StaticAdapterRegistry([{ instanceId: "work", adapter: refusedTarget }]),
      repositoryBinding: {
        async source() { throw new Error("unexpected source inspection"); },
        async resolve(_binding, _path, options) {
          expect(options.allowRepositoryMismatch).toBe(false);
          throw new RepositoryBindingError("Refusing repository mismatch; no session or workspace files were written");
        },
      },
    };
    const refused = run([
      "receive", "--to", "codex@work", "--cwd", "/target/repository", "--bind", "127.0.0.1", "--advertise", "127.0.0.1", "--ttl", "30s", "--yes",
    ], refusedCtx);
    await Bun.sleep(0);
    const refusedLocator = refusedOutput.find((line) => line.startsWith("sinter://"));
    await expect(sendTransfer(refusedLocator!, payload, { metadata: { schema: "sinter.session.v2", mode: "compact" } }))
      .rejects.toThrow("receiver_rejected_transfer");
    expect(await refused).toBe(1);
    expect(refusedErrors.join("\n")).toContain("Refusing repository mismatch");
    expect(refusedTarget.written).toHaveLength(0);

    const allowedTarget = new MockAdapter({ id: "codex" });
    const allowedOutput: string[] = [];
    const allowedErrors: string[] = [];
    const targetRoot = "/target/repository";
    const preview = {
      schema: REPOSITORY_BINDING_PREVIEW_SCHEMA,
      sourceRepository: "github.com/example/project",
      sourceCommit: repository.commit,
      sourceBranch: repository.branch,
      targetRepository: "github.com/example/other",
      targetRemote: "https://github.com/example/other",
      targetRoot,
      targetCwd: targetRoot,
      targetHead: "c".repeat(40),
      relativeCwd: "",
      match: "mismatch" as const,
      commitAvailable: false,
      targetWorktreeDirty: false,
      overrides: { repositoryMismatch: true, missingCommit: true },
      writes: false as const,
    };
    const allowedCtx: Ctx = {
      ...h.ctx,
      out: (line) => allowedOutput.push(line),
      err: (line) => allowedErrors.push(line),
      registry: new StaticAdapterRegistry([{ instanceId: "work", adapter: allowedTarget }]),
      repositoryBinding: {
        async source() { throw new Error("unexpected source inspection"); },
        async resolve(_binding, path, options) {
          expect(path).toBe(targetRoot);
          expect(options).toEqual({ allowRepositoryMismatch: true, allowMissingCommit: true });
          return {
            preview,
            targetCwd: targetRoot,
            git: { sha: repository.commit, branch: repository.branch, remote: "https://github.com/example/other" },
            provenanceModeSuffix: "+repo-mismatch-allowed+missing-commit-allowed",
          };
        },
      },
    };
    const allowed = run([
      "receive", "--to", "codex@work", "--cwd", targetRoot, "--bind", "127.0.0.1", "--advertise", "127.0.0.1", "--ttl", "30s", "--yes", "--allow-repo-mismatch", "--allow-missing-commit",
    ], allowedCtx);
    await Bun.sleep(0);
    const allowedLocator = allowedOutput.find((line) => line.startsWith("sinter://"));
    await sendTransfer(allowedLocator!, payload, { metadata: { schema: "sinter.session.v2", mode: "compact" } });
    expect(await allowed).toBe(0);
    expect(allowedTarget.written).toHaveLength(1);
    expect(allowedTarget.written[0]!.opts?.mode).toBe("network-compact+repo-mismatch-allowed+missing-commit-allowed");
    expect(allowedErrors.join("\n")).toContain("Repository binding preview");
  });

  test("receive rechecks repository identity after preview and before writing", async () => {
    const repository = repositoryFixture();
    const payload = new TextEncoder().encode(serializeSessionTransferPayload(sanitizeSessionForNetwork(session("source")), repository));
    const target = new MockAdapter({ id: "codex" });
    const output: string[] = [];
    const errors: string[] = [];
    let checks = 0;
    const targetRoot = "/target/repository";
    const ctx: Ctx = {
      ...h.ctx,
      out: (line) => output.push(line),
      err: (line) => errors.push(line),
      registry: new StaticAdapterRegistry([{ instanceId: "work", adapter: target }]),
      repositoryBinding: {
        async source() { throw new Error("unexpected source inspection"); },
        async resolve() {
          checks++;
          const preview = {
            schema: REPOSITORY_BINDING_PREVIEW_SCHEMA,
            sourceRepository: "github.com/example/project",
            sourceCommit: repository.commit,
            sourceBranch: repository.branch,
            targetRepository: "github.com/example/project",
            targetRemote: `${checks === 1 ? "ssh" : "https"}://github.com/example/project`,
            targetRoot,
            targetCwd: targetRoot,
            targetHead: "c".repeat(40),
            relativeCwd: "",
            match: "exact" as const,
            commitAvailable: true,
            targetWorktreeDirty: false,
            overrides: { repositoryMismatch: false, missingCommit: false },
            writes: false as const,
          };
          return {
            preview,
            targetCwd: targetRoot,
            git: { sha: repository.commit, branch: repository.branch, remote: "https://github.com/example/project" },
            provenanceModeSuffix: "",
          };
        },
      },
    };
    const receiving = run([
      "receive", "--to", "codex@work", "--cwd", targetRoot, "--bind", "127.0.0.1", "--advertise", "127.0.0.1", "--ttl", "30s", "--yes",
    ], ctx);
    await Bun.sleep(0);
    const locator = output.find((line) => line.startsWith("sinter://"));
    await expect(sendTransfer(locator!, payload, { metadata: { schema: "sinter.session.v2", mode: "compact" } }))
      .rejects.toThrow("receiver_rejected_transfer");
    expect(await receiving).toBe(1);
    expect(checks).toBe(2);
    expect(errors.join("\n")).toContain("target repository changed after preview");
    expect(target.written).toHaveLength(0);
  });
});

describe("capabilities", () => {
  test("renders the canonical support matrix without touching the ledger", async () => {
    expect(await run(["capabilities"], h.ctx)).toBe(0);
    expect(h.out()).toContain("HARNESS");
    expect(h.out()).toContain("claude");
    expect(h.out()).toContain("zcode");
    expect(h.out()).toContain("adapter package unavailable");
    expect(h.ledger.list()).toHaveLength(0);
  });

  test("filters versioned JSON without leaking adapter errors", async () => {
    expect(await run(["capabilities", "--harness", "zcode", "--json"], h.ctx)).toBe(0);
    const result = JSON.parse(h.out());
    expect(result).toMatchObject({
      schema: "sinter.capabilities.v1",
      capabilities: [
        {
          harness: "zcode",
          adapter: "unavailable",
          store: "not-checked",
          read: false,
          write: false,
          resume: "unavailable",
        },
      ],
    });
    expect(h.out()).not.toContain("cannot find module");
  });
});

describe("ghost housekeeping", () => {
  function seedGhosts() {
    h.ledger.upsert(summary({ nativeId: "ghost-plain", ghost: true, title: "disposable" }));
    h.ledger.upsert(summary({ nativeId: "ghost-named", ghost: true, title: "named" }));
    h.ledger.upsert(summary({ nativeId: "ghost-pinned", ghost: true, title: "pinned" }));
    h.ledger.upsert(summary({ nativeId: "ghost-noted", ghost: true, title: "noted" }));
    h.ledger.upsert(summary({ nativeId: "ghost-tagged", ghost: true, title: "tagged" }));
    h.ledger.setAlias("claude", "ghost-named", "keep this alias");
    h.ledger.setPinned("claude", "ghost-pinned", true, "2026-07-01T00:00:00.000Z");
    h.ledger.setNote("claude", "ghost-noted", "keep this note");
    h.ledger.addTags("claude", "ghost-tagged", ["keep-tag"]);
    h.ledger.recordLineage({ harness: "claude", nativeId: "ghost-plain", threadId: "ghost-thread", hop: 0 });
    h.ledger.db.run("UPDATE sessions SET scanned_at = '2026-07-01T00:00:00.000Z' WHERE native_id LIKE 'ghost-%'");
  }

  test("previews eligible and protected ghosts without changing the ledger", async () => {
    seedGhosts();
    expect(await run(["ghosts", "--json"], h.ctx)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({
      schema: "sinter.ghosts.v1",
      action: "preview",
      olderThan: "30d",
      eligible: 1,
      protected: 4,
      removed: 0,
    });
    expect(h.ledger.get("claude", "ghost-plain")).toBeDefined();
  });

  test("requires explicit confirmation and preserves local metadata and lineage", async () => {
    seedGhosts();
    expect(await run(["ghosts", "prune"], h.ctx)).toBe(1);
    expect(h.err()).toContain("without --yes");
    expect(h.ledger.get("claude", "ghost-plain")).toBeDefined();

    h.stdout.length = 0;
    h.stderr.length = 0;
    expect(await run(["ghosts", "prune", "--yes", "--json"], h.ctx)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ action: "prune", eligible: 1, protected: 4, removed: 1 });
    expect(h.ledger.get("claude", "ghost-plain")).toBeUndefined();
    expect(h.ledger.get("claude", "ghost-named")?.alias).toBe("keep this alias");
    expect(h.ledger.get("claude", "ghost-pinned")?.pinnedAt).toBeTruthy();
    expect(h.ledger.get("claude", "ghost-noted")?.note).toBe("keep this note");
    expect(h.ledger.get("claude", "ghost-tagged")?.tags).toEqual(["keep-tag"]);
    expect(h.ledger.lineageFor("ghost-thread")).toHaveLength(1);
  });

  test("validates action, age, and harness filters", async () => {
    expect(await run(["ghosts", "destroy"], h.ctx)).toBe(1);
    expect(await run(["ghosts", "--older-than", "someday"], h.ctx)).toBe(1);
    expect(await run(["ghosts", "--harness", "cursor"], h.ctx)).toBe(1);
  });
});

describe("local tags and notes", () => {
  test("adds searchable metadata that survives rescans without changing native stores", async () => {
    await scan();
    expect(await run(["tag", "aaa11111", "#Release", "urgent"], h.ctx)).toBe(0);
    expect(await run(["note", "aaa11111", "follow up after launch"], h.ctx)).toBe(0);
    expect(h.ledger.get("claude", "aaa11111-1111")).toMatchObject({
      tags: ["release", "urgent"],
      note: "follow up after launch",
      title: "porting sessions between harnesses",
    });
    expect(h.ledger.search("urgent")[0]?.nativeId).toBe("aaa11111-1111");
    expect(h.ledger.search("launch")[0]?.nativeId).toBe("aaa11111-1111");
    expect(h.claude.written).toHaveLength(0);

    await scan();
    expect(h.ledger.get("claude", "aaa11111-1111")).toMatchObject({ tags: ["release", "urgent"], note: "follow up after launch" });
    h.stdout.length = 0;
    expect(await run(["search", "urgent"], h.ctx)).toBe(0);
    expect(h.out()).toContain("#release #urgent");
    expect(h.out()).toContain("✎");
  });

  test("lists counts and removes selected or all metadata", async () => {
    await scan();
    await run(["tag", "aaa11111", "work", "urgent"], h.ctx);
    await run(["tag", "aaa22222", "work"], h.ctx);
    h.stdout.length = 0;
    expect(await run(["tags", "--json"], h.ctx)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      schema: "sinter.tags.v1",
      tags: [{ tag: "urgent", sessions: 1 }, { tag: "work", sessions: 2 }],
    });

    expect(await run(["untag", "aaa11111", "urgent"], h.ctx)).toBe(0);
    expect(h.ledger.get("claude", "aaa11111-1111")?.tags).toEqual(["work"]);
    expect(await run(["untag", "aaa11111", "--all"], h.ctx)).toBe(0);
    expect(h.ledger.get("claude", "aaa11111-1111")?.tags).toBeUndefined();
    await run(["note", "aaa11111", "temporary"], h.ctx);
    expect(await run(["note", "aaa11111", "--clear"], h.ctx)).toBe(0);
    expect(h.ledger.get("claude", "aaa11111-1111")?.note).toBeUndefined();
  });

  test("keeps metadata local to the source when porting", async () => {
    await scan();
    await run(["tag", "aaa11111", "private-context"], h.ctx);
    await run(["note", "aaa11111", "do not copy this note"], h.ctx);
    expect(await run(["port", "aaa11111", "--to", "omp"], h.ctx)).toBe(0);
    expect(h.ledger.get("omp", "new-omp-1")?.tags).toBeUndefined();
    expect(h.ledger.get("omp", "new-omp-1")?.note).toBeUndefined();
    expect(h.ledger.get("claude", "aaa11111-1111")).toMatchObject({
      tags: ["private-context"],
      note: "do not copy this note",
    });
  });

  test("validates tag names, note size, and mutually exclusive forms", async () => {
    await scan();
    expect(await run(["tag", "aaa11111", "bad tag"], h.ctx)).toBe(1);
    expect(await run(["untag", "aaa11111"], h.ctx)).toBe(1);
    expect(await run(["untag", "aaa11111", "work", "--all"], h.ctx)).toBe(1);
    expect(await run(["note", "aaa11111"], h.ctx)).toBe(1);
    expect(await run(["note", "aaa11111", "text", "--clear"], h.ctx)).toBe(1);
    expect(await run(["note", "aaa11111", "x".repeat(4001)], h.ctx)).toBe(1);
  });
});

describe("watch mode", () => {
  test("streams versioned snapshots and rescans before every cycle", async () => {
    let slept = 0;
    h.ctx.sleep = async (ms) => {
      expect(ms).toBe(250);
      slept++;
      h.claude.summaries = h.claude.summaries.map((row) =>
        row.nativeId === "aaa11111-1111"
          ? { ...row, title: "changed while watching", updatedAt: "2026-08-13T11:30:00.000Z" }
          : row,
      );
    };
    expect(await run(["watch", "recent", "--count", "2", "--interval", "250ms", "--json"], h.ctx)).toBe(0);
    const snapshots = h.stdout.map((line) => JSON.parse(line));
    expect(slept).toBe(1);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ schema: "sinter.watch.v1", sequence: 1, view: "recent", changed: true });
    expect(snapshots[1]).toMatchObject({ schema: "sinter.watch.v1", sequence: 2, view: "recent", changed: true });
    expect(snapshots[1].sessions[0].title).toBe("changed while watching");
    expect(snapshots[1].scan.harnesses.claude.updated).toBe(1);
  });

  test("defaults pipes to one project snapshot and can watch the cache only", async () => {
    await scan();
    h.stdout.length = 0;
    h.claude.summaries = [];
    expect(await run(["watch", "projects", "--json", "--no-scan"], h.ctx)).toBe(0);
    const snapshot = JSON.parse(h.out());
    expect(snapshot).toMatchObject({
      schema: "sinter.watch.v1",
      sequence: 1,
      view: "projects",
      changed: true,
      scan: { skipped: true },
    });
    expect(snapshot.projects.some((project: { cwd: string }) => project.cwd === "/Users/test/proj")).toBe(true);
  });

  test("does not treat scan bookkeeping as a visible change", async () => {
    h.ctx.sleep = async () => {};
    expect(await run(["watch", "recent", "--count", "2", "--interval", "250ms", "--json"], h.ctx)).toBe(0);
    const snapshots = h.stdout.map((line) => JSON.parse(line));
    expect(snapshots.map((snapshot) => snapshot.changed)).toEqual([true, false]);
  });

  test("redraws interactive terminals unless --no-clear is set", async () => {
    h.ctx.interactive = true;
    h.ctx.sleep = async () => {};
    expect(await run(["watch", "recent", "--count", "2", "--interval", "250ms"], h.ctx)).toBe(0);
    expect(h.stdout[1]).toStartWith("\x1b[2J\x1b[H");

    h.stdout.length = 0;
    expect(await run(["watch", "recent", "--count", "2", "--interval", "250ms", "--no-clear"], h.ctx)).toBe(0);
    expect(h.stdout.join("\n")).not.toContain("\x1b[2J");
  });

  test("validates view, interval, count, and harness", async () => {
    expect(await run(["watch", "threads"], h.ctx)).toBe(1);
    expect(await run(["watch", "--interval", "10ms"], h.ctx)).toBe(1);
    expect(await run(["watch", "--count", "0"], h.ctx)).toBe(1);
    expect(await run(["watch", "--harness", "cursor"], h.ctx)).toBe(1);
  });
});

describe("saved views", () => {
  test("saves, lists, shows, and runs a reusable local filter", async () => {
    await scan();
    h.ledger.upsert(summary({ nativeId: "ghost-view", ghost: true, updatedAt: "2026-08-10T00:00:00.000Z" }));
    h.ledger.upsert(summary({ nativeId: "sub-view", isSubagent: true, updatedAt: "2026-08-10T00:00:00.000Z" }));

    expect(await run(["view", "save", "work", "--harness", "claude", "--cwd", "/Users/test/proj", "--since", "30d", "--limit", "2"], h.ctx)).toBe(0);
    expect(h.out()).toContain("saved view work");

    h.stdout.length = 0;
    expect(await run(["view", "--json"], h.ctx)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({
      schema: "sinter.views.v1",
      views: [{ name: "work", harnesses: ["claude"], since: "30d", limit: 2 }],
    });

    h.stdout.length = 0;
    expect(await run(["view", "show", "work"], h.ctx)).toBe(0);
    expect(h.out()).toContain("harnesses: claude");

    h.stdout.length = 0;
    expect(await run(["view", "run", "work", "--json"], h.ctx)).toBe(0);
    const result = JSON.parse(h.out());
    expect(result.schema).toBe("sinter.view.v1");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].nativeId).toBe("aaa11111-1111");
    expect(result.sessions.map((row: { nativeId: string }) => row.nativeId)).not.toContain("ghost-view");
    expect(result.sessions.map((row: { nativeId: string }) => row.nativeId)).not.toContain("sub-view");

    h.stdout.length = 0;
    expect(await run(["view", "run", "work", "--all-harnesses", "--all-cwd", "--all-time", "--limit", "100", "--json"], h.ctx)).toBe(0);
    const unscoped = JSON.parse(h.out());
    expect(unscoped.effective.harness).toBeUndefined();
    expect(unscoped.effective.cwd).toBeUndefined();
    expect(unscoped.effective.since).toBeUndefined();
    expect(unscoped.sessions).toHaveLength(4);
  });

  test("explicit run flags override saved filters", async () => {
    await scan();
    await run(["view", "save", "recent", "--harness", "claude", "--limit", "1"], h.ctx);
    h.stdout.length = 0;
    expect(await run(["view", "run", "recent", "--harness", "omp", "--limit", "5", "--json"], h.ctx)).toBe(0);
    const result = JSON.parse(h.out());
    expect(result.effective).toMatchObject({ harness: ["omp"], limit: 5 });
    expect(result.sessions.map((row: { nativeId: string }) => row.nativeId)).toEqual(["omp-1"]);
  });

  test("protects names from accidental replacement and deletes explicitly", async () => {
    expect(await run(["view", "save", "daily"], h.ctx)).toBe(0);
    expect(await run(["view", "save", "DAILY"], h.ctx)).toBe(1);
    expect(h.err()).toContain("use --force");
    h.stderr.length = 0;
    expect(await run(["view", "save", "DAILY", "--harness", "pi", "--force"], h.ctx)).toBe(0);
    expect(h.ledger.getView("daily")?.harnesses).toEqual(["pi"]);
    expect(await run(["view", "delete", "daily"], h.ctx)).toBe(0);
    expect(h.ledger.getView("daily")).toBeUndefined();
    expect(await run(["view", "delete", "daily"], h.ctx)).toBe(1);
  });

  test("validates names, filters, and conflicting overrides", async () => {
    expect(await run(["view", "save", "bad name"], h.ctx)).toBe(1);
    expect(await run(["view", "save", "bad-age", "--since", "later"], h.ctx)).toBe(1);
    expect(await run(["view", "save", "bad-limit", "--limit", "0"], h.ctx)).toBe(1);
    await run(["view", "save", "valid"], h.ctx);
    expect(await run(["view", "run", "valid", "--ghosts", "--no-ghosts"], h.ctx)).toBe(1);
    expect(await run(["view", "run", "valid", "--harness", "pi", "--all-harnesses"], h.ctx)).toBe(1);
    expect(await run(["view", "unknown"], h.ctx)).toBe(1);
  });
});

describe("config", () => {
  test("shows and validates every profile without touching the ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinter-config-"));
    const config = join(dir, "config.toml");
    writeFileSync(
      config,
      `[profiles.personal.stores]\nclaude = "/tmp/claude"\n\n[profiles.work.stores]\ncodex = "/tmp/codex"\ndevin = "/tmp/devin.db"\n`,
    );
    try {
      expect(await run(["config", "show", "--config", config], h.ctx)).toBe(0);
      expect(h.out()).toContain("PROFILE");
      expect(h.out()).toContain("personal");
      expect(h.out()).toContain("/tmp/codex");
      expect(h.ledger.list()).toHaveLength(0);

      h.stdout.length = 0;
      expect(await run(["config", "validate", "--config", config, "--json"], h.ctx)).toBe(0);
      expect(JSON.parse(h.out())).toMatchObject({ valid: true, profiles: 2, stores: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prints the resolved path even before a config file exists", async () => {
    expect(await run(["config", "path", "--config", "/tmp/not-created-sinter.toml"], h.ctx)).toBe(0);
    expect(h.out()).toBe("/tmp/not-created-sinter.toml");
  });

  test("prints an editable example without requiring or touching a config file", async () => {
    const missing = "/tmp/not-created-sinter-example.toml";
    expect(await run(["config", "example", "--config", missing], h.ctx)).toBe(0);
    expect(h.out()).toContain("[profiles.default]");
    expect(h.out()).toContain("include_defaults = true");
    expect(h.err()).toBe("");
  });

  test("validation catches an unknown harness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinter-config-bad-"));
    const config = join(dir, "config.toml");
    writeFileSync(config, `[profiles.work.stores]\ncursor = "/tmp/cursor"\n`);
    try {
      expect(await run(["config", "validate", "--config", config], h.ctx)).toBe(1);
      expect(h.err()).toContain("unknown harness: cursor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("setup", () => {
  test("--yes detects and scans without opening the menu", async () => {
    expect(await run(["setup", "--yes"], h.ctx)).toBe(0);
    expect(h.out()).toContain("Detected local stores:");
    expect(h.out()).toContain("claude:");
    expect(h.ledger.list()).toHaveLength(4);
  });

  test("leaves the ledger untouched when confirmation declines", async () => {
    h.ctx.confirm = async () => false;
    expect(await run(["setup"], h.ctx)).toBe(0);
    expect(h.out()).toContain("Setup cancelled");
    expect(h.ledger.list()).toHaveLength(0);
  });
});

describe("scan", () => {
  test("populates the ledger and reports per-harness counts", async () => {
    expect(await scan()).toBe(0);
    expect(h.out()).toContain("claude");
    expect(h.out()).toMatch(/claude\s+3\s+3/);
    expect(h.ledger.list()).toHaveLength(4);
  });

  test("names unavailable adapters on stderr without failing", async () => {
    expect(await scan()).toBe(0);
    expect(h.err()).toContain("adapter not available: zcode");
  });

  test("--json emits a versioned scan result without human table output", async () => {
    expect(await run(["scan", "--json"], h.ctx)).toBe(0);
    const result = JSON.parse(h.out());
    expect(result).toMatchObject({ schema: "sinter.scan.v1", ok: true });
    expect(result.harnesses.claude).toMatchObject({ seen: 3, inserted: 3 });
    expect(result.unavailable).toEqual([{ harness: "zcode" }]);
    expect(h.err()).toBe("");
  });

  test("a throwing adapter is an error exit but the others still scan", async () => {
    h.omp.throwOnList = "*";
    expect(await scan()).toBe(1);
    expect(h.err()).toContain("scan error [omp]");
    expect(h.ledger.list({ harness: "claude" })).toHaveLength(3);
  });

  test("with no adapters at all it errors clearly", async () => {
    h.ctx.registry = new StaticAdapterRegistry([], { claude: "not installed" });
    expect(await scan()).toBe(1);
    expect(h.err()).toContain("no adapters available");
  });
});

describe("ls", () => {
  test("tabulates newest first with short ids and ~-shortened cwd", async () => {
    await scan();
    expect(await run(["ls"], h.ctx)).toBe(0);
    const out = h.out();
    expect(out).toContain("HARNESS");
    expect(out).toContain("aaa11111");
    expect(out).toContain("porting sessions between harnesses");
    expect(out.split("\n").every((l) => l.length <= 100)).toBe(true);
  });

  test("filters by harness, cwd, since and limit", async () => {
    await scan();
    h.stdout.length = 0;
    await run(["ls", "--harness", "omp"], h.ctx);
    expect(h.out()).toContain("omp session");
    expect(h.out()).not.toContain("porting sessions");

    h.stdout.length = 0;
    await run(["ls", "--cwd", "/Users/test/other"], h.ctx);
    expect(h.out()).toContain("unrelated work");
    expect(h.out()).not.toContain("porting sessions");

    h.stdout.length = 0;
    await run(["ls", "--since", "7d"], h.ctx);
    expect(h.out()).not.toContain("old thing");

    h.stdout.length = 0;
    await run(["ls", "--limit", "1"], h.ctx);
    expect(h.out().split("\n")).toHaveLength(2); // header + 1
  });

  test("--json dumps rows", async () => {
    await scan();
    h.stdout.length = 0;
    await run(["ls", "--json", "--limit", "1"], h.ctx);
    const rows = JSON.parse(h.out());
    expect(rows[0].nativeId).toBeTruthy();
  });

  test("bad flags and values are exit 1", async () => {
    expect(await run(["ls", "--bogus"], h.ctx)).toBe(1);
    expect(await run(["ls", "--limit", "0"], h.ctx)).toBe(1);
    expect(await run(["ls", "--harness", "cursor"], h.ctx)).toBe(1);
  });
});

describe("recent", () => {
  test("lists resumable parent sessions with a compact default limit", async () => {
    await scan();
    h.claude.summaries = h.claude.summaries.filter((s) => s.nativeId !== "bbb33333-3333");
    await scan();
    h.stdout.length = 0;
    expect(await run(["recent"], h.ctx)).toBe(0);
    expect(h.out()).toContain("porting sessions between harnesses");
    expect(h.out()).not.toContain("old thing");
  });

  test("keeps the useful ls filters and JSON output", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["recent", "--cwd", "/Users/test/other", "--json"], h.ctx)).toBe(0);
    const rows = JSON.parse(h.out());
    expect(rows.map((row: { nativeId: string }) => row.nativeId)).toEqual(["aaa22222-2222"]);
  });
});

describe("session pins", () => {
  test("pins, lists, and unpins a session without modifying the adapter", async () => {
    await scan();
    const before = structuredClone(h.claude.summaries);
    expect(await run(["pin", "aaa11111"], h.ctx)).toBe(0);
    expect(h.out()).toContain("pinned claude:aaa11111");
    expect(h.ledger.get("claude", "aaa11111-1111")!.pinnedAt).toBeTruthy();
    expect(h.claude.summaries).toEqual(before);

    h.stdout.length = 0;
    expect(await run(["pinned"], h.ctx)).toBe(0);
    expect(h.out()).toContain("★");
    expect(h.out()).toContain("porting sessions between harnesses");
    expect(h.out()).not.toContain("unrelated work");

    h.stdout.length = 0;
    expect(await run(["unpin", "aaa11111"], h.ctx)).toBe(0);
    expect(h.out()).toContain("unpinned claude:aaa11111");
    expect(h.ledger.get("claude", "aaa11111-1111")!.pinnedAt).toBeUndefined();
  });

  test("offers filtered, versioned JSON and survives rescans", async () => {
    await scan();
    await run(["pin", "aaa11111"], h.ctx);
    await run(["pin", "omp:omp-1"], h.ctx);
    await scan();
    h.stdout.length = 0;
    h.stderr.length = 0;
    expect(await run(["pinned", "--harness", "omp", "--json"], h.ctx)).toBe(0);
    const result = JSON.parse(h.out());
    expect(result.schema).toBe("sinter.pinned.v1");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ harness: "omp", nativeId: "omp-1" });
    expect(result.sessions[0].pinnedAt).toBeTruthy();
    expect(h.err()).toBe("");
  });

  test("is idempotent and reports usage and resolution errors", async () => {
    await scan();
    expect(await run(["pin", "aaa11111"], h.ctx)).toBe(0);
    expect(await run(["pin", "aaa11111"], h.ctx)).toBe(0);
    expect(h.ledger.list({ pinnedOnly: true })).toHaveLength(1);
    h.stderr.length = 0;
    expect(await run(["pin"], h.ctx)).toBe(1);
    expect(h.err()).toContain("usage: sinter pin");
    h.stderr.length = 0;
    expect(await run(["unpin", "missing"], h.ctx)).toBe(2);
    expect(h.err()).toContain("no session matches");
  });
});

describe("projects", () => {
  test("groups resumable sessions by cwd with a versioned JSON contract", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["projects", "--json"], h.ctx)).toBe(0);
    const result = JSON.parse(h.out());
    expect(result.schema).toBe("sinter.projects.v1");
    expect(result.projects).toContainEqual({
      cwd: "/Users/test/proj",
      sessionCount: 3,
      messageCount: 12,
      messageCountSessions: 3,
      harnesses: ["claude", "omp"],
      latestAt: "2026-08-01T01:00:00.000Z",
    });
  });

  test("filters before grouping and renders a compact project table", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["projects", "--harness", "omp", "--limit", "1"], h.ctx)).toBe(0);
    expect(h.out()).toContain("PROJECT");
    expect(h.out()).toContain("/Users/test/proj");
    expect(h.out()).toContain("omp");
    expect(h.out()).not.toContain("/Users/test/other");
  });

  test("rejects an invalid project limit", async () => {
    expect(await run(["projects", "--limit", "0"], h.ctx)).toBe(1);
    expect(h.err()).toContain("bad --limit");
  });
});

describe("last", () => {
  test("prints the native resume command for the newest matching session", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["last", "--cwd", "/Users/test/other"], h.ctx)).toBe(0);
    expect(h.out()).toContain("claude --resume aaa22222-2222");
  });

  test("supports script-safe ids and explicit execution", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["last", "--cwd", "/Users/test/other", "--id"], h.ctx)).toBe(0);
    expect(h.out()).toBe("claude:aaa22222-2222");

    h.stdout.length = 0;
    expect(await run(["last", "--cwd", "/Users/test/other", "--exec"], h.ctx)).toBe(0);
    expect(h.execed).toEqual([["claude", "--resume", "aaa22222-2222"]]);
  });

  test("fails clearly when filters match nothing", async () => {
    await scan();
    expect(await run(["last", "--cwd", "/nowhere"], h.ctx)).toBe(2);
    expect(h.err()).toContain("no recent sessions matched");
  });
});

describe("search", () => {
  test("FTS matches titles and prints the same table", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["search", "porting"], h.ctx)).toBe(0);
    expect(h.out()).toContain("aaa11111");
    expect(h.out()).not.toContain("unrelated work");
  });

  test("needs a query", async () => {
    expect(await run(["search"], h.ctx)).toBe(1);
    expect(h.err()).toContain("usage: sinter search");
  });
});

describe("rename", () => {
  test("sets a searchable local alias that survives rescans", async () => {
    await scan();
    expect(await run(["rename", "aaa11111", "Important review"], h.ctx)).toBe(0);
    expect(h.ledger.get("claude", "aaa11111-1111")!.alias).toBe("Important review");
    await scan();
    expect(h.ledger.get("claude", "aaa11111-1111")!.alias).toBe("Important review");
    h.stdout.length = 0;
    expect(await run(["search", "Important review"], h.ctx)).toBe(0);
    expect(h.out()).toContain("Important review");
  });

  test("clears aliases explicitly and rejects a missing alias", async () => {
    await scan();
    await run(["rename", "aaa11111", "Temporary"], h.ctx);
    expect(await run(["rename", "aaa11111", "--clear"], h.ctx)).toBe(0);
    expect(h.ledger.get("claude", "aaa11111-1111")!.alias).toBeUndefined();
    expect(await run(["rename", "aaa11111"], h.ctx)).toBe(1);
  });
});

describe("show", () => {
  test("renders a transcript for a prefix", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["show", "aaa11111"], h.ctx)).toBe(0);
    expect(h.out()).toContain("● assistant");
    expect(h.out()).toContain("→ Read(");
  });

  test("ambiguous prefixes exit 2 and list candidates", async () => {
    await scan();
    expect(await run(["show", "aaa"], h.ctx)).toBe(2);
    expect(h.err()).toContain("ambiguous");
    expect(h.err()).toContain("aaa11111");
    expect(h.err()).toContain("aaa22222");
  });

  test("unknown prefixes exit 2", async () => {
    await scan();
    expect(await run(["show", "zzzz"], h.ctx)).toBe(2);
    expect(h.err()).toContain("no session matches");
  });

  test("harness-scoped ids resolve", async () => {
    await scan();
    expect(await run(["show", "omp:omp-1"], h.ctx)).toBe(0);
  });

  test("--json dumps SIF", async () => {
    await scan();
    h.stdout.length = 0;
    await run(["show", "aaa11111", "--json"], h.ctx);
    const s = JSON.parse(h.out());
    expect(s.sif).toBe("sif/0");
    expect(s.entries).toHaveLength(3);
  });

  test("--ndjson streams versioned metadata followed by ordered entries", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["show", "aaa11111", "--ndjson"], h.ctx)).toBe(0);
    const records = h.stdout.map((line) => JSON.parse(line));
    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({
      schema: "sinter.transcript.ndjson.v1",
      type: "session",
      session: { id: "sif-aaa11111-1111" },
    });
    expect(records[0].session).not.toHaveProperty("entries");
    expect(records.slice(1).map((record) => [record.type, record.index])).toEqual([
      ["entry", 0],
      ["entry", 1],
      ["entry", 2],
    ]);
  });

  test("--ndjson uses versioned errors and cannot be combined with --json", async () => {
    await scan();
    h.stderr.length = 0;
    expect(await run(["show", "zzzz", "--ndjson"], h.ctx)).toBe(2);
    expect(JSON.parse(h.err())).toMatchObject({
      schema: "sinter.error.v1",
      ok: false,
      error: { code: 2, kind: "resolution" },
    });

    h.stderr.length = 0;
    expect(await run(["show", "aaa11111", "--json", "--ndjson"], h.ctx)).toBe(1);
    expect(JSON.parse(h.err())).toMatchObject({
      schema: "sinter.error.v1",
      error: { code: 1, kind: "usage", message: "choose one output mode: --json or --ndjson" },
    });
  });

  test("--tail renders only the latest entries and keeps the full count visible", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["show", "aaa11111", "--tail", "1"], h.ctx)).toBe(0);
    expect(h.out()).toContain("3 entries");
    expect(h.out()).toContain("showing last 1 entry");
    expect(h.out()).toContain("line1");
    expect(h.out()).not.toContain("hello world");
    expect(h.out()).not.toContain("● assistant");
  });

  test("--tail validates its count and refuses incomplete machine output", async () => {
    await scan();
    for (const value of ["0", "1.5", "many"]) {
      h.stderr.length = 0;
      expect(await run(["show", "aaa11111", "--tail", value], h.ctx)).toBe(1);
      expect(h.err()).toContain(`bad --tail: ${value}`);
    }
    for (const mode of ["--json", "--ndjson"]) {
      h.stderr.length = 0;
      expect(await run(["show", "aaa11111", "--tail", "1", mode], h.ctx)).toBe(1);
      expect(JSON.parse(h.err())).toMatchObject({
        schema: "sinter.error.v1",
        error: {
          kind: "usage",
          message: "--tail is for rendered output and cannot be combined with --json or --ndjson",
        },
      });
    }
  });

  test("an unavailable adapter is reported, not crashed", async () => {
    await scan();
    h.ledger.upsert(summary({ nativeId: "zc-1", harness: "zcode" }));
    expect(await run(["show", "zc-1"], h.ctx)).toBe(1);
    expect(h.err()).toContain("adapter not available: zcode");
  });
});

describe("compare", () => {
  test("emits a versioned structural comparison without transcript content", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["compare", "aaa11111", "omp:omp-1", "--json"], h.ctx)).toBe(0);
    const result = JSON.parse(h.out());
    expect(result).toMatchObject({
      schema: "sinter.compare.v1",
      left: { origin: { harness: "claude", nativeId: "aaa11111-1111" }, entries: 3 },
      right: { origin: { harness: "omp", nativeId: "omp-1" }, entries: 3 },
      delta: { entries: 0 },
    });
    expect(h.out()).not.toContain("hello world");
    expect(h.out()).not.toContain("hi there");
  });

  test("renders right-minus-left deltas with an explicit interpretation warning", async () => {
    await scan();
    h.omp.sessions["omp-1"]!.entries.pop();
    h.stdout.length = 0;
    expect(await run(["compare", "aaa11111", "omp:omp-1"], h.ctx)).toBe(0);
    expect(h.out()).toContain("entry:toolResult");
    expect(h.out()).toContain("-1");
    expect(h.err()).toContain("matching counts do not prove semantic equivalence");
  });

  test("requires exactly two resolvable session ids", async () => {
    expect(await run(["compare", "aaa11111"], h.ctx)).toBe(1);
    expect(h.err()).toContain("usage: sinter compare");
    h.stderr.length = 0;
    expect(await run(["compare", "missing", "omp:omp-1", "--json"], h.ctx)).toBe(2);
    expect(JSON.parse(h.err())).toMatchObject({ schema: "sinter.error.v1", error: { kind: "resolution" } });
  });
});

describe("export", () => {
  test("writes SIF to a file", async () => {
    await scan();
    expect(await run(["export", "aaa11111", "-o", "/tmp/x.sif.json"], h.ctx)).toBe(0);
    const s = JSON.parse(h.written["/tmp/x.sif.json"]!);
    expect(s.origin.nativeId).toBe("aaa11111-1111");
    expect(s.entries[0].raw).toBeDefined();
  });

  test("--slim strips raw", async () => {
    await scan();
    await run(["export", "aaa11111", "--slim", "-o", "/tmp/slim.json"], h.ctx);
    const s = JSON.parse(h.written["/tmp/slim.json"]!);
    expect(s.entries[0].raw).toBeUndefined();
  });

  test("without -o it goes to stdout", async () => {
    await scan();
    h.stdout.length = 0;
    await run(["export", "aaa11111"], h.ctx);
    expect(JSON.parse(h.out()).sif).toBe("sif/0");
  });
});

describe("import", () => {
  test("validates then writes into the target harness and prints the resume command", async () => {
    h.files["/tmp/in.json"] = JSON.stringify(session("src-1"));
    expect(await run(["import", "/tmp/in.json", "--to", "omp"], h.ctx)).toBe(0);
    expect(h.omp.written).toHaveLength(1);
    expect(h.omp.written[0]!.opts?.mode).toBe("full");
    expect(h.out()).toContain("omp:new-omp-1");
    expect(h.out()).toContain("omp --resume new-omp-1");
    expect(h.err()).toContain("wrote omp:new-omp-1");
  });

  test("passes cwd / --live-tools / --dry-run through to the writer", async () => {
    h.files["/tmp/in.json"] = JSON.stringify(session("src-1"));
    await run(
      ["import", "/tmp/in.json", "--to", "omp", "--cwd", "/tmp/target", "--live-tools", "--dry-run"],
      h.ctx,
    );
    expect(h.omp.written[0]!.opts).toMatchObject({
      cwd: "/tmp/target",
      liveTools: true,
      dryRun: true,
    });
    expect(h.err()).toContain("would write");
  });

  test("invalid SIF is rejected", async () => {
    const bad = session("bad");
    (bad.entries[0] as { content: { type: "text"; text: string }[] }).content = [{ type: "text", text: "" }];
    h.files["/tmp/bad.json"] = JSON.stringify(bad);
    expect(await run(["import", "/tmp/bad.json", "--to", "omp"], h.ctx)).toBe(1);
    expect(h.err()).toContain("invalid SIF session");
  });

  test("missing file / missing --to are errors", async () => {
    expect(await run(["import", "/tmp/nope.json", "--to", "omp"], h.ctx)).toBe(1);
    expect(h.err()).toContain("cannot read SIF file");
    h.files["/tmp/in.json"] = JSON.stringify(session("src-1"));
    expect(await run(["import", "/tmp/in.json"], h.ctx)).toBe(1);
    expect(h.err()).toContain("needs --to");
  });

  test("an unavailable target adapter degrades", async () => {
    h.files["/tmp/in.json"] = JSON.stringify(session("src-1"));
    expect(await run(["import", "/tmp/in.json", "--to", "zcode"], h.ctx)).toBe(1);
    expect(h.err()).toContain("adapter not available: zcode");
  });
});

describe("port", () => {
  test("reads from one harness and writes into another", async () => {
    await scan();
    expect(await run(["port", "aaa11111", "--to", "omp"], h.ctx)).toBe(0);
    expect(h.omp.written[0]!.session.origin.nativeId).toBe("aaa11111-1111");
    expect(h.out()).toContain("omp --resume new-omp-1");
    expect(h.err()).toContain("porting claude:aaa11111-111 → omp");
  });

  test("carries a Sinter alias into the target native title", async () => {
    await scan();
    h.ledger.setAlias("claude", "aaa11111-1111", "Review complete");
    await run(["port", "aaa11111", "--to", "omp"], h.ctx);
    expect(h.omp.written[0]!.session.title).toEqual({ text: "Review complete", source: "user" });
  });

  test("ambiguity still exits 2", async () => {
    await scan();
    expect(await run(["port", "aaa", "--to", "omp"], h.ctx)).toBe(2);
  });

  test("supports the same transfer modes as the interactive menu", async () => {
    await scan();
    expect(await run(["port", "aaa11111", "--to", "omp", "--mode", "slim"], h.ctx)).toBe(0);
    expect(h.omp.written[0]!.session.entries.every((entry) => entry.raw === undefined)).toBe(true);
    expect(await run(["port", "aaa11111", "--to", "omp", "--mode", "mystery"], h.ctx)).toBe(1);
    expect(h.err()).toContain("unknown --mode");
  });

  test("previews transfer impact without invoking the target writer", async () => {
    await scan();
    h.stdout.length = 0;
    h.stderr.length = 0;
    const beforeRows = h.ledger.list().length;
    expect(await run(["port", "aaa11111", "--to", "omp", "--mode", "compact", "--preview"], h.ctx)).toBe(0);
    expect(h.out()).toContain("Port preview");
    expect(h.out()).toContain("none — preview only");
    expect(h.out()).toContain("compact");
    expect(h.omp.written).toHaveLength(0);
    expect(h.ledger.list()).toHaveLength(beforeRows);
    expect(h.err()).toBe("");
  });

  test("offers stable JSON preview output", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["port", "aaa11111", "--to", "omp", "--mode", "slim", "--preview", "--json"], h.ctx)).toBe(0);
    const preview = JSON.parse(h.out());
    expect(preview).toMatchObject({
      source: { harness: "claude", nativeId: "aaa11111-1111" },
      target: { harness: "omp", adapter: "write-capable", store: "detected" },
      mode: "slim",
      historicalTools: "inert",
      writes: false,
    });
    expect(preview.payload.bytesAfter).toBeLessThan(preview.payload.bytesBefore);
    expect(h.omp.written).toHaveLength(0);
  });

  test("auto preview selects the least destructive mode that fits the target", async () => {
    Object.assign(h.omp, {
      async planWrite(_session: SifSession, opts?: WriteOpts): Promise<WritePlan> {
        const before = opts?.mode === "compact" ? 90 : 150;
        return { context: { unit: "bytes", limit: 100, before, after: before, omittedEntries: 0, strategy: "none" } };
      },
    });
    await scan();
    h.stdout.length = 0;
    expect(await run(["port", "aaa11111", "--to", "omp", "--preview", "--json"], h.ctx)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({
      requestedMode: "auto",
      mode: "compact",
      selection: "fits",
      targetContext: { unit: "bytes", limit: 100, before: 90, after: 90 },
      writes: false,
    });
    expect(h.omp.written).toHaveLength(0);
  });

  test("auto writes the planned compact session and records its concrete mode", async () => {
    Object.assign(h.omp, {
      async planWrite(_session: SifSession, opts?: WriteOpts): Promise<WritePlan> {
        const compact = opts?.mode === "compact";
        return {
          context: {
            unit: "bytes",
            limit: 100,
            before: compact ? 130 : 180,
            after: compact ? 90 : 95,
            omittedEntries: compact ? 4 : 10,
            strategy: "opening-and-tail",
          },
        };
      },
    });
    await scan();
    expect(await run(["port", "aaa11111", "--to", "omp"], h.ctx)).toBe(0);
    expect(h.omp.written[0]!.opts?.mode).toBe("compact");
    expect(h.omp.written[0]!.session.entries[0]).toMatchObject({ noteType: "sinter_compaction" });
    expect(h.err()).toContain("auto → compact");
    expect(h.err()).toContain("target will omit 4");
  });
});

describe("feedback", () => {
  test("prints a safe prefilled issue URL when browser opening is disabled", async () => {
    h.ctx.version = "0.1.9";
    expect(await run(["feedback", "--title", "Something broke", "--no-open"], h.ctx)).toBe(0);
    expect(h.out()).toContain("https://github.com/jensenloke/sinter/issues/new?");
    const encoded = h.out().split("\n").at(-1)!;
    const body = new URL(encoded).searchParams.get("body")!;
    expect(body).toContain("Sinter: 0.1.9");
    expect(body).not.toContain("/Users/test");
    expect(body).not.toContain("aaa11111");
  });
});

describe("resume", () => {
  test("same harness just prints the native command", async () => {
    await scan();
    expect(await run(["resume", "aaa11111"], h.ctx)).toBe(0);
    expect(h.out()).toContain("claude --resume aaa11111-1111");
    expect(h.omp.written).toHaveLength(0);
  });

  test("--in another harness ports first, then prints the target command", async () => {
    await scan();
    expect(await run(["resume", "aaa11111", "--in", "omp"], h.ctx)).toBe(0);
    expect(h.omp.written).toHaveLength(1);
    expect(h.out()).toContain("omp --resume new-omp-1");
  });

  test("cross-harness resume uses the same automatic fitting plan", async () => {
    Object.assign(h.omp, {
      async planWrite(_session: SifSession, opts?: WriteOpts): Promise<WritePlan> {
        const before = opts?.mode === "compact" ? 90 : 150;
        return { context: { unit: "bytes", limit: 100, before, after: before, omittedEntries: 0, strategy: "none" } };
      },
    });
    await scan();
    expect(await run(["resume", "aaa11111", "--in", "omp"], h.ctx)).toBe(0);
    expect(h.omp.written[0]!.opts?.mode).toBe("compact");
    expect(h.err()).toContain("auto → compact");
  });

  test("--in the origin harness is a no-op port", async () => {
    await scan();
    await run(["resume", "aaa11111", "--in", "claude"], h.ctx);
    expect(h.out()).toContain("claude --resume aaa11111-1111");
  });

  test("--exec spawns instead of printing", async () => {
    await scan();
    expect(await run(["resume", "aaa11111", "--exec"], h.ctx)).toBe(0);
    expect(h.execed).toEqual([["claude", "--resume", "aaa11111-1111"]]);
  });

  test("resuming a ghost row in place is refused", async () => {
    await scan();
    h.claude.summaries = h.claude.summaries.filter((s) => s.nativeId !== "aaa11111-1111");
    await scan();
    expect(await run(["resume", "aaa11111"], h.ctx)).toBe(2);
    expect(h.err()).toContain("ghost row");
  });
});

describe("doctor", () => {
  test("lists detected stores, versions, ledger counts and unavailable adapters", async () => {
    await scan();
    h.stdout.length = 0;
    expect(await run(["doctor"], h.ctx)).toBe(0);
    const out = h.out();
    expect(out).toContain("claude");
    expect(out).toContain("0.0.0-mock");
    expect(out).toContain("unavailable adapters:");
    expect(out).toContain("zcode: cannot find module");
    expect(out).toContain("ledger:");
  });

  test("an absent store is reported, not fatal", async () => {
    h.omp = new MockAdapter({ id: "omp", detect: null });
    h.ctx.registry = new StaticAdapterRegistry([h.claude, h.omp]);
    expect(await run(["doctor"], h.ctx)).toBe(0);
    expect(h.out()).toContain("absent");
  });

  test("a throwing detect() is caught", async () => {
    const broken = new MockAdapter({ id: "pi" });
    broken.detect = async () => {
      throw new Error("store corrupt");
    };
    h.ctx.registry = new StaticAdapterRegistry([broken]);
    expect(await run(["doctor"], h.ctx)).toBe(0);
    expect(h.out()).toContain("detect failed: store corrupt");
  });

  test("--json emits versioned, privacy-safe health data", async () => {
    await scan();
    h.stdout.length = 0;
    h.stderr.length = 0;
    expect(await run(["doctor", "--json"], h.ctx)).toBe(0);
    const result = JSON.parse(h.out());
    expect(result).toMatchObject({ schema: "sinter.doctor.v1", ok: true, ledgerAvailable: true });
    expect(result.harnesses).toContainEqual(expect.objectContaining({ harness: "claude", store: "ok", ledgerSessions: 3 }));
    expect(h.out()).not.toContain("/tmp/mock");
    expect(h.out()).not.toContain("aaa11111");
  });

  test("--report emits reviewable diagnostics without private session data", async () => {
    await scan();
    h.stdout.length = 0;
    h.stderr.length = 0;
    h.ctx.version = "0.1.10-test";
    expect(await run(["doctor", "--report"], h.ctx)).toBe(0);
    const report = h.out();
    expect(report).toContain("# Sinter diagnostic report");
    expect(report).toContain("Sinter: 0.1.10-test");
    expect(report).toContain("| claude | available | ok | 0.0.0-mock | 3 | 0 |");
    expect(report).toContain("excludes paths, session IDs, prompts, titles, transcripts");
    expect(report).not.toContain("/Users/test");
    expect(report).not.toContain("aaa11111");
    expect(report).not.toContain("porting sessions between harnesses");
    expect(report).not.toContain("/tmp/mock");
  });

  test("writes the safe report to a chosen file and redacts adapter errors", async () => {
    const broken = new MockAdapter({ id: "pi" });
    broken.detect = async () => {
      throw new Error("private failure at /Users/test/secret");
    };
    h.ctx.registry = new StaticAdapterRegistry([broken]);
    expect(await run(["doctor", "--report", "-o", "diagnostics.md"], h.ctx)).toBe(0);
    expect(h.written["diagnostics.md"]).toContain("| pi | available | error |");
    expect(h.written["diagnostics.md"]).not.toContain("private failure");
    expect(h.written["diagnostics.md"]).not.toContain("/Users/test");
    expect(h.err()).toContain("wrote privacy-safe diagnostic report");
  });
});

describe("dispatch", () => {
  test("help and version", async () => {
    expect(await run([], h.ctx)).toBe(0);
    expect(h.out()).toContain("usage: sinter [command]");
    h.stdout.length = 0;
    expect(await run(["--version"], h.ctx)).toBe(0);
    expect(h.out()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  test("per-command --help", async () => {
    expect(await run(["ls", "--help"], h.ctx)).toBe(0);
    expect(h.out()).toContain("usage: sinter");
  });

  test("unknown commands exit 1", async () => {
    expect(await run(["frobnicate"], h.ctx)).toBe(1);
    expect(h.err()).toContain("unknown command: frobnicate");
  });

  test("--json returns versioned error envelopes", async () => {
    expect(await run(["search", "--json"], h.ctx)).toBe(1);
    expect(JSON.parse(h.err())).toEqual({
      schema: "sinter.error.v1",
      ok: false,
      error: { code: 1, kind: "usage", message: "usage: sinter search <query>" },
    });
  });

  test("`list` is an alias for ls", async () => {
    await scan();
    expect(await run(["list", "--limit", "1"], h.ctx)).toBe(0);
  });

  test("prints shell completions without touching the ledger", async () => {
    expect(await run(["completion", "zsh"], h.ctx)).toBe(0);
    expect(h.out()).toContain("#compdef sinter");
    expect(h.ledger.list()).toHaveLength(0);
    h.stdout.length = 0;
    expect(await run(["completion", "powershell"], h.ctx)).toBe(1);
    expect(h.err()).toContain("zsh|bash|fish");
  });
});

describe("immediate resolvability after write (issue #1)", () => {
  /** A real CodexAdapter in a temp home, wired into the CLI registry. */
  function codexHarness(extra: HarnessAdapter[] = []): Harness {
    const base = harness();
    const codex = new CodexAdapter({ home: join(mkdtempSync(join(tmpdir(), "sinter-codex-")), "home") });
    base.ctx.registry = new StaticAdapterRegistry([base.claude, base.omp, codex, ...extra]);
    // expose for tests
    (base as any).codex = codex;
    return base;
  }

  test("port --to codex makes the new target resolvable without a scan", async () => {
    const h2 = codexHarness();
    await scan(h2);
    const src = session("src-1");
    h2.files["/tmp/in.json"] = JSON.stringify(src);
    // import into codex (the real writer): writes a rollout + indexes the thread.
    expect(await run(["import", "/tmp/in.json", "--to", "codex"], h2.ctx)).toBe(0);
    const out = h2.out();
    const m = /codex:(?<id>[0-9a-f-]{8,})/.exec(out);
    expect(m).toBeTruthy();
    const newId = m!.groups!.id;
    // Without a scan, the freshly written target must still resolve.
    const resolved = h2.ledger.resolve(`codex:${newId}`);
    expect(resolved.row).toBeTruthy();
    expect(resolved.row!.nativeId).toBe(newId);
    // and the content round-trips back to a valid session
    const adapter = await h2.ctx.registry.get("codex");
    const back = await adapter.read({ harness: "codex", nativeId: newId, nativePath: resolved.row!.nativePath });
    expect(back.origin.nativeId).toBe(newId);
  });

  test("resume --in codex ports then resolves the target without a scan", async () => {
    const h2 = codexHarness();
    await scan(h2);
    // resume an existing claude session into a fresh codex rollout
    expect(await run(["resume", "aaa11111", "--in", "codex"], h2.ctx)).toBe(0);
    // The resume command line is printed (codex resume <id>) — capture the id
    // from whichever stream it landed on.
    const printed = `${h2.out()}\n${h2.err()}`;
    const m = /codex:(?<id>[0-9a-f-]{8,})/.exec(printed) ?? /resume (?<id>[0-9a-f-]{8,})/.exec(printed);
    expect(m).toBeTruthy();
    const newId = m!.groups!.id;
    const resolved = h2.ledger.resolve(`codex:${newId}`);
    expect(resolved.row).toBeTruthy();
    expect(resolved.row!.nativeId).toBe(newId);
  });
});

describe("auto-scan (always-fresh ledger)", () => {
  test("refreshes the ledger before the command when autoScan is enabled", async () => {
    h.ctx.autoScan = true;
    expect(await run(["ls"], h.ctx)).toBe(0);
    expect(h.ledger.list()).toHaveLength(4);
    expect(h.out()).toContain("porting sessions between harnesses");
  });

  test("keeps stderr clean for JSON output while still refreshing", async () => {
    h.ctx.autoScan = true;
    expect(await run(["ls", "--json", "--limit", "1"], h.ctx)).toBe(0);
    expect(JSON.parse(h.out())).toHaveLength(1);
    expect(h.ledger.list()).toHaveLength(4);
    expect(h.err()).toBe("");
  });

  test("keeps stderr clean for NDJSON output while still refreshing", async () => {
    h.ctx.autoScan = true;
    expect(await run(["show", "aaa11111", "--ndjson"], h.ctx)).toBe(0);
    expect(h.stdout.map((line) => JSON.parse(line))).toHaveLength(4);
    expect(h.ledger.list()).toHaveLength(4);
    expect(h.err()).toBe("");
  });

  test("is disabled when autoScan is not set (hand-built test ctx)", async () => {
    expect(await run(["ls"], h.ctx)).toBe(0);
    expect(h.ledger.list()).toHaveLength(0);
    expect(h.err()).toContain("no sessions matched");
  });

  test("--no-scan skips the automatic refresh", async () => {
    h.ctx.autoScan = true;
    expect(await run(["ls", "--no-scan"], h.ctx)).toBe(0);
    expect(h.ledger.list()).toHaveLength(0);
    expect(h.err()).toContain("no sessions matched");
  });

  test("SINTER_NO_SCAN=1 skips the automatic refresh", async () => {
    h.ctx.autoScan = true;
    process.env.SINTER_NO_SCAN = "1";
    try {
      expect(await run(["ls"], h.ctx)).toBe(0);
      expect(h.ledger.list()).toHaveLength(0);
    } finally {
      delete process.env.SINTER_NO_SCAN;
    }
  });

  test("scan and metadata-only commands do not trigger an automatic ledger scan", async () => {
    h.ctx.autoScan = true;
    let lists = 0;
    const original = h.claude.list.bind(h.claude);
    h.claude.list = () => {
      lists++;
      return original();
    };
    await run(["scan"], h.ctx);
    const afterScan = lists;
    expect(afterScan).toBe(1); // only the explicit scan; no double auto-scan
    h.stdout.length = 0;
    await run(["privacy"], h.ctx);
    expect(lists).toBe(afterScan); // privacy does not trigger a scan
    h.stdout.length = 0;
    await run(["capabilities"], h.ctx);
    expect(lists).toBe(afterScan); // capability checks detect stores but never enumerate sessions
    h.stdout.length = 0;
    await run(["ghosts"], h.ctx);
    expect(lists).toBe(afterScan); // housekeeping acts only on the current ledger snapshot
    h.stdout.length = 0;
    await run(["view", "save", "quiet"], h.ctx);
    await run(["view", "list"], h.ctx);
    expect(lists).toBe(afterScan); // defining and inspecting views is metadata-only
    expect(h.ledger.list()).toHaveLength(4);
  });

  test("running a saved view refreshes the session ledger", async () => {
    h.ctx.autoScan = true;
    await run(["view", "save", "fresh", "--harness", "claude"], h.ctx);
    expect(h.ledger.list()).toHaveLength(0);
    expect(await run(["view", "run", "fresh"], h.ctx)).toBe(0);
    expect(h.ledger.list()).toHaveLength(4);
    expect(h.out()).toContain("porting sessions between harnesses");
  });

  test("an auto-scan error never fails the command", async () => {
    h.ctx.autoScan = true;
    h.omp.throwOnList = "*";
    h.stdout.length = 0;
    expect(await run(["ls"], h.ctx)).toBe(0);
    // claude still scanned; omp failure is reported but not fatal
    expect(h.ledger.list({ harness: "claude" })).toHaveLength(3);
    expect(h.err()).toContain("scan warning [omp]");
  });
});
