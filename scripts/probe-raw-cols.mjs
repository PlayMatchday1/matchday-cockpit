import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// Try to explicitly select raw_venue_name
const a = await sb.from("fin_venues").select("id, venue_name, raw_venue_name").limit(2);
console.log("fin_venues raw_venue_name select:");
console.log(JSON.stringify(a, null, 2).slice(0, 500));

const b = await sb.from("fin_schedule").select("id, venue, venue_raw").limit(2);
console.log("\nfin_schedule venue_raw select:");
console.log(JSON.stringify(b, null, 2).slice(0, 500));
