import { afterEach, describe, expect, test } from "bun:test";
import { decodeCliFlow, encodeCliFlow, validateLoopbackCallback } from "../src/lib/cli-flow";

const previous = process.env.SINTER_CLI_FLOW_SECRET;
afterEach(() => { process.env.SINTER_CLI_FLOW_SECRET = previous; });

describe("CLI browser flow cookies", () => {
  test("round-trips a signed, short-lived loopback flow", () => {
    process.env.SINTER_CLI_FLOW_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
    const flow = { callback: "http://127.0.0.1:49152/callback", state: "a".repeat(43), createdAt: Date.now() };
    expect(decodeCliFlow(encodeCliFlow(flow))).toEqual(flow);
  });

  test("rejects tampering and non-loopback callbacks", () => {
    process.env.SINTER_CLI_FLOW_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
    const flow = { callback: "http://127.0.0.1:49152/callback", state: "b".repeat(43), createdAt: Date.now() };
    expect(decodeCliFlow(`${encodeCliFlow(flow)}x`)).toBeUndefined();
    expect(() => validateLoopbackCallback("https://evil.example/callback")).toThrow("127.0.0.1");
    expect(() => validateLoopbackCallback("http://127.0.0.1:49152/other")).toThrow("127.0.0.1");
  });
});
