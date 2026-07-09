// One-time data fix: split fin_revenue id=54 ($400 Hattrick Apr 30
// Private Rental) into 4 weekly $100 rows for Mar 7/14/21/28. The
// original was misdated; the four Saturday rentals actually happened
// in March. Pre-system settlement already covers March, so this is a
// ledger-accuracy fix.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) =>
  "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 1. DELETE id=54.
console.log("Step 1: DELETE id=54");
const del = await sb.from("fin_revenue").delete().eq("id", 54).select();
if (del.error) {
  console.error("Delete failed:", del.error);
  process.exit(1);
}
console.log(`  deleted ${del.data?.length ?? 0} row(s)`);
for (const r of del.data ?? []) {
  console.log(`  → id=${r.id} date=${r.date} venue=${r.venue} gross=${fmt(r.gross)}`);
}

// 2. INSERT 4 replacement rows.
console.log("\nStep 2: INSERT 4 replacement rows");
const replacements = [
  "2026-03-07",
  "2026-03-14",
  "2026-03-21",
  "2026-03-28",
].map((date) => ({
  date,
  city: "Austin",
  venue: "Hattrick",
  source: "Venmo",
  type: "Private Rental",
  gross: 100,
  fees: 0,
  net: 100,
  notes: "Private rental — Hattrick Saturday split",
  manual_entry: true,
}));
const ins = await sb.from("fin_revenue").insert(replacements).select();
if (ins.error) {
  console.error("Insert failed:", ins.error);
  process.exit(1);
}
console.log(`  inserted ${ins.data?.length ?? 0} row(s)`);
for (const r of ins.data ?? []) {
  console.log(`  → id=${r.id} date=${r.date} venue=${r.venue} gross=${fmt(r.gross)} manual_entry=${r.manual_entry}`);
}

// 3. Verify.
console.log("\nStep 3: Verify Hattrick March 2026 Private Rentals");
const { data: marRows, error: verErr } = await sb
  .from("fin_revenue")
  .select("id, date, venue, gross, net, notes, manual_entry")
  .eq("venue", "Hattrick")
  .eq("source", "Venmo")
  .eq("type", "Private Rental")
  .gte("date", "2026-03-01")
  .lte("date", "2026-03-31")
  .order("date");
if (verErr) {
  console.error("Verify failed:", verErr);
  process.exit(1);
}
console.log(`  March 2026 rows: ${marRows.length}`);
let total = 0;
for (const r of marRows) {
  console.log(
    `  → id=${r.id} date=${r.date} venue=${r.venue} gross=${fmt(r.gross)} notes="${r.notes}" manual_entry=${r.manual_entry}`,
  );
  total += Number(r.gross);
}
console.log(`  TOTAL March Private Rentals (Hattrick / Venmo): ${fmt(total)}`);

// 4. Sanity: confirm id=54 is gone + confirm no Apr Private Rental Hattrick row remains.
console.log("\nStep 4: Sanity — confirm Apr 2026 Hattrick Private Rental cleared");
const { data: aprRows } = await sb
  .from("fin_revenue")
  .select("id, date, venue, gross")
  .eq("venue", "Hattrick")
  .eq("source", "Venmo")
  .eq("type", "Private Rental")
  .gte("date", "2026-04-01")
  .lte("date", "2026-04-30");
console.log(`  Apr 2026 Hattrick Private Rental rows: ${aprRows?.length ?? 0}`);
for (const r of aprRows ?? []) {
  console.log(`  → id=${r.id} date=${r.date} gross=${fmt(r.gross)}`);
}
