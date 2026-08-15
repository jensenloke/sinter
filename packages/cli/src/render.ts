/** Human-first transcript rendering for `sinter show`. */

import type { SifEntry, SifSession } from "@sinter/core";
import { palette, shortenPath, truncate, type Palette } from "./format";

export interface RenderOpts {
  width?: number;
  pal?: Palette;
  /** Max chars of a tool result to show (0 = just a size marker). */
  toolResultChars?: number;
  /** Render nested subagent sessions inline. */
  subsessions?: boolean;
}

const textOf = (parts: { type: string; text?: string }[] | undefined): string =>
  (parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");

function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

function argsPreview(args: unknown, max: number): string {
  if (args === undefined || args === null) return "";
  const s = typeof args === "string" ? args : JSON.stringify(args);
  return truncate(s, max);
}

export function renderHeader(s: SifSession, opts: RenderOpts = {}): string {
  const pal = opts.pal ?? palette(false);
  const lines = [
    `${pal.bold(s.title?.text ?? "(untitled)")}`,
    pal.dim(
      `${s.origin.harness}:${s.origin.nativeId}  ${shortenPath(s.cwd, 60)}` +
        (s.git?.branch ? `  [${s.git.branch}]` : "") +
        (s.updatedAt ? `  ${s.updatedAt}` : ""),
    ),
    pal.dim(
      `${s.entries.length} entries` +
        (s.subsessions?.length ? `, ${s.subsessions.length} subsession(s)` : "") +
        (s.usage?.input || s.usage?.output
          ? `  tokens ${s.usage.input ?? 0}in/${s.usage.output ?? 0}out`
          : ""),
    ),
    "",
  ];
  return lines.join("\n");
}

export function renderEntry(e: SifEntry, opts: RenderOpts = {}): string {
  const pal = opts.pal ?? palette(false);
  const width = opts.width ?? 100;
  const resultChars = opts.toolResultChars ?? 240;

  switch (e.kind) {
    case "user": {
      const body = textOf(e.content) || "(no text)";
      const tag = e.synthetic ? pal.dim("▸ user (synthetic)") : pal.bold(pal.cyan("▸ user"));
      return `${tag}\n${indent(body, "  ")}`;
    }
    case "assistant": {
      const model = e.model?.id ? pal.dim(` (${e.model.id})`) : "";
      const out: string[] = [`${pal.bold(pal.green("● assistant"))}${model}`];
      for (const p of e.content) {
        if (p.type === "thinking") {
          out.push(pal.dim(indent(truncate(p.thinking, width * 4), "  ")));
        } else if (p.type === "text") {
          if (p.text.trim()) out.push(indent(p.text, "  "));
        } else if (p.type === "toolCall") {
          const args = argsPreview(p.args, Math.max(20, width - p.name.length - 8));
          out.push(pal.yellow(`  → ${p.name}(${args})`));
        } else if (p.type === "image") {
          out.push(pal.dim(`  [image ${p.mimeType}]`));
        }
      }
      if (e.usage?.output) out.push(pal.dim(`  ${e.usage.output} out tokens`));
      return out.join("\n");
    }
    case "toolResult": {
      const body = textOf(e.content);
      const lines = body.split("\n");
      const head = truncate(body, resultChars);
      const more = body.length > resultChars ? pal.dim(` …(${lines.length} lines)`) : "";
      const marker = e.isError ? pal.red("  ⤶ error") : pal.dim(`  ⤶ ${e.toolName}`);
      return `${marker} ${pal.dim(head)}${more}`;
    }
    case "compaction": {
      const s = e.summary ? `\n${indent(truncate(e.summary, 2000), "  ")}` : "";
      return `${pal.magenta("— compaction —")}${pal.dim(s)}`;
    }
    case "modelChange":
      return pal.dim(`— model → ${e.provider ? `${e.provider}/` : ""}${e.model} —`);
    case "subsession":
      return `${pal.blue("⌥ subagent")} ${e.agentName ?? e.sessionRef}${
        e.resultText ? pal.dim(` — ${truncate(e.resultText, width - 20)}`) : ""
      }`;
    case "note":
      return pal.dim(`· ${e.noteType}${e.text ? `: ${truncate(e.text, width - 10)}` : ""}`);
    default:
      return pal.dim(`· ${(e as { kind: string }).kind}`);
  }
}

export function renderTranscript(s: SifSession, opts: RenderOpts = {}): string {
  const pal = opts.pal ?? palette(false);
  const out: string[] = [renderHeader(s, opts)];
  for (const e of s.entries) out.push(renderEntry(e, opts));

  if (opts.subsessions !== false && s.subsessions?.length) {
    for (const sub of s.subsessions) {
      out.push("");
      out.push(pal.blue(`┌─ subsession ${sub.origin.nativeId} (${sub.entries.length} entries)`));
      out.push(
        indent(
          sub.entries.map((e) => renderEntry(e, opts)).join("\n"),
          pal.blue("│ "),
        ),
      );
      out.push(pal.blue("└─"));
    }
  }
  return out.join("\n");
}

/** Strip `raw` (and nested raw) for --slim exports. */
export function slimSession(s: SifSession): SifSession {
  const strip = (session: SifSession): SifSession => ({
    ...session,
    entries: session.entries.map(({ raw: _raw, ...rest }) => rest as SifEntry),
    subsessions: session.subsessions?.map(strip),
  });
  return strip(s);
}
