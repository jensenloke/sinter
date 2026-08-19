import { describe, expect, test } from "bun:test";
import type { HarnessId, SifSession } from "@sinter/core";
import { SIF_VERSION, validateSession } from "@sinter/core";
import type { LedgerRow } from "@sinter/ledger";
import { palette, visibleWidth } from "../src/format";
import { applyTransfer, callTarget, compactSession } from "../src/transfer";
import { parseKeys } from "../src/tui/keys";
import {
  buildActions,
  initialState,
  reduce,
  visibleThreads,
  type HarnessCaps,
  type MenuState,
} from "../src/tui/state";
import { buildThreads, chainLabel } from "../src/tui/threads";
import { dispatchChunk } from "../src/tui/menu";
import { renderFrame, pageSizeFor } from "../src/tui/view";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const CWD = "/Users/test/proj";

// ------------------------------------------------------------------ fixtures

function row(over: Partial<LedgerRow> & { nativeId: string; harness: HarnessId }): LedgerRow {
  return {
    cwd: CWD,
    title: "some work",
    updatedAt: "2026-08-15T10:00:00.000Z",
    messageCount: 12,
    isSubagent: false,
    ghost: false,
    ...over,
  };
}

function caps(over: Partial<Record<HarnessId, Partial<HarnessCaps>>> = {}): HarnessCaps[] {
  const base: Record<HarnessId, HarnessCaps> = {
    claude: { id: "claude", available: true, canWrite: false, onPath: true },
    codex: { id: "codex", available: true, canWrite: false, onPath: true },
    devin: { id: "devin", available: true, canWrite: true, onPath: true },
    opencode: { id: "opencode", available: true, canWrite: true, onPath: true },
    zcode: { id: "zcode", available: true, canWrite: false, onPath: false, experimental: true },
    omp: { id: "omp", available: true, canWrite: true, onPath: true },
    pi: { id: "pi", available: true, canWrite: true, onPath: true },
  };
  for (const [k, v] of Object.entries(over)) Object.assign(base[k as HarnessId], v);
  return Object.values(base);
}

function state(rows: LedgerRow[], over: Partial<MenuState> = {}): MenuState {
  return {
    ...initialState({ threads: buildThreads(rows), caps: caps(), cwd: CWD }),
    pageSize: 10,
    ...over,
  };
}

const ROWS = [
  row({ nativeId: "aaa11111-1111", harness: "claude", title: "port sessions between harnesses" }),
  row({
    nativeId: "0199abcd",
    harness: "codex",
    title: "auth refactor",
    updatedAt: "2026-08-15T09:00:00.000Z",
  }),
  row({
    nativeId: "ses_zzz",
    harness: "opencode",
    title: "elsewhere",
    cwd: "/Users/test/other",
    updatedAt: "2026-08-14T09:00:00.000Z",
  }),
  row({ nativeId: "ghost-1", harness: "claude", title: "gone", ghost: true }),
  row({ nativeId: "sub-1", harness: "claude", title: "a subagent", isSubagent: true }),
];

// ---------------------------------------------------------------------- keys

describe("parseKeys", () => {
  test("decodes arrows in both CSI and SS3 form", () => {
    expect(parseKeys("\x1b[A\x1b[B\x1bOC\x1bOD").map((k) => k.type)).toEqual([
      "up",
      "down",
      "right",
      "left",
    ]);
  });

  test("decodes navigation and editing keys", () => {
    expect(parseKeys("\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[3~\x1b[Z").map((k) => k.type)).toEqual([
      "pgup",
      "pgdn",
      "home",
      "end",
      "delete",
      "shift-tab",
    ]);
    expect(parseKeys("\r\n\t\x7f\x03\x04\x15\x17").map((k) => k.type)).toEqual([
      "enter",
      "enter",
      "tab",
      "backspace",
      "ctrl-c",
      "ctrl-d",
      "ctrl-u",
      "ctrl-w",
    ]);
  });

  test("splits a chunk carrying several keypresses", () => {
    expect(parseKeys("ab\x1b[Bc")).toEqual([
      { type: "char", value: "a" },
      { type: "char", value: "b" },
      { type: "down" },
      { type: "char", value: "c" },
    ]);
  });

  test("drops unrecognised escape sequences instead of leaking their bytes", () => {
    // A mouse report must not end up in the filter box.
    expect(parseKeys("\x1b[<0;12;5M")).toEqual([]);
    expect(parseKeys("\x1b")).toEqual([{ type: "esc" }]);
  });

  test("keeps non-ascii printables", () => {
    expect(parseKeys("é")).toEqual([{ type: "char", value: "é" }]);
  });
});

// -------------------------------------------------------------------- threads

describe("threads", () => {
  test("rows with no lineage become single-hop threads, newest tip first", () => {
    const threads = buildThreads(ROWS);
    expect(threads.length).toBe(ROWS.length);
    expect(threads.every((t) => t.hops.length === 1 && !t.ported)).toBe(true);
    expect(threads[0]!.tip.nativeId).toBe("aaa11111-1111");
  });

  test("linked rows collapse into one thread with an ordered chain", () => {
    const rows = [
      row({ nativeId: "0199abcd", harness: "codex", updatedAt: "2026-08-15T08:00:00.000Z" }),
      row({ nativeId: "omp-x", harness: "omp", updatedAt: "2026-08-15T09:00:00.000Z" }),
      row({ nativeId: "0199ffff", harness: "codex", updatedAt: "2026-08-15T10:00:00.000Z" }),
    ];
    const links = rows.map((r) => ({ threadId: "T1", harness: r.harness, nativeId: r.nativeId }));
    const [thread] = buildThreads(rows, links);
    expect(thread!.hops.length).toBe(3);
    expect(thread!.ported).toBe(true);
    expect(chainLabel(thread!)).toBe("codex → omp → codex");
    expect(thread!.tip.nativeId).toBe("0199ffff");
  });
});

// -------------------------------------------------------------------- filters

describe("filtering", () => {
  test("defaults to the current directory when it holds sessions", () => {
    const s = state(ROWS);
    expect(s.scope).toBe("cwd");
    expect(visibleThreads(s).map((t) => t.tip.nativeId)).toEqual(["aaa11111-1111", "0199abcd"]);
  });

  test("falls back to all directories when the cwd is empty", () => {
    const s = initialState({
      threads: buildThreads([ROWS[2]!]),
      caps: caps(),
      cwd: "/nowhere",
    });
    expect(s.scope).toBe("all");
  });

  test("ghosts and subagents are hidden until toggled", () => {
    const s = state(ROWS, { scope: "all" });
    const ids = visibleThreads(s).map((t) => t.tip.nativeId);
    expect(ids).not.toContain("ghost-1");
    expect(ids).not.toContain("sub-1");
    expect(visibleThreads({ ...s, showGhosts: true }).map((t) => t.tip.nativeId)).toContain("ghost-1");
  });

  test("typing filters across every field, all terms must match", () => {
    const s = state(ROWS, { scope: "all" });
    expect(visibleThreads({ ...s, filter: "auth" }).length).toBe(1);
    expect(visibleThreads({ ...s, filter: "auth refactor" }).length).toBe(1);
    expect(visibleThreads({ ...s, filter: "auth nonsense" }).length).toBe(0);
    expect(visibleThreads({ ...s, filter: "other" }).length).toBe(1); // matches cwd
    expect(visibleThreads({ ...s, filter: "0199" }).length).toBe(1); // matches id
  });

  test("a harness filter matches any hop, not just the tip", () => {
    const rows = [
      row({ nativeId: "0199abcd", harness: "codex", updatedAt: "2026-08-15T08:00:00.000Z" }),
      row({ nativeId: "omp-x", harness: "omp", updatedAt: "2026-08-15T09:00:00.000Z" }),
    ];
    const links = rows.map((r) => ({ threadId: "T1", harness: r.harness, nativeId: r.nativeId }));
    const s = {
      ...initialState({ threads: buildThreads(rows, links), caps: caps(), cwd: CWD }),
      harnessFilter: "codex" as HarnessId,
    };
    expect(visibleThreads(s).length).toBe(1);
  });
});

// -------------------------------------------------------------------- reducer

const key = (type: string, value?: string) => ({ type, value }) as never;

describe("reduce", () => {
  test("typing goes to the filter box and resets the cursor", () => {
    let s = state(ROWS, { scope: "all", cursor: 3 });
    s = reduce(s, key("char", "a")).state;
    expect(s.filter).toBe("a");
    expect(s.cursor).toBe(0);
    s = reduce(s, key("backspace")).state;
    expect(s.filter).toBe("");
  });

  test("esc clears a filter before it quits", () => {
    const filtered = state(ROWS, { filter: "auth" });
    const cleared = reduce(filtered, key("esc"));
    expect(cleared.effect).toBeUndefined();
    expect(cleared.state.filter).toBe("");
    expect(reduce(cleared.state, key("esc")).effect).toEqual({ type: "quit" });
  });

  test("the cursor stays inside the visible list", () => {
    let s = state(ROWS, { scope: "all" });
    for (let i = 0; i < 20; i++) s = reduce(s, key("down")).state;
    expect(s.cursor).toBe(visibleThreads(s).length - 1);
    for (let i = 0; i < 20; i++) s = reduce(s, key("up")).state;
    expect(s.cursor).toBe(0);
  });

  test("scroll follows the cursor past the page edge", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      row({ nativeId: `id-${i}`, harness: "claude", updatedAt: `2026-08-15T${String(i % 24).padStart(2, "0")}:00:00.000Z` }),
    );
    let s = state(many, { pageSize: 5 });
    for (let i = 0; i < 10; i++) s = reduce(s, key("down")).state;
    expect(s.cursor).toBe(10);
    expect(s.scroll).toBe(6);
    expect(s.cursor).toBeLessThan(s.scroll + s.pageSize);
  });

  test("enter opens the action screen on the first ENABLED action", () => {
    // claude off PATH disables `resume`, so the cursor must skip past it.
    const s = { ...state(ROWS), caps: caps({ claude: { onPath: false } }) };
    const opened = reduce(s, key("enter")).state;
    expect(opened.screen).toBe("actions");
    const actions = buildActions(opened.selected!, opened.caps);
    expect(opened.actionCursor).toBeGreaterThan(0);
    expect(actions[opened.actionCursor]!.disabled).toBeUndefined();
  });

  test("a thread with nothing available parks on action 0 and explains itself", () => {
    const s = state([row({ nativeId: "g", harness: "claude", ghost: true })], {
      scope: "all",
      showGhosts: true,
    });
    const opened = reduce(s, key("enter")).state;
    expect(opened.actionCursor).toBe(0);
    const step = reduce(opened, key("enter"));
    expect(step.effect).toBeUndefined();
    expect(step.state.message).toContain("ghost row");
  });

  test("enter on a disabled action reports why instead of firing", () => {
    const s = state(ROWS);
    const opened = reduce(s, key("enter")).state;
    const actions = buildActions(opened.selected!, opened.caps);
    const codexIdx = actions.findIndex((a) => a.label.includes("codex"));
    const step = reduce({ ...opened, actionCursor: codexIdx }, key("enter"));
    expect(step.effect).toBeUndefined();
    expect(step.state.message).toContain("no writer yet");
  });

  test("enter on an enabled port action emits the effect with the current mode", () => {
    const s = state(ROWS, { mode: "compact" });
    const opened = reduce(s, key("enter")).state;
    const actions = buildActions(opened.selected!, opened.caps);
    const ompIdx = actions.findIndex((a) => a.label === "port → omp");
    const step = reduce({ ...opened, actionCursor: ompIdx }, key("enter"));
    expect(step.effect).toEqual({
      type: "port",
      thread: opened.selected!,
      target: "omp",
      mode: "compact",
    });
  });

  test("tab cycles the transfer mode on the action screen", () => {
    const opened = reduce(state(ROWS), key("enter")).state;
    expect(opened.mode).toBe("full");
    expect(reduce(opened, key("tab")).state.mode).toBe("slim");
    expect(reduce(reduce(opened, key("tab")).state, key("tab")).state.mode).toBe("compact");
    expect(reduce(opened, key("shift-tab")).state.mode).toBe("compact");
  });

  test("esc returns from the action screen to the list", () => {
    const opened = reduce(state(ROWS), key("enter")).state;
    expect(reduce(opened, key("esc")).state.screen).toBe("sessions");
  });

  test("resume emits without writing anything", () => {
    const opened = reduce(state(ROWS), key("enter")).state;
    const step = reduce({ ...opened, actionCursor: 0 }, key("enter"));
    expect(step.effect!.type).toBe("resume");
  });

  test("ctrl-c always quits", () => {
    expect(reduce(state(ROWS), key("ctrl-c")).effect).toEqual({ type: "quit" });
    const opened = reduce(state(ROWS), key("enter")).state;
    expect(reduce(opened, key("ctrl-c")).effect).toEqual({ type: "quit" });
  });
});

describe("actions", () => {
  test("unavailable targets stay listed with the reason", () => {
    const [thread] = buildThreads([ROWS[0]!]);
    const actions = buildActions(thread!, caps({ pi: { available: false, error: "not installed" } }));
    const labels = actions.map((a) => a.label);
    expect(labels).toContain("port → codex");
    expect(actions.find((a) => a.label === "port → codex")!.disabled).toBe("no writer yet");
    expect(actions.find((a) => a.label === "port → pi")!.disabled).toBe("not installed");
    expect(actions.find((a) => a.label === "port → zcode")!.disabled).toBe("no writer yet");
  });

  test("a harness missing from PATH cannot be resumed into", () => {
    const [thread] = buildThreads([ROWS[0]!]);
    const actions = buildActions(thread!, caps({ claude: { onPath: false } }));
    expect(actions[0]!.disabled).toContain("not on PATH");
  });

  test("re-porting to a harness already in the chain is labelled as a return", () => {
    const rows = [
      row({ nativeId: "0199abcd", harness: "codex", updatedAt: "2026-08-15T08:00:00.000Z" }),
      row({ nativeId: "omp-x", harness: "omp", updatedAt: "2026-08-15T09:00:00.000Z" }),
    ];
    const links = rows.map((r) => ({ threadId: "T1", harness: r.harness, nativeId: r.nativeId }));
    const [thread] = buildThreads(rows, links);
    const labels = buildActions(thread!, caps()).map((a) => a.label);
    expect(labels).toContain("port → back to codex");
  });
});

// ------------------------------------------------------------ command chords

describe("dispatchChunk", () => {
  test("control chords never reach the filter box", () => {
    const s = state(ROWS);
    const after = dispatchChunk("\x0f", s).state; // ctrl-o
    expect(after.filter).toBe("");
    expect(after.scope).toBe("all");
    expect(dispatchChunk("\x07", s).state.showGhosts).toBe(true); // ctrl-g
    expect(dispatchChunk("\x13", s).state.showSubagents).toBe(true); // ctrl-s
    expect(dispatchChunk("\x12", s).effect).toEqual({ type: "rescan" }); // ctrl-r
  });

  test("text around a chord is still processed in order", () => {
    const step = dispatchChunk("au\x0fth", state(ROWS));
    expect(step.state.filter).toBe("auth");
    expect(step.state.scope).toBe("all");
  });

  test("stops at the first effect in a chunk", () => {
    const step = dispatchChunk("\x03zzz", state(ROWS));
    expect(step.effect).toEqual({ type: "quit" });
  });
});

// ---------------------------------------------------------------------- view

describe("view", () => {
  const opts = { width: 100, height: 24, pal: palette(false), now: NOW };

  test("every line is exactly the terminal width, in both colour modes", () => {
    const plain = renderFrame(state(ROWS, { scope: "all" }), opts);
    expect(plain.every((l) => l.length === 100)).toBe(true);
    expect(plain.length).toBeLessThanOrEqual(24);

    const coloured = renderFrame(state(ROWS, { scope: "all" }), { ...opts, pal: palette(true) });
    expect(coloured.every((l) => visibleWidth(l) === 100)).toBe(true);
  });

  test("no escape codes leak out when colour is disabled", () => {
    const lines = renderFrame(state(ROWS, { scope: "all" }), opts);
    expect(lines.join("\n")).not.toContain("\x1b");
    const opened = reduce(state(ROWS), key("enter")).state;
    expect(renderFrame(opened, opts).join("\n")).not.toContain("\x1b");
  });

  test("the cursor row is marked without relying on colour", () => {
    const lines = renderFrame(state(ROWS, { scope: "all", cursor: 1 }), opts);
    const marked = lines.filter((l) => l.startsWith("▸"));
    expect(marked.length).toBe(1);
    expect(marked[0]).toContain("auth refactor");
  });

  test("a narrow terminal drops the cwd column instead of overflowing", () => {
    const lines = renderFrame(state(ROWS, { scope: "all" }), { ...opts, width: 70 });
    expect(lines.every((l) => l.length === 70)).toBe(true);
    expect(lines.join("\n")).not.toContain("CWD");
  });

  test("the list shows ids, harnesses and titles", () => {
    const text = renderFrame(state(ROWS, { scope: "all" }), opts).join("\n");
    expect(text).toContain("aaa11111");
    expect(text).toContain("codex");
    expect(text).toContain("auth refactor");
  });

  test("an empty result set explains itself", () => {
    const text = renderFrame(state(ROWS, { filter: "zzzznope" }), opts).join("\n");
    expect(text).toContain("no session matches the filter");
  });

  test("the action screen shows the transfer mode and disabled reasons", () => {
    const opened = reduce(state(ROWS), key("enter")).state;
    const text = renderFrame(opened, opts).join("\n");
    expect(text).toContain("resume in claude");
    expect(text).toContain("no writer yet");
    expect(text).toContain("transfer");
  });

  test("the chain line only appears once a thread has hopped", () => {
    const rows = [
      row({ nativeId: "0199abcd", harness: "codex", updatedAt: "2026-08-15T08:00:00.000Z" }),
      row({ nativeId: "omp-x", harness: "omp", updatedAt: "2026-08-15T09:00:00.000Z" }),
    ];
    const links = rows.map((r) => ({ threadId: "T1", harness: r.harness, nativeId: r.nativeId }));
    const s = {
      ...initialState({ threads: buildThreads(rows, links), caps: caps(), cwd: CWD }),
      screen: "actions" as const,
      selected: buildThreads(rows, links)[0],
    };
    expect(renderFrame(s, opts).join("\n")).toContain("codex → omp");
    expect(renderFrame(reduce(state(ROWS), key("enter")).state, opts).join("\n")).not.toContain("chain");
  });

  test("page size leaves room for the chrome", () => {
    expect(pageSizeFor(24)).toBe(19);
    expect(pageSizeFor(6)).toBe(3);
  });
});

// ------------------------------------------------------------------ transfer

function bigSession(): SifSession {
  const entries: SifSession["entries"] = [
    { kind: "user", id: "u1", parentId: null, content: [{ type: "text", text: "fix the auth bug" }] },
  ];
  // Three reads of the same file: only the last one is worth carrying.
  for (let i = 0; i < 3; i++) {
    entries.push({
      kind: "assistant",
      id: `a${i}`,
      parentId: i === 0 ? "u1" : `t${i - 1}`,
      content: [
        { type: "thinking", thinking: "x".repeat(4000) },
        { type: "text", text: "reading the file" },
        { type: "toolCall", callId: `c${i}`, name: "Read", args: { file_path: "/src/auth.ts", offset: i } },
      ],
      raw: { huge: "y".repeat(5000) },
    });
    entries.push({
      kind: "toolResult",
      id: `t${i}`,
      parentId: `a${i}`,
      callId: `c${i}`,
      toolName: "Read",
      content: [{ type: "text", text: `contents v${i} ` + "z".repeat(5000) }],
    });
  }
  entries.push({
    kind: "toolResult",
    id: "terr",
    parentId: "t2",
    callId: "cerr",
    toolName: "Bash",
    content: [{ type: "text", text: "boom" }],
    isError: true,
  });
  return {
    sif: SIF_VERSION,
    id: "sif-1",
    origin: { harness: "claude", nativeId: "aaa11111" },
    cwd: CWD,
    entries,
  } as SifSession;
}

describe("transfer modes", () => {
  test("callTarget picks the identifying argument, not the whole blob", () => {
    expect(callTarget({ type: "toolCall", callId: "c", name: "Read", args: { file_path: "/a/b.ts", offset: 3 } })).toBe(
      "/a/b.ts",
    );
    expect(callTarget({ type: "toolCall", callId: "c", name: "Bash", args: { command: "ls -la" } })).toBe("ls -la");
    expect(callTarget({ type: "toolCall", callId: "c", name: "X", args: { weird: 1 } })).toBe('{"weird":1}');
  });

  test("full is a passthrough", () => {
    const s = bigSession();
    const { session, stats } = applyTransfer(s, "full");
    expect(session).toBe(s);
    expect(stats.bytesAfter).toBe(stats.bytesBefore);
  });

  test("slim drops raw source records only", () => {
    const { session, stats } = applyTransfer(bigSession(), "slim");
    expect(session.entries.every((e) => e.raw === undefined)).toBe(true);
    expect(session.entries.length).toBe(bigSession().entries.length);
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
  });

  test("compact keeps the last read of a file and drops the superseded ones", () => {
    const { session, stats } = compactSession(bigSession());
    const results = session.entries.filter((e) => e.kind === "toolResult");
    const texts = results.map((e) => (e as { content: { text?: string }[] }).content[0]!.text!);
    expect(texts.filter((t) => t.includes("contents v2")).length).toBe(1);
    expect(texts.filter((t) => t.includes("output superseded")).length).toBe(2);
    expect(stats.resultsCollapsed).toBe(2);
  });

  test("compact always keeps errors", () => {
    const { session } = compactSession(bigSession());
    const err = session.entries.find((e) => e.kind === "toolResult" && e.isError)!;
    expect((err as { content: { text?: string }[] }).content[0]!.text).toContain("boom");
  });

  test("compact drops thinking but never a user turn", () => {
    const { session, stats } = compactSession(bigSession());
    expect(stats.thinkingDropped).toBe(3);
    const user = session.entries.find((e) => e.kind === "user")!;
    expect((user as { content: { text?: string }[] }).content[0]!.text).toBe("fix the auth bug");
    const anyThinking = session.entries.some(
      (e) => e.kind === "assistant" && e.content.some((p) => p.type === "thinking"),
    );
    expect(anyThinking).toBe(false);
  });

  test("compact leaves a note saying what went missing", () => {
    const { session } = compactSession(bigSession());
    const note = session.entries[0]!;
    expect(note.kind).toBe("note");
    expect((note as { text?: string }).text).toContain("/src/auth.ts");
    expect((note as { text?: string }).text).toContain("superseded");
  });

  test("compact keeps the entry tree valid", () => {
    const { session } = compactSession(bigSession());
    expect(() => validateSession(session)).not.toThrow();
    // Ids and parents are untouched, so nothing is orphaned.
    const ids = new Set(session.entries.map((e) => e.id));
    for (const e of session.entries) if (e.parentId) expect(ids.has(e.parentId)).toBe(true);
  });

  test("compact is a large win on a tool-heavy session", () => {
    const { stats } = compactSession(bigSession());
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore / 4);
  });
});
