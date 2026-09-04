import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "@sinter/adapter-claude";
import { CodexAdapter } from "@sinter/adapter-codex";
import { OpencodeAdapter } from "@sinter/adapter-opencode";
import { provenanceOf, validateSession, type SifSession } from "@sinter/core";
import { Ledger } from "@sinter/ledger";
import { StaticAdapterRegistry } from "../src/adapters";
import type { Ctx } from "../src/commands";
import { palette } from "../src/format";
import { run } from "../src/main";
import { compactSession } from "../src/transfer";

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
    expect(stderr.join("\n")).toContain("auto → full (target unknown)");
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

describe("Codex → Claude compact port fidelity", () => {
  test("empty encrypted Codex compactions become non-empty Claude summaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "sinter-compact-fidelity-"));
    tempDirs.push(root);
    const sourcePath = join(root, "rollout-2026-08-31T00-00-00-019f8adc-bad0-75d1-9cab-c5e1f306f0d8.jsonl");
    const records = [
      { timestamp: "2026-08-31T00:00:00.000Z", type: "session_meta", payload: { id: "codex-compact", session_id: "codex-compact", cwd: "/tmp/source", model_provider: "openai" } },
      {
        timestamp: "2026-08-31T00:00:01.000Z",
        type: "compacted",
        payload: {
          message: "",
          replacement_history: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the workflow editor" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } },
            { type: "compaction", encrypted_content: "encrypted-blob-value" },
          ],
        },
      },
      { timestamp: "2026-08-31T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Current state" }] } },
    ];
    writeFileSync(sourcePath, records.map((record) => JSON.stringify(record)).join("\n"));

    const source = await new CodexAdapter({ home: root }).readFile(sourcePath);
    const compacted = compactSession(source).session;
    const target = new ClaudeAdapter({ root: join(root, "claude") });
    const written = await target.write(compacted, { cwd: "/tmp/target", mode: "compact" });
    const native = readFileSync(written.nativePath!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const users = native.filter((record) => record.type === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.isCompactSummary).toBe(true);
    expect(users[0]!.message.content).toContain("Continue the workflow editor");
    expect(users[0]!.message.content.trim()).not.toBe("");
    expect(JSON.stringify(users[0])).not.toContain("encrypted-blob-value");
  });
});
