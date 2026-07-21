import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

async function main() {
  // What's in fin_venues that relates to hattrick?
  const { data: v } = await sb.from("fin_venues").select("id, venue_name, raw_venue_name, city");
  console.log("All fin_venues containing 'hat':");
  for (const r of (v ?? []).filter(x => /hat/i.test(x.venue_name + x.raw_venue_name))) console.log("  " + JSON.stringify(r));
  
  // partner_dashboards row?
  const { data: pd } = await sb.from("partner_dashboards").select("*").eq("slug","hattrick-yx4sur4t").maybeSingle();
  console.log("\npartner_dashboards row:");
  console.log("  " + JSON.stringify(pd));
  
  // Does venue_id 3 exist anywhere?
  const { data: v3 } = await sb.from("fin_venues").select("*").eq("id", 3).maybeSingle();
  console.log("\nfin_venues id=3:", JSON.stringify(v3));
}
main().catch(console.error);
