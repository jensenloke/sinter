# Sinter current status

Last updated: 2026-08-30 (Asia/Singapore)

This is the durable continuation handoff for maintainers and coding agents.
Read the root [AGENTS.md](../AGENTS.md) first. Mutable facts below were verified
on the date above and must be checked again before release, merge, or publish
operations.

## Release state

- Development CLI version on `feat/repository-binding-v2-public`:
  `0.5.0-dev.0`.
- The development package is `private: true`, uses npm tag `next`, and cannot be
  published as a prerelease. It is for source/tarball testing only.
- Latest published npm package and `latest`: `@jensenloke/sinter@0.4.0`.
- npm `0.4.0` is immutable; no npm publication is part of this branch push.
- Historical public-base notes: [releases/v0.3.1.md](releases/v0.3.1.md).

## Git state at handoff

- Working branch: `feat/repository-binding-v2-public`, based directly on the
  already-public `origin/feat/multi-instance-lan` commit `dd46ad1`.
- Cloud-free implementation commit `8c4bfae` is pushed and the branch tracks
  `origin/feat/repository-binding-v2-public`.
- The branch contains no private Cloud ancestry. It ports only repository-bound
  direct transfer, Cloud-free packaging gates, tests, and public documentation.
- GitHub repository `jensenloke/sinter` is public. Never push the local private
  `feat/repository-binding-v2` branch or its newer Cloud ancestry here.
- The sibling `sinter-public` checkout uses the same upstream and was clean at
  `origin/main` when this branch was prepared. Follow the parity protocol in
  `AGENTS.md`; do not duplicate-push from the sibling checkout.
- GitHub PR #24 remains the public direct-transfer base and targets `main`.
- Hosted Sinter Cloud implementation, Auth0 integration, device/capsule client
  commands, Supabase migrations, admin surfaces, and Storage are absent from
  this branch and rejected by source/build package gates.

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

## Repository-bound direct transfer v2 — private development

- The locator, encrypted request, and authenticated receipt remain transport
  version 1. Session plaintext uses strict `sinter.session-transfer.v2` with an
  encrypted `sinter.repository-binding.v1` record.
- Send derives credential-free remote identity, commit, branch hint, and
  monorepo-relative working directory from the actual source checkout. It strips
  source absolute `cwd`, raw Git URLs, native paths, provider state, and raw
  adapter records before encryption.
- Receive requires an explicit target Git root, rejects legacy unbound payloads,
  compares exact sanitized repository identity, checks local commit availability
  without fetching, validates relative-directory containment, reports dirty
  state, and repeats checks immediately before the exact instance write.
- Mismatch and missing-commit exceptions require separate explicit flags and are
  retained in provenance. `--yes` cannot bypass repository checks.
- Versioned JSON distinguishes send preview/result and receive listener/result;
  successful receive reports both `imported: true` and `wrote: true`.
- Source and built npm boundaries are Cloud-free. Package preparation fails if
  known Cloud modules, commands, API paths, identity schemas, or hosted URLs are
  present. Publication also requires explicit approval, clean tagged stable
  `main`, package/runtime parity, and proof that the npm version is absent.
- Design and resolved policy: [repository-binding-design.md](repository-binding-design.md).
- The public branch passed 676 tests and 9,085 assertions, TypeScript, production
  CLI build, Cloud-free source/dist checks, package inspection, isolated Bun/npm
  installs, built help, frozen lockfile, and `git diff --check`. The dry-run npm
  payload contains 23 files limited to `dist`, package metadata, README, and
  license; shasum `97311f1e95e31a0dec9f4f51b2bc7cf56f96b002`. The explicit
  prepublication command fails closed before npm publication.

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
  protocol. Repository-bound v2 rejects legacy v1 session payloads, so both
  devices must use the same hash-matched development package.
- There is no offline inbox, cloud relay, account/device identity, revocation
  service, capsule sync, Storage, or cross-device search in this branch.
- Workspace files and Git dirty state are not transferred.
- Automatic profile bootstrap currently recognizes Claude Code's standard
  `.claude` / `.claude-*` directory convention. Other custom stores still use
  explicit TOML configuration.
- The ledger migration is transactional and rollback-safe but does not create a
  separate user-visible backup file. Backup/repair UX remains roadmap work.
- Sinter Cloud remains a separately gated roadmap/development line. Public npm
  artifacts from this branch are required to remain Cloud-free, and the
  open-source CLI remains fully useful without an account.

## Recommended next actions

1. Review pushed commit `8c4bfae` and this evidence update. Do not open or merge
   a PR until the public base ordering and human review plan are agreed.
2. Keep the package private and unpublished. Before any npm release, complete a
   hash-matched physical MacBook/Mac Mini transfer from this exact public branch,
   obtain human privacy/security review, merge its public base, and rerun the
   complete gate on clean `main`.
3. Any eventual stable release must deliberately remove `private`, change or
   remove npm tag `next`, review scoped-package public access, create the exact
   stable tag, and pass both Cloud-free and publication guards with explicit
   approval.
4. Review and merge GitHub PR #24 so the public default branch catches up with
   the already-published npm package; do not republish an immutable version.
5. Continue peer discovery, inspect-before-send UX, and explicit ledger backup/
   repair without adding Sinter Cloud implementation to this branch.
