/**
 * The single place the six harness adapters are wired up.
 *
 * Adapters are imported DYNAMICALLY, one try/catch each: a package that does
 * not exist yet (or fails to load) degrades to "adapter not available: <name>"
 * instead of taking the whole CLI down. Adding a harness = one row in SPECS.
 */

import type { HarnessAdapter, HarnessId } from "@sinter/core";
import { CliError } from "./args";

import type { SinterProfile } from "./config";

export interface AdapterSpec {
  id: HarnessId;
  pkg: string;
}

export const SPECS: AdapterSpec[] = [
  { id: "claude", pkg: "@sinter/adapter-claude" },
  { id: "codex", pkg: "@sinter/adapter-codex" },
  { id: "devin", pkg: "@sinter/adapter-devin" },
  { id: "opencode", pkg: "@sinter/adapter-opencode" },
  { id: "zcode", pkg: "@sinter/adapter-zcode" },
  { id: "omp", pkg: "@sinter/adapter-omp" },
  { id: "pi", pkg: "@sinter/adapter-pi" },
];

export interface AdapterLoad {
  id: HarnessId;
  adapter?: HarnessAdapter;
  error?: string;
}

export interface AdapterRegistry {
  /** Every spec, loaded or failed, in SPECS order. */
  load(): Promise<AdapterLoad[]>;
  /** Only the adapters that loaded. */
  available(): Promise<HarnessAdapter[]>;
  /** Throws a CliError naming the harness when it is unavailable. */
  get(id: HarnessId): Promise<HarnessAdapter>;
}

async function loadAdapterModule(spec: AdapterSpec): Promise<Record<string, unknown>> {
  const expected = SPECS.find((candidate) => candidate.id === spec.id)?.pkg;
  if (spec.pkg !== expected) return import(spec.pkg);

  switch (spec.id) {
    case "claude":
      return import("@sinter/adapter-claude");
    case "codex":
      return import("@sinter/adapter-codex");
    case "devin":
      return import("@sinter/adapter-devin");
    case "opencode":
      return import("@sinter/adapter-opencode");
    case "zcode":
      return import("@sinter/adapter-zcode");
    case "omp":
      return import("@sinter/adapter-omp");
    case "pi":
      return import("@sinter/adapter-pi");
  }
}

function looksLikeAdapter(x: unknown): x is HarnessAdapter {
  const a = x as HarnessAdapter | undefined;
  return (
    !!a &&
    typeof a === "object" &&
    typeof a.id === "string" &&
    typeof a.detect === "function" &&
    typeof a.list === "function" &&
    typeof a.read === "function" &&
    typeof a.resumeCommand === "function"
  );
}


function profileAdapter(mod: Record<string, unknown>, spec: AdapterSpec, profile: SinterProfile | undefined): HarnessAdapter | undefined {
  const store = profile?.stores[spec.id];
  if (!store) return undefined;
  const exported: Record<HarnessId, string> = {
    claude: "ClaudeAdapter",
    codex: "CodexAdapter",
    devin: "DevinAdapter",
    opencode: "OpencodeAdapter",
    zcode: "ZcodeAdapter",
    omp: "OmpAdapter",
    pi: "PiAdapter",
  };
  const candidate = mod[exported[spec.id]];
  if (typeof candidate !== "function") return undefined;
  const options =
    spec.id === "claude"
      ? { root: store }
      : spec.id === "codex"
        ? { home: store }
        : spec.id === "devin"
          ? { dbPath: store }
          : spec.id === "omp" || spec.id === "pi"
            ? { sessionsDir: store }
            : store;
  try {
    const instance = Reflect.construct(candidate, [options]);
    return looksLikeAdapter(instance) ? instance : undefined;
  } catch {
    return undefined;
  }
}

/** Accept a default export, a named `adapter`, or any adapter-shaped export. */
export function pickAdapter(mod: Record<string, unknown>): HarnessAdapter | undefined {
  const candidates: unknown[] = [mod.default, (mod as { adapter?: unknown }).adapter];
  for (const c of candidates) {
    if (looksLikeAdapter(c)) return c;
    // a default-exported class: instantiate it
    if (typeof c === "function") {
      try {
        const inst = new (c as new () => unknown)();
        if (looksLikeAdapter(inst)) return inst;
      } catch {
        /* not constructible without args — keep looking */
      }
    }
  }
  for (const v of Object.values(mod)) if (looksLikeAdapter(v)) return v;
  return undefined;
}

export class DynamicAdapterRegistry implements AdapterRegistry {
  private cache?: Promise<AdapterLoad[]>;
  constructor(private specs: AdapterSpec[] = SPECS, private profile?: SinterProfile) {}

  load(): Promise<AdapterLoad[]> {
    this.cache ??= Promise.all(this.specs.map((spec) => this.loadOne(spec)));
    return this.cache;
  }

  private async loadOne(spec: AdapterSpec): Promise<AdapterLoad> {
    try {
      const mod = await loadAdapterModule(spec);
      const adapter = profileAdapter(mod, spec, this.profile) ?? pickAdapter(mod);
      if (!adapter) return { id: spec.id, error: `${spec.pkg} exports no HarnessAdapter` };
      if (adapter.id !== spec.id)
        return { id: spec.id, error: `${spec.pkg} reports id "${adapter.id}"` };
      return { id: spec.id, adapter };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: spec.id, error: msg.split("\n")[0]! };
    }
  }

  async available(): Promise<HarnessAdapter[]> {
    return (await this.load()).flatMap((l) => (l.adapter ? [l.adapter] : []));
  }

  async get(id: HarnessId): Promise<HarnessAdapter> {
    const found = (await this.load()).find((l) => l.id === id);
    if (!found) throw new CliError(`unknown harness: ${id}`);
    if (!found.adapter)
      throw new CliError(`adapter not available: ${id} (${found.error ?? "not installed"})`);
    return found.adapter;
  }
}

/** Registry over already-constructed adapters — used by tests. */
export class StaticAdapterRegistry implements AdapterRegistry {
  constructor(
    private adapters: HarnessAdapter[],
    private errors: Record<string, string> = {},
  ) {}

  async load(): Promise<AdapterLoad[]> {
    const out: AdapterLoad[] = this.adapters.map((a) => ({ id: a.id, adapter: a }));
    for (const [id, error] of Object.entries(this.errors)) out.push({ id: id as HarnessId, error });
    return out;
  }
  async available(): Promise<HarnessAdapter[]> {
    return this.adapters;
  }
  async get(id: HarnessId): Promise<HarnessAdapter> {
    const a = this.adapters.find((x) => x.id === id);
    if (a) return a;
    throw new CliError(`adapter not available: ${id} (${this.errors[id] ?? "not installed"})`);
  }
}
