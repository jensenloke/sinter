# Sinter

Sinter is a local-first CLI for finding, browsing, porting, and resuming
coding-agent sessions across Claude Code, Codex CLI, Devin CLI, OpenCode, Oh My
Pi, and pi.

```sh
bunx @jensenloke/sinter --help
bun add --global @jensenloke/sinter
sinter update --check
sinter scan
sinter
```

npm `latest` is the verified public `0.5.0` Cloud client release.

Sinter reads local harness stores and keeps its index on your machine. Historical
tool calls are inert during cross-harness ports unless explicitly enabled for a
compatible target. On POSIX systems, the local SQLite ledger and sidecar files
are restricted to the current user.

Sinter supports named instances of the same harness and direct encrypted context
transfer over LAN or Tailscale. Direct transfer v2 requires the receiver to
select a target Git root with `--cwd`, compares sanitized repository identity,
checks commit availability, previews dirty state without modifying it, and
rewrites the imported session to the target-local monorepo directory. Legacy
unbound payloads and unsafe targets fail closed; dedicated mismatch and
missing-commit overrides remain explicit in provenance. Run `sinter help
instances`, `sinter help receive`, and `sinter help send` for the workflows.

Custom Claude stores hidden behind shell aliases can be previewed only through
`sinter config discover-shell`. This explicit opt-in executes the selected
zsh/bash login startup files to list aliases; normal startup, setup, and scans
never do so. Only simple `CLAUDE_CONFIG_DIR=<path> claude` aliases are accepted,
raw alias output is suppressed, and `--write --yes` creates a missing owner-only
config without ever overwriting an existing one.

Run `sinter update` to install the exact latest published build into the global
Bun or npm installation that owns the current executable. If that ownership is
ambiguous, pass `--package-manager bun` or `--package-manager npm`; use
`--check` for a side-effect-free registry check. A newer development build
reports `newer-local` and does not downgrade to npm `latest` without `--force`.

Sinter Cloud is currently an owner-only development alpha; the CLI remains fully
usable without it. The private `0.5.0-dev.0` build supports device enrollment and
locally encrypted session capsules:

```sh
sinter login
sinter devices register --name "My Mac"
sinter cloud push <id-prefix> --preview
sinter cloud push <id-prefix>
sinter cloud list
sinter cloud inspect <capsule-id>
sinter cloud pull <capsule-id> --to claude@work --cwd ~/Code/project
sinter cloud delete <capsule-id>
```

Private device keys and plaintext stay local. A subsequent device requires signed
approval from an existing active device. Cloud push applies repository binding
and metadata stripping before local encryption; only ciphertext and bounded
routing metadata reach private Storage. Signed device requests, durable replay,
atomic quotas, retryable cleanup, and permanent deletion are enforced. The
migration, owner-only entitlement, and hash-matched physical sync matrix are
complete. Public signup and non-owner entitlements remain disabled.

Approved members with two active registered devices can explicitly test the
local synthetic capsule protocol without reading or uploading any session:

```sh
# On the MacBook (or whichever registered device creates the file)
sinter devices capsule-test create --output ./sinter-capsule-test.json

# Copy that file yourself; Sinter does not transfer or upload it. On the Mac Mini:
sinter devices capsule-test open --input ./sinter-capsule-test.json
```

The create command uses the current registered public identities from Sinter
Cloud, requires at least two active exact-suite devices, self-decrypts the fixed
synthetic fixture, verifies same-process replay rejection, and creates a new
`0600` file without overwriting. Open resolves the signed sender and local
recipient against the current active registry, then repeats the exact-fixture
and replay checks. The command does not scan native stores, open the ledger,
bootstrap profile config, or include titles, paths, repositories, transcripts,
or workspace content. Private keys remain in device credential storage. Output
contains only capsule/file identifiers, fingerprints, recipient count, a file
SHA-256, and verification booleans. Use `--json` for one versioned document.

Documentation, source, roadmap, and issue tracker:
https://github.com/jensenloke/sinter

Licensed under Apache-2.0. See `LICENSE` in this package.
