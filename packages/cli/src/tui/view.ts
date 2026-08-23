/**
 * Frame rendering for the interactive menu. Pure: state in, lines out.
 *
 * Every line is padded to the terminal width so a full-frame redraw never
 * leaves fragments of the previous frame behind.
 */

import { displayId, humanAge, shortenPath, stripAnsi, truncate, visibleWidth, type Palette } from "../format";
import { MODE_HINT, TRANSFER_MODES, estimateTokens, type TransferMode } from "../transfer";
import { buildActions, presentHarnesses, visibleThreads, type MenuState } from "./state";
import { chainLabel, type Thread } from "./threads";

export interface ViewOpts {
  width: number;
  height: number;
  pal: Palette;
  now: number;
}

/** Lines of chrome around the session list: title, filter, header, status, keys. */
export const SESSIONS_CHROME = 5;

export function pageSizeFor(height: number): number {
  return Math.max(3, height - SESSIONS_CHROME);
}

function pad(s: string, w: number): string {
  const vis = visibleWidth(s);
  return vis >= w ? s : s + " ".repeat(w - vis);
}

/**
 * Cut a line to `w` VISIBLE columns, keeping escape sequences (they cost no
 * width) and, crucially, keeping literal spaces — a column layout cannot go
 * through `truncate()`, which collapses runs of whitespace.
 */
function clampVisible(s: string, w: number): string {
  if (visibleWidth(s) <= w) return s;
  let out = "";
  let seen = 0;
  let sawAnsi = false;
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        sawAnsi = true;
        i += m[0].length;
        continue;
      }
    }
    if (seen >= w) break;
    out += s[i];
    seen++;
    i++;
  }
  return sawAnsi ? out + "\x1b[0m" : out;
}

/** Pad or cut a whole rendered line to exactly `w` columns. */
function exact(s: string, w: number): string {
  return pad(clampVisible(s, w), w);
}

/** Cell content: collapsing whitespace is wanted here (titles, prompts). */
function fit(s: string, w: number): string {
  return pad(visibleWidth(s) > w ? truncate(stripAnsi(s), w) : s, w);
}

/**
 * Draw one selectable line. Selection is a `▸` marker plus, when colour is
 * available, reverse video over the whole row (inner colour stripped so the
 * contrast stays predictable). With NO_COLOR the marker carries it alone —
 * emitting escapes anyway would corrupt piped output.
 */
function row(body: string, isSelected: boolean, width: number, pal: Palette): string {
  const line = (isSelected ? "▸" : " ") + body;
  return isSelected && pal.enabled
    ? `\x1b[7m${exact(stripAnsi(line), width)}\x1b[27m`
    : exact(line, width);
}

// ------------------------------------------------------------- sessions view

interface Cols {
  id: number;
  harness: number;
  age: number;
  cwd: number;
  msg: number;
  title: number;
}

function columns(width: number): Cols {
  const id = 13;
  const harness = 10;
  const age = 5;
  const msg = 5;
  // The cwd column is the first thing to give up space on a narrow terminal.
  const cwd = width < 100 ? (width < 80 ? 0 : 18) : 26;
  const gaps = 2 * (cwd ? 5 : 4);
  // `- 1` is the cursor marker column every row carries.
  const title = Math.max(10, width - 1 - id - harness - age - cwd - msg - gaps);
  return { id, harness, age, cwd, msg, title };
}

function harnessCell(t: Thread, pal: Palette): string {
  // `claude·3` — the tip harness plus how many harnesses it has been through.
  return t.ported ? `${t.tip.harness}${pal.dim(`·${t.hops.length}`)}` : t.tip.harness;
}

function threadLine(t: Thread, c: Cols, pal: Palette, now: number): string {
  const tip = t.tip;
  const nativeLabel = tip.title || tip.firstPrompt || "";
  const label = tip.alias
    ? `◆ ${tip.alias}${nativeLabel && nativeLabel !== tip.alias ? ` · ${nativeLabel}` : ""}`
    : nativeLabel || pal.dim("(untitled)");
  const tags = tip.tags?.map((tag) => `#${tag}`).join(" ") ?? "";
  const cells = [
    fit(tip.ghost ? pal.dim(displayId(tip.nativeId)) : pal.bold(displayId(tip.nativeId)), c.id),
    fit(pal.cyan(harnessCell(t, pal)), c.harness),
    pad("", 0) + fitRight(pal.dim(humanAge(tip.updatedAt ?? tip.createdAt, now)), c.age),
  ];
  if (c.cwd) cells.push(fit(pal.dim(shortenPath(tip.cwd, c.cwd)), c.cwd));
  cells.push(fitRight(tip.messageCount === undefined ? "-" : String(tip.messageCount), c.msg));
  cells.push(
    fit(
      (tip.isSubagent ? pal.blue("↳") : "") + (tip.ghost ? pal.dim("†") : "") + truncate(`${label}${tags ? `  ${tags}` : ""}${tip.note ? "  ✎" : ""}`, c.title),
      c.title,
    ),
  );
  return cells.join("  ");
}

function fitRight(s: string, w: number): string {
  const vis = visibleWidth(s);
  if (vis > w) return truncate(stripAnsi(s), w);
  return " ".repeat(w - vis) + s;
}

function titleBar(state: MenuState, o: ViewOpts, shown: number): string {
  const p = o.pal;
  const total = state.threads.length;
  const scope = state.scope === "cwd" ? shortenPath(state.cwd, 30) : "all directories";
  const harness = state.harnessFilter ?? "all harnesses";
  const flags =
    (state.showGhosts ? " +ghosts" : "") + (state.showSubagents ? " +agents" : "");
  return (
    p.bold(p.magenta(" sinter ")) +
    p.dim("· ") +
    `${shown}${shown === total ? "" : `/${total}`} ` +
    p.dim("sessions · ") +
    p.cyan(String(harness)) +
    p.dim(" · ") +
    scope +
    p.dim(flags)
  );
}

function filterBar(state: MenuState, o: ViewOpts): string {
  const p = o.pal;
  const cursor = "\x1b[7m \x1b[27m";
  return state.filter
    ? ` ${p.bold("search")} ${state.filter}${o.pal.enabled ? cursor : "_"}`
    : ` ${p.bold("search")} ${p.dim("type now, or ^f · alias, tag, note, title, prompt, id, path, branch, model…")}`;
}

function keyHints(state: MenuState, o: ViewOpts): string {
  const p = o.pal;
  const k = (key: string, what: string) => `${p.bold(key)}${p.dim(` ${what}`)}`;
  if (state.screen === "actions")
    return (
      " " +
      [k("↑↓", "action"), k("⏎", "go"), k("tab", "mode"), k("esc", "back"), k("q", "quit")].join(
        p.dim("  ·  "),
      )
    );
  return (
    " " +
    [
      k("↑↓", "move"),
      k("⏎", "open"),
      k("type", "search"),
      k("tab", "harness"),
      k("^s", "agents"),
      k("^o", "scope"),
      k("^r", "rescan"),
      k("esc", "quit"),
    ].join(p.dim("  ·  "))
  );
}

function statusLine(state: MenuState, o: ViewOpts, shown: number): string {
  const p = o.pal;
  if (state.message) return " " + p.yellow(state.message);
  if (!shown) {
    const why = state.filter
      ? "no session matches the search"
      : state.scope === "cwd"
        ? `no sessions in ${shortenPath(state.cwd, 40)} — ^o widens to all directories`
        : "ledger is empty — ^r scans every harness";
    return " " + p.dim(why);
  }
  if (!state.showSubagents) {
    const withAgents = visibleThreads({ ...state, showSubagents: true }).length;
    const hidden = Math.max(0, withAgents - shown);
    if (hidden) return " " + p.dim(`${hidden} agent session${hidden === 1 ? "" : "s"} hidden · ^s show`);
  }
  return "";
}

export function renderSessions(state: MenuState, o: ViewOpts): string[] {
  const p = o.pal;
  const c = columns(o.width);
  const rows = visibleThreads(state);
  const page = pageSizeFor(o.height);
  const lines: string[] = [];

  lines.push(titleBar(state, o, rows.length));
  lines.push(filterBar(state, o));

  const header = [
    pad(p.dim("ID"), c.id),
    pad(p.dim("HARNESS"), c.harness),
    fitRight(p.dim("AGE"), c.age),
    ...(c.cwd ? [pad(p.dim("CWD"), c.cwd)] : []),
    fitRight(p.dim("MSG"), c.msg),
    pad(p.dim("TITLE"), c.title),
  ].join("  ");
  lines.push(" " + header);

  for (let i = 0; i < page; i++) {
    const idx = state.scroll + i;
    const t = rows[idx];
    if (!t) {
      lines.push("");
      continue;
    }
    lines.push(row(threadLine(t, c, p, o.now), idx === state.cursor, o.width, p));
  }

  lines.push(statusLine(state, o, rows.length));
  lines.push(keyHints(state, o));
  return lines.map((l) => exact(l, o.width));
}

// -------------------------------------------------------------- actions view

function metaLines(t: Thread, o: ViewOpts): string[] {
  const p = o.pal;
  const tip = t.tip;
  const out: string[] = [];
  out.push(
    " " +
      p.bold(truncate(tip.alias || tip.title || tip.firstPrompt || "(untitled)", Math.max(20, o.width - 2))),
  );
  if (tip.alias && tip.title && tip.title !== tip.alias)
    out.push(" " + p.dim(`native title  ${truncate(tip.title, Math.max(20, o.width - 16))}`));
  const bits = [
    p.cyan(tip.harness) + p.dim(":") + displayId(tip.nativeId),
    `${tip.messageCount ?? "?"} msgs`,
    humanAge(tip.updatedAt ?? tip.createdAt, o.now) + " ago",
    shortenPath(tip.cwd, 34),
  ];
  if (tip.gitBranch) bits.push(p.dim(`[${tip.gitBranch}]`));
  if (tip.model) bits.push(p.dim(tip.model));
  out.push(" " + p.dim(bits.join("  ·  ")));
  if (t.ported)
    out.push(
      " " + p.dim("chain  ") + p.blue(chainLabel(t)) + p.dim(`  (${t.hops.length} hops)`),
    );
  return out;
}

function modeBar(state: MenuState, o: ViewOpts): string {
  const p = o.pal;
  const cells = TRANSFER_MODES.map((m: TransferMode) =>
    m === state.mode
      ? p.enabled
        ? `\x1b[7m ${m} \x1b[27m`
        : `[${m}]`
      : p.dim(p.enabled ? ` ${m} ` : ` ${m} `),
  );
  return ` ${p.dim("transfer")} ${cells.join(p.dim("│"))}   ${p.dim(MODE_HINT[state.mode])}`;
}

export function renderActions(state: MenuState, o: ViewOpts): string[] {
  const p = o.pal;
  const t = state.selected!;
  const actions = buildActions(t, state.caps);
  const lines: string[] = [];

  lines.push(p.bold(p.magenta(" sinter ")) + p.dim("· port or resume"));
  lines.push("");
  lines.push(...metaLines(t, o));
  lines.push("");

  const labelWidth = Math.max(...actions.map((a) => a.label.length)) + 2;
  actions.forEach((a, i) => {
    const num = p.dim(`${i + 1}.`);
    const label = a.disabled ? p.dim(a.label) : a.kind === "resume" ? p.green(a.label) : p.bold(a.label);
    const note = a.disabled ? p.dim(`✗ ${a.disabled}`) : p.dim(a.hint);
    lines.push(row(`${num} ${pad(label, labelWidth)} ${note}`, i === state.actionCursor, o.width, p));
  });

  lines.push("");
  lines.push(modeBar(state, o));
  if (state.message) {
    lines.push("");
    lines.push(" " + p.yellow(state.message));
  }
  const selected = actions[state.actionCursor];
  if (selected) {
    const cmd = selected.disabled ? p.dim(selected.command) : p.cyan(selected.command);
    lines.push("");
    lines.push(" " + p.dim("command:") + " " + cmd);
  }
  lines.push("");
  lines.push(keyHints(state, o));
  return lines.map((l) => exact(l, o.width));
}

export function renderFrame(state: MenuState, o: ViewOpts): string[] {
  return state.screen === "actions" && state.selected
    ? renderActions(state, o)
    : renderSessions(state, o);
}

/** Size warning shown before a port; sized off the SIF, not the message count. */
export function sizeNote(bytes: number, pal: Palette): string {
  const tok = estimateTokens(bytes);
  if (tok < 120_000) return "";
  return pal.yellow(
    `~${Math.round(tok / 1000)}k tokens — consider the \`compact\` transfer mode (tab)`,
  );
}
