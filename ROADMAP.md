# Sinter roadmap

Sinter's long-term direction is to make coding-agent sessions portable: first
between harnesses, then between a user's devices, then between people. The CLI
and local data model remain open source and local-first. Networked features must
preserve that trust boundary rather than turning local transcripts into an
opaque hosted dataset.

This is a direction document, not a release commitment. Each phase should earn
the next one through real usage and privacy review.

## Near term: better CLI ergonomics

1. **Shell completions — ready in draft PR #4.** Generate native completion
   scripts for zsh, bash, and fish covering commands, flags, harnesses, and
   transfer modes.
2. **Port preview — ready in draft PR #5.** Add a side-effect-free view of
   target readiness, payload reduction, entry changes, working directory, and
   historical tool behavior before a port runs.
3. **Recent-session shortcuts — ready in draft PR #6.** Make `sinter recent`,
   `sinter last`, and project-scoped history reduce the need to copy session ID
   prefixes.
4. **Consistent machine-readable output — first contract ready in draft PR
   #9.** Versioned JSON is available for scan and doctor health, port previews,
   config inspection, recent-session queries, and error envelopes. Versioned
   NDJSON transcript streaming is ready in the stacked transcript checkpoint.
5. **Safe diagnostic bundles — ready in draft PR #7.** Let `sinter doctor
   --report` produce a reviewable support report containing versions and store
   health while excluding paths, prompts, titles, session IDs, transcripts,
   and raw adapter errors by default.
6. **Configuration UX — inspection ready in draft PR #8.** Add `sinter config
   show|path|validate` for local profiles. Guided writes for defaults, update
   checks, and telemetry remain a later checkpoint because they require a
   stable, migration-safe config schema.
7. **Project overview — ready in draft PR #12.** Group resumable parent sessions
   by working directory so large multi-harness ledgers stay navigable without
   parsing transcript bodies.

## Phase 1: portable session capsules

Add an encrypted `.sinter` capsule that can move independently of a particular
harness store.

```sh
sinter bundle <session> --context-only
sinter bundle <session> --include-workspace
sinter inspect session.sinter
sinter open session.sinter --in codex
```

A capsule may contain:

- the SIF conversation, provenance, and thread lineage;
- Git remote, commit, branch, and working-directory hints;
- an optional dirty patch and explicitly selected untracked files;
- required harness/model metadata and selected tool artifacts.

Capsules must never silently include credentials, environment values, or
arbitrary workspace files. `inspect` and a secret/redaction review are release
requirements, not later hardening.

## Phase 2: encrypted device transfer

Introduce accounts only when they solve a concrete transport problem:

```sh
sinter login
sinter devices
sinter send <session> --to macbook
sinter inbox
sinter accept <transfer-id>
```

The first service should be an end-to-end encrypted relay. Devices own their
keys; the service stores ciphertext plus the minimum delivery metadata. Every
transfer supports expiry, revocation, deletion, and an audit trail. A useful
resume also needs repository state, so context-only and workspace-aware
transfers remain distinct.

## Phase 3: Sinter Cloud

Build the relay into a zero-knowledge personal session library:

- encrypted sync and backup across registered devices;
- cross-device search, thread lineage, and version history;
- a Sinter Inbox and “continue on another device” workflow;
- explicit retention and permanent deletion controls;
- recovery design that does not give the service transcript access.

The open-source CLI remains fully useful without a cloud account. Personal
sync is a natural paid service, not a prerequisite for local portability.

## Phase 4: teams and handoffs

Support read-only and resumable sharing, expiring links, revocation, team
libraries, comments, audit history, and organisation retention policies. Every
share must show a redaction preview. A generated continuation brief can explain
what was attempted and what should happen next while the full session remains
available underneath.

## Phase 5: cloud execution research

Running a session in the cloud is possible, but it is a separate platform from
session sync. It requires reproducible workspaces, repository checkout and
dirty-state restoration, dependency installation, provider credentials, MCP
configuration, sandboxing, network policy, terminal streaming, retention,
compute limits, and billing. Provider authentication and hosting terms also
need explicit validation.

The honest initial promise would be “start an isolated workspace from this
session capsule,” not “reproduce the exact local machine.” Prototype this only
after capsules and device transfer prove that users value portable context.

## Product principles

- Local-first and useful without an account.
- End-to-end encryption before transcript sync.
- Inspect before send; revoke and delete after send.
- Separate conversation context from workspace state.
- Never move secrets implicitly.
- Transport before collaboration; collaboration before cloud compute.
