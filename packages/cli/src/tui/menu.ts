/**
 * The interactive menu runtime — everything impure the state machine is not.
 *
 * Terminal handling is deliberately conservative: alternate screen buffer, raw
 * mode, cursor hidden. All three are unwound BEFORE a harness is spawned, so
 * the child inherits a clean tty and its own full-screen UI works normally.
 */

import { createInterface } from "node:readline/promises";
import type { HarnessAdapter, HarnessId, NativeRef, SessionRef, SifSession } from "@sinter/core";
import { validateSession } from "@sinter/core";
import type { LedgerRow } from "@sinter/ledger";
import { EXIT } from "../args";
import { adapterCapabilities } from "../capabilities";
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

/** Rows pulled into the menu. Beyond this the filter box is the wrong tool. */
const ROW_LIMIT = 10000;

// ------------------------------------------------------------- capabilities

export async function resolveCaps(ctx: Ctx): Promise<HarnessCaps[]> {
  const loads = await ctx.registry.load();
  const capabilities = await adapterCapabilities(ctx.registry, { detectStores: false });
  return capabilities.map((capability) => ({
    id: capability.harness,
    available: capability.adapter === "available",
    canWrite: capability.write,
    onPath: capability.resume === "available",
    experimental: capability.resume === "unverified",
    error: loads.find((load) => load.id === capability.harness)?.error,
  }));
}

function loadThreads(ctx: Ctx): Thread[] {
  const ledger = ctx.ledger();
  const rows: LedgerRow[] = ledger.list({ limit: ROW_LIMIT });
  // Sessions sinter has never ported have no link and stay single-hop threads.
  return buildThreads(rows, ledger.lineage());
}

// ------------------------------------------------------------------- screen

export interface Screen {
  render(state: MenuState): MenuState;
  /** Next stdin chunk, or undefined when the terminal input has closed. */
  read(): Promise<string | undefined>;
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
  let inputClosed = false;

  const queue: string[] = [];
  let waiting: ((chunk: string | undefined) => void) | undefined;
  let last: MenuState | undefined;

  const onData = (chunk: string): void => {
    if (!chunk) {
      onInputClosed();
      return;
    }
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(chunk);
    } else {
      queue.push(chunk);
    }
  };

  const onInputClosed = (): void => {
    if (inputClosed) return;
    inputClosed = true;
    const resolve = waiting;
    waiting = undefined;
    resolve?.(undefined);
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
    const wasClosed = closed;
    closed = true;
    process.stdin.off("data", onData);
    process.stdin.off("end", onInputClosed);
    process.stdin.off("close", onInputClosed);
    process.stdin.off("error", onInputClosed);
    process.stdout.off("resize", onResize);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
    process.stdin.pause();
    if (!wasClosed) out.write("\x1b[?25h\x1b[?1049l");
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
  process.stdin.on("end", onInputClosed);
  process.stdin.on("close", onInputClosed);
  process.stdin.on("error", onInputClosed);
  process.stdout.on("resize", onResize);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.stdin.resume();

  return {
    render: paint,
    read(): Promise<string | undefined> {
      const buffered = queue.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (closed || inputClosed) return Promise.resolve(undefined);
      const { promise, resolve } = Promise.withResolvers<string | undefined>();
      waiting = resolve;
      return promise;
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

/** Render and reduce input until a keypress acts or the terminal disappears. */
export async function nextEffect(
  screen: Screen,
  start: MenuState,
): Promise<{ state: MenuState; effect: Effect }> {
  let state = screen.render(start);
  for (;;) {
    const chunk = await screen.read();
    if (chunk === undefined) return { state, effect: { type: "quit" } };
    const step = dispatchChunk(chunk, state);
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
  const namedSource = tip.alias ? { ...source, title: { text: tip.alias, source: "user" as const } } : source;
  const { session, stats } = applyTransfer(namedSource, mode);
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

async function promptAlias(thread: Thread): Promise<{ changed: boolean; alias?: string }> {
  const current = thread.tip.alias ? ` (current: ${thread.tip.alias})` : "";
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`New Sinter alias${current}; blank cancels, - clears: `)).trim();
    if (!answer) return { changed: false };
    return answer === "-" ? { changed: true } : { changed: true, alias: answer };
  } finally {
    readline.close();
  }
}

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
  let screen = openScreen(ctx);

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

      if (effect.type === "rename") {
        screen.close();
        const renamed = await promptAlias(effect.thread);
        if (renamed.changed)
          ctx.ledger().setAlias(effect.thread.tip.harness, effect.thread.tip.nativeId, renamed.alias);
        state = {
          ...state,
          screen: "sessions",
          selected: undefined,
          threads: loadThreads(ctx),
          message: renamed.changed
            ? renamed.alias
              ? `alias set to “${renamed.alias}”`
              : "alias cleared"
            : "rename cancelled",
        };
        screen = openScreen(ctx);
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
