/**
 * The single place harness adapters and configured harness instances are
 * wired up. Adapter modules are imported dynamically so an unavailable
 * package degrades to a diagnostic instead of taking down the CLI.
 */

import {
  DEFAULT_INSTANCE_ID,
  type HarnessAdapter,
  type HarnessId,
  type InstanceId,
  type SessionRef,
  type SifSession,
} from "@sinter/core";
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

export interface AdapterBinding {
  harness: HarnessId;
  instanceId: InstanceId;
  adapter: HarnessAdapter;
  store?: string;
  command?: readonly string[];
  /** Apply an optional configured argv prefix to the native resume argv. */
  resumeCommand(ref: SessionRef): string[];
}

export interface AdapterLoad {
  /** Compatibility alias for `harness`. */
  id: HarnessId;
  harness: HarnessId;
  instanceId: InstanceId;
  binding?: AdapterBinding;
  /** Compatibility access for callers that do not yet need instance metadata. */
  adapter?: HarnessAdapter;
  error?: string;
}

export interface AdapterRegistry {
  /** Every selected instance, loaded or failed, in deterministic order. */
  load(): Promise<AdapterLoad[]>;
  /** Only loaded adapter bindings, retaining their instance identity. */
  bindings(): Promise<AdapterBinding[]>;
  /** Compatibility view containing only loaded adapters. */
  available(): Promise<HarnessAdapter[]>;
  /** Get the sole selected instance for a harness; rejects ambiguity. */
  get(id: HarnessId): Promise<HarnessAdapter>;
  /** Exact tuple lookup for multi-instance callers. */
  getBinding(harness: HarnessId, instanceId: InstanceId): Promise<AdapterBinding>;
  /** Exact tuple lookup returning only the adapter. */
  getInstance(harness: HarnessId, instanceId: InstanceId): Promise<HarnessAdapter>;
  /** Build resume argv through the selected instance's command prefix. */
  resumeCommand(harness: HarnessId, instanceId: InstanceId, ref: SessionRef): Promise<string[]>;
}

interface BindingRequest {
  spec: AdapterSpec;
  instanceId: InstanceId;
  store?: string;
  command?: readonly string[];
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
  const adapter = x as HarnessAdapter | undefined;
  return (
    !!adapter &&
    typeof adapter === "object" &&
    typeof adapter.id === "string" &&
    typeof adapter.detect === "function" &&
    typeof adapter.list === "function" &&
    typeof adapter.read === "function" &&
    typeof adapter.resumeCommand === "function"
  );
}

function configuredAdapter(
  mod: Record<string, unknown>,
  spec: AdapterSpec,
  store: string,
): HarnessAdapter | undefined {
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
  for (const candidate of candidates) {
    if (looksLikeAdapter(candidate)) return candidate;
    if (typeof candidate === "function") {
      try {
        const instance = new (candidate as new () => unknown)();
        if (looksLikeAdapter(instance)) return instance;
      } catch {
        /* not constructible without args — keep looking */
      }
    }
  }
  for (const value of Object.values(mod)) if (looksLikeAdapter(value)) return value;
  return undefined;
}

function stampSession(session: SifSession, harness: HarnessId, instanceId: InstanceId): SifSession {
  return {
    ...session,
    origin: { ...session.origin, harness, instanceId },
    ...(session.subsessions
      ? { subsessions: session.subsessions.map((child) => stampSession(child, harness, instanceId)) }
      : {}),
  };
}

/**
 * Existing scan and command paths intentionally consume HarnessAdapter rather
 * than AdapterBinding. Decorate the raw adapter at the registry boundary so
 * those compatibility paths cannot accidentally collapse two stores from the
 * same harness into the default namespace.
 */
function instanceAdapter(raw: HarnessAdapter, harness: HarnessId, instanceId: InstanceId): HarnessAdapter {
  const read = async (ref: SessionRef, ...args: unknown[]): Promise<SifSession> => {
    const rawRead = raw.read as unknown as (ref: SessionRef, ...args: unknown[]) => Promise<SifSession>;
    const session = await rawRead.call(raw, { ...ref, harness, instanceId }, ...args);
    return stampSession(session, harness, instanceId);
  };
  const bound: HarnessAdapter = {
    id: harness,
    instanceId,
    async detect() {
      const info = await raw.detect();
      return info ? { ...info, harness, instanceId } : null;
    },
    async *list() {
      for await (const summary of raw.list()) yield { ...summary, harness, instanceId };
    },
    read,
    resumeCommand(ref) {
      return raw.resumeCommand({ ...ref, harness, instanceId });
    },
  };
  if (raw.write) {
    bound.write = async (session, opts) => {
      const ref = await raw.write!(session, { ...opts, instanceId });
      return { ...ref, harness, instanceId };
    };
  }
  const carry = (raw as HarnessAdapter & { readWithCarry?: (ref: SessionRef) => Promise<SifSession> }).readWithCarry;
  if (carry) {
    (bound as HarnessAdapter & { readWithCarry: (ref: SessionRef) => Promise<SifSession> }).readWithCarry = async (ref) =>
      stampSession(await carry.call(raw, { ...ref, harness, instanceId }), harness, instanceId);
  }
  return bound;
}

function makeBinding(request: BindingRequest, rawAdapter: HarnessAdapter): AdapterBinding {
  const command = request.command ? [...request.command] : undefined;
  const adapter = instanceAdapter(rawAdapter, request.spec.id, request.instanceId);
  return {
    harness: request.spec.id,
    instanceId: request.instanceId,
    adapter,
    ...(request.store ? { store: request.store } : {}),
    ...(command ? { command } : {}),
    resumeCommand(ref) {
      const native = adapter.resumeCommand({ ...ref, harness: request.spec.id, instanceId: request.instanceId });
      return command ? [...command, ...native.slice(1)] : native;
    },
  };
}

function requestsFor(specs: AdapterSpec[], profile?: SinterProfile): BindingRequest[] {
  if (!profile) return specs.map((spec) => ({ spec, instanceId: DEFAULT_INSTANCE_ID }));

  const specByHarness = new Map(specs.map((spec) => [spec.id, spec]));
  const requests: BindingRequest[] = [];
  for (const [harness, store] of Object.entries(profile.stores)) {
    const spec = specByHarness.get(harness as HarnessId);
    if (spec && store) requests.push({ spec, instanceId: DEFAULT_INSTANCE_ID, store });
  }
  for (const instance of profile.instances ?? []) {
    const spec = specByHarness.get(instance.harness);
    if (spec)
      requests.push({
        spec,
        instanceId: instance.id,
        store: instance.store,
        ...(instance.command ? { command: instance.command } : {}),
      });
  }
  return requests;
}

export class DynamicAdapterRegistry implements AdapterRegistry {
  private cache?: Promise<AdapterLoad[]>;
  private requests: BindingRequest[];

  constructor(specs: AdapterSpec[] = SPECS, profile?: SinterProfile) {
    this.requests = requestsFor(specs, profile);
  }

  load(): Promise<AdapterLoad[]> {
    this.cache ??= Promise.all(this.requests.map((request) => this.loadOne(request)));
    return this.cache;
  }

  private async loadOne(request: BindingRequest): Promise<AdapterLoad> {
    const { spec } = request;
    try {
      const mod = await loadAdapterModule(spec);
      const adapter = request.store ? configuredAdapter(mod, spec, request.store) : pickAdapter(mod);
      if (!adapter)
        return {
          id: spec.id,
          harness: spec.id,
          instanceId: request.instanceId,
          error: `${spec.pkg} exports no HarnessAdapter`,
        };
      if (adapter.id !== spec.id)
        return {
          id: spec.id,
          harness: spec.id,
          instanceId: request.instanceId,
          error: `${spec.pkg} reports id "${adapter.id}"`,
        };
      const binding = makeBinding(request, adapter);
      return {
        id: spec.id,
        harness: spec.id,
        instanceId: request.instanceId,
        binding,
        adapter: binding.adapter,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        id: spec.id,
        harness: spec.id,
        instanceId: request.instanceId,
        error: message.split("\n")[0]!,
      };
    }
  }

  async bindings(): Promise<AdapterBinding[]> {
    return (await this.load()).flatMap((load) => (load.binding ? [load.binding] : []));
  }

  async available(): Promise<HarnessAdapter[]> {
    return (await this.bindings()).map((binding) => binding.adapter);
  }

  async get(id: HarnessId): Promise<HarnessAdapter> {
    const matches = (await this.load()).filter((load) => load.harness === id);
    if (!matches.length) throw new CliError(`adapter not available: ${id} (not selected or not installed)`);
    if (matches.length > 1)
      throw new CliError(
        `multiple ${id} instances are selected (${matches.map((load) => load.instanceId).join(", ")}); specify an instance`,
      );
    const found = matches[0]!;
    if (!found.adapter)
      throw new CliError(`adapter not available: ${id} (${found.error ?? "not installed"})`);
    return found.adapter;
  }

  async getBinding(harness: HarnessId, instanceId: InstanceId): Promise<AdapterBinding> {
    const found = (await this.load()).find(
      (load) => load.harness === harness && load.instanceId === instanceId,
    );
    if (!found)
      throw new CliError(`adapter instance not available: ${harness}@${instanceId} (not selected or not installed)`);
    if (!found.binding)
      throw new CliError(`adapter instance not available: ${harness}@${instanceId} (${found.error ?? "not installed"})`);
    return found.binding;
  }

  async getInstance(harness: HarnessId, instanceId: InstanceId): Promise<HarnessAdapter> {
    return (await this.getBinding(harness, instanceId)).adapter;
  }

  async resumeCommand(harness: HarnessId, instanceId: InstanceId, ref: SessionRef): Promise<string[]> {
    return (await this.getBinding(harness, instanceId)).resumeCommand(ref);
  }
}

export interface StaticAdapterBinding {
  harness?: HarnessId;
  instanceId: InstanceId;
  adapter: HarnessAdapter;
  store?: string;
  command?: readonly string[];
}

/** Registry over already-constructed adapters — used by tests. */
export class StaticAdapterRegistry implements AdapterRegistry {
  private readonly staticBindings: AdapterBinding[];

  constructor(
    adapters: Array<HarnessAdapter | StaticAdapterBinding>,
    private errors: Record<string, string> = {},
  ) {
    this.staticBindings = adapters.map((value) => {
      if (looksLikeAdapter(value))
        return makeBinding(
          { spec: { id: value.id, pkg: "static" }, instanceId: DEFAULT_INSTANCE_ID },
          value,
        );
      const harness = value.harness ?? value.adapter.id;
      return makeBinding(
        {
          spec: { id: harness, pkg: "static" },
          instanceId: value.instanceId,
          ...(value.store ? { store: value.store } : {}),
          ...(value.command ? { command: value.command } : {}),
        },
        value.adapter,
      );
    });
  }

  async load(): Promise<AdapterLoad[]> {
    const output: AdapterLoad[] = this.staticBindings.map((binding) => ({
      id: binding.harness,
      harness: binding.harness,
      instanceId: binding.instanceId,
      binding,
      adapter: binding.adapter,
    }));
    for (const [key, error] of Object.entries(this.errors)) {
      const [harness, instanceId = DEFAULT_INSTANCE_ID] = key.split("@", 2);
      output.push({
        id: harness as HarnessId,
        harness: harness as HarnessId,
        instanceId,
        error,
      });
    }
    return output;
  }

  async bindings(): Promise<AdapterBinding[]> {
    return this.staticBindings;
  }

  async available(): Promise<HarnessAdapter[]> {
    return this.staticBindings.map((binding) => binding.adapter);
  }

  async get(id: HarnessId): Promise<HarnessAdapter> {
    const matches = this.staticBindings.filter((binding) => binding.harness === id);
    if (matches.length === 1) return matches[0]!.adapter;
    if (matches.length > 1)
      throw new CliError(
        `multiple ${id} instances are selected (${matches.map((binding) => binding.instanceId).join(", ")}); specify an instance`,
      );
    throw new CliError(`adapter not available: ${id} (${this.errors[id] ?? "not installed"})`);
  }

  async getBinding(harness: HarnessId, instanceId: InstanceId): Promise<AdapterBinding> {
    const binding = this.staticBindings.find(
      (candidate) => candidate.harness === harness && candidate.instanceId === instanceId,
    );
    if (binding) return binding;
    throw new CliError(
      `adapter instance not available: ${harness}@${instanceId} (${this.errors[`${harness}@${instanceId}`] ?? this.errors[harness] ?? "not installed"})`,
    );
  }

  async getInstance(harness: HarnessId, instanceId: InstanceId): Promise<HarnessAdapter> {
    return (await this.getBinding(harness, instanceId)).adapter;
  }

  async resumeCommand(harness: HarnessId, instanceId: InstanceId, ref: SessionRef): Promise<string[]> {
    return (await this.getBinding(harness, instanceId)).resumeCommand(ref);
  }
}
