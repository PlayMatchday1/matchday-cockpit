// Diagnostic: NEMP per-venue cost trace for Apr/May/Jun 2026.
// Mirrors canonicalVenueCost logic (overrides → per_match × rate /
// per_hour × rate / monthly_flat / lump_sum / profit_share / no_charge).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
const fmtSig = (n) =>
  n > 0 ? "+$" + Math.round(n).toLocaleString("en-US")
       : n < 0 ? "-$" + Math.round(Math.abs(n)).toLocaleString("en-US")
              : "$0";

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

const [venues, schedule, overrides, expenses] = await Promise.all([
  selectAll("fin_venues"),
  selectAll("fin_schedule"),
  selectAll("fin_venue_cost_overrides"),
  selectAll("fin_expenses"),
]);

console.log(`\n=== Q1: All venues whose names mention "NEMP" or "NE Metro" or "Northeast Metro" ===\n`);
const NEMP_RE = /nemp|ne metro|northeast metro/i;
const nempVenues = venues.filter(
  (v) =>
    NEMP_RE.test(v.venue_name ?? "") ||
    NEMP_RE.test(v.raw_venue_name ?? "") ||
    NEMP_RE.test(v.notes ?? ""),
);
if (nempVenues.length === 0) {
  console.log("(none found)");
} else {
  for (const v of nempVenues) {
    console.log(
      `id=${String(v.id).padStart(3)}  city=${(v.city ?? "—").padEnd(14)}  ` +
        `venue_name="${v.venue_name}"  raw="${v.raw_venue_name}"  ` +
        `billing=${v.billing_type}  per_match=${v.per_match_rate ?? "—"}  ` +
        `hourly=${v.hourly_rate ?? "—"}  notes="${v.notes ?? ""}"`,
    );
  }
}

console.log(`\n=== Q2: fin_schedule rows mentioning NEMP/NE Metro/Northeast Metro (Apr/May/Jun 2026) ===\n`);
const nempScheduleRows = schedule.filter(
  (s) =>
    NEMP_RE.test(s.venue ?? "") || NEMP_RE.test(s.venue_raw ?? ""),
);
const months = ["Apr 2026", "May 2026", "Jun 2026"];
const byVenueRawByMonth = new Map(); // venue_raw → { month → {matches, hours} }
for (const s of nempScheduleRows) {
  if (!months.includes(s.month)) continue;
  const k = s.venue_raw ?? s.venue ?? "(unknown)";
  if (!byVenueRawByMonth.has(k)) byVenueRawByMonth.set(k, {});
  const e = byVenueRawByMonth.get(k);
  if (!e[s.month]) e[s.month] = { matches: 0, hours: 0, rows: 0 };
  e[s.month].matches += Number(s.match_count ?? 0);
  e[s.month].hours += Number(s.total_hours ?? 0);
  e[s.month].rows += 1;
}
if (byVenueRawByMonth.size === 0) {
  console.log("(no NEMP-tagged schedule rows in Q2 2026)");
} else {
  for (const [vr, e] of byVenueRawByMonth) {
    console.log(`venue_raw="${vr}"`);
    for (const m of months) {
      const d = e[m] ?? { matches: 0, hours: 0, rows: 0 };
      console.log(
        `  ${m.padEnd(10)}  matches=${String(d.matches).padStart(3)}  hours=${String(d.hours).padStart(5)}  (${d.rows} schedule rows)`,
      );
    }
  }
}

console.log(`\n=== Q3: fin_expenses category="Field Costs" with venue/notes mentioning NEMP ===\n`);
const nempExpenseRows = expenses.filter(
  (r) =>
    r.category === "Field Costs" &&
    (NEMP_RE.test(r.vendor ?? "") || NEMP_RE.test(r.notes ?? "")),
);
if (nempExpenseRows.length === 0) {
  console.log("(none — Field Costs is computed from schedule × rate, not from fin_expenses rows)");
} else {
  for (const r of nempExpenseRows) {
    console.log(
      `month=${r.month}  city=${r.city}  vendor=${r.vendor}  amount=${fmt(r.amount)}  notes="${r.notes ?? ""}"`,
    );
  }
}

console.log(`\n=== Q4: NEMP fin_venue_cost_overrides for Apr/May/Jun 2026 ===\n`);
const nempVenueIds = new Set(nempVenues.map((v) => v.id));
const nempOverrides = overrides.filter(
  (o) => nempVenueIds.has(o.venue_id) && months.includes(o.month),
);
if (nempOverrides.length === 0) {
  console.log("(no overrides — costs flow through autoCost = match_count × per_match_rate)");
} else {
  for (const o of nempOverrides) {
    const v = venues.find((x) => x.id === o.venue_id);
    console.log(
      `venue_id=${o.venue_id} (${v?.venue_name ?? "?"})  month=${o.month}  override=${fmt(o.override_amount)}  reason="${o.reason ?? ""}"`,
    );
  }
}

console.log(`\n=== Q5: canonicalVenueCost computation per NEMP venue per month ===\n`);
function findOverride(venueId, month) {
  return overrides.find((o) => o.venue_id === venueId && o.month === month) ?? null;
}
// raw_venue_name is a derived loader field (not a DB column) — in
// production it = the DB's venue_name string before aliasing; the
// schedule's venue_raw = the DB's venue string. So: filter on
// s.venue === v.venue_name (DB columns).
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
  if (ov) {
    return {
      amount: Number(ov.override_amount),
      kind: "override",
      detail: `override $${ov.override_amount}`,
    };
  }
  if (venue.billing_type === "per_match") {
    const mc = venueMatchCount(venue, month);
    const rate = Number(venue.per_match_rate ?? 0);
    return { amount: mc * rate, kind: "per_match", detail: `${mc} matches × $${rate}` };
  }
  if (venue.billing_type === "per_hour") {
    const hrs = venueTotalHours(venue, month);
    const rate = Number(venue.hourly_rate ?? 0);
    if (rate <= 0) return { amount: 0, kind: "per_hour_no_fee", detail: `${hrs} hr × $0 (no fee)` };
    return { amount: hrs * rate, kind: "per_hour_metered", detail: `${hrs} hr × $${rate}` };
  }
  if (venue.billing_type === "no_charge") {
    return { amount: 0, kind: "no_charge", detail: "no fee" };
  }
  return { amount: 0, kind: "needs_override_or_unknown", detail: `billing_type=${venue.billing_type} (no override)` };
}

const perVenueCosts = new Map(); // id → {name, apr, may, jun, kind, detail per month}
for (const v of nempVenues) {
  const row = { name: `${v.city} · ${v.venue_name}`, raw: v.raw_venue_name, billing: v.billing_type };
  for (const m of months) {
    const c = canonicalVenueCost(v, m);
    row[m] = c;
  }
  perVenueCosts.set(v.id, row);
  console.log(`venue=${row.name}  raw="${row.raw}"  billing=${row.billing}`);
  for (const m of months) {
    const c = row[m];
    console.log(
      `  ${m.padEnd(10)}  ${fmt(c.amount).padStart(10)}   kind=${c.kind.padEnd(20)} ${c.detail}`,
    );
  }
}

console.log(`\n=== Q6: Aggregated NEMP cost per month (sum across all NEMP venues) ===\n`);
let aprTotal = 0, mayTotal = 0, junTotal = 0;
for (const [, row] of perVenueCosts) {
  aprTotal += row["Apr 2026"].amount;
  mayTotal += row["May 2026"].amount;
  junTotal += row["Jun 2026"].amount;
}
console.log(`Apr 2026: ${fmt(aprTotal)}`);
console.log(`May 2026: ${fmt(mayTotal)}`);
console.log(`Jun 2026: ${fmt(junTotal)}`);
console.log(`May → Jun delta: ${fmtSig(junTotal - mayTotal)}`);

console.log(`\n=== Q7: What fieldCostsByVenue() actually emits as drill-down keys ===\n`);
function fieldCostsByVenue(month) {
  const m = new Map();
  for (const v of venues) {
    const cost = canonicalVenueCost(v, month).amount;
    if (cost > 0) m.set(`${v.city} · ${v.venue_name}`, cost);
  }
  return m;
}
const may = fieldCostsByVenue("May 2026");
const jun = fieldCostsByVenue("Jun 2026");
const allKeys = new Set([...may.keys(), ...jun.keys()]);
const deltas = [];
for (const k of allKeys) {
  deltas.push({ name: k, may: may.get(k) ?? 0, jun: jun.get(k) ?? 0, delta: (jun.get(k) ?? 0) - (may.get(k) ?? 0) });
}
deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
console.log("KEY (city · venue_name)               MAY            JUN            Δ");
console.log("-".repeat(110));
for (const d of deltas) {
  const isNemp = NEMP_RE.test(d.name);
  console.log(
    `${(isNemp ? "★ " : "  ") + d.name.padEnd(38)} ${fmt(d.may).padStart(10)}  ${fmt(d.jun).padStart(10)}  ${fmtSig(d.delta).padStart(9)}`,
  );
}

console.log(`\n=== Q8: Drill-down threshold check ($50 floor for sub-rows) ===\n`);
const nempDelta = deltas.find((d) => NEMP_RE.test(d.name));
if (!nempDelta) {
  console.log("No NEMP key emitted by fieldCostsByVenue at all.");
} else {
  console.log(
    `NEMP key: "${nempDelta.name}"  May=${fmt(nempDelta.may)}  Jun=${fmt(nempDelta.jun)}  Δ=${fmtSig(nempDelta.delta)}`,
  );
  console.log(`|Δ| = $${Math.round(Math.abs(nempDelta.delta))}  → ${Math.abs(nempDelta.delta) >= 50 ? "ABOVE $50, would surface as a sub-row" : "BELOW $50, rolls into 'Other (...)'"}`);
}

console.log(`\n=== SANITY: total Field Costs May vs Jun (sum of all venue costs) ===\n`);
let totalMay = 0, totalJun = 0;
for (const v of venues) {
  totalMay += canonicalVenueCost(v, "May 2026").amount;
  totalJun += canonicalVenueCost(v, "Jun 2026").amount;
}
console.log(`May total: ${fmt(totalMay)}`);
console.log(`Jun total: ${fmt(totalJun)}`);

console.log(`\n=== SANITY: per_match venues raw schedule check ===`);
const sample = venues.find((v) => v.venue_name === "ATH Pearland");
if (sample) {
  console.log(`venue=${sample.venue_name} raw="${sample.raw_venue_name}" billing=${sample.billing_type} per_match_rate=${sample.per_match_rate}`);
  const may = schedule.filter((s) => s.venue_raw === sample.raw_venue_name && s.month === "May 2026");
  const jun = schedule.filter((s) => s.venue_raw === sample.raw_venue_name && s.month === "Jun 2026");
  console.log(`May rows=${may.length}  total match_count=${may.reduce((s,r)=>s+Number(r.match_count??0),0)}`);
  console.log(`Jun rows=${jun.length}  total match_count=${jun.reduce((s,r)=>s+Number(r.match_count??0),0)}`);
  console.log(`May raw values: ${may.map((r) => `${r.match_count}@${r.venue_raw}`).join(", ")}`);
}
