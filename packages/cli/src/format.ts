/** Hand-rolled ANSI colouring + table/age/path helpers. Respects NO_COLOR. */

import { homedir } from "node:os";

export type Paint = (s: string) => string;

export interface Palette {
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  blue: Paint;
  magenta: Paint;
  cyan: Paint;
  gray: Paint;
  enabled: boolean;
}

const wrap = (open: string, close: string): Paint => (s) => `\x1b[${open}m${s}\x1b[${close}m`;
const plain: Paint = (s) => s;

export function colorEnabled(isTty = !!process.stdout.isTTY): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR) return true;
  return isTty;
}

export function palette(enabled: boolean): Palette {
  const c = (open: string, close = "39") => (enabled ? wrap(open, close) : plain);
  return {
    enabled,
    bold: enabled ? wrap("1", "22") : plain,
    dim: enabled ? wrap("2", "22") : plain,
    red: c("31"),
    green: c("32"),
    yellow: c("33"),
    blue: c("34"),
    magenta: c("35"),
    cyan: c("36"),
    gray: c("90"),
  };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");
export const visibleWidth = (s: string): number => stripAnsi(s).length;

export function termWidth(): number {
  const env = Number(process.env.COLUMNS);
  if (Number.isFinite(env) && env > 20) return env;
  const w = process.stdout.columns;
  return Number.isFinite(w) && w! > 20 ? w! : 100;
}

export function termHeight(): number {
  const env = Number(process.env.LINES);
  if (Number.isFinite(env) && env > 5) return env;
  const h = process.stdout.rows;
  return Number.isFinite(h) && h! > 5 ? h! : 24;
}

/** Truncate to `n` visible chars with an ellipsis (ANSI-unaware: use on raw text). */
export function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (n <= 0) return "";
  return flat.length <= n ? flat : flat.slice(0, Math.max(0, n - 1)) + "…";
}

/** ~-shorten a path, then elide leading segments if still too long. */
export function shortenPath(p: string | undefined, max = 40, home = homedir()): string {
  if (!p) return "";
  let out = home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  if (out.length <= max) return out;
  const parts = out.split("/");
  while (parts.length > 2 && parts.join("/").length > max) parts.shift();
  out = "…/" + parts.join("/").replace(/^\/+/, "");
  return out.length <= max ? out : "…" + out.slice(out.length - max + 1);
}

/** Compact relative age: 12s 5m 3h 2d 6w 1y. */
export function humanAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "-";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d`;
  const w = Math.round(d / 7);
  if (w < 53) return `${w}w`;
  return `${Math.round(d / 365)}y`;
}

export interface Column {
  header: string;
  align?: "left" | "right";
  /** Hard cap; the last column absorbs the remaining width. */
  max?: number;
  flex?: boolean;
}

/**
 * Fixed-width table. Column widths come from content; exactly one `flex`
 * column (normally the title) is squeezed to fit the terminal.
 */
export function renderTable(
  columns: Column[],
  rows: string[][],
  opts: { width?: number; gap?: number; pal?: Palette; header?: boolean } = {},
): string {
  const gap = opts.gap ?? 2;
  const width = opts.width ?? termWidth();
  const pal = opts.pal ?? palette(false);
  const showHeader = opts.header !== false;

  const widths = columns.map((c, i) => {
    const content = rows.map((r) => visibleWidth(r[i] ?? ""));
    let w = Math.max(showHeader ? c.header.length : 0, ...(content.length ? content : [0]));
    if (c.max) w = Math.min(w, c.max);
    return w;
  });

  const flexIndex = columns.findIndex((c) => c.flex);
  if (flexIndex >= 0) {
    const others = widths.reduce((a, w, i) => a + (i === flexIndex ? 0 : w), 0);
    const spacing = gap * (columns.length - 1);
    widths[flexIndex] = Math.max(8, width - others - spacing);
  }

  const pad = (s: string, w: number, align: "left" | "right") => {
    const vis = visibleWidth(s);
    if (vis > w) {
      // truncate while keeping any trailing reset intact
      const flat = stripAnsi(s);
      return truncate(flat, w).padEnd(w, " ");
    }
    const fill = " ".repeat(w - vis);
    return align === "right" ? fill + s : s + fill;
  };

  const line = (cells: string[]) =>
    cells
      .map((c, i) => pad(c, widths[i]!, columns[i]!.align ?? "left"))
      .join(" ".repeat(gap))
      .replace(/\s+$/, "");

  const out: string[] = [];
  if (showHeader) out.push(pal.dim(line(columns.map((c) => c.header))));
  for (const r of rows) out.push(line(r));
  return out.join("\n");
}

/** 8-char short id, the ledger's display handle. */
export function shortId(nativeId: string, n = 8): string {
  return nativeId.length <= n ? nativeId : nativeId.slice(0, n);
}

/**
 * Table handle. Child ids ("<uuid>/agent-abc123", claude sidechains) keep a
 * slice of the child segment so siblings never render identically.
 */
export function displayId(nativeId: string): string {
  const slash = nativeId.lastIndexOf("/");
  if (slash === -1) return shortId(nativeId);
  const tail = nativeId.slice(slash + 1).replace(/^agent[-_]/, "");
  return `${shortId(nativeId.slice(0, slash))}/${shortId(tail, 4)}`;
}

export function formatCount(n: number | undefined): string {
  return n === undefined || n === null ? "-" : String(n);
}
