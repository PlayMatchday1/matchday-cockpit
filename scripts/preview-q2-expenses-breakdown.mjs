// One-off sanity check for the Q2 expenses actual/projected split.
// Mirrors the logic in src/lib/financeStats.ts q2ExpensesActualBreakdown.
// Run with: node scripts/preview-q2-expenses-breakdown.mjs

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

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

function isFutureMonth(month) {
  const monthStart = new Date(2026, MONTH_NUMBER[month], 1);
  const todayMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return monthStart.getTime() > todayMonthStart.getTime();
}

function isCurrentMonth(month) {
  return now.getFullYear() === 2026 && now.getMonth() === MONTH_NUMBER[month];
}

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

const [expenses, venues, overrides, schedule, monthlyExpenses] =
  await Promise.all([
    selectAll("fin_expenses"),
    selectAll("fin_venues"),
    selectAll("fin_venue_cost_overrides"),
    selectAll("fin_schedule"),
    selectAll("fin_monthly_expenses"),
  ]);

// In the DB, fin_venues.venue_name and fin_schedule.venue are RAW
// (pre-alias) names. The runtime FinanceData mapping in
// useFinanceData.ts adds raw_venue_name / venue_raw keys, but raw
// DB rows don't have those — synthesize them so the join logic
// downstream works.
for (const v of venues) v.raw_venue_name = v.venue_name;
for (const s of schedule) s.venue_raw = s.venue;

console.log(`\nToday (local): ${today}`);
console.log(`Q2 months: ${Q2_MONTHS.join(", ")}`);
console.log(
  `Q2 month classification: ${Q2_MONTHS.map((m) =>
    isFutureMonth(m) ? `${m}=future` : isCurrentMonth(m) ? `${m}=current` : `${m}=past`,
  ).join(", ")}`,
);
console.log("");

// --- fin_expenses date <= today ---
let managerPay = 0;
let manualExpenses = 0;
const managerPayRows = [];
const manualByCategory = {};
for (const r of expenses) {
  if (!Q2_MONTHS.includes(r.month)) continue;
  if (r.date > today) continue;
  if (r.category === "Match Manager Pay") {
    managerPay += Number(r.amount);
    managerPayRows.push(r);
  } else {
    manualExpenses += Number(r.amount);
    manualByCategory[r.category] =
      (manualByCategory[r.category] || 0) + Number(r.amount);
  }
}

// --- fieldCostsActualFor per Q2 month ---
function findOverride(venueId, month) {
  return (
    overrides.find((o) => o.venue_id === venueId && o.month === month) ?? null
  );
}

function fieldCostsForMonth(month) {
  // sum of canonical (override or auto) for every venue, full month
  let total = 0;
  for (const v of venues) {
    const ov = findOverride(v.id, month);
    if (ov) {
      total += Number(ov.override_amount);
      continue;
    }
    if (v.billing_type === "per_match") {
      const rate = Number(v.per_match_rate ?? 0);
      const matchCount = schedule
        .filter((s) => s.venue_raw === v.raw_venue_name && s.month === month)
        .reduce((s, r) => s + (Number(r.match_count) ?? 0), 0);
      total += matchCount * rate;
    } else if (v.billing_type === "per_hour") {
      const rate = Number(v.hourly_rate ?? 0);
      if (rate > 0) {
        const totalHours = schedule
          .filter((s) => s.venue_raw === v.raw_venue_name && s.month === month)
          .reduce((s, r) => s + (Number(r.total_hours) ?? 0), 0);
        total += totalHours * rate;
      }
    }
  }
  return total;
}

function fieldCostsActualForMonth(month) {
  if (isFutureMonth(month)) return 0;
  if (!isCurrentMonth(month)) return fieldCostsForMonth(month);
  // current month
  let total = 0;
  for (const v of venues) {
    const ov = findOverride(v.id, month);
    if (ov) {
      total += Number(ov.override_amount);
      continue;
    }
    if (v.billing_type === "per_match") {
      const rate = Number(v.per_match_rate ?? 0);
      for (const s of schedule) {
        if (s.venue_raw !== v.raw_venue_name) continue;
        if (s.month !== month) continue;
        if (s.date > today) continue;
        total += (Number(s.match_count) ?? 0) * rate;
      }
    } else if (v.billing_type === "per_hour") {
      const rate = Number(v.hourly_rate ?? 0);
      if (rate > 0) {
        for (const s of schedule) {
          if (s.venue_raw !== v.raw_venue_name) continue;
          if (s.month !== month) continue;
          if (s.date > today) continue;
          total += (Number(s.total_hours) ?? 0) * rate;
        }
      }
    }
  }
  return total;
}

let fieldCosts = 0;
const fieldCostsByMonth = {};
for (const m of Q2_MONTHS) {
  const v = fieldCostsActualForMonth(m);
  fieldCostsByMonth[m] = v;
  fieldCosts += v;
}

// --- monthlyExpensesActualFor per Q2 month ---
function monthlyExpenseSumForMonth(month) {
  return monthlyExpenses
    .filter((r) => r.month === month)
    .reduce(
      (s, r) =>
        s + Number(r.city_manager ?? 0) + Number(r.marketing ?? 0) + Number(r.equipment ?? 0),
      0,
    );
}

let monthly = 0;
const monthlyByMonth = {};
for (const m of Q2_MONTHS) {
  const v = isFutureMonth(m) ? 0 : monthlyExpenseSumForMonth(m);
  monthlyByMonth[m] = v;
  monthly += v;
}

const total = managerPay + manualExpenses + fieldCosts + monthly;

const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");

console.log("=== Q2 EXPENSES ACTUAL — BREAKDOWN ===");
console.log("");
console.log(
  `Manager Pay actual:        ${fmt(managerPay).padStart(12)}   (${managerPayRows.length} fin_expenses rows, category='Match Manager Pay', date <= today)`,
);
console.log(
  `Manual fin_expenses actual:${fmt(manualExpenses).padStart(12)}   (other categories, date <= today)`,
);
for (const [cat, amt] of Object.entries(manualByCategory).sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`    ${cat.padEnd(28)} ${fmt(amt).padStart(10)}`);
}
console.log(
  `Field Costs actual:        ${fmt(fieldCosts).padStart(12)}`,
);
for (const [m, v] of Object.entries(fieldCostsByMonth)) {
  const tag = isFutureMonth(m) ? "future→0" : isCurrentMonth(m) ? "current→by-date" : "past→full";
  console.log(`    ${m} (${tag}):        ${fmt(v).padStart(10)}`);
}
console.log(
  `Monthly Expenses actual:   ${fmt(monthly).padStart(12)}   (city_manager + marketing + equipment)`,
);
for (const [m, v] of Object.entries(monthlyByMonth)) {
  const tag = isFutureMonth(m) ? "future→0" : "actual";
  console.log(`    ${m} (${tag}):              ${fmt(v).padStart(10)}`);
}
console.log("");
console.log(`TOTAL Q2 ACTUAL:           ${fmt(total).padStart(12)}`);
console.log("");
