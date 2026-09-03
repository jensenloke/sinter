export type CompletionShell = "zsh" | "bash" | "fish";

const COMMANDS = [
  ["help", "show command or topic help"],
  ["version", "print the CLI version"],
  ["scan", "refresh the local ledger"],
  ["login", "sign in to Sinter Cloud"],
  ["whoami", "show the current Cloud identity"],
  ["logout", "remove the current Cloud login"],
  ["devices", "manage Cloud device identities"],
  ["cloud", "sync encrypted session capsules"],
  ["config", "inspect and validate profile configuration"],
  ["ls", "list sessions"],
  ["recent", "list recent resumable sessions"],
  ["watch", "refresh a live local session view"],
  ["pin", "bookmark a session locally"],
  ["unpin", "remove a local bookmark"],
  ["pinned", "list bookmarked sessions"],
  ["tag", "add searchable local session tags"],
  ["untag", "remove local session tags"],
  ["tags", "list local session tags"],
  ["note", "set a searchable local session note"],
  ["ghosts", "preview or prune disposable ghost rows"],
  ["ledger", "back up, verify, or repair the local ledger"],
  ["view", "manage reusable local session filters"],
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
  ["send", "send an encrypted session directly"],
  ["receive", "receive an encrypted session directly"],
  ["resume", "print or run a native resume command"],
  ["setup", "detect stores and build the ledger"],
  ["update", "install the latest published CLI build"],
  ["doctor", "report store and ledger health"],
  ["capabilities", "show adapter support matrix"],
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
const GLOBAL_FLAGS = ["--profile", "--config", "--ledger", "--no-color", "--no-scan", "--no-update-check", "--no-backup", "--help", "--version"];

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
    config) _arguments $global_args '1:action:(show path validate example discover-shell)' '--shell=[absolute zsh/bash executable]:shell:_files' '--write[create config only if missing]' '--yes[confirm non-interactive config creation]' '--json[emit versioned JSON]' ;;
    login) _arguments $global_args '--no-open' '--timeout=[callback lifetime]:duration' '--json' ;;
    whoami|logout) _arguments $global_args '--json' ;;
    devices) _arguments $global_args '1:action:(register list rename revoke pending approve capsule-test)' '2:operation, device, or request id:(create open)' '3:device name' '--name=[device name]:name' '--output=[new synthetic capsule file]:file:_files' '--input=[synthetic capsule file]:file:_files' '--no-wait[return approval-required without polling]' '--timeout=[approval wait, 5s to 15m]:duration' '--yes[confirm permanent revocation]' '--json' ;;
    cloud) _arguments $global_args '1:action:(push list ls inspect pull delete rm)' '2:session prefix or capsule id' '--mode=[transfer mode]:mode:($modes)' '--repo-remote=[source Git remote name]:remote' '--to=[recipient device or target harness instance]:target' '--cwd=[target repository root]:directory:_directories' '--preview[prepare without uploading]' '--allow-repo-mismatch[explicit repository mismatch override]' '--allow-missing-commit[explicit missing-commit override]' '--dry-run[validate target write without consuming replay]' '--yes[confirm pull or deletion]' '--json[emit versioned JSON]' ;;
    ls) _arguments $global_args '--harness=[filter by harness]:harnesses' '--cwd=[filter by directory]:directory:_directories' '--since=[time window]:duration' '--limit=[maximum rows]:count' '--json' '--no-ghost' '--no-sub' ;;
    recent) _arguments $global_args '--harness=[filter by harness]:harnesses' '--cwd=[filter by directory]:directory:_directories' '--since=[time window]:duration' '--limit=[maximum rows]:count' '--json' ;;
    watch) _arguments $global_args '1:view:(recent projects)' '--interval=[refresh interval]:duration' '--count=[snapshot count]:count' '--harness=[filter by harness]:harnesses' '--cwd=[filter by directory]:directory:_directories' '--since=[time window]:duration' '--limit=[maximum rows]:count' '--json' '--no-clear' ;;
    pin) _arguments $global_args '1:session id' ;;
    unpin) _arguments $global_args '1:session id' ;;
    pinned) _arguments $global_args '--harness=[filter by harness]:harnesses' '--cwd=[filter by directory]:directory:_directories' '--since=[time window]:duration' '--limit=[maximum rows]:count' '--json' '--no-ghost' '--no-sub' ;;
    tag) _arguments $global_args '1:session id' '*:tag' ;;
    untag) _arguments $global_args '1:session id' '*:tag' '--all' ;;
    tags) _arguments $global_args '--json' ;;
    note) _arguments $global_args '1:session id' '*:note text' '--clear' ;;
    ghosts) _arguments $global_args '1:action:(preview prune)' '--older-than=[minimum ghost age]:duration' '--harness=[filter by harness]:harness:($harnesses)' '--json' '--yes' ;;
    ledger) _arguments $global_args '1:action:(backup verify repair)' '--output=[backup file]:file:_files' '--yes' '--no-backup' '--json' ;;
    view) _arguments $global_args '1:action:(save list show run delete)' '2:view name' '--harness=[filter by harness]:harnesses' '--all-harnesses' '--cwd=[filter by directory]:directory:_directories' '--all-cwd' '--since=[time window]:duration' '--all-time' '--limit=[maximum rows]:count' '--ghosts' '--no-ghosts' '--subagents' '--no-subagents' '--force' '--json' ;;
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
    send) _arguments $global_args '1:session id' '--to=[one-use transfer locator]:locator' '--mode=[transfer mode]:mode:($modes)' '--repo-remote=[source Git remote name]:remote' '--preview' '--json' ;;
    receive) _arguments $global_args '--to=[target harness instance]:instance' '--bind=[listen address]:address' '--advertise=[LAN or Tailscale address]:address' '--port=[listen port]:port' '--ttl=[locator lifetime]:duration' '--cwd=[target repository root]:directory:_directories' '--allow-repo-mismatch[explicit context-only mismatch override]' '--allow-missing-commit[explicit missing-commit override]' '--yes[accept after repository checks]' '--json' ;;
    resume) _arguments $global_args '1:session id' '--in=[target harness]:harness:($harnesses)' '--cwd=[target directory]:directory:_directories' '--exec' '--dry-run' '--live-tools' ;;
    setup) _arguments $global_args '--yes' '--no-menu' ;;
    update) _arguments $global_args '--check[check without installing]' '--package-manager=[global installer]:package manager:(bun npm)' '--force[allow installing an older published version]' '--json[emit versioned JSON]' ;;
    doctor) _arguments $global_args '--json' '--report' '(-o --output)'{-o,--output}'=[diagnostic report file]:file:_files' ;;
    capabilities) _arguments $global_args '--harness=[filter by harness]:harness:($harnesses)' '--json' ;;
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
    --package-manager) COMPREPLY=( $(compgen -W 'bun npm' -- "$current") ); return ;;
    --cwd|--config|--ledger|--shell|--input|-o|--output) COMPREPLY=( $(compgen -f -- "$current") ); return ;;
  esac
  if [[ $command == completion ]]; then
    COMPREPLY=( $(compgen -W 'zsh bash fish' -- "$current") )
    return
  fi
  if [[ $command == config ]]; then
    COMPREPLY=( $(compgen -W 'show path validate example discover-shell --shell --write --yes --json' -- "$current") )
    return
  fi
  if [[ $command == devices ]]; then
    COMPREPLY=( $(compgen -W 'register list rename revoke pending approve capsule-test create open --name --output --input --no-wait --timeout --yes --json' -- "$current") )
    return
  fi
  if [[ $command == cloud ]]; then
    COMPREPLY=( $(compgen -W 'push list ls inspect pull delete rm --mode --repo-remote --to --cwd --preview --allow-repo-mismatch --allow-missing-commit --dry-run --yes --json full slim compact all' -- "$current") )
    return
  fi
  if [[ $command == update ]]; then
    COMPREPLY=( $(compgen -W '--check --package-manager --force --json bun npm' -- "$current") )
    return
  fi
  if [[ $command == send ]]; then
    COMPREPLY=( $(compgen -W '--to --mode --repo-remote --preview --json' -- "$current") )
    return
  fi
  if [[ $command == receive ]]; then
    COMPREPLY=( $(compgen -W '--to --cwd --bind --advertise --port --ttl --allow-repo-mismatch --allow-missing-commit --yes --json' -- "$current") )
    return
  fi
  COMPREPLY=( $(compgen -W '${GLOBAL_FLAGS.join(" ")} --harness --all-harnesses --cwd --all-cwd --since --all-time --older-than --interval --count --limit --json --ndjson --tail --id --to --in --mode --preview --report --output --dry-run --live-tools --exec --no-open --yes --ghosts --no-ghosts --subagents --no-subagents --force --all --clear --no-clear' -- "$current") )
}
complete -F _sinter_completion sinter
`;
}

function fish(): string {
  const lines = ["complete -c sinter -f"];
  for (const [name, description] of COMMANDS)
    lines.push(`complete -c sinter -n '__fish_use_subcommand' -a '${name}' -d '${description}'`);
  lines.push(
    `complete -c sinter -n '__fish_seen_subcommand_from port import receive' -l to -xa '${HARNESSES.join(" ")}' -d 'Target harness or instance'`,
    "complete -c sinter -n '__fish_seen_subcommand_from send' -l to -r -d 'One-use transfer locator'",
    `complete -c sinter -n '__fish_seen_subcommand_from send' -l mode -xa '${MODES.join(" ")}' -d 'Transfer mode'`,
    "complete -c sinter -n '__fish_seen_subcommand_from send' -l repo-remote -r -d 'Source Git remote name'",
    "complete -c sinter -n '__fish_seen_subcommand_from receive' -l bind -r -d 'Listen address'",
    "complete -c sinter -n '__fish_seen_subcommand_from receive' -l advertise -r -d 'LAN or Tailscale address'",
    "complete -c sinter -n '__fish_seen_subcommand_from receive' -l port -r -d 'Listen port'",
    "complete -c sinter -n '__fish_seen_subcommand_from receive' -l ttl -r -d 'Locator lifetime'",
    "complete -c sinter -n '__fish_seen_subcommand_from receive' -l cwd -r -d 'Target repository root'",
    "complete -c sinter -n '__fish_seen_subcommand_from receive' -l allow-repo-mismatch -d 'Explicit context-only mismatch override'",
    "complete -c sinter -n '__fish_seen_subcommand_from receive' -l allow-missing-commit -d 'Explicit missing-commit override'",
    "complete -c sinter -n '__fish_seen_subcommand_from receive' -l yes -d 'Accept after repository checks'",
    `complete -c sinter -n '__fish_seen_subcommand_from resume' -l in -xa '${HARNESSES.join(" ")}' -d 'Target harness'`,
    `complete -c sinter -n '__fish_seen_subcommand_from port menu' -l mode -xa '${MODES.join(" ")}' -d 'Transfer mode'`,
    "complete -c sinter -n '__fish_seen_subcommand_from config' -a 'show path validate example discover-shell' -d 'Action'",
    "complete -c sinter -n '__fish_seen_subcommand_from config' -l shell -r -d 'Absolute zsh/bash executable'",
    "complete -c sinter -n '__fish_seen_subcommand_from config' -l write -d 'Create config only if missing'",
    "complete -c sinter -n '__fish_seen_subcommand_from config' -l yes -d 'Confirm non-interactive config creation'",
    "complete -c sinter -n '__fish_seen_subcommand_from config' -l json -d 'Emit versioned JSON'",
    "complete -c sinter -n '__fish_seen_subcommand_from devices' -a 'register list rename revoke pending approve capsule-test' -d 'Action'",
    "complete -c sinter -n '__fish_seen_subcommand_from devices' -a 'create open' -d 'Capsule diagnostic operation'",
    "complete -c sinter -n '__fish_seen_subcommand_from devices' -l output -r -d 'New synthetic capsule file'",
    "complete -c sinter -n '__fish_seen_subcommand_from devices' -l input -r -d 'Synthetic capsule file'",
    "complete -c sinter -n '__fish_seen_subcommand_from devices' -l name -r -d 'Device name'",
    "complete -c sinter -n '__fish_seen_subcommand_from devices' -l no-wait -d 'Return approval-required without polling'",
    "complete -c sinter -n '__fish_seen_subcommand_from devices' -l timeout -r -d 'Approval wait, 5s to 15m'",
    "complete -c sinter -n '__fish_seen_subcommand_from devices' -l yes -d 'Confirm permanent revocation'",
    "complete -c sinter -n '__fish_seen_subcommand_from devices' -l json -d 'Emit versioned JSON'",
    "complete -c sinter -n '__fish_seen_subcommand_from cloud' -a 'push list ls inspect pull delete rm' -d 'Cloud capsule action'",
    `complete -c sinter -n '__fish_seen_subcommand_from cloud' -l mode -xa '${MODES.join(" ")}' -d 'Transfer mode'`,
    "complete -c sinter -n '__fish_seen_subcommand_from cloud' -l repo-remote -r -d 'Source Git remote name'",
    "complete -c sinter -n '__fish_seen_subcommand_from cloud' -l to -r -d 'Recipient device or target harness instance'",
    "complete -c sinter -n '__fish_seen_subcommand_from cloud' -l cwd -r -d 'Target repository root'",
    "complete -c sinter -n '__fish_seen_subcommand_from cloud' -l preview -d 'Prepare without uploading'",
    "complete -c sinter -n '__fish_seen_subcommand_from cloud' -l allow-repo-mismatch -d 'Explicit repository mismatch override'",
    "complete -c sinter -n '__fish_seen_subcommand_from cloud' -l allow-missing-commit -d 'Explicit missing-commit override'",
    "complete -c sinter -n '__fish_seen_subcommand_from cloud' -l dry-run -d 'Validate without consuming replay'",
    "complete -c sinter -n '__fish_seen_subcommand_from cloud' -l yes -d 'Confirm pull or deletion'",
    "complete -c sinter -n '__fish_seen_subcommand_from cloud' -l json -d 'Emit versioned JSON'",
    "complete -c sinter -n '__fish_seen_subcommand_from completion' -a 'zsh bash fish' -d 'Shell'",
    "complete -c sinter -n '__fish_seen_subcommand_from update' -l check -d 'Check without installing'",
    "complete -c sinter -n '__fish_seen_subcommand_from update' -l package-manager -xa 'bun npm' -d 'Global installer'",
    "complete -c sinter -n '__fish_seen_subcommand_from update' -l force -d 'Allow an older published version'",
    "complete -c sinter -n '__fish_seen_subcommand_from update' -l json -d 'Emit versioned JSON'",
    "complete -c sinter -n '__fish_seen_subcommand_from port' -l preview -d 'Preview without writing'",
    "complete -c sinter -n '__fish_seen_subcommand_from doctor' -l report -d 'Generate a privacy-safe report'",
    `complete -c sinter -n '__fish_seen_subcommand_from capabilities' -l harness -xa '${HARNESSES.join(" ")}' -d 'Filter by harness'`,
    "complete -c sinter -n '__fish_seen_subcommand_from capabilities' -l json -d 'Emit versioned JSON'",
    `complete -c sinter -n '__fish_seen_subcommand_from pinned' -l harness -xa '${HARNESSES.join(" ")}' -d 'Filter by harness'`,
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l cwd -r -d 'Filter by directory'",
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l since -r -d 'Filter by age'",
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l limit -r -d 'Maximum rows'",
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l json -d 'Emit versioned JSON'",
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l no-ghost -d 'Hide missing native sessions'",
    "complete -c sinter -n '__fish_seen_subcommand_from pinned' -l no-sub -d 'Hide subagent sessions'",
    "complete -c sinter -n '__fish_seen_subcommand_from watch' -a 'recent projects' -d 'View'",
    "complete -c sinter -n '__fish_seen_subcommand_from watch' -l interval -r -d 'Refresh interval'",
    "complete -c sinter -n '__fish_seen_subcommand_from watch' -l count -r -d 'Snapshot count'",
    `complete -c sinter -n '__fish_seen_subcommand_from watch' -l harness -xa '${HARNESSES.join(" ")}' -d 'Filter by harness'`,
    "complete -c sinter -n '__fish_seen_subcommand_from watch' -l cwd -r -d 'Filter by directory'",
    "complete -c sinter -n '__fish_seen_subcommand_from watch' -l since -r -d 'Filter by age'",
    "complete -c sinter -n '__fish_seen_subcommand_from watch' -l limit -r -d 'Maximum rows'",
    "complete -c sinter -n '__fish_seen_subcommand_from watch' -l json -d 'Emit NDJSON snapshots'",
    "complete -c sinter -n '__fish_seen_subcommand_from watch' -l no-clear -d 'Do not redraw the terminal'",
    "complete -c sinter -n '__fish_seen_subcommand_from untag' -l all -d 'Remove all tags'",
    "complete -c sinter -n '__fish_seen_subcommand_from tags' -l json -d 'Emit versioned JSON'",
    "complete -c sinter -n '__fish_seen_subcommand_from note' -l clear -d 'Clear the note'",
    "complete -c sinter -n '__fish_seen_subcommand_from ghosts' -a 'preview prune' -d 'Action'",
    `complete -c sinter -n '__fish_seen_subcommand_from ghosts' -l harness -xa '${HARNESSES.join(" ")}' -d 'Filter by harness'`,
    "complete -c sinter -n '__fish_seen_subcommand_from ghosts' -l older-than -r -d 'Minimum ghost age'",
    "complete -c sinter -n '__fish_seen_subcommand_from ghosts' -l json -d 'Emit versioned JSON'",
    "complete -c sinter -n '__fish_seen_subcommand_from ghosts' -l yes -d 'Confirm pruning'",
    "complete -c sinter -n '__fish_seen_subcommand_from ledger' -a 'backup verify repair' -d 'Action'",
    "complete -c sinter -n '__fish_seen_subcommand_from ledger' -l output -r -d 'Backup file'",
    "complete -c sinter -n '__fish_seen_subcommand_from ledger' -l yes -d 'Confirm repair'",
    "complete -c sinter -n '__fish_seen_subcommand_from ledger' -l no-backup -d 'Do not create a repair backup'",
    "complete -c sinter -n '__fish_seen_subcommand_from ledger' -l json -d 'Emit versioned JSON'",
    "complete -c sinter -n '__fish_seen_subcommand_from view' -a 'save list show run delete' -d 'Action'",
    `complete -c sinter -n '__fish_seen_subcommand_from view' -l harness -xa '${HARNESSES.join(" ")}' -d 'Filter by harness'`,
    "complete -c sinter -n '__fish_seen_subcommand_from view' -l all-harnesses -d 'Clear the saved harness filter'",
    "complete -c sinter -n '__fish_seen_subcommand_from view' -l cwd -r -d 'Filter by directory'",
    "complete -c sinter -n '__fish_seen_subcommand_from view' -l all-cwd -d 'Clear the saved directory filter'",
    "complete -c sinter -n '__fish_seen_subcommand_from view' -l since -r -d 'Filter by age'",
    "complete -c sinter -n '__fish_seen_subcommand_from view' -l all-time -d 'Clear the saved recency filter'",
    "complete -c sinter -n '__fish_seen_subcommand_from view' -l limit -r -d 'Maximum rows'",
    "complete -c sinter -n '__fish_seen_subcommand_from view' -l ghosts -d 'Include ghost rows'",
    "complete -c sinter -n '__fish_seen_subcommand_from view' -l subagents -d 'Include subagents'",
    "complete -c sinter -n '__fish_seen_subcommand_from view' -l force -d 'Replace an existing view'",
    "complete -c sinter -n '__fish_seen_subcommand_from view' -l json -d 'Emit versioned JSON'",
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
