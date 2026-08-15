import { describe, expect, test } from "bun:test";
import {
  displayId,
  humanAge,
  palette,
  renderTable,
  shortId,
  shortenPath,
  stripAnsi,
  truncate,
  visibleWidth,
} from "../src/format";

describe("palette", () => {
  test("disabled palette is a no-op, enabled emits ANSI", () => {
    expect(palette(false).red("x")).toBe("x");
    const p = palette(true);
    expect(p.red("x")).not.toBe("x");
    expect(stripAnsi(p.bold(p.red("x")))).toBe("x");
    expect(visibleWidth(p.dim("hello"))).toBe(5);
  });
});

describe("humanAge", () => {
  const now = Date.parse("2026-08-13T12:00:00.000Z");
  test("scales units", () => {
    expect(humanAge("2026-08-13T11:59:30.000Z", now)).toBe("30s");
    expect(humanAge("2026-08-13T11:30:00.000Z", now)).toBe("30m");
    expect(humanAge("2026-08-13T00:00:00.000Z", now)).toBe("12h");
    expect(humanAge("2026-08-08T12:00:00.000Z", now)).toBe("5d");
    expect(humanAge("2026-06-13T12:00:00.000Z", now)).toBe("9w");
    expect(humanAge(undefined, now)).toBe("-");
    expect(humanAge("not a date", now)).toBe("-");
  });
});

describe("shortenPath", () => {
  test("collapses home to ~", () => {
    expect(shortenPath("/Users/test/proj/app", 40, "/Users/test")).toBe("~/proj/app");
  });
  test("elides leading segments when too long", () => {
    const out = shortenPath("/Users/test/a/b/c/d/e/f/g/h/deep", 16, "/Users/test");
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out.startsWith("…")).toBe(true);
  });
  test("undefined is empty", () => {
    expect(shortenPath(undefined)).toBe("");
  });
});

describe("truncate", () => {
  test("collapses whitespace and ellipsises", () => {
    expect(truncate("a  b\nc", 10)).toBe("a b c");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("renderTable", () => {
  test("aligns columns and flexes the last one to the width", () => {
    const out = renderTable(
      [{ header: "ID" }, { header: "N", align: "right" }, { header: "TITLE", flex: true }],
      [
        ["abc", "12", "a fairly long title that must be cut somewhere near the end"],
        ["de", "3", "short"],
      ],
      { width: 30, pal: palette(false) },
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("ID");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(30);
    expect(lines[1]).toMatch(/^abc\s+12\s/);
  });

  test("respects colour without breaking widths", () => {
    const p = palette(true);
    const out = renderTable([{ header: "A" }, { header: "B", flex: true }], [[p.red("xx"), "y"]], {
      width: 20,
      pal: p,
    });
    expect(stripAnsi(out).split("\n")[1]).toMatch(/^xx\s+y$/);
  });
});

describe("shortId", () => {
  test("truncates long native ids only", () => {
    expect(shortId("0199abcd-ef01-7000-8000-000000000000")).toBe("0199abcd");
    expect(shortId("short")).toBe("short");
  });
});

describe("displayId", () => {
  test("keeps subagent ids distinguishable from parent and siblings", () => {
    const parent = "0a45e9b9-fe0d-4b8b-80b4-abc56ed4ef08";
    expect(displayId(parent)).toBe("0a45e9b9");
    const a = displayId(`${parent}/agent-a9e6712e6f9bd37a2`);
    const b = displayId(`${parent}/agent-a8e1e575adc10c63e`);
    expect(a).not.toBe(b);
    expect(a).not.toBe(displayId(parent));
    expect(a.length).toBeLessThanOrEqual(14);
  });
});
