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

See the [v0.1.7 release notes](docs/releases/v0.1.7.md) for the latest changes.

## Quick start

```sh
sinter scan
sinter ls --since 7d
sinter search "session alias or topic"
sinter rename <id-prefix> "My important session"
sinter show <id-prefix>
sinter port <id-prefix> --to omp
sinter resume <id-prefix> --in omp --exec
```

## Privacy and safety

- Sinter reads local session stores only; it does not upload transcripts.
- Source stores are read-only. A port creates a new target-native session.
- Historical tool calls are rendered inert by default. Use `--live-tools` only when that behavior is explicitly required.
- `sinter privacy` describes local data handling and `sinter doctor` reports detected stores.

## Harness support

| Harness | Read | Port target | Native resume |
|---|---:|---:|---:|
| Claude Code | yes | yes | yes |
| Codex CLI | yes | yes | yes |
| Devin CLI | yes | yes | yes |
| opencode | yes | yes | yes |
| ZCode | yes | experimental | unverified |
| Oh My Pi | yes | yes | yes |
| pi | yes | yes | yes |

## Development

```sh
bun test
bunx tsc --noEmit
```

Fixtures are wholly synthetic. They retain only vendor-format structure and test edge cases; they contain no user sessions or account data.

## License

Apache-2.0
