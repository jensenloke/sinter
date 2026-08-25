# Sinter

Sinter is a local-first CLI for finding, browsing, porting, and resuming
coding-agent sessions across Claude Code, Codex CLI, Devin CLI, OpenCode, Oh My
Pi, and pi.

```sh
bunx @jensenloke/sinter --help
bun add --global @jensenloke/sinter
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

Documentation, source, roadmap, and issue tracker:
https://github.com/jensenloke/sinter

Licensed under Apache-2.0. See `LICENSE` in this package.
