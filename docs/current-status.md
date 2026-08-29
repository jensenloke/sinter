# Sinter current status

Last updated: 2026-08-29 (Asia/Singapore)

This is the durable continuation handoff for maintainers and coding agents.
Read the root [AGENTS.md](../AGENTS.md) first. Mutable facts below were verified
on the date above and must be checked again before release, merge, or publish
operations.

## Release state

- Development CLI version on `feat/repository-binding-v2`: `0.5.0`.
- The verified `0.4.1` candidate remains scoped to automatic device-enrollment
  waiting and synthetic capsule diagnostics on the parent branch.
- Latest published CLI version: `0.4.0`.
- npm package and `latest`: `@jensenloke/sinter@0.4.0`.
- Registry shasum `972494f4c4cc25d537dbcea407441de9c98b0e30` matches the
  published package; both installed global executables still report `0.4.0`.
- Unpublished candidate notes: [releases/v0.4.1.md](releases/v0.4.1.md).
- Published release notes: [releases/v0.4.0.md](releases/v0.4.0.md).
- npm publication source HEAD: `90ed981 docs: record the 0.4.0 release gate`.
- npm `0.4.0` is immutable. The `0.4.1` candidate requires explicit publication
  approval after physical-device verification. `0.5.0` is development-only and
  must not be pushed, tagged, released, or published from this branch.

## Git state at handoff

- CLI release work remains on `feat/multi-instance-lan`. Cloud foundation work
  is isolated on `docs/sinter-cloud-inventory`.
- Repository-bound direct transfer v2 is isolated on the local, unpushed child
  branch `feat/repository-binding-v2`; it is not part of the `0.4.1` candidate.
- The feature branch is pushed as `origin/feat/multi-instance-lan` and tracks
  that remote branch. It has not yet been merged into `origin/main`.
- GitHub PR #24 targets `main`:
  `https://github.com/jensenloke/sinter/pull/24`.
- PR #24's macOS and Ubuntu verification checks pass at current head `dd46ad1`.
- PR #25 is open, GitHub-mergeable, and CI-green, but review found it must not
  merge yet: merge/rebase on PR #24 first, preserve named-instance routing, keep
  direct send modes concrete, and fix Devin UTF-8 byte-budget clipping/write
  enforcement. No GitHub review/comment was submitted.
- The sibling `sinter-public` checkout currently uses the same GitHub upstream,
  `jensenloke/sinter`, and was clean at `origin/main`/`v0.2.0` before this
  branch was pushed. Follow the public-clone parity protocol in `AGENTS.md`;
  update that checkout by clean fast-forward after merge, not by copying files.
- By explicit product decision, npm `0.4.0` includes optional Cloud login/device
  identity commands so the private-alpha second device can enroll. Hosted app,
  admin, database, and capsule transport code are not packaged; the local CLI
  remains fully useful without an account and cannot upload sessions.
- Cloud planning and implementation continue on `docs/sinter-cloud-inventory`;
  its inventory is documented in
  [sinter-cloud-inventory.md](sinter-cloud-inventory.md).
- Real-session direct transfer v2 now binds an explicitly selected target
  checkout to sanitized repository identity rather than a source absolute path.
  The design, resolved mismatch policy, acceptance tests, and continuation
  guidance are in [repository-binding-design.md](repository-binding-design.md).
  The implementation is isolated on `feat/repository-binding-v2` and does not
  change the scoped `0.4.1` synthetic candidate.
- The Cloud branch is ahead of `origin/docs/sinter-cloud-inventory` with
  reviewed, unpushed commits. Phase 1 device identity and the metadata-only
  control plane are deployed; the C2 local-only envelope remains disconnected
  from transport.

## Verified v0.4.1 candidate and physical test — keep unpublished

- Candidate implementation commit: `84ca372 feat: add synthetic capsule
  diagnostics`. The branch remains local and unpushed.
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
- `packages/cli/package.json`, the built CLI, and the candidate tarball report
  `0.4.1`. npm `0.4.0` remains immutable; `0.4.1` is not published. The physical
  test is complete, but do not push, tag, release, or publish without explicit
  maintainer approval.

## Verified repository-bound direct transfer v2 — development only

- The `0.5.0` development CLI retains the version 1 locator, request encryption,
  and authenticated receipt while moving session content into a strict encrypted
  `sinter.session-transfer.v2` envelope with `sinter.repository-binding.v1`.
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
- The full repository passed 847 tests and 9,822 assertions, both TypeScript
  checks, CLI and Cloud production builds, isolated Bun/npm package rehearsal,
  built help, and `git diff --check`. Independent adversarial review found no
  remaining critical, high, or medium blockers.
- This branch does not add Cloud upload, Storage, workspace transfer, Git fetch/
  checkout/reset/patch behavior, or any repository dependency to the `0.4.1`
  synthetic capsule diagnostic.

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
  RLS, and portal inventory. MacBook and Mac Mini are both active; the Mac Mini
  was admitted by the MacBook's signed approval and no enrollment is pending.
  Revocation is irreversible;
  after all devices are lost or revoked there is intentionally no recovery.
- C2 has a hardened local-only synthetic capsule draft in `@sinter/core`: RFC
  9180 HPKE wraps a random content key; AES-256-GCM separately encrypts a fixed
  padded manifest and synthetic SIF payload; an expected Phase 1 sender signs
  the header, part metadata, and exact recipient set. Replay keys are opener-
  scoped and include both ciphertext hashes. Exact P-256/AES-256 and neighboring
  authoritative CFRG vectors pass. Two independent Claude Opus reviews closed
  all original blockers, and the guarded synthetic capsule passed across the
  MacBook and Mac Mini with replay rejection. Durable replay and human
  cryptographic review still block Storage/real data. No CLI/TUI/Storage/network
  or real-session path uses the capsule format.
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
- Development verification: 832 tests, 9,680 assertions, 217 database policy
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

The `0.5.0` development payload additionally removes source absolute `cwd` and
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
  protocol. The `0.5.0` development receiver accepts only repository-bound v2
  session payloads; both devices must run the same development build.
- There is no offline inbox, cloud relay, encrypted capsule storage, browser
  device, or cross-device search yet. Two CLI devices are enrolled and passed the
  guarded synthetic capsule create/open test, but replay remains process-local.
  Account identity exists, and no session content is stored remotely.
- Workspace files and Git dirty state are not transferred.
- Automatic profile bootstrap recognizes Claude Code's standard `.claude` /
  `.claude-*` convention. Custom alias-backed stores use explicit opt-in
  `sinter config discover-shell`; existing config is never overwritten.
- The ledger migration is transactional and rollback-safe but does not create a
  separate user-visible backup file. Backup/repair UX remains roadmap work.
- Sinter Cloud is an existing-members-only private alpha, not a public release.
  The open-source CLI remains fully useful without an account.

## Recommended next actions

1. Review and checkpoint `feat/repository-binding-v2`, then run one physical
   MacBook/Mac Mini direct transfer using the identical `0.5.0` development build
   and two explicit checkouts of the same repository.
2. Obtain human privacy/security review of repository binding before merging it;
   the automated adversarial review does not replace this gate.
3. Separately decide whether to publish the already-verified `0.4.1` candidate;
   pushing, tagging, releasing, and npm publication require explicit approval.
4. Obtain human cryptographic review before freezing C2 or adding Storage, then
   design durable replay, quota reservations, private encrypted **synthetic**
   push/list/inspect/pull/delete, and permanent deletion.
5. Keep real-session Cloud upload and viewing blocked until those gates pass.
6. Merge PR #24, then rebase/fix PR #25's UTF-8 byte-budget and named-instance
   integration before merging it. Create the eventual `v0.4.0` GitHub tag and
   release without republishing npm.
