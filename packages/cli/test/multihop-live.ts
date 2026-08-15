/**
 * Live multi-hop check against a REAL codex session, isolated in temp dirs so
 * the user's ~/.omp and ~/.pi stores are never touched.
 *
 *   codex:01a0045d  ->  omp  ->  pi
 *
 * Proves: one stable threadId, a growing chain, and no double-flattening of
 * historical tool calls on the second hop.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provenanceOf, validateSession, type SifSession } from "@sinter/core";
import { OmpAdapter, PiAdapter } from "@sinter/adapter-omp";
import codex from "@sinter/adapter-codex";

const CODEX_ID = process.argv[2] ?? "01a0045d-3cdd-77f2-a09f-e77439403531";
const root = mkdtempSync(join(tmpdir(), "sinter-multihop-"));
const omp = new OmpAdapter({ home: root });
const pi = new PiAdapter({ home: root });

const countInert = (s: SifSession) => {
  let n = 0, nested = 0;
  for (const e of s.entries) {
    const parts = (e as any).content ?? [];
    for (const p of parts) {
      if (p.type !== "text" || typeof p.text !== "string") continue;
      const hits = p.text.match(/\[historical tool call:/g);
      if (hits) n += hits.length;
      // A marker that itself contains another marker = double flattening.
      if (/\[historical tool call:[^\]]*\[historical tool call:/.test(p.text)) nested++;
    }
  }
  return { n, nested };
};

console.log("--- hop 0: read codex ---");
const h0 = await codex.read({ harness: "codex", nativeId: CODEX_ID });
validateSession(h0);
console.log(`entries=${h0.entries.length} inert=${JSON.stringify(countInert(h0))} prov=${!!provenanceOf(h0)}`);

console.log("\n--- hop 1: codex -> omp ---");
const r1 = await omp.write(h0, { liveTools: false });
console.log(`wrote omp:${r1.nativeId}  provenance-on-ref=${!!r1.provenance}`);
const h1 = await omp.read(r1);
const p1 = provenanceOf(h1)!;
console.log(`threadId=${p1?.threadId}  hop=${p1?.hop}  chain=${p1?.chain.map(c=>c.harness).join(" -> ")}`);
console.log(`entries=${h1.entries.length} inert=${JSON.stringify(countInert(h1))} carry=${p1?.carry?`inline ${p1.carry.length}b`:p1?.carryRef?`sidecar`:"none"}`);

console.log("\n--- hop 2: omp -> pi ---");
const r2 = await pi.write(h1, { liveTools: false });
const h2 = await pi.read(r2);
const p2 = provenanceOf(h2)!;
console.log(`wrote pi:${r2.nativeId}`);
console.log(`threadId=${p2?.threadId}  hop=${p2?.hop}  chain=${p2?.chain.map(c=>c.harness).join(" -> ")}`);
const i2 = countInert(h2);
console.log(`entries=${h2.entries.length} inert=${JSON.stringify(i2)}`);

console.log("\n--- hop 3: pi -> omp (BACK to a harness already in the chain) ---");
const r3 = await omp.write(h2, { liveTools: false });
const p3 = provenanceOf(await omp.read(r3))!;
console.log(`threadId=${p3?.threadId}  hop=${p3?.hop}  chain=${p3?.chain.map(c=>c.harness).join(" -> ")}`);

console.log("\n=== VERDICT ===");
console.log("threadId stable across 3 hops :", p1?.threadId === p2?.threadId && p2?.threadId === p3?.threadId);
console.log("chain grows 2 -> 3 -> 4       :", `${p1?.chain.length} -> ${p2?.chain.length} -> ${p3?.chain.length}`);
console.log("re-entry appended, not merged :", p3?.chain.map(c=>c.harness).join(",") === "codex,omp,pi,omp");
console.log("NO nested tool markers        :", i2.nested === 0, `(nested=${i2.nested})`);
console.log("tmp root:", root);

console.log("\n=== CARRY-FORWARD RECOVERY ===");
const recovered = await omp.read(r1, { useCarry: true });
const origToolCalls = h0.entries.flatMap((e:any) => (e.content ?? []).filter((p:any)=>p.type==="toolCall"));
const recToolCalls  = recovered.entries.flatMap((e:any) => (e.content ?? []).filter((p:any)=>p.type==="toolCall"));
const flatToolCalls = h1.entries.flatMap((e:any) => (e.content ?? []).filter((p:any)=>p.type==="toolCall"));
console.log(`original codex entries     : ${h0.entries.length}, live toolCalls=${origToolCalls.length}`);
console.log(`omp native (flattened) read: ${h1.entries.length}, live toolCalls=${flatToolCalls.length}`);
console.log(`omp read WITH carry        : ${recovered.entries.length}, live toolCalls=${recToolCalls.length}`);
console.log("carry restores the original:", recovered.entries.length === h0.entries.length && recToolCalls.length === origToolCalls.length);
console.log("native read stays flattened:", flatToolCalls.length === 0);

console.log("\n=== LEDGER WIRING (real adapters, temp ledger) ===");
const { Ledger } = await import("@sinter/ledger");
const { buildThreads } = await import("../src/tui/threads");
const led = new Ledger(join(root, "ledger.db"));
await led.scan([omp as any, pi as any]);
for (const r of [r1, r2, r3]) if (r.provenance) led.recordProvenance(r.provenance);

const links = led.lineage();
console.log(`lineage rows: ${links.length}, threads: ${new Set(links.map(l=>l.threadId)).size}`);
console.log("hops:", links.slice().sort((a,b)=>a.hop-b.hop).map(l=>`${l.hop}:${l.harness}`).join(" -> "));

const threads = buildThreads(led.list({}), links);
const ported = threads.filter(t => t.ported);
console.log(`threads built: ${threads.length}, ported: ${ported.length}`);
if (ported[0]) {
  console.log("chain label :", ported[0].hops.map(x=>x.harness).join(" → "));
  console.log("tip         :", `${ported[0].tip.harness}:${ported[0].tip.nativeId.slice(0,12)}`);
}
console.log("\nONE thread, FOUR hops:", links.length === 4 && new Set(links.map(l=>l.threadId)).size === 1);
led.close();
