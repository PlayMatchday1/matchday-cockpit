// Step 1 of the one-time Hattrick Private Rental split: query the
// candidate row(s). No mutations — read-only.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const { data, error } = await sb
  .from("fin_revenue")
  .select("id, date, city, venue, source, type, gross, fees, net, notes, manual_entry, created_at")
  .eq("date", "2026-04-30")
  .eq("source", "Venmo")
  .eq("type", "Private Rental")
  .eq("gross", 400);

if (error) {
  console.error("Query error:", error);
  process.exit(1);
}

console.log(`Matches: ${data?.length ?? 0}`);
for (const r of data ?? []) {
  console.log(JSON.stringify(r, null, 2));
}
