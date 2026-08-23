import { describe, expect, test } from "bun:test";
import { session } from "../../ledger/test/mock-adapter";
import { transcriptNdjson, transcriptRecords } from "../src/ndjson";

describe("transcript NDJSON", () => {
  test("emits metadata followed by ordered entries", () => {
    const source = session("root");
    const records = [...transcriptRecords(source)];
    expect(records[0]).toMatchObject({
      schema: "sinter.transcript.ndjson.v1",
      type: "session",
      session: { id: source.id, origin: source.origin },
    });
    expect(records[0]).not.toHaveProperty("session.entries");
    expect(records.slice(1).map((record) => record.type)).toEqual(["entry", "entry", "entry"]);
    expect(records.filter((record) => record.type === "entry").map((record) => record.index)).toEqual([0, 1, 2]);
  });

  test("links nested sessions and can omit them explicitly", () => {
    const source = session("root");
    source.subsessions = [session("child")];
    const records = [...transcriptRecords(source)];
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "session",
        parentSessionId: source.id,
        session: expect.objectContaining({ id: "sif-child" }),
      }),
    );
    expect([...transcriptRecords(source, { subsessions: false })]).toHaveLength(4);
  });

  test("writes one independently parseable JSON object per line", () => {
    const lines = transcriptNdjson(session("root")).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => JSON.parse(line).schema)).toEqual(
      Array(4).fill("sinter.transcript.ndjson.v1"),
    );
  });
});
