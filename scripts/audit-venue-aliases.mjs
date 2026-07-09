import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const { data: aliases } = await sb
  .from("fin_venue_aliases")
  .select("*")
  .order("alias");
console.log("=== Current fin_venue_aliases rows ===");
for (const r of aliases ?? []) console.log(r);
console.log(`(${(aliases ?? []).length} rows)`);

const { data: venues, error: verr } = await sb
  .from("fin_venues")
  .select("id, city, venue_name")
  .order("venue_name");
if (verr) console.log("fin_venues error:", verr);
console.log("\n=== fin_venues (canonical venue_name) ===");
const seen = new Set();
for (const v of venues ?? []) {
  if (seen.has(v.venue_name)) continue;
  seen.add(v.venue_name);
  console.log(`  ${v.city.padEnd(10)}  canonical='${v.venue_name}'`);
}
console.log(`(${seen.size} distinct canonical names, ${(venues ?? []).length} venue rows incl. day-of-week legs)`);
