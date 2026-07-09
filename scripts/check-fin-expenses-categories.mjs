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
  .from("fin_expenses")
  .select("category, amount");

if (error) {
  console.log("ERROR:", error.message);
  process.exit(1);
}

const byCat = new Map();
for (const r of data ?? []) {
  const c = r.category ?? "(null)";
  const e = byCat.get(c) ?? { count: 0, total: 0 };
  e.count += 1;
  e.total += Number(r.amount ?? 0);
  byCat.set(c, e);
}

const rows = [...byCat.entries()]
  .map(([category, { count, total }]) => ({ category, rowCount: count, total }))
  .sort((a, b) => b.total - a.total);

console.log("Distinct fin_expenses.category values:");
console.table(rows);

console.log("\nLooking for Equipment / Marketing / City Manager (case-sensitive):");
for (const target of ["Equipment", "Marketing", "City Manager"]) {
  const e = byCat.get(target);
  console.log(
    `  ${target.padEnd(15)} → ${e ? `${e.count} rows, $${e.total.toLocaleString()}` : "(none)"}`,
  );
}
