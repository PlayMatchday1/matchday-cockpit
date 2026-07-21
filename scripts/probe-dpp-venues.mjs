import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// Distinct venues across the DPP rows
const dpp = await sb.from("fin_revenue").select("date, venue, gross, source, type").eq("type", "DPP");
const allRows = dpp.data ?? [];
const venues = new Set(allRows.map(r => r.venue).filter(Boolean));
console.log(`DPP rows: ${allRows.length}; distinct venues: ${venues.size}`);
console.log(`Sample venues: ${[...venues].slice(0, 12).join(" | ")}`);

// Stripe only — what dates cover?
const stripe = allRows.filter(r => r.source === "Stripe");
const dates = [...new Set(stripe.map(r => r.date))].sort();
console.log(`\nStripe-source DPP rows: ${stripe.length}; date range: ${dates[0]} → ${dates[dates.length-1]} (${dates.length} distinct dates)`);

// Per-month Stripe coverage
const byMonth = new Map();
for (const r of stripe) {
  const m = r.date.slice(0,7);
  if (!byMonth.has(m)) byMonth.set(m, { rows: 0, gross: 0, venues: new Set(), dates: new Set() });
  const o = byMonth.get(m);
  o.rows++;
  o.gross += r.gross ?? 0;
  o.venues.add(r.venue);
  o.dates.add(r.date);
}
console.log("\nPer-month Stripe DPP coverage:");
for (const [m, o] of [...byMonth.entries()].sort()) {
  console.log(`  ${m}: ${o.rows} rows, $${Math.round(o.gross).toLocaleString()}, ${o.venues.size} venues, ${o.dates.size} dates`);
}

// PROJECTION rows look like aggregates — confirm
console.log("\nPROJECTION DPP rows (full):");
const proj = allRows.filter(r => r.source === "PROJECTION");
for (const r of proj) console.log(" ", JSON.stringify(r));

// Are there ANY non-DPP non-Stripe revenue rows pre-April that might be DPP miscategorized?
console.log("\nAll fin_revenue rows before 2026-04-01:");
const early = await sb.from("fin_revenue").select("date, venue, type, source, gross, notes").lt("date", "2026-04-01");
for (const r of early.data ?? []) console.log(" ", JSON.stringify(r));
