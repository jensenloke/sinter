#!/usr/bin/env bun
/**
 * sinter — browse, port and resume coding-agent sessions across harnesses.
 *
 * Human-first, terse output. Errors go to stderr.
 * Exit codes: 0 ok, 1 error, 2 ambiguous / not found.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openLedger, type Ledger } from "@sinter/ledger";
import { CliError, EXIT } from "./args";
import { DynamicAdapterRegistry } from "./adapters";
import { loadProfile, type SinterProfile } from "./config";
import {
  cmdCompletion,
  cmdCompare,
  cmdCapabilities,
  cmdConfig,
  cmdDoctor,
  cmdExport,
  cmdFeedback,
  cmdGhosts,
  cmdGui,
  cmdImport,
  cmdLast,
  cmdLs,
  cmdMenu,
  cmdNote,
  cmdPin,
  cmdPinned,
  cmdPort,
  cmdProjects,
  cmdPrivacy,
  cmdRelink,
  cmdRecent,
  cmdRename,
  cmdResume,
  cmdScan,
  cmdSetup,
  cmdSearch,
  cmdShow,
  cmdTelemetry,
  cmdTag,
  cmdTags,
  cmdThread,
  cmdUnpin,
  cmdUntag,
  cmdView,
  type Ctx,
} from "./commands";
import { colorEnabled, palette, termWidth } from "./format";
import { canRunMenu } from "./tui/menu";
import { maybePromptForUpdate } from "./update";
import { trackTelemetry, type TelemetryEvent } from "./telemetry";

export const VERSION = "0.1.10";

/** Commands that manage the ledger themselves — the automatic pre-scan skips them. */
const AUTO_SCAN_SKIP = new Set(["scan", "setup", "doctor", "capabilities", "ghosts", "tags", "privacy", "feedback", "telemetry", "completion", "config"]);

function skipsAutoScan(command: string, argv: string[]): boolean {
  if (AUTO_SCAN_SKIP.has(command)) return true;
  // Saved-view definitions are ledger metadata; only executing a view needs fresh sessions.
  return command === "view" && (argv[0] ?? "list") !== "run";
}

/**
 * Keep the ledger fresh on every invocation: commands that resolve or list
 * sessions read the ledger, and it goes stale the moment the user works in a
 * native harness between two sinter invocations. This is the automatic
 * counterpart of `sinter scan`.
 *
 * Deliberately quiet and never fatal: it prints only when rows actually
 * changed (or a store fails), and a failure degrades to the stale ledger.
 * Enabled by the real CLI (`makeCtx` sets `autoScan: true`); hand-built test
 * contexts leave it off. Opt out per-run with `--no-scan` or SINTER_NO_SCAN=1.
 */
async function autoScanLedger(ctx: Ctx, argv: string[]): Promise<void> {
  if (!ctx.autoScan || argv.includes("--no-scan") || process.env.SINTER_NO_SCAN === "1") return;
  const quiet = argv.includes("--json") || argv.includes("--json=true") || argv.includes("--ndjson") || argv.includes("--ndjson=true");
  try {
    const loads = await ctx.registry.load();
    const adapters = loads.filter((l) => l.adapter).map((l) => l.adapter!);
    if (!adapters.length) return;
    const result = await ctx.ledger().scan(adapters);
    const inserted = Object.values(result.harnesses).reduce((n, s) => n + s.inserted, 0);
    const updated = Object.values(result.harnesses).reduce((n, s) => n + s.updated, 0);
    if (!quiet && (inserted || updated)) ctx.err(ctx.pal.dim(`(ledger: ${inserted} new, ${updated} updated)`));
    if (!quiet) for (const e of result.errors) ctx.err(ctx.pal.dim(`(scan warning [${e.harness}]: ${e.error})`));
  } catch (err) {
    if (!quiet) ctx.err(ctx.pal.dim(`(auto-scan skipped: ${err instanceof Error ? err.message : String(err)})`));
  }
}

const COMMANDS: Record<string, (argv: string[], ctx: Ctx) => Promise<number>> = {
  completion: cmdCompletion,
  compare: cmdCompare,
  capabilities: cmdCapabilities,
  config: cmdConfig,
  scan: cmdScan,
  ls: cmdLs,
  list: cmdLs,
  recent: cmdRecent,
  pin: cmdPin,
  pinned: cmdPinned,
  tag: cmdTag,
  untag: cmdUntag,
  tags: cmdTags,
  note: cmdNote,
  ghosts: cmdGhosts,
  view: cmdView,
  thread: cmdThread,
  last: cmdLast,
  search: cmdSearch,
  rename: cmdRename,
  alias: cmdRename,
  show: cmdShow,
  setup: cmdSetup,
  export: cmdExport,
  import: cmdImport,
  port: cmdPort,
  projects: cmdProjects,
  resume: cmdResume,
  doctor: cmdDoctor,
  privacy: cmdPrivacy,
  feedback: cmdFeedback,
  telemetry: cmdTelemetry,
  unpin: cmdUnpin,
  gui: cmdGui,
  relink: cmdRelink,
  menu: cmdMenu,
  ui: cmdMenu,
};

const HELP = `sinter ${VERSION} — one ledger for every coding-agent session

usage: sinter [command] [args]

  (no command)                           interactive menu: pick a session, pick
                                         a harness, launch it right here
  menu [--all] [--mode full|slim|compact]
                                         the same menu, explicitly
  scan [--json]                          refresh the ledger from every available harness
  config [show|path|validate]            inspect and validate local profile configuration
  ls [--harness x] [--cwd .] [--since 7d] [--limit n]
                                         list sessions, newest first
  recent [--harness x] [--cwd .] [-n 10]
                                         list recent resumable parent sessions
  pin <id-prefix>                        bookmark a session in the local ledger
  unpin <id-prefix>                      remove a local session bookmark
  pinned [--harness x] [--cwd .]        list bookmarked sessions
  tag|untag <id-prefix> <tag...>        manage searchable local tags
  note <id-prefix> <text>|--clear       manage a searchable local note
  tags [--json]                         list tags and session counts
  ghosts [preview|prune] [...]          preview or prune disposable ghost rows
  view <save|list|show|run|delete> ...  manage reusable local session filters
  thread <id-prefix> [--json]           inspect port lineage and resumable tip
  projects [--harness x] [--since 7d]   group resumable sessions by project
  last [--harness x] [--cwd .] [--exec]  print or run the newest resume command
  search <query>                         match aliases, tags, notes, titles + prompts
  rename <id-prefix> <alias>             set a local alias that survives rescans
  show <id-prefix> [--tail n|--json|--ndjson]
                                         render or stream a transcript from any harness
  compare <left-id> <right-id> [--json]  compare transcript structure, not content
  export <id-prefix> [-o file] [--slim]  write the session as SIF JSON
  import <file> --to <harness> [...]     synthesize a new native session from SIF
  setup [--yes] [--no-menu]              detect stores, build the ledger, then open the menu
  port <id-prefix> --to <harness> [...]  create a new target-native session
  resume <id-prefix> [--in <harness>] [--exec]
                                         print (or run) the native resume command
  doctor [--json|--report [-o file]]     detect stores or create a privacy-safe report
  capabilities [--harness x] [--json]   show adapter read, write, and resume support
  privacy                                explain local storage and support limits
  feedback [--title text] [--no-open]    open a safe, prefilled GitHub issue
  telemetry [status|enable|disable]      control anonymous active-use measurement
  gui [--port n] [--no-open]             open the local session workspace
  completion <zsh|bash|fish>              generate native shell completions
  relink [--harness x] [--limit n]       rebuild thread lineage from target stores

global flags:
  --profile <name>  use named local store roots from ~/.config/sinter/config.toml
  --config <path>   use a different profile config file
  --ledger <path>   use a different ledger db (default ~/.sinter/ledger.db)
  --no-color        disable ANSI colour (NO_COLOR is honoured too)
  --no-scan         skip the automatic ledger refresh before the command runs
                   (SINTER_NO_SCAN=1 does the same for scripts/CI)
  --no-update-check disable the cached interactive npm update check
  -h, --help        this help
  --version         print version

profiles: one configured local store per harness. Run \`sinter privacy\` for
storage, support limits, and an example configuration.

ids: any unambiguous native-id prefix, optionally harness-scoped (codex:0199ab).
`;

const COMMAND_HELP: Record<string, string> = {
  config: "usage: sinter config [show|path|validate] [--config file] [--json]\n\nShows profile store roots, prints the resolved config path, or validates every profile.",
  scan: "usage: sinter scan [--harness claude,codex] [--json]\n\nRefreshes the local ledger. Reads local stores only.",
  ls: "usage: sinter ls [--harness x] [--cwd .] [--since 7d] [--limit n] [--json]",
  recent: "usage: sinter recent [--harness x] [--cwd .] [--since 7d] [--limit n] [--json]\n\nLists the newest non-ghost parent sessions; defaults to 10.",
  pin: "usage: sinter pin <id-prefix>\n\nBookmarks a session in Sinter's local ledger without modifying its harness store.",
  unpin: "usage: sinter unpin <id-prefix>\n\nRemoves a Sinter-local bookmark without modifying the session.",
  pinned: "usage: sinter pinned [--harness x] [--cwd .] [--since 7d] [--limit n] [--json] [--no-ghost] [--no-sub]\n\nLists local bookmarks. Pins survive rescans and native-session garbage collection.",
  tag: "usage: sinter tag <id-prefix> <tag...>\n\nAdds normalized, searchable Sinter-local tags without modifying the native session.",
  untag: "usage: sinter untag <id-prefix> <tag...>|--all\n\nRemoves selected or all Sinter-local tags.",
  tags: "usage: sinter tags [--json]\n\nLists local tags and the number of sessions carrying each tag.",
  note: "usage: sinter note <id-prefix> <text>|--clear\n\nSets or clears one searchable Sinter-local note (maximum 4,000 characters).",
  ghosts: "usage: sinter ghosts [preview|prune] [--older-than 30d] [--harness x] [--json] [--yes]\n\nPreviews old ghost rows by default. Pruning requires the explicit `prune` action and --yes, removes only disposable ledger/FTS rows, and never modifies native stores, local metadata, or lineage.",
  view: "usage: sinter view <save|list|show|run|delete> ...\n\nSaves reusable local filters for harness, cwd, recency, result limit, ghosts, and subagents. Explicit flags on `view run` override the saved definition.",
  thread: "usage: sinter thread <id-prefix> [--json]\n\nShows cached port lineage, transfer modes, missing hops, and the newest resumable session without reading transcripts.",
  projects: "usage: sinter projects [--harness x] [--since 7d] [--limit n] [--json]\n\nGroups resumable parent sessions by working directory without reading transcript bodies.",
  last: "usage: sinter last [--harness x] [--cwd .] [--since 7d] [--id|--json|--exec]\n\nSelects the newest non-ghost parent session. By default, prints its native resume command.",
  search: "usage: sinter search <query> [--harness x] [--json]",
  rename: "usage: sinter rename <id-prefix> <alias> [--clear]\n\nStores a local alias in Sinter without modifying the native harness session.",
  alias: "usage: sinter rename <id-prefix> <alias> [--clear]",
  show: "usage: sinter show <id-prefix> [--tail n|--json|--ndjson] [--tool-chars n] [--no-sub]\n\n--tail renders only the latest n entries from each session. It cannot be combined with machine output because the result would not be a complete SIF document.\n--ndjson emits a versioned session record followed by one record per entry, then nested sessions.",
  compare: "usage: sinter compare <left-id> <right-id> [--json]\n\nCompares structural counts without printing transcript content. Matching counts do not prove semantic equivalence.",
  export: "usage: sinter export <id-prefix> [-o file] [--slim]\n\nWithout -o, writes SIF JSON to stdout.",
  import: "usage: sinter import <file.sif.json> --to <harness> [--cwd dir] [--dry-run] [--live-tools]\n\nCreates a new target session; never modifies the source.",
  port: "usage: sinter port <id-prefix> --to <harness> [--mode full|slim|compact] [--preview [--json]] [--cwd dir] [--dry-run] [--live-tools]\n\nCreates a new target session; never modifies the source.\n--preview reports target readiness and transfer impact without invoking the target writer.\n--dry-run asks the target writer to validate and describe its planned native output.\nHistorical tool calls are inert unless --live-tools is explicit.",
  resume: "usage: sinter resume <id-prefix> [--in <harness>] [--exec]\n\n--exec hands this terminal to the target harness.",
  doctor: "usage: sinter doctor [--json|--report [-o file]]\n\nNormal output shows resolved local store paths. --json emits safe structured health. --report emits a reviewable support report that excludes paths, prompts, titles, session IDs, transcripts, and raw errors.",
  capabilities: "usage: sinter capabilities [--harness x] [--json]\n\nChecks adapter loading, local-store detection, write support, and native resume availability without reading transcripts or touching the ledger.",
  setup: "usage: sinter setup [--yes] [--no-menu]\n\nShows detected local stores. Interactive setup asks before scanning and opening the menu; --yes scans without opening it.",
  privacy: "usage: sinter privacy\n\nExplains local storage, profile limits, and harness support.",
  feedback: "usage: sinter feedback [--title text] [--no-open]\n\nOpens a prefilled GitHub issue with safe diagnostics only.",
  telemetry: "usage: sinter telemetry [status|enable|disable] [--endpoint https://…]\n\nOpt-in anonymous active-use measurement. CI and non-interactive commands never emit events.",
  gui: "usage: sinter gui [--port n] [--no-open]\n\nRuns a token-protected workspace on 127.0.0.1; transcripts never leave this machine.",
  completion: "usage: sinter completion <zsh|bash|fish>\n\nPrints a native completion script to stdout; does not modify shell configuration.",
  relink: "usage: sinter relink [--harness x] [--limit n] [--quiet]\n\nRebuilds the disposable lineage cache from target stores.",
  menu: "usage: sinter menu [--all] [--mode full|slim|compact]\n\nRequires an interactive terminal.",
};

function helpFor(command: string): string {
  return `${COMMAND_HELP[command] ?? HELP.trimEnd()}\n\nGlobal flags: --profile <name>, --config <path>, --ledger <path>, --no-color, --no-scan, --no-update-check, -h/--help`;
}

export function makeCtx(overrides: Partial<Ctx> & { ledgerPath?: string; profile?: SinterProfile } = {}): Ctx {
  const enabled = overrides.pal ? overrides.pal.enabled : colorEnabled();
  let ledger: Ledger | undefined;
  return {
    registry: overrides.registry ?? new DynamicAdapterRegistry(undefined, overrides.profile),
    ledger: overrides.ledger ?? (() => (ledger ??= openLedger(overrides.ledgerPath))),
    out: overrides.out ?? ((s) => process.stdout.write(s + "\n")),
    err: overrides.err ?? ((s) => process.stderr.write(s + "\n")),
    pal: overrides.pal ?? palette(enabled),
    width: overrides.width ?? termWidth(),
    now: overrides.now ?? Date.now(),
    writeFile:
      overrides.writeFile ??
      (async (p, c) => {
        mkdirSync(dirname(p), { recursive: true });
        await Bun.write(p, c);
      }),
    readFile: overrides.readFile ?? ((p) => Bun.file(p).text()),
    exec:
      overrides.exec ??
      (async (argv) => {
        const proc = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });
        return await proc.exited;
      }),
    profile: overrides.profile,
    autoScan: overrides.autoScan ?? true,
    version: overrides.version ?? VERSION,
  };
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const jsonRequested = rest.includes("--json") || rest.includes("--json=true") || rest.includes("--ndjson") || rest.includes("--ndjson=true");

  if (!cmd) {
    if (canRunMenu()) {
      await autoScanLedger(ctx, argv);
      return cmdMenu([], ctx);
    }
    ctx.out(HELP.trimEnd());
    return EXIT.OK;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    ctx.out(HELP.trimEnd());
    return EXIT.OK;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    ctx.out(VERSION);
    return EXIT.OK;
  }

  const fn = COMMANDS[cmd];
  if (!fn) {
    if (jsonRequested) {
      ctx.err(JSON.stringify({ schema: "sinter.error.v1", ok: false, error: { code: EXIT.ERROR, kind: "usage", message: `unknown command: ${cmd}` } }));
    } else {
      ctx.err(`unknown command: ${cmd}\ntry: sinter help`);
    }
    return EXIT.ERROR;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    ctx.out(helpFor(cmd));
    return EXIT.OK;
  }

  if (!skipsAutoScan(cmd, rest)) await autoScanLedger(ctx, argv);

  try {
    const code = await fn(rest, ctx);
    if (code === EXIT.OK) {
      const event: Partial<Record<string, TelemetryEvent>> = {
        scan: "scan",
        port: "port_success",
        resume: "resume",
        gui: "gui_open",
      };
      if (event[cmd]) await trackTelemetry(event[cmd]!, VERSION);
    }
    return code;
  } catch (err) {
    if (err instanceof CliError) {
      if (jsonRequested) {
        ctx.err(
          JSON.stringify({
            schema: "sinter.error.v1",
            ok: false,
            error: { code: err.code, kind: err.code === EXIT.AMBIGUOUS ? "resolution" : "usage", message: err.message },
          }),
        );
      } else {
        ctx.err(ctx.pal.red(err.message));
      }
      return err.code;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (jsonRequested) {
      ctx.err(JSON.stringify({ schema: "sinter.error.v1", ok: false, error: { code: EXIT.ERROR, kind: "internal", message } }));
    } else {
      ctx.err(ctx.pal.red(message));
      if (process.env.SINTER_DEBUG && err instanceof Error && err.stack) ctx.err(ctx.pal.dim(err.stack));
    }
    return EXIT.ERROR;
  }
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  if (await maybePromptForUpdate(VERSION, { argv })) return EXIT.OK;
  const ledgerIndex = argv.findIndex((arg) => arg === "--ledger" || arg.startsWith("--ledger="));
  const ledgerPath = ledgerIndex < 0 ? undefined : argv[ledgerIndex]!.includes("=") ? argv[ledgerIndex]!.slice(argv[ledgerIndex]!.indexOf("=") + 1) : argv[ledgerIndex + 1];
  const noColor = argv.includes("--no-color");
  const profile = loadProfile(argv);
  const ctx = makeCtx({ ledgerPath, profile, pal: palette(noColor ? false : colorEnabled()) });
  return run(argv, ctx);
}

if (import.meta.main) process.exit(await main());
