import { describe, expect, test } from "bun:test";
import { UPDATE_CHECK_INTERVAL_MS, isNewerVersion, maybePromptForUpdate } from "../src/update";

describe("isNewerVersion", () => {
  test("compares stable semantic versions", () => {
    expect(isNewerVersion("0.1.5", "0.1.4")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.1.99")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.1.4", "0.1.4")).toBe(false);
    expect(isNewerVersion("0.1.3", "0.1.4")).toBe(false);
  });

  test("handles prereleases and malformed versions conservatively", () => {
    expect(isNewerVersion("1.0.0", "1.0.0-beta.1")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
    expect(isNewerVersion("latest", "0.1.4")).toBe(false);
  });
});

describe("maybePromptForUpdate", () => {
  test("does nothing outside an interactive terminal", async () => {
    let fetched = false;
    const updated = await maybePromptForUpdate("0.1.4", {
      interactive: false,
      fetchLatest: async () => {
        fetched = true;
        return undefined;
      },
    });
    expect(updated).toBe(false);
    expect(fetched).toBe(false);
  });

  test("honours explicit and CI-style disabling", async () => {
    let fetched = false;
    const updated = await maybePromptForUpdate("0.1.4", {
      interactive: true,
      disabled: true,
      fetchLatest: async () => {
        fetched = true;
        return undefined;
      },
    });
    expect(updated).toBe(false);
    expect(fetched).toBe(false);
  });

  test("uses a fresh cache without hitting the registry", async () => {
    let fetched = false;
    let question = "";
    const updated = await maybePromptForUpdate("0.1.4", {
      interactive: true,
      disabled: false,
      now: 10_000,
      readCache: () => ({ checkedAt: 9_000, latest: "0.1.5" }),
      fetchLatest: async () => {
        fetched = true;
        return undefined;
      },
      confirm: async (value) => {
        question = value;
        return false;
      },
    });
    expect(updated).toBe(false);
    expect(fetched).toBe(false);
    expect(question).toContain("0.1.5");
  });

  test("refreshes a stale cache and remembers a declined update", async () => {
    let written: unknown;
    let installed = false;
    const now = UPDATE_CHECK_INTERVAL_MS + 100;
    const updated = await maybePromptForUpdate("0.1.4", {
      interactive: true,
      disabled: false,
      now,
      readCache: () => ({ checkedAt: 0, latest: "0.1.4" }),
      writeCache: (_path, value) => void (written = value),
      fetchLatest: async () => "0.1.5",
      confirm: async () => false,
      install: async () => {
        installed = true;
        return 0;
      },
    });
    expect(updated).toBe(false);
    expect(written).toEqual({ checkedAt: now, latest: "0.1.5", promptedAt: now });
    expect(installed).toBe(false);
  });

  test("does not repeat a declined prompt during the cache interval", async () => {
    let prompted = false;
    const now = 50_000;
    const updated = await maybePromptForUpdate("0.1.4", {
      interactive: true,
      disabled: false,
      now,
      readCache: () => ({ checkedAt: now - 1_000, latest: "0.1.5", promptedAt: now - 1_000 }),
      confirm: async () => {
        prompted = true;
        return false;
      },
    });
    expect(updated).toBe(false);
    expect(prompted).toBe(false);
  });

  test("installs an accepted update and asks the caller to stop", async () => {
    const output: string[] = [];
    let installs = 0;
    const updated = await maybePromptForUpdate("0.1.4", {
      interactive: true,
      disabled: false,
      readCache: () => ({ checkedAt: Date.now(), latest: "0.1.5" }),
      confirm: async () => true,
      install: async () => (installs++, 0),
      out: (message) => output.push(message),
    });
    expect(updated).toBe(true);
    expect(installs).toBe(1);
    expect(output.join("\n")).toContain("Updated Sinter to 0.1.5");
    expect(output.join("\n")).toContain("Run your command again");
  });

  test("reports a failed installer without suppressing the requested command", async () => {
    const output: string[] = [];
    const updated = await maybePromptForUpdate("0.1.4", {
      interactive: true,
      disabled: false,
      readCache: () => ({ checkedAt: Date.now(), latest: "0.1.5" }),
      confirm: async () => true,
      install: async () => 7,
      out: (message) => output.push(message),
    });
    expect(updated).toBe(false);
    expect(output.join("\n")).toContain("bun add --global @jensenloke/sinter@latest");
  });
});
