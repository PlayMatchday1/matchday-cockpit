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

// Pull Mar with all distinguishing columns
const mar = await paginateAll(
  sb.from("fin_revenue").select("id, date, venue, city, type, source, gross, notes")
    .eq("type","DPP").eq("source","Stripe")
    .gte("date","2026-03-01").lte("date","2026-03-31")
);

// Find (date, venue) groups with >1 row
const byKey = new Map();
for (const r of mar) {
  const k = `${r.date}|${r.venue ?? "(null)"}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(r);
}
const dupGroups = [...byKey.entries()].filter(([, rows]) => rows.length > 1);

console.log(`=== (date, venue) groups with >1 row: ${dupGroups.length} ===`);
for (const [k, rows] of dupGroups) {
  console.log(`\nKEY: ${k}  (${rows.length} rows, total $${Math.round(rows.reduce((s,r) => s+(r.gross??0), 0))})`);
  for (const r of rows) {
    console.log(`  id=${r.id}  city=${JSON.stringify(r.city)}  $${r.gross}  notes=${JSON.stringify((r.notes ?? "").slice(0,80))}`);
  }
}

// Are the dupes city-collisions (same venue name in different cities)?
let cityCollisions = 0, sameCityDupes = 0;
for (const [, rows] of dupGroups) {
  const cities = new Set(rows.map(r => r.city));
  if (cities.size > 1) cityCollisions++;
  else sameCityDupes++;
}
console.log(`\nSplit: city-collisions=${cityCollisions}  same-city-dupes=${sameCityDupes}`);

// Compare with Jan/Feb same check (no dupes was reported earlier — re-verify)
console.log(`\n=== Cross-month (date, venue) dup check ===`);
for (const monthRange of [["2026-01","31"], ["2026-02","28"], ["2026-04","30"], ["2026-05","31"]]) {
  const [m, end] = monthRange;
  const rows = await paginateAll(sb.from("fin_revenue").select("date, venue, city").eq("type","DPP").eq("source","Stripe").gte("date", `${m}-01`).lte("date", `${m}-${end}`));
  const map = new Map();
  for (const r of rows) {
    const k = `${r.date}|${r.venue}`;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  const dups = [...map.values()].filter(v => v > 1).length;
  console.log(`  ${m}: ${rows.length} rows, ${map.size} distinct (date,venue), ${dups} duplicate pairs`);
}
