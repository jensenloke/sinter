/**
 * The interactive menu runtime — everything impure the state machine is not.
 *
 * Terminal handling is deliberately conservative: alternate screen buffer, raw
 * mode, cursor hidden. All three are unwound BEFORE a harness is spawned, so
 * the child inherits a clean tty and its own full-screen UI works normally.
 */

import type { HarnessAdapter, HarnessId, NativeRef, SessionRef, SifSession } from "@sinter/core";
import { validateSession } from "@sinter/core";
import type { LedgerRow } from "@sinter/ledger";
import { EXIT } from "../args";
import type { Ctx } from "../commands";
import { shortenPath, termHeight, termWidth } from "../format";
import { renderTranscript } from "../render";
import { applyTransfer, fmtBytes, type TransferMode } from "../transfer";
import { parseKeys } from "./keys";
import {
  COMMAND_KEYS,
  applyCommand,
  initialState,
  reduce,
  setPageSize,
  visibleThreads,
  type Effect,
  type HarnessCaps,
  type MenuState,
  type Scope,
  type Step,
} from "./state";
import { buildThreads, type Thread } from "./threads";
import { pageSizeFor, renderFrame } from "./view";

const HARNESSES: HarnessId[] = ["claude", "codex", "devin", "opencode", "zcode", "omp", "pi"];

/** Rows pulled into the menu. Beyond this the filter box is the wrong tool. */
const ROW_LIMIT = 2000;

// ------------------------------------------------------------- capabilities

/** The binary a harness is resumed with, taken from its own resumeCommand(). */
function resumeBinary(adapter: HarnessAdapter): string | undefined {
  try {
    return adapter.resumeCommand({ harness: adapter.id, nativeId: "probe" })[0];
  } catch {
    return undefined;
  }
}

export async function resolveCaps(ctx: Ctx): Promise<HarnessCaps[]> {
  const loads = await ctx.registry.load();
  const caps: HarnessCaps[] = [];
  for (const id of HARNESSES) {
    const load = loads.find((l) => l.id === id);
    if (!load?.adapter) {
      caps.push({ id, available: false, canWrite: false, onPath: false, error: load?.error });
      continue;
    }
    const bin = resumeBinary(load.adapter);
    caps.push({
      id,
      available: true,
      canWrite: typeof load.adapter.write === "function",
      onPath: !!bin && !!Bun.which(bin),
      // zcode ships no CLI; its resumeCommand() is documented as a guess.
      experimental: id === "zcode",
    });
  }
  return caps;
}

function loadThreads(ctx: Ctx): Thread[] {
  const ledger = ctx.ledger();
  const rows: LedgerRow[] = ledger.list({ limit: ROW_LIMIT });
  // Sessions sinter has never ported have no link and stay single-hop threads.
  return buildThreads(rows, ledger.lineage());
}

// ------------------------------------------------------------------- screen

interface Screen {
  render(state: MenuState): MenuState;
  /** Next stdin chunk. Chunks that arrived earlier are returned immediately. */
  read(): Promise<string>;
  close(): void;
}

/**
 * One persistent `data` listener for the whole menu.
 *
 * Attaching a listener per keypress loses input: `stdin.resume()` puts the
 * stream in flowing mode, and anything that arrives while no listener is
 * attached is discarded — so keys typed during startup, or during a rescan,
 * would vanish. Buffering into a queue makes the read side race-free.
 */
function openScreen(ctx: Ctx): Screen {
  const out = process.stdout;
  const wasRaw = process.stdin.isRaw;
  let closed = false;

  const queue: string[] = [];
  let waiting: ((chunk: string) => void) | undefined;
  let last: MenuState | undefined;

  const onData = (chunk: string): void => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(chunk);
    } else {
      queue.push(chunk);
    }
  };

  const paint = (state: MenuState): MenuState => {
    const height = termHeight();
    const width = termWidth();
    const sized = setPageSize(state, pageSizeFor(height));
    const lines = renderFrame(sized, { width, height, pal: ctx.pal, now: Date.now() });
    // Home, then paint; \x1b[J clears anything the frame did not cover.
    out.write("\x1b[H" + lines.slice(0, height).join("\n") + "\x1b[J");
    last = sized;
    return sized;
  };

  const onResize = (): void => {
    if (!closed && last) paint(last);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    process.stdin.off("data", onData);
    process.stdout.off("resize", onResize);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
    process.stdin.pause();
    out.write("\x1b[?25h\x1b[?1049l");
  };

  // Being killed must not leave the user in a raw-mode alternate screen.
  function onSignal(): void {
    close();
    process.exit(130);
  }

  out.write("\x1b[?1049h\x1b[?25l");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  process.stdout.on("resize", onResize);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.stdin.resume();

  return {
    render: paint,
    read(): Promise<string> {
      const buffered = queue.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close,
  };
}

// -------------------------------------------------------------- input loop

/**
 * Feed one stdin chunk through the reducer. Command chords are pulled out
 * first: they are C0 bytes that never appear inside a CSI escape sequence, so
 * splitting the chunk on them is safe, and it keeps them out of the filter box.
 */
export function dispatchChunk(chunk: string, state: MenuState): Step {
  let current = state;
  let buffer = "";

  const flush = (): Effect | undefined => {
    if (!buffer) return undefined;
    for (const key of parseKeys(buffer)) {
      const step = reduce(current, key);
      current = step.state;
      if (step.effect) {
        buffer = "";
        return step.effect;
      }
    }
    buffer = "";
    return undefined;
  };

  for (const ch of chunk) {
    const cmd = COMMAND_KEYS[ch];
    if (cmd) {
      const effect = flush();
      if (effect) return { state: current, effect };
      const step = applyCommand(current, cmd);
      current = step.state;
      if (step.effect) return { state: current, effect: step.effect };
      continue;
    }
    buffer += ch;
  }

  const effect = flush();
  return { state: current, effect };
}

/** Render, wait for input, reduce — until a keypress produces an effect. */
async function nextEffect(
  screen: Screen,
  start: MenuState,
): Promise<{ state: MenuState; effect: Effect }> {
  let state = screen.render(start);
  for (;;) {
    const step = dispatchChunk(await screen.read(), state);
    state = step.state;
    if (step.effect) return { state, effect: step.effect };
    state = screen.render(state);
  }
}

// ---------------------------------------------------------------- effects

async function readTip(ctx: Ctx, thread: Thread): Promise<SifSession> {
  const tip = thread.tip;
  const adapter = await ctx.registry.get(tip.harness);
  return adapter.read({ harness: tip.harness, nativeId: tip.nativeId, nativePath: tip.nativePath });
}

async function readTipForPort(ctx: Ctx, thread: Thread): Promise<SifSession> {
  const tip = thread.tip;
  const adapter = await ctx.registry.get(tip.harness);
  const ref: SessionRef = { harness: tip.harness, nativeId: tip.nativeId, nativePath: tip.nativePath };
  const withCarry = adapter as HarnessAdapter & { readWithCarry?: (ref: SessionRef) => Promise<SifSession> };
  if (withCarry.readWithCarry) return withCarry.readWithCarry(ref);
  if (adapter.id === "omp" || adapter.id === "pi") {
    return (adapter as HarnessAdapter & { read: (ref: SessionRef, opts: { useCarry: true }) => Promise<SifSession> }).read(ref, {
      useCarry: true,
    });
  }
  return adapter.read(ref);
}

function quoteArgv(argv: string[]): string {
  return argv.map((a) => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(" ");
}

/** Hand the terminal over to the harness and adopt its exit code. */
async function launch(ctx: Ctx, argv: string[]): Promise<number> {
  if (!ctx.exec) {
    ctx.out(quoteArgv(argv));
    return EXIT.OK;
  }
  ctx.err(ctx.pal.dim(`▸ ${quoteArgv(argv)}`));
  return await ctx.exec(argv);
}

async function doResume(ctx: Ctx, thread: Thread): Promise<number> {
  const tip = thread.tip;
  const adapter = await ctx.registry.get(tip.harness);
  const argv = adapter.resumeCommand({
    harness: tip.harness,
    nativeId: tip.nativeId,
    nativePath: tip.nativePath,
  });
  return launch(ctx, argv);
}

async function doPort(
  ctx: Ctx,
  thread: Thread,
  target: HarnessId,
  mode: TransferMode,
): Promise<number> {
  const tip = thread.tip;
  const adapter = await ctx.registry.get(target);
  if (!adapter.write) throw new Error(`${target} adapter cannot write sessions yet`);

  ctx.err(
    `${ctx.pal.cyan(tip.harness)} → ${ctx.pal.cyan(target)}  ${ctx.pal.dim(
      `${tip.nativeId.slice(0, 12)} · ${mode}`,
    )}`,
  );

  const source = await readTipForPort(ctx, thread);
  const { session, stats } = applyTransfer(source, mode);
  validateSession(session);

  if (stats.bytesAfter !== stats.bytesBefore)
    ctx.err(
      ctx.pal.dim(
        `  ${fmtBytes(stats.bytesBefore)} → ${fmtBytes(stats.bytesAfter)}` +
          (stats.resultsCollapsed ? `, ${stats.resultsCollapsed} tool result(s) collapsed` : "") +
          (stats.thinkingDropped ? `, ${stats.thinkingDropped} thinking block(s) dropped` : ""),
      ),
    );

  // Historical tool calls stay inert: a ported transcript must never be
  // re-executable by the receiving harness.
  const ref = await adapter.write(session, { liveTools: false });
  for (const c of ref.created ?? []) ctx.err(ctx.pal.dim(`  ${c}`));
  ctx.err(`  wrote ${ctx.pal.bold(`${ref.harness}:${ref.nativeId}`)}`);

  recordLineage(ctx, ref, thread);

  return launch(ctx, adapter.resumeCommand(ref));
}

/**
 * Cache the link the writer stamped into the target store.
 *
 * The store is the source of truth; this table only saves the menu from
 * re-reading every session to draw a chain. A writer that does not report its
 * provenance yet degrades to a single-hop link, which is still better than
 * nothing and is corrected by the next `sinter relink`.
 */
function recordLineage(ctx: Ctx, ref: NativeRef, thread: Thread): void {
  try {
    const ledger = ctx.ledger();
    if (ref.provenance) {
      ledger.recordProvenance(ref.provenance);
      return;
    }
    const tip = thread.tip;
    ledger.recordLineage({
      harness: ref.harness,
      nativeId: ref.nativeId,
      threadId: ledger.threadIdOf(tip.harness, tip.nativeId) ?? `${tip.harness}:${tip.nativeId}`,
      hop: thread.hops.length,
      parentHarness: tip.harness,
      parentNativeId: tip.nativeId,
      portedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Lineage is a cache. Failing to write it must never lose the port itself,
    // which has already succeeded by this point.
    ctx.err(ctx.pal.dim(`  (lineage not recorded: ${err instanceof Error ? err.message : String(err)})`));
  }
}

async function doShow(ctx: Ctx, thread: Thread): Promise<number> {
  const session = await readTip(ctx, thread);
  ctx.out(
    renderTranscript(session, { width: ctx.width, pal: ctx.pal, toolResultChars: 240, subsessions: true }),
  );
  return EXIT.OK;
}

// ------------------------------------------------------------------- entry

export interface MenuOpts {
  cwd?: string;
  mode?: TransferMode;
  /** Force the initial scope instead of auto-picking cwd when it has sessions. */
  scope?: Scope;
}

export async function runMenu(ctx: Ctx, opts: MenuOpts = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const caps = await resolveCaps(ctx);

  let threads = loadThreads(ctx);
  if (!threads.length) {
    ctx.err("empty ledger — scanning every harness (this happens once)…");
    await ctx.ledger().scan(await ctx.registry.available());
    threads = loadThreads(ctx);
  }
  if (!threads.length) {
    ctx.err("no sessions found in any harness — try `sinter doctor`");
    return EXIT.ERROR;
  }

  let state = initialState({ threads, caps, cwd, mode: opts.mode, scope: opts.scope });
  const screen = openScreen(ctx);

  try {
    for (;;) {
      const { state: next, effect } = await nextEffect(screen, state);
      state = next;

      if (effect.type === "quit") {
        screen.close();
        return EXIT.OK;
      }

      if (effect.type === "rescan") {
        process.stdout.write("\x1b[H\x1b[2J" + ctx.pal.dim(" scanning every harness…\n"));
        const result = await ctx.ledger().scan(await ctx.registry.available());
        const errs = result.errors.map((e) => `${e.harness}: ${e.error}`);
        state = {
          ...state,
          threads: loadThreads(ctx),
          message: errs.length ? `scan errors — ${errs.join("; ")}` : "ledger rescanned",
        };
        continue;
      }

      // Everything else leaves the menu for good: give the tty back first.
      screen.close();
      if (effect.type === "resume") return await doResume(ctx, effect.thread);
      if (effect.type === "show") return await doShow(ctx, effect.thread);
      return await doPort(ctx, effect.thread, effect.target, effect.mode);
    }
  } finally {
    screen.close();
  }
}

/** `sinter` with no arguments, when stdin/stdout are a terminal. */
export function canRunMenu(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

export { shortenPath, visibleThreads };
