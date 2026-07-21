import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// ----- 1. All Stripe rows that landed in Jan 1-7 -----
const win = await sb.from("fin_revenue")
  .select("date, venue, city, type, gross, source, notes")
  .eq("source","Stripe")
  .gte("date","2026-01-01")
  .lte("date","2026-01-07")
  .order("date", { ascending: true });
const rows = win.data ?? [];

console.log("=== fin_revenue rows in 2026-01-01..2026-01-07 (Stripe-source only) ===");
console.log(`Total rows: ${rows.length}`);

const byType = new Map();
for (const r of rows) {
  if (!byType.has(r.type)) byType.set(r.type, { rows: 0, gross: 0 });
  byType.get(r.type).rows++;
  byType.get(r.type).gross += r.gross ?? 0;
}
console.log("\nBy type:");
for (const [t, x] of byType.entries()) {
  console.log(`  ${t.padEnd(18)}  rows=${String(x.rows).padStart(3)}  $${Math.round(x.gross).toLocaleString().padStart(6)}`);
}

const dates = [...new Set(rows.map(r => r.date))].sort();
console.log(`\nDistinct dates: ${dates.length} → ${dates.join(", ")}`);

// Specifically — was Jan 7 included?
const jan7Rows = rows.filter(r => r.date === "2026-01-07");
console.log(`\nJan 7 rows: ${jan7Rows.length}  ${jan7Rows.length === 0 ? "← NOT included" : ""}`);

// ----- 2. DPP breakdown (the actual target metric) -----
const dpp = rows.filter(r => r.type === "DPP");
const dppTotal = dpp.reduce((s,r) => s+(r.gross??0), 0);
const dppVenues = new Set(dpp.map(r => r.venue).filter(Boolean));
const dppDates = new Set(dpp.map(r => r.date));
console.log(`\n=== DPP-only stats ===`);
console.log(`  rows: ${dpp.length}`);
console.log(`  total: $${Math.round(dppTotal).toLocaleString()}`);
console.log(`  distinct venues: ${dppVenues.size}`);
console.log(`  distinct dates: ${dppDates.size}`);
console.log(`  venue list: ${[...dppVenues].sort().join(" | ")}`);

// ----- 3. Membership breakdown + Deleted Account Revenue check -----
const mem = rows.filter(r => r.type === "Membership");
const memTotal = mem.reduce((s,r) => s+(r.gross??0), 0);
const memByCity = new Map();
for (const r of mem) {
  const c = r.city ?? "(null)";
  if (!memByCity.has(c)) memByCity.set(c, { rows: 0, gross: 0 });
  memByCity.get(c).rows++;
  memByCity.get(c).gross += r.gross ?? 0;
}
console.log(`\n=== Membership-only stats ===`);
console.log(`  rows: ${mem.length}  total: $${Math.round(memTotal).toLocaleString()}`);
for (const [c, x] of [...memByCity.entries()].sort()) {
  console.log(`  city=${c.padEnd(28)}  rows=${String(x.rows).padStart(3)}  $${Math.round(x.gross).toLocaleString()}`);
}
const deletedAcct = mem.filter(r => r.city === "Deleted Account Revenue");
console.log(`\n  "Deleted Account Revenue" bucket: ${deletedAcct.length} rows, $${Math.round(deletedAcct.reduce((s,r) => s+(r.gross??0),0)).toLocaleString()}`);
for (const r of deletedAcct) {
  console.log(`    date=${r.date}  $${r.gross}  notes=${r.notes ?? ""}`);
}

// ----- 4. Drift check Apr/May -----
console.log(`\n=== Drift check (baseline: Apr 362r/$47,923, May 179r/$23,996) ===`);
const apr = await sb.from("fin_revenue").select("gross").eq("type","DPP").eq("source","Stripe").gte("date","2026-04-01").lte("date","2026-04-30");
const may = await sb.from("fin_revenue").select("gross").eq("type","DPP").eq("source","Stripe").gte("date","2026-05-01").lte("date","2026-05-31");
const aprT = (apr.data ?? []).reduce((s,r) => s+(r.gross??0), 0);
const mayT = (may.data ?? []).reduce((s,r) => s+(r.gross??0), 0);
const aprDelta = aprT - 47923;
const mayDelta = mayT - 23996;
console.log(`  Apr: ${apr.data?.length ?? 0} rows / $${Math.round(aprT).toLocaleString()}  Δ=${Math.round(aprDelta) === 0 ? "ZERO ✓" : "$" + Math.round(aprDelta).toLocaleString() + " ⚠️"}`);
console.log(`  May: ${may.data?.length ?? 0} rows / $${Math.round(mayT).toLocaleString()}  Δ=${Math.round(mayDelta) === 0 ? "ZERO ✓" : "$" + Math.round(mayDelta).toLocaleString() + " ⚠️"}`);

// ----- 5. fin_sync_log row for this attempt -----
console.log(`\n=== fin_sync_log: latest stripe-api row ===`);
const log = await sb.from("fin_sync_log").select("started_at, completed_at, rows_imported, rows_replaced, charges_fetched, charges_succeeded, charges_skipped, error_message").eq("source","stripe-api").order("started_at",{ascending:false}).limit(1).maybeSingle();
console.log(JSON.stringify(log.data, null, 2));
