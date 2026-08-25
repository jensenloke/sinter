# Sinter Cloud inventory

Status: C0-C1 complete; C2 synthetic envelope verified locally, external review pending
Last reviewed: 2026-08-25 (Asia/Singapore)

This document turns the Sinter Cloud direction in [ROADMAP.md](../ROADMAP.md)
into an implementation sequence. The first goal is not cloud execution. It is
a trustworthy, end-to-end encrypted way for one user to move and retain Sinter
session capsules across devices.

## Recommended first stack

- **Web and control plane:** a small TypeScript web app on Vercel.
- **Auth, metadata, and policy:** Supabase Auth plus Postgres with Row Level
  Security (RLS).
- **Ciphertext objects:** a private Supabase Storage bucket.
- **Client:** the open-source Sinter CLI remains the encryption and decryption
  boundary.
- **First test URL:** the stable, Vercel-generated `*.vercel.app` project URL.
  Do not buy or configure a custom domain for the prototype.
- **First backend:** one development Supabase project. Production must later
  use a separate project, keys, backups, and retention settings.

Vercel preview deployments receive generated URLs and are appropriate for QA,
but authentication callbacks are easier to reason about against one stable
generated project URL. Preview URLs can still be used for UI-only changes once
their redirect policy is explicit.

## Product boundary

The Cloud MVP should do four things:

1. Sign a user in and register a named device.
2. Encrypt a portable session capsule locally.
3. Upload only ciphertext and minimum routing metadata.
4. Download, decrypt, inspect, and explicitly import it on another device.

The local CLI must continue to work without an account. Cloud sync is additive;
it does not replace `scan`, local porting, LAN transfer, or Tailscale transfer.

Not in the MVP:

- executing agents or repositories in the cloud;
- synchronizing credentials, environment values, MCP secrets, or arbitrary
  workspace files;
- teams, public links, comments, or organisation policy;
- server-side transcript search, summarization, or model inference;
- payment collection before storage and retention behavior are measured;
- any promise that a cloud resume recreates the source machine.

## Trust and encryption model

Sinter Cloud should be designed as a zero-knowledge ciphertext store, with one
important caveat: the service will still observe operational metadata such as
account ID, device IDs, object sizes, timestamps, IP/network logs, and transfer
status.

- Each device generates its own encryption/key-agreement key pair locally.
- Private device keys never leave the device unencrypted.
- Each capsule receives a random content-encryption key and authenticated
  encryption. The content key is wrapped separately for authorized devices.
- Supabase stores encrypted capsule bytes and wrapped keys, never plaintext
  transcript content.
- The server verifies ownership, quotas, sizes, hashes, and state transitions;
  it does not decrypt content.
- Recovery must be an explicit product choice. The safe prototype default is
  **no server recovery**: losing every enrolled device loses access to stored
  ciphertext. A later recovery key may be user-held, not silently escrowed.
- Cryptographic formats need version fields, test vectors, tamper tests, and a
  migration story before real transcripts are uploaded.

The existing direct-transfer protocol is useful prior art, but durable cloud
objects require a separate key lifecycle, multi-device envelopes, revocation,
and versioning. Do not reuse a one-time locator capability as an account key.

## Proposed data inventory

All exposed tables must enable RLS, revoke broad default grants, grant only the
needed operations, and ship with allow/deny policy tests.

| Resource | Minimum fields | Purpose |
|---|---|---|
| `profiles` | `user_id`, display settings, created/deletion timestamps | One row per Supabase Auth user; no transcript data. |
| `devices` | `id`, `user_id`, name, public key, key version, last seen, revoked timestamp | Identifies authorized decryption endpoints. |
| `capsules` | `id`, `owner_id`, object path, ciphertext bytes, ciphertext hash, crypto version, created/updated/deleted timestamps | Indexes one encrypted session artifact. |
| `capsule_keys` | capsule ID, device ID, wrapped content key, created/revoked timestamp | Grants a device cryptographic access. |
| `transfers` | sender, recipient/device, capsule ID, state, expiry, claimed/revoked timestamps | Implements inbox and delivery state. |
| `audit_events` | actor, event kind, object/device reference, timestamp | Content-free security and deletion history. |
| `entitlements` | user, plan, status, limits, provider references | Added only with billing; server-written and user-readable. |

Use one private Storage bucket, initially `capsules`, with paths such as
`<owner-id>/<capsule-id>/<version>.bin`. Storage access policies must match the
metadata ownership rules. Object writes and deletions go through the Storage
API; do not mutate Supabase's `storage` schema directly.

Avoid storing plaintext titles, prompts, repository names, paths, branches,
native session IDs, or searchable transcript fragments. A future cross-device
search feature needs a separate encrypted-index design.

## Authentication and device enrollment

Auth0 owns web and CLI authentication. The web uses authorization code; the
native CLI uses OAuth Device Authorization so headless/SSH users receive the
same supported flow. Refresh credentials stay in the operating-system
credential store when available and never enter `config.toml`, the ledger,
shell history, telemetry, or support reports.

Each CLI device generates separate local P-256 ECDH and ECDSA key pairs. The
first-ever device may bootstrap only after the server verifies a paired Auth0
API access token and CLI-audience ID token. Every later device proves possession
of its signing key and requires a bounded, signed approval from an active
existing device. Private keys never leave local custody. Fingerprints bind both
normalized public keys. Revocation is irreversible, and losing or revoking all
devices intentionally leaves no recovery path in the initial design.

The browser will later enroll as another device with a non-exportable local key
and existing-device approval. Do not add more identity providers until account
linking and takeover cases are tested.

## Application and API split

The browser may use the Supabase publishable key with the user's Auth0 ID token
where RLS fully expresses the operation. Device creation and approval require
server-side signature verification, so their Vercel routes use the server-only
`SUPABASE_SECRET_KEY` only after paired Auth0 verification and explicit account
resolution. That key bypasses RLS, must never enter browser code, and every
query/RPC remains explicitly account-scoped. Billing webhooks and final deletion
jobs may later use the same trust boundary after separate review.

Suggested repository layout:

```text
packages/cloud/             web dashboard and Vercel functions
packages/cloud/src/crypto/  browser-side envelope helpers and shared vectors
packages/cli/src/cloud/     login, devices, push, pull, inbox
supabase/migrations/        reproducible schema, grants, RLS, and functions
supabase/tests/             positive and negative RLS tests
docs/                       threat model, privacy, retention, operations
```

The Cloud package is a private Next.js workspace and is not part of the CLI
release artifact. The CLI must not import hosted application code directly;
define a small, versioned HTTP/data contract instead.

## Deployment ladder

### Environment 0: local

- Web app runs locally.
- Supabase CLI stack runs in containers when database policy work begins.
- Seed only synthetic sessions and synthetic users.
- Commit migrations and RLS tests; never commit `.env` files or linked-project
  state.

### Environment 1: hosted development

- Deploy to the default Vercel-generated project URL.
- Connect one development Supabase project.
- Add only the generated URL and explicit local callback URLs to the Supabase
  redirect allow-list.
- Gate every dashboard route except the landing/auth callback.
- Keep real transcript uploads disabled behind a server-side feature flag.

### Environment 2: private alpha

- Use a separate Supabase project if development data or access has become
  shared.
- Enable encrypted synthetic-capsule upload, download, and deletion first.
- Admit named testers only after the threat model, privacy notice, account
  deletion, abuse limits, and backup/restore drill are reviewed.

### Environment 3: production

- Separate production Vercel/Supabase environments and secrets.
- Custom domain, transactional email, monitoring, incident response, legal
  pages, payment system, and support process.
- No promotion from alpha merely because the happy path works.

## Configuration and secret inventory

Names are provisional but the visibility boundary is not:

| Setting | Exposure | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser-safe | Development project URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe | Relies on grants and RLS; it is not an admin secret. |
| `SUPABASE_SECRET_KEY` | Server only | Bypasses RLS; device APIs fail closed without it; never prefix with `NEXT_PUBLIC_`. |
| `SINTER_CLOUD_BASE_URL` | CLI/public | Defaults to the generated Vercel URL during testing. |
| `SINTER_CLOUD_REAL_UPLOADS` | Server only | Off until crypto and deletion gates pass. |
| `STRIPE_SECRET_KEY` / webhook secret | Server only, later | Not needed for the first hosted test. |

Use separate values for Local, Preview, and Production. Never copy production
secrets into preview deployments.

## Monetization recommendation

Monetize durable encrypted storage, not access to the open-source CLI.

- Primary meter: retained ciphertext bytes over time.
- Secondary guardrails: active capsule count, maximum capsule size, devices,
  and monthly transfer egress.
- Show users both human-friendly storage usage and session count.
- Do not bill only by session count: one session can differ by orders of
  magnitude in size.
- Start with a small free allowance and one paid personal tier, but set exact
  limits and prices only after measuring encrypted capsule sizes and retention.
- Enforce quota before issuing an upload authorization and recheck the final
  stored byte count. Deletion must reduce the user's visible usage promptly.

Stripe Checkout, Customer Portal, signed webhooks, entitlement reconciliation,
refund handling, tax/business details, and failed-payment behavior are a later
milestone. Billing tables must never be writable by the browser or CLI.

## Privacy, security, and operating inventory

Before private alpha:

- threat model covering account takeover, malicious devices, replay, object
  substitution, metadata leakage, service-role compromise, and lost keys;
- privacy notice listing metadata, subprocessors, purposes, region, retention,
  deletion timing, logs, support access, and contact route;
- terms of service and acceptable-use policy;
- in-product account export and deletion, including Storage objects, wrapped
  keys, Auth user, and backups/retention caveats;
- maximum object size, per-user quota, rate limits, expiry cleanup, and abuse
  controls;
- RLS/grant tests for two users proving cross-account denial for every table
  and bucket operation;
- content-free audit and error logs with documented retention;
- database backups plus a tested restore procedure; ciphertext-object recovery
  behavior documented separately;
- dependency, secret, and migration review in CI;
- incident response owner and a way to notify affected users.

For cost safety, configure provider budgets/alerts, keep the development
project count low, cap upload size, expire abandoned transfers, and measure
Storage bytes plus egress. Supabase bills each project for its dedicated
compute and measures Storage consumption over time, so unnecessary projects and
undeleted test objects have a real cost.

The free development project uses one daily Vercel Hobby cron to make a
content-free database RPC. Supabase currently considers Free projects for
pausing after a low-activity seven-day window and says a few daily user queries
are typically enough to avoid it. The cron is protected by `CRON_SECRET`, uses
only the publishable Supabase key, and cannot read or write application rows.
It reduces idle-pausing risk without adding a paid service, but it is not an
availability guarantee.

## Milestones and acceptance gates

### C0 — architecture and empty deployment

- [x] Use a private Next.js workspace and add a versioned health endpoint.
- [x] Create one free development Supabase project and commit reproducible config.
- [x] Link one Vercel Hobby project and deploy to
  `https://sinter-cloud.vercel.app`.
- [x] Keep project identifiers, linked state, and credentials out of source.
- [x] Build and type-check the web app independently of the CLI package.
- [x] Add a free daily, secret-protected database keepalive with no application
  data access.

### C1 — authentication and policy skeleton

- [x] Add Auth0 web sign-in, protected dashboard, CLI device authorization,
  rotating refresh, and sign-out/logout.
- [x] Implement device key custody, first-device bootstrap, signed subsequent-
  device approval, list, rename, revoke, pending, and approval flows locally.
- [x] Apply the device identity migration and server-only secret to hosted
  development, deploy the APIs, and register the first real device.
- [x] RLS/service-boundary tests prove user A cannot read or mutate user B and
  authenticated SQL cannot bypass cryptographic approval.
- [x] Keep all session and capsule upload paths absent and disabled.

### C2 — encrypted synthetic capsule

- [x] Implement a versioned local-only synthetic envelope with a project AES-256
  vector and authoritative RFC Appendix A.3 dependency interoperability.
- [ ] Freeze the Sinter format only after external cryptographic review.
- [x] Encrypt/decrypt synthetic manifest and SIF locally; no upload path exists.
- [ ] A second enrolled device decrypts the synthetic fixture.
- [x] Tampering, wrong-device keys, replay guard, oversize, truncation, swapped
  parts/envelopes, malformed data, and unsupported versions fail locally.
- [ ] Permanent deletion removes metadata, wrapped keys, and Storage object.

### C3 — CLI private alpha

- [x] Add Auth0 device-code `sinter login`, verified `whoami`, rotating refresh,
  and revoking `logout`, with macOS Keychain storage and an owner-only fallback.
- [x] Add device register, rename, list, revoke, pending, and approve commands;
  hosted activation remains gated on the C1 rollout.
- [ ] Add explicit `cloud push`, `cloud ls`, `cloud inspect`, and `cloud pull`;
  do not overload local `scan` or silently sync.
- [ ] Preserve qualified `(harness, instance, native-id)` provenance locally
  without exposing native IDs as cloud metadata.
- [ ] Complete one two-device real-session test after redaction review.

### C4 — inbox and relay

- [ ] Add recipient approval, expiry, revocation, one-time claim semantics, and
  an audit trail.
- [ ] Prefer direct LAN/Tailscale transfer when reachable; Cloud is the durable
  fallback, not a replacement.
- [ ] Define offline delivery and conflict behavior.

### C5 — paid beta

- [ ] Measure retained bytes, object counts, transfer egress, and support load.
- [ ] Choose free/paid limits and publish pricing clearly.
- [ ] Add Stripe-hosted checkout/portal and verified webhooks.
- [ ] Enforce entitlements server-side with a grace path for data export and
  deletion after downgrade or payment failure.

Cloud execution remains a separate research track after these milestones. The
current deployment stores no session content and cannot run agents.

## Open decisions

1. Validate or revise the provisional 16 MiB combined ciphertext cap and initial
   alpha allowance from synthetic and later consented measurements.
2. When should a separate production project be created?
3. Who should perform the external review before the Sinter envelope is frozen?

Resolved: Next.js on Vercel, a Singapore Supabase region, Auth0 web plus native
Device Authorization, explicit immutable Cloud snapshots rather than automatic
mirroring, no recovery when every device is lost, existing-device approval for
new devices, browser-as-device client-side decryption, and user-approved,
time-bounded support access instead of an administrative master key.

## Recommended immediate checkpoint

Review C2 before enabling any upload path:

1. obtain an external review of the canonical header/AAD, AES-GCM part
   encryption, HPKE recipient wrapping, strict parser, limits, and replay split;
2. keep deterministic test hooks and the synthetic-only schema out of all
   production transport APIs;
3. enroll and approve a second device, then decrypt only the synthetic fixture;
4. design account entitlements, quota reservations, usage counters, and
   metadata-only super-admin controls without adding billing yet;
5. design private Storage begin/finalize/delete for synthetic ciphertext only;
6. keep real-session integration blocked until deletion and two-device tests.

C1 proves authentication, local key custody, cryptographic approval, hosted
schema, and account isolation. The local C2 draft proves envelope behavior
without placing a real coding-agent transcript in Cloud.

## Official references

- [RFC 9180 Hybrid Public Key Encryption](https://www.rfc-editor.org/rfc/rfc9180)
- [hpke-js WebCrypto implementation](https://github.com/dajiaji/hpke-js)
- [Vercel environments and generated preview deployments](https://vercel.com/docs/deployments/environments)
- [Vercel generated deployment URLs](https://vercel.com/docs/deployments/generated-urls)
- [Supabase PKCE authentication flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [Supabase Postgres Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Supabase resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)
- [Supabase Storage schema guidance](https://supabase.com/docs/guides/storage/schema/design)
- [Supabase billing model](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Vercel cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)

Platform facts and links were checked against official documentation on
2026-08-25. Pricing and limits are mutable and must be rechecked before a paid
beta.
