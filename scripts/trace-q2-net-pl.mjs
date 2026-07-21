// Trace the Q2 Net P&L hero block. Mirrors the helpers in
// src/lib/financeStats.ts (q2NetRevenueActual, q2ExpensesActual,
// q2NetPLProjected) and breaks down the actual vs projected split.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const Q2_MONTHS = ["Apr 2026", "May 2026", "Jun 2026"];
const MONTH_NUMBER = { "Apr 2026": 3, "May 2026": 4, "Jun 2026": 5 };
const MONTH_DAYS = { "Apr 2026": 30, "May 2026": 31, "Jun 2026": 30 };

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
const fmtSigned = (n) =>
  n > 0 ? "+$" + Math.round(n).toLocaleString("en-US")
       : n < 0 ? "-$" + Math.round(Math.abs(n)).toLocaleString("en-US")
              : "$0";

function isFutureMonth(month) {
  const monthStart = new Date(2026, MONTH_NUMBER[month], 1);
  const todayMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return monthStart.getTime() > todayMonthStart.getTime();
}
function isCurrentMonth(month) {
  return now.getFullYear() === 2026 && now.getMonth() === MONTH_NUMBER[month];
}
function dppExtrapolationFactor(month) {
  if (!isCurrentMonth(month)) return 1;
  const elapsed = now.getDate();
  if (elapsed <= 0) return 1;
  return MONTH_DAYS[month] / elapsed;
}

async function selectAll(table) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from(table)
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

const [revenue, expenses, monthlyExpenses, venues, overrides, schedule] =
  await Promise.all([
    selectAll("fin_revenue"),
    selectAll("fin_expenses"),
    selectAll("fin_monthly_expenses"),
    selectAll("fin_venues"),
    selectAll("fin_venue_cost_overrides"),
    selectAll("fin_schedule"),
  ]);

console.log(`\nToday: ${today}`);
console.log(`Q2 month classification: ${Q2_MONTHS.map(m =>
  isFutureMonth(m) ? `${m}=future` : isCurrentMonth(m) ? `${m}=current` : `${m}=past`).join(", ")}`);
console.log(`DPP factor for Apr 2026: ${dppExtrapolationFactor("Apr 2026").toFixed(4)} (= 30 / ${now.getDate()})`);

// =========================================================
// 1. Revenue Actual breakdown (q2NetRevenueActual)
// =========================================================
console.log("\n========== REVENUE ACTUAL ==========");
console.log("(rows where: month in Q2 AND source != PROJECTION AND date <= today)");
console.log("Summing r.net across qualifying rows.\n");

let revActualTotal = 0;
const revByMonthSource = new Map();
const revByMonth = new Map(Q2_MONTHS.map(m => [m, 0]));

for (const r of revenue) {
  if (!Q2_MONTHS.includes(r.month)) continue;
  if (r.source === "PROJECTION") continue;
  if (r.date > today) continue;
  const k = `${r.month}|${r.source}`;
  revByMonthSource.set(k, (revByMonthSource.get(k) ?? 0) + Number(r.net ?? 0));
  revByMonth.set(r.month, revByMonth.get(r.month) + Number(r.net ?? 0));
  revActualTotal += Number(r.net ?? 0);
}

console.log("By month × source (net):");
for (const m of Q2_MONTHS) {
  const sources = [...revByMonthSource.entries()]
    .filter(([k]) => k.startsWith(m + "|"))
    .map(([k, v]) => [k.split("|")[1], v]);
  if (sources.length === 0) {
    console.log(`  ${m}: (none)`);
    continue;
  }
  for (const [src, v] of sources) {
    console.log(`  ${m.padEnd(10)} ${src.padEnd(12)} ${fmt(v).padStart(12)}`);
  }
  console.log(`  ${m.padEnd(10)} ${"subtotal".padEnd(12)} ${fmt(revByMonth.get(m)).padStart(12)}`);
}
console.log(`\n  q2NetRevenueActual = ${fmt(revActualTotal)}`);

// =========================================================
// 2. Expenses Actual breakdown (q2ExpensesActual)
// =========================================================
console.log("\n========== EXPENSES ACTUAL ==========");
console.log("Three buckets: fin_expenses (date <= today), fieldCostsActual,");
console.log("monthlyExpenses for past+current months.\n");

// Bucket A: fin_expenses with date <= today, by month and category
let expActualTotal = 0;
const expByMonthCat = new Map();
const expByMonth = new Map(Q2_MONTHS.map(m => [m, 0]));
const mmpByMonth = new Map(Q2_MONTHS.map(m => [m, 0]));
const otherFinExpByMonth = new Map(Q2_MONTHS.map(m => [m, 0]));
for (const r of expenses) {
  if (!Q2_MONTHS.includes(r.month)) continue;
  if (r.date > today) continue;
  const k = `${r.month}|${r.category}`;
  expByMonthCat.set(k, (expByMonthCat.get(k) ?? 0) + Number(r.amount ?? 0));
  expByMonth.set(r.month, expByMonth.get(r.month) + Number(r.amount ?? 0));
  if (r.category === "Match Manager Pay") {
    mmpByMonth.set(r.month, mmpByMonth.get(r.month) + Number(r.amount ?? 0));
  } else {
    otherFinExpByMonth.set(r.month, otherFinExpByMonth.get(r.month) + Number(r.amount ?? 0));
  }
  expActualTotal += Number(r.amount ?? 0);
}

console.log("Bucket A — fin_expenses (date <= today):");
for (const m of Q2_MONTHS) {
  const cats = [...expByMonthCat.entries()]
    .filter(([k]) => k.startsWith(m + "|"))
    .sort((a, b) => b[1] - a[1]);
  if (cats.length === 0) {
    console.log(`  ${m}: (none)`);
    continue;
  }
  for (const [k, v] of cats) {
    const cat = k.split("|").slice(1).join("|");
    console.log(`    ${m.padEnd(10)} ${cat.padEnd(28)} ${fmt(v).padStart(10)}`);
  }
  console.log(`    ${m.padEnd(10)} ${"subtotal".padEnd(28)} ${fmt(expByMonth.get(m)).padStart(10)}`);
}
console.log(`  Bucket A total: ${fmt(expActualTotal)}`);

// Bucket B: fieldCostsActual per month
function findOverride(venueId, month) {
  return overrides.find(o => o.venue_id === venueId && o.month === month) ?? null;
}
function fieldCostsForMonth(month) {
  let total = 0;
  for (const v of venues) {
    const ov = findOverride(v.id, month);
    if (ov) { total += Number(ov.override_amount); continue; }
    if (v.billing_type === "per_match") {
      const rate = Number(v.per_match_rate ?? 0);
      const mc = schedule
        .filter(s => s.venue === v.venue_name && s.month === month)
        .reduce((s, r) => s + (Number(r.match_count) ?? 0), 0);
      total += mc * rate;
    } else if (v.billing_type === "per_hour") {
      const rate = Number(v.hourly_rate ?? 0);
      if (rate > 0) {
        const hrs = schedule
          .filter(s => s.venue === v.venue_name && s.month === month)
          .reduce((s, r) => s + (Number(r.total_hours) ?? 0), 0);
        total += hrs * rate;
      }
    }
  }
  return total;
}
function fieldCostsActualForMonth(month) {
  if (isFutureMonth(month)) return 0;
  if (!isCurrentMonth(month)) return fieldCostsForMonth(month);
  // Current month — schedule rows by date, overrides full
  let total = 0;
  for (const v of venues) {
    const ov = findOverride(v.id, month);
    if (ov) { total += Number(ov.override_amount); continue; }
    if (v.billing_type === "per_match") {
      const rate = Number(v.per_match_rate ?? 0);
      for (const s of schedule) {
        if (s.venue !== v.venue_name) continue;
        if (s.month !== month) continue;
        if (s.date > today) continue;
        total += (Number(s.match_count) ?? 0) * rate;
      }
    } else if (v.billing_type === "per_hour") {
      const rate = Number(v.hourly_rate ?? 0);
      if (rate > 0) {
        for (const s of schedule) {
          if (s.venue !== v.venue_name) continue;
          if (s.month !== month) continue;
          if (s.date > today) continue;
          total += (Number(s.total_hours) ?? 0) * rate;
        }
      }
    }
  }
  return total;
}

console.log("\nBucket B — fieldCostsActual:");
let fcActual = 0;
const fcByMonth = new Map();
for (const m of Q2_MONTHS) {
  const v = fieldCostsActualForMonth(m);
  fcByMonth.set(m, v);
  fcActual += v;
  const tag = isFutureMonth(m) ? "future→0" : isCurrentMonth(m) ? "current→by-date" : "past→full";
  console.log(`    ${m.padEnd(10)} ${tag.padEnd(20)} ${fmt(v).padStart(10)}`);
}
console.log(`  Bucket B total: ${fmt(fcActual)}`);

// Bucket C: monthlyExpenses past+current
console.log("\nBucket C — monthlyExpenses (past + current months):");
let meActual = 0;
const meByMonth = new Map();
for (const m of Q2_MONTHS) {
  const v = isFutureMonth(m) ? 0 :
    monthlyExpenses
      .filter(r => r.month === m)
      .reduce((s, r) =>
        s + Number(r.city_manager ?? 0) + Number(r.marketing ?? 0) + Number(r.equipment ?? 0), 0);
  meByMonth.set(m, v);
  meActual += v;
  const tag = isFutureMonth(m) ? "future→0" : "actual";
  console.log(`    ${m.padEnd(10)} ${tag.padEnd(20)} ${fmt(v).padStart(10)}`);
}
console.log(`  Bucket C total: ${fmt(meActual)}`);

const expActualGrandTotal = expActualTotal + fcActual + meActual;
console.log(`\n  q2ExpensesActual = ${fmt(expActualGrandTotal)}`);
console.log(`    A (fin_expenses) ${fmt(expActualTotal)}`);
console.log(`    B (fieldCosts)   ${fmt(fcActual)}`);
console.log(`    C (monthly)      ${fmt(meActual)}`);

// =========================================================
// 3. actualPL
// =========================================================
const actualPL = revActualTotal - expActualGrandTotal;
console.log("\n========== ACTUAL P&L ==========");
console.log(`  Revenue actual:  ${fmt(revActualTotal)}`);
console.log(`  Expenses actual: ${fmt(expActualGrandTotal)}`);
console.log(`  actualPL:        ${fmtSigned(actualPL)}`);

// =========================================================
// 4. q2NetRevenueProjected breakdown (per-month)
// =========================================================
console.log("\n========== REVENUE PROJECTED (q2NetRevenueProjected) ==========");
console.log("Per month: filterRevenueRows(month, 'projection') × dppExtrapolationFactor for DPP\n");

let revProjectedTotal = 0;
const revProjByMonth = new Map();
for (const m of Q2_MONTHS) {
  const factor = dppExtrapolationFactor(m);
  const future = isFutureMonth(m);
  let monthTotal = 0;
  let dppRealizedRaw = 0;
  let dppRealizedScaled = 0;
  let nonDppRealized = 0;
  let projectionRows = 0;
  let projectionRowCount = 0;

  for (const r of revenue) {
    if (r.month !== m) continue;
    if (future && r.source !== "PROJECTION") continue;
    if (!future && r.source === "PROJECTION") continue;
    const v = Number(r.net ?? 0);
    if (future) {
      projectionRows += v;
      projectionRowCount++;
    } else if (r.type === "DPP") {
      dppRealizedRaw += v;
      dppRealizedScaled += v * factor;
    } else {
      nonDppRealized += v;
    }
    monthTotal += future ? v : (r.type === "DPP" ? v * factor : v);
  }
  revProjByMonth.set(m, monthTotal);
  revProjectedTotal += monthTotal;
  console.log(`  ${m}: factor=${factor.toFixed(4)}`);
  if (!future) {
    console.log(`    DPP realized:        ${fmt(dppRealizedRaw)} (raw)`);
    console.log(`    DPP realized × factor: ${fmt(dppRealizedScaled)}`);
    console.log(`    non-DPP realized:    ${fmt(nonDppRealized)}`);
    console.log(`    DPP extrap gain:     ${fmt(dppRealizedScaled - dppRealizedRaw)}`);
  } else {
    console.log(`    PROJECTION rows: ${projectionRowCount} totaling ${fmt(projectionRows)}`);
  }
  console.log(`    month total:         ${fmt(monthTotal)}`);
}
console.log(`\n  q2NetRevenueProjected = ${fmt(revProjectedTotal)}`);

// =========================================================
// 5. q2ExpensesProjected breakdown
// =========================================================
console.log("\n========== EXPENSES PROJECTED (q2ExpensesProjected) ==========");
console.log("Per month: totalExpensesFor(month, 'projection') = filterExpenseRows + fieldCosts + manager pay + monthly");
console.log("filterExpenseRows includes ALL fin_expenses regardless of date (not gated by date <= today, and no future-month gate as of recent fix).\n");

let expProjectedTotal = 0;
const expProjByMonth = new Map();
for (const m of Q2_MONTHS) {
  // filterExpenseRows = ALL fin_expenses for that month
  const finExpAll = expenses
    .filter(r => r.month === m)
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);
  // field costs for the month (full, override-aware)
  const fc = fieldCostsForMonth(m);
  // monthly expenses for the month
  const me = monthlyExpenses
    .filter(r => r.month === m)
    .reduce((s, r) => s + Number(r.city_manager ?? 0) + Number(r.marketing ?? 0) + Number(r.equipment ?? 0), 0);
  // totalExpensesFor inlines: otherNonManagerPay + managerPayFor + fieldCosts + monthly_3
  // but otherNonManagerPay = filterExpenseRows minus MMP, and managerPayFor = MMP. Sum = all fin_expenses.
  const monthTotal = finExpAll + fc + me;
  expProjByMonth.set(m, monthTotal);
  expProjectedTotal += monthTotal;

  // Breakdown of fin_expenses for this month
  const finByCat = new Map();
  for (const r of expenses) {
    if (r.month !== m) continue;
    finByCat.set(r.category, (finByCat.get(r.category) ?? 0) + Number(r.amount ?? 0));
  }
  console.log(`  ${m}:`);
  console.log(`    fin_expenses (all):  ${fmt(finExpAll)}`);
  for (const [cat, v] of [...finByCat.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${cat.padEnd(28)} ${fmt(v).padStart(10)}`);
  }
  console.log(`    field costs:         ${fmt(fc)}`);
  console.log(`    monthly expenses:    ${fmt(me)}`);
  console.log(`    month total:         ${fmt(monthTotal)}`);
}
console.log(`\n  q2ExpensesProjected = ${fmt(expProjectedTotal)}`);

// =========================================================
// 6. q2NetPLProjected & projectedPL
// =========================================================
const netPLProjected = revProjectedTotal - expProjectedTotal;
const projectedPL = netPLProjected - actualPL;

console.log("\n========== NET P&L (PROJECTED) ==========");
console.log(`  q2NetRevenueProjected:  ${fmt(revProjectedTotal)}`);
console.log(`  q2ExpensesProjected:    ${fmt(expProjectedTotal)}`);
console.log(`  q2NetPLProjected:       ${fmtSigned(netPLProjected)}`);
console.log(`\n  actualPL:               ${fmtSigned(actualPL)}`);
console.log(`  projectedPL = netPLProj − actualPL = ${fmtSigned(projectedPL)}`);

// =========================================================
// 7. projectedPL composition: April extrap vs May/Jun PROJECTION rows
// =========================================================
console.log("\n========== PROJECTED PL COMPOSITION ==========");

// April projected slice
const aprRevProjected = revProjByMonth.get("Apr 2026");
const aprExpProjected = expProjByMonth.get("Apr 2026");
const aprNetProjected = aprRevProjected - aprExpProjected;

const aprRevActual = revByMonth.get("Apr 2026");
const aprExpActual = expByMonth.get("Apr 2026") + fcByMonth.get("Apr 2026") + meByMonth.get("Apr 2026");
const aprNetActual = aprRevActual - aprExpActual;

const aprDelta = aprNetProjected - aprNetActual;
console.log(`\n  April: actualPL contribution = ${fmtSigned(aprNetActual)}`);
console.log(`         projectedPL contribution (extrap + remaining) = ${fmtSigned(aprDelta)}`);

// May / June (PROJECTION rows + monthly_expenses + fieldCosts)
for (const m of ["May 2026", "Jun 2026"]) {
  const monthRev = revProjByMonth.get(m);
  const monthExp = expProjByMonth.get(m);
  const monthNet = monthRev - monthExp;
  console.log(`\n  ${m}:`);
  console.log(`    revenue (PROJECTION rows):   ${fmt(monthRev)}`);
  console.log(`    expenses (manual + field + monthly): ${fmt(monthExp)}`);
  console.log(`    net contribution to projectedPL: ${fmtSigned(monthNet)}`);
}

// =========================================================
// 8. PROJECTION rows source check
// =========================================================
console.log("\n========== PROJECTION ROWS — fin_revenue ==========");
const projRows = revenue.filter(r => r.source === "PROJECTION");
console.log(`Total PROJECTION rows in fin_revenue: ${projRows.length}`);
if (projRows.length > 0) {
  console.log("\nSample (first 10):");
  for (const r of projRows.slice(0, 10)) {
    console.log(`  id=${r.id}  ${r.date}  ${r.month}  ${r.city.padEnd(20)}  ${(r.type ?? "").padEnd(10)}  net=${fmt(Number(r.net))}  manual=${r.manual_entry}  notes=${(r.notes ?? "").slice(0, 40)}`);
  }
  console.log("\nBy month + manual_entry flag:");
  const byMm = new Map();
  for (const r of projRows) {
    const k = `${r.month}|${r.manual_entry}`;
    byMm.set(k, (byMm.get(k) ?? 0) + Number(r.net ?? 0));
  }
  for (const [k, v] of byMm) {
    console.log(`  ${k.padEnd(28)} ${fmt(v).padStart(10)}`);
  }
}
