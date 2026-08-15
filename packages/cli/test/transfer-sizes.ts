import { openLedger } from "@sinter/ledger";
import { DynamicAdapterRegistry } from "../src/adapters";
import { applyTransfer, fmtBytes, estimateTokens } from "../src/transfer";
import { validateSession } from "@sinter/core";

const reg = new DynamicAdapterRegistry();
const ledger = openLedger();

const counts = ledger.db
  .query("SELECT harness, count(*) n, sum(message_count IS NULL) nulls FROM sessions GROUP BY harness")
  .all();
console.log("message_count coverage:", JSON.stringify(counts));

// Biggest sessions per harness that we can actually read.
const rows = ledger.list({ limit: 400, includeGhost: false }).filter((r) => !r.isSubagent);
const picked: typeof rows = [];
for (const h of ["claude", "codex", "opencode", "omp"]) {
  const r = rows.filter((x) => x.harness === h).slice(0, 3);
  picked.push(...r);
}

console.log("\nharness    entries  full        slim        compact     saved  tokens(full→compact)");
for (const row of picked) {
  try {
    const adapter = await reg.get(row.harness);
    const s = await adapter.read({ harness: row.harness, nativeId: row.nativeId, nativePath: row.nativePath });
    const full = applyTransfer(s, "full");
    const slim = applyTransfer(s, "slim");
    const comp = applyTransfer(s, "compact");
    validateSession(comp.session);
    const saved = Math.round((1 - comp.stats.bytesAfter / comp.stats.bytesBefore) * 100);
    console.log(
      `${row.harness.padEnd(10)} ${String(s.entries.length).padStart(6)}  ` +
        `${fmtBytes(full.stats.bytesBefore).padEnd(11)} ${fmtBytes(slim.stats.bytesAfter).padEnd(11)} ` +
        `${fmtBytes(comp.stats.bytesAfter).padEnd(11)} ${String(saved).padStart(4)}%  ` +
        `${Math.round(estimateTokens(full.stats.bytesBefore) / 1000)}k → ${Math.round(estimateTokens(comp.stats.bytesAfter) / 1000)}k`,
    );
  } catch (e) {
    console.log(`${row.harness.padEnd(10)} SKIP ${(e as Error).message.slice(0, 60)}`);
  }
}
