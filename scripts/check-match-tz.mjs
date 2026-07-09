import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// Drea = manager_first_name "Drea" — match her recent matches
const { data } = await sb
  .from("mdapi_matches")
  .select("api_id, city_identifier, field_title, start_date, start_date_utc, raw")
  .eq("manager_first_name", "Drea")
  .gte("start_date", "2026-05-09T00:00:00Z")
  .lt("start_date", "2026-05-11T00:00:00Z")
  .order("start_date")
  .limit(6);

console.log("Drea May 9-10 — column vs raw\n");
for (const r of data ?? []) {
  console.log(`match ${r.api_id}  ${r.city_identifier}  ${r.field_title}`);
  console.log(`  col start_date:      ${r.start_date}`);
  console.log(`  col start_date_utc:  ${r.start_date_utc}`);
  console.log(`  raw.startDate:       ${r.raw?.startDate}`);
  console.log(`  raw.startDateUtc:    ${r.raw?.startDateUtc}`);
  console.log();
}

// Same probe for ATL Hammond Park
console.log("\nATL Hammond Park May 9 (expected 6 PM CT)\n");
const { data: atl } = await sb
  .from("mdapi_matches")
  .select("api_id, field_title, start_date, start_date_utc, raw")
  .eq("city_identifier", "ATL")
  .eq("field_title", "Hammond Park")
  .gte("start_date", "2026-05-09T00:00:00Z")
  .lt("start_date", "2026-05-10T00:00:00Z")
  .limit(2);
for (const r of atl ?? []) {
  console.log(`  col start_date:      ${r.start_date}`);
  console.log(`  col start_date_utc:  ${r.start_date_utc}`);
  console.log(`  raw.startDate:       ${r.raw?.startDate}`);
  console.log(`  raw.startDateUtc:    ${r.raw?.startDateUtc}`);
  console.log();
}
