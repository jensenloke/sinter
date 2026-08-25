# Sinter agent instructions

These instructions apply to the entire repository. A resumed agent must read
this file first, then read [docs/current-status.md](docs/current-status.md)
before planning or changing the project. Treat the status page as a dated
handoff: verify mutable facts such as the current branch, worktree, npm version,
and remote state before acting.

## GBrain remote-only policy

GBrain is hosted remotely on the Mac Mini and exposed through the configured
`gbrain` MCP server. Use MCP tools for brain search/query/get/write operations.
Do not create, initialize, sync, or query a MacBook-local GBrain store. If the
MCP server is unavailable, report that GBrain is unavailable instead of
falling back locally. On the Mac Mini, the local `gbrain` CLI is reserved for
host maintenance; normal agent work should still prefer MCP. Never commit a
private GBrain address, credential, or personal infrastructure detail here.

## Continuation protocol

1. Read `docs/current-status.md`, `ROADMAP.md`, and the latest file under
   `docs/releases/`.
2. Run `git status --short --branch`, inspect the current branch, and compare it
   with the relevant remote before editing. Preserve unrelated user changes.
3. Check the public npm version before any release. Published npm versions are
   immutable; never attempt to republish the same version.
4. Keep the open-source CLI local-first. Do not mix hosted Sinter Cloud work
   into CLI feature branches unless the user explicitly changes scope.
5. Before a release or handoff, run the repository verification commands
   documented in `docs/current-status.md` and update that page if its facts or
   next actions changed materially.

## Public clone parity

The maintainer may have both `sinter` and a sibling `sinter-public` working
copy. At the time this instruction was written, both clones use the same public
upstream repository; `sinter-public` is a second checkout, not a second product
or an independent source of truth.

- Verify both remotes before assuming this is still true:
  `git remote -v` and `git -C ../sinter-public remote -v`.
- Commit and push a branch once from the active canonical checkout. Do not push
  duplicate branches independently from both clones.
- After the change is merged to the public default branch, update the sibling
  checkout with `git -C ../sinter-public pull --ff-only` only when its worktree
  is clean. If it is dirty or diverged, stop and report it; never reset or
  overwrite it.
- Before declaring parity, compare `HEAD`, the package version, release notes,
  and the verification result in both checkouts.
- If the remotes later become different private/public repositories, do not
  copy blindly. Port only public-safe source and documentation, exclude secrets
  and internal infrastructure, run the full public verification gate, and
  record the paired commits in `docs/current-status.md`.

## Repository conventions

- The published package is `@jensenloke/sinter` from `packages/cli`.
- Use the tuple `(harness, instance, native-id)` for session identity. Omitted
  instance values mean the stable `default` instance.
- Source harness stores are read-only. Ports and receives create new target
  sessions; historical tools remain inert unless explicitly requested.
- Direct transfer moves sanitized conversation context, not credentials or an
  implicit workspace snapshot.
- Use `rg` for repository search and `apply_patch` for manual file edits.
