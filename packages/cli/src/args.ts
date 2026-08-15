/** Tiny argv parser — no deps, per-command flag spec so booleans never eat a positional. */

export class CliError extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

/** Exit codes: 0 ok, 1 error, 2 ambiguous / not found. */
export const EXIT = { OK: 0, ERROR: 1, AMBIGUOUS: 2 } as const;

export interface FlagSpec {
  /** Flags that take no value. */
  booleans?: string[];
  /** Flags that consume the next argv item (or `--flag=value`). */
  strings?: string[];
  /** Short/alternate name → canonical name. */
  alias?: Record<string, string>;
}

export interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean>;
}

const GLOBAL_BOOLEANS = ["help", "no-color", "version"];
const GLOBAL_STRINGS = ["ledger", "profile", "config"];

export function parseArgs(argv: string[], spec: FlagSpec = {}): ParsedArgs {
  const booleans = new Set([...(spec.booleans ?? []), ...GLOBAL_BOOLEANS]);
  const strings = new Set([...(spec.strings ?? []), ...GLOBAL_STRINGS]);
  const alias: Record<string, string> = { h: "help", ...(spec.alias ?? {}) };

  const out: ParsedArgs = { _: [], flags: {} };
  let literal = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (literal) {
      out._.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") {
      out._.push(arg);
      continue;
    }

    const isLong = arg.startsWith("--");
    let name = isLong ? arg.slice(2) : arg.slice(1);
    let inlineValue: string | undefined;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    name = alias[name] ?? name;

    if (booleans.has(name)) {
      if (inlineValue !== undefined && !/^(true|false)$/i.test(inlineValue))
        throw new CliError(`flag --${name} does not take a value`);
      out.flags[name] = inlineValue === undefined ? true : inlineValue.toLowerCase() === "true";
      continue;
    }
    if (strings.has(name)) {
      const value = inlineValue ?? argv[++i];
      if (value === undefined) throw new CliError(`flag --${name} needs a value`);
      out.flags[name] = value;
      continue;
    }
    throw new CliError(`unknown flag: ${isLong ? "--" : "-"}${name}`);
  }
  return out;
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

const SINCE_UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** "7d" | "24h" | "90m" | "2w" | "2026-08-01" | ISO → ISO cutoff timestamp. */
export function parseSince(input: string, now: number = Date.now()): string {
  const rel = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(input.trim());
  if (rel) return new Date(now - Number(rel[1]) * SINCE_UNITS[rel[2]!.toLowerCase()]!).toISOString();

  if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    const d = new Date(`${input.trim()}T00:00:00.000Z`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const d = new Date(input);
  if (!isNaN(d.getTime())) return d.toISOString();
  throw new CliError(`bad --since value: ${input} (try 7d, 24h, 90m, 2w or 2026-08-01)`);
}

const HARNESSES = ["claude", "codex", "opencode", "zcode", "omp", "pi"] as const;
export type KnownHarness = (typeof HARNESSES)[number];

export function parseHarness(input: string): KnownHarness {
  const h = input.trim().toLowerCase();
  if (!(HARNESSES as readonly string[]).includes(h))
    throw new CliError(`unknown harness: ${input} (known: ${HARNESSES.join(", ")})`);
  return h as KnownHarness;
}

export const ALL_HARNESSES: readonly KnownHarness[] = HARNESSES;
