import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const r = await sb.from("fin_sync_log").select("*").eq("source","stripe-api").order("started_at",{ascending:false}).limit(5);
console.log("=== Last 5 stripe-api rows in fin_sync_log ===");
for (const row of r.data ?? []) {
  const dur = row.completed_at ? `${Math.round((new Date(row.completed_at) - new Date(row.started_at))/1000)}s` : "(never finalized)";
  console.log(`  ${row.started_at}  by=${row.triggered_by}  ${dur}  rows=${row.rows_imported}  fetched=${row.charges_fetched}  rep=${row.rows_replaced}  err=${row.error_message ?? "—"}`);
}
