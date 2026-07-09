// Reconcile April 2026 revenue between Stripe + cockpit hero.
// Diagnostic only — no writes.
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

// --- Q1: Group by source ---
console.log("=== Q1: fin_revenue April 2026, grouped by source ===\n");
const bySource = new Map();
for (const r of apr) {
  const k = r.source || "(null)";
  if (!bySource.has(k)) bySource.set(k, { count: 0, gross: 0, net: 0, fees: 0 });
  const e = bySource.get(k);
  e.count += 1;
  e.gross += Number(r.gross ?? 0);
  e.net += Number(r.net ?? 0);
  e.fees += Number(r.fees ?? 0);
}
console.log(
  "SOURCE         ROWS   SUM(GROSS)        SUM(NET)          SUM(FEES)",
);
console.log("-".repeat(80));
let totGross = 0, totNet = 0, totFees = 0;
for (const [src, e] of [...bySource.entries()].sort((a, b) => b[1].gross - a[1].gross)) {
  console.log(
    `${src.padEnd(13)}  ${String(e.count).padStart(4)}   ${fmt(e.gross).padStart(14)}  ${fmt(e.net).padStart(14)}  ${fmt(e.fees).padStart(14)}`,
  );
  totGross += e.gross; totNet += e.net; totFees += e.fees;
}
console.log("-".repeat(80));
console.log(
  `TOTAL          ${String(apr.length).padStart(4)}   ${fmt(totGross).padStart(14)}  ${fmt(totNet).padStart(14)}  ${fmt(totFees).padStart(14)}`,
);

// --- Q2: Most recent Stripe row created_at ---
console.log("\n=== Q2: Latest Stripe row created_at ===\n");
const stripe = apr.filter((r) => r.source === "Stripe");
if (stripe.length === 0) {
  console.log("(no Stripe rows for Apr 2026)");
} else {
  const sorted = [...stripe].sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
  );
  console.log(`Stripe row count: ${stripe.length}`);
  console.log(`Latest created_at: ${sorted[0].created_at}`);
  console.log(`Latest 5 stripe rows by created_at:`);
  for (const r of sorted.slice(0, 5)) {
    console.log(
      `  id=${String(r.id).padEnd(5)} date=${r.date} type=${r.type.padEnd(12)} city=${(r.city ?? "—").padEnd(14)} gross=${fmt(r.gross)} net=${fmt(r.net)} fees=${fmt(r.fees)} created=${r.created_at}`,
    );
  }
  // Also: look for rows created today.
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const today = stripe.filter((r) => String(r.created_at ?? "").startsWith(todayPrefix));
  console.log(`\nStripe rows created today (${todayPrefix}): ${today.length}`);
}

// --- Q3: explain hero math (already inspected the code) ---
console.log("\n=== Q3: Hero math source ===");
console.log(`
The "April Gross Revenue" hero stat at /admin/finance is rendered by
src/components/FinanceExecHero.tsx:71 with value =
  grossRevenueFor(data, currentMonth, "mtd", now)
defined at src/lib/financeStats.ts:171-184.

Path:
  filterRevenueRows(data, "Apr 2026", "mtd", now)
    -> mtd mode + non-future month
    -> returns ALL rows where source !== "PROJECTION"
  aggregateRevenue(rows, r => r.gross, factor, isFutureProjection=false)
    -> isFutureProjection false (mtd mode)
    -> factor = dppExtrapolationFactor("Apr 2026", now)
       = (isCurrentMonth ? MONTH_DAYS / now.getDate() : 1)
    -> on 2026-04-30 the factor = 30 / 30 = 1.0 (no DPP extrapolation)
  Returns: sum(r.gross) across all non-PROJECTION Apr rows.

So the hero is plain sum(gross) across Stripe + Venmo + MANUAL + any
other non-PROJECTION sources. PRE-FEE (gross), not net.
`);

// --- Q4: Stripe sum reconciliation ---
console.log("=== Q4: fin_revenue source='Stripe' totals ===\n");
const sGross = stripe.reduce((s, r) => s + Number(r.gross ?? 0), 0);
const sNet = stripe.reduce((s, r) => s + Number(r.net ?? 0), 0);
const sFees = stripe.reduce((s, r) => s + Number(r.fees ?? 0), 0);
console.log(`Stripe rows: ${stripe.length}`);
console.log(`sum(gross): ${fmt(sGross)}    Stripe Dashboard "Succeeded": $62,207.25    Δ: ${fmt(sGross - 62207.25)}`);
console.log(`sum(net):   ${fmt(sNet)}`);
console.log(`sum(fees):  ${fmt(sFees)}`);

// --- Q5: Venmo rows ---
console.log("\n=== Q5: Venmo rows for Apr 2026 ===\n");
const venmo = apr.filter((r) => r.source === "Venmo");
if (venmo.length === 0) {
  console.log("(no Venmo rows for Apr 2026)");
} else {
  for (const r of venmo) {
    console.log(
      `id=${String(r.id).padEnd(5)} date=${r.date} type=${(r.type ?? "—").padEnd(15)} city=${(r.city ?? "—").padEnd(14)} venue=${(r.venue ?? "—").padEnd(20)} gross=${fmt(r.gross).padStart(10)} net=${fmt(r.net).padStart(10)} manual=${r.manual_entry} created=${r.created_at}`,
    );
    console.log(`  notes="${r.notes ?? ""}"`);
  }
}

// --- Q6 + Q7: full reconciliation ---
console.log("\n=== Q6+Q7: Full reconciliation of the hero number ===\n");
console.log("Components contributing to grossRevenueFor(data, 'Apr 2026', 'mtd', now):");
console.log("  (sum of r.gross for all rows with source != 'PROJECTION')\n");
const nonProj = apr.filter((r) => r.source !== "PROJECTION");
const heroSum = nonProj.reduce((s, r) => s + Number(r.gross ?? 0), 0);
for (const [src, e] of [...bySource.entries()].sort((a, b) => b[1].gross - a[1].gross)) {
  if (src === "PROJECTION") continue;
  console.log(`  ${src.padEnd(13)}  ${String(e.count).padStart(3)} rows  ${fmt(e.gross).padStart(14)}`);
}
console.log("-".repeat(50));
console.log(`  HERO TOTAL (sum gross, non-PROJECTION):  ${fmt(heroSum)}`);
console.log(`  User-reported hero shows:                $63,716`);
console.log(`  Δ:                                       ${fmt(heroSum - 63716)}`);

// PROJECTION rows for Apr (should be 0 since Apr is current month — bootstrap was for May/Jun only).
const proj = apr.filter((r) => r.source === "PROJECTION");
console.log(`\nPROJECTION rows for Apr 2026 (should be 0): ${proj.length}`);
for (const r of proj) {
  console.log(
    `  id=${r.id} type=${r.type} gross=${fmt(r.gross)} net=${fmt(r.net)} created=${r.created_at}`,
  );
}

// Stripe + Venmo arithmetic
console.log("\n=== Arithmetic reconciliation vs Stripe Dashboard ===\n");
console.log(`Stripe Dashboard Succeeded (post-fee on Stripe's side... actually GROSS): $62,207.25`);
console.log(`Stripe Dashboard Gross volume: $64,924.85 (includes failed/blocked)`);
console.log(`Cockpit fin_revenue Stripe sum(gross):  ${fmt(sGross)}`);
console.log(`Cockpit fin_revenue Venmo  sum(gross):  ${fmt(venmo.reduce((s,r)=>s+Number(r.gross??0),0))}`);
console.log(`Cockpit fin_revenue MANUAL sum(gross):  ${fmt((bySource.get("MANUAL")?.gross ?? 0))}`);
console.log(`Cockpit fin_revenue OTHER  sum(gross):  ${fmt([...bySource.entries()].filter(([s]) => s !== "PROJECTION" && s !== "Stripe" && s !== "Venmo" && s !== "MANUAL").reduce((sum, [, e]) => sum + e.gross, 0))}`);
console.log(`SUM:                                     ${fmt(heroSum)}`);
console.log("");
console.log(`Stripe Succeeded + Venmo: $62,207.25 + $500 = $62,707.25`);
console.log(`vs cockpit hero: ${fmt(heroSum)}`);
console.log(`Δ: ${fmt(heroSum - 62707.25)}`);

console.log("\n=== Q8: Stripe row date distribution (April only?) ===\n");
const dateCounts = new Map();
for (const r of stripe) {
  const d = r.date ?? "(null)";
  if (!dateCounts.has(d)) dateCounts.set(d, { n: 0, gross: 0 });
  const e = dateCounts.get(d);
  e.n += 1;
  e.gross += Number(r.gross ?? 0);
}
const dates = [...dateCounts.entries()].sort();
console.log(`Distinct dates among Stripe Apr 2026 rows: ${dates.length}`);
console.log(`First 3:`);
for (const [d, e] of dates.slice(0, 3)) {
  console.log(`  ${d}: ${e.n} rows, gross=${fmt(e.gross)}`);
}
console.log(`Last 3:`);
for (const [d, e] of dates.slice(-3)) {
  console.log(`  ${d}: ${e.n} rows, gross=${fmt(e.gross)}`);
}
const outOfMonth = stripe.filter((r) => !String(r.date ?? "").startsWith("2026-04"));
console.log(`\nStripe rows where date is NOT in April 2026: ${outOfMonth.length}`);
for (const r of outOfMonth.slice(0, 10)) {
  console.log(`  id=${r.id} date=${r.date} month=${r.month} gross=${fmt(r.gross)}`);
}

console.log(`\n=== Q9: Created_at distribution (when did rows land) ===\n`);
const createdDay = new Map();
for (const r of stripe) {
  const d = String(r.created_at ?? "").slice(0, 10);
  if (!createdDay.has(d)) createdDay.set(d, { n: 0, gross: 0 });
  const e = createdDay.get(d);
  e.n += 1;
  e.gross += Number(r.gross ?? 0);
}
for (const [d, e] of [...createdDay.entries()].sort()) {
  console.log(`  ${d}: ${e.n} rows, gross=${fmt(e.gross)}`);
}
