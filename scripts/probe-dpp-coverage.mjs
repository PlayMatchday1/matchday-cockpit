import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

console.log("=== fin_revenue: min/max date ===");
const minR = await sb.from("fin_revenue").select("date").order("date", { ascending: true }).limit(1).maybeSingle();
const maxR = await sb.from("fin_revenue").select("date").order("date", { ascending: false }).limit(1).maybeSingle();
console.log(`  min date: ${minR.data?.date}`);
console.log(`  max date: ${maxR.data?.date}`);

console.log("\n=== row counts by month (any type) ===");
const all = await sb.from("fin_revenue").select("month, type, gross, source, date");
const byMonth = new Map();
for (const r of all.data ?? []) {
  if (!byMonth.has(r.month)) byMonth.set(r.month, { rows: 0, gross: 0, types: {} });
  const m = byMonth.get(r.month);
  m.rows++;
  m.gross += r.gross ?? 0;
  m.types[r.type] = (m.types[r.type] ?? 0) + (r.gross ?? 0);
}
for (const [month, x] of [...byMonth.entries()].sort()) {
  console.log(`  ${month.padEnd(10)}  rows=${String(x.rows).padStart(4)}  gross=$${Math.round(x.gross).toLocaleString().padStart(8)}  types: ${Object.entries(x.types).map(([t,v]) => `${t}=$${Math.round(v)}`).join(", ")}`);
}

console.log("\n=== DPP only: source breakdown by month ===");
const dpp = (all.data ?? []).filter(r => r.type === "DPP");
const dppByMonth = new Map();
for (const r of dpp) {
  if (!dppByMonth.has(r.month)) dppByMonth.set(r.month, { rows: 0, gross: 0, sources: {} });
  const m = dppByMonth.get(r.month);
  m.rows++;
  m.gross += r.gross ?? 0;
  m.sources[r.source ?? "(null)"] = (m.sources[r.source ?? "(null)"] ?? 0) + (r.gross ?? 0);
}
for (const [month, x] of [...dppByMonth.entries()].sort()) {
  console.log(`  ${month.padEnd(10)}  rows=${String(x.rows).padStart(4)}  gross=$${Math.round(x.gross).toLocaleString().padStart(7)}  sources: ${Object.entries(x.sources).map(([s,v]) => `${s}=$${Math.round(v)}`).join(", ")}`);
}

console.log("\n=== DPP daily granularity check (May 2026) ===");
const mayDates = new Set(dpp.filter(r => r.month === "May 2026").map(r => r.date));
console.log(`  distinct dates in May 2026: ${mayDates.size}`);
console.log(`  sample: ${[...mayDates].sort().slice(0,5).join(", ")} … ${[...mayDates].sort().slice(-3).join(", ")}`);

console.log("\n=== distinct venues in fin_revenue ===");
const allVenues = new Set((all.data ?? []).map(r => r.venue).filter(Boolean));
console.log(`  count: ${allVenues.size}`);
const dppVenues = new Set(dpp.map(r => r.venue).filter(Boolean));
console.log(`  with DPP rows: ${dppVenues.size}`);
