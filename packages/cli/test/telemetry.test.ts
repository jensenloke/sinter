import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableTelemetry, enableTelemetry, readTelemetryConfig } from "../src/telemetry";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
});
