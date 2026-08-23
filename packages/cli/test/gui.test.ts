import { afterEach, describe, expect, test } from "bun:test";
import { Ledger } from "@sinter/ledger";
import { StaticAdapterRegistry } from "../src/adapters";
import type { Ctx } from "../src/commands";
import { palette } from "../src/format";
import { startGuiServer } from "../src/gui";
import { MockAdapter, session, summary } from "../../ledger/test/mock-adapter";

const servers: ReturnType<typeof startGuiServer>["server"][] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function guiHarness(): Ctx {
  const ledger = new Ledger(":memory:");
  const adapter = new MockAdapter({
    id: "claude",
    summaries: [summary({ nativeId: "gui-1", title: "GUI design session" })],
    sessions: { "gui-1": session("gui-1") },
  });
  ledger.upsert(adapter.summaries[0]!);
  ledger.addTags("claude", "gui-1", ["design"]);
  ledger.setNote("claude", "gui-1", "review tomorrow");
  return {
    registry: new StaticAdapterRegistry([adapter]),
    ledger: () => ledger,
    out: () => {},
    err: () => {},
    pal: palette(false),
    width: 100,
    now: Date.now(),
    writeFile: async () => {},
    readFile: async () => "",
  };
}

describe("local GUI server", () => {
  test("serves the shell but token-protects session data", async () => {
    const launched = startGuiServer(guiHarness(), { token: "test-token", port: 0 });
    servers.push(launched.server);
    const base = `http://127.0.0.1:${launched.server.port}`;
    const shell = await fetch(`${base}/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("local session workspace");
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    const response = await fetch(`${base}/api/sessions?token=test-token`);
    expect(response.status).toBe(200);
    const body = await response.json() as { threads: { tip: { title: string; tags: string[]; note: string } }[] };
    expect(body.threads[0]!.tip.title).toBe("GUI design session");
    expect(body.threads[0]!.tip.tags).toEqual(["design"]);
    expect(body.threads[0]!.tip.note).toBe("review tomorrow");
  });

  test("renders transcript data without exposing adapter raw records", async () => {
    const launched = startGuiServer(guiHarness(), { token: "test-token", port: 0 });
    servers.push(launched.server);
    const base = `http://127.0.0.1:${launched.server.port}`;
    const response = await fetch(`${base}/api/session?harness=claude&id=gui-1&token=test-token`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("assistant");
    expect(text).not.toContain('"raw"');
    expect(text).not.toContain('"nativePath"');
  });

  test("token-protects and validates actions before dispatch", async () => {
    const actions: unknown[] = [];
    const launched = startGuiServer(guiHarness(), {
      token: "test-token",
      port: 0,
      onAction: async (action) => {
        actions.push(action);
        return { code: 0, out: "ported", err: "" };
      },
    });
    servers.push(launched.server);
    const base = `http://127.0.0.1:${launched.server.port}`;
    const request = (body: unknown, token = "test-token") => fetch(`${base}/api/action?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await request({ action: "port" }, "wrong-token")).status).toBe(401);
    expect((await request({ action: "delete", harness: "claude", nativeId: "gui-1" })).status).toBe(400);
    expect(actions).toEqual([]);

    const response = await request({
      action: "port",
      harness: "claude",
      nativeId: "gui-1",
      target: "codex",
      mode: "compact",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 0, out: "ported", err: "" });
    expect(actions).toEqual([{
      action: "port",
      harness: "claude",
      nativeId: "gui-1",
      target: "codex",
      mode: "compact",
    }]);
  });

  test("fails closed when actions are unavailable and handles unknown routes", async () => {
    const launched = startGuiServer(guiHarness(), { token: "test-token", port: 0 });
    servers.push(launched.server);
    const base = `http://127.0.0.1:${launched.server.port}`;
    const unavailable = await fetch(`${base}/api/action?token=test-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resume", harness: "claude", nativeId: "gui-1" }),
    });
    expect(unavailable.status).toBe(501);
    expect((await fetch(`${base}/missing?token=test-token`)).status).toBe(404);
    expect((await fetch(`${base}/api/session?token=test-token`)).status).toBe(400);
  });
});
