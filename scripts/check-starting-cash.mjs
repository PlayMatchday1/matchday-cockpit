import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const { data, error } = await sb
  .from("fin_config")
  .select("key, value")
  .like("key", "starting_cash%");
if (error) { console.error(error); process.exit(1); }
console.log("starting_cash rows in fin_config:");
for (const r of data) console.log("  ", r.key.padEnd(30), "=", JSON.stringify(r.value));
