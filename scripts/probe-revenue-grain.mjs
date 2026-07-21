import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

console.log("=== fin_revenue columns (sample row) ===");
const r = await sb.from("fin_revenue").select("*").limit(2);
if (r.data?.[0]) {
  for (const [k, v] of Object.entries(r.data[0])) console.log("  ", k, "=", JSON.stringify(typeof v === "string" && v.length > 60 ? v.slice(0,60)+"…" : v));
  console.log("\n=== fin_revenue row count ===");
  const c = await sb.from("fin_revenue").select("*", { count: "exact", head: true });
  console.log(`  total rows: ${c.count}`);
  // Are there per-day rows or per-month aggregates?
  console.log("\n=== distinct months in fin_revenue ===");
  const months = await sb.from("fin_revenue").select("month");
  const monthSet = new Set(months.data?.map(x => x.month));
  console.log(`  ${[...monthSet].sort().join(", ")}`);
  // Type field?
  console.log("\n=== distinct types/sources in fin_revenue ===");
  if (r.data[0].type !== undefined || r.data[0].revenue_type !== undefined || r.data[0].source !== undefined) {
    const col = r.data[0].type !== undefined ? "type" : r.data[0].revenue_type !== undefined ? "revenue_type" : "source";
    const rows = await sb.from("fin_revenue").select(col);
    const set = new Set(rows.data?.map(x => x[col]));
    console.log(`  ${col}: ${[...set].join(" | ")}`);
  }
}

// Look for any stripe-related table
console.log("\n=== stripe-related tables ===");
const stripeTables = ["mdapi_subscriptions", "stripe_payments", "stripe_charges", "fin_stripe_payments", "fin_stripe_revenue"];
for (const t of stripeTables) {
  const probe = await sb.from(t).select("*").limit(1);
  if (probe.error) {
    if (probe.error.code !== "42P01") console.log(`  ${t}: error ${probe.error.code}`);
  } else {
    const c = await sb.from(t).select("*", { count: "exact", head: true });
    console.log(`  ${t}: ${c.count} rows; columns: ${probe.data[0] ? Object.keys(probe.data[0]).slice(0,12).join(", ")+"…" : "empty"}`);
  }
}
