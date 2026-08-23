import type { HarnessAdapter, HarnessId } from "@sinter/core";
import { SPECS, type AdapterRegistry } from "./adapters";

export const CAPABILITIES_SCHEMA = "sinter.capabilities.v1";

export type StoreCapability = "detected" | "absent" | "error" | "not-checked";
export type ResumeCapability = "available" | "binary-missing" | "unverified" | "unavailable";

export interface AdapterCapability {
  harness: HarnessId;
  adapter: "available" | "unavailable";
  store: StoreCapability;
  read: boolean;
  write: boolean;
  resume: ResumeCapability;
  resumeBinary?: string;
  limitations: string[];
}

export interface CapabilityOptions {
  /** TUI startup can skip store I/O while sharing every other capability rule. */
  detectStores?: boolean;
  which?: (binary: string) => string | null | undefined;
}

function resumeBinary(adapter: HarnessAdapter): string | undefined {
  try {
    const binary = adapter.resumeCommand({ harness: adapter.id, nativeId: "probe" })[0];
    return binary || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve support from adapter behavior, with explicit overrides for known product limits. */
export async function adapterCapabilities(
  registry: AdapterRegistry,
  options: CapabilityOptions = {},
): Promise<AdapterCapability[]> {
  const detectStores = options.detectStores ?? true;
  const which = options.which ?? ((binary: string) => Bun.which(binary));
  const loads = await registry.load();

  return Promise.all(
    SPECS.map(async ({ id }): Promise<AdapterCapability> => {
      const adapter = loads.find((load) => load.id === id)?.adapter;
      if (!adapter) {
        return {
          harness: id,
          adapter: "unavailable",
          store: "not-checked",
          read: false,
          write: false,
          resume: "unavailable",
          limitations: ["adapter package unavailable"],
        };
      }

      let store: StoreCapability = "not-checked";
      if (detectStores) {
        try {
          store = (await adapter.detect()) ? "detected" : "absent";
        } catch {
          store = "error";
        }
      }

      const binary = resumeBinary(adapter);
      const write = typeof adapter.write === "function";
      const limitations: string[] = [];
      let resume: ResumeCapability;

      if (id === "zcode") {
        resume = "unverified";
        limitations.push("read-only adapter", "native resume command is unverified");
      } else if (!binary) {
        resume = "unavailable";
        limitations.push("adapter did not provide a native resume command");
      } else if (!which(binary)) {
        resume = "binary-missing";
        limitations.push(`${binary} is not on PATH`);
      } else {
        resume = "available";
      }

      if (!write && id !== "zcode") limitations.unshift("read-only adapter");
      if (store === "absent") limitations.push("local store not detected");
      if (store === "error") limitations.push("local store detection failed");

      return {
        harness: id,
        adapter: "available",
        store,
        read: true,
        write,
        resume,
        ...(binary ? { resumeBinary: binary } : {}),
        limitations,
      };
    }),
  );
}
