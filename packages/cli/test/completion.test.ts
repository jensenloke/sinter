import { describe, expect, test } from "bun:test";
import { completionScript } from "../src/completion";

describe("shell completions", () => {
  test.each(["zsh", "bash", "fish"] as const)("generates %s completions", (shell) => {
    const script = completionScript(shell);
    expect(script).toContain("sinter");
    expect(script).toContain("completion");
    expect(script).toContain("port");
    expect(script).toContain("compare");
    expect(script).toContain("feedback");
    expect(script).toContain("login");
    expect(script).toContain("whoami");
    expect(script).toContain("logout");
    expect(script).toContain("devices");
    expect(script).toContain("approve");
    expect(script).toContain("gui");
    expect(script).toContain("recent");
    expect(script).toContain("watch");
    expect(script).toContain("projects");
    expect(script).toContain("pinned");
    expect(script).toContain("thread");
    expect(script).toContain("capabilities");
    expect(script).toContain("ghosts");
    expect(script).toContain("view");
    expect(script).toContain("untag");
    expect(script).toContain("tags");
    expect(script).toContain("note");
    expect(script).toContain("unpin");
    expect(script).toContain("last");
    expect(script).toContain("config");
    expect(script).toContain("preview");
    expect(script).toContain("report");
    expect(script).toContain("ndjson");
    expect(script).toContain("tail");
    expect(script).toContain("codex");
    expect(script).toContain("compact");
    expect(script).not.toContain("/Users/");
    expect(script).not.toContain("nativeId");
  });

  test("zsh output is a native compdef function", () => {
    expect(completionScript("zsh")).toStartWith("#compdef sinter");
    expect(completionScript("zsh")).toContain("compdef _sinter sinter");
  });

  test("bash output registers a completion function", () => {
    expect(completionScript("bash")).toContain("complete -F _sinter_completion sinter");
  });

  test("fish output uses scoped complete declarations", () => {
    expect(completionScript("fish")).toContain("__fish_use_subcommand");
    expect(completionScript("fish")).toContain("-l mode");
  });
});
