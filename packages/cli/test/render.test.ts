import { describe, expect, test } from "bun:test";
import type { SifSession } from "@sinter/core";
import { palette } from "../src/format";
import { renderTranscript, slimSession } from "../src/render";
import { session } from "../../ledger/test/mock-adapter";

const pal = palette(false);

describe("renderTranscript", () => {
  test("renders header, roles, tool calls and truncated results", () => {
    const out = renderTranscript(session("s1"), { pal, width: 80 });
    expect(out).toContain("a mock session");
    expect(out).toContain("claude:s1");
    expect(out).toContain("▸ user");
    expect(out).toContain("hello world");
    expect(out).toContain("● assistant");
    expect(out).toContain("pondering"); // thinking kept (dim in colour mode)
    expect(out).toContain('→ Read({"file":"/tmp/x"})');
    expect(out).toContain("⤶ Read");
    expect(out).toContain("line1");
  });

  test("clips long tool results", () => {
    const s = session("s2");
    (s.entries[2] as { content: { type: "text"; text: string }[] }).content = [
      { type: "text", text: "x".repeat(5000) },
    ];
    const out = renderTranscript(s, { pal, width: 80, toolResultChars: 50 });
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(2000);
  });

  test("marks compactions, model changes, notes and subsessions", () => {
    const s: SifSession = {
      ...session("s3"),
      entries: [
        { kind: "compaction", id: "c", parentId: null, summary: "we talked about ports" },
        { kind: "modelChange", id: "m", parentId: "c", provider: "anthropic", model: "opus" },
        { kind: "note", id: "n", parentId: "m", noteType: "hook", text: "PreToolUse fired" },
        {
          kind: "subsession",
          id: "sub",
          parentId: "n",
          sessionRef: "agent-1",
          agentName: "Explore",
          resultText: "found it",
        },
      ],
    };
    const out = renderTranscript(s, { pal, width: 80 });
    expect(out).toContain("— compaction —");
    expect(out).toContain("we talked about ports");
    expect(out).toContain("model → anthropic/opus");
    expect(out).toContain("· hook: PreToolUse fired");
    expect(out).toContain("⌥ subagent Explore");
    expect(out).toContain("found it");
  });

  test("renders nested subsessions and can skip them", () => {
    const s: SifSession = { ...session("s4"), subsessions: [session("sub-1")] };
    expect(renderTranscript(s, { pal, width: 80 })).toContain("┌─ subsession sub-1");
    expect(renderTranscript(s, { pal, width: 80, subsessions: false })).not.toContain("┌─ subsession");
  });

  test("tails root and nested sessions while preserving total counts", () => {
    const child = session("sub-tail");
    (child.entries[0] as { content: { type: "text"; text: string }[] }).content = [
      { type: "text", text: "child first entry" },
    ];
    (child.entries[2] as { content: { type: "text"; text: string }[] }).content = [
      { type: "text", text: "child final entry" },
    ];
    const s: SifSession = { ...session("tail"), subsessions: [child] };
    const out = renderTranscript(s, { pal, width: 80, tailEntries: 1 });
    expect(out).toContain("3 entries");
    expect(out).toContain("showing last 1 entry");
    expect(out).not.toContain("hello world");
    expect(out).not.toContain("child first entry");
    expect(out).toContain("child final entry");
    expect(out).toContain("3 entries, showing last 1 entry");
  });

  test("colour mode wraps output in ANSI but keeps the text", () => {
    const out = renderTranscript(session("s5"), { pal: palette(true), width: 80 });
    expect(out).toContain("\x1b[");
    expect(out).toContain("hello world");
  });
});

describe("slimSession", () => {
  test("strips raw everywhere, keeps everything else", () => {
    const s: SifSession = { ...session("s6"), subsessions: [session("sub")] };
    const slim = slimSession(s);
    expect(slim.entries.every((e) => !("raw" in e))).toBe(true);
    expect(slim.subsessions![0]!.entries.every((e) => !("raw" in e))).toBe(true);
    expect(slim.entries).toHaveLength(s.entries.length);
    expect(slim.title).toEqual(s.title);
    // source untouched
    expect(s.entries[0]!.raw).toBeDefined();
  });
});
