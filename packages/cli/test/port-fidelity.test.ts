import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeAdapter } from "@sinter/adapter-opencode";
import { CodexAdapter } from "@sinter/adapter-codex";
import { provenanceOf, validateSession, type SifSession } from "@sinter/core";
import { Ledger } from "@sinter/ledger";
import { StaticAdapterRegistry } from "../src/adapters";
import type { Ctx } from "../src/commands";
import { palette } from "../src/format";
import { run } from "../src/main";

const OPEN_CODE_DB = join(import.meta.dir, "../../../fixtures/opencode/mini.db");
const SOURCE_ID = "synthetic-1401";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function conversationText(session: SifSession): string[] {
  return session.entries
    .filter((entry) => entry.kind === "user" || entry.kind === "assistant")
    .flatMap((entry) => entry.content)
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean);
}

describe("OpenCode → Codex port fidelity (issue #1)", () => {
  test("the native Codex rollout retains resumable conversation context", async () => {
    const targetHome = mkdtempSync(join(tmpdir(), "sinter-port-fidelity-"));
    tempDirs.push(targetHome);
    const source = new OpencodeAdapter(OPEN_CODE_DB);
    const target = new CodexAdapter({ home: targetHome });
    const ledger = new Ledger(":memory:");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx: Ctx = {
      registry: new StaticAdapterRegistry([source, target]),
      ledger: () => ledger,
      out: (line) => stdout.push(line),
      err: (line) => stderr.push(line),
      pal: palette(false),
      width: 100,
      now: Date.parse("2026-08-24T00:00:00.000Z"),
      writeFile: async () => {},
      readFile: async () => "",
      version: "0.1.10-test",
    };

    const sourceHash = Bun.hash(await Bun.file(OPEN_CODE_DB).arrayBuffer());
    expect(await run(["scan"], ctx)).toBe(0);
    stdout.length = 0;
    stderr.length = 0;
    expect(await run(["port", SOURCE_ID, "--to", "codex"], ctx)).toBe(0);
    expect(stderr.join("\n").toLowerCase()).not.toContain("error");

    const targetRow = ledger.list({ harness: "codex", includeGhost: true })[0];
    expect(targetRow).toBeDefined();
    expect(targetRow!.nativePath).toBeTruthy();
    expect(ledger.resolve(`codex:${targetRow!.nativeId}`).row?.nativeId).toBe(targetRow!.nativeId);

    const original = await source.read({ harness: "opencode", nativeId: SOURCE_ID });
    const resumed = await target.read({
      harness: "codex",
      nativeId: targetRow!.nativeId,
      nativePath: targetRow!.nativePath,
    });
    validateSession(resumed);
    const resumedText = conversationText(resumed).join("\n");
    for (const text of conversationText(original)) expect(resumedText).toContain(text);

    expect(provenanceOf(resumed)?.chain.map((hop) => hop.harness)).toEqual(["opencode", "codex"]);
    expect(target.resumeCommand(targetRow!)).toEqual(["codex", "resume", targetRow!.nativeId]);
    expect(Bun.hash(await Bun.file(OPEN_CODE_DB).arrayBuffer())).toBe(sourceHash);

    const carried = await target.readWithCarry({
      harness: "codex",
      nativeId: targetRow!.nativeId,
      nativePath: targetRow!.nativePath,
    });
    expect(carried.entries).toEqual(original.entries);
    ledger.close();
  });
});
