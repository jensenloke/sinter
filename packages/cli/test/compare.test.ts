import { describe, expect, test } from "bun:test";
import { session } from "../../ledger/test/mock-adapter";
import { compareSessions, inventorySession } from "../src/compare";

describe("session structural comparison", () => {
  test("inventories entries, content parts, raw records, and models", () => {
    const inventory = inventorySession(session("left"));
    expect(inventory).toMatchObject({
      origin: { harness: "claude", nativeId: "left" },
      sessions: 1,
      entries: 3,
      entriesWithRaw: 3,
      entryKinds: { user: 1, assistant: 1, toolResult: 1 },
      contentParts: { text: 3, thinking: 1, image: 0, toolCall: 1 },
      models: ["sonnet"],
    });
  });

  test("recurses through subsessions and computes right-minus-left deltas", () => {
    const left = session("left");
    left.subsessions = [session("child")];
    const right = session("right");
    right.entries.pop();
    const comparison = compareSessions(left, right);
    expect(comparison.schema).toBe("sinter.compare.v1");
    expect(comparison.left.sessions).toBe(2);
    expect(comparison.delta).toMatchObject({ sessions: -1, entries: -4, entriesWithRaw: -4 });
    expect(comparison.delta.entryKinds.toolResult).toBe(-2);
  });
});
