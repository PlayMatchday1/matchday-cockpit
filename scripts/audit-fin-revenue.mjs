// Forensic check on fin_revenue: duplicates, Stripe source/status,
// date-range distribution, and totals comparison vs Stripe Dashboard.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

async function selectAll(table, select = "*") {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
const rev = await selectAll("fin_revenue");
console.log(`\nTotal fin_revenue rows: ${rev.length}`);

const bySource = new Map();
for (const r of rev) {
  bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
}
console.log("\nRows by source:");
for (const [s, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s ?? "(null)"}: ${n}`);
}

const stripe = rev.filter((r) => r.source === "Stripe");
console.log(`\nStripe rows: ${stripe.length}`);

// --- 1. Check for dupes on aggregation key (date, city, type, venue) ---
console.log("\n=== DUPLICATE CHECK ===");
console.log("Looking for multiple Stripe rows on same (date, city, type, venue):\n");
const keyMap = new Map();
for (const r of stripe) {
  const key = `${r.date}|${r.city}|${r.type}|${r.venue ?? ""}`;
  const arr = keyMap.get(key) ?? [];
  arr.push(r);
  keyMap.set(key, arr);
}
const dupes = [...keyMap.entries()].filter(([, arr]) => arr.length > 1);
console.log(`Aggregation-key duplicates: ${dupes.length}`);
if (dupes.length > 0) {
  console.log("  Top 20 by occurrence count:");
  const sorted = dupes
    .map(([k, arr]) => ({
      key: k,
      count: arr.length,
      grossSum: arr.reduce((s, r) => s + Number(r.gross ?? 0), 0),
      netSum: arr.reduce((s, r) => s + Number(r.net ?? 0), 0),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  for (const d of sorted) {
    console.log(
      `    ${d.key.padEnd(60)}  count=${d.count}  gross=${fmt(d.grossSum)}  net=${fmt(d.netSum)}`,
    );
  }
}

// --- 2. Daily counts to spot overlap-window doubling ---
console.log("\n=== DAILY ROW COUNTS (Stripe) ===");
console.log("Last 30 dates:\n");
const byDate = new Map();
for (const r of stripe) {
  const cur = byDate.get(r.date) ?? { rows: 0, gross: 0, net: 0 };
  cur.rows += 1;
  cur.gross += Number(r.gross ?? 0);
  cur.net += Number(r.net ?? 0);
  byDate.set(r.date, cur);
}
const sortedDates = [...byDate.entries()].sort((a, b) =>
  a[0].localeCompare(b[0]),
);
const last30 = sortedDates.slice(-30);
console.log("  date         rows  gross         net");
for (const [date, v] of last30) {
  console.log(
    `  ${date}   ${String(v.rows).padStart(3)}   ${fmt(v.gross).padStart(12)}  ${fmt(v.net).padStart(12)}`,
  );
}

// --- 3. April MTD totals ---
console.log("\n=== APRIL 2026 MTD TOTALS (Stripe) ===\n");
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
const aprStripe = stripe.filter(
  (r) => r.date >= "2026-04-01" && r.date <= today,
);
const aprGross = aprStripe.reduce((s, r) => s + Number(r.gross ?? 0), 0);
const aprFees = aprStripe.reduce((s, r) => s + Number(r.fees ?? 0), 0);
const aprNet = aprStripe.reduce((s, r) => s + Number(r.net ?? 0), 0);
console.log(`  Window: 2026-04-01 → ${today}`);
console.log(`  Rows:    ${aprStripe.length}`);
console.log(`  Gross:   ${fmt(aprGross)}`);
console.log(`  Fees:    ${fmt(aprFees)}`);
console.log(`  Net:     ${fmt(aprNet)}`);

// Breakdown by type
const byType = new Map();
for (const r of aprStripe) {
  const cur = byType.get(r.type) ?? { rows: 0, gross: 0, net: 0 };
  cur.rows += 1;
  cur.gross += Number(r.gross ?? 0);
  cur.net += Number(r.net ?? 0);
  byType.set(r.type, cur);
}
console.log("  By type:");
for (const [t, v] of byType) {
  console.log(
    `    ${t.padEnd(12)}  rows=${String(v.rows).padStart(4)}  gross=${fmt(v.gross).padStart(11)}  net=${fmt(v.net).padStart(11)}`,
  );
}

// --- 4. Negative or zero amounts (refunds / chargebacks) ---
console.log("\n=== ZERO/NEGATIVE AMOUNT ROWS ===\n");
const zeroOrNeg = stripe.filter(
  (r) => Number(r.gross ?? 0) <= 0 || Number(r.net ?? 0) <= 0,
);
console.log(`  Zero/negative rows: ${zeroOrNeg.length}`);
if (zeroOrNeg.length > 0) {
  console.log("  First 20:");
  for (const r of zeroOrNeg.slice(0, 20)) {
    console.log(
      `    ${r.date}  ${r.city.padEnd(20)}  ${String(r.type).padEnd(12)}  gross=${fmt(r.gross)}  net=${fmt(r.net)}  notes=${(r.notes ?? "").slice(0, 40)}`,
    );
  }
}

// --- 5. Manual_entry stripe rows (suspicious — Stripe rows shouldn't be manual) ---
console.log("\n=== MANUAL-ENTRY STRIPE ROWS ===\n");
const manualStripe = stripe.filter((r) => r.manual_entry);
console.log(`  Manual-entry Stripe rows: ${manualStripe.length}`);
if (manualStripe.length > 0 && manualStripe.length < 30) {
  for (const r of manualStripe) {
    console.log(
      `    ${r.date}  ${r.city.padEnd(20)}  ${String(r.type).padEnd(12)}  gross=${fmt(r.gross)}  notes=${(r.notes ?? "").slice(0, 40)}`,
    );
  }
}
