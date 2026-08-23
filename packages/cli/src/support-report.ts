import { arch, platform, release } from "node:os";

export interface SupportHarnessStatus {
  harness: string;
  adapter: "available" | "unavailable";
  store: "ok" | "absent" | "error" | "not-checked";
  version?: string;
  ledgerSessions: number;
  ghostSessions: number;
}

export interface SupportReport {
  generatedAt: string;
  sinterVersion: string;
  bunVersion: string;
  platform: string;
  profileConfigured: boolean;
  ledgerAvailable: boolean;
  harnesses: SupportHarnessStatus[];
}

export function supportPlatform(): string {
  return `${platform()} ${release()} (${arch()})`;
}

function cell(value: string | number): string {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Render diagnostics that are safe to inspect before attaching to an issue. */
export function renderSupportReport(report: SupportReport): string {
  const lines = [
    "# Sinter diagnostic report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "> Privacy: this report excludes paths, session IDs, prompts, titles, transcripts, and adapter error details.",
    "",
    "## Runtime",
    "",
    `- Sinter: ${report.sinterVersion}`,
    `- Bun: ${report.bunVersion}`,
    `- Platform: ${report.platform}`,
    `- Named profile configured: ${report.profileConfigured ? "yes" : "no"}`,
    `- Ledger readable: ${report.ledgerAvailable ? "yes" : "no"}`,
    "",
    "## Harness health",
    "",
    "| Harness | Adapter | Store | Version | Sessions | Ghosts |",
    "|---|---|---|---|---:|---:|",
    ...report.harnesses.map(
      (h) =>
        `| ${cell(h.harness)} | ${h.adapter} | ${h.store} | ${cell(h.version ?? "-")} | ${h.ledgerSessions} | ${h.ghostSessions} |`,
    ),
    "",
  ];
  return lines.join("\n");
}
