import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validateSession } from "@sinter/core";
import type { AssistantEntry, NoteEntry, SessionSummary, ToolResultEntry, UserEntry } from "@sinter/core";
import { ZcodeAdapter } from "../src/index";

const FIXTURE_DB = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "zcode", "mini.db");

const SESS_TINY = "synthetic-0011";
const SESS_RICH = "synthetic-0002";

async function listAll(adapter: ZcodeAdapter): Promise<SessionSummary[]> {
  const out: SessionSummary[] = [];
  for await (const s of adapter.list()) out.push(s);
  return out;
}

describe("zcode adapter — offline fixture tests", () => {
  test("detect() returns null when the store path does not exist", async () => {
    const adapter = new ZcodeAdapter("/nonexistent/zcode/db.sqlite");
    expect(await adapter.detect()).toBeNull();
  });

  test("detect() finds the fixture store", async () => {
    const adapter = new ZcodeAdapter(FIXTURE_DB);
    const info = await adapter.detect();
    expect(info).not.toBeNull();
    expect(info?.harness).toBe("zcode");
    expect(info?.paths).toContain(FIXTURE_DB);
  });

  test("resumeCommand() returns a best-guess argv (unverified)", () => {
    const adapter = new ZcodeAdapter(FIXTURE_DB);
    expect(adapter.resumeCommand({ harness: "zcode", nativeId: SESS_TINY })).toEqual([
      "zcode",
      "--resume",
      SESS_TINY,
    ]);
  });

  test("list() enumerates both fixture sessions cheaply, with message counts and usage rollup", async () => {
    const adapter = new ZcodeAdapter(FIXTURE_DB);
    const rows = await listAll(adapter);
    expect(rows).toHaveLength(2);

    const tiny = rows.find((r) => r.nativeId === SESS_TINY)!;
    expect(tiny).toBeDefined();
    expect(tiny.cwd).toBe("/workspace/synthetic-project");
    expect(tiny.messageCount).toBeGreaterThan(0);
    expect(tiny.usage).toBeUndefined();

    const rich = rows.find((r) => r.nativeId === SESS_RICH)!;
    expect(rich).toBeDefined();
    expect(rich.cwd).toBe("/workspace/synthetic-project");
    expect(rich.messageCount).toBeGreaterThan(0);
    expect(rich.usage?.input).toBeGreaterThan(0);
    expect(rich.usage?.output).toBeGreaterThan(0);
  });

  test("read() on the tiny error session: empty assistant content falls back to the error, usage omitted", async () => {
    const adapter = new ZcodeAdapter(FIXTURE_DB);
    const session = await adapter.read({ harness: "zcode", nativeId: SESS_TINY });
    expect(() => validateSession(session)).not.toThrow();

    expect(session.title?.text).toMatch(/^Synthetic fixture text/);
    expect(session.title?.source).toBe("derived");
    expect(session.usage).toBeUndefined();

    expect(session.entries.length).toBeGreaterThan(1);
    const [user, assistant] = session.entries as [UserEntry, AssistantEntry];
    expect(user.kind).toBe("user");
    expect(assistant.kind).toBe("assistant");
    expect(assistant.stopReason).toBe("error");
    expect(assistant.usage).toBeUndefined();
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content[0]).toMatchObject({ type: "text" });
  });

  test("read() on the rich session: sequence ordering, tool call/result pairing, turn_usage token attachment", async () => {
    const adapter = new ZcodeAdapter(FIXTURE_DB);
    const session = await adapter.read({ harness: "zcode", nativeId: SESS_RICH });
    expect(() => validateSession(session)).not.toThrow();

    expect(session.title?.source).toBe("auto"); // title_source: generated

    // Session-level usage rollup from turn_usage across both turns.
    expect(session.usage?.input).toBeGreaterThan(0);
    expect(session.usage?.output).toBeGreaterThan(0);


    // todo_reminder: providerVisibility is "visible" (the model does see it,
    // it's only hidden from the human UI) so per the fidelity rule it stays
    // a conversational UserEntry rather than becoming a NoteEntry — but
    // semantics.origin ("agent_runtime", not "real_user") marks it synthetic.
    const todoEntry = session.entries.find(
      (e) => e.kind === "user" && (e as UserEntry).synthetic,
    ) as UserEntry | undefined;
    expect(todoEntry).toBeDefined();

    const checkpointNote = session.entries.find(
      (e) => e.kind === "note" && (e as NoteEntry).noteType === "runtime/workspace_checkpoint",
    ) as NoteEntry | undefined;
    expect(checkpointNote).toBeDefined();
    const parent = session.entries.find((e) => e.id === checkpointNote?.parentId);
    expect(parent?.kind).toBe("user");

    const toolResults = session.entries.filter((e) => e.kind === "toolResult") as ToolResultEntry[];
    expect(toolResults.length).toBeGreaterThan(0);
    for (const tr of toolResults) {
      const parentEntry = session.entries.find((e) => e.id === tr.parentId) as AssistantEntry | undefined;
      expect(parentEntry?.kind).toBe("assistant");
      const call = parentEntry?.content.find((p) => p.type === "toolCall" && p.callId === tr.callId);
      expect(call).toBeDefined();
      if (call?.type === "toolCall") expect(call.name).toBe(tr.toolName);
    }

    // Sequence ordering: parentId chain should walk back to a root (null)
    // without cycles, and entries should be internally consistent (already
    // exercised by validateSession above, but assert non-triviality here).
    const roots = session.entries.filter((e) => e.parentId === null);
    expect(roots.length).toBeGreaterThan(0);
  });
});
