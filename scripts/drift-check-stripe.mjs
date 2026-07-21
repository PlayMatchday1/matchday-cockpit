import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

console.log("=== Stripe DPP drift check ===");
const apr = await sb.from("fin_revenue").select("date, venue, gross").eq("type","DPP").eq("source","Stripe").gte("date","2026-04-01").lte("date","2026-04-30");
const may = await sb.from("fin_revenue").select("date, venue, gross").eq("type","DPP").eq("source","Stripe").gte("date","2026-05-01").lte("date","2026-05-31");
const aprTotal = (apr.data ?? []).reduce((s,r) => s+(r.gross??0), 0);
const mayTotal = (may.data ?? []).reduce((s,r) => s+(r.gross??0), 0);
console.log(`Apr: ${apr.data?.length ?? 0} rows, $${Math.round(aprTotal).toLocaleString()} (baseline: 362 rows / $47,923)`);
console.log(`May: ${may.data?.length ?? 0} rows, $${Math.round(mayTotal).toLocaleString()} (baseline: 179 rows / $23,996)`);

console.log("\n=== Did any Stripe rows land in Jan/Feb/Mar from the failed click? ===");
const q1 = await sb.from("fin_revenue").select("date, venue, gross").eq("type","DPP").eq("source","Stripe").gte("date","2026-01-01").lte("date","2026-03-31");
console.log(`Q1 Stripe DPP rows present: ${q1.data?.length ?? 0}`);
if ((q1.data?.length ?? 0) > 0) {
  const total = q1.data.reduce((s,r) => s+(r.gross??0), 0);
  console.log(`  total: $${Math.round(total).toLocaleString()}`);
  const dates = [...new Set(q1.data.map(r => r.date))].sort();
  console.log(`  date range: ${dates[0]} → ${dates[dates.length-1]} (${dates.length} distinct dates)`);
}
