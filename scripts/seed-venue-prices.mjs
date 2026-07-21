// Seed dpp_price + member_price for the 21 active venues per Ryan's
// canonical list. Matches by (venue_name, city) so a city-shared venue
// name (no current case but defensive) doesn't cross-pollinate. Reports
// any rows that didn't update.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const SEED = [
  ["Austin",      "San Juan Diego",     12,    72.99],
  ["Austin",      "NEMP",                12,    72.99],
  ["Austin",      "Hattrick",             5,    72.99],
  ["Austin",      "Stony Point",          9,    72.99],
  ["Austin",      "Round Rock",           5,    72.99],
  ["Austin",      "Onion Creek",          5,    72.99],
  ["Dallas",      "Bicentennial Park",   10,    32.48],
  ["Dallas",      "Carroll Senior HS",   10,    32.48],
  ["Dallas",      "Majestic Gardens",     5,    32.48],
  ["Houston",     "ATH Pearland",        12,    72.99],
  ["Houston",     "ATH Katy",             9,    72.99],
  ["Houston",     "KISC (Katy Intl)",     9,    72.99],
  ["Houston",     "PAC Global",           9,    72.99],
  ["San Antonio", "Soccer Central",       9,    53.04],
  ["San Antonio", "STAR",                 5,    53.04],
  ["Atlanta",     "PRUMC",                7,    32.48],
  ["Atlanta",     "Hammond Park",         5,    32.48],
  ["St. Louis",   "Lou Fusz Outdoor",     9,    32.48],
  ["St. Louis",   "Centennial Commons",   5,    32.48],
  ["OKC",         "Scissortail Park",     5,    15],
  ["El Paso",     "Galatzan Park",        1,    15],
];

let updated = 0;
const missing = [];
for (const [city, venue, dpp, member] of SEED) {
  const { data, error } = await sb
    .from("fin_venues")
    .update({ dpp_price: dpp, member_price: member })
    .eq("city", city)
    .eq("venue_name", venue)
    .select("id,venue_name,city,dpp_price,member_price");
  if (error) {
    console.log(`ERROR ${city}/${venue}: ${error.message}`);
    missing.push({ city, venue, reason: error.message });
    continue;
  }
  if (!data || data.length === 0) {
    missing.push({ city, venue, reason: "no row matched" });
    continue;
  }
  if (data.length > 1) {
    console.log(`WARN ${city}/${venue}: ${data.length} rows updated (expected 1)`);
  }
  updated += data.length;
}

console.log(`\nSeeded ${updated} venue rows`);
if (missing.length > 0) {
  console.log(`\nMissing (${missing.length}):`);
  console.table(missing);
}

// Verification: list every fin_venue with its prices.
const { data: all } = await sb
  .from("fin_venues")
  .select("id,venue_name,city,dpp_price,member_price")
  .order("city")
  .order("venue_name");
console.log("\nAll fin_venues after seed:");
console.table(all);
