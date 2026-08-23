import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export type TelemetryEvent = "first_run" | "scan" | "port_success" | "resume" | "gui_open";

export interface TelemetryConfig {
  enabled: boolean;
  installationId?: string;
  endpoint?: string;
}

export function telemetryConfigPath(): string {
  return process.env.SINTER_TELEMETRY_CONFIG ??
    join(process.env.SINTER_HOME ?? join(homedir(), ".sinter"), "telemetry.json");
}

export function readTelemetryConfig(path = telemetryConfigPath()): TelemetryConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TelemetryConfig>;
    return {
      enabled: parsed.enabled === true,
      installationId: typeof parsed.installationId === "string" ? parsed.installationId : undefined,
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : undefined,
    };
  } catch {
    return { enabled: false };
  }
}

export function writeTelemetryConfig(config: TelemetryConfig, path = telemetryConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function enableTelemetry(endpoint?: string, path = telemetryConfigPath()): TelemetryConfig {
  const current = readTelemetryConfig(path);
  const config: TelemetryConfig = {
    enabled: true,
    installationId: current.installationId ?? crypto.randomUUID(),
    endpoint: endpoint ?? current.endpoint,
  };
  writeTelemetryConfig(config, path);
  return config;
}

export function disableTelemetry(path = telemetryConfigPath()): TelemetryConfig {
  const current = readTelemetryConfig(path);
  const config = { ...current, enabled: false };
  writeTelemetryConfig(config, path);
  return config;
}

function isAutomated(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.BUILDKITE ||
    process.env.JENKINS_URL ||
    process.env.SINTER_TELEMETRY === "0"
  );
}

export async function trackTelemetry(event: TelemetryEvent, version: string): Promise<boolean> {
  if (isAutomated() || !process.stdout.isTTY) return false;
  const config = readTelemetryConfig();
  const endpoint = process.env.SINTER_TELEMETRY_ENDPOINT ?? config.endpoint;
  if (!config.enabled || !config.installationId || !endpoint) return false;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: 1,
        event,
        installationId: config.installationId,
        version,
        platform: platform(),
        arch: arch(),
        occurredAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}
