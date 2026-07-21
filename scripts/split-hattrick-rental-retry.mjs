// Retry: insert 4 Hattrick replacement rows without `net` (generated
// column). The DELETE of id=54 already succeeded in the prior run.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) =>
  "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Sanity: confirm id=54 is gone before re-inserting.
const sanity = await sb.from("fin_revenue").select("id").eq("id", 54);
if (sanity.error) {
  console.error("Sanity query failed:", sanity.error);
  process.exit(1);
}
if ((sanity.data?.length ?? 0) > 0) {
  console.error("ABORT: id=54 still exists; refusing to insert replacements.");
  process.exit(1);
}
console.log("Sanity: id=54 is gone ✓");

// Confirm no Mar Hattrick rentals exist yet (idempotency guard — if a
// prior partial run already inserted them, don't double-insert).
const { data: existing } = await sb
  .from("fin_revenue")
  .select("id, date")
  .eq("venue", "Hattrick")
  .eq("source", "Venmo")
  .eq("type", "Private Rental")
  .gte("date", "2026-03-01")
  .lte("date", "2026-03-31");
if ((existing?.length ?? 0) > 0) {
  console.error(`ABORT: ${existing.length} March Hattrick rental row(s) already exist:`);
  for (const r of existing) console.error(`  id=${r.id} date=${r.date}`);
  process.exit(1);
}
console.log("Sanity: no March Hattrick rental rows yet ✓");

// INSERT (no `net`).
const replacements = [
  "2026-03-07",
  "2026-03-14",
  "2026-03-21",
  "2026-03-28",
].map((date) => ({
  date,
  month: "Mar 2026",
  city: "Austin",
  venue: "Hattrick",
  source: "Venmo",
  type: "Private Rental",
  gross: 100,
  fees: 0,
  notes: "Private rental — Hattrick Saturday split",
  manual_entry: true,
}));
const ins = await sb.from("fin_revenue").insert(replacements).select();
if (ins.error) {
  console.error("Insert failed:", ins.error);
  process.exit(1);
}
console.log(`\nInserted ${ins.data?.length ?? 0} row(s):`);
for (const r of ins.data ?? []) {
  console.log(`  id=${r.id} date=${r.date} venue=${r.venue} gross=${fmt(r.gross)} net=${fmt(r.net)} manual_entry=${r.manual_entry}`);
}

// Verify.
console.log("\nVerify: Hattrick March 2026 Private Rentals");
const { data: marRows } = await sb
  .from("fin_revenue")
  .select("id, date, venue, gross, net, notes, manual_entry")
  .eq("venue", "Hattrick")
  .eq("source", "Venmo")
  .eq("type", "Private Rental")
  .gte("date", "2026-03-01")
  .lte("date", "2026-03-31")
  .order("date");
console.log(`  March 2026 rows: ${marRows.length}`);
let total = 0;
for (const r of marRows) {
  console.log(`  → id=${r.id} date=${r.date} gross=${fmt(r.gross)} net=${fmt(r.net)}`);
  total += Number(r.gross);
}
console.log(`  TOTAL: ${fmt(total)}`);

// Sanity: confirm Apr 2026 Hattrick Private Rental rows are clear.
const { data: aprRows } = await sb
  .from("fin_revenue")
  .select("id, date, gross")
  .eq("venue", "Hattrick")
  .eq("source", "Venmo")
  .eq("type", "Private Rental")
  .gte("date", "2026-04-01")
  .lte("date", "2026-04-30");
console.log(`\n  Apr 2026 Hattrick Private Rental rows: ${aprRows?.length ?? 0} (should be 0)`);
