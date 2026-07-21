// Diagnostic: full May→Jun MoM line items with threshold = $0.
// Mirrors monthOverMonthDeltas in src/lib/financeStats.ts.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const CUR = "May 2026";
const NXT = "Jun 2026";
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

function expensesByCategory(month) {
  const byCat = new Map();
  for (const r of expenses) {
    if (r.month !== month) continue;
    byCat.set(r.category, (byCat.get(r.category) ?? 0) + Number(r.amount ?? 0));
  }
  byCat.set("Field Costs", fieldCostsForMonth(month));
  let cm = 0, mk = 0, eq = 0;
  for (const r of monthlyExpenses) {
    if (r.month !== month) continue;
    cm += Number(r.city_manager ?? 0);
    mk += Number(r.marketing ?? 0);
    eq += Number(r.equipment ?? 0);
  }
  byCat.set("City Manager", cm);
  byCat.set("Marketing", mk);
  byCat.set("Equipment", eq);
  return byCat;
}

function revenueByType(month) {
  const future = isFuture(month);
  const factor = dppFactor(month);
  const proj = new Map();
  const real = new Map();
  for (const r of revenue) {
    if (r.month !== month) continue;
    const isProj = r.source === "PROJECTION";
    if (!future && isProj) continue;
    const v = Number(r.net ?? 0);
    const scaled = factor !== 1 && !isProj && r.type === "DPP" ? v * factor : v;
    const map = isProj ? proj : real;
    map.set(r.type, (map.get(r.type) ?? 0) + scaled);
  }
  const out = new Map();
  const types = new Set([...proj.keys(), ...real.keys()]);
  for (const t of types) {
    const p = proj.get(t) ?? 0;
    const re = real.get(t) ?? 0;
    if (future) {
      out.set(t, {
        effective: Math.max(p, re),
        projected: p,
        realized: re,
        origin: re > p ? "realized" : "projection",
      });
    } else {
      out.set(t, { effective: re, projected: 0, realized: re, origin: "realized" });
    }
  }
  return out;
}

// Top contributor for a category, used as the "driver" string.
function topContributor(curMap, nxtMap) {
  const keys = new Set([...curMap.keys(), ...nxtMap.keys()]);
  let bestKey = null, bestAbs = -Infinity, bestDelta = 0;
  for (const k of keys) {
    const d = (nxtMap.get(k) ?? 0) - (curMap.get(k) ?? 0);
    if (Math.abs(d) > bestAbs) { bestAbs = Math.abs(d); bestKey = k; bestDelta = d; }
  }
  return bestKey ? `${bestKey} ${fmtSig(bestDelta)}` : "—";
}

function fieldCostsByVenue(month) {
  const m = new Map();
  for (const v of venues) {
    const ov = findOverride(v.id, month);
    let amount = 0;
    if (ov) amount = Number(ov.override_amount);
    else if (v.billing_type === "per_match") {
      const rate = Number(v.per_match_rate ?? 0);
      const mc = schedule.filter(s => s.venue === v.venue_name && s.month === month).reduce((s, r) => s + (Number(r.match_count) ?? 0), 0);
      amount = mc * rate;
    } else if (v.billing_type === "per_hour") {
      const rate = Number(v.hourly_rate ?? 0);
      const hrs = schedule.filter(s => s.venue === v.venue_name && s.month === month).reduce((s, r) => s + (Number(r.total_hours) ?? 0), 0);
      amount = rate > 0 ? hrs * rate : 0;
    }
    if (amount > 0) m.set(v.venue_name, amount);
  }
  return m;
}
function mmpByCity(month) {
  const m = new Map();
  for (const r of expenses) {
    if (r.month !== month || r.category !== "Match Manager Pay") continue;
    const c = r.city || "Company-wide";
    m.set(c, (m.get(c) ?? 0) + Number(r.amount ?? 0));
  }
  return m;
}
function monthlyExpenseByCity(month, key) {
  const m = new Map();
  for (const r of monthlyExpenses) {
    if (r.month !== month) continue;
    const v = Number(r[key] ?? 0);
    if (v > 0) m.set(r.city, v);
  }
  return m;
}
function finExpensesByVendor(month, category) {
  const m = new Map();
  for (const r of expenses) {
    if (r.month !== month || r.category !== category) continue;
    const v = r.vendor || "(no vendor)";
    m.set(v, (m.get(v) ?? 0) + Number(r.amount ?? 0));
  }
  return m;
}

function expenseDriver(category) {
  if (category === "Field Costs") return topContributor(fieldCostsByVenue(CUR), fieldCostsByVenue(NXT));
  if (category === "Match Manager Pay") return topContributor(mmpByCity(CUR), mmpByCity(NXT));
  if (category === "City Manager") return topContributor(monthlyExpenseByCity(CUR, "city_manager"), monthlyExpenseByCity(NXT, "city_manager"));
  if (category === "Marketing") return topContributor(monthlyExpenseByCity(CUR, "marketing"), monthlyExpenseByCity(NXT, "marketing"));
  if (category === "Equipment") return topContributor(monthlyExpenseByCity(CUR, "equipment"), monthlyExpenseByCity(NXT, "equipment"));
  return topContributor(finExpensesByVendor(CUR, category), finExpensesByVendor(NXT, category));
}

const expCur = expensesByCategory(CUR);
const expNxt = expensesByCategory(NXT);
const expCats = new Set([...expCur.keys(), ...expNxt.keys()]);

const expenseLines = [];
for (const cat of expCats) {
  const cv = expCur.get(cat) ?? 0;
  const nv = expNxt.get(cat) ?? 0;
  const delta = nv - cv;
  expenseLines.push({
    kind: "expense",
    name: cat,
    cur: cv,
    nxt: nv,
    delta,
    isProjectionDriven: false,
    driver: delta === 0 ? "—" : expenseDriver(cat),
  });
}

const revCur = revenueByType(CUR);
const revNxt = revenueByType(NXT);
const revTypes = new Set([...revCur.keys(), ...revNxt.keys()]);
const nextIsFuture = isFuture(NXT);

const revenueLines = [];
let projectionDrivenSum = 0;
const projectionTypeDeltas = [];
for (const type of revTypes) {
  const curEff = revCur.get(type)?.effective ?? 0;
  const nxtAgg = revNxt.get(type);
  const nxtEff = nxtAgg?.effective ?? 0;
  const delta = nxtEff - curEff;
  const nextOrigin = nxtAgg?.origin ?? (nextIsFuture ? "projection" : "realized");
  if (nextIsFuture && nextOrigin === "projection") {
    projectionDrivenSum += delta;
    projectionTypeDeltas.push({ type, cur: curEff, nxt: nxtEff, delta });
    continue;
  }
  revenueLines.push({
    kind: "revenue",
    name: type,
    cur: curEff,
    nxt: nxtEff,
    delta,
    isProjectionDriven: false,
    driver: nextIsFuture ? `${NXT.split(" ")[0]} realized — manual entry` : `${type} mix shift`,
  });
}
if (projectionDrivenSum !== 0 || projectionTypeDeltas.length > 0) {
  const curSum = projectionTypeDeltas.reduce((s, x) => s + x.cur, 0);
  const nxtSum = projectionTypeDeltas.reduce((s, x) => s + x.nxt, 0);
  revenueLines.push({
    kind: "revenue",
    name: "Expected revenue (forecast)",
    cur: curSum,
    nxt: nxtSum,
    delta: projectionDrivenSum,
    isProjectionDriven: true,
    driver: "Next month from PROJECTION estimate",
  });
}

const all = [...expenseLines, ...revenueLines].sort(
  (a, b) => Math.abs(b.delta) - Math.abs(a.delta),
);

console.log(`\n=== Full May 2026 → Jun 2026 line items (threshold = $0) ===\n`);
console.log(
  "KIND      NAME                          MAY              JUN              Δ           PROJ?  DRIVER",
);
console.log("-".repeat(140));
for (const li of all) {
  console.log(
    `${li.kind.padEnd(9)} ${li.name.padEnd(28)} ${fmt(li.cur).padStart(14)}  ${fmt(li.nxt).padStart(14)}  ${fmtSig(li.delta).padStart(10)}   ${(li.isProjectionDriven ? "Y" : "").padEnd(4)}  ${li.driver}`,
  );
}

console.log(`\n=== Per-type breakdown of "Expected revenue (forecast)" ===`);
for (const x of projectionTypeDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
  console.log(`  ${x.type.padEnd(20)} May ${fmt(x.cur).padStart(10)}  Jun ${fmt(x.nxt).padStart(10)}  Δ ${fmtSig(x.delta).padStart(10)}`);
}

const nonZero = all.filter((x) => Math.abs(x.delta) >= 0.5);
const zero = all.length - nonZero.length;
const hidden = nonZero.filter((x) => Math.abs(x.delta) < 500);
const visible = nonZero.filter((x) => Math.abs(x.delta) >= 500);
const largestHidden = [...hidden].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];

console.log(`\n=== Summary ===`);
console.log(`Total line items:                     ${all.length}`);
console.log(`  Δ = 0 (rounding-zero):              ${zero}`);
console.log(`  Δ != 0:                             ${nonZero.length}`);
console.log(`     Above $500 threshold (visible):  ${visible.length}`);
console.log(`     Below $500 threshold (hidden):   ${hidden.length}`);
if (largestHidden) {
  console.log(
    `Largest hidden delta:                 ${largestHidden.kind} "${largestHidden.name}" ${fmtSig(largestHidden.delta)}`,
  );
} else {
  console.log(`Largest hidden delta:                 (none)`);
}

const curRev = [...revCur.values()].reduce((s, v) => s + v.effective, 0);
const nxtRev = [...revNxt.values()].reduce((s, v) => s + v.effective, 0);
const curExp = [...expCur.values()].reduce((s, v) => s + v, 0);
const nxtExp = [...expNxt.values()].reduce((s, v) => s + v, 0);
console.log(`\n=== Net Δ ===`);
console.log(`May 2026: ${fmtSig(curRev - curExp)}  (rev ${fmt(curRev)} − exp ${fmt(curExp)})`);
console.log(`Jun 2026: ${fmtSig(nxtRev - nxtExp)}  (rev ${fmt(nxtRev)} − exp ${fmt(nxtExp)})`);
console.log(`Net Δ:    ${fmtSig((nxtRev - nxtExp) - (curRev - curExp))}`);
