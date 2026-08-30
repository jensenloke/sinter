# Repository binding for cross-device sessions

Status: implemented and verified on `feat/repository-binding-v2-public`
Last reviewed: 2026-08-30 (Asia/Singapore)

## Decision summary

A real session received on another device must never silently resume against a
repository selected only from the source device's absolute working directory.
Cross-device import should require an explicit target workspace, compare a
sanitized source repository identity with the target repository, preview the
result before writing, and reject mismatches by default.

This public branch applies repository binding only to direct cross-device
send/receive. It contains no Cloud account, device, capsule, hosted application,
or Storage implementation. Repository binding remains a future prerequisite if
encrypted Cloud transport is designed on a separately reviewed development line.

## Problem

The same repository commonly has different absolute paths on two devices:

```text
Device A: /Users/me/Documents/project/packages/frontend
Device B: /Users/me/Code/project/packages/frontend
```

An absolute path is therefore not repository identity. Worse, the same path on a
second device may point to an unrelated checkout. Importing a session there can
give an agent plausible-looking but incorrect repository context.

The design must distinguish:

- the repository in which the source session was created;
- the target checkout selected by the recipient;
- the subdirectory within a monorepo;
- the source commit and branch hints;
- workspace state, which remains a separate opt-in concern.

## Implemented direct-transfer boundary

The `0.5.0-dev.0` development CLI keeps the version 1 locator and encrypted
transport framing but replaces the inner session payload with
`sinter.session-transfer.v2`. The sender derives and strictly parses a sanitized
binding from the actual source checkout, removes source absolute `cwd` and raw
Git metadata from every transferred SIF session, and requires
`--repo-remote <name>` if several identities remain possible.

The receiver rejects legacy v1 session payloads, requires
`--cwd <repository-root>`, resolves the exact named harness instance, compares
the selected sanitized remote, checks commit availability without fetching,
validates and canonicalizes the monorepo-relative directory, reports dirty state,
and shows a no-write preview. It repeats the checks immediately before invoking
the adapter. Mismatch and missing-commit overrides are separate and visible in
provenance; `--yes` cannot bypass them. Unbound and non-Git targets fail closed.

No Cloud modules are present in the public CLI source or built npm payload. A
source-and-dist packaging gate rejects known Cloud command, API, and hosted URL
markers before packing or publication.

## Required safety properties

1. **No absolute source path binding.** A source absolute `cwd` may be shown
   locally during source inspection, but it must not select the target workspace.
2. **Explicit target selection.** A real cross-device open or receive must name a
   target workspace with `--cwd <path>` or an equivalent explicit UI selection.
3. **Repository identity before path similarity.** Compare sanitized Git remote
   identities, not directory names or absolute paths.
4. **Preview before write.** Show source identity, target identity, commit state,
   relative working directory, dirty-state warning, and intended harness target
   before invoking an adapter writer.
5. **Mismatch refusal by default.** A repository mismatch must stop before any
   native session, ledger row, sidecar, checkout, or workspace file is written.
6. **Specific override only.** A generic `--yes` must not bypass a mismatch. An
   intentional context-only import requires a dedicated option such as
   `--allow-repo-mismatch` and must remain visible in provenance.
7. **Rewrite target `cwd`.** A successful import stamps the resolved target
   repository path plus a validated repository-relative subdirectory. It never
   retains the sender's absolute path.
8. **No implicit Git mutation.** Sinter must not fetch, checkout, reset, apply a
   patch, create a branch, initialize a repository, or modify dirty files unless
   the user explicitly requests a separately previewed operation.
9. **Encrypted metadata.** Repository names, remotes, branches, paths, and commit
   identifiers remain inside the encrypted capsule or direct-transfer payload;
   they are not Cloud routing metadata, analytics, or audit fields.
10. **Context and workspace stay separate.** Repository hints may accompany a
    context-only capsule, but patches and selected untracked files require a
    distinct workspace-aware mode and redaction review.

## Implemented repository-binding record

The direct-transfer v2 schema is implemented and remains subject to human review:

```ts
interface RepositoryBindingV1 {
  schema: "sinter.repository-binding.v1";
  remotes: Array<{
    host: string;
    path: string;
  }>;
  selectedRemote: {
    host: string;
    path: string;
  };
  commit: string;
  branch?: string;
  relativeCwd: string;
}
```

The record should live in encrypted capsule plaintext. Cloud services should not
index or duplicate it. The source absolute path should not be part of the binding
record.

### Remote normalization

Normalization must be deterministic and credential-safe:

- recognize HTTPS, SSH URL, and SCP-like Git remote forms;
- strip user information, passwords, tokens, query parameters, and fragments;
- lowercase the hostname and normalize default ports;
- remove a trailing slash and conventional `.git` suffix;
- preserve path case unless a provider-specific rule safely establishes
  case-insensitive identity;
- reject malformed or credential-bearing values that cannot be sanitized;
- compare the set of sanitized remotes because repositories may have multiple
  remotes;
- never infer that a fork is the same repository merely because names resemble
  each other.

A canonical SHA-256 fingerprint of `{host, path}` can support stable comparison,
but the decrypted local preview should still show a reviewable sanitized remote.

### Monorepo location

`relativeCwd` represents the source working directory relative to the repository
root. On the target device:

1. resolve and canonicalize the explicit target repository root;
2. join the validated relative path to that root;
3. reject absolute values, `..` traversal, symlink escape, and a missing target
   subdirectory;
4. pass only the resulting target-local absolute path to the adapter writer.

## Target classification

The preview should classify repository state before any write:

| State | Default behavior |
|---|---|
| Exact sanitized remote match | Continue to commit/worktree checks. |
| Several possible source remotes | Refuse until `--repo-remote <name>` selects one identity. |
| Source commit unavailable in target | Refuse unless `--allow-missing-commit` is explicit; never fetch. |
| Repository mismatch | Refuse unless `--allow-repo-mismatch` is explicit. |
| Source has no remote identity | Treat as unbound and refuse. |
| Target is not a Git repository or has no hosted identity | Refuse. |
| Relative monorepo directory is missing or escapes root | Refuse. |
| Target worktree is dirty | Warn and preview; never modify or discard its changes. |

A branch name is only a hint. It must not establish repository identity and must
not cause an automatic checkout.

## Future Cloud capsule user flow

Illustrative syntax for later Cloud capsule work; this command is not implemented:

```sh
sinter inspect session.sinter
sinter open session.sinter \
  --in claude@work \
  --cwd ~/Code/project \
  --preview
```

Example exact-match preview:

```text
Capsule open preview

Source repository   github.com/example/project
Source commit       abc1234
Source branch       feature/example
Target repository   github.com/example/project
Target directory    /Users/me/Code/project
Relative directory  packages/frontend
Repository match    exact
Commit available    yes
Target worktree     dirty
Session write       not performed
```

Example mismatch refusal:

```text
refusing repository mismatch
source: github.com/example/project
target: github.com/example/other-project
no session or workspace files were written
```

The receiver repeats the checks immediately before the write and refuses if the
semantic preview changed, reducing path-swap and repository-change races.

## Direct-transfer hardening

Repository binding is implemented first for direct transfer rather than future
Cloud capsules:

1. The sanitized binding record lives inside the encrypted
   `sinter.session-transfer.v2` payload.
2. The receiver requires `--cwd <repository-root>`.
3. After decryption and validation, the receiver shows a repository preview
   before acceptance and repeats the checks before writing.
4. Legacy session payloads without a binding are rejected with an upgrade error.
5. The imported SIF `cwd` and Git metadata are rewritten to validated target-local
   values.
6. Existing same-machine local port behavior is unchanged; a local cross-harness
   port can legitimately reuse the existing checkout.

The locator, request encryption, and authenticated receipt remain transport
version 1. Only the encrypted inner session payload changes version, so older
senders and receivers fail clearly rather than silently using source paths.

## Acceptance tests

The focused and full verification gates cover:

- HTTPS, SSH URL, and SCP-like forms of one remote normalize consistently;
- credentials, query parameters, and fragments never enter the binding or output;
- two different repositories with the same directory name do not match;
- the same repository at different device paths matches and rewrites `cwd`;
- a wrong repository is rejected before adapter, ledger, or sidecar writes;
- a generic `--yes` cannot bypass mismatch refusal;
- the dedicated mismatch override is explicit and preserved in provenance;
- missing source commits do not trigger network access or Git mutation;
- dirty target worktrees are reported and remain byte-for-byte untouched;
- repositories without remotes are classified as unbound, not guessed;
- multiple remotes and ambiguous matches fail closed;
- absolute and traversal-based `relativeCwd` values are rejected;
- symlink escape from the selected repository root is rejected;
- machine-readable preview output contains no credentials or source absolute path;
- exact `(harness, instance, native-id)` target identity is preserved;
- the Cloud-free source and built-package gates reject private-alpha modules and
  command/API/hosted URL markers.

The complete public gate passed 676 tests and 9,085 assertions, TypeScript,
production CLI build, Cloud-free source/dist checks, package inspection,
isolated Bun/npm installs, built help, frozen lockfile, and `git diff --check`.
The focused suite includes real temporary Git repositories and encrypted
loopback transport. Package details are recorded in `docs/current-status.md`.

## Release sequencing

This public branch is based on the already-public direct-transfer line and
contains no Sinter Cloud implementation or private Cloud ancestry. The package
is a private prerelease and cannot be published without deliberate stable-release
changes and all release guards passing.

Before any future real-session Cloud push, pull, open, inbox, or resume:

1. retain the versioned binding schema, strict parser, no-write preview, and
   fail-closed mismatch policy proven by direct transfer v2;
2. obtain human privacy and security review;
3. add durable replay, quota reservation, private Storage, and permanent deletion;
4. keep workspace-aware transfer behind separate inspection and redaction gates.

## Resolved implementation decisions

1. An exact source commit must be present by default. A remote match may proceed
   without it only through `--allow-missing-commit`; Sinter never fetches.
2. Forks and renamed remotes are different repositories unless their selected
   sanitized `{host, path}` identity is exact. A mismatch requires
   `--allow-repo-mismatch`.
3. A repository without a supported hosted remote is unbound and refused. No
   path-, directory-name-, or content-derived identity is guessed.
4. Direct `receive` immediately requires `--cwd <repository-root>` under the new
   encrypted payload v2. Legacy v1 session payloads are rejected.
5. Dirty target state is shown in the preview but needs no additional override
   because Sinter writes only a new native harness session and leaves repository
   files untouched. The normal receive confirmation still applies unless
   `--yes` is explicit.
6. If the source has several possible remotes and the session does not identify
   one exactly, `send --repo-remote <name>` is required. A mismatch override does
   not select among several target identities.
7. Direct transfer retains `--to` for exact `harness@instance` targets. Naming for
   future Cloud capsule open remains deferred until that command exists.

## Continuation handoff

The next agent should first read `AGENTS.md`, `docs/current-status.md`,
`ROADMAP.md`, the latest release notes, and this document. Verify the live branch
and remote state before editing.

Implemented surfaces are:

- `packages/cli/src/repository-binding.ts` for strict schemas, normalization,
  read-only Git inspection, target classification, path safety, and SIF rewrite;
- `packages/cli/src/commands.ts` for encrypted payload v2, explicit flags,
  preview, recheck, and provenance mode;
- `packages/cli/src/main.ts` and `packages/cli/src/completion.ts` for help and
  shell interfaces;
- `packages/cli/test/repository-binding.test.ts` and command/network/package
  regression tests.

Core SIF, adapter writers, and the ledger schema remain unchanged. No capsule,
Cloud API, account, device, hosted application, or Storage module exists in this
branch. The next gates are public-branch package verification, an identical-build
physical direct transfer between two explicit checkouts, and human
privacy/security review. Keep source harness stores read-only and preserve exact
named-instance identity.
