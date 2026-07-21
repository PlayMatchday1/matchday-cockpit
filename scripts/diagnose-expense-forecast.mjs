// Diagnostic for the "Looking ahead" panel reframe. For each expense
// category that surfaces in monthOverMonthDeltas, pulls Apr/May/Jun
// totals + classifies the source/method/confidence.
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
  "$" + Math.round(Number(n)).toLocaleString("en-US");

async function selectAll(table) {
  const out = []; let from = 0; const PAGE = 1000;
  while (true) {
    const { data, error } = await sb.from(table).select("*").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

const [exp, monthly, venues, overrides, schedule] = await Promise.all([
  selectAll("fin_expenses"),
  selectAll("fin_monthly_expenses"),
  selectAll("fin_venues"),
  selectAll("fin_venue_cost_overrides"),
  selectAll("fin_schedule"),
]);

const MONTHS = ["Apr 2026", "May 2026", "Jun 2026"];

// 1. Sum fin_expenses by category × month.
const byCatMonth = new Map();
for (const r of exp) {
  if (!MONTHS.includes(r.month)) continue;
  const k = `${r.category}|${r.month}`;
  byCatMonth.set(k, (byCatMonth.get(k) ?? 0) + Number(r.amount ?? 0));
}

// 2. fin_monthly_expenses synthetic categories (per-city).
const monthlyByCol = new Map();
for (const r of monthly) {
  if (!MONTHS.includes(r.month)) continue;
  for (const col of ["city_manager", "marketing", "equipment"]) {
    const k = `${col}|${r.month}`;
    monthlyByCol.set(k, (monthlyByCol.get(k) ?? 0) + Number(r[col] ?? 0));
  }
}

// 3. Field Costs: override-aware sum across venues.
function findOverride(venueId, month) {
  return overrides.find((o) => o.venue_id === venueId && o.month === month) ?? null;
}
function fieldCostFor(venue, month) {
  const ov = findOverride(venue.id, month);
  if (ov) return Number(ov.override_amount);
  if (venue.billing_type === "per_match") {
    const rate = Number(venue.per_match_rate ?? 0);
    const mc = schedule
      .filter((s) => s.venue === venue.venue_name && s.month === month)
      .reduce((sum, r) => sum + (Number(r.match_count) || 0), 0);
    return mc * rate;
  }
  if (venue.billing_type === "per_hour") {
    const rate = Number(venue.hourly_rate ?? 0);
    if (rate <= 0) return 0;
    const hrs = schedule
      .filter((s) => s.venue === venue.venue_name && s.month === month)
      .reduce((sum, r) => sum + (Number(r.total_hours) || 0), 0);
    return hrs * rate;
  }
  return 0;
}
function fieldCostsTotal(month) {
  return venues.reduce((s, v) => s + fieldCostFor(v, month), 0);
}

// 4. Build the unified category map per month.
function categoriesFor(month) {
  const m = new Map();
  // fin_expenses categories
  for (const [k, v] of byCatMonth) {
    const [cat, mo] = k.split("|");
    if (mo !== month) continue;
    m.set(cat, (m.get(cat) ?? 0) + v);
  }
  // synthetics
  m.set("Field Costs", fieldCostsTotal(month));
  m.set("City Manager", monthlyByCol.get(`city_manager|${month}`) ?? 0);
  m.set("Marketing", monthlyByCol.get(`marketing|${month}`) ?? 0);
  m.set("Equipment", monthlyByCol.get(`equipment|${month}`) ?? 0);
  return m;
}

const apr = categoriesFor("Apr 2026");
const may = categoriesFor("May 2026");
const jun = categoriesFor("Jun 2026");

// 5. Source classification per category name.
function classify(cat) {
  if (cat === "Field Costs") {
    return {
      source: "fieldCostsFor — venue override OR schedule×rate",
      where: "src/lib/financeCosts.ts canonicalVenueCost",
      reliability:
        "Formula-based. Per-venue: override_amount if set, else match_count × per_match_rate (or hours × hourly_rate)",
    };
  }
  if (cat === "City Manager" || cat === "Marketing" || cat === "Equipment") {
    return {
      source: "fin_monthly_expenses (per-city × month)",
      where: "/admin/finance — monthly recurring",
      reliability:
        "Manually pre-entered. Same value cloned across Q2 by default unless operator edits month-by-month.",
    };
  }
  if (cat === "Match Manager Pay") {
    return {
      source: "fin_expenses rows written by Manager Pay admin tool",
      where: "/admin/finance Manager Pay tab",
      reliability:
        "Auto-computed weekly Thursday cash-out per city. Past weeks = actual; future weeks = pre-scheduled at standard rate.",
    };
  }
  return {
    source: "fin_expenses (manual entry)",
    where: "/admin/finance Expenses tab",
    reliability:
      "Manually pre-entered for the month. Same value cloned across months when ops doesn't differentiate.",
  };
}

// 6. Print the unified table.
const allCats = new Set([...apr.keys(), ...may.keys(), ...jun.keys()]);
const rows = [];
for (const cat of allCats) {
  const a = apr.get(cat) ?? 0;
  const m = may.get(cat) ?? 0;
  const j = jun.get(cat) ?? 0;
  const c = classify(cat);
  rows.push({ cat, a, m, j, ...c });
}
// Sort by Apr actual desc.
rows.sort((x, y) => y.a - x.a);

console.log("\n=== Unified expense table (categories surfaced by monthOverMonthDeltas) ===\n");
console.log(
  "CATEGORY                          APR ACTUAL    MAY (current)  JUN (next)    RELIABILITY",
);
console.log("-".repeat(125));
for (const r of rows) {
  const conf =
    r.cat === "Field Costs"
      ? "Formula"
      : r.cat === "Match Manager Pay"
        ? "Mixed actual/pre-scheduled"
        : "Manual pre-entry";
  console.log(
    `${r.cat.padEnd(34)} ${fmt(r.a).padStart(10)}     ${fmt(r.m).padStart(10)}    ${fmt(r.j).padStart(10)}    ${conf}`,
  );
}

// 7. Per-category source detail.
console.log("\n=== Source / method per category ===\n");
for (const r of rows) {
  console.log(`• ${r.cat}`);
  console.log(`    source: ${r.source}`);
  console.log(`    where:  ${r.where}`);
  console.log(`    notes:  ${r.reliability}`);
  console.log("");
}

// 8. Special-case Field Costs detail: which venues drive May cost +
// which May venue costs are overrides vs formula-derived.
console.log("=== Field Costs breakdown (May 2026) ===");
console.log("Per-venue: override-amount or schedule×rate. Override rows are 'actual' (operator-set); formula rows are 'projected' (depend on schedule).\n");
const fcRows = [];
for (const v of venues) {
  const cost = fieldCostFor(v, "May 2026");
  if (cost <= 0) continue;
  const ov = findOverride(v.id, "May 2026");
  fcRows.push({
    label: `${v.city ?? "?"} · ${v.venue_name}`,
    cost,
    kind: ov ? "override" : `${v.billing_type} × schedule`,
    detail: ov
      ? `$${Number(ov.override_amount).toFixed(2)} (reason: ${ov.reason ?? "—"})`
      : (() => {
          const mc = schedule
            .filter((s) => s.venue === v.venue_name && s.month === "May 2026")
            .reduce((sum, r) => sum + (Number(r.match_count) || 0), 0);
          const rate = Number(v.per_match_rate ?? 0);
          return `${mc} matches × $${rate}`;
        })(),
  });
}
fcRows.sort((a, b) => b.cost - a.cost);
for (const r of fcRows) {
  console.log(
    `  ${r.label.padEnd(40)} ${fmt(r.cost).padStart(10)}  [${r.kind.padEnd(22)}] ${r.detail}`,
  );
}

// 9. Quick flag: any row with Apr=0 but May/Jun>0 (suggests "kicks in later")?
console.log("\n=== Special flag: categories where May or Jun differs from Apr by ≥ $1,000 ===");
for (const r of rows) {
  const dam = r.m - r.a;
  const daj = r.j - r.a;
  if (Math.abs(dam) >= 1000 || Math.abs(daj) >= 1000) {
    console.log(
      `  ${r.cat.padEnd(34)} Apr→May ${(dam >= 0 ? "+" : "") + fmt(dam)}  Apr→Jun ${(daj >= 0 ? "+" : "") + fmt(daj)}`,
    );
  }
}

// 10. Today + accrual context.
console.log("\n=== Context ===");
console.log(`Today (UTC): ${new Date().toISOString().slice(0, 10)}`);
console.log("April 2026: complete — all rows in fin_expenses + fin_venue_cost_overrides etc. represent actuals.");
console.log("May 2026:   currently in progress — fin_expenses rows for May are a mix of actuals-so-far and pre-entered forecasts.");
console.log("June 2026:  fully forward — all fin_expenses rows for Jun are pre-entered forecasts.");
