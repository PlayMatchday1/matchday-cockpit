import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

console.log("=== 1. Schema check on fin_expenses ===");
const { data: oneRow } = await sb.from("fin_expenses").select("*").limit(1);
if (!oneRow || oneRow.length === 0) {
  console.log("(no rows to read schema from)");
} else {
  console.log("Columns:", Object.keys(oneRow[0]));
  console.log("Sample row:", JSON.stringify(oneRow[0], null, 2));
}

console.log("\n=== 2. fin_monthly_expenses still present? ===");
const { count: meCount, error: meErr } = await sb
  .from("fin_monthly_expenses")
  .select("*", { count: "exact", head: true });
if (meErr) {
  console.log(`  fin_monthly_expenses: ${meErr.message}`);
} else {
  console.log(`  fin_monthly_expenses row count: ${meCount}`);
}

console.log("\n=== 3. Existing City Manager rows in fin_expenses ===");
const { data: cmRows } = await sb
  .from("fin_expenses")
  .select("*")
  .eq("category", "City Manager")
  .order("date");
console.log(`  count: ${(cmRows ?? []).length}`);
if ((cmRows ?? []).length > 0) {
  console.table(
    cmRows.map((r) => ({
      id: r.id,
      date: r.date,
      city: r.city,
      vendor: r.vendor,
      amount: r.amount,
      notes: r.notes,
    })),
  );
}

console.log("\n=== 4. Distinct city spellings in fin_expenses ===");
const { data: allRows } = await sb
  .from("fin_expenses")
  .select("city");
const citySet = new Map();
for (const r of allRows ?? []) {
  const k = r.city ?? "(null)";
  citySet.set(k, (citySet.get(k) ?? 0) + 1);
}
console.table(
  [...citySet.entries()].map(([city, n]) => ({ city, rows: n })).sort((a, b) =>
    String(a.city).localeCompare(String(b.city)),
  ),
);

console.log("\n=== 5. Distinct categories in fin_expenses ===");
const { data: catRows } = await sb.from("fin_expenses").select("category");
const cats = new Map();
for (const r of catRows ?? []) {
  cats.set(r.category, (cats.get(r.category) ?? 0) + 1);
}
console.table(
  [...cats.entries()].map(([category, n]) => ({ category, rows: n })),
);

console.log(
  "\n=== 6. Pre-check for duplicates among the 20 rows about to be inserted ===",
);
const candidates = [
  ["Anton", "El Paso", "2026-04-11", 500],
  ["Anton", "El Paso", "2026-05-11", 317],
  ["Abraham", "San Antonio", "2026-04-15", 500],
  ["Abraham", "San Antonio", "2026-05-15", 500],
  ["Abraham", "San Antonio", "2026-06-15", 500],
  ["Gabe", "Austin", "2026-04-15", 500],
  ["Gabe", "Austin", "2026-05-15", 500],
  ["Gabe", "Austin", "2026-06-15", 500],
  ["Chris", "Dallas", "2026-04-15", 800],
  ["Chris", "Dallas", "2026-05-15", 800],
  ["Chris", "Dallas", "2026-06-15", 800],
  ["Rodrigo", "OKC", "2026-04-01", 500],
  ["Rodrigo", "OKC", "2026-05-01", 500],
  ["Rodrigo", "OKC", "2026-06-01", 500],
  ["Yarra", "Houston", "2026-04-05", 500],
  ["Yarra", "Houston", "2026-05-05", 500],
  ["Yarra", "Houston", "2026-06-05", 500],
  ["Willfried", "St. Louis", "2026-04-05", 500],
  ["Willfried", "St. Louis", "2026-05-05", 500],
  ["Willfried", "St. Louis", "2026-06-05", 500],
];
let dupCount = 0;
for (const [vendor, city, date, amount] of candidates) {
  const { data: matches } = await sb
    .from("fin_expenses")
    .select("id, date, city, vendor, amount, category")
    .eq("date", date)
    .eq("city", city)
    .eq("vendor", vendor)
    .eq("amount", amount)
    .eq("category", "City Manager");
  if (matches && matches.length > 0) {
    dupCount += matches.length;
    console.log(
      `  DUP: ${vendor} / ${city} / ${date} / $${amount} → ${matches.length} existing row(s) id=${matches.map((m) => m.id).join(",")}`,
    );
  }
}
if (dupCount === 0) console.log("  (no duplicates found — safe to insert all 20)");

console.log("\n=== 7. Author/created_by/manual_entry default columns ===");
// Looked at oneRow above — re-print just the metadata-y columns to check
// what defaults are assumed.
if (oneRow && oneRow.length > 0) {
  const r = oneRow[0];
  console.log({
    manual_entry: r.manual_entry,
    created_at: r.created_at,
    created_by: r.created_by,
  });
}
