import type { HarnessId } from "@sinter/core";
import type { LedgerRow } from "@sinter/ledger";

export const PROJECTS_SCHEMA = "sinter.projects.v1" as const;

export interface ProjectSummary {
  cwd: string;
  sessionCount: number;
  messageCount: number;
  /** Number of sessions whose adapter supplied a message count. */
  messageCountSessions: number;
  harnesses: HarnessId[];
  latestAt?: string;
}

/** Aggregate already-filtered ledger rows without reading transcript bodies. */
export function projectSummaries(rows: LedgerRow[]): ProjectSummary[] {
  const projects = new Map<string, Omit<ProjectSummary, "harnesses"> & { harnesses: Set<HarnessId> }>();

  for (const row of rows) {
    if (!row.cwd) continue;
    let project = projects.get(row.cwd);
    if (!project) {
      project = {
        cwd: row.cwd,
        sessionCount: 0,
        messageCount: 0,
        messageCountSessions: 0,
        harnesses: new Set<HarnessId>(),
      };
      projects.set(row.cwd, project);
    }
    project.sessionCount++;
    project.harnesses.add(row.harness);
    if (row.messageCount !== undefined) {
      project.messageCount += row.messageCount;
      project.messageCountSessions++;
    }
    const activity = row.updatedAt ?? row.createdAt;
    if (activity && (!project.latestAt || activity > project.latestAt)) project.latestAt = activity;
  }

  return [...projects.values()]
    .map((project) => ({ ...project, harnesses: [...project.harnesses].sort() }))
    .sort((a, b) => (b.latestAt ?? "").localeCompare(a.latestAt ?? "") || a.cwd.localeCompare(b.cwd));
}
