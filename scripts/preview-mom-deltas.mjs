// Walk through monthOverMonthDeltas for current vs next month using
// the same composition the helper would do. Pulls live data and
// computes per-category and per-type deltas.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const Q2 = ["Apr 2026", "May 2026", "Jun 2026"];
const MONTH_NUMBER = { "Apr 2026": 3, "May 2026": 4, "Jun 2026": 5 };
const MONTH_DAYS = { "Apr 2026": 30, "May 2026": 31, "Jun 2026": 30 };

const now = new Date();
const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
const fmtSig = (n) =>
  n > 0 ? "+$" + Math.round(n).toLocaleString("en-US")
       : n < 0 ? "-$" + Math.round(Math.abs(n)).toLocaleString("en-US")
              : "$0";

function isFuture(month) {
  const ms = new Date(2026, MONTH_NUMBER[month], 1);
  const tms = new Date(now.getFullYear(), now.getMonth(), 1);
  return ms.getTime() > tms.getTime();
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

// =========================================================
// REVENUE BY TYPE per month (projection mode)
// =========================================================
function revenueByTypeForMonth(month) {
  const future = isFuture(month);
  const rows = revenue.filter(r => r.month === month && (future ? r.source === "PROJECTION" : r.source !== "PROJECTION"));
  const factor = dppFactor(month);
  const byType = new Map();
  for (const r of rows) {
    const v = Number(r.net ?? 0);
    const scaled = (factor !== 1 && r.source !== "PROJECTION" && r.type === "DPP") ? v * factor : v;
    byType.set(r.type, (byType.get(r.type) ?? 0) + scaled);
  }
  return byType;
}

// =========================================================
// EXPENSES BY CATEGORY per month (projection mode)
// Categories: fin_expenses categories + synthetic "Field Costs"
// + "City Manager" + "Marketing" + "Equipment"
// =========================================================
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
// Per-venue field costs for driver attribution
function fieldCostsByVenue(month) {
  const byVenue = new Map();
  for (const v of venues) {
    const ov = findOverride(v.id, month);
    let amt = 0;
    if (ov) amt = Number(ov.override_amount);
    else if (v.billing_type === "per_match") {
      const rate = Number(v.per_match_rate ?? 0);
      const mc = schedule.filter(s => s.venue === v.venue_name && s.month === month).reduce((s, r) => s + (Number(r.match_count) ?? 0), 0);
      amt = mc * rate;
    } else if (v.billing_type === "per_hour") {
      const rate = Number(v.hourly_rate ?? 0);
      if (rate > 0) {
        const hrs = schedule.filter(s => s.venue === v.venue_name && s.month === month).reduce((s, r) => s + (Number(r.total_hours) ?? 0), 0);
        amt = hrs * rate;
      }
    }
    if (amt > 0) byVenue.set(`${v.city} · ${v.venue_name}`, amt);
  }
  return byVenue;
}
function monthlyExpensesByCity(month, key) {
  const byCity = new Map();
  for (const r of monthlyExpenses) {
    if (r.month !== month) continue;
    const v = Number(r[key] ?? 0);
    if (v > 0) byCity.set(r.city, v);
  }
  return byCity;
}
function fin_expensesByCategory(month) {
  const byCat = new Map();
  for (const r of expenses) {
    if (r.month !== month) continue;
    byCat.set(r.category, (byCat.get(r.category) ?? 0) + Number(r.amount ?? 0));
  }
  return byCat;
}
function expensesByCategoryForMonth(month) {
  const byCat = new Map(fin_expensesByCategory(month)); // includes Match Manager Pay + Subscriptions + etc.
  byCat.set("Field Costs", fieldCostsForMonth(month));
  // monthly_expenses split into 3 categories
  const me = monthlyExpenses.filter(r => r.month === month);
  let cm = 0, mk = 0, eq = 0;
  for (const r of me) { cm += Number(r.city_manager ?? 0); mk += Number(r.marketing ?? 0); eq += Number(r.equipment ?? 0); }
  byCat.set("City Manager", cm);
  byCat.set("Marketing", mk);
  byCat.set("Equipment", eq);
  return byCat;
}

// =========================================================
// Driver string composers
// =========================================================
function topContributorCity(map, fallback) {
  if (map.size === 0) return fallback;
  const top = [...map.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  return top ? top[0] : fallback;
}
function expenseDriverString(category, currentMonth, nextMonth) {
  if (category === "Field Costs") {
    const cur = fieldCostsByVenue(currentMonth);
    const nxt = fieldCostsByVenue(nextMonth);
    const deltas = new Map();
    const allKeys = new Set([...cur.keys(), ...nxt.keys()]);
    for (const k of allKeys) deltas.set(k, (nxt.get(k) ?? 0) - (cur.get(k) ?? 0));
    const top = [...deltas.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    return top ? `Driven by ${top[0]} (${fmtSig(top[1])})` : "Field-cost mix shift";
  }
  if (category === "Match Manager Pay") {
    const curByCity = new Map();
    for (const r of expenses) if (r.month === currentMonth && r.category === "Match Manager Pay" && r.city) curByCity.set(r.city, (curByCity.get(r.city) ?? 0) + Number(r.amount ?? 0));
    const nxtByCity = new Map();
    for (const r of expenses) if (r.month === nextMonth && r.category === "Match Manager Pay" && r.city) nxtByCity.set(r.city, (nxtByCity.get(r.city) ?? 0) + Number(r.amount ?? 0));
    const deltas = new Map();
    const allKeys = new Set([...curByCity.keys(), ...nxtByCity.keys()]);
    for (const k of allKeys) deltas.set(k, (nxtByCity.get(k) ?? 0) - (curByCity.get(k) ?? 0));
    const top = [...deltas.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    return top ? `Driven by ${top[0]} (${fmtSig(top[1])})` : "Manager pay mix shift";
  }
  if (category === "City Manager" || category === "Marketing" || category === "Equipment") {
    const key = category === "City Manager" ? "city_manager" : category === "Marketing" ? "marketing" : "equipment";
    const cur = monthlyExpensesByCity(currentMonth, key);
    const nxt = monthlyExpensesByCity(nextMonth, key);
    const deltas = new Map();
    const allKeys = new Set([...cur.keys(), ...nxt.keys()]);
    for (const k of allKeys) deltas.set(k, (nxt.get(k) ?? 0) - (cur.get(k) ?? 0));
    const top = [...deltas.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    return top ? `Driven by ${top[0]} (${fmtSig(top[1])})` : `${category} mix shift`;
  }
  // Generic for fin_expenses categories without per-X attribution
  const curTot = fin_expensesByCategory(currentMonth).get(category) ?? 0;
  const nxtTot = fin_expensesByCategory(nextMonth).get(category) ?? 0;
  if (curTot === 0 && nxtTot > 0) return `New in ${nextMonth.split(" ")[0]}`;
  if (nxtTot === 0 && curTot > 0) return `Ends in ${currentMonth.split(" ")[0]}`;
  if (nxtTot > curTot) return "Higher next month";
  return "Lower next month";
}
function revenueDriverString(type, currentMonth, nextMonth) {
  // For DPP: per-venue (revenue rows have venue field)
  if (type === "DPP") {
    const cur = new Map(); const nxt = new Map();
    for (const r of revenue) {
      if (r.type !== "DPP" || r.source === "PROJECTION") continue;
      if (r.month === currentMonth && r.venue) cur.set(r.venue, (cur.get(r.venue) ?? 0) + Number(r.net ?? 0));
    }
    for (const r of revenue) {
      if (r.type !== "DPP") continue;
      // For next-month (May/Jun), revenue is PROJECTION-source, no venue attribution
      if (r.month === nextMonth && r.venue) nxt.set(r.venue, (nxt.get(r.venue) ?? 0) + Number(r.net ?? 0));
    }
    if (cur.size === 0 && nxt.size === 0) {
      // No venue attribution available — likely PROJECTION rows for both
      return isFuture(nextMonth) ? `${nextMonth.split(" ")[0]} target from PROJECTION estimate` : "DPP mix shift";
    }
    const deltas = new Map();
    const all = new Set([...cur.keys(), ...nxt.keys()]);
    for (const k of all) deltas.set(k, (nxt.get(k) ?? 0) - (cur.get(k) ?? 0));
    const top = [...deltas.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    return top ? `Driven by ${top[0]} (${fmtSig(top[1])})` : "DPP mix shift";
  }
  if (type === "Membership") {
    return isFuture(nextMonth) ? `${nextMonth.split(" ")[0]} target from PROJECTION estimate` : "Membership renewals";
  }
  return `${type} mix shift`;
}

// =========================================================
// Detect current vs next month
// =========================================================
function findCurrentMonth() {
  for (const m of Q2) if (isCurrent(m)) return m;
  // No current Q2 month — bail
  return null;
}
const currentMonth = findCurrentMonth();
const idx = currentMonth ? Q2.indexOf(currentMonth) : -1;
const nextMonth = idx >= 0 && idx < Q2.length - 1 ? Q2[idx + 1] : null;

console.log(`\nToday: ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
console.log(`currentMonth: ${currentMonth ?? "(none — outside Q2)"}`);
console.log(`nextMonth: ${nextMonth ?? "(none — currentMonth is last in Q2)"}`);

if (!currentMonth || !nextMonth) {
  console.log("\nNo comparison possible — hero would render hidden / placeholder.");
  process.exit(0);
}

// =========================================================
// Compute deltas
// =========================================================
console.log("\n========== EXPENSE CATEGORIES ==========");
const expCur = expensesByCategoryForMonth(currentMonth);
const expNxt = expensesByCategoryForMonth(nextMonth);
const allCats = new Set([...expCur.keys(), ...expNxt.keys()]);
const expDeltas = [];
for (const cat of allCats) {
  const c = expCur.get(cat) ?? 0;
  const n = expNxt.get(cat) ?? 0;
  expDeltas.push({ cat, current: c, next: n, delta: n - c });
}
expDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
console.log(`${"Category".padEnd(26)} ${"Apr (proj)".padStart(12)} ${"May (proj)".padStart(12)} ${"Δ".padStart(12)}`);
for (const e of expDeltas) {
  console.log(`${e.cat.padEnd(26)} ${fmt(e.current).padStart(12)} ${fmt(e.next).padStart(12)} ${fmtSig(e.delta).padStart(12)}`);
}
const topExp = expDeltas[0];
console.log(`\nBiggest expense delta: ${topExp.cat} ${fmtSig(topExp.delta)}`);
console.log(`Driver: ${expenseDriverString(topExp.cat, currentMonth, nextMonth)}`);

console.log("\n========== REVENUE TYPES ==========");
const revCur = revenueByTypeForMonth(currentMonth);
const revNxt = revenueByTypeForMonth(nextMonth);
const allTypes = new Set([...revCur.keys(), ...revNxt.keys()]);
const revDeltas = [];
for (const t of allTypes) {
  const c = revCur.get(t) ?? 0;
  const n = revNxt.get(t) ?? 0;
  revDeltas.push({ type: t, current: c, next: n, delta: n - c });
}
revDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
console.log(`${"Type".padEnd(20)} ${"Apr (proj)".padStart(12)} ${"May (proj)".padStart(12)} ${"Δ".padStart(12)}`);
for (const r of revDeltas) {
  console.log(`${r.type.padEnd(20)} ${fmt(r.current).padStart(12)} ${fmt(r.next).padStart(12)} ${fmtSig(r.delta).padStart(12)}`);
}
const topRev = revDeltas[0];
console.log(`\nBiggest revenue delta: ${topRev.type} ${fmtSig(topRev.delta)}`);
console.log(`Driver: ${revenueDriverString(topRev.type, currentMonth, nextMonth)}`);

console.log("\n========== NET P&L DELTA ==========");
const curRevTotal = [...revCur.values()].reduce((s, v) => s + v, 0);
const curExpTotal = [...expCur.values()].reduce((s, v) => s + v, 0);
const curNet = curRevTotal - curExpTotal;
const nxtRevTotal = [...revNxt.values()].reduce((s, v) => s + v, 0);
const nxtExpTotal = [...expNxt.values()].reduce((s, v) => s + v, 0);
const nxtNet = nxtRevTotal - nxtExpTotal;
console.log(`${currentMonth} Net P&L (proj): ${fmtSig(curNet)}  (rev ${fmt(curRevTotal)} − exp ${fmt(curExpTotal)})`);
console.log(`${nextMonth} Net P&L (proj):    ${fmtSig(nxtNet)}  (rev ${fmt(nxtRevTotal)} − exp ${fmt(nxtExpTotal)})`);
console.log(`Net delta: ${fmtSig(nxtNet - curNet)}`);
