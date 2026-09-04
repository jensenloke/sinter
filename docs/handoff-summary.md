# Devin Cloud handoff summary

Last verified: 2026-09-03

This is the short entry point for the next Devin Cloud development session. It
does not replace the repository instructions or dated status page.

## Read first

Before planning or changing code, read these files in order:

1. `AGENTS.md`
2. `docs/current-status.md`
3. `ROADMAP.md`
4. the latest file under `docs/releases/`

Then verify all mutable facts instead of relying only on this handoff:

```sh
git status --short --branch
git branch --show-current
git remote -v
git fetch origin
git rev-list --left-right --count origin/main...HEAD
npm view @jensenloke/sinter version dist-tags --json
```

## Canonical repository state

- The sole active source of truth is the public GitHub repository
  `jensenloke/sinter`.
- The default branch is `main`.
- At this handoff, local `main` and `origin/main` are synchronized. Verify the
  exact commit at the start of every session.
- The current public CLI, Git tag, GitHub release, and npm `latest` are v0.5.1.
- npm versions 0.4.1, 0.5.0, and 0.5.1 are immutable and must not be
  republished.
- Previous local checkouts and linked worktrees were retired. Do not look for,
  restore, copy from, or push legacy local-only history. Start new work from
  current `origin/main` unless the maintainer explicitly names another remote
  branch.

`docs/current-status.md` is dated 2026-08-30 and still contains historical
checkout references. Treat those references as superseded by this handoff, but
continue to use the status page for product, release, security, and verification
context.

## Product and deployment boundary

- The CLI and Cloud client source are public and local-first.
- The CLI must remain useful without a Sinter Cloud account.
- The hosted service remains owner-only and public signup remains closed.
- Do not broaden access, change owner entitlement, deploy, publish, migrate a
  hosted database, or perform production operations without explicit maintainer
  approval for that exact action.
- Never commit credentials, environment files, tokens, private keys, personal
  infrastructure details, or native harness data.
- Keep source harness stores read-only. Transfers create target sessions and
  move sanitized conversation context, not credentials or an implicit workspace
  snapshot.

## Devin Cloud environment

A repository-scoped Devin Cloud environment is configured and was rebuilt for
this repository with:

- Bun 1.3.14;
- `bun install --frozen-lockfile` on session maintenance;
- Docker for local Supabase;
- repository knowledge for tests, builds, startup, and database verification.

Devin Cloud rewrites GitHub remotes through its global Git configuration. The
repository-binding tests intentionally assert canonical GitHub identities, so
run the test suite with the global Git configuration isolated for that process:

```sh
GIT_CONFIG_GLOBAL=/dev/null bun test
```

Do not modify global or repository Git configuration to work around this.

No hosted credentials are required for the normal test, typecheck, build, or
local database gates. The Next.js app builds without Auth0 variables, although
it prints expected missing-configuration warnings. Authenticated end-to-end
flows require reviewed development-only variables documented in
`packages/cloud/README.md`; keep production and deployment credentials out of
the base environment.

Start the development app with:

```sh
bun run --cwd packages/cloud dev
```

## Verification commands

Run the main gate from the repository root:

```sh
bun install --frozen-lockfile
GIT_CONFIG_GLOBAL=/dev/null bun test
bun run typecheck
bun run typecheck:cloud
bun run build:cli
bun run build:cloud
bun packages/cli/dist/main.js --version
bun run verify:package
git diff --check
```

Run the database gate separately and always stop local Supabase afterward:

```sh
status=0
bunx supabase start && bunx supabase test db || status=$?
bunx supabase stop
exit $status
```

The 2026-09-03 Devin Cloud sandbox verification passed:

- 938 tests and 10,473 assertions;
- both TypeScript checks;
- CLI and Cloud production builds;
- built CLI v0.5.1 smoke test;
- isolated Bun and npm package rehearsal;
- 320 pgTAP assertions across seven database test files;
- local Supabase shutdown after verification.

## Development workflow

For each new task:

1. Fetch `origin` and verify the current release and branch state.
2. Create a focused branch from current `origin/main`.
3. Preserve the separation between open-source CLI work and hosted-service
   operations.
4. Add or update tests before fixing behavioral bugs when practical.
5. Run the smallest relevant checks during iteration, then the appropriate full
   gate before handoff or pull request.
6. Review the complete diff for secrets, private paths, generated artifacts,
   release-version mistakes, and unrelated changes.
7. Push and open a pull request only when explicitly requested.

Next feature work is tracked in PRs #38 (context-budget fitting) and #39 (ledger
backup/verify/repair); draft PRs #4–#9 and #11–#22 were closed as superseded by
the merged v0.2.0 umbrella (#23). PR #10 remains open and security-blocked.
