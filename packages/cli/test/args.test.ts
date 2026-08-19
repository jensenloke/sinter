import { describe, expect, test } from "bun:test";
import { CliError, parseArgs, parseHarness, parseSince, flagBool, flagString } from "../src/args";

describe("parseArgs", () => {
  const spec = { strings: ["harness", "output"], booleans: ["json", "slim"], alias: { o: "output" } };

  test("positionals, string flags and booleans", () => {
    const a = parseArgs(["abc123", "--harness", "codex", "--json", "-o", "out.json"], spec);
    expect(a._).toEqual(["abc123"]);
    expect(flagString(a, "harness")).toBe("codex");
    expect(flagBool(a, "json")).toBe(true);
    expect(flagString(a, "output")).toBe("out.json");
    expect(flagBool(a, "slim")).toBe(false);
  });

  test("--flag=value form", () => {
    const a = parseArgs(["--harness=omp", "--slim=false"], spec);
    expect(flagString(a, "harness")).toBe("omp");
    expect(flagBool(a, "slim")).toBe(false);
  });

  test("a boolean never swallows the next positional", () => {
    const a = parseArgs(["--json", "query", "words"], spec);
    expect(a._).toEqual(["query", "words"]);
  });

  test("-- ends flag parsing", () => {
    const a = parseArgs(["--json", "--", "--not-a-flag"], spec);
    expect(a._).toEqual(["--not-a-flag"]);
  });

  test("unknown flags and missing values are errors", () => {
    expect(() => parseArgs(["--nope"], spec)).toThrow(CliError);
    expect(() => parseArgs(["--harness"], spec)).toThrow(/needs a value/);
    expect(() => parseArgs(["--json=loud"], spec)).toThrow(/does not take a value/);
  });

  test("global flags are always accepted", () => {
    const a = parseArgs(["--ledger", "/tmp/x.db", "--no-color", "--help"], spec);
    expect(flagString(a, "ledger")).toBe("/tmp/x.db");
    expect(flagBool(a, "no-color")).toBe(true);
    expect(flagBool(a, "help")).toBe(true);
  });
});

describe("parseSince", () => {
  const now = Date.parse("2026-08-13T12:00:00.000Z");
  test("relative units", () => {
    expect(parseSince("24h", now)).toBe("2026-08-12T12:00:00.000Z");
    expect(parseSince("7d", now)).toBe("2026-08-06T12:00:00.000Z");
    expect(parseSince("90m", now)).toBe("2026-08-13T10:30:00.000Z");
    expect(parseSince("2w", now)).toBe("2026-07-30T12:00:00.000Z");
  });
  test("absolute dates", () => {
    expect(parseSince("2026-08-01", now)).toBe("2026-08-01T00:00:00.000Z");
    expect(parseSince("2026-08-01T06:30:00.000Z", now)).toBe("2026-08-01T06:30:00.000Z");
  });
  test("garbage is an error", () => {
    expect(() => parseSince("soonish", now)).toThrow(/bad --since/);
  });
});

describe("parseHarness", () => {
  test("accepts known harnesses, rejects others", () => {
    expect(parseHarness("Codex")).toBe("codex");
    expect(parseHarness("Devin")).toBe("devin");
    expect(() => parseHarness("cursor")).toThrow(/unknown harness/);
  });
});
