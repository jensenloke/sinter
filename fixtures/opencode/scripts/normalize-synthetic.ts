#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
for (const file of ["mini-messages.json", "mini-parts.json"]) {
  const path = join(dir, file);
  const rows = JSON.parse(await readFile(path, "utf8")) as Array<{ data: string }>;
  for (const row of rows) {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    if ("parentID" in data) data.parentID = null;
    row.data = JSON.stringify(data);
  }
  await writeFile(path, `${JSON.stringify(rows, null, 2)}\n`);
}
