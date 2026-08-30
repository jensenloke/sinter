import pkg from "../package.json";
import { VERSION } from "../src/main";

export interface PublishGuardState {
  approved: boolean;
  branch: string;
  clean: boolean;
  tags: string[];
  version: string;
  runtimeVersion: string;
  registry: "absent" | "present" | "unavailable";
}

export function publishGuardFailure(state: PublishGuardState): string | undefined {
  if (!state.approved) return "SINTER_RELEASE_APPROVED=1 is required";
  if (state.branch !== "main") return "publication is allowed only from main";
  if (!state.clean) return "publication requires a clean worktree";
  if (state.version !== state.runtimeVersion) return "package and runtime versions do not match";
  if (state.version.includes("-")) return "prerelease development versions cannot be published";
  if (!state.tags.includes(`v${state.version}`)) return `HEAD must have the exact v${state.version} tag`;
  if (state.registry === "present") return `${pkg.name}@${state.version} is already published and immutable`;
  if (state.registry === "unavailable") return "npm registry absence could not be verified";
  return undefined;
}

export interface PublishGuardDependencies {
  command?: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  approved?: boolean;
}

async function command(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(30_000),
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function currentPublishGuardState(dependencies: PublishGuardDependencies = {}): Promise<PublishGuardState> {
  const run = dependencies.command ?? command;
  const [branch, status, tags, registry] = await Promise.all([
    run(["git", "branch", "--show-current"]),
    run(["git", "status", "--porcelain", "--untracked-files=normal"]),
    run(["git", "tag", "--points-at", "HEAD"]),
    run(["npm", "view", `${pkg.name}@${pkg.version}`, "version", "--json"]),
  ]);
  if (branch.code !== 0 || status.code !== 0 || tags.code !== 0) throw new Error("Git release state could not be verified");
  const registryState = registry.code === 0
    ? "present"
    : /E404|404 Not Found/i.test(registry.stderr)
      ? "absent"
      : "unavailable";
  return {
    approved: dependencies.approved ?? process.env.SINTER_RELEASE_APPROVED === "1",
    branch: branch.stdout,
    clean: status.stdout === "",
    tags: tags.stdout.split(/\r?\n/).filter(Boolean),
    version: pkg.version,
    runtimeVersion: VERSION,
    registry: registryState,
  };
}

if (import.meta.main) {
  const failure = publishGuardFailure(await currentPublishGuardState());
  if (failure) {
    console.error(`Refusing npm publication: ${failure}.`);
    process.exit(1);
  }
  console.log(`Publication guard passed for ${pkg.name}@${pkg.version}.`);
}
