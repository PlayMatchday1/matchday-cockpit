import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// One row to see columns
const { data: sample } = await sb.from("mdapi_reviews").select("*").limit(1);
console.log("Sample mdapi_reviews row keys:", Object.keys(sample?.[0] ?? {}));
console.log("Sample:", JSON.stringify(sample?.[0] ?? {}, null, 2));

// Count by month for San Antonio
const { data: sa } = await sb.from("mdapi_reviews").select("start_date, star_rating, manager_first_name").eq("city", "San Antonio");
const byMonth = new Map();
for (const r of sa ?? []) {
  if (!r.start_date) continue;
  const ym = String(r.start_date).slice(0, 7);
  byMonth.set(ym, (byMonth.get(ym) ?? 0) + 1);
}
console.log("\nSan Antonio review counts by year-month:");
console.table([...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([m, c]) => ({ month: m, count: c })));
