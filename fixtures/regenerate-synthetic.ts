#!/usr/bin/env bun
/**
 * Replace fixture payload values with deterministic fictional equivalents.
 *
 * It deliberately retains only source-format structure: record types, enum
 * values, array shape, and internal identifier links. No human prompts,
 * command output, local paths, account metadata, timestamps, or opaque
 * provider strings survive. Run before building the committed SQLite fixtures.
 */
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const ids = new Map<string, string>();
let nextId = 1;
let nextText = 1;
let nextTime = 0;

const KEEP = new Set([
  "type", "role", "name", "toolName", "tool_name", "stop_reason", "stopReason",
  "version", "provider", "providerID", "model", "modelID", "agent", "agentName",
  "agentSetting", "mode", "permissionMode", "task_type", "title_source", "status",
  "entrypoint", "caller", "customType", "nativeType", "isSidechain", "isError",
  "synthetic", "userType", "event", "eventType", "source", "kind",
]);
const ID_KEY = /(^id$|_id$|Id$|Uuid$|uuid$|sessionId$|session_id$|callId$|call_id$|parentId$|parent_id$|parentUuid$|toolUseId$|toolUseID$|trace_id$|traceId$)/;
const PATH_KEY = /(?:path|cwd|directory|worktree|root|home|file)$/i;
const TIME_KEY = /(?:timestamp|created|updated|mtime|started|completed|_at)$/i;

function fakeId(value: string): string {
  let id = ids.get(value);
  if (!id) {
    id = `synthetic-${String(nextId++).padStart(4, "0")}`;
    ids.set(value, id);
  }
  return id;
}

function fakeTime(): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, nextTime++)).toISOString();
}

function fakeString(key: string, value: string): string {
  if (KEEP.has(key)) return value;
  if (ID_KEY.test(key)) return fakeId(value);
  if (PATH_KEY.test(key)) return "/workspace/synthetic-project";
  if (TIME_KEY.test(key)) return fakeTime();
  if (key === "signature" || key === "thinkingSignature") return `synthetic-signature-${String(nextText++).padStart(4, "0")}`;
  if (key === "command") return "echo synthetic-fixture";
  if (key === "text" || key === "content" || key === "summary" || key === "title" || key === "firstPrompt" || key === "first_user_message") return `Synthetic fixture text ${nextText++}.`;
  if (key === "data") {
    try { return JSON.stringify(fake(JSON.parse(value))); } catch { /* ordinary string */ }
  }
  return `synthetic-${key}-${nextText++}`;
}

function fake(value: unknown, key = ""): unknown {
  if (typeof value === "string") return fakeString(key, value);
  if (typeof value === "number") return TIME_KEY.test(key) ? 1_767_225_600_000 + nextTime++ * 1_000 : value === 0 ? 0 : 42;
  if (Array.isArray(value)) return value.map((item) => fake(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k.startsWith("/") ? `synthetic-field-${nextText++}` : k, fake(v, k)]),
  );
}

function processJsonFile(path: string): void {
  const source = readFileSync(path, "utf8");
  if (extname(path) === ".jsonl") {
    const lines = source.split(/\r?\n/).filter(Boolean).map((line) => JSON.stringify(fake(JSON.parse(line))));
    writeFileSync(path, `${lines.join("\n")}\n`);
    return;
  }
  writeFileSync(path, `${JSON.stringify(fake(JSON.parse(source)), null, 2)}\n`);
}

function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (extname(path) === ".json" || extname(path) === ".jsonl") processJsonFile(path);
  }
}

walk(root);
for (const [from, to] of [
  [join(root, "claude", "projects", "-workspace-synthetic-project"), join(root, "claude", "projects", "-workspace-synthetic-project")],
  [join(root, "claude", "projects", "-workspace-synthetic"), join(root, "claude", "projects", "-workspace-synthetic")],
  [join(root, "pi", "sessions", "--workspace-synthetic--"), join(root, "pi", "sessions", "--workspace-synthetic--")],
  [join(root, "pi", "sessions", "--workspace-synthetic-project--"), join(root, "pi", "sessions", "--workspace-synthetic-project--")],
]) {
  try { renameSync(from, to); } catch { /* fixture variant absent */ }
}

console.log(`syntheticized ${nextId - 1} identifiers and ${nextText - 1} text fields`);
