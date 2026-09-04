/**
 * The interactive menu as a pure state machine.
 *
 * `reduce(state, key)` returns the next state plus an optional Effect — the
 * only things that touch the world (spawn a harness, write a session, rescan).
 * Everything here is deterministic so it can be driven from tests without a tty.
 *
 * The unit of selection is a THREAD, not a ledger row: one conversation that may
 * already have hopped between harnesses. Porting always works from the thread's
 * tip, which is what makes `codex → claude → codex` carry the middle hop's work.
 */

import { DEFAULT_INSTANCE_ID, type HarnessId, type InstanceId } from "@sinter/core";
import type { LedgerRow } from "@sinter/ledger";
import { displayId } from "../format";
import { MODE_HINT, TRANSFER_MODES, type TransferMode } from "../transfer";
import type { Key } from "./keys";
import type { Thread } from "./threads";
export type Screen = "sessions" | "actions";
export type Scope = "cwd" | "all";

/** What a harness can do on this machine, resolved once at startup. */
export interface HarnessCaps {
  id: HarnessId;
  instanceId?: InstanceId;
  /** The adapter package loaded. */
  available: boolean;
  /** The adapter implements write() — i.e. it is a valid port target. */
  canWrite: boolean;
  /** The resume binary is on PATH. */
  onPath: boolean;
  /** resumeCommand() is a guess, not a verified entry point (zcode). */
  experimental?: boolean;
  /** Why the adapter is unavailable. */
  error?: string;
}

export type ActionKind = "resume" | "port" | "rename" | "show";

export interface MenuAction {
  kind: ActionKind;
  /** Target harness — the tip's harness for `resume`, undefined for `show`. */
  harness?: HarnessId;
  instanceId?: InstanceId;
  label: string;
  hint: string;
  /** Exact `sinter` CLI equivalent for this action. */
  command: string;
  /** Set when the action cannot run; the reason is shown and Enter is a no-op. */
  disabled?: string;
}

export interface MenuState {
  screen: Screen;
  /** Every candidate thread, newest tip first. Filters narrow this, never refetch. */
  threads: Thread[];
  caps: HarnessCaps[];
  cwd: string;
  scope: Scope;
  filter: string;
  harnessFilter: HarnessId | null;
  showGhosts: boolean;
  showSubagents: boolean;
  cursor: number;
  scroll: number;
  /** Visible row count on the sessions screen; set by the renderer each frame. */
  pageSize: number;
  actionCursor: number;
  /** How much of the transcript rides along on a port. */
  mode: TransferMode;
  selected?: Thread;
  /** Transient one-line status, cleared on the next keypress. */
  message?: string;
}

export type Effect =
  | { type: "quit" }
  | { type: "rescan" }
  | { type: "show"; thread: Thread }
  | { type: "rename"; thread: Thread }
  /** Resume the tip natively — nothing is written. */
  | { type: "resume"; thread: Thread }
  /** Port the tip into `target` with `mode`, then launch the new session. */
  | { type: "port"; thread: Thread; target: HarnessId; targetInstanceId: InstanceId; mode: TransferMode };

export interface Step {
  state: MenuState;
  effect?: Effect;
}

export const HARNESS_ORDER: HarnessId[] = ["claude", "codex", "devin", "opencode", "zcode", "omp", "pi"];

export function initialState(init: {
  threads: Thread[];
  caps: HarnessCaps[];
  cwd: string;
  scope?: Scope;
  mode?: TransferMode;
}): MenuState {
  return {
    screen: "sessions",
    threads: init.threads,
    caps: init.caps,
    cwd: init.cwd,
    // Default to the directory you ran sinter in, but only when it has
    // sessions — otherwise the menu would open empty.
    scope: init.scope ?? (init.threads.some((t) => t.tip.cwd === init.cwd) ? "cwd" : "all"),
    filter: "",
    harnessFilter: null,
    showGhosts: false,
    showSubagents: false,
    cursor: 0,
    scroll: 0,
    pageSize: 10,
    actionCursor: 0,
    mode: init.mode ?? "auto",
  };
}

// ------------------------------------------------------------------ filtering

function haystack(t: Thread): string {
  return t.hops
    .map(
      (r) =>
        `${r.nativeId} ${r.harness} ${r.cwd ?? ""} ${r.alias ?? ""} ${r.title ?? ""} ${r.firstPrompt ?? ""} ${r.note ?? ""} ${r.tags?.join(" ") ?? ""} ${
          r.gitBranch ?? ""
        } ${r.model ?? ""}`,
    )
    .join(" ")
    .toLowerCase();
}

/** All whitespace-separated terms must appear. Cheap and predictable. */
export function matches(thread: Thread, filter: string): boolean {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = haystack(thread);
  return terms.every((t) => hay.includes(t));
}

export function visibleThreads(state: MenuState): Thread[] {
  return state.threads.filter((t) => {
    if (state.scope === "cwd" && !t.hops.some((h) => h.cwd === state.cwd)) return false;
    // A harness filter matches any hop: filtering to "codex" should surface a
    // conversation that started in codex even if it now lives in claude.
    if (state.harnessFilter && !t.hops.some((h) => h.harness === state.harnessFilter)) return false;
    if (!state.showGhosts && t.tip.ghost) return false;
    if (!state.showSubagents && t.tip.isSubagent) return false;
    return matches(t, state.filter);
  });
}

/** Harnesses that actually appear in the loaded threads, in canonical order. */
export function presentHarnesses(threads: Thread[]): HarnessId[] {
  const seen = new Set<HarnessId>();
  for (const t of threads) for (const h of t.hops) seen.add(h.harness);
  return HARNESS_ORDER.filter((h) => seen.has(h));
}

// -------------------------------------------------------------------- actions

function capOf(caps: HarnessCaps[], id: HarnessId, instanceId?: InstanceId): HarnessCaps | undefined {
  return caps.find((c) => c.id === id && (c.instanceId ?? DEFAULT_INSTANCE_ID) === (instanceId ?? DEFAULT_INSTANCE_ID));
}

function capLabel(cap: Pick<HarnessCaps, "id" | "instanceId">): string {
  return cap.instanceId && cap.instanceId !== DEFAULT_INSTANCE_ID ? `${cap.id}@${cap.instanceId}` : cap.id;
}

/**
 * The action list for one thread. Impossible actions stay visible with the
 * reason attached — a menu that silently hides "port → codex" reads as a bug,
 * not as a missing feature.
 */
export function buildActions(thread: Thread, caps: HarnessCaps[]): MenuAction[] {
  const tip: LedgerRow = thread.tip;
  const id = displayId(tip.nativeId);
  const actions: MenuAction[] = [];
  const own = capOf(caps, tip.harness, tip.instanceId);
  const ownLabel = capLabel({ id: tip.harness, instanceId: tip.instanceId });
  const visited = new Set(
    thread.hops.map((hop) => capLabel({ id: hop.harness, instanceId: hop.instanceId })),
  );

  let resumeDisabled: string | undefined;
  if (tip.ghost) resumeDisabled = "transcript is gone (ghost row)";
  else if (!own?.available) resumeDisabled = own?.error ?? "adapter not available";
  else if (!own.onPath) resumeDisabled = `\`${ownLabel}\` is not on PATH`;

  actions.push({
    kind: "resume",
    harness: tip.harness,
    instanceId: tip.instanceId ?? DEFAULT_INSTANCE_ID,
    label: `resume in ${ownLabel}`,
    hint: own?.experimental ? "native · resume command unverified" : "native · nothing is written",
    command: `sinter resume ${ownLabel}:${id} --exec`,
    disabled: resumeDisabled,
  });

  const targets = [...caps].sort((a, b) => {
    const order = HARNESS_ORDER.indexOf(a.id) - HARNESS_ORDER.indexOf(b.id);
    return order || capLabel(a).localeCompare(capLabel(b));
  });
  for (const cap of targets) {
    const target = cap.id;
    const targetInstanceId = cap.instanceId ?? DEFAULT_INSTANCE_ID;
    if (target === tip.harness && targetInstanceId === (tip.instanceId ?? DEFAULT_INSTANCE_ID)) continue;
    const targetLabel = capLabel(cap);
    let disabled: string | undefined;
    if (tip.ghost) disabled = "source transcript is gone (ghost row)";
    else if (!cap.available) disabled = cap.error ?? "adapter not available";
    else if (!cap.canWrite) disabled = "no writer yet";
    else if (!cap.onPath) disabled = `\`${targetLabel}\` is not on PATH`;

    const revisit = visited.has(targetLabel) ? "back to " : "";
    actions.push({
      kind: "port",
      harness: target,
      instanceId: targetInstanceId,
      label: `port → ${revisit}${targetLabel}`,
      hint: disabled
        ? ""
        : cap?.experimental
          ? "writes a new session · resume unverified"
          : "writes a new session, then launches it",
      command: `sinter resume ${id} --in ${targetLabel} --exec`,
      disabled,
    });
  }

  actions.push({
    kind: "rename",
    label: tip.alias ? "change Sinter alias" : "set Sinter alias",
    hint: "local label · survives rescans · native store unchanged",
    command: `sinter rename ${id} "<alias>"`,
  });

  actions.push({
    kind: "show",
    label: "show transcript",
    hint: "print it here and exit",
    command: `sinter show ${id}`,
    disabled: tip.ghost ? "transcript is gone (ghost row)" : undefined,
  });

  return actions;
}

/** First enabled action, so the cursor never opens on a dead row. */
export function firstEnabled(actions: MenuAction[]): number {
  const i = actions.findIndex((a) => !a.disabled);
  return i === -1 ? 0 : i;
}

export function modeLabel(mode: TransferMode): string {
  return `${mode} — ${MODE_HINT[mode]}`;
}

// -------------------------------------------------------------------- reducer

function clampCursor(state: MenuState, count: number): MenuState {
  const cursor = count === 0 ? 0 : Math.min(Math.max(0, state.cursor), count - 1);
  const page = Math.max(1, state.pageSize);
  let scroll = state.scroll;
  if (cursor < scroll) scroll = cursor;
  if (cursor >= scroll + page) scroll = cursor - page + 1;
  scroll = Math.max(0, Math.min(scroll, Math.max(0, count - page)));
  return { ...state, cursor, scroll };
}

function move(state: MenuState, delta: number): MenuState {
  const count = visibleThreads(state).length;
  if (!count) return state;
  return clampCursor({ ...state, cursor: state.cursor + delta }, count);
}

/** Reset the cursor to the top whenever the visible set changes under it. */
function refiltered(state: MenuState): MenuState {
  return clampCursor({ ...state, cursor: 0, scroll: 0 }, visibleThreads(state).length);
}

function cycleHarness(state: MenuState, dir: 1 | -1): MenuState {
  const present = presentHarnesses(state.threads);
  const options: (HarnessId | null)[] = [null, ...present];
  const at = options.indexOf(state.harnessFilter);
  const next = options[(at + dir + options.length) % options.length]!;
  return refiltered({ ...state, harnessFilter: next });
}

function cycleMode(state: MenuState, dir: 1 | -1): MenuState {
  const at = TRANSFER_MODES.indexOf(state.mode);
  const next = TRANSFER_MODES[(at + dir + TRANSFER_MODES.length) % TRANSFER_MODES.length]!;
  return { ...state, mode: next };
}

function openActions(state: MenuState): Step {
  const thread = visibleThreads(state)[state.cursor];
  if (!thread) return { state };
  return {
    state: {
      ...state,
      screen: "actions",
      selected: thread,
      actionCursor: firstEnabled(buildActions(thread, state.caps)),
    },
  };
}

function runAction(state: MenuState): Step {
  const thread = state.selected;
  if (!thread) return { state: { ...state, screen: "sessions" } };
  const actions = buildActions(thread, state.caps);
  const action = actions[state.actionCursor];
  if (!action) return { state };
  if (action.disabled)
    return { state: { ...state, message: `cannot ${action.label}: ${action.disabled}` } };

  if (action.kind === "show") return { state, effect: { type: "show", thread } };
  if (action.kind === "rename") return { state, effect: { type: "rename", thread } };
  if (action.kind === "resume") return { state, effect: { type: "resume", thread } };
  return {
    state,
    effect: {
      type: "port",
      thread,
      target: action.harness!,
      targetInstanceId: action.instanceId ?? DEFAULT_INSTANCE_ID,
      mode: state.mode,
    },
  };
}

export function reduce(state: MenuState, key: Key): Step {
  const s: MenuState = state.message ? { ...state, message: undefined } : state;

  if (key.type === "ctrl-c") return { state: s, effect: { type: "quit" } };

  // ------------------------------------------------------- actions screen
  if (s.screen === "actions") {
    const actions = buildActions(s.selected!, s.caps);
    switch (key.type) {
      case "esc":
      case "left":
        return { state: { ...s, screen: "sessions", selected: undefined } };
      case "up":
        return { state: { ...s, actionCursor: Math.max(0, s.actionCursor - 1) } };
      case "down":
        return { state: { ...s, actionCursor: Math.min(actions.length - 1, s.actionCursor + 1) } };
      case "home":
        return { state: { ...s, actionCursor: 0 } };
      case "end":
        return { state: { ...s, actionCursor: actions.length - 1 } };
      case "tab":
        return { state: cycleMode(s, 1) };
      case "shift-tab":
        return { state: cycleMode(s, -1) };
      case "enter":
      case "right":
        return runAction(s);
      case "ctrl-d":
        return { state: s, effect: { type: "quit" } };
      case "char": {
        const c = key.value ?? "";
        if (c === "q") return { state: s, effect: { type: "quit" } };
        if (c === "m") return { state: cycleMode(s, 1) };
        // Number keys jump straight to an action.
        if (/^[1-9]$/.test(c)) {
          const idx = Number(c) - 1;
          if (idx < actions.length) return runAction({ ...s, actionCursor: idx });
        }
        return { state: s };
      }
      default:
        return { state: s };
    }
  }

  // ------------------------------------------------------ sessions screen
  switch (key.type) {
    case "up":
      return { state: move(s, -1) };
    case "down":
      return { state: move(s, 1) };
    case "pgup":
      return { state: move(s, -s.pageSize) };
    case "pgdn":
      return { state: move(s, s.pageSize) };
    case "home":
      return { state: clampCursor({ ...s, cursor: 0 }, visibleThreads(s).length) };
    case "end":
      return {
        state: clampCursor({ ...s, cursor: visibleThreads(s).length - 1 }, visibleThreads(s).length),
      };
    case "enter":
    case "right":
      return openActions(s);
    case "tab":
      return { state: cycleHarness(s, 1) };
    case "shift-tab":
      return { state: cycleHarness(s, -1) };
    case "backspace":
      return s.filter ? { state: refiltered({ ...s, filter: s.filter.slice(0, -1) }) } : { state: s };
    case "ctrl-u":
      return { state: refiltered({ ...s, filter: "" }) };
    case "ctrl-w":
      return { state: refiltered({ ...s, filter: s.filter.replace(/\s*\S+\s*$/, "") }) };
    case "ctrl-d":
      return { state: s, effect: { type: "quit" } };
    case "esc":
      // Esc clears the filter first; only an already-empty box quits.
      return s.filter
        ? { state: refiltered({ ...s, filter: "" }) }
        : { state: s, effect: { type: "quit" } };
    case "char":
      // Bare keys go to the filter box. Commands live on ctrl- chords
      // (COMMAND_KEYS) so they can never be swallowed mid-search.
      return { state: refiltered({ ...s, filter: s.filter + key.value! }) };
    default:
      return { state: s };
  }
}

/**
 * Commands that must never be swallowed by the filter box, so they live on
 * control chords. The runtime maps the raw byte before decoding — see menu.ts.
 */
export const COMMAND_KEYS: Record<string, "rescan" | "scope" | "ghosts" | "subagents" | "search"> = {
  "\x12": "rescan", // ctrl-r
  "\x0f": "scope", // ctrl-o
  "\x07": "ghosts", // ctrl-g
  "\x13": "subagents", // ctrl-s
  "\x06": "search", // ctrl-f
};

export function applyCommand(state: MenuState, cmd: string): Step {
  switch (cmd) {
    case "rescan":
      return { state, effect: { type: "rescan" } };
    case "scope":
      return { state: refiltered({ ...state, scope: state.scope === "cwd" ? "all" : "cwd" }) };
    case "ghosts":
      return { state: refiltered({ ...state, showGhosts: !state.showGhosts }) };
    case "subagents":
      return { state: refiltered({ ...state, showSubagents: !state.showSubagents }) };
    case "search":
      return { state: refiltered({ ...state, filter: "", message: "search: type an alias, tag, note, title, prompt, id, path, branch, or model" }) };
    default:
      return { state };
  }
}

/** Re-clamp after the renderer learns the real terminal height. */
export function setPageSize(state: MenuState, pageSize: number): MenuState {
  if (pageSize === state.pageSize) return state;
  return clampCursor({ ...state, pageSize }, visibleThreads(state).length);
}
