/**
 * Lenient JSONL reading (pattern proven by omp's foreign-session importer):
 * unparseable/truncated lines are skipped, never fatal, and line numbers are
 * kept so adapters can mint deterministic synthetic ids.
 */

export interface JsonlLine<T = unknown> {
  value: T;
  line: number; // 1-based
}

export async function* readJsonl(path: string): AsyncGenerator<JsonlLine> {
  const file = Bun.file(path);
  const text = await file.text();
  let line = 0;
  for (const rawLine of text.split("\n")) {
    line++;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      yield { value: JSON.parse(trimmed), line };
    } catch {
      // skip malformed line (live-written tail, non-JSON slots like omp's
      // fixed-width title record when damaged, etc.)
    }
  }
}

export async function readJsonlAll(path: string): Promise<JsonlLine[]> {
  const out: JsonlLine[] = [];
  for await (const l of readJsonl(path)) out.push(l);
  return out;
}
