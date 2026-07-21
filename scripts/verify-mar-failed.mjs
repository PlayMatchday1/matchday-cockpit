import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
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

// 1. March data — should be empty
console.log("=== (1) Mar 1-31 DPP rows ===");
const mar = await paginateAll(
  sb.from("fin_revenue").select("date, gross")
    .eq("type","DPP").eq("source","Stripe")
    .gte("date","2026-03-01").lte("date","2026-03-31")
);
const marTotal = mar.reduce((s,r) => s+(r.gross??0), 0);
const marDates = [...new Set(mar.map(r => r.date))].sort();
console.log(`  rows=${mar.length}  $${Math.round(marTotal).toLocaleString()}  date range: ${marDates[0] ?? "—"} → ${marDates[marDates.length-1] ?? "—"}`);
console.log(`  ${mar.length === 0 ? "✓ clean — no partial writes" : "⚠️ partial writes present"}`);

// Also check non-DPP Stripe rows in Mar (Membership, Strike)
const marAll = await paginateAll(
  sb.from("fin_revenue").select("date, type, gross")
    .eq("source","Stripe")
    .gte("date","2026-03-01").lte("date","2026-03-31")
);
console.log(`  All March Stripe rows (any type): ${marAll.length}`);

// 2. fin_sync_log for the failed March attempt
console.log("\n=== (2) fin_sync_log: last 4 stripe-api rows ===");
const log = await sb.from("fin_sync_log").select("started_at, completed_at, rows_imported, charges_fetched, rows_replaced, error_message").eq("source","stripe-api").order("started_at",{ascending:false}).limit(4);
for (const row of log.data ?? []) {
  const dur = row.completed_at ? `${Math.round((new Date(row.completed_at) - new Date(row.started_at))/1000)}s` : "(never finalized)";
  console.log(`  ${row.started_at}  ${dur}  rows=${row.rows_imported}  fetched=${row.charges_fetched}  rep=${row.rows_replaced}  err=${row.error_message ?? "—"}`);
}

// 3. Drift check on all 4 known-good months
console.log("\n=== (3) Drift check ===");
const baselines = {
  "2026-01": { rows: 230, gross: 39787, end: "31" },
  "2026-02": { rows: 292, gross: 42946, end: "28" },
  "2026-04": { rows: 362, gross: 47923, end: "30" },
  "2026-05": { rows: 179, gross: 23996, end: "31" },
};
for (const [m, base] of Object.entries(baselines)) {
  const lo = `${m}-01`;
  const hi = `${m}-${base.end}`;
  const rows = await paginateAll(sb.from("fin_revenue").select("gross").eq("type","DPP").eq("source","Stripe").gte("date", lo).lte("date", hi));
  const t = rows.reduce((s,r) => s+(r.gross??0), 0);
  const dRows = rows.length - base.rows;
  const dGross = Math.round(t - base.gross);
  const ok = dRows === 0 && dGross === 0;
  console.log(`  ${m}:  rows=${rows.length} (baseline ${base.rows}, Δ=${dRows})  $${Math.round(t).toLocaleString()} (baseline $${base.gross.toLocaleString()}, Δ=${dGross === 0 ? "ZERO ✓" : "$" + dGross.toLocaleString() + " ⚠️"})  ${ok ? "✓" : "⚠️"}`);
}

// Sanity: full coverage
console.log("\n=== Full coverage ===");
const all = await paginateAll(sb.from("fin_revenue").select("date, gross").eq("type","DPP").eq("source","Stripe"));
const byMonth = new Map();
for (const r of all) {
  const m = r.date.slice(0,7);
  if (!byMonth.has(m)) byMonth.set(m, { rows: 0, gross: 0 });
  byMonth.get(m).rows++; byMonth.get(m).gross += r.gross ?? 0;
}
for (const [m, o] of [...byMonth.entries()].sort()) {
  console.log(`  ${m}:  rows=${String(o.rows).padStart(4)}  $${Math.round(o.gross).toLocaleString().padStart(8)}`);
}
