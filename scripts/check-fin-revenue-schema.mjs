import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url,key);

const { data } = await sb.from("fin_revenue").select("*").limit(3);
console.log("Sample rows (columns + types):");
for (const r of data ?? []) console.log(r);

const { data: hat } = await sb
  .from("fin_revenue")
  .select("month, venue, type, gross")
  .ilike("venue", "%hattrick%")
  .limit(5);
console.log("\nDistinct months for any Hattrick row:");
const months = [...new Set((hat ?? []).map((r) => r.month))];
console.log(months);
console.log(`(showing first 5):`, hat);
