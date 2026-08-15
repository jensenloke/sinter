import { openLedger } from "@sinter/ledger";
import { palette } from "../src/format";
import { initialState, reduce } from "../src/tui/state";
import { buildThreads } from "../src/tui/threads";
import { renderFrame } from "../src/tui/view";
import { resolveCaps } from "../src/tui/menu";
import { DynamicAdapterRegistry } from "../src/adapters";

const ctx: any = { registry: new DynamicAdapterRegistry() };
const caps = await resolveCaps(ctx);
console.log("caps: " + caps.map((c) => `${c.id}[${c.available ? "ok" : "NO"}${c.canWrite ? " W" : ""}${c.onPath ? " P" : ""}]`).join(" "));

const rows = openLedger().list({ limit: 2000 });
const threads = buildThreads(rows, []);
let s = initialState({ threads, caps, cwd: process.argv[2] ?? process.cwd() });
const opts = { width: 104, height: 20, pal: palette(true), now: Date.now() };

console.log("\n=== SESSIONS (scope=" + s.scope + ") ===");
console.log(renderFrame(s, opts).join("\n"));

s = reduce(s, { type: "enter" } as any).state;
console.log("\n=== ACTIONS ===");
console.log(renderFrame(s, opts).join("\n"));
