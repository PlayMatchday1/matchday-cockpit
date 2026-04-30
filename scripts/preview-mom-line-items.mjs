// Compute the new lineItems[] for the redesigned hero. Threshold
// applied here ($500) matches the UI filter.
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
  const byType = new Map();
  for (const r of revenue) {
    if (r.month !== month) continue;
    if (future ? r.source !== "PROJECTION" : r.source === "PROJECTION") continue;
    const v = Number(r.net ?? 0);
    const scaled = factor !== 1 && r.source !== "PROJECTION" && r.type === "DPP" ? v * factor : v;
    byType.set(r.type, (byType.get(r.type) ?? 0) + scaled);
  }
  return byType;
}

const currentMonth = Q2.find((m) => isCurrent(m));
const idx = Q2.indexOf(currentMonth);
const nextMonth = idx >= 0 && idx < Q2.length - 1 ? Q2[idx + 1] : null;
console.log(`\nToday: ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
console.log(`currentMonth=${currentMonth}  nextMonth=${nextMonth}\n`);

if (!currentMonth || !nextMonth) {
  console.log("(hero would render the muted single-line panel)");
  process.exit(0);
}

const expCur = expensesByCategory(currentMonth);
const expNxt = expensesByCategory(nextMonth);
const expCats = new Set([...expCur.keys(), ...expNxt.keys()]);
const lineItems = [];
for (const cat of expCats) {
  const delta = (expNxt.get(cat) ?? 0) - (expCur.get(cat) ?? 0);
  if (Math.abs(delta) < 0.5) continue;
  lineItems.push({ kind: "expense", name: cat, delta, isProjectionDriven: false });
}
const revCur = revenueByType(currentMonth);
const revNxt = revenueByType(nextMonth);
const revTypes = new Set([...revCur.keys(), ...revNxt.keys()]);
const nextIsFuture = isFuture(nextMonth);
// New: collapse PROJECTION-driven revenue into one combined line.
let projSum = 0;
for (const type of revTypes) {
  const delta = (revNxt.get(type) ?? 0) - (revCur.get(type) ?? 0);
  if (Math.abs(delta) < 0.5) continue;
  if (nextIsFuture) {
    projSum += delta;
    continue;
  }
  lineItems.push({
    kind: "revenue",
    name: type,
    delta,
    isProjectionDriven: false,
  });
}
if (Math.abs(projSum) >= 0.5) {
  lineItems.push({
    kind: "revenue",
    name: "Expected revenue (forecast)",
    delta: projSum,
    isProjectionDriven: true,
  });
}
lineItems.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

console.log("=== ALL line items (sorted by |Δ| desc) ===");
console.log("KIND      NAME                          Δ            PROJECTION?");
for (const li of lineItems) {
  const proj = li.isProjectionDriven ? "(PROJECTION)" : "";
  console.log(`${li.kind.padEnd(10)} ${li.name.padEnd(28)} ${fmtSig(li.delta).padStart(10)}   ${proj}`);
}

console.log("\n=== Visible (|Δ| ≥ $500) ===");
for (const li of lineItems.filter((x) => Math.abs(x.delta) >= 500)) {
  const proj = li.isProjectionDriven ? "(PROJECTION)" : "";
  console.log(`${li.kind.padEnd(10)} ${li.name.padEnd(28)} ${fmtSig(li.delta).padStart(10)}   ${proj}`);
}

const curRevTotal = [...revCur.values()].reduce((s, v) => s + v, 0);
const curExpTotal = [...expCur.values()].reduce((s, v) => s + v, 0);
const nxtRevTotal = [...revNxt.values()].reduce((s, v) => s + v, 0);
const nxtExpTotal = [...expNxt.values()].reduce((s, v) => s + v, 0);
const curNet = curRevTotal - curExpTotal;
const nxtNet = nxtRevTotal - nxtExpTotal;
console.log(`\n=== Net delta ===`);
console.log(`${currentMonth}: ${fmtSig(curNet)}  (rev ${fmt(curRevTotal)} − exp ${fmt(curExpTotal)})`);
console.log(`${nextMonth}: ${fmtSig(nxtNet)}  (rev ${fmt(nxtRevTotal)} − exp ${fmt(nxtExpTotal)})`);
console.log(`Net Δ:    ${fmtSig(nxtNet - curNet)}`);
