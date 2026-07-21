// Per-type breakdown of fin_revenue Apr 2026 Stripe rows + per-type
// CSV reconciliation.
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

async function selectAll(table, filters = {}) {
  const out = []; let from = 0; const PAGE = 1000;
  while (true) {
    let q = sb.from(table).select("*").range(from, from + PAGE - 1);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

const apr = await selectAll("fin_revenue", { month: "Apr 2026" });
const stripe = apr.filter((r) => r.source === "Stripe");

console.log("=== fin_revenue Apr 2026, Stripe rows, grouped by type ===\n");
const byType = new Map();
for (const r of stripe) {
  const k = r.type || "(null)";
  if (!byType.has(k)) byType.set(k, { count: 0, gross: 0, net: 0, fees: 0 });
  const e = byType.get(k);
  e.count += 1;
  e.gross += Number(r.gross ?? 0);
  e.net += Number(r.net ?? 0);
  e.fees += Number(r.fees ?? 0);
}
console.log(
  "TYPE         ROWS   SUM(GROSS)        SUM(NET)          SUM(FEES)",
);
console.log("-".repeat(80));
let totGross = 0, totNet = 0, totFees = 0;
for (const [t, e] of [...byType.entries()].sort((a, b) => b[1].gross - a[1].gross)) {
  console.log(
    `${t.padEnd(11)}  ${String(e.count).padStart(4)}   ${fmt(e.gross).padStart(14)}  ${fmt(e.net).padStart(14)}  ${fmt(e.fees).padStart(14)}`,
  );
  totGross += e.gross; totNet += e.net; totFees += e.fees;
}
console.log("-".repeat(80));
console.log(
  `TOTAL        ${String(stripe.length).padStart(4)}   ${fmt(totGross).padStart(14)}  ${fmt(totNet).padStart(14)}  ${fmt(totFees).padStart(14)}`,
);

// CSV-reported buckets
const CSV = {
  match:  { rows: 4213, gross: 49461.94 },
  sub:    { rows: 378,  gross: 14991.78, subUpdate: 13053.65, subCreate: 1938.13 },
  strike: { rows: 3,    gross: 64.95 },
  total:  { rows: 4213 + 378 + 3, gross: 64518.67 },
};

console.log("\n=== Per-type reconciliation: CSV vs cockpit ===\n");
console.log("BUCKET           CSV rows   CSV gross         COCKPIT rows   COCKPIT gross    Δ (cockpit − CSV)");
console.log("-".repeat(110));

const dpp = byType.get("DPP") ?? { count: 0, gross: 0 };
console.log(
  `DPP/match        ${String(CSV.match.rows).padStart(8)}   ${fmt(CSV.match.gross).padStart(14)}    ${String(dpp.count).padStart(11)}   ${fmt(dpp.gross).padStart(14)}    ${fmt(dpp.gross - CSV.match.gross).padStart(12)}`,
);

const mem = byType.get("Membership") ?? { count: 0, gross: 0 };
console.log(
  `Membership/sub   ${String(CSV.sub.rows).padStart(8)}   ${fmt(CSV.sub.gross).padStart(14)}    ${String(mem.count).padStart(11)}   ${fmt(mem.gross).padStart(14)}    ${fmt(mem.gross - CSV.sub.gross).padStart(12)}`,
);

const str = byType.get("Strike") ?? { count: 0, gross: 0 };
console.log(
  `Strike           ${String(CSV.strike.rows).padStart(8)}   ${fmt(CSV.strike.gross).padStart(14)}    ${String(str.count).padStart(11)}   ${fmt(str.gross).padStart(14)}    ${fmt(str.gross - CSV.strike.gross).padStart(12)}`,
);

console.log("-".repeat(110));
const cockpitTotal = (dpp.gross ?? 0) + (mem.gross ?? 0) + (str.gross ?? 0);
console.log(
  `TOTAL            ${String(CSV.total.rows).padStart(8)}   ${fmt(CSV.total.gross).padStart(14)}    ${String(stripe.length).padStart(11)}   ${fmt(cockpitTotal).padStart(14)}    ${fmt(cockpitTotal - CSV.total.gross).padStart(12)}`,
);

// City distribution within Membership rows — does any sit in DELETED_ACCOUNT_CITY?
console.log("\n=== Stripe Membership rows by city (Apr 2026) ===\n");
const membership = stripe.filter((r) => r.type === "Membership");
const memByCity = new Map();
for (const r of membership) {
  const c = r.city || "(null)";
  if (!memByCity.has(c)) memByCity.set(c, { count: 0, gross: 0 });
  const e = memByCity.get(c);
  e.count += 1;
  e.gross += Number(r.gross ?? 0);
}
console.log(`Total Membership rows: ${membership.length}, sum gross: ${fmt(membership.reduce((s, r) => s + Number(r.gross ?? 0), 0))}`);
console.log("\nCITY                          ROWS   GROSS");
console.log("-".repeat(60));
for (const [c, e] of [...memByCity.entries()].sort((a, b) => b[1].gross - a[1].gross)) {
  console.log(`${c.padEnd(30)}  ${String(e.count).padStart(4)}   ${fmt(e.gross).padStart(14)}`);
}

// Are there any rows with type = "Membership" but unusual fees or gross=0?
console.log("\n=== Membership rows with gross = 0 or fees != 0 ===\n");
const oddMem = membership.filter((r) => Number(r.gross ?? 0) === 0 || Number(r.fees ?? 0) !== 0);
console.log(`Rows with gross=0: ${membership.filter((r) => Number(r.gross ?? 0) === 0).length}`);
console.log(`Rows with fees!=0: ${membership.filter((r) => Number(r.fees ?? 0) !== 0).length}`);
if (oddMem.length > 0 && oddMem.length <= 10) {
  for (const r of oddMem) {
    console.log(`  id=${r.id} date=${r.date} city=${r.city} gross=${fmt(r.gross)} fees=${fmt(r.fees)} notes="${r.notes ?? ""}"`);
  }
}

// Per-day Stripe breakdown to spot any missing dates
console.log("\n=== Per-day Stripe rows (Apr 2026, by date) ===\n");
const byDay = new Map();
for (const r of stripe) {
  const d = r.date ?? "(null)";
  if (!byDay.has(d)) byDay.set(d, { count: 0, gross: 0 });
  const e = byDay.get(d);
  e.count += 1;
  e.gross += Number(r.gross ?? 0);
}
const days = [...byDay.entries()].sort();
console.log(`Distinct dates: ${days.length}`);
let totalDayGross = 0;
for (const [d, e] of days) {
  console.log(`  ${d}: ${String(e.count).padStart(3)} rows  ${fmt(e.gross).padStart(12)}`);
  totalDayGross += e.gross;
}
console.log(`  TOTAL: ${fmt(totalDayGross)}`);
