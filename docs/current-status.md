# Sinter current status

Last updated: 2026-08-25 (Asia/Singapore)

This is the durable continuation handoff for maintainers and coding agents.
Read the root [AGENTS.md](../AGENTS.md) first. Mutable facts below were verified
on the date above and must be checked again before release, merge, or publish
operations.

## Release state

- Current CLI version: `0.3.1`.
- npm package: `@jensenloke/sinter@0.3.1`.
- npm `latest`: `0.3.1`, publicly verified after publication.
- Both the globally resolved npm executable and Bun's global executable were
  verified at version `0.3.1`.
- Release notes: [releases/v0.3.1.md](releases/v0.3.1.md).
- Release commit: `f805f3e feat: bootstrap multi-instance profiles`.
- npm `0.3.1` is already published and cannot be republished. Any correction
  requires a new version.

## Git state at handoff

- Working branch: `feat/multi-instance-lan`.
- The feature branch is pushed as `origin/feat/multi-instance-lan` and tracks
  that remote branch. It has not yet been merged into `origin/main`.
- GitHub PR #24 targets `main`:
  `https://github.com/jensenloke/sinter/pull/24`.
- PR #24's macOS and Ubuntu verification checks passed for commit `f805f3e`.
- The sibling `sinter-public` checkout currently uses the same GitHub upstream,
  `jensenloke/sinter`, and was clean at `origin/main`/`v0.2.0` before this
  branch was pushed. Follow the public-clone parity protocol in `AGENTS.md`;
  update that checkout by clean fast-forward after merge, not by copying files.
- Sinter Cloud implementation remains isolated from CLI release commits. Do
  not mix hosted application code into the CLI release line without an
  explicit product decision.
- Cloud planning continues on `docs/sinter-cloud-inventory`; its inventory is
  documented in [sinter-cloud-inventory.md](sinter-cloud-inventory.md). The
  recommended first hosted checkpoint is an auth/policy shell on a generated
  Vercel URL with one development Supabase project and no transcript uploads.

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
- There is no offline inbox, cloud relay, account/device identity, revocation
  service, or cross-device search yet.
- Workspace files and Git dirty state are not transferred.
- Automatic profile bootstrap currently recognizes Claude Code's standard
  `.claude` / `.claude-*` directory convention. Other custom stores still use
  explicit TOML configuration.
- The ledger migration is transactional and rollback-safe but does not create a
  separate user-visible backup file. Backup/repair UX remains roadmap work.
- Sinter Cloud remains roadmap work. The open-source CLI must remain useful
  without an account.

## Recommended next actions

1. Review and merge GitHub PR #24 so the public default branch catches up with
   the already-published npm package.
2. After merge, create the Git tag/GitHub release for `v0.3.1`; do not publish
   `0.3.1` to npm again.
3. Test an actual same-harness port from `claude@personal` to
   `claude@addvita`, including preview, write, qualified resolution, and the
   generated `CLAUDE_CONFIG_DIR` resume command.
4. Test direct transfer between two physical devices on LAN, then across
   Tailscale. Record firewall and address-selection problems as issues.
5. Choose the next CLI checkpoint from [../ROADMAP.md](../ROADMAP.md). The most
   natural follow-ups are peer discovery, inspect-before-send UX, and explicit
   ledger backup/repair—not Sinter Cloud implementation yet.
