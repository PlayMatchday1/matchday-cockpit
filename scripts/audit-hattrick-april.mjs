import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// Pull all April Hattrick rows once, then aggregate locally — PostgREST
// has no SQL aggregation; equivalent to the SQL queries below.
let rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("fin_revenue")
    .select("date, month, venue, type, gross, fees, source, notes")
    .gte("date", "2026-04-01")
    .lt("date", "2026-05-01")
    .or("venue.ilike.%hattrick%,venue.ilike.%hat trick%,venue.ilike.%hat-trick%")
    .range(from, from + 999);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < 1000) break;
}

// Q1: by month, venue, type
const fmt = (n) =>
  Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

const byKey = new Map();
for (const r of rows) {
  const key = `${r.month}|${r.venue}|${r.type}`;
  const v = byKey.get(key) ?? { ...r, count: 0, total: 0 };
  v.count += 1;
  v.total += Number(r.gross) || 0;
  byKey.set(key, v);
}
console.log("=== Q1: All Hattrick fin_revenue April rows, by type ===");
console.log(
  "month        venue                              type                     rows    total",
);
const sorted = [...byKey.values()].sort((a, b) =>
  (a.type ?? "").localeCompare(b.type ?? ""),
);
for (const r of sorted) {
  console.log(
    `${r.month}  ${String(r.venue ?? "").padEnd(34)}  ${String(r.type ?? "").padEnd(22)}  ${String(r.count).padStart(4)}   ${fmt(r.total).padStart(11)}`,
  );
}

// Q2: sum of all types
const totalApr = rows.reduce((s, r) => s + (Number(r.gross) || 0), 0);
console.log(`\n=== Q2: total_apr ===`);
console.log(fmt(totalApr));
console.log(`(${rows.length} rows total)`);

// Q3: top 20 by amount
console.log(`\n=== Q3: Top rows by amount (LIMIT 20) ===`);
console.log(
  "month        venue                              type                     gross        notes",
);
const top = [...rows]
  .sort((a, b) => (Number(b.gross) || 0) - (Number(a.gross) || 0))
  .slice(0, 20);
for (const r of top) {
  console.log(
    `${r.month}  ${String(r.venue ?? "").padEnd(34)}  ${String(r.type ?? "").padEnd(22)}  ${fmt(r.gross).padStart(10)}  ${(r.notes ?? "").slice(0, 60)}`,
  );
}
