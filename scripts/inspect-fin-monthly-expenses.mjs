import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const { count } = await sb
  .from("fin_monthly_expenses")
  .select("*", { count: "exact", head: true });
console.log(`fin_monthly_expenses row count: ${count}\n`);

const { data, error } = await sb
  .from("fin_monthly_expenses")
  .select("*")
  .order("month", { ascending: true })
  .order("city", { ascending: true });

if (error) {
  console.log("ERROR:", error.message);
  process.exit(1);
}

console.log("All rows:");
console.table(data);

console.log("\nNon-zero rows for city_manager / marketing / equipment:");
const nonZero = data.filter(
  (r) => (r.city_manager ?? 0) || (r.marketing ?? 0) || (r.equipment ?? 0),
);
if (nonZero.length === 0) {
  console.log("(none — all values are 0 or null)");
} else {
  console.table(
    nonZero.map((r) => ({
      id: r.id,
      city: r.city,
      month: r.month,
      city_manager: r.city_manager,
      marketing: r.marketing,
      equipment: r.equipment,
    })),
  );
}

console.log("\nColumn-level totals:");
const tot = (k) => data.reduce((s, r) => s + (r[k] ?? 0), 0);
console.log(`  city_manager: $${tot("city_manager").toLocaleString()}`);
console.log(`  marketing:    $${tot("marketing").toLocaleString()}`);
console.log(`  equipment:    $${tot("equipment").toLocaleString()}`);

console.log(
  "\nDistinct (city, month) pairs with any non-zero value above:",
  nonZero.length,
);
