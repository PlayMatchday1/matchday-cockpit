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

// Compare Jan 1-14 (the user's earlier "$106 real / $14,867 deleted" snapshot) vs same window today
console.log("=== Jan 1-14 Membership Stripe — BEFORE-FIX claim vs CURRENT state ===");
const rows = await paginateAll(sb.from("fin_revenue").select("date, city, gross, notes")
  .eq("type","Membership").eq("source","Stripe")
  .gte("date","2026-01-01").lte("date","2026-01-14"));
const byCity = new Map();
for (const r of rows) {
  if (!byCity.has(r.city)) byCity.set(r.city, { rows: 0, gross: 0, sampleNotes: [] });
  byCity.get(r.city).rows++; byCity.get(r.city).gross += r.gross ?? 0;
  if (byCity.get(r.city).sampleNotes.length < 3) byCity.get(r.city).sampleNotes.push({ date: r.date, gross: r.gross, notes: r.notes });
}
console.log(`Jan 1-14 total rows: ${rows.length}, total $${Math.round(rows.reduce((s,r)=>s+(r.gross??0),0)).toLocaleString()}`);
console.log();
for (const [c, x] of [...byCity.entries()].sort((a,b)=>b[1].gross-a[1].gross)) {
  console.log(`  ${c.padEnd(28)} rows=${String(x.rows).padStart(3)}  $${Math.round(x.gross).toLocaleString().padStart(7)}`);
  for (const s of x.sampleNotes) console.log(`      sample: date=${s.date} $${s.gross} notes=${JSON.stringify(s.notes)}`);
}

console.log("\n=== User reported BEFORE: real=$106 deleted=$14,867 — matches CURRENT? ===");
const deleted14 = byCity.get("Deleted Account Revenue");
const real14 = [...byCity.entries()].filter(([c]) => c !== "Deleted Account Revenue").reduce((s,[,x])=>s+x.gross, 0);
console.log(`  Real cities total: $${Math.round(real14).toLocaleString()} (was $106)`);
console.log(`  Deleted: $${Math.round(deleted14?.gross ?? 0).toLocaleString()} (was $14,867)`);
console.log(`  Diff from BEFORE: real Δ=$${Math.round(real14 - 106)}, deleted Δ=$${Math.round((deleted14?.gross ?? 0) - 14867)}`);
console.log(`  ${Math.abs(real14 - 106) < 10 && Math.abs((deleted14?.gross ?? 0) - 14867) < 100 ? "→ NEARLY IDENTICAL — fallback did NOT take effect" : "→ Real change present"}`);

// fin_sync_log diagnostic: prior 3 syncs and their rows_replaced
console.log("\n=== Last 3 stripe-api sync log rows ===");
const log = await sb.from("fin_sync_log").select("started_at, completed_at, rows_imported, rows_replaced, charges_fetched, error_message").eq("source","stripe-api").order("started_at",{ascending:false}).limit(3);
for (const row of log.data ?? []) {
  const dur = row.completed_at ? `${Math.round((new Date(row.completed_at) - new Date(row.started_at))/1000)}s` : "(never finalized)";
  console.log(`  ${row.started_at}  ${dur}  rows_imported=${row.rows_imported}  rows_replaced=${row.rows_replaced}  charges=${row.charges_fetched}`);
}
