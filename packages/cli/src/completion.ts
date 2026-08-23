export type CompletionShell = "zsh" | "bash" | "fish";

const COMMANDS = [
  ["scan", "refresh the local ledger"],
  ["config", "inspect and validate profile configuration"],
  ["ls", "list sessions"],
  ["recent", "list recent resumable sessions"],
  ["pin", "bookmark a session locally"],
  ["unpin", "remove a local bookmark"],
  ["pinned", "list bookmarked sessions"],
  ["thread", "inspect session port lineage"],
  ["projects", "group sessions by working directory"],
  ["last", "resume the newest matching session"],
  ["search", "search sessions"],
  ["rename", "set a local session alias"],
  ["show", "render a transcript"],
  ["compare", "compare transcript structure"],
  ["export", "export a SIF session"],
  ["import", "import a SIF session"],
  ["port", "port a session to another harness"],
  ["resume", "print or run a native resume command"],
  ["setup", "detect stores and build the ledger"],
  ["doctor", "report store and ledger health"],
  ["privacy", "explain local data handling"],
  ["feedback", "open a safe GitHub issue"],
  ["telemetry", "control anonymous usage measurement"],
  ["gui", "open the local browser workspace"],
  ["relink", "rebuild thread lineage"],
  ["menu", "open the interactive menu"],
  ["completion", "generate shell completions"],
] as const;

const HARNESSES = ["claude", "codex", "devin", "opencode", "zcode", "omp", "pi"];
const MODES = ["full", "slim", "compact"];
const GLOBAL_FLAGS = ["--profile", "--config", "--ledger", "--no-color", "--no-scan", "--no-update-check", "--help", "--version"];

function zsh(): string {
  const commands = COMMANDS.map(([name, description]) => `    '${name}:${description}'`).join("\n");
  return `#compdef sinter

_sinter() {
  local -a commands harnesses modes global_args
  commands=(
${commands}
  )
  harnesses=(${HARNESSES.join(" ")})
  modes=(${MODES.join(" ")})
  global_args=(
    '--profile=[use a named profile]:profile'
    '--config=[profile configuration file]:file:_files'
    '--ledger=[ledger database]:file:_files'
    '--no-color[disable ANSI colour]'
    '--no-scan[skip automatic ledger refresh]'
    '--no-update-check[skip the update check]'
    '(-h --help)'{-h,--help}'[show help]'
    '--version[show version]'
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  case $words[2] in
    scan) _arguments $global_args '--harness=[comma-separated harnesses]:harnesses' '--json' ;;
    config) _arguments $global_args '1:action:(show path validate)' '--json' ;;
    ls) _arguments $global_args '--harness=[filter by harness]:harnesses' '--cwd=[filter by directory]:directory:_directories' '--since=[time window]:duration' '--limit=[maximum rows]:count' '--json' '--no-ghost' '--no-sub' ;;
    recent) _arguments $global_args '--harness=[filter by harness]:harnesses' '--cwd=[filter by directory]:directory:_directories' '--since=[time window]:duration' '--limit=[maximum rows]:count' '--json' ;;
    pin) _arguments $global_args '1:session id' ;;
    unpin) _arguments $global_args '1:session id' ;;
    pinned) _arguments $global_args '--harness=[filter by harness]:harnesses' '--cwd=[filter by directory]:directory:_directories' '--since=[time window]:duration' '--limit=[maximum rows]:count' '--json' '--no-ghost' '--no-sub' ;;
    thread) _arguments $global_args '1:session id' '--json' ;;
    projects) _arguments $global_args '--harness=[filter by harness]:harnesses' '--since=[time window]:duration' '--limit=[maximum projects]:count' '--json' ;;
    last) _arguments $global_args '--harness=[filter by harness]:harnesses' '--cwd=[filter by directory]:directory:_directories' '--since=[time window]:duration' '--id' '--json' '--exec' ;;
    search) _arguments $global_args '1:query' '--harness=[filter by harness]:harnesses' '--json' ;;
    rename) _arguments $global_args '1:session id' '2:alias' '--clear' ;;
    show) _arguments $global_args '1:session id' '--json' '--ndjson' '--tail=[latest entries to render]:count' '--tool-chars=[tool result limit]:characters' '--no-sub' ;;
    compare) _arguments $global_args '1:left session id' '2:right session id' '--json' ;;
    export) _arguments $global_args '1:session id' '(-o --output)'{-o,--output}'=[output file]:file:_files' '--slim' ;;
    import) _arguments $global_args '1:SIF file:_files' '--to=[target harness]:harness:($harnesses)' '--cwd=[target directory]:directory:_directories' '--dry-run' '--live-tools' ;;
    port) _arguments $global_args '1:session id' '--to=[target harness]:harness:($harnesses)' '--mode=[transfer mode]:mode:($modes)' '--cwd=[target directory]:directory:_directories' '--preview' '--json' '--dry-run' '--live-tools' ;;
    resume) _arguments $global_args '1:session id' '--in=[target harness]:harness:($harnesses)' '--cwd=[target directory]:directory:_directories' '--exec' '--dry-run' '--live-tools' ;;
    setup) _arguments $global_args '--yes' '--no-menu' ;;
    doctor) _arguments $global_args '--json' '--report' '(-o --output)'{-o,--output}'=[diagnostic report file]:file:_files' ;;
    feedback) _arguments $global_args '--title=[issue title]:title' '--no-open' ;;
    telemetry) _arguments $global_args '1:action:(status enable disable)' '--endpoint=[collector URL]:url' ;;
    gui) _arguments $global_args '--port=[local port]:port' '--no-open' ;;
    relink) _arguments $global_args '--harness=[filter by harness]:harnesses' '--limit=[maximum sessions]:count' '--quiet' ;;
    menu) _arguments $global_args '--all' '--mode=[transfer mode]:mode:($modes)' '--cwd=[initial directory]:directory:_directories' ;;
    completion) _arguments $global_args '1:shell:(zsh bash fish)' ;;
    *) _arguments $global_args ;;
  esac
}

compdef _sinter sinter
`;
}

function bash(): string {
  const names = COMMANDS.map(([name]) => name).join(" ");
  return `_sinter_completion() {
  local current previous command
  COMPREPLY=()
  current="\${COMP_WORDS[COMP_CWORD]}"
  previous="\${COMP_WORDS[COMP_CWORD-1]}"
  command="\${COMP_WORDS[1]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W '${names}' -- "$current") )
    return
  fi
  case "$previous" in
    --to|--in) COMPREPLY=( $(compgen -W '${HARNESSES.join(" ")}' -- "$current") ); return ;;
    --mode) COMPREPLY=( $(compgen -W '${MODES.join(" ")}' -- "$current") ); return ;;
    --cwd|--config|--ledger|-o|--output) COMPREPLY=( $(compgen -f -- "$current") ); return ;;
  esac
  if [[ $command == completion ]]; then
    COMPREPLY=( $(compgen -W 'zsh bash fish' -- "$current") )
    return
  fi
  if [[ $command == config ]]; then
    COMPREPLY=( $(compgen -W 'show path validate --json' -- "$current") )
    return
  fi
  COMPREPLY=( $(compgen -W '${GLOBAL_FLAGS.join(" ")} --harness --cwd --since --limit --json --ndjson --tail --id --to --in --mode --preview --report --output --dry-run --live-tools --exec --no-open' -- "$current") )
}
complete -F _sinter_completion sinter
`;
}

function fish(): string {
  const lines = ["complete -c sinter -f"];
  for (const [name, description] of COMMANDS)
    lines.push(`complete -c sinter -n '__fish_use_subcommand' -a '${name}' -d '${description}'`);
  lines.push(
    `complete -c sinter -n '__fish_seen_subcommand_from port import' -l to -xa '${HARNESSES.join(" ")}' -d 'Target harness'`,
    `complete -c sinter -n '__fish_seen_subcommand_from resume' -l in -xa '${HARNESSES.join(" ")}' -d 'Target harness'`,
    `complete -c sinter -n '__fish_seen_subcommand_from port menu' -l mode -xa '${MODES.join(" ")}' -d 'Transfer mode'`,
    "complete -c sinter -n '__fish_seen_subcommand_from config' -a 'show path validate' -d 'Action'",
    "complete -c sinter -n '__fish_seen_subcommand_from completion' -a 'zsh bash fish' -d 'Shell'",
    "complete -c sinter -n '__fish_seen_subcommand_from port' -l preview -d 'Preview without writing'",
    "complete -c sinter -n '__fish_seen_subcommand_from doctor' -l report -d 'Generate a privacy-safe report'",
    `complete -c sinter -n '__fish_seen_subcommand_from pinned' -l harness -xa '${HARNESSES.join(" ")}' -d 'Filter by harness'`,
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l cwd -r -d 'Filter by directory'",
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l since -r -d 'Filter by age'",
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l limit -r -d 'Maximum rows'",
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l json -d 'Emit versioned JSON'",
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l no-ghost -d 'Hide missing native sessions'",
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l no-sub -d 'Hide subagent sessions'",
    "complete -c sinter -n '__fish_seen_subcommand_from thread' -l json -d 'Emit versioned JSON'",
    "complete -c sinter -n '__fish_seen_subcommand_from show' -l json -d 'Emit one SIF JSON document'",
    "complete -c sinter -n '__fish_seen_subcommand_from show' -l ndjson -d 'Stream versioned transcript records'",
    "complete -c sinter -n '__fish_seen_subcommand_from show' -l tail -r -d 'Latest entries to render'",
    "complete -c sinter -l no-scan -d 'Skip automatic ledger refresh'",
    "complete -c sinter -l no-update-check -d 'Skip the update check'",
    "complete -c sinter -s h -l help -d 'Show help'",
    "complete -c sinter -l version -d 'Show version'",
  );
  return `${lines.join("\n")}\n`;
}

export function completionScript(shell: CompletionShell): string {
  if (shell === "zsh") return zsh();
  if (shell === "bash") return bash();
  return fish();
}
