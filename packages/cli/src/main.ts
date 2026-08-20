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
  cmdDoctor,
  cmdExport,
  cmdImport,
  cmdLs,
  cmdMenu,
  cmdPort,
  cmdPrivacy,
  cmdRelink,
  cmdResume,
  cmdScan,
  cmdSetup,
  cmdSearch,
  cmdShow,
  type Ctx,
} from "./commands";
import { colorEnabled, palette, termWidth } from "./format";
import { canRunMenu } from "./tui/menu";
import { maybePromptForUpdate } from "./update";

export const VERSION = "0.1.5";

const COMMANDS: Record<string, (argv: string[], ctx: Ctx) => Promise<number>> = {
  scan: cmdScan,
  ls: cmdLs,
  list: cmdLs,
  search: cmdSearch,
  show: cmdShow,
  setup: cmdSetup,
  export: cmdExport,
  import: cmdImport,
  port: cmdPort,
  resume: cmdResume,
  doctor: cmdDoctor,
  privacy: cmdPrivacy,
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
  scan                                   refresh the ledger from every available harness
  ls [--harness x] [--cwd .] [--since 7d] [--limit n]
                                         list sessions, newest first
  search <query>                         full-text match over titles + first prompts
  show <id-prefix> [--json]              render a transcript from any harness
  export <id-prefix> [-o file] [--slim]  write the session as SIF JSON
  import <file> --to <harness> [...]     synthesize a new native session from SIF
  setup [--yes] [--no-menu]              detect stores, build the ledger, then open the menu
  port <id-prefix> --to <harness> [...]  create a new target-native session
  resume <id-prefix> [--in <harness>] [--exec]
                                         print (or run) the native resume command
  doctor                                 detect stores, versions, ledger counts
  privacy                                explain local storage and support limits
  relink [--harness x] [--limit n]       rebuild thread lineage from target stores

global flags:
  --profile <name>  use named local store roots from ~/.config/sinter/config.toml
  --config <path>   use a different profile config file
  --ledger <path>   use a different ledger db (default ~/.sinter/ledger.db)
  --no-color        disable ANSI colour (NO_COLOR is honoured too)
  --no-update-check disable the cached interactive npm update check
  -h, --help        this help
  --version         print version

profiles: one configured local store per harness. Run \`sinter privacy\` for
storage, support limits, and an example configuration.

ids: any unambiguous native-id prefix, optionally harness-scoped (codex:0199ab).
`;

const COMMAND_HELP: Record<string, string> = {
  scan: "usage: sinter scan [--harness claude,codex]\n\nRefreshes the local ledger. Reads local stores only.",
  ls: "usage: sinter ls [--harness x] [--cwd .] [--since 7d] [--limit n] [--json]",
  search: "usage: sinter search <query> [--harness x] [--json]",
  show: "usage: sinter show <id-prefix> [--json] [--tool-chars n] [--no-sub]",
  export: "usage: sinter export <id-prefix> [-o file] [--slim]\n\nWithout -o, writes SIF JSON to stdout.",
  import: "usage: sinter import <file.sif.json> --to <harness> [--cwd dir] [--dry-run] [--live-tools]\n\nCreates a new target session; never modifies the source.",
  port: "usage: sinter port <id-prefix> --to <harness> [--cwd dir] [--dry-run] [--live-tools]\n\nCreates a new target session; historical tool calls are inert unless --live-tools is explicit.",
  resume: "usage: sinter resume <id-prefix> [--in <harness>] [--exec]\n\n--exec hands this terminal to the target harness.",
  doctor: "usage: sinter doctor\n\nReports resolved local store paths and ledger counts.",
  setup: "usage: sinter setup [--yes] [--no-menu]\n\nShows detected local stores. Interactive setup asks before scanning and opening the menu; --yes scans without opening it.",
  privacy: "usage: sinter privacy\n\nExplains local storage, profile limits, and harness support.",
  relink: "usage: sinter relink [--harness x] [--limit n] [--quiet]\n\nRebuilds the disposable lineage cache from target stores.",
  menu: "usage: sinter menu [--all] [--mode full|slim|compact]\n\nRequires an interactive terminal.",
};

function helpFor(command: string): string {
  return `${COMMAND_HELP[command] ?? HELP.trimEnd()}\n\nGlobal flags: --profile <name>, --config <path>, --ledger <path>, --no-color, --no-update-check, -h/--help`;
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
  };
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd) {
    if (canRunMenu()) return cmdMenu([], ctx);
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
    ctx.err(`unknown command: ${cmd}\ntry: sinter help`);
    return EXIT.ERROR;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    ctx.out(helpFor(cmd));
    return EXIT.OK;
  }

  try {
    return await fn(rest, ctx);
  } catch (err) {
    if (err instanceof CliError) {
      ctx.err(ctx.pal.red(err.message));
      return err.code;
    }
    ctx.err(ctx.pal.red(err instanceof Error ? err.message : String(err)));
    if (process.env.SINTER_DEBUG && err instanceof Error && err.stack) ctx.err(ctx.pal.dim(err.stack));
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
