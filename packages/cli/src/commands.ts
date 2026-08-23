import { createInterface } from "node:readline/promises";
import type {
  HarnessAdapter,
  HarnessId,
  NativeRef,
  SessionRef,
  SessionSummary,
  SifEntry,
  SifSession,
} from "@sinter/core";
import { provenanceOf, validateSession } from "@sinter/core";
import type { Ledger, LedgerRow, ListOpts } from "@sinter/ledger";
import {
  CliError,
  EXIT,
  flagBool,
  flagString,
  parseArgs,
  parseHarness,
  parseSince,
  type ParsedArgs,
} from "./args";
import type { AdapterRegistry } from "./adapters";
import { defaultConfigPath, inspectConfig, PROFILE_EXAMPLE, type SinterProfile } from "./config";

import {
  displayId,
  formatCount,
  humanAge,
  renderTable,
  shortId,
  shortenPath,
  truncate,
  type Palette,
} from "./format";
import { renderTranscript, slimSession } from "./render";
import { renderSupportReport, supportPlatform, type SupportHarnessStatus } from "./support-report";
import { applyTransfer, fmtBytes, TRANSFER_MODES, type TransferMode } from "./transfer";

export interface Ctx {
  registry: AdapterRegistry;
  /** Lazy: doctor/import must work without touching the ledger file. */
  ledger: () => Ledger;
  out: (s: string) => void;
  err: (s: string) => void;
  pal: Palette;
  width: number;
  now: number;
  writeFile: (path: string, content: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  /** Only used by `resume --exec`. Returns the child's exit code. */
  exec?: (argv: string[]) => Promise<number>;
  profile?: SinterProfile;
  /** Setup confirmation; injectable so the command stays testable. */
  confirm?: (question: string) => Promise<boolean>;
  /**
   * Refresh the ledger with an automatic scan before the command runs. The
   * real CLI enables it via `makeCtx`; tests build their ctx without it so the
   * in-memory ledger stays deterministic. `--no-scan` / SINTER_NO_SCAN=1
   * override this off for any run.
   */
  autoScan?: boolean;
  /** Runtime CLI version, injected by main so helpers do not import it circularly. */
  version?: string;
}

// ------------------------------------------------------------------ helpers

function filterOpts(args: ParsedArgs, now: number): ListOpts {
  const opts: ListOpts = {};
  const harness = flagString(args, "harness");
  if (harness) opts.harness = harness.split(",").map((h) => parseHarness(h)) as HarnessId[];

  const cwd = flagString(args, "cwd");
  if (cwd) opts.cwd = cwd === "." ? process.cwd() : cwd.replace(/\/$/, "");

  const since = flagString(args, "since");
  if (since) opts.since = parseSince(since, now);

  const limit = flagString(args, "limit");
  if (limit !== undefined) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) throw new CliError(`bad --limit: ${limit}`);
    opts.limit = Math.floor(n);
  }
  if (flagBool(args, "no-ghost")) opts.includeGhost = false;
  if (flagBool(args, "no-sub")) opts.includeSubagents = false;
  return opts;
}

export function rowsTable(rows: LedgerRow[], ctx: Ctx): string {
  const p = ctx.pal;
  const body = rows.map((r) => {
    const nativeLabel = r.title || r.firstPrompt || "";
    const label = r.alias ? `${r.alias}${nativeLabel && nativeLabel !== r.alias ? ` · ${nativeLabel}` : ""}` : nativeLabel;
    return [
      r.ghost ? p.dim(displayId(r.nativeId)) : p.bold(displayId(r.nativeId)),
      p.cyan(r.harness),
      p.dim(humanAge(r.updatedAt ?? r.createdAt, ctx.now)),
      p.dim(shortenPath(r.cwd, 28)),
      formatCount(r.messageCount),
      (r.isSubagent ? p.blue("↳ ") : "") + (r.ghost ? p.dim("†") : "") + truncate(label, 400),
    ];
  });
  return renderTable(
    [
      { header: "ID", max: 14 },
      { header: "HARNESS", max: 8 },
      { header: "AGE", max: 5, align: "right" },
      { header: "CWD", max: 28 },
      { header: "MSG", max: 5, align: "right" },
      { header: "TITLE", flex: true },
    ],
    body,
    { width: ctx.width, pal: ctx.pal },
  );
}

function printRows(rows: LedgerRow[], ctx: Ctx, args: ParsedArgs): number {
  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify(rows, null, 2));
    return EXIT.OK;
  }
  if (!rows.length) {
    ctx.err("no sessions matched (run `sinter scan` first?)");
    return EXIT.OK;
  }
  ctx.out(rowsTable(rows, ctx));
  return EXIT.OK;
}

/**
 * Build a SessionSummary for a freshly-written target so callers can resolve it
 * immediately — before any `sinter scan`. The writer returns enough to do this;
 * `scan` would only re-derive the same row from the target store.
 *
 * `messageCount` is the count of the rendered transcript's message-bearing
 * entries (user + assistant), matching what Codex's own thread rows expose.
 */
function summarize(ref: NativeRef, session: SifSession, cwd: string | undefined): SessionSummary {
  const userAssistant = session.entries.filter((e: SifEntry) => e.kind === "user" || e.kind === "assistant").length;
  let firstPrompt: string | undefined;
  for (const e of session.entries) {
    if (e.kind !== "user" || e.synthetic) continue;
    const text = e.content.find((p): p is { type: "text"; text: string } => p.type === "text")?.text.trim();
    if (text) {
      firstPrompt = text;
      break;
    }
  }
  firstPrompt = firstPrompt ?? session.title?.text ?? undefined;
  return {
    harness: ref.harness,
    nativeId: ref.nativeId,
    nativePath: ref.nativePath,
    cwd: cwd || session.cwd,
    title: session.title?.text,
    firstPrompt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: userAssistant || undefined,
    parentNativeId: session.origin.nativeId,
  };
}

/** Resolve an id prefix or fail with the candidate list (exit 2). */
export function resolveRow(ctx: Ctx, prefix: string): LedgerRow {
  const { row, candidates } = ctx.ledger().resolve(prefix);
  if (row) return row;
  if (!candidates.length)
    throw new CliError(`no session matches "${prefix}" (run \`sinter scan\`?)`, EXIT.AMBIGUOUS);
  // Full native ids here: the differing part is often the tail (subagent ids).
  const idWidth = Math.min(52, Math.max(...candidates.map((c) => c.nativeId.length)));
  const lines = candidates
    .slice(0, 10)
    .map(
      (c) =>
        `  ${truncate(c.nativeId, idWidth).padEnd(idWidth)}  ${c.harness}  ${truncate(
          c.title ?? c.firstPrompt ?? "",
          Math.max(20, ctx.width - idWidth - 16),
        )}`,
    );
  throw new CliError(
    `ambiguous id "${prefix}" — ${candidates.length} matches:\n${lines.join("\n")}` +
      (candidates.length > 10 ? `\n  …and ${candidates.length - 10} more` : "") +
      `\nnarrow it with a longer prefix or harness:id`,
    EXIT.AMBIGUOUS,
  );
}

function quoteArgv(argv: string[]): string {
  return argv.map((a) => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(" ");
}

function printResume(ctx: Ctx, adapter: HarnessAdapter, ref: { harness: HarnessId; nativeId: string; nativePath?: string }): string {
  let argv: string[];
  try {
    argv = adapter.resumeCommand(ref);
  } catch (err) {
    ctx.err(`no resume command for ${ref.harness}: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
  const cmd = quoteArgv(argv);
  ctx.out("");
  ctx.out(ctx.pal.dim("resume with:"));
  ctx.out(`  ${ctx.pal.bold(cmd)}`);
  return cmd;
}

async function readSession(ctx: Ctx, row: LedgerRow): Promise<SifSession> {
  const adapter = await ctx.registry.get(row.harness);
  return adapter.read({ harness: row.harness, nativeId: row.nativeId, nativePath: row.nativePath });
}

/**
 * Porting should start from the best carry-forward view when a session was
 * previously imported by sinter. `read()` must stay native for show/export/relink,
 * but an onward port wants the original entries, not a second flattening of the
 * receiving harness's inert transcript.
 */
async function readSessionForPort(ctx: Ctx, row: LedgerRow): Promise<SifSession> {
  const adapter = await ctx.registry.get(row.harness);
  const ref: SessionRef = { harness: row.harness, nativeId: row.nativeId, nativePath: row.nativePath };
  const withCarry = adapter as HarnessAdapter & { readWithCarry?: (ref: SessionRef) => Promise<SifSession> };
  let session: SifSession;
  if (withCarry.readWithCarry) session = await withCarry.readWithCarry(ref);
  else if (adapter.id === "omp" || adapter.id === "pi") {
    session = await (adapter as HarnessAdapter & { read: (ref: SessionRef, opts: { useCarry: true }) => Promise<SifSession> }).read(ref, {
      useCarry: true,
    });
  } else session = await adapter.read(ref);
  return row.alias ? { ...session, title: { text: row.alias, source: "user" } } : session;
}

// ----------------------------------------------------------------- commands

export async function cmdConfig(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["config"], booleans: ["json"] });
  const action = args._[0] ?? "show";
  if (args._.length > 1 || !["show", "path", "validate"].includes(action))
    throw new CliError("usage: sinter config [show|path|validate] [--config file] [--json]");
  const configPath = flagString(args, "config") ?? defaultConfigPath();
  if (action === "path") {
    if (flagBool(args, "json")) ctx.out(JSON.stringify({ configPath }, null, 2));
    else ctx.out(configPath);
    return EXIT.OK;
  }

  const summary = inspectConfig(configPath);
  if (action === "validate") {
    const stores = summary.profiles.reduce((total, profile) => total + Object.keys(profile.stores).length, 0);
    if (flagBool(args, "json")) {
      ctx.out(JSON.stringify({ valid: true, configPath, profiles: summary.profiles.length, stores }, null, 2));
    } else {
      ctx.out(`valid config: ${summary.profiles.length} profile(s), ${stores} store root(s)`);
    }
    return EXIT.OK;
  }

  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify(summary, null, 2));
    return EXIT.OK;
  }
  ctx.out(`config: ${configPath}`);
  const rows = summary.profiles.flatMap((profile) =>
    Object.entries(profile.stores).map(([harness, path]) => [profile.name, harness, path ?? ""]),
  );
  ctx.out(
    renderTable(
      [{ header: "PROFILE" }, { header: "HARNESS" }, { header: "STORE ROOT", flex: true }],
      rows,
      { width: ctx.width, pal: ctx.pal },
    ),
  );
  return EXIT.OK;
}

export async function cmdScan(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["harness"], booleans: ["json"] });
  const only = flagString(args, "harness")
    ?.split(",")
    .map((h) => parseHarness(h));

  const loads = await ctx.registry.load();
  const adapters = loads
    .filter((l) => l.adapter && (!only || only.includes(l.id as never)))
    .map((l) => l.adapter!);
  const unavailable = loads.filter((l) => !l.adapter && (!only || only.includes(l.id as never)));

  if (!adapters.length) {
    if (flagBool(args, "json")) throw new CliError("no adapters available — nothing to scan");
    ctx.err("no adapters available — nothing to scan");
    for (const u of unavailable) ctx.err(`  adapter not available: ${u.id} (${u.error})`);
    return EXIT.ERROR;
  }

  const ledger = ctx.ledger();
  const result = await ledger.scan(adapters);

  if (flagBool(args, "json")) {
    ctx.out(
      JSON.stringify(
        {
          schema: "sinter.scan.v1",
          ok: result.errors.length === 0,
          harnesses: result.harnesses,
          unavailable: unavailable.map((adapter) => ({ harness: adapter.id })),
          errors: result.errors.map((error) => ({ harness: error.harness, message: error.error })),
        },
        null,
        2,
      ),
    );
    return result.errors.length ? EXIT.ERROR : EXIT.OK;
  }

  const rows = Object.entries(result.harnesses).map(([h, s]) => [
    ctx.pal.cyan(h),
    String(s.seen),
    String(s.inserted),
    String(s.updated),
    s.ghosts ? ctx.pal.dim(String(s.ghosts)) : "0",
  ]);
  ctx.out(
    renderTable(
      [
        { header: "HARNESS" },
        { header: "SEEN", align: "right" },
        { header: "NEW", align: "right" },
        { header: "UPD", align: "right" },
        { header: "GHOST", align: "right" },
      ],
      rows,
      { width: ctx.width, pal: ctx.pal },
    ),
  );

  for (const u of unavailable) ctx.err(ctx.pal.dim(`adapter not available: ${u.id} (${u.error})`));
  for (const e of result.errors) ctx.err(ctx.pal.red(`scan error [${e.harness}]: ${e.error}`));
  return result.errors.length ? EXIT.ERROR : EXIT.OK;
}

export async function cmdLs(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["harness", "cwd", "since", "limit"],
    booleans: ["json", "no-ghost", "no-sub"],
    alias: { n: "limit" },
  });
  const opts = filterOpts(args, ctx.now);
  opts.limit ??= 30;
  return printRows(ctx.ledger().list(opts), ctx, args);
}

/** A low-noise view for quickly finding the work a user just left. */
export async function cmdRecent(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["harness", "cwd", "since", "limit"],
    booleans: ["json"],
    alias: { n: "limit" },
  });
  const opts = filterOpts(args, ctx.now);
  opts.includeGhost = false;
  opts.includeSubagents = false;
  opts.limit ??= 10;
  return printRows(ctx.ledger().list(opts), ctx, args);
}

/** Print or execute the native resume command for the newest matching session. */
export async function cmdLast(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["harness", "cwd", "since"],
    booleans: ["exec", "id", "json"],
  });
  const selected = ["exec", "id", "json"].filter((flag) => flagBool(args, flag));
  if (selected.length > 1) throw new CliError(`choose one output mode: ${selected.map((flag) => `--${flag}`).join(", ")}`);

  const opts = filterOpts(args, ctx.now);
  opts.includeGhost = false;
  opts.includeSubagents = false;
  opts.limit = 1;
  const row = ctx.ledger().list(opts)[0];
  if (!row) throw new CliError("no recent sessions matched (run `sinter scan` first?)", EXIT.AMBIGUOUS);

  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify(row, null, 2));
    return EXIT.OK;
  }
  if (flagBool(args, "id")) {
    ctx.out(`${row.harness}:${row.nativeId}`);
    return EXIT.OK;
  }

  const adapter = await ctx.registry.get(row.harness);
  const ref = { harness: row.harness, nativeId: row.nativeId, nativePath: row.nativePath };
  if (flagBool(args, "exec")) {
    if (!ctx.exec) throw new CliError("--exec is not available in this context");
    const resumeArgv = adapter.resumeCommand(ref);
    ctx.err(ctx.pal.dim(`exec: ${quoteArgv(resumeArgv)}`));
    return await ctx.exec(resumeArgv);
  }
  printResume(ctx, adapter, ref);
  return EXIT.OK;
}

export async function cmdSearch(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["harness", "cwd", "since", "limit"],
    booleans: ["json", "no-ghost", "no-sub"],
    alias: { n: "limit" },
  });
  const query = args._.join(" ").trim();
  if (!query) throw new CliError("usage: sinter search <query>");
  const opts = filterOpts(args, ctx.now);
  opts.limit ??= 30;
  return printRows(ctx.ledger().search(query, opts), ctx, args);
}

export async function cmdRename(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { booleans: ["clear"] });
  const prefix = args._[0];
  if (!prefix) throw new CliError("usage: sinter rename <id-prefix> <alias>");
  const row = resolveRow(ctx, prefix);
  const alias = args._.slice(1).join(" ").trim();
  if (!alias && !flagBool(args, "clear"))
    throw new CliError("sinter rename needs an alias (or --clear)");
  ctx.ledger().setAlias(row.harness, row.nativeId, alias || undefined);
  ctx.out(alias ? `${row.harness}:${displayId(row.nativeId)} → ${alias}` : `cleared alias for ${row.harness}:${displayId(row.nativeId)}`);
  return EXIT.OK;
}

export async function cmdShow(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { booleans: ["json", "no-sub"], strings: ["tool-chars", "tail"] });
  const prefix = args._[0];
  if (!prefix) throw new CliError("usage: sinter show <id-prefix>");
  const tailValue = flagString(args, "tail");
  let tailEntries: number | undefined;
  if (tailValue !== undefined) {
    tailEntries = Number(tailValue);
    if (!Number.isInteger(tailEntries) || tailEntries <= 0) throw new CliError(`bad --tail: ${tailValue}`);
    if (flagBool(args, "json")) throw new CliError("--tail is for rendered output and cannot be combined with --json");
  }
  const row = resolveRow(ctx, prefix);
  if (row.ghost) ctx.err(ctx.pal.dim(`note: ${shortId(row.nativeId)} is a ghost row — the harness may have GC'd it`));

  const session = await readSession(ctx, row);
  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify(session, null, 2));
    return EXIT.OK;
  }
  const toolChars = Number(flagString(args, "tool-chars") ?? 240);
  ctx.out(
    renderTranscript(session, {
      width: ctx.width,
      pal: ctx.pal,
      toolResultChars: Number.isFinite(toolChars) ? toolChars : 240,
      subsessions: !flagBool(args, "no-sub"),
      tailEntries,
    }),
  );
  return EXIT.OK;
}

export async function cmdExport(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["output"], booleans: ["slim"], alias: { o: "output" } });
  const prefix = args._[0];
  if (!prefix) throw new CliError("usage: sinter export <id-prefix> [-o file] [--slim]");
  const row = resolveRow(ctx, prefix);
  let session = await readSession(ctx, row);
  if (flagBool(args, "slim")) session = slimSession(session);

  const json = JSON.stringify(session, null, 2);
  const out = flagString(args, "output");
  if (out) {
    await ctx.writeFile(out, json + "\n");
    ctx.err(`wrote ${out} (${session.entries.length} entries${flagBool(args, "slim") ? ", slim" : ""})`);
  } else {
    ctx.out(json);
  }
  return EXIT.OK;
}

async function writeInto(
  ctx: Ctx,
  target: HarnessId,
  session: SifSession,
  args: ParsedArgs,
): Promise<number> {
  const adapter = await ctx.registry.get(target);
  if (!adapter.write) throw new CliError(`${target} adapter cannot write sessions yet`);

  const cwd = flagString(args, "cwd");
  const dryRun = flagBool(args, "dry-run");
  const resolvedCwd = cwd === "." ? process.cwd() : cwd;
  const ref = await adapter.write(session, {
    cwd: resolvedCwd,
    liveTools: flagBool(args, "live-tools"),
    dryRun,
  });

  ctx.err(
    `${dryRun ? "would write" : "wrote"} ${target}:${ref.nativeId}` +
      (ref.created?.length ? ` (${ref.created.length} file(s))` : ""),
  );
  for (const c of ref.created ?? []) ctx.err(ctx.pal.dim(`  ${c}`));

  // Cache the lineage link the writer stamped into the target store. A dry run
  // wrote nothing, so there is nothing to remember.
  if (!dryRun && ref.provenance) {
    try {
      ctx.ledger().recordProvenance(ref.provenance);
      ctx.err(
        ctx.pal.dim(
          `  thread ${shortId(ref.provenance.threadId, 12)} · hop ${ref.provenance.hop} of ${
            ref.provenance.chain.length - 1
          }`,
        ),
      );
    } catch (err) {
      // The port already succeeded; a cache write must not turn that into a failure.
      ctx.err(ctx.pal.dim(`  (lineage not recorded: ${err instanceof Error ? err.message : String(err)})`));
    }
  }

  // The target store now has the session, but Sinter's own resolver reads the
  // ledger's `sessions` table — which `scan` populates. Without an explicit
  // upsert, `sinter resume <new-id>` would report "no session matches" until a
  // later scan. Index it now so it is immediately resolvable.
  if (!dryRun) {
    try {
      ctx.ledger().upsert(summarize(ref, session, resolvedCwd));
    } catch (err) {
      // Indexing is best-effort: the port succeeded and the target is usable.
      ctx.err(ctx.pal.dim(`  (ledger not updated: ${err instanceof Error ? err.message : String(err)})`));
    }
  }

  ctx.out(`${ref.harness}:${ref.nativeId}`);
  printResume(ctx, adapter, ref);
  return EXIT.OK;
}

export async function cmdImport(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["to", "cwd"],
    booleans: ["live-tools", "dry-run"],
  });
  const file = args._[0];
  if (!file) throw new CliError("usage: sinter import <file.sif.json> --to <harness>");
  const to = flagString(args, "to");
  if (!to) throw new CliError("sinter import needs --to <harness>");
  const target = parseHarness(to);

  let session: SifSession;
  try {
    session = JSON.parse(await ctx.readFile(file)) as SifSession;
  } catch (err) {
    throw new CliError(`cannot read SIF file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  validateSession(session);
  return writeInto(ctx, target, session, args);
}

export async function cmdPort(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["to", "cwd", "mode"],
    booleans: ["live-tools", "dry-run", "preview", "json"],
  });
  const prefix = args._[0];
  if (!prefix) throw new CliError("usage: sinter port <id-prefix> --to <harness>");
  if (flagBool(args, "json") && !flagBool(args, "preview"))
    throw new CliError("--json is currently available with --preview");
  const to = flagString(args, "to");
  if (!to) throw new CliError("sinter port needs --to <harness>");
  const target = parseHarness(to);

  const row = resolveRow(ctx, prefix);
  const source = await readSessionForPort(ctx, row);
  const mode = (flagString(args, "mode") ?? "full") as TransferMode;
  if (!TRANSFER_MODES.includes(mode))
    throw new CliError(`unknown --mode: ${mode} (known: ${TRANSFER_MODES.join(", ")})`);
  const transfer = applyTransfer(source, mode);
  const session = transfer.session;
  validateSession(session);
  if (flagBool(args, "preview")) {
    if (flagBool(args, "dry-run")) throw new CliError("--preview and --dry-run are separate modes; choose one");
    const adapter = await ctx.registry.get(target);
    if (!adapter.write) throw new CliError(`${target} adapter cannot write sessions yet`);
    let store: "detected" | "absent" | "check failed" = "absent";
    try {
      store = (await adapter.detect()) ? "detected" : "absent";
    } catch {
      store = "check failed";
    }
    const cwdFlag = flagString(args, "cwd");
    const cwd = cwdFlag === "." ? process.cwd() : cwdFlag ?? session.cwd;
    const reduction = transfer.stats.bytesBefore
      ? Math.max(0, Math.round((1 - transfer.stats.bytesAfter / transfer.stats.bytesBefore) * 100))
      : 0;
    const preview = {
      source: { harness: row.harness, nativeId: row.nativeId },
      target: { harness: target, adapter: "write-capable", store },
      mode,
      cwd,
      entries: { before: source.entries.length, after: session.entries.length },
      payload: {
        bytesBefore: transfer.stats.bytesBefore,
        bytesAfter: transfer.stats.bytesAfter,
        reductionPercent: reduction,
      },
      compact: {
        toolResultsCollapsed: transfer.stats.resultsCollapsed,
        thinkingDropped: transfer.stats.thinkingDropped,
      },
      historicalTools: flagBool(args, "live-tools") ? "live" : "inert",
      writes: false,
    };
    if (flagBool(args, "json")) {
      ctx.out(JSON.stringify(preview, null, 2));
      return EXIT.OK;
    }
    const rows = [
      ["source", `${row.harness}:${row.nativeId}`],
      ["target", `${target} (${store}, write-capable)`],
      ["mode", mode],
      ["working directory", cwd],
      ["entries", `${preview.entries.before} → ${preview.entries.after}`],
      ["payload", `${fmtBytes(transfer.stats.bytesBefore)} → ${fmtBytes(transfer.stats.bytesAfter)} (${reduction}% smaller)`],
      ["tool results collapsed", String(transfer.stats.resultsCollapsed)],
      ["thinking blocks dropped", String(transfer.stats.thinkingDropped)],
      ["historical tools", preview.historicalTools],
      ["writes", "none — preview only"],
    ];
    ctx.out("Port preview");
    ctx.out(renderTable([{ header: "FIELD" }, { header: "VALUE", flex: true }], rows, { width: ctx.width, pal: ctx.pal }));
    return EXIT.OK;
  }
  ctx.err(`porting ${row.harness}:${shortId(row.nativeId, 12)} → ${target}`);
  return writeInto(ctx, target, session, args);
}

export async function cmdResume(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["in", "cwd"],
    booleans: ["exec", "live-tools", "dry-run"],
  });
  const prefix = args._[0];
  if (!prefix) throw new CliError("usage: sinter resume <id-prefix> [--in <harness>]");
  const row = resolveRow(ctx, prefix);
  const inFlag = flagString(args, "in");
  const target = inFlag ? parseHarness(inFlag) : row.harness;

  let ref: { harness: HarnessId; nativeId: string; nativePath?: string };
  let adapter: HarnessAdapter;

  if (target === row.harness) {
    if (row.ghost)
      throw new CliError(
        `${shortId(row.nativeId)} is a ghost row — the ${row.harness} transcript is gone, port it instead`,
        EXIT.AMBIGUOUS,
      );
    adapter = await ctx.registry.get(row.harness);
    ref = { harness: row.harness, nativeId: row.nativeId, nativePath: row.nativePath };
  } else {
    const session = await readSessionForPort(ctx, row);
    validateSession(session);
    const targetAdapter = await ctx.registry.get(target);
    if (!targetAdapter.write) throw new CliError(`${target} adapter cannot write sessions yet`);
    ctx.err(`porting ${row.harness}:${shortId(row.nativeId, 12)} → ${target}`);
    const native = await targetAdapter.write(session, {
      cwd: flagString(args, "cwd") === "." ? process.cwd() : flagString(args, "cwd"),
      liveTools: flagBool(args, "live-tools"),
      dryRun: flagBool(args, "dry-run"),
    });
    for (const c of native.created ?? []) ctx.err(ctx.pal.dim(`  ${c}`));
    adapter = targetAdapter;
    ref = native;
    // Same as writeInto: index the freshly-written cross-harness target so a
    // subsequent `sinter resume <id>` resolves it without a separate scan.
    if (!flagBool(args, "dry-run")) {
      try {
        const crossCwd = flagString(args, "cwd") === "." ? process.cwd() : flagString(args, "cwd");
        ctx.ledger().upsert(summarize(native, session, crossCwd));
      } catch (err) {
        ctx.err(ctx.pal.dim(`  (ledger not updated: ${err instanceof Error ? err.message : String(err)})`));
      }
    }
  }

  const argv2 = adapter.resumeCommand(ref);
  if (flagBool(args, "exec")) {
    if (!ctx.exec) throw new CliError("--exec is not available in this context");
    ctx.err(ctx.pal.dim(`exec: ${quoteArgv(argv2)}`));
    return await ctx.exec(argv2);
  }
  printResume(ctx, adapter, ref);
  return EXIT.OK;
}

/**
 * Rebuild the lineage cache by re-reading the stores.
 *
 * The ledger's lineage table is only a cache: the authoritative record is the
 * provenance each writer stamped into the TARGET store. That is what makes the
 * ledger disposable — delete `~/.sinter/ledger.db`, rescan, relink, and every
 * thread comes back.
 *
 * Only harnesses sinter can write to are candidates: no other store can contain
 * a sinter provenance record, so reading them would be wasted work.
 */
export async function cmdRelink(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["harness", "limit"], booleans: ["quiet"] });
  const only = flagString(args, "harness")
    ?.split(",")
    .map((h) => parseHarness(h)) as HarnessId[] | undefined;

  const loads = await ctx.registry.load();
  const targets = loads
    .filter((l) => l.adapter && typeof l.adapter.write === "function")
    .filter((l) => !only || only.includes(l.id))
    .map((l) => l.id);

  if (!targets.length) {
    ctx.err("no write-capable adapters available — nothing could hold a sinter provenance record");
    return EXIT.ERROR;
  }

  const ledger = ctx.ledger();
  const limitFlag = flagString(args, "limit");
  const limit = limitFlag ? Number(limitFlag) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0))
    throw new CliError(`bad --limit: ${limitFlag}`);

  const rows = ledger.list({ harness: targets, includeGhost: false, limit });
  const quiet = flagBool(args, "quiet");
  if (!quiet) ctx.err(`relinking ${rows.length} session(s) across ${targets.join(", ")}…`);

  let linked = 0;
  let failed = 0;
  const threads = new Set<string>();

  for (const row of rows) {
    try {
      const adapter = await ctx.registry.get(row.harness);
      const session = await adapter.read({
        harness: row.harness,
        nativeId: row.nativeId,
        nativePath: row.nativePath,
      });
      const prov = provenanceOf(session);
      if (!prov) continue;
      ledger.recordProvenance(prov);
      threads.add(prov.threadId);
      linked++;
    } catch {
      // One unreadable session must not abort the sweep.
      failed++;
    }
  }

  ctx.out(
    `linked ${linked} session(s) into ${threads.size} thread(s)` +
      (failed ? `, ${failed} unreadable` : ""),
  );
  return EXIT.OK;
}

async function confirmSetup(ctx: Ctx): Promise<boolean> {
  const question = "Create or refresh the local ledger and open the menu? [Y/n]";
  if (ctx.confirm) return ctx.confirm(question);
  if (!process.stdin.isTTY) throw new CliError("setup needs an interactive terminal; use `sinter setup --yes`");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${question} `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

export async function cmdSetup(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { booleans: ["yes", "no-menu"] });
  const loads = await ctx.registry.load();
  const detected: string[] = [];
  for (const load of loads) {
    if (!load.adapter) continue;
    const store = await load.adapter.detect();
    if (store) detected.push(`${load.id}: ${(store.paths ?? []).join(", ")}`);
  }

  ctx.out("Sinter indexes local coding-agent session stores. It does not upload transcripts.");
  if (ctx.profile) ctx.out(`profile: ${ctx.profile.name} (${ctx.profile.configPath})`);
  if (detected.length) {
    ctx.out("");
    ctx.out("Detected local stores:");
    for (const store of detected) ctx.out(`  ${store}`);
  } else {
    ctx.out("");
    ctx.out("No local harness stores detected. Run `sinter doctor` for details.");
  }

  const approved = flagBool(args, "yes") || (await confirmSetup(ctx));
  if (!approved) {
    ctx.out("Setup cancelled. No session stores were changed.");
    return EXIT.OK;
  }
  const result = await cmdScan([], ctx);
  if (result !== EXIT.OK || flagBool(args, "yes") || flagBool(args, "no-menu")) return result;
  return cmdMenu([], ctx);
}

export async function cmdMenu(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["mode", "cwd"], booleans: ["all"] });
  const mode = flagString(args, "mode");
  if (mode && !TRANSFER_MODES.includes(mode as TransferMode))
    throw new CliError(`unknown --mode: ${mode} (known: ${TRANSFER_MODES.join(", ")})`);

  const { canRunMenu, runMenu } = await import("./tui/menu");
  if (!canRunMenu())
    throw new CliError("the menu needs an interactive terminal — try `sinter ls` instead");

  const cwdFlag = flagString(args, "cwd");
  return runMenu(ctx, {
    cwd: cwdFlag === "." || cwdFlag === undefined ? process.cwd() : cwdFlag,
    mode: mode as TransferMode | undefined,
    scope: flagBool(args, "all") ? "all" : undefined,
  });
}

export async function cmdPrivacy(argv: string[], ctx: Ctx): Promise<number> {
  parseArgs(argv, {});
  ctx.out("Sinter reads local coding-agent session stores on this machine. It does not upload transcripts.");
  ctx.out("Ports create a new target-native session; the source session is never changed.");
  ctx.out("");
  ctx.out("Sinter data:");
  ctx.out(`  ledger: ${ctx.ledger().path}`);
  ctx.out("  carry-forward data: stored beside a target session only when a port needs it");
  ctx.out("  telemetry: disabled unless you explicitly run `sinter telemetry enable`");
  ctx.out("    events contain a random installation id, version, OS/architecture, event name, and time only");
  ctx.out("    CI and non-interactive commands never emit telemetry; disable with `sinter telemetry disable`");
  if (ctx.profile) {
    ctx.out(`  profile: ${ctx.profile.name} (${ctx.profile.configPath})`);
    for (const [harness, path] of Object.entries(ctx.profile.stores)) ctx.out(`  ${harness}: ${path}`);
  } else {
    ctx.out("  profile: default harness stores (run `sinter doctor` for resolved paths)");
  }
  ctx.out("");
  ctx.out("Support:");
  ctx.out("  claude, codex CLI, devin, opencode, omp, pi: read, port, and CLI resume");
  ctx.out("  zcode: read-only; native resume is unverified");
  ctx.out("  ChatGPT.app / Codex desktop: future work; Sinter does not read or write its Chromium profile");
  ctx.out("");
  ctx.out("");
  ctx.out("Example profile config:");
  ctx.out(PROFILE_EXAMPLE.trimEnd());
  ctx.out("Profiles: one configured local store per harness. Additional accounts, profile directories,");
  ctx.out("and cloud-only history are not discovered automatically. Verify with `sinter doctor` before porting.");
  return EXIT.OK;
}

export async function cmdDoctor(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["output"], booleans: ["report", "json"], alias: { o: "output" } });
  const reportMode = flagBool(args, "report");
  const jsonMode = flagBool(args, "json");
  const reportOutput = flagString(args, "output");
  if (reportOutput && !reportMode) throw new CliError("--output requires --report");
  if (reportMode && jsonMode) throw new CliError("choose one output mode: --report or --json");
  if (ctx.profile && !reportMode && !jsonMode) {
    ctx.out(ctx.pal.dim(`profile: ${ctx.profile.name} (${ctx.profile.configPath})`));
    ctx.out(ctx.pal.dim("note: configured profile roots override defaults; other local profiles are not scanned."));
    ctx.out("");
  }
  const loads = await ctx.registry.load();
  const ledger = (() => {
    try {
      return ctx.ledger();
    } catch {
      return undefined;
    }
  })();

  const rows: string[][] = [];
  const unavailable: string[] = [];
  const supportRows: SupportHarnessStatus[] = [];
  let anyDetected = false;
  const ghostCounts = new Map((ledger?.counts() ?? []).map((count) => [count.harness, count.ghosts]));

  for (const l of loads) {
    if (!l.adapter) {
      unavailable.push(`${l.id}: ${l.error ?? "not installed"}`);
      supportRows.push({
        harness: l.id,
        adapter: "unavailable",
        store: "not-checked",
        ledgerSessions: ledger ? ledger.countFor(l.id) : 0,
        ghostSessions: ghostCounts.get(l.id) ?? 0,
      });
      continue;
    }
    let store: Awaited<ReturnType<HarnessAdapter["detect"]>> = null;
    let note = "";
    try {
      store = await l.adapter.detect();
    } catch (err) {
      note = `detect failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (store) anyDetected = true;
    const count = ledger ? ledger.countFor(l.id) : 0;
    supportRows.push({
      harness: l.id,
      adapter: "available",
      store: store ? "ok" : note ? "error" : "absent",
      version: store?.version,
      ledgerSessions: count,
      ghostSessions: ghostCounts.get(l.id) ?? 0,
    });
    rows.push([
      ctx.pal.cyan(l.id),
      store ? ctx.pal.green("ok") : note ? ctx.pal.red("error") : ctx.pal.dim("absent"),
      store?.version ?? "-",
      String(count),
      note || (store?.paths ?? []).map((p) => shortenPath(p, 46)).join(", ") || (store?.notes ?? "-"),
    ]);
  }

  const reportData = {
    generatedAt: new Date(ctx.now).toISOString(),
    sinterVersion: ctx.version ?? "development",
    bunVersion: Bun.version,
    platform: supportPlatform(),
    profileConfigured: Boolean(ctx.profile),
    ledgerAvailable: Boolean(ledger),
    harnesses: supportRows.sort((a, b) => a.harness.localeCompare(b.harness)),
  };
  if (jsonMode) {
    ctx.out(JSON.stringify({ schema: "sinter.doctor.v1", ok: anyDetected, ...reportData }, null, 2));
    return anyDetected || supportRows.length ? EXIT.OK : EXIT.ERROR;
  }
  if (reportMode) {
    const report = renderSupportReport(reportData);
    if (reportOutput) {
      await ctx.writeFile(reportOutput, report);
      ctx.err(`wrote privacy-safe diagnostic report to ${reportOutput}`);
    } else {
      ctx.out(report.trimEnd());
    }
    return anyDetected || supportRows.length ? EXIT.OK : EXIT.ERROR;
  }

  if (rows.length)
    ctx.out(
      renderTable(
        [
          { header: "HARNESS" },
          { header: "STORE" },
          { header: "VERSION", max: 14 },
          { header: "LEDGER", align: "right" },
          { header: "PATHS", flex: true },
        ],
        rows,
        { width: ctx.width, pal: ctx.pal },
      ),
    );

  if (unavailable.length) {
    ctx.out("");
    ctx.out(ctx.pal.dim("unavailable adapters:"));
    for (const u of unavailable) ctx.out(ctx.pal.dim(`  ${u}`));
  }
  if (ledger) {
    ctx.out("");
    ctx.out(ctx.pal.dim(`ledger: ${ledger.path}`));
    for (const c of ledger.counts())
      ctx.out(ctx.pal.dim(`  ${c.harness}: ${c.total}${c.ghosts ? ` (${c.ghosts} ghost)` : ""}`));
  }
  return anyDetected || rows.length ? EXIT.OK : EXIT.ERROR;
}

export async function cmdFeedback(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["title"], booleans: ["no-open"] });
  const { browserCommand, feedbackDiagnostics, feedbackUrl } = await import("./feedback");
  const detected: string[] = [];
  for (const load of await ctx.registry.load()) {
    if (!load.adapter) continue;
    try {
      if (await load.adapter.detect()) detected.push(load.id);
    } catch {
      // Diagnostics are best-effort and never include paths or error details.
    }
  }
  const url = feedbackUrl(feedbackDiagnostics(ctx.version ?? "development", detected), flagString(args, "title"));
  if (!flagBool(args, "no-open") && ctx.exec) {
    try {
      if ((await ctx.exec(browserCommand(url))) === 0) {
        ctx.out("Opened a prefilled GitHub issue. Review it before submitting.");
        return EXIT.OK;
      }
    } catch {
      // Fall through to the copyable URL.
    }
  }
  ctx.out("Open this URL to send feedback:");
  ctx.out(url);
  return EXIT.OK;
}

export async function cmdTelemetry(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["endpoint"] });
  const action = args._[0] ?? "status";
  if (args._.length > 1 || !["status", "enable", "disable"].includes(action))
    throw new CliError("usage: sinter telemetry [status|enable|disable] [--endpoint https://…]");
  const { disableTelemetry, enableTelemetry, readTelemetryConfig, telemetryConfigPath, trackTelemetry } =
    await import("./telemetry");
  if (action === "enable") {
    const endpoint = flagString(args, "endpoint");
    if (endpoint) {
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        throw new CliError("--endpoint must be an absolute http(s) URL");
      }
      if (!["http:", "https:"].includes(url.protocol))
        throw new CliError("--endpoint must be an absolute http(s) URL");
    }
    const config = enableTelemetry(endpoint);
    ctx.out(`Anonymous telemetry enabled (${telemetryConfigPath()}).`);
    if (!config.endpoint && !process.env.SINTER_TELEMETRY_ENDPOINT)
      ctx.out("No collector endpoint is configured yet, so no events will be sent.");
    ctx.out("Run `sinter telemetry disable` at any time.");
    await trackTelemetry("first_run", ctx.version ?? "development");
    return EXIT.OK;
  }
  if (action === "disable") {
    disableTelemetry();
    ctx.out("Anonymous telemetry disabled.");
    return EXIT.OK;
  }
  const config = readTelemetryConfig();
  ctx.out(`telemetry: ${config.enabled ? "enabled" : "disabled"}`);
  ctx.out(`collector: ${process.env.SINTER_TELEMETRY_ENDPOINT ?? config.endpoint ?? "not configured"}`);
  ctx.out(`config: ${telemetryConfigPath()}`);
  return EXIT.OK;
}

export async function cmdGui(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["port"], booleans: ["no-open"] });
  const rawPort = flagString(args, "port");
  const port = rawPort === undefined ? 0 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError(`bad --port: ${rawPort}`);
  const { browserCommand } = await import("./feedback");
  const { startGuiServer } = await import("./gui");
  const launched = startGuiServer(ctx, {
    port,
    onAction: async (action) => {
      const out: string[] = [];
      const err: string[] = [];
      const actionCtx: Ctx = { ...ctx, out: (line) => out.push(line), err: (line) => err.push(line) };
      const id = `${action.harness}:${action.nativeId}`;
      try {
        const code =
          action.action === "port"
            ? await cmdPort([id, "--to", String(action.target), "--mode", action.mode ?? "full"], actionCtx)
            : await cmdResume([id], actionCtx);
        return { code, out: out.join("\n"), err: err.join("\n") };
      } catch (error) {
        return { code: EXIT.ERROR, out: out.join("\n"), err: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  ctx.out(`Sinter GUI: ${launched.url}`);
  ctx.out("Local-only server; press Ctrl-C to stop.");
  if (!flagBool(args, "no-open") && ctx.exec) {
    try {
      await ctx.exec(browserCommand(launched.url));
    } catch {
      ctx.err("Could not open a browser automatically; use the URL above.");
    }
  }
  await new Promise<void>((resolve) => {
    const stop = () => {
      launched.server.stop(true);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return EXIT.OK;
}

export async function cmdCompletion(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {});
  const shell = args._[0];
  if (args._.length !== 1 || !["zsh", "bash", "fish"].includes(shell ?? ""))
    throw new CliError("usage: sinter completion <zsh|bash|fish>");
  const { completionScript } = await import("./completion");
  ctx.out(completionScript(shell as "zsh" | "bash" | "fish").trimEnd());
  return EXIT.OK;
}
