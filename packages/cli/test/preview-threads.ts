import { openLedger } from "@sinter/ledger";
import { palette } from "../src/format";
import { initialState, reduce } from "../src/tui/state";
import { buildThreads } from "../src/tui/threads";
import { renderFrame } from "../src/tui/view";
import { resolveCaps } from "../src/tui/menu";
import { DynamicAdapterRegistry } from "../src/adapters";

const ctx: any = { registry: new DynamicAdapterRegistry() };
const caps = await resolveCaps(ctx);
const led = openLedger();
const threads = buildThreads(led.list({ limit: 2000 }), led.lineage());
const ported = threads.filter((t) => t.ported);
console.log(`threads: ${threads.length}, ported: ${ported.length}`);
for (const t of ported) console.log(`  ${t.hops.map((h) => h.harness).join(" → ")}  tip=${t.tip.harness}:${t.tip.nativeId.slice(0, 12)}`);

if (ported.length) {
  let s = initialState({ threads: ported, caps, cwd: process.cwd(), scope: "all" });
  const opts = { width: 104, height: 16, pal: palette(true), now: Date.now() };
  console.log("\n=== LIST (ported threads only) ===");
  console.log(renderFrame(s, opts).join("\n"));
  s = reduce(s, { type: "enter" } as any).state;
  console.log("\n=== ACTIONS ===");
  console.log(renderFrame(s, opts).join("\n"));
}
