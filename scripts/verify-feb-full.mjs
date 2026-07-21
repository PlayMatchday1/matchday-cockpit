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

// (a) Feb DPP totals
const feb = await paginateAll(
  sb.from("fin_revenue").select("date, venue, gross")
    .eq("type","DPP").eq("source","Stripe")
    .gte("date","2026-02-01").lte("date","2026-02-28")
    .order("date", { ascending: true })
);
const febTotal = feb.reduce((s,r) => s+(r.gross??0), 0);
const febVenues = new Set(feb.map(r => r.venue).filter(Boolean));
const febDates = new Set(feb.map(r => r.date));
const dArr = [...febDates].sort();
console.log("=== (a) Feb 1-28 DPP totals ===");
console.log(`  rows=${feb.length}  $${Math.round(febTotal).toLocaleString()}  venues=${febVenues.size}  dates=${febDates.size}`);
console.log(`  earliest=${dArr[0]}  latest=${dArr[dArr.length-1]}`);

// (b) Feb 28 inclusion
const feb28 = feb.filter(r => r.date === "2026-02-28");
const feb28T = feb28.reduce((s,r) => s+(r.gross??0), 0);
console.log("\n=== (b) Feb 28 inclusion ===");
console.log(`  rows on 2026-02-28: ${feb28.length}  $${Math.round(feb28T).toLocaleString()}  ${feb28.length > 0 ? "✓" : "⚠️"}`);

// (c) Drift check Jan / Apr / May
console.log("\n=== (c) Drift check on previously-synced months ===");
const baselines = { "2026-01": { rows: 230, gross: 39787 }, "2026-04": { rows: 362, gross: 47923 }, "2026-05": { rows: 179, gross: 23996 } };
for (const [m, base] of Object.entries(baselines)) {
  const lo = `${m}-01`;
  const hiMonth = m.endsWith("-04") || m.endsWith("-06") || m.endsWith("-09") || m.endsWith("-11") ? "30" : (m.endsWith("-02") ? "28" : "31");
  const hi = `${m}-${hiMonth}`;
  const rows = await paginateAll(sb.from("fin_revenue").select("gross").eq("type","DPP").eq("source","Stripe").gte("date", lo).lte("date", hi));
  const t = rows.reduce((s,r) => s+(r.gross??0), 0);
  const dRows = rows.length - base.rows;
  const dGross = Math.round(t - base.gross);
  const ok = dRows === 0 && dGross === 0;
  console.log(`  ${m}:  rows=${rows.length} (baseline ${base.rows}, Δ=${dRows})  $${Math.round(t).toLocaleString()} (baseline $${base.gross.toLocaleString()}, Δ=${dGross === 0 ? "ZERO ✓" : "$" + dGross.toLocaleString() + " ⚠️"})  ${ok ? "✓" : "⚠️"}`);
}

// (d) Full coverage table
console.log("\n=== (d) Coverage (type=DPP, source=Stripe) ===");
const all = await paginateAll(sb.from("fin_revenue").select("date, venue, gross").eq("type","DPP").eq("source","Stripe"));
const byMonth = new Map();
for (const r of all) {
  const m = r.date.slice(0,7);
  if (!byMonth.has(m)) byMonth.set(m, { rows: 0, gross: 0, venues: new Set(), dates: new Set() });
  const o = byMonth.get(m);
  o.rows++; o.gross += r.gross ?? 0; o.venues.add(r.venue); o.dates.add(r.date);
}
for (const [m, o] of [...byMonth.entries()].sort()) {
  console.log(`  ${m}:  rows=${String(o.rows).padStart(4)}  $${Math.round(o.gross).toLocaleString().padStart(8)}  venues=${o.venues.size}  dates=${o.dates.size}`);
}

// Duplicate check within Feb
const seen = new Map();
const dupes = [];
for (const r of feb) {
  const k = `${r.date}|${r.venue}`;
  if (seen.has(k)) dupes.push(k); else seen.set(k, r.gross);
}
console.log(`\n=== Duplicate check within Feb (date, venue) ===  distinct keys=${seen.size}  dupes=${dupes.length}  ${dupes.length === 0 ? "✓" : "⚠️"}`);

// Sync log — last 3 stripe-api rows so we can see the orphan situation too
console.log("\n=== Last 3 stripe-api fin_sync_log rows ===");
const log = await sb.from("fin_sync_log").select("started_at, completed_at, rows_imported, charges_fetched, rows_replaced, error_message").eq("source","stripe-api").order("started_at",{ascending:false}).limit(3);
for (const row of log.data ?? []) {
  const dur = row.completed_at ? `${Math.round((new Date(row.completed_at) - new Date(row.started_at))/1000)}s` : "(never finalized)";
  console.log(`  ${row.started_at}  ${dur}  rows=${row.rows_imported}  fetched=${row.charges_fetched}  rep=${row.rows_replaced}  err=${row.error_message ?? "—"}`);
}
