# Sinter current status

Last updated: 2026-08-30 (Asia/Singapore)

This is the durable continuation handoff for maintainers and coding agents.
Read the root [AGENTS.md](../AGENTS.md) first. Mutable facts below were verified
on the date above and must be checked again before release, merge, or publish
operations.

## Release state

- Current CLI version: `0.4.1`.
- npm package and `latest`: `@jensenloke/sinter@0.4.1`, publicly verified.
- Published shasum: `4c944de67e826899e137c9a06aa571ea9e32d472`.
- Release source commit: `4d51a11 release: prepare Cloud-free v0.4.1 (#28)`.
- Annotated tag and public GitHub release: `v0.4.1`.
- npm `0.4.1` is immutable and must never be republished. Any correction
  requires a new version.
- Release notes: [releases/v0.4.1.md](releases/v0.4.1.md).

## Git state at handoff

- PR #28 merged stable release metadata into `main` as `4d51a11`; macOS and
  Ubuntu checks passed before merge.
- Annotated tag `v0.4.1` points exactly to `4d51a11` and the matching public
  GitHub release is published.
- Earlier PR #26 merged the terminal-only candidate into its public base, and
  PR #24 merged that base into `main`.
- `main` contains explicit self-update, safe Claude shell-alias discovery,
  exact TUI instance actions, readable Codex tool input, and direct transfer v1.
- It contains no private Cloud ancestry, hosted application, Auth0 integration,
  account/device/capsule commands, Supabase migrations, or Storage code.
- Repository-bound direct-transfer v2 remains on
  `feat/repository-binding-v2-public` for v0.5.0 testing.

Before continuing, run:

```sh
git status --short --branch
git branch --show-current
git log --oneline -12
git fetch origin
git rev-list --left-right --count origin/main...HEAD
npm view @jensenloke/sinter version dist-tags --json
```

Do not infer that npm publication means GitHub was updated; these are separate
release operations.

## v0.4.1 terminal-only release

- `sinter update --check` compares strict semantic versions without installing;
  explicit update resolves Bun/npm ownership, uses exact argv without a shell,
  installs an exact version, and verifies the resolved executable afterward.
- `sinter config discover-shell` is explicit and opt-in. It executes a validated
  zsh/bash login shell only to list aliases, suppresses raw output, accepts only
  conservative `CLAUDE_CONFIG_DIR=<path> claude` shapes, and never overwrites
  existing config.
- TUI resume and port actions use exact harness instances.
- Codex custom tool input remains readable across supported transfers.
- Direct-transfer protocol and receiver behavior remain compatible with v0.4.0;
  repository-bound v2 is deferred to v0.5.0.
- Cloud-free source and built-package gates reject known private-alpha modules,
  commands, API paths, identity markers, and hosted URLs before packing or
  publication.
- Publication additionally requires explicit approval, clean tagged stable
  `main`, package/runtime version parity, and proof that npm v0.4.1 is absent.
- The stable release passed 695 tests and 9,047 assertions, TypeScript,
  production build, built-help Cloud exclusion, frozen lockfile, Cloud-free
  source/dist checks, package inspection, isolated Bun/npm installs, and
  `git diff --check`. The 23-file stable tarball contains only `dist`, package
  metadata, README, and license; shasum
  `4c944de67e826899e137c9a06aa571ea9e32d472`.

## Completed in v0.3.1

### Automatic multi-instance configuration

The first operational run checks for `~/.claude/projects` and
`~/.claude-*/projects`. When at least two exist and the resolved config path is
missing, Sinter creates an owner-only `config.toml` and immediately selects its
`default` profile. Existing configuration is never overwritten.

Generated alternate instances resume with `env CLAUDE_CONFIG_DIR=<root> claude`,
so agent workflows do not depend on interactive shell aliases. The
generated profile uses `include_defaults = true`: Claude is routed through its
named stores while all other harnesses retain default discovery.

The maintainer machine currently has generated instances `personal`,
`addvita`, and `kimi`. A real global JSON scan completed successfully with no
stderr output and scanned each independently alongside every other detected
harness.

Agent-facing discovery is available through:

```sh
sinter help instances
sinter config path
sinter config show
sinter config validate
sinter config example
```

Requested results and machine data remain on stdout. Creation notices and
errors use stderr; invalid help/usage/configuration returns non-zero. Help,
version, completion, config-path, and config-example invocations do not create
configuration.

## Completed in v0.3.0

### Multiple same-harness instances

Profiles may select several named stores for one harness:

```toml
[instances.personal]
harness = "claude"
store = "/Users/me/.claude/projects"
command = ["claude"]

[instances.addvita]
harness = "claude"
store = "/Users/me/.claude-addvita/projects"
command = ["claude-addvita"]

[profiles.all]
instances = ["personal", "addvita"]
```

Exact identities and targets use `harness@instance`:

```sh
sinter scan --profile all
sinter show claude@personal:<id> --profile all
sinter port claude@personal:<id> --to claude@addvita --profile all
sinter resume claude@addvita:<id> --profile all --exec
```

The ledger schema is version 7. Sessions, aliases, pins, notes, tags, FTS,
lineage, carry sidecars, scanning, ghosting, resolution, and filtering are keyed
by `(harness, instance_id, native_id)`. Legacy rows migrate transactionally to
instance `default`. Existing one-store profiles remain compatible.

Instance routing reaches CLI reads/writes/ports/resumes, configured command
prefixes, adapter provenance, metadata, thread views, GUI actions, and TUI
source and target actions. Identical native IDs in two stores remain distinct.

Primary implementation locations:

- `packages/core/src/sif.ts` and `packages/core/src/adapter.ts`
- `packages/ledger/src/schema.ts` and `packages/ledger/src/ledger.ts`
- `packages/cli/src/config.ts` and `packages/cli/src/adapters.ts`
- `packages/cli/src/commands.ts`
- `packages/cli/src/tui/` and `packages/cli/src/gui.ts`

### Direct encrypted transfer

The receiver prints a short-lived one-use locator, then imports one accepted
session into an exact target instance:

```sh
# LAN: advertise a private address automatically when one is available
sinter receive --to claude@addvita --profile all

# Tailscale: advertise the device's tailnet IP explicitly
sinter receive --to claude@addvita --advertise <tailscale-ip> --profile all

# On the sending device
sinter send <id> --to 'sinter://transfer/v1?...' --profile all
```

Protocol properties:

- direct HTTP transport with encrypted/authenticated payloads;
- 192-bit one-time capability carried in the locator, not sent as an HTTP
  credential;
- HKDF-SHA256 key separation, AES-GCM payload encryption, request
  authentication, and authenticated receipts;
- five-minute default expiry, one successful claim, replay rejection, and a
  16 MiB default maximum payload;
- sender success only after receiver validation, confirmation, and target
  import complete;
- LAN and Tailscale supported by address from day one; no SSH dependency.

Network payloads remove raw adapter records, provider-private `preserve` state,
native store paths, and additional workspace directories. Historical tools are
inert on import. The feature moves conversation context only: it does not copy
repository files, dirty changes, environment values, or credentials.

Primary implementation locations:

- `packages/cli/src/network/crypto.ts`
- `packages/cli/src/network/locator.ts`
- `packages/cli/src/network/transfer.ts`
- `packages/cli/src/commands.ts` (`cmdSend` and `cmdReceive`)

## Verification baseline

The `v0.3.1` release passed:

- 655 tests;
- 8,863 assertions;
- TypeScript checking;
- production CLI build;
- npm tarball inspection;
- isolated Bun and npm global installs;
- same-harness/native-ID collision coverage;
- encrypted loopback send/receive with import-before-receipt coverage.

Run the complete gate with:

```sh
bun run typecheck
bun test
bun run build:cli
bun run verify:package
```

For a published-version check:

```sh
npm view @jensenloke/sinter version dist-tags --json
bunx @jensenloke/sinter@0.3.1 --version
```

## Known boundaries

- There is no automatic peer discovery; the receiver locator must be copied to
  the sender.
- Direct transfer requires network reachability and may be blocked by host or
  network firewalls. Tailscale is transport reachability, not a separate Sinter
  protocol.
- This package contains no offline inbox, Cloud relay, account/device identity,
  revocation service, capsule sync, Storage, or cross-device search.
- Workspace files and Git dirty state are not transferred.
- Automatic profile bootstrap currently recognizes Claude Code's standard
  `.claude` / `.claude-*` directory convention. Other custom stores still use
  explicit TOML configuration.
- The ledger migration is transactional and rollback-safe but does not create a
  separate user-visible backup file. Backup/repair UX remains roadmap work.
- Sinter Cloud remains on a separate private development line for maintainer
  testing. Public terminal releases must remain useful without an account and
  pass the Cloud-free source/dist gate.

## Recommended next actions

1. Do not republish immutable npm `0.4.1`; any correction requires a new
   version and the full release gate.
2. Continue terminal improvements publicly while keeping the package fully
   useful without an account.
3. Keep Sinter Cloud private for maintainer testing and hold repository-bound
   direct-transfer v2 for the v0.5.0 test/review cycle.
