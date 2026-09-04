# Sinter roadmap

Sinter's long-term direction is to make coding-agent sessions portable: first
between harnesses, then between a user's devices, then between people. The CLI
and local data model remain open source and local-first. Networked features must
preserve that trust boundary rather than turning local transcripts into an
opaque hosted dataset.

This is a direction document, not a release commitment. Each phase should earn
the next one through real usage and privacy review.

## Active implementation handoffs

- [Intelligent target-aware porting](docs/intelligent-porting.md) documents the
  automatic fit algorithm, named-instance routing, Devin coverage, safety
  boundaries, and verification baseline for the context-budget feature.

## Near term: better CLI ergonomics

1. **Shell completions — shipped (v0.2.0).** Generate native completion
   scripts for zsh, bash, and fish covering commands, flags, harnesses, and
   transfer modes.
2. **Port preview — shipped (v0.2.0).** Add a side-effect-free view of
   target readiness, payload reduction, entry changes, working directory, and
   historical tool behavior before a port runs.
3. **Recent-session shortcuts — shipped (v0.2.0).** Make `sinter recent`,
   `sinter last`, and project-scoped history reduce the need to copy session ID
   prefixes.
4. **Consistent machine-readable output — shipped (v0.2.0).** Versioned JSON is available for scan and doctor health, port previews,
   and error envelopes. Existing list, recent-session, search, and config JSON
   shapes remain stable for backward compatibility. Versioned NDJSON transcript
   streaming shipped alongside it.
5. **Safe diagnostic bundles — shipped (v0.2.0).** Let `sinter doctor
   --report` produce a reviewable support report containing versions and store
   health while excluding paths, prompts, titles, session IDs, transcripts,
   and raw adapter errors by default.
6. **Configuration UX — shipped (v0.2.0).** Add `sinter config
   show|path|validate` for local profiles. Guided writes for defaults, update
   checks, and telemetry remain a later checkpoint because they require a
   stable, migration-safe config schema.
7. **Project overview — shipped (v0.2.0).** Group
   resumable parent sessions by working directory so large multi-harness
   ledgers stay navigable without parsing transcript bodies.
8. **Transfer verification — shipped (v0.2.0).** Compare
   source and target transcript structure after a port without printing
   conversation content or overstating count equality as semantic equivalence.
9. **Large transcript navigation — shipped (v0.2.0).**
   Add a bounded tail view for quickly reading the latest turns without
   rendering an entire long-running session or emitting an incomplete
   machine-readable SIF document.

## Next CLI candidates

These candidates shipped in v0.2.0 and remain in the published CLI:

1. **Pinned sessions — shipped (v0.2.0).** Keep a small, Sinter-local
   shortlist above the churn of a large ledger with `pin`, `unpin`, and
   `pinned`; pins survive rescans.
2. **Thread inspection — shipped (v0.2.0).** Expose a ported session's
   ordered lineage, transfer modes, and resumable tip without requiring the
   interactive TUI.
3. **Capability matrix — shipped (v0.2.0).** Report
   adapter loading, store detection, read/write support, native resume
   readiness, and known limitations in human and versioned JSON forms. The TUI
   consumes the same resolver so its action availability cannot drift.
4. **Saved views — shipped (v0.2.0).** Name reusable local
   combinations of project, harness, recency, limit, and ghost/subagent filters;
   explicit flags on `view run` override the saved definition.
5. **Safe ghost housekeeping — shipped (v0.2.0).**
   Preview old ghost rows by default; pruning requires an explicit action and
   confirmation, protects rows carrying local metadata, and never touches native
   harness stores or lineage.
6. **Local tags and notes — shipped (v0.2.0).** Add
   searchable, rescan-safe user metadata across CLI/TUI/GUI search without
   modifying native sessions or carrying the metadata into ports.
7. **Watch mode — shipped (v0.2.0).** Refresh a project or
   recent-session view as local harness stores change. Interactive terminals
   redraw until Ctrl+C; pipes default to one snapshot and explicit `--count`
   plus NDJSON make automation bounded and predictable.

## Next release checkpoint

PR #23 (merged as v0.2.0) integrated the CLI roadmap above into one review and
merge path from `main`; the individual checkpoint PRs #4–#9 and #11–#22 were
closed as superseded and remain readable as review history. GitHub CI now
verifies the locked dependency install, full test suite, TypeScript, production
CLI build, and built entrypoint on every pull request and push to `main`.

Direct encrypted context transfer and named same-harness instances are now
implemented on the feature branch for the next checkpoint. Cloud accounts,
hosted sync, npm publication, and deployment remain outside this checkpoint.

## Evidence before expansion

npm downloads are a distribution signal, not proof of active use: automated
installs, caches, CI, upgrades, and mirrors can all inflate them. Product
decisions should combine:

- successful first scan and first useful action (`show`, `resume`, or `port`);
- weekly active installations and four-week return rate;
- transfer attempts, successes, target harnesses, and failure categories;
- `sinter feedback`, GitHub issues, and short user interviews;
- capsule/device-transfer demand expressed as a concrete workflow, not a vote.

Any product analytics remain explicit opt-in, content-free, documented, and
disabled until a collector and retention policy are approved. Session IDs,
paths, prompts, titles, transcript content, repository identity, and account
credentials are never product metrics. A small number of retained users with a
repeated portability problem matters more than a large download count.

## Post-release CLI research

Feature-freeze the current release candidate. Validate these candidates with
usage and support evidence before selecting another implementation batch:

1. **Lightweight session info.** Resolve one prefix and show cached identity,
   activity, project, model, metadata, capability, and lineage without reading
   the transcript.
2. **Unix pipelines.** Accept SIF from stdin and make stream/file behavior
   explicit so export, inspection, redaction, and import compose safely.
3. **Deep adapter self-test.** Add an explicit, reviewable diagnostic that can
   round-trip synthetic content in a temporary target store without touching a
   user's sessions.
4. **Typo-aware command help.** Suggest the closest command and flag while
   retaining stable exit codes and machine-readable errors.
5. **Ledger backup and repair.** Preview migrations, create a local backup, and
   verify/rebuild derived indexes without changing native harness stores.
6. **Continuation brief.** Produce a deterministic, inspectable handoff summary
   from selected turns as a separate artifact; never silently substitute it for
   the full transcript.

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

The first local-first slice is implemented: `sinter receive` creates a short-
lived, one-use encrypted locator and `sinter send` connects directly over LAN
or Tailscale. An authenticated success receipt is returned only after the
receiver validates, approves, and imports the context into an exact named
harness instance. The `0.5.0-dev.0` development path additionally binds a
sanitized source repository identity to an explicitly selected target checkout,
rejects legacy unbound payloads, and rewrites the imported session to a
target-local monorepo directory without mutating Git or workspace files. It
requires no account, SSH daemon, relay, or discovery service. Context transfer
intentionally excludes workspace files and secrets.

The physical synthetic repository-bound transfer matrix passed. Next steps are
human privacy/security review, optional discovery, durable inbox semantics,
revocation, and a relay for devices that cannot connect directly.

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

The implementation inventory, Vercel/Supabase architecture, security gates,
data model, deployment ladder, and monetization checkpoints are tracked in
[docs/sinter-cloud-inventory.md](docs/sinter-cloud-inventory.md).

The local `0.5.0-dev.0` owner-only MVP now implements encrypted push/list/
inspect/pull/delete across registered devices, private ciphertext Storage,
signed device requests, durable replay, atomic quotas, retryable cleanup,
permanent deletion, and repository-bound restore. The hosted migration and real
upload gate remain off until explicit deployment approval and physical testing.

Continue the zero-knowledge personal session library with:

- physical owner-only sync verification across registered devices;
- cross-device search, thread lineage, and version history;
- a richer Sinter Inbox and “continue on another device” workflow;
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

Sinter should not build a terminal multiplexer, PTY host, background process
supervisor, or SSH streaming layer. Products such as HerdR own the live runtime
and process lifecycle; Sinter owns durable conversation state, provenance,
inspection, transfer, and encrypted routing. If cloud execution is eventually
validated, define an executor interface and integrate with a runtime rather
than absorbing runtime supervision into the Sinter core.

## Product principles

- Local-first and useful without an account.
- End-to-end encryption before transcript sync.
- Inspect before send; revoke and delete after send.
- Separate conversation context from workspace state.
- Never move secrets implicitly.
- Transport before collaboration; collaboration before cloud compute.
