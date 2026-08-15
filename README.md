# sinter

Sinter indexes local coding-agent sessions, renders a portable session format, and ports supported sessions between harnesses.

## Install

```sh
bun install
bun run sinter --help
```

## Quick start

```sh
sinter scan
sinter ls --since 7d
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
