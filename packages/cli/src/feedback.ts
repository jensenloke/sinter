import { arch, platform, release } from "node:os";

export const FEEDBACK_REPO = "jensenloke/sinter";

export interface FeedbackDiagnostics {
  sinterVersion: string;
  bunVersion: string;
  platform: string;
  detectedHarnesses: string[];
}

export function feedbackDiagnostics(version: string, detectedHarnesses: string[] = []): FeedbackDiagnostics {
  return {
    sinterVersion: version,
    bunVersion: Bun.version,
    platform: `${platform()} ${release()} (${arch()})`,
    detectedHarnesses: [...detectedHarnesses].sort(),
  };
}

export function feedbackUrl(diagnostics: FeedbackDiagnostics, title = ""): string {
  const body = [
    "## What happened?",
    "",
    "<!-- Please describe the bug or idea. Do not paste private transcript content. -->",
    "",
    "## Safe diagnostics",
    "",
    `- Sinter: ${diagnostics.sinterVersion}`,
    `- Bun: ${diagnostics.bunVersion}`,
    `- Platform: ${diagnostics.platform}`,
    `- Detected harnesses: ${diagnostics.detectedHarnesses.join(", ") || "none"}`,
    "",
    "<!-- No paths, session IDs, prompts, or transcripts were collected. -->",
  ].join("\n");
  const params = new URLSearchParams({ body });
  if (title.trim()) params.set("title", title.trim());
  return `https://github.com/${FEEDBACK_REPO}/issues/new?${params}`;
}

export function browserCommand(url: string, os: NodeJS.Platform = process.platform): string[] {
  if (os === "darwin") return ["open", url];
  if (os === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}
