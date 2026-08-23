import { describe, expect, test } from "bun:test";
import type { LedgerRow } from "@sinter/ledger";
import { projectSummaries } from "../src/projects";

const row = (overrides: Partial<LedgerRow> = {}): LedgerRow => ({
  harness: "claude",
  nativeId: "session-1",
  cwd: "/work/alpha",
  updatedAt: "2026-08-20T00:00:00.000Z",
  messageCount: 5,
  isSubagent: false,
  ghost: false,
  ...overrides,
});

describe("project summaries", () => {
  test("groups by cwd and ranks projects by latest activity", () => {
    const projects = projectSummaries([
      row(),
      row({ harness: "codex", nativeId: "session-2", messageCount: 7 }),
      row({ nativeId: "session-3", cwd: "/work/beta", updatedAt: "2026-08-23T00:00:00.000Z" }),
    ]);
    expect(projects.map((project) => project.cwd)).toEqual(["/work/beta", "/work/alpha"]);
    expect(projects[1]).toEqual({
      cwd: "/work/alpha",
      sessionCount: 2,
      messageCount: 12,
      messageCountSessions: 2,
      harnesses: ["claude", "codex"],
      latestAt: "2026-08-20T00:00:00.000Z",
    });
  });

  test("skips rows without a cwd and reports partial message-count coverage", () => {
    const projects = projectSummaries([
      row({ nativeId: "unknown", cwd: undefined }),
      row(),
      row({ nativeId: "session-2", messageCount: undefined }),
    ]);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ sessionCount: 2, messageCount: 5, messageCountSessions: 1 });
  });
});
