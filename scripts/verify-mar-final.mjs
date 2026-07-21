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

// (a) Mar DPP totals
const mar = await paginateAll(
  sb.from("fin_revenue").select("date, venue, gross")
    .eq("type","DPP").eq("source","Stripe")
    .gte("date","2026-03-01").lte("date","2026-03-31")
    .order("date", { ascending: true })
);
const marTotal = mar.reduce((s,r) => s+(r.gross??0), 0);
const marVenues = new Set(mar.map(r => r.venue).filter(Boolean));
const marDates = new Set(mar.map(r => r.date));
const dArr = [...marDates].sort();
console.log("=== (a) Mar 1-31 DPP totals ===");
console.log(`  rows=${mar.length}  $${Math.round(marTotal).toLocaleString()}  venues=${marVenues.size}  dates=${marDates.size}`);
console.log(`  earliest=${dArr[0]}  latest=${dArr[dArr.length-1]}`);

// (b) Mar 31 inclusion
const mar31 = mar.filter(r => r.date === "2026-03-31");
const mar31T = mar31.reduce((s,r) => s+(r.gross??0), 0);
console.log("\n=== (b) Mar 31 inclusion ===");
console.log(`  rows on 2026-03-31: ${mar31.length}  $${Math.round(mar31T).toLocaleString()}  ${mar31.length > 0 ? "✓" : "⚠️"}`);

// (c) Drift Jan/Feb/Apr/May
console.log("\n=== (c) Drift check on Jan/Feb/Apr/May ===");
const baselines = {
  "2026-01": { rows: 230, gross: 39787, end: "31" },
  "2026-02": { rows: 292, gross: 42946, end: "28" },
  "2026-04": { rows: 362, gross: 47923, end: "30" },
  "2026-05": { rows: 179, gross: 23996, end: "31" },
};
for (const [m, base] of Object.entries(baselines)) {
  const rows = await paginateAll(sb.from("fin_revenue").select("gross").eq("type","DPP").eq("source","Stripe").gte("date", `${m}-01`).lte("date", `${m}-${base.end}`));
  const t = rows.reduce((s,r) => s+(r.gross??0), 0);
  const dRows = rows.length - base.rows;
  const dGross = Math.round(t - base.gross);
  const ok = dRows === 0 && dGross === 0;
  console.log(`  ${m}:  rows=${rows.length} (Δ=${dRows})  $${Math.round(t).toLocaleString()} (Δ=${dGross === 0 ? "ZERO ✓" : "$" + dGross.toLocaleString() + " ⚠️"})  ${ok ? "✓" : "⚠️"}`);
}

// (d) Full coverage
console.log("\n=== (d) Full coverage table — all 5 months ===");
const all = await paginateAll(sb.from("fin_revenue").select("date, venue, gross").eq("type","DPP").eq("source","Stripe"));
const byMonth = new Map();
for (const r of all) {
  const m = r.date.slice(0,7);
  if (!byMonth.has(m)) byMonth.set(m, { rows: 0, gross: 0, venues: new Set(), dates: new Set() });
  const o = byMonth.get(m);
  o.rows++; o.gross += r.gross ?? 0; o.venues.add(r.venue); o.dates.add(r.date);
}
const sortedMonths = [...byMonth.entries()].sort();
console.log(`  month     rows    $         venues  dates`);
for (const [m, o] of sortedMonths) {
  console.log(`  ${m}  ${String(o.rows).padStart(4)}  $${Math.round(o.gross).toLocaleString().padStart(7)}  ${String(o.venues.size).padStart(2)}      ${o.dates.size}`);
}

// (e) MoM trajectory
console.log("\n=== (e) MoM DPP trajectory ===");
let prev = null;
for (const [m, o] of sortedMonths) {
  const g = Math.round(o.gross);
  const partial = o.dates.size < 28 ? ` (partial — ${o.dates.size} dates)` : "";
  if (prev === null) {
    console.log(`  ${m}: $${g.toLocaleString()}${partial}  (base)`);
  } else {
    const delta = g - prev;
    const pct = prev > 0 ? Math.round((delta / prev) * 1000) / 10 : 0;
    const sign = delta >= 0 ? "+" : "";
    console.log(`  ${m}: $${g.toLocaleString()}${partial}  Δ ${sign}$${delta.toLocaleString()}  (${sign}${pct}% MoM)`);
  }
  prev = g;
}

// Duplicate check within Mar
const seen = new Map();
const dupes = [];
for (const r of mar) {
  const k = `${r.date}|${r.venue}`;
  if (seen.has(k)) dupes.push(k); else seen.set(k, r.gross);
}
console.log(`\n=== Duplicate check within Mar (date, venue) ===  distinct keys=${seen.size}  dupes=${dupes.length}  ${dupes.length === 0 ? "✓" : "⚠️"}`);

// Latest sync log row for Mar
console.log("\n=== fin_sync_log: last 4 stripe-api rows ===");
const log = await sb.from("fin_sync_log").select("started_at, completed_at, rows_imported, charges_fetched, rows_replaced, error_message").eq("source","stripe-api").order("started_at",{ascending:false}).limit(4);
for (const row of log.data ?? []) {
  const dur = row.completed_at ? `${Math.round((new Date(row.completed_at) - new Date(row.started_at))/1000)}s` : "(never finalized)";
  console.log(`  ${row.started_at}  ${dur}  rows=${row.rows_imported}  fetched=${row.charges_fetched}  rep=${row.rows_replaced}  err=${row.error_message ?? "—"}`);
}
