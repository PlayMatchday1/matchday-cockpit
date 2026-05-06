import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

async function main() {
  const { data: spots } = await sb
    .from("fin_member_spots")
    .select("city, venue, month, member_spots")
    .eq("month", "May 2026");
  console.log(`fin_member_spots May 2026 rows: ${spots?.length ?? 0}`);
  if (spots && spots.length) console.log(spots.slice(0, 5));

  const { data: rev } = await sb
    .from("fin_revenue")
    .select("city, type, month, gross, net")
    .eq("month", "May 2026")
    .eq("type", "Membership")
    .eq("city", "Austin");
  console.log("\nfin_revenue Membership May 2026 Austin:");
  console.log(rev);

  const { data: revApr } = await sb
    .from("fin_revenue")
    .select("city, type, month, gross, net")
    .eq("month", "Apr 2026")
    .eq("type", "Membership")
    .eq("city", "Austin");
  console.log("\nfin_revenue Membership Apr 2026 Austin:");
  console.log(revApr);
}
main().catch(console.error);
