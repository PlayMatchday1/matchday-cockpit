import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);
const { data, error, count } = await sb
  .from("field_week_projections")
  .select("*", { count: "exact" });
if (error) { console.error(error); process.exit(1); }
console.log(`Saved projection rows: ${count ?? data.length}`);
console.table(data);
