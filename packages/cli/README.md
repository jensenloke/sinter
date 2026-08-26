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

Sinter reads local harness stores and keeps its index on your machine. It does
not require an account or upload transcripts. Historical tool calls are inert
during cross-harness ports unless explicitly enabled for a compatible target.
On POSIX systems, the local SQLite ledger and sidecar files are restricted to
the current user.

Sinter also supports named instances of the same harness and direct encrypted
context transfer over LAN or Tailscale. Run `sinter receive --help` and
`sinter send --help` for the one-use transfer workflow. When multiple
`~/.claude*` stores are present, the first operational run creates and selects
a default multi-instance config without overwriting existing configuration.
Run `sinter help instances` for the agent-safe porting workflow.

Custom Claude stores hidden behind shell aliases can be previewed only through
`sinter config discover-shell`. This explicit opt-in executes the selected
zsh/bash login startup files to list aliases; normal startup, setup, and scans
never do so. Only simple `CLAUDE_CONFIG_DIR=<path> claude` aliases are accepted,
raw alias output is suppressed, and `--write --yes` creates a missing owner-only
config without ever overwriting an existing one.

Run `sinter update` to install the exact latest published build into the global
bun or npm installation that owns the current executable. If that ownership is
ambiguous, pass `--package-manager bun` or `--package-manager npm`; use
`--check` for a side-effect-free registry check.

Sinter Cloud is currently a private alpha for existing members; the CLI remains
fully usable without it. Approved members can register devices without uploading
sessions:

```sh
sinter login
sinter devices register --name "My Mac"
sinter devices list
```

Private device keys stay local. A subsequent device requires signed approval
from an existing active device. Session upload and sync remain disabled.

Documentation, source, roadmap, and issue tracker:
https://github.com/jensenloke/sinter

Licensed under Apache-2.0. See `LICENSE` in this package.
