import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// Exact payload shape the dialog produces for the QA spec:
//   QA Test Field 1 / El Paso / per_match / pm=100 / cpm=50
const payload = {
  venue_name: "QA Test Field 1",
  city: "El Paso",
  billing_type: "per_match",
  per_match_rate: 100,
  hourly_rate: null,
  cost_per_match: 50,
  max_spots: null,
  dpp_price: null,
  member_price: null,
  launch_date: null,
  notes: null,
  is_active: true,
};

console.log("Attempting INSERT…");
const { data, error } = await sb
  .from("fin_venues")
  .insert(payload)
  .select()
  .single();

if (error) {
  console.error("INSERT FAILED:");
  console.error(JSON.stringify(error, null, 2));
  process.exit(1);
}
console.log("INSERT OK. Row:");
console.log("  id:", data.id);
console.log("  venue_name:", data.venue_name);
console.log("  city:", data.city);
console.log("  billing_type:", data.billing_type);
console.log("  per_match_rate:", data.per_match_rate);
console.log("  cost_per_match:", data.cost_per_match);
console.log("  is_active:", data.is_active);

// Now verify the uniqueness guard would have caught a re-insert.
console.log("\nAttempting duplicate INSERT (should be rejected by unique index)…");
const dupe = await sb.from("fin_venues").insert(payload).select().single();
if (!dupe.error) {
  console.error("UNEXPECTED: duplicate INSERT succeeded — unique index not applied?");
  process.exit(1);
}
console.log("DUPLICATE rejected as expected:");
console.log("  code:", dupe.error.code);
console.log("  message:", dupe.error.message);

// Cleanup.
console.log("\nCleaning up test row…");
const del = await sb.from("fin_venues").delete().eq("id", data.id);
if (del.error) {
  console.error("DELETE failed:", del.error);
  process.exit(1);
}
console.log("Test row deleted. Done.");
