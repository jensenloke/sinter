# sinter

Sinter indexes local coding-agent sessions, renders a portable session format, and ports supported sessions between harnesses.

## Demo

![Interactive session porting demo](assets/sinter-demo-2x.gif)

## Install

Sinter requires [Bun](https://bun.sh); its SQLite support is part of the runtime.

```sh
# Run once
bunx @jensenloke/sinter --help

# Install globally
bun add --global @jensenloke/sinter
# or: npm install --global @jensenloke/sinter

sinter --help
```

Interactive runs check npm at most once per day and offer to install a newer release. Use `--no-update-check` or set `SINTER_NO_UPDATE_CHECK=1` to disable this; scripts, CI, and non-interactive output never prompt.

npm `latest` is the Cloud-free terminal release `0.4.1`. Repository-bound direct
transfer v2 and owner-only encrypted Cloud sync are available only from the
private `0.5.0-dev.0` source/tarball on its development branch; normal npm/Bun
installation does not install them yet. See the
[v0.4.1 release notes](docs/releases/v0.4.1.md) for the latest published changes.

## Quick start

```sh
sinter scan
sinter scan --json
sinter ls --since 7d
sinter recent --cwd .
sinter pin <id-prefix>          # keep an important session in a local shortlist
sinter pinned                  # list bookmarks across harnesses
sinter thread <id-prefix>      # inspect port lineage and the resumable tip
sinter capabilities           # check read, write, store, and resume support
sinter ghosts                 # preview disposable ghost rows older than 30 days
sinter view run work          # run a reusable local session filter
sinter tag <id-prefix> release urgent
sinter note <id-prefix> "follow up after launch"
sinter watch recent --cwd .    # live-refresh recent work in this project
sinter projects                 # group resumable sessions by working directory
sinter last --cwd .             # print the newest native resume command
sinter last --cwd . --exec      # resume it in this terminal
sinter search "session alias or topic"
sinter rename <id-prefix> "My important session"
sinter show <id-prefix>
sinter show <id-prefix> --ndjson       # one versioned JSON record per line
sinter compare <source-id> <target-id>  # structural transfer check; no content printed
sinter show <id-prefix> --tail 20       # render only the latest entries
sinter port <id-prefix> --to codex --mode compact --preview
sinter port <id-prefix> --to omp
sinter resume <id-prefix> --in omp --exec
sinter receive --to claude@work --cwd ~/Code/project --advertise 100.64.0.12
sinter send <id-prefix> --to 'sinter://transfer/v1?...'
sinter login                    # optional Sinter Cloud browser login
sinter whoami                   # verify the current Cloud identity
sinter logout                   # revoke and remove this device's login
sinter feedback
sinter gui
```

Commands with `--json` or `--ndjson` keep stdout machine-readable and return
errors on stderr using the versioned `sinter.error.v1` envelope. Transcript
streams use `sinter.transcript.ndjson.v1`: session metadata first, then ordered
entries, followed by linked nested sessions. Direct receive emits a versioned
listener record followed by a versioned completion record; preview tables remain
on stderr. Structural comparisons use `sinter.compare.v1` and never include
transcript content.

Inspect the support Sinter can actually use on this machine without reading
transcripts or opening the ledger:

```sh
sinter capabilities
sinter capabilities --harness codex --json
```

Machine output uses the versioned `sinter.capabilities.v1` schema. A loaded
adapter, a detected session store, and a native resume binary are reported as
separate facts so an installed integration is not mistaken for a runnable one.

Old ledger rows whose native transcript has disappeared are retained as
ghosts. Housekeeping is deliberately two-step and protects anything with local
metadata:

```sh
sinter ghosts --older-than 30d
sinter ghosts prune --older-than 30d --yes
```

Pruning removes only eligible session and search-index rows. Rows carrying an
alias, pin, tag, or note are protected. Pruning never changes native harness
stores or cached thread lineage; a later scan can rediscover a native session
if it returns.

Save frequently used filters in the local ledger, then run them by name:

```sh
sinter view save work --cwd . --harness claude,codex --since 14d --limit 25
sinter view list
sinter view run work
sinter view run work --harness omp --limit 5   # explicit flags override the view
sinter view run work --all-cwd --all-time      # clear saved scope filters
```

Views hide ghosts and subagents unless saved with `--ghosts` or `--subagents`.
Use `view show` to inspect a definition, `view save --force` to replace it, and
`view delete` to remove it. Definitions remain local and contain filters only,
never transcript content.

Add searchable local context without changing the native session:

```sh
sinter tag <id-prefix> release urgent
sinter untag <id-prefix> urgent
sinter tags
sinter note <id-prefix> "Follow up after the release"
sinter note <id-prefix> --clear
```

Tags and notes survive rescans, participate in CLI/TUI/GUI search, and protect a
ghost row from housekeeping. Tags are normalized to lowercase. Notes are
limited to 4,000 characters; neither is copied into a ported transcript.

Watch recent sessions or project activity while local harness stores change:

```sh
sinter watch recent --cwd .
sinter watch projects --since 7d --interval 5s
sinter watch recent --count 3 --json
```

On an interactive terminal, watch mode redraws until Ctrl+C. In pipes and CI it
emits one snapshot and exits unless `--count` is explicit; `--json` is compact
NDJSON with one `sinter.watch.v1` record per snapshot. Every cycle reads only
local indexes and session summaries, never transcript bodies. Use `--no-scan`
to observe the cached ledger without touching harness stores.

Inspect profile configuration without starting a scan:

```sh
sinter config path
sinter config show
sinter config validate
sinter config example
sinter help instances
```

On the first operational run, Sinter checks for `~/.claude/projects` and
`~/.claude-*/projects`. When it finds multiple stores and no config exists, it
creates a private `config.toml` with a `default` profile and uses it
automatically. Sinter never overwrites an existing config. Other harnesses keep
their normal default discovery.

The generated shape is equivalent to:

```toml
[instances.personal]
harness = "claude"
store = "/Users/me/.claude/projects"
command = ["claude"]

[instances.work]
harness = "claude"
store = "/Users/me/.claude-work/projects"
command = ["env", "CLAUDE_CONFIG_DIR=/Users/me/.claude-work", "claude"]

[profiles.default]
include_defaults = true
instances = ["personal", "work"]
```

Select exact stores with `claude@personal:<id>` and targets with
`--to claude@work`. Legacy one-store profiles continue to use the `default`
instance. Requested results and machine data are written to stdout; notices
and errors use stderr, and failures return a non-zero exit code.

## Owner-only Cloud development

Published `0.4.1` is terminal-only. The private `0.5.0-dev.0` build adds Cloud
account, device, and encrypted session-capsule commands for owner-only testing:

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

The CLI reads the source session without modifying it, applies transfer mode and
repository sanitization, encrypts locally to active registered devices, and
uploads only ciphertext through a signed Storage reservation. List returns
content-free metadata. Inspect and pull download, hash-check, verify the signed
sender, and decrypt locally. Pull repeats repository checks before writing a new
session into the exact target instance and records durable local replay.

Every capsule API request also carries an ECDSA device proof over its exact
method, path, body hash, timestamp, and nonce. The server enforces account/device
ownership, active owner entitlement, atomic storage/session quotas, private
Storage, retryable cleanup, and permanent deletion. Public signup remains closed;
real uploads and the owner entitlement remain disabled until the reviewed
migration and deployment are explicitly approved. The CLI remains fully useful
without an account.

## Direct device transfer

In the `0.5.0-dev.0` source build, install the identical tarball on both devices.
On the receiver, explicitly select the root of the target Git checkout and create
a one-use encrypted locator:

```sh
# LAN address is selected automatically when available
sinter receive --to claude@claude-work --cwd ~/Code/project

# Or advertise the device's Tailscale IP explicitly
sinter receive --to claude@claude-work --cwd ~/Code/project --advertise 100.64.0.12
```

Copy the printed `sinter://transfer/v1?...` locator to the sending device:

```sh
sinter send <id-prefix> --to 'sinter://transfer/v1?...'
```

The locator and encrypted transport framing remain version 1; the encrypted
session envelope is repository-bound version 2. The sender derives a sanitized
remote identity, source commit, branch hint, and monorepo-relative directory
from the local checkout. If several remotes remain possible, select one by name
with `send --repo-remote <name>`.

After decryption, the receiver compares sanitized remotes, checks that the
source commit exists locally, validates the relative directory, reports dirty
state, and shows a no-write preview before confirmation. Repository mismatches
and missing commits fail closed unless their dedicated
`--allow-repo-mismatch` or `--allow-missing-commit` option is explicit; `--yes`
cannot bypass those checks. Legacy unbound session payloads are rejected.
Sinter never fetches, checks out, resets, patches, or changes repository files.
It rewrites the imported session to the target-local directory.

The capability encrypts and authenticates one transfer, expires after five
minutes by default, and is never sent to the receiver as an HTTP credential.
Network payloads exclude the source absolute working directory, raw Git URL,
raw adapter records, provider-private state, native store paths, and extra
workspace directories. This transfers conversation context, not repository
files or credentials. LAN and Tailscale use the same direct protocol; no SSH or
Cloud account is required.

## Feedback

Run `sinter feedback` to open a prefilled GitHub issue. Sinter includes only its
version, the Bun version, OS/architecture, and the names of detected harnesses.
It never includes paths, session IDs, prompts, or transcript content. Use
`sinter feedback --no-open` to print the URL instead.

## Local GUI

`sinter gui` opens a local session workspace with harness filters, search,
thread lineage, transcript preview, resume, and port actions. The server binds
only to `127.0.0.1`; a random URL token protects its data and action endpoints.
The browser reads the same local ledger and adapters as the CLI, so transcripts
do not leave the machine. Use `sinter gui --no-open` to print the URL without
launching a browser.

## Anonymous usage measurement

Telemetry is disabled by default. Users can explicitly enable the small,
documented event stream with:

```sh
sinter telemetry enable --endpoint https://your-collector.example/events
sinter telemetry status
sinter telemetry disable
```

Events contain only a random installation ID, Sinter version, OS/architecture,
event name (`first_run`, `scan`, `port_success`, `resume`, or `gui_open`), and
timestamp. CI and non-interactive invocations never emit events. Set
`SINTER_TELEMETRY=0` for an additional environment-level kill switch. The
collector endpoint is intentionally operator-configured until Sinter has a
published first-party privacy policy and endpoint.

## Shell completions

Generate native completions for commands, flags, harness names, and transfer
modes. Sinter prints the script and never edits shell configuration itself.

```sh
# zsh — current shell
source <(sinter completion zsh)

# bash — current shell
source <(sinter completion bash)

# fish — current shell
sinter completion fish | source
```

To make completions permanent, write the generated script into the completion
directory managed by your shell or dotfiles.

## Privacy and safety

- Sinter reads local session stores only; it does not upload transcripts.
- On POSIX systems, the local SQLite ledger and sidecar files are restricted to the current user (`0600`).
- Anonymous product telemetry is off by default and never contains session data.
- Source stores are read-only. A port creates a new target-native session.
- Direct device transfer is end-to-end encrypted and one-use; the locator itself is a secret capability.
- Historical tool calls are rendered inert by default. Use `--live-tools` only when that behavior is explicitly required.
- `sinter privacy` describes local data handling and `sinter doctor` reports detected stores.
- `sinter doctor --report -o sinter-diagnostics.md` creates a reviewable support report without paths, prompts, titles, session IDs, transcripts, or raw adapter errors.

## Harness support

| Harness | Read | Port target | Native resume |
|---|---:|---:|---:|
| Claude Code | yes | yes | yes |
| Codex CLI | yes | yes | yes |
| Devin CLI | yes | yes | yes |
| opencode | yes | yes | yes |
| ZCode | yes | no | unverified |
| Oh My Pi | yes | yes | yes |
| pi | yes | yes | yes |

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned CLI improvements, encrypted
cross-device session transfer, Sinter Cloud, team handoffs, and the longer-term
cloud-execution research path.

Maintainers and resumed coding agents should start with [AGENTS.md](AGENTS.md)
and the dated [current status handoff](docs/current-status.md).

## Development

```sh
bun test
bunx tsc --noEmit
```

Fixtures are wholly synthetic. They retain only vendor-format structure and test edge cases; they contain no user sessions or account data.

## License

Apache-2.0
