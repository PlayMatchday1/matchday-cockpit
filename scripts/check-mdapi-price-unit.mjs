import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);
const { data } = await sb
  .from("mdapi_matches")
  .select(
    "api_id, city_identifier, field_title, name, registration_price, additional_spot_price, max_player_count, raw",
  )
  .eq("city_identifier", "ATL")
  .gte("start_date", "2026-05-04T00:00:00Z")
  .lt("start_date", "2026-05-11T00:00:00Z")
  .limit(8);
for (const r of data ?? []) {
  const rawPrice = r.raw?.registrationPrice;
  const rawSpot = r.raw?.additionalSpotPrice;
  console.log(
    `${r.api_id}  ${r.field_title?.padEnd(18)}  col reg=${String(r.registration_price).padStart(6)}  col spot=${String(r.additional_spot_price).padStart(6)}  raw reg=${rawPrice}  raw spot=${rawSpot}`,
  );
}
