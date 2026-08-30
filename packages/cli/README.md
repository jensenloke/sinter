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

npm `latest` remains `0.4.0`. This Cloud-free `0.5.0-dev.0` package is private
and tested only through a locally packed tarball installed identically on both
devices; the public install commands above do not install it yet.

Sinter reads local harness stores and keeps its index on your machine. It does
not require an account or upload transcripts. Historical tool calls are inert
during cross-harness ports unless explicitly enabled for a compatible target.
On POSIX systems, the local SQLite ledger and sidecar files are restricted to
the current user.

Sinter also supports named instances of the same harness and direct encrypted
context transfer over LAN or Tailscale. Direct transfer v2 requires the receiver
to select a target Git root with `--cwd`, compares sanitized repository identity,
checks commit availability, previews dirty state without modifying it, and
rewrites the imported session to the target-local monorepo directory. Legacy
unbound payloads and unsafe targets fail closed; dedicated mismatch and
missing-commit overrides remain explicit in provenance. Run the command-specific
help for `sinter receive` and `sinter send` for the one-use workflow. When multiple
`~/.claude*` stores are present, the first operational run creates and selects
a default multi-instance config without overwriting existing configuration.
Run `sinter help instances` for the agent-safe porting workflow.

This npm package excludes Cloud account, device, capsule, hosted application,
and Storage functionality. Source and built-output gates reject known Cloud
modules and markers before packing or publication.

Documentation, source, roadmap, and issue tracker:
https://github.com/jensenloke/sinter

Licensed under Apache-2.0. See `LICENSE` in this package.
