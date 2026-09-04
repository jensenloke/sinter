# Sinter current status

Last updated: 2026-09-03 (Asia/Singapore)

This is the durable continuation handoff for maintainers and coding agents.
Read the root [AGENTS.md](../AGENTS.md) first. Mutable facts below were verified
on the date above and must be checked again before release, merge, or publish
operations.

## Release state

- Current public CLI, npm `latest`, annotated Git tag, and GitHub release:
  `@jensenloke/sinter@0.5.1` / `v0.5.1`.
- PR #32 merged the compacted Codex-to-Claude resume fix at `1b759c4`; release
  PR #34 merged at `9190954`, the exact v0.5.1 tag target.
- v0.5.1 registry and rehearsed 24-file tarball shasum:
  `e5d2b3dbe35ab5c79ca8d35864cb549f0d92cf81`.
- Isolated Bun and npm installs both report `0.5.1` and expose Cloud help.
- Patch notes: [releases/v0.5.1.md](releases/v0.5.1.md).
- npm `0.4.1`, `0.5.0`, and `0.5.1` are immutable and must never be republished.

## Git state at handoff

- Public `main` includes the Devin Cloud continuation handoff from PR #36 after
  the v0.5.1 release; this documentation-only change does not alter the package
  or runtime version.
- PRs #30, #31, #32, #33, #34, and #36 passed macOS, Ubuntu, and isolated
  database-policy CI. The v0.5 feature branch retains checkpoints `ff4b8a7`,
  `33a9b8c`, `8e8731f`, and physical evidence handoff `5dc7860`.
- Public `main` contains the released Cloud client and compact-resume patch. The
  exact v0.5.0 and v0.5.1 release commits remain tagged and published.
- The CLI/source are public; the hosted service remains restricted to exactly
  the owner's entitlement during testing and public signup remains closed.
- PR #25 is superseded by PR #38, which re-lands the context-budget fitting
  feature on current `main` with named-instance routing preserved, concrete
  send/Cloud modes, and UTF-8 byte-accurate Devin clipping; close #25 once #38
  merges. Draft PRs #4–#9 and #11–#22 were closed as superseded by the merged
  v0.2.0 umbrella (#23). PR #10 (local-file encrypted capsules) remains open
  and security-blocked; it is not in `main`.
- The `sinter-public` checkout is the sole active maintainer checkout. Previous
  local checkouts and linked worktrees were retired; do not recover, copy from,
  or push their legacy local-only history. The public GitHub repository is the
  source of truth.
- Published npm `0.4.1` is terminal-only. v0.5 is the first public Cloud client,
  while the CLI remains fully useful without an account.
- Cloud-agent continuation instructions and the verified environment gate are in
  [handoff-summary.md](handoff-summary.md). Cloud history and current evidence
  are documented in [sinter-cloud-inventory.md](sinter-cloud-inventory.md).
  Repository-bound direct transfer v2 design and mismatch policy are in
  [repository-binding-design.md](repository-binding-design.md).

## Historical synthetic capsule diagnostic checkpoint

- Checkpoint implementation commit: `84ca372 feat: add synthetic capsule
  diagnostics`; it preceded the terminal-only public v0.4.1 split.
- `4204cdf` is complete and reviewed locally: `devices register` now waits for
  signed approval, auto-saves the approved device ID, supports bounded timeout/
  Ctrl+C, and retains `--no-wait` for scripts. It is **not** in published npm
  `0.4.0`.
- The synthetic local-file capsule diagnostic is reviewed, corrected, fully
  verified, and included in the unpublished candidate. `devices capsule-test
  create` encrypts one fixed synthetic fixture for the active exact-suite device
  registry, self-opens it, proves same-process replay rejection, and exclusively
  creates a `0600` file without following or overwriting an existing path.
  `devices capsule-test open` safely reads a bounded regular file, requires the
  local recipient and signed sender to remain active, verifies the exact fixture,
  and proves replay rejection. Neither operation scans native stores, opens the
  ledger, bootstraps profile config, uploads data, or emits keys/ciphertext/
  decrypted fixture content.
- Focused verification passed 66 tests and 473 assertions. The full repository
  passed 832 tests and 9,680 assertions, both TypeScript checks, CLI and Cloud
  production builds, npm package inspection, isolated Bun/npm installs, built
  device-help smoke testing, and `git diff --check`.
- The identical packaged `0.4.1` candidate was installed into temporary prefixes
  on the MacBook and Mac Mini. MacBook create and Mac Mini open reported the same
  capsule ID and file SHA-256, two distinct registered device fingerprints, two
  recipients, successful exact-fixture decryption, same-process replay rejection,
  and exit code zero. The transferred capsule remained `0600`; no real session
  content or Cloud Storage path was involved.
- At parent-branch candidate commit `84ca372`, `packages/cli/package.json`, the
  built CLI, and the physically tested candidate tarball reported `0.4.1`. The
  current child branch now reports `0.5.0-dev.0`; this does not supersede or
  republish the candidate. npm `0.4.0` remains immutable and `0.4.1` is not
  published. Do not push, tag, release, or publish either line without explicit
  maintainer approval.

## Verified repository-bound direct transfer v2 — development only

- The `0.5.0-dev.0` development CLI retains the version 1 locator, request
  encryption, and authenticated receipt while moving session content into a
  strict encrypted `sinter.session-transfer.v2` envelope with
  `sinter.repository-binding.v1`.
- The development package is `private: true`, uses the non-default `next`
  publish tag, and has a `prepublishOnly` guard requiring explicit approval,
  clean `main`, exact stable tag, package/runtime parity, and npm absence. Stable
  release preparation must deliberately remove `private`, review scoped-package
  public access, and change or remove the `next` tag.
- Send derives sanitized hosted Git identities, commit, branch hint, and
  monorepo-relative `cwd` from the actual source checkout. It strips source
  absolute paths and raw Git metadata from the transferred SIF. Multiple source
  identities require `--repo-remote <name>`.
- Receive rejects legacy v1 session payloads and requires
  `--cwd <repository-root>`. It compares exact sanitized remotes, checks commit
  availability without network access, rejects unbound/non-Git targets, blocks
  traversal and symlink escape, reports dirty state without modifying it, and
  repeats semantic checks immediately before the adapter write.
- Repository mismatch and missing-commit exceptions require separate
  `--allow-repo-mismatch` and `--allow-missing-commit` options; `--yes` cannot
  bypass them. Overrides remain visible in native and cached lineage provenance.
- A real-Git encrypted loopback test proves the same repository at different
  device paths rewrites every session `cwd` to the validated target-local
  subdirectory before the exact `harness@instance` writer runs. Distinct
  repositories with the same basename fail by remote identity, and all refusal
  paths prove zero adapter writes.
- A fully synthetic physical MacBook/Mac Mini matrix used hash-matched
  `0.5.0-dev.0` tarballs, temporary Claude stores/ledgers, and temporary Git
  checkouts only. Exact/dirty compact import passed; ambiguous source remotes
  required explicit selection; missing-commit and mismatch cases refused before
  import, then passed only with their dedicated slim/full overrides; lineage
  retained both override modes; and a published `0.4.0` sender was rejected as
  legacy v1. The final reviewed tarball SHA-256 was
  `e07174dd90fedab060958fb8bfe988f1777ec25d02534ad91ea5ce9531787e4f`
  on both devices and passed a second exact/dirty compact transfer with the
  versioned `wrote: true` result. Four intended sessions were imported in total;
  the dirty target marker/hash/status remained unchanged.
- The full repository passed 851 tests and 9,898 assertions, both TypeScript
  checks, CLI and Cloud production builds, isolated Bun/npm package rehearsal,
  built help, and `git diff --check`. Independent adversarial review found no
  remaining critical, high, or medium blockers.
- That repository-binding checkpoint did not add Cloud upload or Storage. The
  child v0.5 sync implementation below reuses its fail-closed restore boundary.

## Encrypted Cloud sync MVP — implemented locally, undeployed

- `sinter cloud push|list|inspect|pull|delete` is implemented for an owner-only
  alpha. Push reads the source store without modifying it, applies compact/slim/
  full transfer and repository sanitization, encrypts locally to active exact
  registered devices, and uploads only the signed canonical capsule ciphertext.
- Session capsules preserve the reviewed outer HPKE/AES-GCM/ECDSA envelope while
  adding a distinct real `sinter.capsule.session-transfer.v1` payload containing
  strict `sinter.session-transfer.v2`. Synthetic diagnostics remain backward
  compatible and cannot be confused with real payloads.
- Every capsule API request requires paired Auth0 tokens plus an ECDSA device
  proof over exact method, path, body hash, timestamp, and a durable one-use
  nonce. The Cloud service verifies the active account device and never receives
  a private key or plaintext.
- The new private Storage and metadata migration uses service-role-only atomic
  reserve/finalize/delete/expiry RPCs, active owner entitlement, exact size and
  server-computed SHA-256 verification, 16/64 MiB caps, storage/session quotas,
  cross-account RLS, retryable two-stage cleanup, and permanent deletion even if
  uploads are later disabled or the account is suspended.
- List returns content-free routing metadata. Inspect and pull download with
  bounded streaming, reject redirects and hash/size mismatch, verify the current
  signed sender/recipient set, and decrypt locally. Inspect does not expose the
  transcript or replay key. Pull repeats repository checks before an exact
  instance write and records durable local replay; dry-run consumes no replay.
- Admin upload entitlement can be enabled only while the exact global server
  gate is on and after super-admin reauthorization, typed confirmation, and an
  audit reason. Defaults remain off; no email/account heuristic enables anyone.
- A secret-protected daily cleanup route processes retryable reservations and
  expired request nonces even while uploads are disabled.
- Local verification passes 938 tests and 10,473 assertions, 320 pgTAP database
  assertions from a clean migration reset, both TypeScript checks, CLI and Cloud
  production builds, Cloud-enabled package rehearsal, frozen lockfile, and
  `git diff --check`. Two independent post-fix reviews found no remaining
  critical, high, or medium blocker for owner-only alpha.
- The `0.5.0-dev.0` tarball contains 24 files limited to the CLI bundle, README,
  license, and package metadata; it excludes the hosted app, SQL migrations, and
  server secrets. The physically tested package SHA-256 is
  `c3c9c4b41756f9beaa6ba1813cb7e8322f7e9674e576daf088921fc78dd9b91d`.
- Migration `20260826050000` is applied to hosted development and the Cloud app,
  capsule APIs, admin gate, and cleanup cron are deployed to Vercel production.
  The first deploy failed before promotion because Vercel could not resolve a
  workspace-only proof dependency; `33a9b8c` restored a pinned standalone server
  contract and the retry succeeded. Hosted migration parity, private 64 MiB
  bucket, one account/two devices, zero capsules/recipients/nonces, and zero
  enabled upload entitlements were verified without exposing identifiers.
- Gate-off production verification passed before enablement: list returned a
  sanitized unavailable response, deletion still required auth/device proof, and
  cron rejected missing authorization. The global gate was then enabled and the
  audited entitlement RPC enabled exactly the sole active unmetered super-admin;
  no other account is enabled and public signup remains closed.
- A hash-matched physical MacBook/Mac Mini test used only temporary Git, Claude,
  config, ledger, and synthetic session fixtures. Push retained a 9,004-byte
  capsule for both devices; list/inspect leaked no content/path; Mac Mini dry-run
  wrote nothing/consumed no replay; real pull imported one exact-instance session
  at the target-local monorepo path; replay made no second write; and the dirty
  target marker/hash/status remained unchanged.
- Permanent deletion removed the retained Storage object and quota. The failed
  pre-fix reservation then passed the two-stage expiry/finalization cleanup path.
  Hosted state ended with zero reserved/retained capsules, zero Storage objects,
  zero usage counters, one enabled owner, and zero other enabled accounts. No
  personal or pre-existing session was read or uploaded.

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
  identities, and devices remain exactly 1/1/2.
- `/api/health` reports configuration state without exposing credentials.
- A free daily Vercel cron invokes secret-protected retryable capsule-reservation
  cleanup and expired request-nonce removal. It processes only encrypted-object
  metadata/usage, never transcript plaintext, and also supplies database activity
  without being an uptime guarantee.
- Realtime, Edge Runtime, Analytics, billing, and cloud agent execution remain
  absent. Owner-only encrypted capsule Storage is now enabled and physically
  verified; current retained/reserved Storage and usage are zero.
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
  RLS, and portal inventory. MacBook and Mac Mini are both active; the Mac Mini
  was admitted by the MacBook's signed approval and no enrollment is pending.
  Revocation is irreversible;
  after all devices are lost or revoked there is intentionally no recovery.
- C2 began as a hardened synthetic-only capsule: RFC 9180 HPKE wraps a random
  content key; AES-256-GCM separately encrypts a fixed padded manifest and
  payload; an expected device sender signs the header, part metadata, and exact
  recipient set. Exact P-256/AES-256 and neighboring CFRG vectors pass, and the
  synthetic capsule passed across the MacBook and Mac Mini. The local v0.5 work
  extends that unchanged outer envelope with a separately typed real-session
  payload, durable replay, signed Cloud requests, private Storage, and atomic
  lifecycle controls; hosted real data remains disabled pending deployment and
  physical owner-only testing.
- The metadata-only control plane is deployed: default disabled/zero development
  entitlements, own quota/usage RLS, unmetered owner semantics with retained
  safety caps, service-only first-admin/role/entitlement RPCs, immutable
  content-free audit events, and a cryptographically protected `/admin` portal.
  The sole owner role remains present and the owner-only upload change is audited.
  The v0.5 admin path permits enablement only while the exact global gate is on
  and after reauthorization, confirmation, and audit reason; role management
  stays service-only and no session content enters the portal.
- The Cloud UI uses an original five-cell sintered-mineral mark with transparent
  512, 192, and 32 px assets. The raster concept should be traced and optically
  refined before final trademark use.
- Earlier foundation verification: 832 tests, 9,680 assertions, 217 database
  policy assertions, schema lint, both TypeScript checks, both production builds,
  npm package inspection, isolated Bun/npm installs, authoritative RFC HPKE
  interoperability, and independent adversarial device/capsule/admin reviews.
  Hosted migrations/deployments, unauthenticated rejection, credential refresh,
  first-device bootstrap, list, empty enrollment, one-time owner bootstrap,
  own-entitlement RLS, and authenticated admin-route checks completed
  successfully with real uploads disabled at that checkpoint.
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
sinter receive --to claude@addvita --cwd <target-repository-root> --profile all

# Tailscale: advertise the device's tailnet IP explicitly
sinter receive --to claude@addvita --cwd <target-repository-root> --advertise <tailscale-ip> --profile all

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

The `0.5.0-dev.0` development payload additionally removes source absolute `cwd` and
raw Git URLs, carries only a sanitized encrypted binding, requires an explicit
target repository root, and rejects legacy unbound payloads. Network payloads
remove raw adapter records, provider-private `preserve` state, native store paths,
and additional workspace directories. Historical tools are inert on import. The
feature moves conversation context only: it does not copy repository files,
dirty changes, environment values, or credentials.

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

Run the current v0.5 development gate with:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run typecheck:cloud
bun run build:cli
bun run build:cloud
bun run verify:package
bunx supabase start
bunx supabase test db
bunx supabase stop
```

For the published terminal release check:

```sh
npm view @jensenloke/sinter version dist-tags --json
bunx @jensenloke/sinter@0.4.1 --version
```

## Known boundaries

- There is no automatic peer discovery; direct-transfer locators must be copied
  to the sender. Owner-only Cloud sync is the deployed asynchronous path.
- Direct transfer requires network reachability and may be blocked by host or
  network firewalls. The `0.5.0-dev.0` receiver accepts only repository-bound v2
  session payloads; both devices must run the same development build.
- Hosted private Storage and owner-only uploads are enabled. Current retained/
  reserved content and usage are zero after the physical test; public signup and
  all non-owner entitlements remain disabled.
- Cloud sync has no browser decryption, team sharing, public signup, recovery
  escrow, or cross-account collaboration. Loss/revocation of every device key is
  intentionally unrecoverable.
- A process crash after local replay claim but before writer completion can leave
  that capsule blocked on the device; target writer atomicity remains adapter-
  specific. A failed writer that returns normally through the CLI releases its
  claim for retry.
- Finalize streams and hashes the full encrypted object through the Node runtime;
  this is correct for trust but should be monitored for memory/egress during alpha.
- Workspace files, dirty changes, environment values, and credentials are never
  transferred.
- Automatic profile bootstrap recognizes Claude Code's standard `.claude` /
  `.claude-*` convention. Custom alias-backed stores use explicit opt-in
  `sinter config discover-shell`; existing config is never overwritten.
- The ledger migration is transactional and rollback-safe. `sinter ledger
  backup|verify|repair` provides explicit local backup, verification, and
  derived-index repair; backups are not created automatically before migration.
- Sinter Cloud will expose a public/open-source client while the hosted alpha is
  owner-only. The terminal CLI remains fully useful without an account.

## Recommended next actions

1. Treat npm `0.5.1` and tag `v0.5.1` as immutable; use a new patch version for
   every future package change.
2. Keep public signup closed and exactly one owner entitlement enabled; v0.5.1
   changes client-side adapter/transfer behavior only.
3. Monitor owner-only Storage/egress, cleanup, auth refresh, deletion, and
   compacted Codex-to-Claude resumes before admitting any tester.
4. Review and merge PR #38 (context-budget fitting) and PR #39 (ledger
   backup/verify/repair); then close PR #25 as superseded and decide whether PR
   #10 should be closed or redesigned against the shipped device-transfer
   capsules.
