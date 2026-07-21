// Apply the three NEMP override updates (cash view) and re-verify.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) => "$" + Math.round(Number(n)).toLocaleString("en-US");
const fmtSig = (n) =>
  n > 0 ? "+$" + Math.round(n).toLocaleString("en-US")
       : n < 0 ? "-$" + Math.round(Math.abs(n)).toLocaleString("en-US")
              : "$0";

// --- 1. UPDATE the three NEMP rows. ---

const updates = [
  {
    month: "Apr 2026",
    override_amount: 0,
    reason: "lump_sum · Q2 permit paid in June (cash view)",
  },
  {
    month: "May 2026",
    override_amount: 0,
    reason: "lump_sum · Q2 permit paid in June (cash view)",
  },
  {
    month: "Jun 2026",
    override_amount: 11100,
    reason: "lump_sum · Q2 permit fee, full $11,100 paid June (cash view)",
  },
];

console.log("=== Applying NEMP cash-view updates (venue_id=2) ===\n");
for (const u of updates) {
  const { data, error } = await sb
    .from("fin_venue_cost_overrides")
    .update({ override_amount: u.override_amount, reason: u.reason })
    .eq("venue_id", 2)
    .eq("month", u.month)
    .select();
  if (error) { console.error(`  ${u.month}: ERROR — ${error.message}`); continue; }
  if (!data || data.length === 0) {
    console.log(`  ${u.month}: NO ROW UPDATED (composite key didn't match!)`);
    continue;
  }
  for (const row of data) {
    console.log(
      `  ${u.month}: amount=${fmt(row.override_amount).padStart(8)}  reason="${row.reason}"`,
    );
  }
}

// --- 2. Reload all data so subsequent reads reflect the new state. ---

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

const [venues, schedule, overrides, expenses, monthlyExpenses, revenue] = await Promise.all([
  selectAll("fin_venues"),
  selectAll("fin_schedule"),
  selectAll("fin_venue_cost_overrides"),
  selectAll("fin_expenses"),
  selectAll("fin_monthly_expenses"),
  selectAll("fin_revenue"),
]);

function findOverride(venueId, month) {
  return overrides.find((o) => o.venue_id === venueId && o.month === month) ?? null;
}
function venueMatchCount(venue, month) {
  return schedule
    .filter((s) => s.venue === venue.venue_name && s.month === month)
    .reduce((sum, s) => sum + Number(s.match_count ?? 0), 0);
}
function venueTotalHours(venue, month) {
  return schedule
    .filter((s) => s.venue === venue.venue_name && s.month === month)
    .reduce((sum, s) => sum + Number(s.total_hours ?? 0), 0);
}
function canonicalVenueCost(venue, month) {
  const ov = findOverride(venue.id, month);
  if (ov) return Number(ov.override_amount);
  if (venue.billing_type === "per_match") {
    return venueMatchCount(venue, month) * Number(venue.per_match_rate ?? 0);
  }
  if (venue.billing_type === "per_hour") {
    const rate = Number(venue.hourly_rate ?? 0);
    return rate > 0 ? venueTotalHours(venue, month) * rate : 0;
  }
  return 0;
}
function fieldCostsByVenue(month) {
  const m = new Map();
  for (const v of venues) {
    const cost = canonicalVenueCost(v, month);
    if (cost > 0) m.set(`${v.city} · ${v.venue_name}`, cost);
  }
  return m;
}
function fieldCostsTotal(month) {
  return [...fieldCostsByVenue(month).values()].reduce((s, v) => s + v, 0);
}

// --- 3. Re-verify Apr/May/Jun NEMP overrides. ---

console.log("\n=== Verification: NEMP overrides post-update ===\n");
for (const m of ["Apr 2026", "May 2026", "Jun 2026"]) {
  const o = findOverride(2, m);
  console.log(`  ${m}: ${fmt(o.override_amount).padStart(8)}  reason="${o.reason}"`);
}

// --- 4. Field Costs totals + Net P&L for each Q2 month. ---

console.log("\n=== Field Costs totals (post-update) ===\n");
for (const m of ["Apr 2026", "May 2026", "Jun 2026"]) {
  console.log(`  ${m}: ${fmt(fieldCostsTotal(m)).padStart(10)}`);
}

// --- 5. May→Jun drill-down: per-venue Field Costs deltas, sorted by |Δ| desc. ---

console.log("\n=== May→Jun Field Costs drill-down (top 5 by |Δ|) ===\n");
const mayMap = fieldCostsByVenue("May 2026");
const junMap = fieldCostsByVenue("Jun 2026");
const allKeys = new Set([...mayMap.keys(), ...junMap.keys()]);
const drillDeltas = [];
for (const k of allKeys) {
  drillDeltas.push({
    name: k,
    may: mayMap.get(k) ?? 0,
    jun: junMap.get(k) ?? 0,
    delta: (junMap.get(k) ?? 0) - (mayMap.get(k) ?? 0),
  });
}
drillDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
console.log("KEY (city · venue_name)               MAY            JUN            Δ");
console.log("-".repeat(95));
for (const d of drillDeltas.slice(0, 5)) {
  console.log(
    `${d.name.padEnd(38)} ${fmt(d.may).padStart(10)}  ${fmt(d.jun).padStart(10)}  ${fmtSig(d.delta).padStart(9)}`,
  );
}

// --- 6. Full June Field Costs breakdown, sorted desc. ---

console.log("\n=== Jun 2026 Field Costs by venue (descending) ===\n");
const junSorted = [...junMap.entries()].sort((a, b) => b[1] - a[1]);
console.log("VENUE                                    AMOUNT");
console.log("-".repeat(60));
for (const [k, v] of junSorted) {
  console.log(`${k.padEnd(40)} ${fmt(v).padStart(10)}`);
}
console.log("-".repeat(60));
console.log(`TOTAL                                    ${fmt([...junMap.values()].reduce((s, v) => s + v, 0)).padStart(10)}`);

// --- 7. Flat-thirds re-scan post-update. ---

console.log("\n=== Re-scan: any remaining flat-thirds amortized lump sums? ===\n");
const Q2 = ["Apr 2026", "May 2026", "Jun 2026"];
const venueById = new Map(venues.map((v) => [v.id, v]));
const byVenue = new Map();
for (const o of overrides) {
  if (!Q2.includes(o.month)) continue;
  if (!byVenue.has(o.venue_id)) byVenue.set(o.venue_id, []);
  byVenue.get(o.venue_id).push(o);
}
const candidates = [];
for (const [vid, rows] of byVenue) {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  if (rows.length < 3) continue;
  const aprAmt = Number(byMonth.get("Apr 2026")?.override_amount ?? 0);
  const mayAmt = Number(byMonth.get("May 2026")?.override_amount ?? 0);
  const junAmt = Number(byMonth.get("Jun 2026")?.override_amount ?? 0);
  if (aprAmt <= 0) continue;
  if (Math.abs(aprAmt - mayAmt) > 0.5) continue;
  if (Math.abs(mayAmt - junAmt) > 0.5) continue;
  const v = venueById.get(vid);
  candidates.push({ vid, v, rows, aprAmt });
}
if (candidates.length === 0) {
  console.log("(none — NEMP was the last one)");
} else {
  for (const c of candidates) {
    console.log(
      `venue_id=${c.vid}  ${c.v?.city ?? "?"} · ${c.v?.venue_name ?? "?"}  per-month=${fmt(c.aprAmt)}`,
    );
    for (const r of c.rows.sort((a, b) => Q2.indexOf(a.month) - Q2.indexOf(b.month))) {
      console.log(`  ${r.month}: reason="${r.reason ?? ""}"`);
    }
    console.log("");
  }
}

// --- 8. Net P&L — replicate monthOverMonthDeltas logic at totals level. ---

console.log("\n=== Net P&L per Q2 month (using new field costs + same revenue/expense logic) ===\n");
function isFuture(m) {
  const ms = new Date(2026, { "Apr 2026": 3, "May 2026": 4, "Jun 2026": 5 }[m], 1);
  const t = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  return ms.getTime() > t.getTime();
}
function isCurrent(m) {
  const now = new Date();
  return now.getFullYear() === 2026 && now.getMonth() === { "Apr 2026": 3, "May 2026": 4, "Jun 2026": 5 }[m];
}
const MONTH_DAYS = { "Apr 2026": 30, "May 2026": 31, "Jun 2026": 30 };
function dppFactor(m) {
  if (!isCurrent(m)) return 1;
  const elapsed = new Date().getDate();
  return elapsed > 0 ? MONTH_DAYS[m] / elapsed : 1;
}
function expensesTotal(m) {
  let t = fieldCostsTotal(m);
  for (const r of expenses) {
    if (r.month !== m) continue;
    t += Number(r.amount ?? 0);
  }
  for (const r of monthlyExpenses) {
    if (r.month !== m) continue;
    t += Number(r.city_manager ?? 0) + Number(r.marketing ?? 0) + Number(r.equipment ?? 0);
  }
  return t;
}
function revenueTotal(m) {
  const future = isFuture(m);
  const factor = dppFactor(m);
  const proj = new Map(), real = new Map();
  for (const r of revenue) {
    if (r.month !== m) continue;
    const isProj = r.source === "PROJECTION";
    if (!future && isProj) continue;
    const v = Number(r.net ?? 0);
    const scaled = factor !== 1 && !isProj && r.type === "DPP" ? v * factor : v;
    (isProj ? proj : real).set(r.type, ((isProj ? proj : real).get(r.type) ?? 0) + scaled);
  }
  let total = 0;
  if (future) {
    const types = new Set([...proj.keys(), ...real.keys()]);
    for (const t of types) total += Math.max(proj.get(t) ?? 0, real.get(t) ?? 0);
  } else {
    for (const v of real.values()) total += v;
  }
  return total;
}
for (const m of ["Apr 2026", "May 2026", "Jun 2026"]) {
  const rev = revenueTotal(m);
  const exp = expensesTotal(m);
  console.log(
    `  ${m}:  rev ${fmt(rev).padStart(10)}  exp ${fmt(exp).padStart(10)}  net ${fmtSig(rev - exp).padStart(10)}`,
  );
}
