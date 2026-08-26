import { createInterface } from "node:readline/promises";
import { networkInterfaces } from "node:os";
import type {
  InstanceId,
  HarnessAdapter,
  HarnessId,
  NativeRef,
  SessionRef,
  SessionSummary,
  SifEntry,
  SifSession,
} from "@sinter/core";
import { DEFAULT_INSTANCE_ID, provenanceOf, validateSession } from "@sinter/core";
import type { Ledger, LedgerRow, LineageRow, ListOpts } from "@sinter/ledger";
import {
  CliError,
  EXIT,
  flagBool,
  flagString,
  parseArgs,
  parseHarness,
  parseHarnessTarget,
  parseSince,
  type ParsedArgs,
} from "./args";
import type { AdapterBinding, AdapterRegistry } from "./adapters";
import { adapterCapabilities, CAPABILITIES_SCHEMA } from "./capabilities";
import { compareSessions, CONTENT_TYPES, ENTRY_KINDS } from "./compare";
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
import { transcriptRecords } from "./ndjson";
import { PROJECTS_SCHEMA, projectSummaries } from "./projects";
import { renderSupportReport, supportPlatform, type SupportHarnessStatus } from "./support-report";
import { applyTransfer, fmtBytes, TRANSFER_MODES, type TransferMode } from "./transfer";
import { sendTransfer, startTransferReceiver, type ReceivedTransfer } from "./network";
import { createCloudAuthService, type CloudAuthService } from "./cloud-auth";
import { createCloudDeviceService, type CloudDeviceService } from "./cloud-devices";
import type { UpdateDependencies } from "./update";

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
  /** Terminal capabilities and delay are injectable so long-running commands stay testable. */
  interactive?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Cloud auth is injectable so command tests never open browsers or touch OS credentials. */
  cloudAuth?: CloudAuthService;
  /** Device identity/API operations are separately injectable and never touch the session ledger. */
  cloudDevices?: CloudDeviceService;
  /** Registry, process, and installation-layout seams for the explicit update command. */
  update?: UpdateDependencies;
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
    const metadata = [r.tags?.map((tag) => `#${tag}`).join(" "), r.note ? "✎" : ""].filter(Boolean).join(" ");
    return [
      r.ghost ? p.dim(displayId(r.nativeId)) : p.bold(displayId(r.nativeId)),
      p.cyan(instanceLabel(r.harness, r.instanceId)),
      p.dim(humanAge(r.updatedAt ?? r.createdAt, ctx.now)),
      p.dim(shortenPath(r.cwd, 28)),
      formatCount(r.messageCount),
      (r.pinnedAt ? p.yellow("★ ") : "") +
        (r.isSubagent ? p.blue("↳ ") : "") +
        (r.ghost ? p.dim("†") : "") +
        truncate(`${label}${metadata ? `  ${metadata}` : ""}`, 400),
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
    ...(ref.instanceId ? { instanceId: ref.instanceId } : {}),
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
        `  ${truncate(c.nativeId, idWidth).padEnd(idWidth)}  ${instanceLabel(c.harness, c.instanceId)}  ${truncate(
          c.title ?? c.firstPrompt ?? "",
          Math.max(20, ctx.width - idWidth - 16),
        )}`,
    );
  throw new CliError(
    `ambiguous id "${prefix}" — ${candidates.length} matches:\n${lines.join("\n")}` +
      (candidates.length > 10 ? `\n  …and ${candidates.length - 10} more` : "") +
      `\nnarrow it with a longer prefix or harness:id (or harness@instance:id)`,
    EXIT.AMBIGUOUS,
  );
}

function quoteArgv(argv: string[]): string {
  return argv.map((a) => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(" ");
}

function instanceLabel(harness: HarnessId, instanceId?: InstanceId): string {
  return instanceId && instanceId !== DEFAULT_INSTANCE_ID ? `${harness}@${instanceId}` : harness;
}

async function bindingForRow(ctx: Ctx, row: LedgerRow): Promise<AdapterBinding> {
  return ctx.registry.getBinding(row.harness, row.instanceId ?? DEFAULT_INSTANCE_ID);
}

async function resolveTargetBinding(ctx: Ctx, value: string): Promise<AdapterBinding> {
  const target = parseHarnessTarget(value);
  if (target.instanceId) return ctx.registry.getBinding(target.harness, target.instanceId);
  const matches = (await ctx.registry.bindings()).filter((binding) => binding.harness === target.harness);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw new CliError(
      `multiple ${target.harness} instances are selected (${matches.map((binding) => binding.instanceId).join(", ")}); use --to ${target.harness}@<instance>`,
    );
  throw new CliError(`adapter not available: ${target.harness} (not selected or not installed)`);
}

function printResume(ctx: Ctx, binding: AdapterBinding, ref: SessionRef): string {
  let argv: string[];
  try {
    argv = binding.resumeCommand(ref);
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
  const binding = await bindingForRow(ctx, row);
  const ref: SessionRef = {
    harness: row.harness,
    instanceId: row.instanceId ?? DEFAULT_INSTANCE_ID,
    nativeId: row.nativeId,
    nativePath: row.nativePath,
  };
  const session = await binding.adapter.read(ref);
  return {
    ...session,
    origin: { ...session.origin, instanceId: row.instanceId ?? DEFAULT_INSTANCE_ID },
  };
}

/**
 * Porting should start from the best carry-forward view when a session was
 * previously imported by sinter. `read()` must stay native for show/export/relink,
 * but an onward port wants the original entries, not a second flattening of the
 * receiving harness's inert transcript.
 */
async function readSessionForPort(ctx: Ctx, row: LedgerRow): Promise<SifSession> {
  const { adapter } = await bindingForRow(ctx, row);
  const ref: SessionRef = {
    harness: row.harness,
    instanceId: row.instanceId ?? DEFAULT_INSTANCE_ID,
    nativeId: row.nativeId,
    nativePath: row.nativePath,
  };
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
  if (args._.length > 1 || !["show", "path", "validate", "example"].includes(action))
    throw new CliError("usage: sinter config [show|path|validate|example] [--config file] [--json]");
  const configPath = flagString(args, "config") ?? defaultConfigPath();
  if (action === "path") {
    if (flagBool(args, "json")) ctx.out(JSON.stringify({ configPath }, null, 2));
    else ctx.out(configPath);
    return EXIT.OK;
  }
  if (action === "example") {
    if (flagBool(args, "json")) ctx.out(JSON.stringify({ configPath, example: PROFILE_EXAMPLE }, null, 2));
    else ctx.out(PROFILE_EXAMPLE.trimEnd());
    return EXIT.OK;
  }

  const summary = inspectConfig(configPath);
  if (action === "validate") {
    const stores = summary.profiles.reduce(
      (total, profile) => total + Object.keys(profile.stores).length + (profile.instances?.length ?? 0),
      0,
    );
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
  const rows = summary.profiles.flatMap((profile) => [
    ...Object.entries(profile.stores).map(([harness, path]) => [profile.name, harness, path ?? ""]),
    ...(profile.instances ?? []).map((instance) => [
      profile.name,
      `${instance.harness}@${instance.id}`,
      instance.store,
    ]),
  ]);
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

const WATCH_SCHEMA = "sinter.watch.v1";

function watchInterval(value: string | undefined): number {
  const input = value ?? "2s";
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)$/i.exec(input.trim());
  if (!match) throw new CliError(`bad --interval: ${input} (try 2s, 500ms, or 1m)`);
  const unit = match[2]!.toLowerCase();
  const ms = Number(match[1]) * (unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1);
  if (!Number.isFinite(ms) || ms < 250 || ms > 3_600_000)
    throw new CliError("--interval must be between 250ms and 1h");
  return Math.floor(ms);
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new CliError(`bad --${name}: ${value}`);
  return number;
}

function renderProjects(projects: ReturnType<typeof projectSummaries>, ctx: Ctx): string {
  return renderTable(
    [
      { header: "AGE", max: 5, align: "right" },
      { header: "SESS", max: 5, align: "right" },
      { header: "MSG", max: 7, align: "right" },
      { header: "HARNESSES", max: 24 },
      { header: "PROJECT", flex: true },
    ],
    projects.map((project) => [
      ctx.pal.dim(humanAge(project.latestAt, ctx.now)),
      String(project.sessionCount),
      project.messageCountSessions ? String(project.messageCount) : "-",
      project.harnesses.join(","),
      shortenPath(project.cwd, 400),
    ]),
    { width: ctx.width, pal: ctx.pal },
  );
}

/** Continuously rescan and render a bounded recent-session or project view. */
export async function cmdWatch(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["harness", "cwd", "since", "limit", "interval", "count"],
    booleans: ["json", "no-clear"],
    alias: { n: "limit" },
  });
  const view = args._[0] ?? "recent";
  if (args._.length > 1 || (view !== "recent" && view !== "projects"))
    throw new CliError("usage: sinter watch [recent|projects] [--interval 2s] [--count n] [--harness x] [--cwd .] [--since 7d] [--limit n] [--json] [--no-clear]");

  const intervalMs = watchInterval(flagString(args, "interval"));
  const requestedCount = positiveInteger(flagString(args, "count"), "count");
  const cycles = requestedCount ?? (ctx.interactive ? Number.POSITIVE_INFINITY : 1);
  const limit = positiveInteger(flagString(args, "limit"), "limit") ?? (view === "recent" ? 10 : 30);
  const opts = filterOpts(args, ctx.now);
  opts.includeGhost = false;
  opts.includeSubagents = false;
  if (view === "recent") opts.limit = limit;
  else delete opts.limit;

  const noScan = flagBool(args, "no-scan") || process.env.SINTER_NO_SCAN === "1";
  const onlyHarnesses = opts.harness;
  const loads = noScan ? [] : await ctx.registry.load();
  const adapters = loads
    .filter((load) => load.adapter && (!onlyHarnesses || onlyHarnesses.includes(load.id as HarnessId)))
    .map((load) => load.adapter!);
  if (!noScan && !adapters.length) throw new CliError("no adapters available — nothing to watch");

  let previous = "";
  for (let sequence = 1; sequence <= cycles; sequence++) {
    const scan = noScan ? undefined : await ctx.ledger().scan(adapters);
    const rows = ctx.ledger().list(opts);
    // A scan refreshes `scannedAt` even when the native session is unchanged;
    // omit that bookkeeping field from snapshots and change detection.
    const visibleRows = rows.map(({ scannedAt: _scannedAt, ...row }) => row);
    const data = view === "recent" ? visibleRows : projectSummaries(rows).slice(0, limit);
    const fingerprint = JSON.stringify(data);
    const changed = sequence === 1 || fingerprint !== previous;
    previous = fingerprint;

    if (flagBool(args, "json")) {
      ctx.out(JSON.stringify({
        schema: WATCH_SCHEMA,
        sequence,
        view,
        changed,
        scan: scan
          ? { ok: scan.errors.length === 0, harnesses: scan.harnesses, errors: scan.errors.map((error) => ({ harness: error.harness, message: error.error })) }
          : { skipped: true },
        ...(view === "recent" ? { sessions: data } : { projects: data }),
      }));
    } else {
      const heading = `watch ${view} · refresh ${intervalMs}ms · cycle ${sequence}${Number.isFinite(cycles) ? `/${cycles}` : ""}`;
      const body = data.length
        ? view === "recent"
          ? rowsTable(data as LedgerRow[], ctx)
          : renderProjects(data as ReturnType<typeof projectSummaries>, ctx)
        : `no ${view === "recent" ? "recent sessions" : "projects"} matched`;
      const frame = `${ctx.pal.dim(heading)}\n${body}`;
      if (ctx.interactive && !flagBool(args, "no-clear") && sequence > 1) ctx.out(`\x1b[2J\x1b[H${frame}`);
      else ctx.out(frame);
      if (scan) for (const error of scan.errors) ctx.err(ctx.pal.dim(`(scan warning [${error.harness}]: ${error.error})`));
    }

    if (sequence < cycles) await (ctx.sleep ?? Bun.sleep)(intervalMs);
  }
  return EXIT.OK;
}

export async function cmdPin(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv);
  if (args._.length !== 1) throw new CliError("usage: sinter pin <id-prefix>");
  const row = resolveRow(ctx, args._[0]!);
  ctx.ledger().setPinned(row.harness, row.nativeId, true, new Date(ctx.now).toISOString(), row.instanceId ?? DEFAULT_INSTANCE_ID);
  ctx.out(`pinned ${row.harness}:${displayId(row.nativeId)}`);
  return EXIT.OK;
}

export async function cmdUnpin(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv);
  if (args._.length !== 1) throw new CliError("usage: sinter unpin <id-prefix>");
  const row = resolveRow(ctx, args._[0]!);
  ctx.ledger().setPinned(row.harness, row.nativeId, false, new Date(ctx.now).toISOString(), row.instanceId ?? DEFAULT_INSTANCE_ID);
  ctx.out(`unpinned ${row.harness}:${displayId(row.nativeId)}`);
  return EXIT.OK;
}

const TAG_NAME = /^[a-z0-9][a-z0-9._/-]{0,31}$/;

function normalizedTags(values: string[]): string[] {
  const tags = [...new Set(values.map((value) => value.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))];
  if (!tags.length) throw new CliError("at least one non-empty tag is required");
  const invalid = tags.find((tag) => !TAG_NAME.test(tag));
  if (invalid)
    throw new CliError(`bad tag: ${invalid} (use 1-32 letters, numbers, dots, dashes, underscores, or slashes)`);
  return tags;
}

export async function cmdTag(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv);
  if (args._.length < 2) throw new CliError("usage: sinter tag <id-prefix> <tag...>");
  const row = resolveRow(ctx, args._[0]!);
  const tags = normalizedTags(args._.slice(1));
  ctx.ledger().addTags(row.harness, row.nativeId, tags, row.instanceId ?? DEFAULT_INSTANCE_ID);
  ctx.out(`tagged ${row.harness}:${displayId(row.nativeId)} ${tags.map((tag) => `#${tag}`).join(" ")}`);
  return EXIT.OK;
}

export async function cmdUntag(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { booleans: ["all"] });
  if (!args._[0] || (!flagBool(args, "all") && args._.length < 2) || (flagBool(args, "all") && args._.length !== 1))
    throw new CliError("usage: sinter untag <id-prefix> <tag...>|--all");
  const row = resolveRow(ctx, args._[0]);
  const tags = flagBool(args, "all") ? undefined : normalizedTags(args._.slice(1));
  ctx.ledger().removeTags(row.harness, row.nativeId, tags, row.instanceId ?? DEFAULT_INSTANCE_ID);
  ctx.out(tags ? `removed ${tags.map((tag) => `#${tag}`).join(" ")} from ${row.harness}:${displayId(row.nativeId)}` : `cleared tags for ${row.harness}:${displayId(row.nativeId)}`);
  return EXIT.OK;
}

export async function cmdNote(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { booleans: ["clear"] });
  if (!args._[0]) throw new CliError("usage: sinter note <id-prefix> <text>|--clear");
  const text = args._.slice(1).join(" ").trim();
  if (flagBool(args, "clear") && text) throw new CliError("--clear cannot be combined with note text");
  if (!flagBool(args, "clear") && !text) throw new CliError("sinter note needs text (or --clear)");
  if (text.length > 4000) throw new CliError("note is too long (maximum 4000 characters)");
  const row = resolveRow(ctx, args._[0]);
  ctx.ledger().setNote(row.harness, row.nativeId, text || undefined, new Date(ctx.now).toISOString(), row.instanceId ?? DEFAULT_INSTANCE_ID);
  ctx.out(text ? `noted ${row.harness}:${displayId(row.nativeId)}` : `cleared note for ${row.harness}:${displayId(row.nativeId)}`);
  return EXIT.OK;
}

export async function cmdTags(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { booleans: ["json"] });
  if (args._.length) throw new CliError("usage: sinter tags [--json]");
  const tags = ctx.ledger().tagCounts();
  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify({ schema: "sinter.tags.v1", tags }, null, 2));
  } else if (!tags.length) {
    ctx.out("no local session tags");
  } else {
    ctx.out(renderTable(
      [{ header: "TAG", flex: true }, { header: "SESSIONS", align: "right" }],
      tags.map((tag) => [`#${tag.tag}`, String(tag.sessions)]),
      { width: ctx.width, pal: ctx.pal },
    ));
  }
  return EXIT.OK;
}

/** List Sinter-local bookmarks; pins survive rescans and native-session GC. */
export async function cmdPinned(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["harness", "cwd", "since", "limit"],
    booleans: ["json", "no-ghost", "no-sub"],
    alias: { n: "limit" },
  });
  const opts = filterOpts(args, ctx.now);
  opts.pinnedOnly = true;
  opts.limit ??= 30;
  const rows = ctx.ledger().list(opts);
  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify({ schema: "sinter.pinned.v1", sessions: rows }, null, 2));
    return EXIT.OK;
  }
  if (!rows.length) {
    ctx.err("no pinned sessions");
    return EXIT.OK;
  }
  ctx.out(rowsTable(rows, ctx));
  return EXIT.OK;
}

const GHOSTS_SCHEMA = "sinter.ghosts.v1";

/** Preview or explicitly prune disposable, locally cached ghost rows. */
export async function cmdGhosts(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["harness", "older-than"],
    booleans: ["json", "yes"],
  });
  const action = args._[0] ?? "preview";
  if (args._.length > 1 || !["preview", "prune"].includes(action))
    throw new CliError("usage: sinter ghosts [preview|prune] [--older-than 30d] [--harness x] [--json] [--yes]");

  const olderThan = flagString(args, "older-than") ?? "30d";
  let cutoff: string;
  try {
    cutoff = parseSince(olderThan, ctx.now);
  } catch {
    throw new CliError(`bad --older-than value: ${olderThan} (try 30d, 12w, or 2026-07-01)`);
  }
  const harnessFlag = flagString(args, "harness");
  const harness = harnessFlag ? parseHarness(harnessFlag) : undefined;
  const opts = { ...(harness ? { harness } : {}), before: cutoff };
  const rows = ctx.ledger().ghosts(opts);
  const record = (row: LedgerRow) => {
    const protectedBy = [
      row.alias ? "alias" : undefined,
      row.pinnedAt ? "pin" : undefined,
      row.note ? "note" : undefined,
      row.tags?.length ? "tag" : undefined,
    ].filter(
      (value): value is string => !!value,
    );
    return {
      harness: row.harness,
      nativeId: row.nativeId,
      lastObservedAt: row.scannedAt ?? row.updatedAt ?? row.createdAt,
      protectedBy,
      prunable: protectedBy.length === 0,
    };
  };
  const records = rows.map(record);
  const eligible = records.filter((item) => item.prunable).length;
  const protectedCount = records.length - eligible;

  let removed = 0;
  if (action === "prune" && eligible > 0) {
    if (!flagBool(args, "yes"))
      throw new CliError(`refusing to remove ${eligible} ghost row${eligible === 1 ? "" : "s"} without --yes; preview with \`sinter ghosts\` first`);
    removed = ctx.ledger().pruneGhosts(opts).length;
  }

  if (flagBool(args, "json")) {
    ctx.out(
      JSON.stringify(
        {
          schema: GHOSTS_SCHEMA,
          action,
          olderThan,
          cutoff,
          eligible,
          protected: protectedCount,
          removed,
          ghosts: records,
        },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }

  if (records.length) {
    ctx.out(
      renderTable(
        [
          { header: "ID", max: 14 },
          { header: "HARNESS" },
          { header: "LAST SEEN", align: "right" },
          { header: "STATUS", flex: true },
        ],
        rows.map((row, index) => [
          displayId(row.nativeId),
          ctx.pal.cyan(row.harness),
          humanAge(records[index]!.lastObservedAt, ctx.now),
          records[index]!.prunable ? "prunable" : `protected by ${records[index]!.protectedBy.join(" + ")}`,
        ]),
        { width: ctx.width, pal: ctx.pal },
      ),
    );
  }

  if (action === "prune") {
    ctx.out(`removed ${removed} disposable ghost row${removed === 1 ? "" : "s"}; ${protectedCount} protected`);
    ctx.out(ctx.pal.dim("native stores, local metadata, and lineage were not modified"));
  } else if (!records.length) {
    ctx.out(`no ghost rows older than ${olderThan}`);
  } else {
    ctx.out("");
    ctx.out(`${eligible} prunable; ${protectedCount} protected by local metadata`);
    ctx.out(ctx.pal.dim(`preview only — apply with: sinter ghosts prune --older-than ${olderThan}${harness ? ` --harness ${harness}` : ""} --yes`));
  }
  return EXIT.OK;
}

const VIEW_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

function requireViewName(name: string | undefined): string {
  if (!name || !VIEW_NAME.test(name))
    throw new CliError("view name must be 1-40 letters, numbers, dots, dashes, or underscores");
  return name;
}

function viewLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) throw new CliError(`bad --limit: ${value}`);
  return Math.floor(limit);
}

/** Manage reusable, Sinter-local list filters. */
export async function cmdView(argv: string[], ctx: Ctx): Promise<number> {
  const hasAction = !!argv[0] && !argv[0]!.startsWith("-");
  const action = hasAction ? argv[0]! : "list";
  const rest = hasAction ? argv.slice(1) : argv;
  const ledger = ctx.ledger();

  if (action === "list") {
    const args = parseArgs(rest, { booleans: ["json"] });
    if (args._.length) throw new CliError("usage: sinter view list [--json]");
    const views = ledger.listViews();
    if (flagBool(args, "json")) {
      ctx.out(JSON.stringify({ schema: "sinter.views.v1", views }, null, 2));
      return EXIT.OK;
    }
    if (!views.length) {
      ctx.out("no saved views");
      return EXIT.OK;
    }
    ctx.out(
      renderTable(
        [
          { header: "NAME" },
          { header: "HARNESSES" },
          { header: "CWD", max: 28 },
          { header: "SINCE" },
          { header: "LIMIT", align: "right" },
          { header: "INCLUDES", flex: true },
        ],
        views.map((view) => [
          view.name,
          view.harnesses?.join(",") ?? "all",
          shortenPath(view.cwd, 28),
          view.since ?? "all",
          view.limit ? String(view.limit) : "-",
          [view.includeGhost ? "ghosts" : "", view.includeSubagents ? "subagents" : ""].filter(Boolean).join(",") || "-",
        ]),
        { width: ctx.width, pal: ctx.pal },
      ),
    );
    return EXIT.OK;
  }

  if (action === "save") {
    const args = parseArgs(rest, {
      strings: ["harness", "cwd", "since", "limit"],
      booleans: ["ghosts", "subagents", "force", "json"],
    });
    if (args._.length !== 1)
      throw new CliError("usage: sinter view save <name> [--harness x] [--cwd .] [--since 7d] [--limit n] [--ghosts] [--subagents] [--force]");
    const name = requireViewName(args._[0]);
    if (ledger.getView(name) && !flagBool(args, "force"))
      throw new CliError(`saved view already exists: ${name} (use --force to replace it)`);
    const harnessFlag = flagString(args, "harness");
    const harnesses = harnessFlag
      ? harnessFlag.split(",").map((id) => parseHarness(id)) as HarnessId[]
      : undefined;
    const cwdFlag = flagString(args, "cwd");
    const cwd = cwdFlag === "." ? process.cwd() : cwdFlag?.replace(/\/$/, "");
    const since = flagString(args, "since");
    if (since) parseSince(since, ctx.now);
    const limit = viewLimit(flagString(args, "limit"));
    const saved = ledger.saveView({
      name,
      ...(harnesses?.length ? { harnesses } : {}),
      ...(cwd ? { cwd } : {}),
      ...(since ? { since } : {}),
      ...(limit ? { limit } : {}),
      includeGhost: flagBool(args, "ghosts"),
      includeSubagents: flagBool(args, "subagents"),
    }, new Date(ctx.now).toISOString());
    if (flagBool(args, "json")) ctx.out(JSON.stringify({ schema: "sinter.view.v1", view: saved }, null, 2));
    else ctx.out(`saved view ${saved.name}`);
    return EXIT.OK;
  }

  if (action === "show") {
    const args = parseArgs(rest, { booleans: ["json"] });
    if (args._.length !== 1) throw new CliError("usage: sinter view show <name> [--json]");
    const name = requireViewName(args._[0]);
    const view = ledger.getView(name);
    if (!view) throw new CliError(`saved view not found: ${name}`);
    if (flagBool(args, "json")) {
      ctx.out(JSON.stringify({ schema: "sinter.view.v1", view }, null, 2));
    } else {
      ctx.out(`view ${view.name}`);
      ctx.out(`  harnesses: ${view.harnesses?.join(",") ?? "all"}`);
      ctx.out(`  cwd: ${view.cwd ?? "all"}`);
      ctx.out(`  since: ${view.since ?? "all"}`);
      ctx.out(`  limit: ${view.limit ?? "default (30)"}`);
      ctx.out(`  ghosts: ${view.includeGhost ? "include" : "hide"}`);
      ctx.out(`  subagents: ${view.includeSubagents ? "include" : "hide"}`);
    }
    return EXIT.OK;
  }

  if (action === "delete") {
    const args = parseArgs(rest);
    if (args._.length !== 1) throw new CliError("usage: sinter view delete <name>");
    const name = requireViewName(args._[0]);
    if (!ledger.deleteView(name)) throw new CliError(`saved view not found: ${name}`);
    ctx.out(`deleted view ${name}`);
    return EXIT.OK;
  }

  if (action === "run") {
    const args = parseArgs(rest, {
      strings: ["harness", "cwd", "since", "limit"],
      booleans: ["json", "ghosts", "no-ghosts", "subagents", "no-subagents", "all-harnesses", "all-cwd", "all-time"],
    });
    if (args._.length !== 1)
      throw new CliError("usage: sinter view run <name> [--harness x|--all-harnesses] [--cwd .|--all-cwd] [--since 7d|--all-time] [--limit n] [--ghosts|--no-ghosts] [--subagents|--no-subagents] [--json]");
    if (flagBool(args, "ghosts") && flagBool(args, "no-ghosts"))
      throw new CliError("choose one: --ghosts or --no-ghosts");
    if (flagBool(args, "subagents") && flagBool(args, "no-subagents"))
      throw new CliError("choose one: --subagents or --no-subagents");
    if (flagBool(args, "all-harnesses") && flagString(args, "harness"))
      throw new CliError("choose one: --harness or --all-harnesses");
    if (flagBool(args, "all-cwd") && flagString(args, "cwd"))
      throw new CliError("choose one: --cwd or --all-cwd");
    if (flagBool(args, "all-time") && flagString(args, "since"))
      throw new CliError("choose one: --since or --all-time");
    const name = requireViewName(args._[0]);
    const view = ledger.getView(name);
    if (!view) throw new CliError(`saved view not found: ${name}`);

    const harnessFlag = flagString(args, "harness");
    const cwdFlag = flagString(args, "cwd");
    const sinceFlag = flagString(args, "since");
    const limitFlag = viewLimit(flagString(args, "limit"));
    const sinceWindow = flagBool(args, "all-time") ? undefined : sinceFlag ?? view.since;
    const opts: ListOpts = {
      ...(!flagBool(args, "all-harnesses") && harnessFlag
        ? { harness: harnessFlag.split(",").map((id) => parseHarness(id)) as HarnessId[] }
        : !flagBool(args, "all-harnesses") && view.harnesses ? { harness: view.harnesses } : {}),
      ...(!flagBool(args, "all-cwd") && (cwdFlag ?? view.cwd)
        ? { cwd: cwdFlag === "." ? process.cwd() : (cwdFlag ?? view.cwd)!.replace(/\/$/, "") }
        : {}),
      ...(sinceWindow ? { since: parseSince(sinceWindow, ctx.now) } : {}),
      limit: limitFlag ?? view.limit ?? 30,
      includeGhost: flagBool(args, "ghosts") ? true : flagBool(args, "no-ghosts") ? false : view.includeGhost,
      includeSubagents: flagBool(args, "subagents") ? true : flagBool(args, "no-subagents") ? false : view.includeSubagents,
    };
    const sessions = ledger.list(opts);
    if (flagBool(args, "json")) {
      ctx.out(JSON.stringify({ schema: "sinter.view.v1", view, effective: opts, sessions }, null, 2));
    } else if (!sessions.length) {
      ctx.err(`no sessions matched view ${view.name}`);
    } else {
      ctx.out(ctx.pal.dim(`view ${view.name} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`));
      ctx.out(rowsTable(sessions, ctx));
    }
    return EXIT.OK;
  }

  throw new CliError(`unknown view action: ${action} (known: save, list, show, run, delete)`);
}

interface ThreadHopView {
  hop: number;
  harness: HarnessId;
  instanceId?: InstanceId;
  nativeId: string;
  parentHarness?: HarnessId;
  parentNativeId?: string;
  mode?: string;
  portedAt?: string;
  selected: boolean;
  present: boolean;
  ghost?: boolean;
  resumable: boolean;
  alias?: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
}

function threadHop(link: LineageRow, selected: LedgerRow, ledger: Ledger): ThreadHopView {
  const row = ledger.get(link.harness, link.nativeId, link.instanceId ?? DEFAULT_INSTANCE_ID);
  return {
    hop: link.hop,
    harness: link.harness,
    ...(link.instanceId && link.instanceId !== DEFAULT_INSTANCE_ID ? { instanceId: link.instanceId } : {}),
    nativeId: link.nativeId,
    parentHarness: link.parentHarness,
    parentNativeId: link.parentNativeId,
    mode: link.mode,
    portedAt: link.portedAt,
    selected:
      link.harness === selected.harness &&
      (link.instanceId ?? DEFAULT_INSTANCE_ID) === (selected.instanceId ?? DEFAULT_INSTANCE_ID) &&
      link.nativeId === selected.nativeId,
    present: !!row,
    ghost: row?.ghost || undefined,
    resumable: !!row && !row.ghost && !row.isSubagent,
    alias: row?.alias,
    title: row?.title ?? row?.firstPrompt,
    cwd: row?.cwd,
    updatedAt: row?.updatedAt ?? row?.createdAt,
  };
}

/** Inspect the cached port lineage without reading transcript bodies or native stores. */
export async function cmdThread(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { booleans: ["json"] });
  if (args._.length !== 1) throw new CliError("usage: sinter thread <id-prefix> [--json]");
  const selected = resolveRow(ctx, args._[0]!);
  const ledger = ctx.ledger();
  const cachedThreadId = ledger.threadIdOf(selected.harness, selected.nativeId, selected.instanceId ?? DEFAULT_INSTANCE_ID);
  const links: LineageRow[] = cachedThreadId
    ? ledger.lineageFor(cachedThreadId)
    : [{ harness: selected.harness, instanceId: selected.instanceId ?? DEFAULT_INSTANCE_ID, nativeId: selected.nativeId, threadId: `${instanceLabel(selected.harness, selected.instanceId)}:${selected.nativeId}`, hop: 0 }];
  const hops = links.map((link) => threadHop(link, selected, ledger));
  const tip = [...hops].reverse().find((hop) => hop.resumable);
  const threadId = cachedThreadId ?? `${instanceLabel(selected.harness, selected.instanceId)}:${selected.nativeId}`;
  const result = {
    schema: "sinter.thread.v1",
    threadId,
    lineageCached: !!cachedThreadId,
    ported: links.length > 1,
    selected: {
      harness: selected.harness,
      ...(selected.instanceId && selected.instanceId !== DEFAULT_INSTANCE_ID ? { instanceId: selected.instanceId } : {}),
      nativeId: selected.nativeId,
    },
    hops,
    resumableTip: tip
      ? {
          hop: tip.hop,
          harness: tip.harness,
          ...(tip.instanceId && tip.instanceId !== DEFAULT_INSTANCE_ID ? { instanceId: tip.instanceId } : {}),
          nativeId: tip.nativeId,
          command: ["sinter", "resume", `${instanceLabel(tip.harness, tip.instanceId)}:${tip.nativeId}`],
        }
      : null,
  };

  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.OK;
  }

  ctx.out(`Thread ${threadId}${cachedThreadId ? "" : " (no cached port lineage)"}`);
  ctx.out(
    renderTable(
      [
        { header: "HOP", max: 3, align: "right" },
        { header: "SESSION", max: 24 },
        { header: "MODE", max: 9 },
        { header: "AGE", max: 5, align: "right" },
        { header: "STATE", max: 14 },
        { header: "TITLE", flex: true },
      ],
      hops.map((hop) => [
        String(hop.hop),
        `${hop.selected ? "→ " : "  "}${instanceLabel(hop.harness, hop.instanceId)}:${displayId(hop.nativeId)}`,
        hop.hop === 0 ? "origin" : (hop.mode ?? "unknown"),
        humanAge(hop.updatedAt ?? hop.portedAt, ctx.now),
        !hop.present ? "metadata only" : hop.ghost ? "ghost" : hop.resumable ? "resumable" : "sidechain",
        `${hop.alias ? `${hop.alias} · ` : ""}${hop.title ?? ""}`,
      ]),
      { width: ctx.width, pal: ctx.pal },
    ),
  );
  if (tip) {
    ctx.out("");
    ctx.out(`resumable tip: ${ctx.pal.bold(`${instanceLabel(tip.harness, tip.instanceId)}:${tip.nativeId}`)}`);
    ctx.out(ctx.pal.dim(`resume with: sinter resume ${instanceLabel(tip.harness, tip.instanceId)}:${tip.nativeId}`));
  } else {
    ctx.err("no resumable session remains in this thread");
  }
  if (!cachedThreadId) ctx.err(ctx.pal.dim("run `sinter relink` to rebuild lineage cached in native target sessions"));
  return EXIT.OK;
}

/** Summarize resumable work by directory without parsing any transcripts. */
export async function cmdProjects(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["harness", "since", "limit"],
    booleans: ["json"],
    alias: { n: "limit" },
  });
  const opts = filterOpts(args, ctx.now);
  const limit = opts.limit ?? 30;
  delete opts.limit;
  opts.includeGhost = false;
  opts.includeSubagents = false;
  const projects = projectSummaries(ctx.ledger().list(opts)).slice(0, limit);

  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify({ schema: PROJECTS_SCHEMA, projects }, null, 2));
    return EXIT.OK;
  }
  if (!projects.length) {
    ctx.err("no projects matched (run `sinter scan` first?)");
    return EXIT.OK;
  }
  ctx.out(renderProjects(projects, ctx));
  return EXIT.OK;
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
    ctx.out(`${instanceLabel(row.harness, row.instanceId)}:${row.nativeId}`);
    return EXIT.OK;
  }

  const binding = await bindingForRow(ctx, row);
  const ref: SessionRef = {
    harness: row.harness,
    instanceId: row.instanceId ?? DEFAULT_INSTANCE_ID,
    nativeId: row.nativeId,
    nativePath: row.nativePath,
  };
  if (flagBool(args, "exec")) {
    if (!ctx.exec) throw new CliError("--exec is not available in this context");
    const resumeArgv = binding.resumeCommand(ref);
    ctx.err(ctx.pal.dim(`exec: ${quoteArgv(resumeArgv)}`));
    return await ctx.exec(resumeArgv);
  }
  printResume(ctx, binding, ref);
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
  ctx.ledger().setAlias(row.harness, row.nativeId, alias || undefined, row.instanceId ?? DEFAULT_INSTANCE_ID);
  ctx.out(alias ? `${row.harness}:${displayId(row.nativeId)} → ${alias}` : `cleared alias for ${row.harness}:${displayId(row.nativeId)}`);
  return EXIT.OK;
}

export async function cmdShow(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { booleans: ["json", "ndjson", "no-sub"], strings: ["tool-chars", "tail"] });
  const prefix = args._[0];
  if (!prefix) throw new CliError("usage: sinter show <id-prefix>");
  if (flagBool(args, "json") && flagBool(args, "ndjson"))
    throw new CliError("choose one output mode: --json or --ndjson");
  const tailValue = flagString(args, "tail");
  let tailEntries: number | undefined;
  if (tailValue !== undefined) {
    tailEntries = Number(tailValue);
    if (!Number.isInteger(tailEntries) || tailEntries <= 0) throw new CliError(`bad --tail: ${tailValue}`);
    if (flagBool(args, "json") || flagBool(args, "ndjson"))
      throw new CliError("--tail is for rendered output and cannot be combined with --json or --ndjson");
  }
  const row = resolveRow(ctx, prefix);
  if (row.ghost) ctx.err(ctx.pal.dim(`note: ${shortId(row.nativeId)} is a ghost row — the harness may have GC'd it`));

  const session = await readSession(ctx, row);
  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify(session, null, 2));
    return EXIT.OK;
  }
  if (flagBool(args, "ndjson")) {
    for (const record of transcriptRecords(session, { subsessions: !flagBool(args, "no-sub") }))
      ctx.out(JSON.stringify(record));
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

/** Compare transcript shape without printing conversation content. */
export async function cmdCompare(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { booleans: ["json"] });
  if (args._.length !== 2) throw new CliError("usage: sinter compare <left-id> <right-id> [--json]");
  const leftRow = resolveRow(ctx, args._[0]!);
  const rightRow = resolveRow(ctx, args._[1]!);
  const comparison = compareSessions(await readSession(ctx, leftRow), await readSession(ctx, rightRow));

  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify(comparison, null, 2));
    return EXIT.OK;
  }

  const delta = (value: number) => (value > 0 ? `+${value}` : String(value));
  const metrics: Array<[string, number, number, number]> = [
    ["sessions", comparison.left.sessions, comparison.right.sessions, comparison.delta.sessions],
    ["entries", comparison.left.entries, comparison.right.entries, comparison.delta.entries],
    ...ENTRY_KINDS.map((kind) => [
      `entry:${kind}`,
      comparison.left.entryKinds[kind],
      comparison.right.entryKinds[kind],
      comparison.delta.entryKinds[kind],
    ] as [string, number, number, number]),
    ...CONTENT_TYPES.map((type) => [
      `part:${type}`,
      comparison.left.contentParts[type],
      comparison.right.contentParts[type],
      comparison.delta.contentParts[type],
    ] as [string, number, number, number]),
    ["entries:raw", comparison.left.entriesWithRaw, comparison.right.entriesWithRaw, comparison.delta.entriesWithRaw],
    [
      "sessions:preserve",
      comparison.left.sessionsWithPreserve,
      comparison.right.sessionsWithPreserve,
      comparison.delta.sessionsWithPreserve,
    ],
  ];
  ctx.out(`left:  ${leftRow.harness}:${shortId(leftRow.nativeId)}`);
  ctx.out(`right: ${rightRow.harness}:${shortId(rightRow.nativeId)}`);
  ctx.out(
    renderTable(
      [
        { header: "METRIC", flex: true },
        { header: "LEFT", max: 9, align: "right" },
        { header: "RIGHT", max: 9, align: "right" },
        { header: "DELTA", max: 9, align: "right" },
      ],
      metrics.map(([name, left, right, difference]) => [name, String(left), String(right), delta(difference)]),
      { width: ctx.width, pal: ctx.pal },
    ),
  );
  ctx.out(`models left:  ${comparison.left.models.join(", ") || "-"}`);
  ctx.out(`models right: ${comparison.right.models.join(", ") || "-"}`);
  ctx.err(ctx.pal.dim("structural inventory only; matching counts do not prove semantic equivalence"));
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
  binding: AdapterBinding,
  session: SifSession,
  args: ParsedArgs,
  mode?: string,
): Promise<number> {
  const { adapter } = binding;
  const target = instanceLabel(binding.harness, binding.instanceId);
  if (!adapter.write) throw new CliError(`${target} adapter cannot write sessions yet`);

  const cwd = flagString(args, "cwd");
  const dryRun = flagBool(args, "dry-run");
  const resolvedCwd = cwd === "." ? process.cwd() : cwd;
  const ref = await adapter.write(session, {
    instanceId: binding.instanceId,
    cwd: resolvedCwd,
    mode,
    liveTools: flagBool(args, "live-tools"),
    dryRun,
  });
  const instanceRef: NativeRef = { ...ref, instanceId: binding.instanceId };

  ctx.err(
    `${dryRun ? "would write" : "wrote"} ${target}:${instanceRef.nativeId}` +
      (ref.created?.length ? ` (${ref.created.length} file(s))` : ""),
  );
  for (const c of ref.created ?? []) ctx.err(ctx.pal.dim(`  ${c}`));

  // Cache the lineage link the writer stamped into the target store. A dry run
  // wrote nothing, so there is nothing to remember.
  if (!dryRun && instanceRef.provenance) {
    try {
      ctx.ledger().recordProvenance(instanceRef.provenance);
      ctx.err(
        ctx.pal.dim(
          `  thread ${shortId(instanceRef.provenance.threadId, 12)} · hop ${instanceRef.provenance.hop} of ${
            instanceRef.provenance.chain.length - 1
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
      ctx.ledger().upsert(summarize(instanceRef, session, resolvedCwd));
    } catch (err) {
      // Indexing is best-effort: the port succeeded and the target is usable.
      ctx.err(ctx.pal.dim(`  (ledger not updated: ${err instanceof Error ? err.message : String(err)})`));
    }
  }

  ctx.out(`${target}:${instanceRef.nativeId}`);
  printResume(ctx, binding, instanceRef);
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
  const target = await resolveTargetBinding(ctx, to);

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
  const target = await resolveTargetBinding(ctx, to);

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
    const adapter = target.adapter;
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
      source: { harness: row.harness, instanceId: row.instanceId ?? DEFAULT_INSTANCE_ID, nativeId: row.nativeId },
      target: { harness: target.harness, instanceId: target.instanceId, adapter: "write-capable", store },
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
      ["source", `${instanceLabel(row.harness, row.instanceId)}:${row.nativeId}`],
      ["target", `${instanceLabel(target.harness, target.instanceId)} (${store}, write-capable)`],
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
  ctx.err(`porting ${instanceLabel(row.harness, row.instanceId)}:${shortId(row.nativeId, 12)} → ${instanceLabel(target.harness, target.instanceId)}`);
  return writeInto(ctx, target, session, args, mode);
}

function networkSafeSession(session: SifSession): SifSession {
  const sanitize = (value: SifSession): SifSession => {
    const { preserve: _preserve, additionalDirs: _additionalDirs, ...rest } = value;
    return {
      ...rest,
      origin: {
        harness: value.origin.harness,
        ...(value.origin.instanceId ? { instanceId: value.origin.instanceId } : {}),
        nativeId: value.origin.nativeId,
        ...(value.origin.host ? { host: value.origin.host } : {}),
      },
      entries: value.entries.map(({ raw: _raw, ...entry }) => entry as SifEntry),
      ...(value.subsessions ? { subsessions: value.subsessions.map(sanitize) } : {}),
    };
  };
  return sanitize(session);
}

function transferTtl(value: string | undefined): number {
  const input = value ?? "5m";
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)$/i.exec(input.trim());
  if (!match) throw new CliError(`bad --ttl: ${input} (try 5m, 30s, or 1h)`);
  const unit = match[2]!.toLowerCase();
  const ms = Number(match[1]) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000);
  if (!Number.isFinite(ms) || ms < 10_000 || ms > 3_600_000)
    throw new CliError("--ttl must be between 10s and 1h");
  return Math.floor(ms);
}

function advertiseAddress(bindHost: string, explicit?: string): string {
  if (explicit) return explicit;
  if (bindHost !== "0.0.0.0" && bindHost !== "::") return bindHost;
  const addresses = Object.values(networkInterfaces()).flatMap((items) => items ?? []);
  const lan = addresses.find(
    (item) =>
      item.family === "IPv4" &&
      !item.internal &&
      (/^10\./.test(item.address) || /^192\.168\./.test(item.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(item.address)),
  );
  if (lan) return lan.address;
  throw new CliError("no private LAN address found; pass --advertise <LAN-or-Tailscale-IP>");
}

async function confirmReceive(ctx: Ctx, transfer: ReceivedTransfer, target: string): Promise<boolean> {
  const question = `Accept ${fmtBytes(transfer.bytes.byteLength)} into ${target}? [y/N]`;
  if (ctx.confirm) return ctx.confirm(question);
  if (!process.stdin.isTTY) throw new CliError("receive needs an interactive terminal; use --yes for unattended receipt");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${question} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

/** Send a context-only, encrypted one-shot session payload to a receiver locator. */
export async function cmdSend(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["to", "mode"], booleans: ["preview", "json"] });
  const prefix = args._[0];
  const locator = flagString(args, "to");
  if (!prefix || !locator) throw new CliError("usage: sinter send <id-prefix> --to <sinter://transfer/...> [--mode compact|slim|full]");
  const row = resolveRow(ctx, prefix);
  const source = await readSessionForPort(ctx, row);
  const mode = (flagString(args, "mode") ?? "compact") as TransferMode;
  if (!TRANSFER_MODES.includes(mode))
    throw new CliError(`unknown --mode: ${mode} (known: ${TRANSFER_MODES.join(", ")})`);
  const transferred = applyTransfer(source, mode);
  const session = networkSafeSession(transferred.session);
  validateSession(session);
  const bytes = new TextEncoder().encode(JSON.stringify(session));
  if (flagBool(args, "preview")) {
    const preview = {
      source: { harness: row.harness, instanceId: row.instanceId ?? DEFAULT_INSTANCE_ID, nativeId: row.nativeId },
      mode,
      entries: session.entries.length,
      bytes: bytes.byteLength,
      encrypted: true,
      sends: false,
    };
    if (flagBool(args, "json")) ctx.out(JSON.stringify(preview, null, 2));
    else ctx.out(`would send ${session.entries.length} entries (${fmtBytes(bytes.byteLength)}), encrypted; no connection made`);
    return EXIT.OK;
  }
  const receipt = await sendTransfer(locator, bytes, {
    metadata: {
      schema: "sinter.session.v1",
      mode,
      sourceHarness: row.harness,
      sourceInstance: row.instanceId ?? DEFAULT_INSTANCE_ID,
    },
  });
  if (flagBool(args, "json")) ctx.out(JSON.stringify({ ok: true, transferId: receipt.transferId, bytes: bytes.byteLength }));
  else ctx.out(`sent ${fmtBytes(bytes.byteLength)} · accepted as ${receipt.transferId}`);
  return EXIT.OK;
}

/** Receive one encrypted transfer and import it only into the selected instance. */
export async function cmdReceive(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, {
    strings: ["to", "bind", "advertise", "port", "ttl", "cwd"],
    booleans: ["yes", "json"],
  });
  const to = flagString(args, "to");
  if (!to) throw new CliError("usage: sinter receive --to <harness@instance> [--advertise <LAN-or-Tailscale-IP>] [--yes]");
  const binding = await resolveTargetBinding(ctx, to);
  if (!binding.adapter.write) throw new CliError(`${instanceLabel(binding.harness, binding.instanceId)} adapter cannot write sessions yet`);
  const bindHost = flagString(args, "bind") ?? "0.0.0.0";
  const advertised = advertiseAddress(bindHost, flagString(args, "advertise"));
  const portValue = flagString(args, "port");
  const port = portValue === undefined ? 0 : Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new CliError(`bad --port: ${portValue}`);
  const target = instanceLabel(binding.harness, binding.instanceId);
  const receiver = startTransferReceiver({
    bindHost,
    advertiseHost: advertised,
    port,
    ttlMs: transferTtl(flagString(args, "ttl")),
    async accept(transfer) {
      if (transfer.metadata.schema !== "sinter.session.v1") throw new CliError("unsupported transfer payload");
      let session: SifSession;
      try {
        session = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(transfer.bytes)) as SifSession;
      } catch {
        throw new CliError("received payload is not valid SIF JSON");
      }
      validateSession(session);
      if (!flagBool(args, "yes") && !(await confirmReceive(ctx, transfer, target)))
        throw new CliError("transfer declined");
      await writeInto(ctx, binding, networkSafeSession(session), args, `network-${transfer.metadata.mode ?? "compact"}`);
    },
  });
  ctx.out(receiver.locator);
  ctx.err(`listening on ${bindHost}:${receiver.port} for one encrypted transfer → ${target}`);
  try {
    const received = await receiver.received;
    if (flagBool(args, "json"))
      ctx.out(JSON.stringify({ ok: true, transferId: received.transferId, bytes: received.bytes.byteLength, target }));
    else ctx.err(`received and imported ${fmtBytes(received.bytes.byteLength)} · ${received.transferId}`);
    // `received` resolves when the authenticated Response is created. Give Bun
    // one event-loop turn to flush that receipt before closing the one-shot server.
    await (ctx.sleep ?? Bun.sleep)(50);
  } finally {
    receiver.close();
  }
  return EXIT.OK;
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
  const sourceBinding = await bindingForRow(ctx, row);
  const targetBinding = inFlag ? await resolveTargetBinding(ctx, inFlag) : sourceBinding;
  const sameInstance =
    targetBinding.harness === row.harness &&
    targetBinding.instanceId === (row.instanceId ?? DEFAULT_INSTANCE_ID);

  let ref: NativeRef | SessionRef;
  let binding: AdapterBinding;

  if (sameInstance) {
    if (row.ghost)
      throw new CliError(
        `${shortId(row.nativeId)} is a ghost row — the ${row.harness} transcript is gone, port it instead`,
        EXIT.AMBIGUOUS,
      );
    binding = sourceBinding;
    ref = {
      harness: row.harness,
      instanceId: row.instanceId ?? DEFAULT_INSTANCE_ID,
      nativeId: row.nativeId,
      nativePath: row.nativePath,
    };
  } else {
    const session = await readSessionForPort(ctx, row);
    validateSession(session);
    const targetAdapter = targetBinding.adapter;
    const target = instanceLabel(targetBinding.harness, targetBinding.instanceId);
    if (!targetAdapter.write) throw new CliError(`${target} adapter cannot write sessions yet`);
    ctx.err(`porting ${instanceLabel(row.harness, row.instanceId)}:${shortId(row.nativeId, 12)} → ${target}`);
    const native = await targetAdapter.write(session, {
      instanceId: targetBinding.instanceId,
      cwd: flagString(args, "cwd") === "." ? process.cwd() : flagString(args, "cwd"),
      mode: "full",
      liveTools: flagBool(args, "live-tools"),
      dryRun: flagBool(args, "dry-run"),
    });
    const instanceNative: NativeRef = { ...native, instanceId: targetBinding.instanceId };
    for (const c of native.created ?? []) ctx.err(ctx.pal.dim(`  ${c}`));
    binding = targetBinding;
    ref = instanceNative;
    // Same as writeInto: index the freshly-written cross-harness target so a
    // subsequent `sinter resume <id>` resolves it without a separate scan.
    if (!flagBool(args, "dry-run")) {
      try {
        const crossCwd = flagString(args, "cwd") === "." ? process.cwd() : flagString(args, "cwd");
        ctx.ledger().upsert(summarize(instanceNative, session, crossCwd));
      } catch (err) {
        ctx.err(ctx.pal.dim(`  (ledger not updated: ${err instanceof Error ? err.message : String(err)})`));
      }
    }
  }

  const argv2 = binding.resumeCommand(ref);
  if (flagBool(args, "exec")) {
    if (!ctx.exec) throw new CliError("--exec is not available in this context");
    ctx.err(ctx.pal.dim(`exec: ${quoteArgv(argv2)}`));
    return await ctx.exec(argv2);
  }
  printResume(ctx, binding, ref);
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
  const targetLoads = loads
    .filter((l) => l.adapter && typeof l.adapter.write === "function")
    .filter((l) => !only || only.includes(l.id));
  const targets = [...new Set(targetLoads.map((load) => load.id))];

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
      const binding = await bindingForRow(ctx, row);
      const session = await binding.adapter.read({
        harness: row.harness,
        instanceId: row.instanceId ?? DEFAULT_INSTANCE_ID,
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
    if (store) detected.push(`${instanceLabel(load.harness, load.instanceId)}: ${(store.paths ?? []).join(", ")}`);
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
  ctx.out("    on POSIX systems, SQLite files are restricted to the current user (owner read/write only)");
  ctx.out("  carry-forward data: stored beside a target session only when a port needs it");
  ctx.out("  telemetry: disabled unless you explicitly run `sinter telemetry enable`");
  ctx.out("    events contain a random installation id, version, OS/architecture, event name, and time only");
  ctx.out("    CI and non-interactive commands never emit telemetry; disable with `sinter telemetry disable`");
  ctx.out("  Cloud login: optional; `sinter login` stores access credentials in macOS Keychain");
  ctx.out("    other platforms currently use an owner-only file; login does not upload transcripts");
  ctx.out("    inspect with `sinter whoami`; revoke and remove with `sinter logout`");
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

export async function cmdCapabilities(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["harness"], booleans: ["json"] });
  const harness = flagString(args, "harness");
  const selected = harness ? parseHarness(harness) : undefined;
  const all = await adapterCapabilities(ctx.registry);
  const capabilities = selected ? all.filter((capability) => capability.harness === selected) : all;

  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify({ schema: CAPABILITIES_SCHEMA, capabilities }, null, 2));
    return EXIT.OK;
  }

  const yesNo = (value: boolean): string => (value ? ctx.pal.green("yes") : ctx.pal.dim("no"));
  ctx.out(
    renderTable(
      [
        { header: "HARNESS" },
        { header: "ADAPTER" },
        { header: "STORE" },
        { header: "READ" },
        { header: "WRITE" },
        { header: "RESUME" },
        { header: "LIMITATIONS", flex: true },
      ],
      capabilities.map((capability) => [
        ctx.pal.cyan(capability.harness),
        capability.adapter === "available" ? ctx.pal.green("yes") : ctx.pal.dim("no"),
        capability.store,
        yesNo(capability.read),
        yesNo(capability.write),
        capability.resume,
        capability.limitations.join("; ") || "-",
      ]),
      { width: ctx.width, pal: ctx.pal },
    ),
  );
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

function cloudLoginTimeout(value: string | undefined) {
  const input = value ?? "10m";
  const match = /^(\d+(?:\.\d+)?)\s*(s|m)$/i.exec(input.trim());
  if (!match) throw new CliError(`bad --timeout: ${input} (try 10m or 90s)`);
  const ms = Number(match[1]) * (match[2]!.toLowerCase() === "m" ? 60_000 : 1_000);
  if (!Number.isFinite(ms) || ms < 30_000 || ms > 15 * 60_000)
    throw new CliError("--timeout must be between 30s and 15m");
  return Math.floor(ms);
}

function cloudAuth(ctx: Ctx) {
  return ctx.cloudAuth ?? createCloudAuthService();
}

function cloudDevices(ctx: Ctx) {
  return ctx.cloudDevices ?? createCloudDeviceService();
}

export async function cmdDevices(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["name"], booleans: ["json", "yes"] });
  const action = args._[0] ?? "list";
  const positional = args._.slice(1);
  const json = flagBool(args, "json");
  const service = cloudDevices(ctx);

  if (action === "register") {
    if (positional.length) throw new CliError("usage: sinter devices register [--name name] [--json]");
    const result = await service.register(flagString(args, "name"));
    if (json) {
      ctx.out(JSON.stringify({ schema: "sinter.cloud.device-registration-result.v1", ok: true, ...result }));
    } else if (result.status === "approval_required") {
      ctx.out("Approval required before this device can be registered.");
      if (result.enrollment?.id) ctx.out(`request: ${result.enrollment.id}`);
      ctx.out("Run `sinter devices pending` and approve this request from an existing registered device.");
      ctx.out(ctx.pal.dim(`private keys: ${result.keyStorage}`));
    } else {
      ctx.out(`Registered device ${result.device?.name ?? result.name} (${result.device?.id ?? result.deviceId}).`);
      ctx.out(ctx.pal.dim(`private keys: ${result.keyStorage}`));
    }
    return EXIT.OK;
  }

  if (action === "list") {
    if (positional.length || flagString(args, "name")) throw new CliError("usage: sinter devices list [--json]");
    const devices = await service.list();
    if (json) {
      ctx.out(JSON.stringify({ schema: "sinter.cloud.devices.v1", ok: true, devices }));
    } else if (!devices.length) {
      ctx.out("No registered Cloud devices.");
    } else {
      ctx.out(renderTable(
        [
          { header: "ID", max: 24 },
          { header: "NAME", flex: true },
          { header: "STATUS", max: 12 },
          { header: "FINGERPRINT", max: 16 },
        ],
        devices.map((device) => [device.id, device.name, device.status ?? (device.revokedAt ? "revoked" : "active"), device.fingerprint.slice(0, 16)]),
        { width: ctx.width, pal: ctx.pal },
      ));
    }
    return EXIT.OK;
  }

  if (action === "rename") {
    if (positional.length !== 2 || flagString(args, "name")) throw new CliError("usage: sinter devices rename <id> <name> [--json]");
    await service.rename(positional[0]!, positional[1]!);
    if (json) ctx.out(JSON.stringify({ schema: "sinter.cloud.device-rename.v1", ok: true, deviceId: positional[0], name: positional[1] }));
    else ctx.out(`Renamed device ${positional[0]} to ${positional[1]}.`);
    return EXIT.OK;
  }

  if (action === "revoke") {
    if (positional.length !== 1 || flagString(args, "name")) throw new CliError("usage: sinter devices revoke <id> --yes [--json]");
    if (!flagBool(args, "yes")) throw new CliError("refusing to revoke a device without --yes; revocation is permanent and may make Cloud data unrecoverable");
    await service.revoke(positional[0]!);
    if (json) ctx.out(JSON.stringify({ schema: "sinter.cloud.device-revoke.v1", ok: true, deviceId: positional[0] }));
    else ctx.out(`Revoked device ${positional[0]}.`);
    return EXIT.OK;
  }

  if (action === "pending") {
    if (positional.length || flagString(args, "name")) throw new CliError("usage: sinter devices pending [--json]");
    const enrollments = await service.pending();
    if (json) {
      ctx.out(JSON.stringify({ schema: "sinter.cloud.device-enrollments.v1", ok: true, enrollments }));
    } else if (!enrollments.length) {
      ctx.out("No pending device enrollment requests.");
    } else {
      ctx.out(renderTable(
        [
          { header: "REQUEST", max: 24 },
          { header: "NAME", flex: true },
          { header: "FINGERPRINT", max: 16 },
          { header: "EXPIRES", max: 24 },
        ],
        enrollments.map((request) => [request.id, request.name ?? "-", request.requestFingerprint.slice(0, 16), request.expiresAt]),
        { width: ctx.width, pal: ctx.pal },
      ));
    }
    return EXIT.OK;
  }

  if (action === "approve") {
    if (positional.length !== 1 || flagString(args, "name")) throw new CliError("usage: sinter devices approve <request-id> [--json]");
    const result = await service.approve(positional[0]!);
    if (json) ctx.out(JSON.stringify({ schema: "sinter.cloud.device-approval-result.v1", ok: true, ...result }));
    else ctx.out(`Approved device enrollment ${result.requestId}.`);
    return EXIT.OK;
  }

  throw new CliError("usage: sinter devices <register|list|rename|revoke|pending|approve> ...");
}

export async function cmdLogin(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { strings: ["timeout"], booleans: ["no-open", "json"] });
  if (args._.length) throw new CliError("usage: sinter login [--no-open] [--timeout 10m] [--json]");
  const result = await cloudAuth(ctx).login({
    timeoutMs: cloudLoginTimeout(flagString(args, "timeout")),
    openBrowser: !flagBool(args, "no-open"),
    onUrl: (url) => {
      ctx.err(flagBool(args, "no-open") ? "Open this URL to sign in:" : "Waiting for device approval. If the browser did not open, use:");
      ctx.err(url);
    },
    onDeviceCode: (code) => ctx.err(`Confirm code: ${code}`),
  });
  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify({ schema: "sinter.cloud.login.v1", ok: true, user: result.user, storage: result.storage }));
  } else {
    ctx.out(`Logged in to Sinter Cloud as ${result.user.email ?? result.user.id}.`);
    ctx.out(ctx.pal.dim(`credentials: ${result.storage}`));
  }
  return EXIT.OK;
}

export async function cmdWhoami(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { booleans: ["json"] });
  if (args._.length) throw new CliError("usage: sinter whoami [--json]");
  const result = await cloudAuth(ctx).whoami();
  if (!result) {
    if (flagBool(args, "json")) ctx.out(JSON.stringify({ schema: "sinter.cloud.identity.v1", ok: false, loggedIn: false }));
    else ctx.err("Not logged in. Run `sinter login`.");
    return EXIT.ERROR;
  }
  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify({ schema: "sinter.cloud.identity.v1", ok: true, loggedIn: true, user: result.user, storage: result.storage }));
  } else {
    ctx.out(result.user.email ?? result.user.id);
    ctx.out(ctx.pal.dim(`credentials: ${result.storage}`));
  }
  return EXIT.OK;
}

export async function cmdLogout(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, { booleans: ["json"] });
  if (args._.length) throw new CliError("usage: sinter logout [--json]");
  const result = await cloudAuth(ctx).logout();
  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify({ schema: "sinter.cloud.logout.v1", ok: true, ...result }));
  } else if (!result.hadSession) {
    ctx.out("Already logged out.");
  } else {
    ctx.out("Logged out of Sinter Cloud on this device.");
    if (!result.revoked) ctx.err("The local credential was removed, but remote revocation could not be confirmed.");
  }
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
      const id = `${action.harness}@${action.instanceId ?? DEFAULT_INSTANCE_ID}:${action.nativeId}`;
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
