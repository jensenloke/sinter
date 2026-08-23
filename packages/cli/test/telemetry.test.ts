import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableTelemetry, enableTelemetry, readTelemetryConfig, trackTelemetry } from "../src/telemetry";

const dirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalIsTTY = process.stdout.isTTY;
const envKeys = [
  "SINTER_TELEMETRY_CONFIG",
  "SINTER_TELEMETRY_ENDPOINT",
  "SINTER_TELEMETRY",
  "CI",
  "GITHUB_ACTIONS",
  "BUILDKITE",
  "JENKINS_URL",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function restoreEnvironment(): void {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
  restoreEnvironment();
});

describe("telemetry config", () => {
  test("is disabled until the user explicitly enables it", () => {
    const dir = mkdtempSync(join(tmpdir(), "sinter-telemetry-"));
    dirs.push(dir);
    const path = join(dir, "telemetry.json");
    expect(readTelemetryConfig(path)).toEqual({ enabled: false });
    const enabled = enableTelemetry("https://metrics.example.test/events", path);
    expect(enabled.enabled).toBe(true);
    expect(enabled.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readTelemetryConfig(path)).toEqual(enabled);
    expect(readFileSync(path, "utf8")).not.toContain("cwd");
    expect(readFileSync(path, "utf8")).not.toContain("session");
  });

  test("disable retains the anonymous id but stops collection", () => {
    const dir = mkdtempSync(join(tmpdir(), "sinter-telemetry-"));
    dirs.push(dir);
    const path = join(dir, "telemetry.json");
    const enabled = enableTelemetry(undefined, path);
    const disabled = disableTelemetry(path);
    expect(disabled.enabled).toBe(false);
    expect(disabled.installationId).toBe(enabled.installationId);
  });

  test("an explicit opt-in sends only the documented content-free payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinter-telemetry-"));
    dirs.push(dir);
    const path = join(dir, "telemetry.json");
    process.env.SINTER_TELEMETRY_CONFIG = path;
    for (const key of ["SINTER_TELEMETRY", "CI", "GITHUB_ACTIONS", "BUILDKITE", "JENKINS_URL"] as const)
      delete process.env[key];
    const config = enableTelemetry("https://metrics.example.test/events", path);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    let request: { input: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { input: String(input), init };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    expect(await trackTelemetry("port_success", "0.1.10")).toBe(true);
    expect(request?.input).toBe("https://metrics.example.test/events");
    expect(request?.init?.method).toBe("POST");
    const payload = JSON.parse(String(request?.init?.body));
    expect(Object.keys(payload).sort()).toEqual([
      "arch",
      "event",
      "installationId",
      "occurredAt",
      "platform",
      "schema",
      "version",
    ]);
    expect(payload).toMatchObject({
      schema: 1,
      event: "port_success",
      installationId: config.installationId,
      version: "0.1.10",
    });
    expect(JSON.stringify(payload)).not.toMatch(/cwd|path|prompt|session|title|transcript|repository/i);
  });

  test("non-interactive and CI runs never call the collector", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinter-telemetry-"));
    dirs.push(dir);
    const path = join(dir, "telemetry.json");
    process.env.SINTER_TELEMETRY_CONFIG = path;
    enableTelemetry("https://metrics.example.test/events", path);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    expect(await trackTelemetry("scan", "0.1.10")).toBe(false);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    process.env.CI = "1";
    expect(await trackTelemetry("scan", "0.1.10")).toBe(false);
    expect(calls).toBe(0);
  });
});
