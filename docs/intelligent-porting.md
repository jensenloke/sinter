# Intelligent target-aware porting

Status: implemented on `feat/intelligent-porting` in
[PR #25](https://github.com/jensenloke/sinter/pull/25), targeting `main`.
Implementation commit: `65d34d1`.
Last verified: 2026-08-26.

## Why this exists

A portable session can be larger than the receiving harness can safely admit.
Blindly writing the complete history can make the target refuse inference or
trigger a failing native compaction loop. Refusing every oversized session is
also too conservative when Sinter can produce a useful, inspectable
continuation without touching the source.

The motivating production case was a multi-hop Codex/OMP session imported into
Devin. Devin's native compactor amplified the oversized history before failing.
Sinter already bounded foreign-to-Devin history; the incident and original
safeguard are recorded in the [v0.1.5 release notes](releases/v0.1.5.md). This
change turns that target safeguard into a programmatic planning contract and
makes transfer-mode selection automatic.

## Product decision

Sinter should choose the least destructive representation that the target can
safely admit:

1. `full` preserves the complete SIF representation.
2. `slim` removes raw provider records.
3. `compact` deterministically removes thinking and repetitive tool noise while
   preserving user and assistant conversation.
4. If compact still exceeds a verified target budget, use the target adapter's
   explicit bounded fallback.
5. Refuse the port if the adapter's final plan still exceeds its limit or if the
   adapter reports an inconsistent plan.

This path is local and deterministic. It does not call a model, infer missing
facts, or mutate the source session. Every reduction remains visible in the
ported session and in preview output.

## Current command behavior

`auto` is now the default transfer mode for:

- `sinter port`;
- `sinter import`;
- cross-harness `sinter resume --in`;
- the interactive TUI; and
- the local GUI.

Explicit `full`, `slim`, and `compact` modes remain available. An explicit mode
is not silently replaced with another mode, although a target's existing safety
fallback may still bound the native history when required.

The automatic planner follows this algorithm:

```text
if the target cannot report a verified budget:
    preserve full and report target-unknown
else:
    evaluate full, slim, compact in that order
    select the first candidate whose pre-fallback native context fits
    if compact still does not fit but the target's bounded result does:
        select compact plus the target fallback
    otherwise:
        refuse
```

A target without planning support does not cause speculative compaction. It
keeps the previous full-transfer behavior and reports `target-unknown`.

## Adapter contract

`HarnessAdapter` now has an optional side-effect-free method:

```ts
planWrite?(session: SifSession, opts?: WriteOpts): Promise<WritePlan>
```

A plan may report:

```ts
interface WriteContextPlan {
  unit: "bytes" | "tokens";
  limit: number;
  before: number;
  after: number;
  omittedEntries: number;
  strategy: "none" | "opening-and-tail";
}
```

Semantics:

- `limit` is an admission budget, not necessarily the model's advertised
  context window. The adapter owns any required safety margin.
- `before` is the target-native active context size before its fallback.
- `after` is the target-native active context size that will actually be
  written after the fallback.
- `omittedEntries` is the number of older active entries removed by the target.
- `strategy = none` means the target does not transform the candidate.
- `strategy = opening-and-tail` means the target keeps the opening objective and
  the newest usable history.

Sinter rejects plans with non-finite or negative sizes, non-positive limits,
invalid omission counts, impossible size growth, or inconsistent `none`
strategies. Adapter planning must remain side-effect-free and must share its
native construction logic with `write()` so preview and execution cannot drift.

## Devin implementation

Devin is currently the only adapter with a verified target admission budget.
For foreign-to-Devin writes:

- the active native history budget is 200,000 bytes;
- the first real user request is retained;
- the newest history fills the remaining budget;
- an individual native message is clipped to approximately 40,000 bytes;
- a visible system message records how much older history was omitted;
- the resulting chain is rebuilt linearly with the newest retained message as
  the active tip; and
- foreign provider reasoning signatures and model state remain excluded.

`planWrite()` and `write()` both call the same `planNativeWrite()` path. Tests
assert that the planned final byte count equals the bytes written to Devin's
SQLite message chain.

Same-harness Devin movement is not capped by this cross-harness safeguard.

## Source and carry behavior

The source harness store remains read-only and unchanged. Sinter carry data
retains the transferred SIF when it is within the existing carry limit. Carry
storage has a finite limit, so documentation and target omission notes must not
claim that arbitrarily large source histories are always duplicated in carry.
The authoritative original remains the source session unless a future capsule
or backup flow explicitly preserves it elsewhere.

## Preview and capability output

`port --preview` now reports:

- `requestedMode`;
- the concrete selected `mode`;
- `selection` (`requested`, `fits`, `target-bounded`, or `target-unknown`);
- `evaluatedModes`; and
- `targetContext`, when the target reports one.

Human preview output displays the same mode resolution and target sizes.
Normal CLI, TUI, and GUI actions report `auto → <selected mode>` and any
expected target-side omission.

`sinter capabilities` adds `contextPlanning` to JSON output and a `FIT` column
to the human support matrix.

## Current boundary

Only Devin reports a verified budget in PR #25. Claude, Codex, OpenCode, OMP,
and pi currently preserve `full` under auto mode and report that the target
budget is unknown. ZCode remains read-only.

Do not hardcode context-window guesses for these targets. Their usable budget
can depend on the selected model, provider, harness version, system prompt,
tool schemas, and local configuration. Extend each adapter only when it can
produce a defensible native estimate and use the same estimate during writing.

## Main implementation locations

- `packages/core/src/adapter.ts`: planning contract.
- `packages/cli/src/transfer.ts`: automatic mode evaluation and plan validation.
- `packages/cli/src/commands.ts`: port/import/resume planning and preview output.
- `packages/cli/src/tui/`: TUI default and execution path.
- `packages/cli/src/gui.ts`: GUI auto mode and combined result reporting.
- `packages/cli/src/capabilities.ts`: context-planning capability surface.
- `packages/adapters/devin/src/index.ts`: shared Devin planning/writing path.

Primary regression coverage is in:

- `packages/cli/test/tui.test.ts`;
- `packages/cli/test/commands.test.ts`;
- `packages/cli/test/gui.test.ts`;
- `packages/cli/test/port-fidelity.test.ts`; and
- `packages/adapters/devin/test/devin.test.ts`.

## Verification baseline

PR #25 passed locally with:

- 622 tests;
- 8,769 assertions;
- TypeScript checking;
- production CLI build;
- npm tarball inspection; and
- isolated Bun and npm global-install verification.

GitHub's macOS and Ubuntu verification jobs also passed for the implementation
commit before this documentation update.

Run the complete gate with:

```sh
bun run typecheck
bun test
bun run build:cli
bun run verify:package
```

## Recommended continuation

1. Preserve the safe unknown-target behavior: auto must remain full when no
   verified budget is available.
2. Add adapter planning one target at a time, deriving the budget from real
   target-native state rather than a generic harness constant where possible.
3. Add real oversized fixtures and assert preview/write agreement for every new
   target planner.
4. Keep model-generated digest or continuation-brief work as a separate,
   explicit artifact. Never silently substitute it for the transcript.
5. Decide whether profiles need an explicit user override for target budgets,
   including units and safety margins, only after adapter-derived limits are
   understood.
6. Revisit carry guarantees before claiming recovery of arbitrarily large
   omitted histories.
7. Keep hosted Sinter Cloud work out of this CLI feature branch.
