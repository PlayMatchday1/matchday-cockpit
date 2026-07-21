import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const envText = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const envVars = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) envVars[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(envVars.NEXT_PUBLIC_SUPABASE_URL, envVars.SUPABASE_SERVICE_ROLE_KEY);

const v = await sb.from("fin_venues")
  .select("venue_name, city")
  .or("venue_name.ilike.%lou fusz%,venue_name.ilike.%katy%,venue_name.ilike.%kisc%,venue_name.ilike.%star%,venue_name.ilike.%galatzan%");
console.log("Relevant fin_venues canonical rows:");
for (const r of v.data ?? []) {
  console.log(`  city=${r.city.padEnd(5)}  venue_name="${r.venue_name}"`);
}
