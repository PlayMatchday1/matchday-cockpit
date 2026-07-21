import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const { data, error } = await sb.from("fin_venues").select("*").limit(1);
if (error) { console.error(error); process.exit(1); }
if (data[0]) {
  console.log("fin_venues columns:");
  for (const k of Object.keys(data[0])) console.log("  ", k, "=", JSON.stringify(data[0][k]));
}

const sched = await sb.from("fin_schedule").select("*").limit(1);
if (sched.data?.[0]) {
  console.log("\nfin_schedule columns:");
  for (const k of Object.keys(sched.data[0])) console.log("  ", k, "=", JSON.stringify(sched.data[0][k]));
}

const md = await sb.from("mdapi_matches").select("*").limit(1);
if (md.data?.[0]) {
  console.log("\nmdapi_matches columns:");
  for (const k of Object.keys(md.data[0])) console.log("  ", k, "=", JSON.stringify(md.data[0][k]));
}
