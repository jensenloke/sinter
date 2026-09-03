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
import { bootstrapDefaultConfig, loadProfile, type SinterProfile } from "./config";
import {
  cmdCompletion,
  cmdCompare,
  cmdCapabilities,
  cmdCloud,
  cmdConfig,
  cmdDoctor,
  cmdDevices,
  cmdExport,
  cmdFeedback,
  cmdGhosts,
  cmdGui,
  cmdImport,
  cmdLast,
  cmdLedger,
  cmdLogin,
  cmdLs,
  cmdLogout,
  cmdMenu,
  cmdNote,
  cmdPin,
  cmdPinned,
  cmdPort,
  cmdProjects,
  cmdPrivacy,
  cmdRelink,
  cmdRecent,
  cmdReceive,
  cmdRename,
  cmdResume,
  cmdScan,
  cmdSend,
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
  cmdWatch,
  cmdWhoami,
  type Ctx,
} from "./commands";
import { colorEnabled, palette, termWidth } from "./format";
import { canRunMenu } from "./tui/menu";
import { cmdUpdate, maybePromptForUpdate } from "./update";
import { trackTelemetry, type TelemetryEvent } from "./telemetry";

export const VERSION = "0.5.1";

/** Commands that manage the ledger themselves — the automatic pre-scan skips them. */
const AUTO_SCAN_SKIP = new Set(["scan", "watch", "setup", "doctor", "capabilities", "ghosts", "ledger", "tags", "privacy", "feedback", "telemetry", "completion", "config", "login", "whoami", "logout", "devices", "update"]);

function skipsAutoScan(command: string, argv: string[]): boolean {
  if (AUTO_SCAN_SKIP.has(command)) return true;
  if (command === "cloud") return (argv[0] ?? "list") !== "push";
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
  update: cmdUpdate,
  completion: cmdCompletion,
  compare: cmdCompare,
  capabilities: cmdCapabilities,
  config: cmdConfig,
  cloud: cmdCloud,
  devices: cmdDevices,
  login: cmdLogin,
  whoami: cmdWhoami,
  logout: cmdLogout,
  scan: cmdScan,
  ls: cmdLs,
  list: cmdLs,
  recent: cmdRecent,
  watch: cmdWatch,
  pin: cmdPin,
  pinned: cmdPinned,
  tag: cmdTag,
  untag: cmdUntag,
  tags: cmdTags,
  note: cmdNote,
  ghosts: cmdGhosts,
  ledger: cmdLedger,
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
  send: cmdSend,
  receive: cmdReceive,
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

interactive
  (no command)                           interactive menu: pick a session, pick
                                         a harness, launch it right here
  menu [--all] [--mode full|slim|compact]
                                         the same menu, explicitly

find and inspect
  scan [--json]                          refresh the ledger from every available harness
  ls [--harness x] [--cwd .] [--since 7d] [--limit n]
                                         list sessions, newest first
  recent [--harness x] [--cwd .] [-n 10]
                                         list recent resumable parent sessions
  watch [recent|projects] [--interval 2s]
                                         refresh a live local session view
  projects [--harness x] [--since 7d]   group resumable sessions by project
  search <query>                         match aliases, tags, notes, titles + prompts
  show <id-prefix> [--tail n|--json|--ndjson]
                                         render or stream a transcript from any harness
  thread <id-prefix> [--json]           inspect port lineage and resumable tip
  compare <left-id> <right-id> [--json]  compare transcript structure, not content

organize locally
  pin <id-prefix>                        bookmark a session in the local ledger
  unpin <id-prefix>                      remove a local session bookmark
  pinned [--harness x] [--cwd .]        list bookmarked sessions
  rename <id-prefix> <alias>             set a local alias that survives rescans
  tag|untag <id-prefix> <tag...>        manage searchable local tags
  note <id-prefix> <text>|--clear       manage a searchable local note
  tags [--json]                         list tags and session counts
  view <save|list|show|run|delete> ...  manage reusable local session filters

move and continue
  last [--harness x] [--cwd .] [--exec]  print or run the newest resume command
  export <id-prefix> [-o file] [--slim]  write the session as SIF JSON
  import <file> --to <harness> [...]     synthesize a new native session from SIF
  port <id-prefix> --to <harness> [...]  create a new target-native session
  resume <id-prefix> [--in <harness>] [--exec]
                                         print (or run) the native resume command
  receive --to <harness@instance> --cwd <repository-root>
                                         accept one repository-bound encrypted transfer
  send <id-prefix> --to <locator> [...]  send encrypted context to that receiver

setup and maintenance
  setup [--yes] [--no-menu]              detect stores, build the ledger, then open the menu
  config [show|path|validate|example|discover-shell]
                                         inspect profiles or explicitly discover Claude aliases
  update [--check] [--package-manager bun|npm] [--force] [--json]
                                         install the exact latest published CLI build
  doctor [--json|--report [-o file]]     detect stores or create a privacy-safe report
  capabilities [--harness x] [--json]   show adapter read, write, and resume support
  ghosts [preview|prune] [...]          preview or prune disposable ghost rows
  ledger <backup|verify|repair> [...]   back up or repair the local ledger
  relink [--harness x] [--limit n]       rebuild thread lineage from target stores

cloud account (optional)
  login [--no-open] [--timeout 10m]      approve this CLI through Auth0 device login
  whoami [--json]                        verify and print the current Cloud identity
  logout [--json]                        revoke and remove this device's Cloud login
  devices register [--name name] [--no-wait] [--timeout 5m]
                                         register and wait for device approval
  devices list|pending [--json]          list devices or enrollment requests
  devices rename|revoke|approve ...      manage Cloud device identity
  devices capsule-test create|open ...   verify a synthetic-only local capsule file
  cloud push <id-prefix> [--mode ...]    encrypt and retain a session capsule (default compact)
  cloud list|inspect [...]               list metadata or decrypt one capsule locally
  cloud pull <id> --to <harness@instance> --cwd <repository-root>
                                         restore into one repository-bound target
  cloud delete <id> [--yes]              permanently delete a retained capsule

support and interfaces
  privacy                                explain local storage and support limits
  feedback [--title text] [--no-open]    open a safe, prefilled GitHub issue
  telemetry [status|enable|disable]      control anonymous active-use measurement
  gui [--port n] [--no-open]             open the local session workspace
  completion <zsh|bash|fish>              generate native shell completions

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

profiles: the first operational run detects multiple Claude stores and creates
config.toml only when missing. Run \`sinter help instances\` for the workflow.

ids: any unambiguous native-id prefix, optionally instance-qualified
(claude@personal:0199ab). Agent scripts should use the qualified form.
`;

const INSTANCE_HELP = `sinter named instances — use multiple accounts or stores for one harness

Sinter automatically checks for ~/.claude/projects and ~/.claude-*/projects on
the first operational run. If it finds two or more stores and config.toml does
not exist, it creates a default profile and uses it immediately. Existing
configuration is never overwritten.

inspect configuration
  sinter config path                    print the resolved config path
  sinter config show                    show selected profile/store mappings
  sinter config validate                validate every profile
  sinter config example                 print editable TOML to stdout
  sinter config discover-shell          opt-in preview of simple Claude aliases

Shell alias discovery is never automatic. The explicit discover-shell command
runs the selected zsh/bash login startup files only to list aliases, suppresses
raw alias output, and previews safe instance tables. Use --write --yes only to
create a missing config; an existing config is never modified.

move between two Claude instances
  sinter scan
  sinter ls --harness claude
  sinter port claude@personal:<id> --to claude@addvita --preview
  sinter port claude@personal:<id> --to claude@addvita
  sinter resume claude@addvita:<new-id>

The source store is read-only. Port creates a new session in the target store.
Reverse the two instance names to move context back.

agent workflow
  1. Run \`sinter config validate\`, then \`sinter scan\`.
  2. Resolve the source with \`harness@instance:id\`; do not guess on ambiguity.
  3. Run \`sinter port ... --preview\` before writing.
  4. Run the port without --exec unless the user explicitly asks to launch it.
  5. Report the new qualified ID and the printed native resume command.

stdout contains requested results and machine data. Notices go to stderr.
Usage or validation failures go to stderr and return a non-zero exit code.`;

const COMMAND_HELP: Record<string, string> = {
  config: "usage: sinter config [show|path|validate|example] [--config file] [--json]\n       sinter config discover-shell [--shell <absolute-path>] [--write] [--yes] [--json]\n\nShows profile store roots, prints the resolved config path, validates every profile, or prints editable TOML. discover-shell is explicit and opt-in: it executes zsh/bash login startup files with argv [shell, '-lic', 'alias'], suppresses raw alias output, and previews only conservative CLAUDE_CONFIG_DIR instances. --write is create-only, never overwrites an existing config, and requires --yes outside an interactive terminal.",
  update: "usage: sinter update [--check] [--package-manager bun|npm] [--force] [--json]\n\nQueries npm for an exact published version, then updates the matching global bun or npm installation. --check never installs. A newer local build is never downgraded unless --force is explicit. If installation ownership cannot be determined safely, pass --package-manager.",
  instances: INSTANCE_HELP,
  scan: "usage: sinter scan [--harness claude,codex] [--json]\n\nRefreshes the local ledger. Reads local stores only.",
  ls: "usage: sinter ls [--harness x] [--cwd .] [--since 7d] [--limit n] [--json]",
  recent: "usage: sinter recent [--harness x] [--cwd .] [--since 7d] [--limit n] [--json]\n\nLists the newest non-ghost parent sessions; defaults to 10.",
  watch: "usage: sinter watch [recent|projects] [--interval 2s] [--count n] [--harness x] [--cwd .] [--since 7d] [--limit n] [--json] [--no-clear]\n\nRescans local harness stores before every snapshot. Interactive terminals repeat until Ctrl-C and redraw in place. Pipes and CI emit one snapshot unless --count is explicit; --json emits one compact sinter.watch.v1 record per snapshot. --no-scan watches the cached ledger only.",
  pin: "usage: sinter pin <id-prefix>\n\nBookmarks a session in Sinter's local ledger without modifying its harness store.",
  unpin: "usage: sinter unpin <id-prefix>\n\nRemoves a Sinter-local bookmark without modifying the session.",
  pinned: "usage: sinter pinned [--harness x] [--cwd .] [--since 7d] [--limit n] [--json] [--no-ghost] [--no-sub]\n\nLists local bookmarks. Pins survive rescans and native-session garbage collection.",
  tag: "usage: sinter tag <id-prefix> <tag...>\n\nAdds normalized, searchable Sinter-local tags without modifying the native session.",
  untag: "usage: sinter untag <id-prefix> <tag...>|--all\n\nRemoves selected or all Sinter-local tags.",
  tags: "usage: sinter tags [--json]\n\nLists local tags and the number of sessions carrying each tag.",
  note: "usage: sinter note <id-prefix> <text>|--clear\n\nSets or clears one searchable Sinter-local note (maximum 4,000 characters).",
  ghosts: "usage: sinter ghosts [preview|prune] [--older-than 30d] [--harness x] [--json] [--yes]\n\nPreviews old ghost rows by default. Pruning requires the explicit `prune` action and --yes, removes only disposable ledger/FTS rows, and never modifies native stores, local metadata, or lineage.",
  ledger: "usage: sinter ledger <backup [--output file]|verify|repair [--yes] [--no-backup]> [--json]\n\nbackup writes a consistent owner-only snapshot copy of the local ledger (default: next to the ledger with a timestamp) and never overwrites an existing file. verify reports SQLite integrity, schema version, table presence, and search-index consistency without writing. repair rebuilds only derived data (the FTS search index and SQLite indexes) after taking a backup; it never modifies session rows, local metadata, lineage, or native harness stores. Restore a backup by copying the file over the ledger path while Sinter is not running.",
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
  port: "usage: sinter port <harness[@instance]:id> --to <harness[@instance]> [--mode full|slim|compact] [--preview [--json]] [--cwd dir] [--dry-run] [--live-tools]\n\nCreates a new target session; never modifies the source. Use qualified IDs when a harness has multiple instances.\n--preview reports target readiness and transfer impact without invoking the target writer.\n--dry-run asks the target writer to validate and describe its planned native output.\nHistorical tool calls are inert unless --live-tools is explicit.",
  resume: "usage: sinter resume <harness[@instance]:id> [--in <harness[@instance]>] [--exec]\n\nPrints the native resume command to stdout. --exec hands this terminal to the exact target harness instance.",
  send: "usage: sinter send <id-prefix> --to <sinter://transfer/...> [--mode compact|slim|full] [--repo-remote <name>] [--preview] [--json]\n\nSends a one-use encrypted, context-only v2 payload. Source repository identity is sanitized inside the encrypted payload; the source absolute working directory and raw Git URL are not transferred. If several hosted remotes remain possible and the session does not identify one, --repo-remote must select the intended Git remote by name. The sender reports success only after the receiver validates, accepts, and imports it.",
  receive: "usage: sinter receive --to <harness@instance> --cwd <repository-root> [--bind 0.0.0.0] [--advertise <LAN-or-Tailscale-IP>] [--port n] [--ttl 5m] [--allow-repo-mismatch] [--allow-missing-commit] [--yes] [--json]\n\nAccepts only repository-bound direct-transfer v2 payloads and rejects legacy v1 session payloads. --cwd must explicitly select the target Git repository root. After decryption, Sinter compares sanitized remotes, verifies the source commit is present, validates the repository-relative subdirectory, reports dirty state, and shows a no-write preview before confirmation or import. It never fetches, checks out, resets, patches, or modifies repository files. A mismatch or missing commit requires its dedicated explicit override; --yes only skips the final receipt prompt and cannot bypass repository checks. --json emits one versioned listener record followed by one versioned completion record, with human preview details on stderr. Use --advertise with a Tailscale IP for tailnet transfer.",
  doctor: "usage: sinter doctor [--json|--report [-o file]]\n\nNormal output shows resolved local store paths. --json emits safe structured health. --report emits a reviewable support report that excludes paths, prompts, titles, session IDs, transcripts, and raw errors.",
  capabilities: "usage: sinter capabilities [--harness x] [--json]\n\nChecks adapter loading, local-store detection, write support, and native resume availability without reading transcripts or touching the ledger.",
  setup: "usage: sinter setup [--yes] [--no-menu]\n\nShows detected local stores. Interactive setup asks before scanning and opening the menu; --yes scans without opening it.",
  privacy: "usage: sinter privacy\n\nExplains local storage, profile limits, and harness support.",
  feedback: "usage: sinter feedback [--title text] [--no-open]\n\nOpens a prefilled GitHub issue with safe diagnostics only.",
  login: "usage: sinter login [--no-open] [--timeout 10m] [--json]\n\nStarts an OAuth device authorization, opens Auth0 in the browser, prints the confirmation code for headless/SSH use, validates the returned Sinter Cloud identity, and stores rotating credentials in macOS Keychain (or an owner-only file when no native credential store is available). It does not upload sessions.",
  whoami: "usage: sinter whoami [--json]\n\nRefreshes the Cloud session when needed and verifies the identity with Sinter Cloud. It never scans local sessions.",
  logout: "usage: sinter logout [--json]\n\nRevokes the current Cloud session when reachable, then removes the local credential even if the network is unavailable.",
  devices: "usage: sinter devices register [--name name] [--no-wait] [--timeout 5m] [--json]\n       sinter devices <list|rename|revoke|pending|approve> ...\n       sinter devices capsule-test create --output <new-file> [--json]\n       sinter devices capsule-test open --input <file> [--json]\n\nRegistration waits for an existing device to approve the enrollment, then saves the approved device ID automatically. --no-wait returns approval-required immediately for scripts. --timeout accepts 5s through 15m and never extends past the server expiry; without it, registration waits through the enrollment window. Progress is written to stderr, and --json writes one final versioned document to stdout. Ctrl+C stops waiting without removing the request or local keys.\n\nCapsule-test is an explicit account-only, synthetic-only local-file diagnostic. Create requires at least two current active initialized exact-suite registered devices, self-verifies decrypt and replay rejection, and writes a new owner-only file without overwriting. Open requires the local recipient and signed sender to remain active in the current registry and verifies the exact fixed fixture plus same-process replay rejection. It never scans sessions, reads the ledger or native stores, bootstraps config, includes transcript/workspace content, or transfers/uploads the file automatically. Copy the created file between approved devices yourself.\n\nPrivate P-256 keys remain in macOS Keychain (or a separate owner-only file on other platforms); only public JWKs are sent to Sinter Cloud. Safe output contains fingerprints, capsule/file metadata, and verification booleans—not keys, ciphertext, device names, emails, tokens, or decrypted fixture content. Device commands never scan local sessions or create profile configuration.",
  cloud: "usage: sinter cloud <push|list|inspect|pull|delete> ...\n\nPush encrypts a repository-bound session-transfer v2 object to active registered devices before upload. List exposes only content-free server metadata. Inspect and pull download, hash-check, verify, and decrypt locally; inspect does not consume replay. Pull repeats repository checks before its exact-instance writer, and --yes never bypasses mismatch or missing-commit checks. Delete requires confirmation or --yes. Aliases: list=ls, delete=rm.",
  "cloud:push": "usage: sinter cloud push <id-prefix> [--mode compact|slim|full] [--repo-remote <name>] [--to all|<device-id-or-fingerprint>] [--preview] [--json]\n\nReads the source store without modifying it, applies the existing repository-binding and metadata-stripping pipeline, encrypts to active exact-suite recipients, and uploads only after an exact reservation. --mode defaults to compact. --preview performs no capsule upload.",
  "cloud:list": "usage: sinter cloud list [--json]\n\nLists sanitized retained-capsule metadata only. Alias: ls.",
  "cloud:inspect": "usage: sinter cloud inspect <capsule-id> [--json]\n\nDownloads with an exact 24 MiB local budget, verifies metadata, sender signature, and local recipient, then decrypts locally without consuming replay.",
  "cloud:pull": "usage: sinter cloud pull <capsule-id> --to <harness@instance> --cwd <repository-root> [--allow-repo-mismatch] [--allow-missing-commit] [--dry-run] [--yes] [--json]\n\nShows and repeats repository checks before any target writer or replay-ledger side effect. --dry-run does not consume replay. --yes skips only confirmation.",
  "cloud:delete": "usage: sinter cloud delete <capsule-id> [--yes] [--json]\n\nPermanently deletes one capsule and requires final deleted state. Alias: rm.",
  telemetry: "usage: sinter telemetry [status|enable|disable] [--endpoint https://…]\n\nOpt-in anonymous active-use measurement. CI and non-interactive commands never emit events.",
  gui: "usage: sinter gui [--port n] [--no-open]\n\nRuns a token-protected workspace on 127.0.0.1; transcripts never leave this machine.",
  completion: "usage: sinter completion <zsh|bash|fish>\n\nPrints a native completion script to stdout; does not modify shell configuration.",
  relink: "usage: sinter relink [--harness x] [--limit n] [--quiet]\n\nRebuilds the disposable lineage cache from target stores.",
  menu: "usage: sinter menu [--all] [--mode full|slim|compact]\n\nRequires an interactive terminal.",
};

function helpFor(command: string, subcommand?: string): string {
  const normalized = command === "cloud" && subcommand === "ls" ? "list" : command === "cloud" && subcommand === "rm" ? "delete" : subcommand;
  const key = normalized ? `${command}:${normalized}` : command;
  return `${COMMAND_HELP[key] ?? COMMAND_HELP[command] ?? HELP.trimEnd()}\n\nGlobal flags: --profile <name>, --config <path>, --ledger <path>, --no-color, --no-scan, --no-update-check, -h/--help`;
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
    interactive: overrides.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    sleep: overrides.sleep ?? Bun.sleep,
    update: overrides.update,
    shellDiscovery: overrides.shellDiscovery,
    cloudAuth: overrides.cloudAuth,
    cloudDevices: overrides.cloudDevices,
    capsuleTest: overrides.capsuleTest,
    cloudCapsules: overrides.cloudCapsules,
    repositoryBinding: overrides.repositoryBinding,
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
    const topic = cmd === "help" ? rest[0] : undefined;
    if (topic && !COMMAND_HELP[topic]) {
      ctx.err(`unknown help topic: ${topic}\ntry: sinter help`);
      return EXIT.ERROR;
    }
    ctx.out(topic ? helpFor(topic, rest[1]) : HELP.trimEnd());
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
    ctx.out(helpFor(cmd, rest[0]));
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
            error: { code: err.code, kind: err.kind ?? (err.code === EXIT.AMBIGUOUS ? "resolution" : "usage"), message: err.message },
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

export async function main(
  argv: string[] = Bun.argv.slice(2),
  overrides: Partial<Ctx> & { ledgerPath?: string; profile?: SinterProfile } = {},
): Promise<number> {
  if (await maybePromptForUpdate(VERSION, { argv })) return EXIT.OK;
  const ledgerIndex = argv.findIndex((arg) => arg === "--ledger" || arg.startsWith("--ledger="));
  const ledgerPath = ledgerIndex < 0 ? undefined : argv[ledgerIndex]!.includes("=") ? argv[ledgerIndex]!.slice(argv[ledgerIndex]!.indexOf("=") + 1) : argv[ledgerIndex + 1];
  const noColor = argv.includes("--no-color");
  const command = argv[0];
  const informational =
    command !== undefined &&
    (["help", "--help", "-h", "--version", "-v", "version", "completion"].includes(command) ||
      (command === "config" && ["path", "example"].includes(argv[1] ?? "show")));
  const helpRequested = argv.includes("--help") || argv.includes("-h");
  const standalone =
    command !== undefined &&
    (["login", "whoami", "logout", "devices", "update"].includes(command) ||
      (command === "cloud" && [undefined, "list", "ls", "inspect", "delete", "rm"].includes(argv[1])) ||
      (command === "config" && argv[1] === "discover-shell"));
  const operational = (!command || Boolean(COMMANDS[command])) && !informational && !helpRequested && !standalone;
  let bootstrap: ReturnType<typeof bootstrapDefaultConfig> | undefined;
  try {
    if (operational) {
      const configIndex = argv.findIndex((arg) => arg === "--config" || arg.startsWith("--config="));
      const configPath =
        configIndex < 0
          ? undefined
          : argv[configIndex]!.includes("=")
            ? argv[configIndex]!.slice(argv[configIndex]!.indexOf("=") + 1)
            : argv[configIndex + 1];
      bootstrap = bootstrapDefaultConfig(configPath);
    }
    const profile = operational ? loadProfile(argv) : overrides.profile;
    const ctx = makeCtx({
      ...overrides,
      ledgerPath: overrides.ledgerPath ?? ledgerPath,
      profile,
      pal: overrides.pal ?? palette(noColor ? false : colorEnabled()),
    });
    if (bootstrap?.created)
      ctx.err(`created config: ${bootstrap.configPath} (instances: ${bootstrap.instances.join(", ")})`);
    return run(argv, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(message + "\n");
    return err instanceof CliError ? err.code : EXIT.ERROR;
  }
}

if (import.meta.main) process.exit(await main());
