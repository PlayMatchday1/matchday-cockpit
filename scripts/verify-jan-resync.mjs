import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

async function paginateAll(q, pageSize = 1000) {
  let from = 0, all = [];
  for (;;) {
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

const MONTH_START = "2026-01-01", MONTH_END = "2026-01-31";

// 1. DPP — must be unchanged from baseline 230 rows / $39,787
console.log("=== (1) DPP drift check (baseline 230 rows / $39,787) ===");
const dpp = await paginateAll(sb.from("fin_revenue").select("gross").eq("type","DPP").eq("source","Stripe").gte("date",MONTH_START).lte("date",MONTH_END));
const dppTotal = dpp.reduce((s,r)=>s+(r.gross??0),0);
const dDpp = Math.round(dppTotal - 39787);
console.log(`  rows=${dpp.length} (Δ=${dpp.length - 230})  $${Math.round(dppTotal).toLocaleString()} (Δ=${dDpp === 0 ? "ZERO ✓" : "$" + dDpp.toLocaleString() + " ⚠️"})`);

// 2. Membership — total invariant, but redistribution between cities
console.log("\n=== (2) Membership by city — Jan 2026 (full month) ===");
const mem = await paginateAll(sb.from("fin_revenue").select("date, city, gross, notes").eq("type","Membership").eq("source","Stripe").gte("date",MONTH_START).lte("date",MONTH_END));
const byCity = new Map();
for (const r of mem) {
  const c = r.city ?? "(null)";
  if (!byCity.has(c)) byCity.set(c, { rows: 0, gross: 0 });
  byCity.get(c).rows++; byCity.get(c).gross += r.gross ?? 0;
}
const memTotal = mem.reduce((s,r)=>s+(r.gross??0), 0);
console.log(`  Total Membership $: $${Math.round(memTotal).toLocaleString()} across ${mem.length} aggregate rows`);
console.log();
const realCities = [...byCity.entries()].filter(([c]) => c !== "Deleted Account Revenue").sort((a,b)=>b[1].gross - a[1].gross);
const deleted = byCity.get("Deleted Account Revenue");
let realTotal = 0;
for (const [c, x] of realCities) {
  realTotal += x.gross;
  console.log(`    ${c.padEnd(28)} rows=${String(x.rows).padStart(3)}  $${Math.round(x.gross).toLocaleString().padStart(7)}`);
}
console.log(`    ${"".padEnd(28)} ${"-".repeat(20)}`);
console.log(`    ${"Real cities total".padEnd(28)} rows=${String(realCities.reduce((s,[,x])=>s+x.rows,0)).padStart(3)}  $${Math.round(realTotal).toLocaleString().padStart(7)}`);
console.log();
if (deleted) {
  console.log(`    ${"Deleted Account Revenue".padEnd(28)} rows=${String(deleted.rows).padStart(3)}  $${Math.round(deleted.gross).toLocaleString().padStart(7)}  (was ~$14,867 for Jan 1-14 alone in the pre-fix data)`);
} else {
  console.log(`    Deleted Account Revenue: NO ROWS (fully resolved ✓)`);
}

// 3. Sync log
console.log("\n=== (3) fin_sync_log latest stripe-api row ===");
const log = await sb.from("fin_sync_log").select("started_at, completed_at, rows_imported, charges_fetched, rows_replaced, error_message").eq("source","stripe-api").order("started_at",{ascending:false}).limit(1).maybeSingle();
const dur = log.data?.completed_at ? `${Math.round((new Date(log.data.completed_at) - new Date(log.data.started_at))/1000)}s` : "(never finalized)";
console.log(`  ${log.data?.started_at}  ${dur}  rows_imported=${log.data?.rows_imported}  rows_replaced=${log.data?.rows_replaced}  charges_fetched=${log.data?.charges_fetched}  err=${log.data?.error_message ?? "—"}`);
