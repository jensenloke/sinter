# Intelligent target-aware porting

Status: implemented on the context-budget feature branch.

## Product decision

Ports, imports, cross-harness resumes, the TUI, and the local GUI use
`--mode auto` by default. The planner evaluates `full`, `slim`, and `compact`
in that order and chooses the least destructive representation that fits the
target's verified native context plan. If no target budget is available, Sinter
preserves the full session rather than guessing. A target-side bounded fallback
is accepted only when its final plan fits; otherwise the operation is refused.

Target selection is instance-aware. Use qualified forms such as
`--to claude@personal` or `--to claude@work`; planning and writing always use
the adapter bound to that exact instance. The source store remains read-only.

Direct `send` and Cloud `push` are context-only transfers and remain
concrete-only: their modes are `full`, `slim`, and `compact`; they do not
accept `auto`.

## Adapter contract

Adapters may implement the side-effect-free method:

```ts
planWrite?(session: SifSession, opts?: WriteOpts): Promise<WritePlan>
```

Plans report `unit`, `limit`, `before`, `after`, `omittedEntries`, and either
`none` or `opening-and-tail`. The CLI rejects impossible or inconsistent plans.
Planning and writing share native construction logic so previews cannot drift
from execution.

## Devin

Devin is currently the only adapter with a verified foreign-session admission
budget. Its active history cap is 200,000 **UTF-8 bytes**, not JavaScript
string length. Foreign histories retain the opening request, fill the newest
usable tail, clip individual messages to approximately 40,000 bytes without
splitting Unicode code points, and add a visible omission note. `planWrite()` and
`write()` share the same cap path, and writes refuse to persist a result whose
planned context still exceeds the limit.

Same-harness Devin movement is not subject to this cross-harness safeguard.
The original source session and SIF carry remain authoritative.

## Preview and implementation locations

`port --preview` reports the requested mode, selected concrete mode, selection,
evaluated candidates, and target context before writing. Human actions report
automatic mode selection and expected target-side omissions.

The implementation is in:

- `packages/core/src/adapter.ts` — planning contract;
- `packages/cli/src/transfer.ts` — mode evaluation and plan validation;
- `packages/cli/src/commands.ts` — command routing and previews;
- `packages/cli/src/tui/` and `packages/cli/src/gui.ts` — interactive clients;
- `packages/adapters/devin/src/index.ts` — byte-accurate native cap.

Regression coverage is in the CLI command, completion, GUI, TUI, port-fidelity,
and Devin adapter test suites.

## Verification

Run:

```sh
bun run typecheck
GIT_CONFIG_GLOBAL=/dev/null bun test
bun run build:cli
git diff --check
```

Do not add speculative context-window constants for other harnesses. Extend an
adapter only when it can derive and enforce a defensible native budget.
