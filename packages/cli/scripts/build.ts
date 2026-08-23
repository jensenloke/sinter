import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = fileURLToPath(new URL("../dist", import.meta.url));

// Splitting uses content-hashed chunk names. Always remove the prior build so
// npm archives cannot accumulate unreachable chunks from older releases.
rmSync(dist, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [`${root}src/main.ts`],
  outdir: dist,
  target: "bun",
  format: "esm",
  splitting: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(`${output.path.replace(`${root}`, "")}  ${output.size} bytes`);
}
