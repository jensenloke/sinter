# omp vs pi — session dialect forensics

**Question settled:** both claim `version: 3` and the *message core* is byte-compatible, but the
*envelope* diverges in five places. The earlier "byte-compatible v3" report and the "d.ts shows
divergence" report were both partly right: **an omp reader can read a pi file, but a pi reader
cannot read an omp file**, and a writer must pick a dialect.

Verified 2026-08-13 against:

| Source | Version | Path |
|---|---|---|
| omp source (TS, MIT) | `omp/17.2.15` | `~/node_modules/@oh-my-pi/pi-coding-agent/src/session/` |
| pi dist (`.d.ts` + `.js`) | `0.84.1` | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.*` |
| live omp store | 3 sessions + 3 subagents | `~/.omp/agent/sessions/` |
| live pi store | 4 sessions | `~/.pi/agent/sessions/` |

---

## 1. What is identical (the shared core)

Both write append-only JSONL where every record after the header is an entry with
`{type, id (8 hex chars), parentId: string|null, timestamp: ISO}` forming a **tree**.

`message` entries are identical in both, including the unusual bits:

- `message.role` is one of `user | assistant | toolResult` — **`toolResult` is a TOP-LEVEL role**,
  not a content part. It maps 1:1 to SIF `ToolResultEntry`.
- `user`: `{role, content: string | (text|image)[], timestamp}`.
- `assistant`: `{role, content: (text | thinking | toolCall)[], api, provider, model, usage, stopReason, timestamp}`.
- `toolCall` part: `{type:"toolCall", id, name, arguments}`.
- `thinking` part: `{type:"thinking", thinking, thinkingSignature}` — identical key name in both.
- `toolResult`: `{role, toolCallId, toolName, content, isError, timestamp}`.
- `custom` / `custom_message` / `compaction` / `label` / `branch_summary` /
  `thinking_level_change` carry the same base shape.

**Correction to PLAN.md §2.1:** the plan says "omp/pi have none" for token usage. That is wrong.
**Both** record real `usage` on assistant messages. Shapes differ slightly:

```jsonc
// omp                                       // pi
{ "input", "output", "cacheRead",            { "input", "output", "cacheRead",
  "cacheWrite", "totalTokens",                 "cacheWrite", "reasoning",
  "reasoningTokens",                           "totalTokens",
  "cost": {input,output,cacheRead,             "cost": {input,output,cacheRead,
           cacheWrite,total} }                          cacheWrite,total} }
```

i.e. reasoning tokens are `usage.reasoningTokens` (omp) vs `usage.reasoning` (pi). The reader
accepts either. `cost.total` is frequently `0` for non-billing providers — it is only mapped to
`usage.costUsd` when non-zero (never zero-fill, per CONVENTIONS §4).

---

## 2. The five real divergences

### D1 — `model_change` shape (**breaking**)

| | shape |
|---|---|
| omp | `{type:"model_change", model:"provider/modelId", role?:"default"\|"smol"\|…, resolvedModelIsFallback?:bool}` |
| pi  | `{type:"model_change", provider:"…", modelId:"…"}` |

Live evidence:
```jsonc
// omp  ~/.omp/agent/sessions/-workspace/…_session.jsonl
{"type":"model_change","id":"entry-a","parentId":"entry-root","timestamp":"…","model":"provider/model","role":"default","resolvedModelIsFallback":false}
// pi   ~/.pi/agent/sessions/--home-demo--/…_session.jsonl
{"type":"model_change","id":"entry-b","parentId":null,"timestamp":"…","provider":"provider","modelId":"model"}
```
Source: `session-entries.ts:79-88` (omp) vs `session-manager.d.ts:29-33` (pi).

The reader accepts both (`provider` + `modelId` if present, else split `model` on the **first**
`/` — note pi model ids can themselves contain slashes, e.g.
`accounts/fireworks/routers/kimi-k2p6-turbo`, so splitting on the first `/` only is required).
The writer emits per dialect.

### D2 — the 256-byte title slot (**omp only**)

omp's line 1 is *optionally* a fixed-width mutable title record:
```jsonc
{"type":"title","v":1,"title":"…","source":"auto","updatedAt":"…","pad":"      … "}
```
padded with spaces to **exactly 256 UTF-8 bytes including the trailing newline**
(`SESSION_TITLE_SLOT_BYTES = 256`, `session-entries.ts:7`; serializer
`session-title-slot.ts:serializeTitleSlot`). It exists so omp can rewrite the title in place with
one 256-byte pwrite instead of rewriting the file.

It is not the header and it is not an entry; omp's loader peels it and *folds* it over
`header.title`/`header.titleSource` (`session-loader.ts:splitTitleSlot` / `foldTitleSlot`) — the
slot **wins** over the header when both are present, and an empty slot title **deletes**
`header.title`.

pi has no such concept: its `parseSessionEntries` treats line 1 as the header. A pi reader fed an
omp file with a slot will fail to find the header.

Contrary to the briefing, the slot line **is** valid JSON (omp's own comment calls it "NOT JSON",
meaning "not a session *entry*"). So `readJsonl` from core parses it fine; the reader just has to
recognise `type === "title" && v === 1` and not emit an entry for it. The reader still checks the
byte length so drift is visible.

Title truncation is by **code point** binary search until the serialized line fits 256 bytes
(`truncateTitleForSlot`), which this implementation replicates exactly.

### D3 — header fields (**omp superset**)

```ts
// omp SessionHeader (session-entries.ts:26-46)
{ type:"session", version:3, id, timestamp, cwd,
  title?, titleSource?, additionalDirectories?, parentSession?,
  previousSessionFiles?, providerPromptCacheKey? }
// pi SessionHeader (session-manager.d.ts:5-12)
{ type:"session", version:3, id, timestamp, cwd, parentSession? }
```
pi has **no** `title`/`titleSource`. A pi session's title is derived (first user message) or comes
from a `session_info` entry (see D5). The writer therefore never emits `title` into a pi header.

Header must land within the first 4KB — omp's cheap lister reads only
`SESSION_LIST_PREFIX_BYTES = 4096` (`session-listing.ts:59`), pi uses
`SESSION_HEADER_READ_BUFFER_SIZE = 4096` (`session-manager.js:256`). With a slot present that
leaves 3840 bytes; a very long `cwd` + `additionalDirectories` could in principle overflow it, so
the writer asserts header-within-4KB before writing.

### D4 — cwd → directory-name encoding (**three-way, lossy, never invert**)

pi (`session-manager.js:242-247`) has exactly one scheme, the legacy absolute one:
--${abs.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--     →  /home/demo  →  --home-demo--
```

omp (`session-paths.ts:36-88`) picks one of three by scope, **home-relative first**:
```
home:  path.relative(home, cwd)   → "-" + rel.replace(/[/\\:]/g,"-")   → /home/demo/workspace → -workspace
                                    (rel === ""                        → /home/demo           → -)
tmp:   path.relative(tmpdir, cwd) → "-tmp" + "-" + encoded             → /private/tmp/x          → -tmp-x
abs:   otherwise                  → --…--  (same as pi)                → /opt/foo                → --opt-foo--
```
Both paths canonicalise through `resolveEquivalentPath` (symlink/`/private` folding) first — on
macOS `/tmp` → `/private/tmp`, which is why the live store shows `--private-tmp--` (an *abs*-scope
dir written before the tmp branch existed) alongside `-Documents`.

This is lossy in both directions (a literal `-` in a path segment is indistinguishable from a
separator), hence CONVENTIONS §3: always read `cwd` from the header, never from the dirname. The
writer implements omp's scheme faithfully (`paths.ts:ompSessionDirName`) rather than guessing.

### D5 — entry-type vocabulary

| entry type | omp | pi | notes |
|---|:--:|:--:|---|
| `message`, `custom`, `custom_message`, `label`, `compaction`, `branch_summary`, `thinking_level_change`, `model_change` | ✅ | ✅ | shared core |
| `title_change` | ✅ | ❌ | append-only audit log of title edits |
| `session_init` | ✅ | ❌ | **first entry of a subagent sidecar file**; carries `systemPrompt`, `task`, `tools`, `agent`, `modelRole`, `resolvedModel` |
| `mode_change` | ✅ | ❌ | plan mode etc. |
| `reset_boundary` | ✅ | ❌ | `/clear` marker |
| `ttsr_injection`, `credential_pin`, `service_tier_change` | ✅ | ❌ | |
| `session_info` | ❌ | ✅ | `{name?}` — pi's user-set display name; **this is where a pi title lives** |

Sub-shape drift within shared types:
- `thinking_level_change`: omp adds `configured` (`"auto"` vs a concrete level).
- `compaction`: omp adds `shortSummary`, `preserveData`, `fromExtension`, `warning`;
  pi has `usage` and `fromHook` (omp renamed `fromHook` → `fromExtension`).
- `toolCall` part: omp adds `intent`, `partialArgs`, `streamIndex`.
- `assistant` message: omp adds `contextSnapshot`, `duration`, `ttft`; pi adds `errorMessage`, `rawStopReason`.
- `user` message: omp adds `attribution`.

All of these survive as `raw` on the SIF entry, so the extra fields round-trip.

---

## 3. omp-only: the sidecar directory

`artifactsDirectoryFor(sessionFile) = sessionFile.slice(0, -6)` — strip `.jsonl`
(`session-manager.ts:99`, `session-storage.ts:441`). So
`…/<ts>_<uuid7>.jsonl` pairs with `…/<ts>_<uuid7>/`, containing:

- **`<AgentName>.jsonl`** — a full subagent transcript in the *same* format (own title slot, own
  `session` header with its own uuid7, then a `session_init` entry). Written by
  `task/executor.ts:2689` as `path.join(artifactsDir, `${id}.jsonl`)` where `id` is the **job id**
  from the `task` tool call. → loaded into `SifSession.subsessions`.
- **`<seq>.<tool>.log`** — spilled tool output, referenced as `artifact://…` from tool results.
- **`draft.txt`**, `<AgentName>.md` — editor draft / structured agent output.

**Parent↔child linkage** (no `parentSession` on the child header — verified, subagent headers omit
it): the link is by **job id == file basename**. The parent records
1. a `task` toolCall whose `arguments.tasks[].name` is the job id,
2. `custom_message` entries with `customType:"async-result"` and
   `details.jobs[].jobId === "<AgentName>"`.

The reader emits a `SubsessionEntry` at the position of the async-result (falling back to the
`task` toolResult, then to end-of-session) with `sessionRef` = the child's native id and
`agentName` = the basename.

pi has no sidecar directory at all.

---

## 4. Consequences for sinter

1. **One reader, one dialect flag.** `readNativeSession()` is dialect-agnostic on the message core
   and branches only on D1/D2/D5. pi files parse under the omp reader unchanged.
2. **Two writers, one code path.** `writeNativeSession()` takes a `Dialect` describing D1–D4.
   pi's writer falls out for free (the briefing's "if it falls out cheaply" — it did).
3. **`list()` stays cheap** by reading a 4KB head window: peel the slot, parse the header, done.
   No full parse. Message counts are deliberately *not* computed during `list()`.
4. **Resume** — `omp --resume <id>` (`-r`, accepts an id prefix) vs `pi --session <id>`
   (`--resume`/`-r` in pi takes **no argument**; it opens the picker). Both accept
   `--session-dir <dir>`, which is what makes the offline write-test possible.
5. **omp reads its own title from the slot, not the header** when a slot is present. Since the
   writer omits the slot by default, omp falls back to `header.title` — verified working (see the
   adapter report). `--emit-title-slot` is available if that ever regresses.
