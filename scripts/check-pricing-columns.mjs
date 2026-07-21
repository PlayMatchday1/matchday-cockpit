import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const { data, error } = await sb
  .from("fin_venues")
  .select("id,venue_name,dpp_price,member_price")
  .limit(1);
if (error) {
  console.log("ERROR:", error.message);
  console.log("→ pricing columns DO NOT exist yet, ALTER TABLE needed first.");
} else {
  console.log("Sample row:", data[0]);
  console.log("→ pricing columns exist (or are queryable).");
}
