# Sinter current status

Last updated: 2026-08-25 (Asia/Singapore)

This is the durable continuation handoff for maintainers and coding agents.
Read the root [AGENTS.md](../AGENTS.md) first. Mutable facts below were verified
on the date above and must be checked again before release, merge, or publish
operations.

## Release state

- Development CLI version on `docs/sinter-cloud-inventory`: `0.4.0`.
- Latest published CLI version: `0.3.1`.
- npm package: `@jensenloke/sinter@0.3.1`.
- npm `latest`: `0.3.1`, publicly verified after publication.
- Both local global executables (`/opt/homebrew/bin/sinter` and
  `~/.bun/bin/sinter`) are the unpublished `0.4.0` development build. npm
  `latest` remains `0.3.1`; do not mistake a local install for publication.
- Release notes: [releases/v0.3.1.md](releases/v0.3.1.md).
- Release commit: `f805f3e feat: bootstrap multi-instance profiles`.
- npm `0.3.1` is already published and cannot be republished. Any correction
  requires a new version.

## Git state at handoff

- CLI release work remains on `feat/multi-instance-lan`. Cloud foundation work
  is isolated on `docs/sinter-cloud-inventory`.
- The feature branch is pushed as `origin/feat/multi-instance-lan` and tracks
  that remote branch. It has not yet been merged into `origin/main`.
- GitHub PR #24 targets `main`:
  `https://github.com/jensenloke/sinter/pull/24`.
- PR #24's macOS and Ubuntu verification checks passed for commit `f805f3e`.
- PR #25 is open, GitHub-mergeable, and CI-green, but review found it must not
  merge yet: merge/rebase on PR #24 first, preserve named-instance routing, keep
  direct send modes concrete, and fix Devin UTF-8 byte-budget clipping/write
  enforcement. No GitHub review/comment was submitted.
- The sibling `sinter-public` checkout currently uses the same GitHub upstream,
  `jensenloke/sinter`, and was clean at `origin/main`/`v0.2.0` before this
  branch was pushed. Follow the public-clone parity protocol in `AGENTS.md`;
  update that checkout by clean fast-forward after merge, not by copying files.
- Sinter Cloud implementation remains isolated from CLI release commits. Do
  not mix hosted application code into the CLI release line without an
  explicit product decision.
- Cloud planning and implementation continue on `docs/sinter-cloud-inventory`;
  its inventory is documented in
  [sinter-cloud-inventory.md](sinter-cloud-inventory.md).
- The Cloud branch is ahead of `origin/docs/sinter-cloud-inventory` with
  reviewed, unpushed commits. Phase 1 device identity and the metadata-only
  control plane are deployed; the C2 local-only envelope remains disconnected
  from transport. Keep all of this work off the CLI release line.

## Cloud development foundation

- The responsive Next.js development portal is live at
  `https://sinter-cloud.vercel.app` on a Vercel Hobby project. Its authenticated
  dashboard exposes real overview, account, security, and device states while
  unavailable product surfaces remain clearly disabled.
- One free Supabase development project runs in Singapore. It uses the
  publishable-key model, and legacy JWT API keys are disabled.
- Auth0 owns web and CLI authentication. Cloud is existing-members-only during
  private alpha: database signup is disabled; a Sinter-client-scoped Action
  denies users without JSON `sinter_cloud_access: true`; then a second scoped
  Action adds `role=authenticated` to ID tokens. The one owner is allowlisted.
  The web app uses authorization code and the CLI uses device authorization,
  both with rotating refresh tokens and RS256.
- Hosted Supabase trusts the canonical Auth0 tenant through a manually created
  Third-Party Auth connection. Supabase CLI 2.115.0 ignores
  `[auth.third_party.auth0]` during `config push`, so the local block documents
  local development but does not create the hosted connection.
- The provider-neutral `profiles`, `account_identities`, and `devices` model is
  applied to hosted development. `claim_account()` now returns an existing
  identity or links one verified provider to an existing active profile; it has
  no profile-creation path, members cannot rewrite linking emails, and denied
  claims leave all control/device counts unchanged. Hosted profiles,
  identities, and devices remain exactly 1/1/1.
- `/api/health` reports configuration state without exposing credentials.
- A free Vercel cron invokes a secret-protected, content-free Supabase database
  RPC once daily to reduce free-project idle-pausing risk. It neither reads nor
  writes user/session rows and is not an uptime guarantee.
- Real session/capsule uploads, Storage, Realtime, Edge Runtime, Analytics,
  billing, and cloud agent execution remain disabled or absent. No real session
  content has been uploaded.
- The `0.4.0` development CLI adds Auth0 device-code `sinter login`, verified
  `whoami`, rotating refresh, and revoking `logout`. macOS stores the credential
  in Keychain; other platforms currently use an owner-only file. A real Google
  login and refresh completed successfully. These account commands do not scan
  sessions, create profile configuration, or enable uploads.
- `sinter update` now checks or installs an exact published npm version through
  an evidence-detected Bun/npm global layout, never downgrades without `--force`,
  and has check-only/JSON modes. Both local global 0.4.0 installs contain it; a
  live check correctly refused npm's older 0.3.1. Multi-instance TUI actions
  show each user's dynamic `harness@instance` names. Opt-in `sinter config
  discover-shell` safely previews simple Claude aliases and emits mergeable
  TOML; it never runs during normal startup and never overwrites existing
  config. The locally reported instance was healthy; only its label was
  ambiguous.
- Phase 1 device identity is deployed: paired Auth0 token verification,
  separate P-256 encryption/signing keys, Keychain or owner-only private-key
  custody, first-device bootstrap, signed approval for subsequent devices,
  immutable fingerprints, distinct encryption/signing points across CLI/API/DB,
  list/rename/revoke/pending/approve commands, service-only registration RPCs,
  RLS, and portal inventory. The first real device is active and no enrollment
  is pending. Revocation is irreversible;
  after all devices are lost or revoked there is intentionally no recovery.
- C2 has a hardened local-only synthetic capsule draft in `@sinter/core`: RFC
  9180 HPKE wraps a random content key; AES-256-GCM separately encrypts a fixed
  padded manifest and synthetic SIF payload; an expected Phase 1 sender signs
  the header, part metadata, and exact recipient set. Replay keys are opener-
  scoped and include both ciphertext hashes. Exact P-256/AES-256 and neighboring
  authoritative CFRG vectors pass. Two independent Claude Opus reviews closed
  all original blockers and approve a guarded synthetic second-device test, but
  durable replay and human cryptographic review still block Storage/real data.
  No CLI/TUI/Storage/network or real-session path uses the capsule format.
- The metadata-only control plane is deployed: default disabled/zero development
  entitlements, own quota/usage RLS, unmetered owner semantics with retained
  safety caps, service-only first-admin/role/entitlement RPCs, immutable
  content-free audit events, and a cryptographically protected `/admin` portal.
  The one owner role and audit event are present. Upload enablement is hard-
  locked false; role management stays service-only and no account/session
  content enters the admin surface.
- The Cloud UI uses an original five-cell sintered-mineral mark with transparent
  512, 192, and 32 px assets. The raster concept should be traced and optically
  refined before final trademark use.
- Development verification: 798 tests, 9,467 assertions, 164 database policy
  assertions, schema lint, both TypeScript checks, both production builds, npm
  package inspection, isolated Bun/npm installs, authoritative RFC HPKE
  interoperability, and independent adversarial device/capsule/admin reviews.
  Hosted migrations/deployments, unauthenticated rejection, credential refresh,
  first-device bootstrap, list, empty enrollment, one-time owner bootstrap,
  own-entitlement RLS, and authenticated admin-route checks completed
  successfully with real uploads still disabled.
- Linked-provider state and `.env` files are ignored. The database password is
  held in the maintainer machine's credential store, not in the repository.

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
- There is no offline inbox, cloud relay, encrypted capsule storage, browser
  device, or cross-device search yet. Device enrollment/revocation is deployed,
  but only the first CLI device is enrolled. Account identity exists, and no
  session content is stored remotely.
- Workspace files and Git dirty state are not transferred.
- Automatic profile bootstrap currently recognizes Claude Code's standard
  `.claude` / `.claude-*` directory convention. Other custom stores still use
  explicit TOML configuration.
- The ledger migration is transactional and rollback-safe but does not create a
  separate user-visible backup file. Backup/repair UX remains roadmap work.
- Sinter Cloud remains roadmap work. The open-source CLI must remain useful
  without an account.

## Recommended next actions

1. Keep the deployed Phase 1 device identity checkpoint on
   `docs/sinter-cloud-inventory` and out of the CLI release line.
2. Obtain an external review of the C2 draft and retain its synthetic-only
   boundary. The implementation uses a reviewed HPKE library, authoritative RFC
   dependency vectors, project AES-256 vectors, and negative tests, but the
   Sinter format itself is not yet externally reviewed.
3. Enroll a second real device through signed approval before any real-session
   Cloud test. Do not revoke the only active device.
4. Design private Storage, quota reservations, encrypted **synthetic** push/list/
   inspect/pull/delete, and permanent deletion only after the C2 format review.
5. Separately review and merge GitHub PR #24 so the public default branch catches
   up with the already-published npm package; then create the `v0.3.1` tag and
   GitHub release without republishing npm.
6. Continue physical-device LAN/Tailscale transfer tests independently of Cloud.
