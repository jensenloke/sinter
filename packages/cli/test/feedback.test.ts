import { describe, expect, test } from "bun:test";
import { browserCommand, feedbackUrl } from "../src/feedback";

describe("feedback", () => {
  test("builds a prefilled issue without private session data", () => {
    const url = new URL(
      feedbackUrl({
        sinterVersion: "0.1.9",
        bunVersion: "1.3.14",
        platform: "darwin 25 arm64",
        detectedHarnesses: ["codex", "claude"],
      }, "Port failed"),
    );
    expect(url.origin + url.pathname).toBe("https://github.com/jensenloke/sinter/issues/new");
    expect(url.searchParams.get("title")).toBe("Port failed");
    expect(url.searchParams.get("body")).toContain("Sinter: 0.1.9");
    expect(url.searchParams.get("body")).toContain("Detected harnesses: codex, claude");
    expect(url.searchParams.get("body")).not.toContain("nativeId");
    expect(url.searchParams.get("body")).not.toContain("cwd");
  });

  test("selects the platform browser command", () => {
    expect(browserCommand("https://example.test", "darwin")).toEqual(["open", "https://example.test"]);
    expect(browserCommand("https://example.test", "linux")).toEqual(["xdg-open", "https://example.test"]);
    expect(browserCommand("https://example.test", "win32")).toEqual(["cmd", "/c", "start", "", "https://example.test"]);
  });
});
