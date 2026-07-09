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

// (a) Jan DPP totals
console.log("=== (a) Jan 1-31 DPP totals ===");
const jan = await paginateAll(
  sb.from("fin_revenue").select("date, venue, gross")
    .eq("type","DPP").eq("source","Stripe")
    .gte("date","2026-01-01").lte("date","2026-01-31")
    .order("date", { ascending: true })
);
const janTotal = jan.reduce((s,r) => s+(r.gross??0), 0);
const janVenues = new Set(jan.map(r => r.venue).filter(Boolean));
const janDates = new Set(jan.map(r => r.date));
const dates = [...janDates].sort();
console.log(`  rows=${jan.length}  $${Math.round(janTotal).toLocaleString()}  venues=${janVenues.size}  dates=${janDates.size}`);
console.log(`  earliest=${dates[0]}  latest=${dates[dates.length-1]}`);

// (b) Jan 31 inclusion
console.log("\n=== (b) Jan 31 inclusion ===");
const jan31 = jan.filter(r => r.date === "2026-01-31");
const jan31Total = jan31.reduce((s,r) => s+(r.gross??0), 0);
console.log(`  rows on 2026-01-31: ${jan31.length}  $${Math.round(jan31Total).toLocaleString()}`);
console.log(`  included? ${jan31.length > 0 ? "YES ✓" : "NO — Jan 31 missing"}`);

// (c) Drift check Apr/May
console.log("\n=== (c) Apr / May DPP drift check ===");
const apr = await paginateAll(
  sb.from("fin_revenue").select("date, gross")
    .eq("type","DPP").eq("source","Stripe")
    .gte("date","2026-04-01").lte("date","2026-04-30")
);
const may = await paginateAll(
  sb.from("fin_revenue").select("date, gross")
    .eq("type","DPP").eq("source","Stripe")
    .gte("date","2026-05-01").lte("date","2026-05-31")
);
const aprT = apr.reduce((s,r) => s+(r.gross??0), 0);
const mayT = may.reduce((s,r) => s+(r.gross??0), 0);
console.log(`  2026-04:  rows=${apr.length}  $${Math.round(aprT).toLocaleString()}  baseline=362r/$47,923  Δ=${Math.round(aprT-47923) === 0 ? "ZERO ✓" : "$" + Math.round(aprT-47923).toLocaleString() + " ⚠️"}`);
console.log(`  2026-05:  rows=${may.length}  $${Math.round(mayT).toLocaleString()}  baseline=179r/$23,996  Δ=${Math.round(mayT-23996) === 0 ? "ZERO ✓" : "$" + Math.round(mayT-23996).toLocaleString() + " ⚠️"}`);

// (d) Coverage table across all months
console.log("\n=== (d) Coverage table (type=DPP, source=Stripe) ===");
const all = await paginateAll(
  sb.from("fin_revenue").select("date, venue, gross")
    .eq("type","DPP").eq("source","Stripe")
);
const byMonth = new Map();
for (const r of all) {
  const m = (r.date).slice(0,7);
  if (!byMonth.has(m)) byMonth.set(m, { rows: 0, gross: 0, venues: new Set(), dates: new Set() });
  const o = byMonth.get(m);
  o.rows++;
  o.gross += r.gross ?? 0;
  o.venues.add(r.venue);
  o.dates.add(r.date);
}
for (const [m, o] of [...byMonth.entries()].sort()) {
  console.log(`  ${m}:  rows=${String(o.rows).padStart(4)}  $${Math.round(o.gross).toLocaleString().padStart(8)}  venues=${o.venues.size}  dates=${o.dates.size}`);
}

// (e) Subset check — Jan 1-6 should still match $8,972
console.log("\n=== (e) Subset check: Jan 1-6 (within Jan full) vs $8,972 pre-flight baseline ===");
const jan16 = jan.filter(r => r.date >= "2026-01-01" && r.date <= "2026-01-06");
const jan16Total = jan16.reduce((s,r) => s+(r.gross??0), 0);
const jan16Delta = jan16Total - 8972;
console.log(`  Jan 1-6 in new Jan dataset:  rows=${jan16.length}  $${Math.round(jan16Total).toLocaleString()}`);
console.log(`  baseline (pre-flight):       43 rows / $8,972`);
console.log(`  Δ rows: ${jan16.length - 43}  Δ $: ${Math.round(jan16Delta) === 0 ? "ZERO ✓" : "$" + Math.round(jan16Delta).toLocaleString() + (Math.abs(jan16Delta) < 1 ? " (rounding) ✓" : " ⚠️")}`);

// Duplicate check — exact (date, venue) duplicates within Jan?
console.log("\n=== Duplicate check within Jan (date, venue) groupings ===");
const seen = new Map();
const dupes = [];
for (const r of jan) {
  const k = `${r.date}|${r.venue}`;
  if (seen.has(k)) dupes.push({ key: k, prev: seen.get(k), now: r.gross });
  else seen.set(k, r.gross);
}
console.log(`  distinct (date, venue) keys: ${seen.size}`);
console.log(`  duplicate (date, venue) pairs: ${dupes.length}  ${dupes.length === 0 ? "✓" : "⚠️"}`);
if (dupes.length > 0) {
  for (const d of dupes.slice(0,5)) console.log(`    ${d.key} prev=$${d.prev} now=$${d.now}`);
}

// Sync log for the Jan run
console.log("\n=== fin_sync_log: latest stripe-api row ===");
const log = await sb.from("fin_sync_log").select("started_at, completed_at, rows_imported, rows_replaced, charges_fetched, charges_succeeded, charges_skipped, error_message").eq("source","stripe-api").order("started_at",{ascending:false}).limit(1).maybeSingle();
const dur = log.data?.completed_at ? Math.round((new Date(log.data.completed_at) - new Date(log.data.started_at))/1000) : null;
console.log(`  ${log.data?.started_at} → ${log.data?.completed_at} (${dur}s)`);
console.log(`  rows_imported=${log.data?.rows_imported}  charges_fetched=${log.data?.charges_fetched}  succeeded=${log.data?.charges_succeeded}  skipped=${log.data?.charges_skipped}  rows_replaced=${log.data?.rows_replaced}  err=${log.data?.error_message ?? "—"}`);
