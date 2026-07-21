// Sanity check: old vs new actualPL for the Q2 Net P&L hero block.
// Mirrors the helpers exactly: q2NetRevenueActual / q2ExpensesActual
// (old) vs q2NetPLActualClosedMonth (new), both composed from the
// same primitives the page uses.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const Q2 = ["Apr 2026", "May 2026", "Jun 2026"];
const MONTH_NUMBER = { "Apr 2026": 3, "May 2026": 4, "Jun 2026": 5 };
const MONTH_DAYS = { "Apr 2026": 30, "May 2026": 31, "Jun 2026": 30 };

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
const fmtSig = (n) =>
  n > 0 ? "+$" + Math.round(n).toLocaleString("en-US")
       : n < 0 ? "-$" + Math.round(Math.abs(n)).toLocaleString("en-US")
              : "$0";

function isFuture(month) {
  const monthStart = new Date(2026, MONTH_NUMBER[month], 1);
  const todayMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return monthStart.getTime() > todayMonthStart.getTime();
}
function isCurrent(month) {
  return now.getFullYear() === 2026 && now.getMonth() === MONTH_NUMBER[month];
}
function dppFactor(month) {
  if (!isCurrent(month)) return 1;
  const elapsed = now.getDate();
  if (elapsed <= 0) return 1;
  return MONTH_DAYS[month] / elapsed;
}

async function selectAll(table) {
  const out = []; let from = 0; const PAGE = 1000;
  while (true) {
    const { data, error } = await sb.from(table).select("*").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

const [revenue, expenses, monthlyExpenses, venues, overrides, schedule] = await Promise.all([
  selectAll("fin_revenue"), selectAll("fin_expenses"),
  selectAll("fin_monthly_expenses"), selectAll("fin_venues"),
  selectAll("fin_venue_cost_overrides"), selectAll("fin_schedule"),
]);

// Mirror filterRevenueRows + applyDppExtrapolation
function netRevenueFor(month, mode) {
  const rows = revenue.filter(r => r.month === month);
  const future = isFuture(month);
  let kept;
  if (mode === "mtd") {
    if (future) kept = [];
    else kept = rows.filter(r => r.source !== "PROJECTION");
  } else {
    if (future) kept = rows.filter(r => r.source === "PROJECTION");
    else kept = rows.filter(r => r.source !== "PROJECTION");
  }
  const factor = mode === "projection" ? dppFactor(month) : 1;
  let total = 0;
  for (const r of kept) {
    const v = Number(r.net ?? 0);
    if (factor !== 1 && r.source !== "PROJECTION" && r.type === "DPP") total += v * factor;
    else total += v;
  }
  return total;
}

function findOverride(venueId, month) {
  return overrides.find(o => o.venue_id === venueId && o.month === month) ?? null;
}
function fieldCostsFor(month) {
  let total = 0;
  for (const v of venues) {
    const ov = findOverride(v.id, month);
    if (ov) { total += Number(ov.override_amount); continue; }
    if (v.billing_type === "per_match") {
      const rate = Number(v.per_match_rate ?? 0);
      const mc = schedule.filter(s => s.venue === v.venue_name && s.month === month).reduce((s, r) => s + (Number(r.match_count) ?? 0), 0);
      total += mc * rate;
    } else if (v.billing_type === "per_hour") {
      const rate = Number(v.hourly_rate ?? 0);
      if (rate > 0) {
        const hrs = schedule.filter(s => s.venue === v.venue_name && s.month === month).reduce((s, r) => s + (Number(r.total_hours) ?? 0), 0);
        total += hrs * rate;
      }
    }
  }
  return total;
}

function totalExpensesFor(month) {
  // Mirror totalExpensesFor in projection mode: all fin_expenses + fieldCosts + monthlyExp 3
  const finExp = expenses.filter(r => r.month === month).reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const fc = fieldCostsFor(month);
  const me = monthlyExpenses.filter(r => r.month === month).reduce((s, r) =>
    s + Number(r.city_manager ?? 0) + Number(r.marketing ?? 0) + Number(r.equipment ?? 0), 0);
  return finExp + fc + me;
}

// =========================================================
// Old actualPL = q2NetRevenueActual − q2ExpensesActual
// =========================================================
let revActual = 0;
for (const r of revenue) {
  if (!Q2.includes(r.month)) continue;
  if (r.source === "PROJECTION") continue;
  if (r.date > today) continue;
  revActual += Number(r.net ?? 0);
}
let expActualA = 0; // fin_expenses with date <= today
for (const r of expenses) {
  if (!Q2.includes(r.month)) continue;
  if (r.date > today) continue;
  expActualA += Number(r.amount ?? 0);
}
let expActualB = 0; // fieldCosts past + by-date current
for (const m of Q2) {
  if (isFuture(m)) continue;
  if (!isCurrent(m)) { expActualB += fieldCostsFor(m); continue; }
  // current month — by-date schedule walk
  for (const v of venues) {
    const ov = findOverride(v.id, m);
    if (ov) { expActualB += Number(ov.override_amount); continue; }
    if (v.billing_type === "per_match") {
      const rate = Number(v.per_match_rate ?? 0);
      for (const s of schedule) {
        if (s.venue !== v.venue_name) continue;
        if (s.month !== m) continue;
        if (s.date > today) continue;
        expActualB += (Number(s.match_count) ?? 0) * rate;
      }
    } else if (v.billing_type === "per_hour") {
      const rate = Number(v.hourly_rate ?? 0);
      if (rate > 0) {
        for (const s of schedule) {
          if (s.venue !== v.venue_name) continue;
          if (s.month !== m) continue;
          if (s.date > today) continue;
          expActualB += (Number(s.total_hours) ?? 0) * rate;
        }
      }
    }
  }
}
let expActualC = 0;
for (const m of Q2) {
  if (isFuture(m)) continue;
  expActualC += monthlyExpenses.filter(r => r.month === m).reduce((s, r) =>
    s + Number(r.city_manager ?? 0) + Number(r.marketing ?? 0) + Number(r.equipment ?? 0), 0);
}
const expActual = expActualA + expActualB + expActualC;
const oldActualPL = revActual - expActual;

// =========================================================
// New actualPL = q2NetPLActualClosedMonth
// =========================================================
let newActualPL = 0;
const perMonth = [];
for (const m of Q2) {
  if (isFuture(m)) {
    perMonth.push({ month: m, status: "future→0", rev: 0, exp: 0, net: 0 });
    continue;
  }
  const rev = netRevenueFor(m, "projection");
  const exp = totalExpensesFor(m);
  const net = rev - exp;
  newActualPL += net;
  const status = isCurrent(m) ? "current (full-month closed projection)" : "past (realized total)";
  perMonth.push({ month: m, status, rev, exp, net });
}

// =========================================================
// q2NetPLProjected (unchanged)
// =========================================================
let netPLProjected = 0;
for (const m of Q2) {
  netPLProjected += netRevenueFor(m, "projection") - totalExpensesFor(m);
}
const oldProjectedPL = netPLProjected - oldActualPL;
const newProjectedPL = netPLProjected - newActualPL;

console.log(`\nToday: ${today}\n`);
console.log("=== q2NetPLActualClosedMonth — per-month breakdown ===");
for (const r of perMonth) {
  console.log(`  ${r.month.padEnd(10)} ${r.status.padEnd(40)} rev=${fmt(r.rev).padStart(10)}  exp=${fmt(r.exp).padStart(10)}  net=${fmtSig(r.net).padStart(10)}`);
}
console.log(`  Total newActualPL: ${fmtSig(newActualPL)}`);

console.log("\n=== Hero rebalance ===");
console.log(`  q2NetPLProjected (unchanged):       ${fmtSig(netPLProjected)}`);
console.log(`  Old actualPL (rev−exp through today): ${fmtSig(oldActualPL)}`);
console.log(`  New actualPL (closed-month sum):    ${fmtSig(newActualPL)}`);
console.log(`  Delta (new − old):                  ${fmtSig(newActualPL - oldActualPL)}`);
console.log(`  Old projectedPL:                    ${fmtSig(oldProjectedPL)}`);
console.log(`  New projectedPL:                    ${fmtSig(newProjectedPL)}`);
console.log(`\n  Identity check: newActualPL + newProjectedPL = ${fmtSig(newActualPL + newProjectedPL)} (should equal q2NetPLProjected ${fmtSig(netPLProjected)}) ${newActualPL + newProjectedPL === netPLProjected ? "✓" : ""}`);
