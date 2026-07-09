// Audit May 2026 — is the $12,014 net P&L projection realistic?
// Check whether DPP extrapolation is biased by day-of-week (early
// May = Fri/Sat/Sun, weekend-heavy) and break down all revenue +
// expense components.
//
// Read-only.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  Q2_MONTHS,
  netRevenueFor,
  totalExpensesFor,
} from "../src/lib/financeStats";
import { fieldCostsFor, perMatchTotalFor } from "../src/lib/financeCosts";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

async function fetchAll<T>(table: string, orderCol: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from(table)
      .select("*")
      .order(orderCol)
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

const fmtUsd = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function main() {
  const today = new Date();
  console.log(`today: ${today.toISOString().slice(0, 10)} (${DOW_LABELS[today.getDay()]})\n`);

  const num = (v: unknown): number => Number(v) || 0;
  const numOrNull = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  const txt = (v: unknown): string => String(v ?? "");

  const [revRaw, expRaw, monthExpRaw, venuesRaw, schedRaw, overridesRaw, aliasesRaw] =
    await Promise.all([
      fetchAll<Record<string, unknown>>("fin_revenue", "id"),
      fetchAll<Record<string, unknown>>("fin_expenses", "id"),
      fetchAll<Record<string, unknown>>("fin_monthly_expenses", "id"),
      fetchAll<Record<string, unknown>>("fin_venues", "id"),
      fetchAll<Record<string, unknown>>("fin_schedule", "id"),
      fetchAll<Record<string, unknown>>("fin_venue_cost_overrides", "id"),
      fetchAll<Record<string, unknown>>("fin_venue_aliases", "alias"),
    ]);

  const venueAliases = new Map<string, string>();
  for (const a of aliasesRaw)
    venueAliases.set(txt(a.alias), txt(a.canonical_venue));

  const venues = venuesRaw.map((v) => ({
    id: num(v.id),
    venue_name: venueAliases.get(txt(v.venue_name)) ?? txt(v.venue_name),
    raw_venue_name: txt(v.venue_name),
    city: txt(v.city),
    billing_type: txt(v.billing_type) as
      | "per_hour"
      | "per_match"
      | "monthly_flat"
      | "lump_sum"
      | "profit_share"
      | "no_charge",
    hourly_rate: numOrNull(v.hourly_rate),
    monthly_flat: numOrNull(v.monthly_flat),
    per_match_rate: numOrNull(v.per_match_rate),
    max_spots: numOrNull(v.max_spots),
    dpp_price: numOrNull(v.dpp_price),
    member_price: numOrNull(v.member_price),
    cost_per_match: numOrNull(v.cost_per_match),
    notes: null,
    launch_date: null,
    is_active: true,
  }));

  const data = {
    revenue: revRaw.map((r) => ({
      id: num(r.id),
      date: txt(r.date),
      month: txt(r.month),
      city: txt(r.city),
      venue: r.venue == null ? null : txt(r.venue),
      type: txt(r.type),
      gross: num(r.gross),
      fees: num(r.fees),
      net: num(r.net),
      source: txt(r.source),
      notes: null,
    })),
    expenses: expRaw.map((e) => ({
      id: num(e.id),
      date: txt(e.date),
      month: txt(e.month),
      city: e.city == null ? null : txt(e.city),
      category: txt(e.category),
      amount: num(e.amount),
      notes: null,
    })),
    managerPay: [],
    monthlyExpenses: monthExpRaw.map((m) => ({
      id: num(m.id),
      month: txt(m.month),
      city: txt(m.city),
      city_manager: num(m.city_manager),
      marketing: num(m.marketing),
      equipment: num(m.equipment),
    })),
    schedule: schedRaw.map((s) => ({
      id: num(s.id),
      date: txt(s.date),
      month: txt(s.month),
      city: txt(s.city),
      venue: venueAliases.get(txt(s.venue)) ?? txt(s.venue),
      venue_raw: txt(s.venue),
      match_count: num(s.match_count),
      total_hours: numOrNull(s.total_hours),
      venue_cost: numOrNull(s.venue_cost),
      notes: null,
      manual_entry: false,
      created_at: null,
      created_by: null,
    })),
    venues,
    memberSpots: [],
    members: [],
    pricing: [],
    commentary: null,
    overrides: overridesRaw.map((o) => ({
      id: num(o.id),
      venue_id: num(o.venue_id),
      month: txt(o.month),
      override_amount: num(o.override_amount),
      reason: null,
      created_at: txt(o.created_at),
      created_by: txt(o.created_by),
    })),
    venueAliases,
    config: {},
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fd = data as any;

  // ===== May daily DPP =====
  console.log("======== May 2026 daily DPP (realized only) ========");
  const mayDpp = data.revenue.filter(
    (r) => r.month === "May 2026" && r.type === "DPP" && r.source !== "PROJECTION",
  );
  const dppByDate = new Map<string, number>();
  for (const r of mayDpp) dppByDate.set(r.date, (dppByDate.get(r.date) ?? 0) + r.net);
  const sortedDates = [...dppByDate.keys()].sort();
  let cumulativeDpp = 0;
  for (const d of sortedDates) {
    const v = dppByDate.get(d)!;
    cumulativeDpp += v;
    const dt = new Date(`${d}T12:00:00`); // noon to dodge tz edge
    console.log(
      `  ${d} (${DOW_LABELS[dt.getDay()]})  net=${fmtUsd(v).padStart(10)}  cumulative=${fmtUsd(cumulativeDpp)}`,
    );
  }
  const realizedDppNet = cumulativeDpp;
  console.log(`  TOTAL realized DPP net through today: ${fmtUsd(realizedDppNet)}\n`);

  // ===== Extrapolation walkthrough =====
  console.log("======== DPP extrapolation factor ========");
  const monthDays = 31;
  const elapsed = today.getDate();
  const factor = monthDays / elapsed;
  console.log(`  formula:    MONTH_DAYS[May] / now.getDate()`);
  console.log(`  values:     31 / ${elapsed} = ${factor.toFixed(4)}×`);
  console.log(`  realized DPP × factor = projected DPP`);
  console.log(`  ${fmtUsd(realizedDppNet)} × ${factor.toFixed(4)} = ${fmtUsd(realizedDppNet * factor)}\n`);

  console.log("  Day-of-week composition of realized days:");
  const dowCounts = new Array(7).fill(0);
  for (const d of sortedDates) {
    const dt = new Date(`${d}T12:00:00`);
    dowCounts[dt.getDay()] += 1;
  }
  for (let i = 0; i < 7; i++) {
    if (dowCounts[i] > 0)
      console.log(`    ${DOW_LABELS[i].padEnd(3)} present in realized window: ${dowCounts[i]} day(s)`);
  }
  // What does the rest of May look like by DOW?
  const remainingDayCounts = new Array(7).fill(0);
  for (let d = elapsed + 1; d <= monthDays; d++) {
    const dt = new Date(2026, 4, d);
    remainingDayCounts[dt.getDay()] += 1;
  }
  console.log(`  Remaining ${monthDays - elapsed} days of May by DOW:`);
  for (let i = 0; i < 7; i++) {
    if (remainingDayCounts[i] > 0)
      console.log(`    ${DOW_LABELS[i].padEnd(3)}: ${remainingDayCounts[i]} day(s)`);
  }
  console.log();

  // ===== May full revenue breakdown =====
  console.log("======== May 2026 revenue breakdown ========");
  const mayRev = data.revenue.filter((r) => r.month === "May 2026");
  const realizedByType = new Map<string, number>();
  const projByType = new Map<string, number>();
  for (const r of mayRev) {
    const target = r.source === "PROJECTION" ? projByType : realizedByType;
    target.set(r.type, (target.get(r.type) ?? 0) + r.net);
  }
  console.log("  Realized (gross, in fin_revenue, source != PROJECTION):");
  for (const [t, v] of [...realizedByType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t.padEnd(20)} ${fmtUsd(v).padStart(12)}`);
  }
  console.log("  PROJECTION rows:");
  for (const [t, v] of [...projByType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t.padEnd(20)} ${fmtUsd(v).padStart(12)}`);
  }
  console.log();

  // Apply the lib's own logic:
  const libNetRev = netRevenueFor(fd, "May 2026", "projection", today);
  console.log(`  netRevenueFor("May 2026", "projection"): ${fmtUsd(libNetRev)}`);
  console.log(`  Composition: realized non-DPP + (realized DPP × factor)`);
  let realizedNonDpp = 0;
  for (const [t, v] of realizedByType) {
    if (t !== "DPP") realizedNonDpp += v;
  }
  console.log(`    realized non-DPP                = ${fmtUsd(realizedNonDpp)}`);
  console.log(`    realized DPP × ${factor.toFixed(4)} = ${fmtUsd(realizedDppNet * factor)}`);
  console.log(`    sum                              = ${fmtUsd(realizedNonDpp + realizedDppNet * factor)}\n`);

  // ===== May expense breakdown =====
  console.log("======== May 2026 expense breakdown ========");
  const libExp = totalExpensesFor(fd, "May 2026", "projection", today);
  const fc = fieldCostsFor(fd, "May 2026");
  const pmt = perMatchTotalFor(fd, "May 2026");
  const finExpByCat = new Map<string, number>();
  for (const e of data.expenses) {
    if (e.month !== "May 2026") continue;
    finExpByCat.set(e.category, (finExpByCat.get(e.category) ?? 0) + e.amount);
  }
  let mmp = finExpByCat.get("Match Manager Pay") ?? 0;
  let nonMmpFinExp = 0;
  for (const [c, v] of finExpByCat) if (c !== "Match Manager Pay") nonMmpFinExp += v;
  let cmTotal = 0;
  let mkTotal = 0;
  let eqTotal = 0;
  for (const m of data.monthlyExpenses) {
    if (m.month !== "May 2026") continue;
    cmTotal += m.city_manager;
    mkTotal += m.marketing;
    eqTotal += m.equipment;
  }
  console.log(`  fin_expenses (non-MMP):                 ${fmtUsd(nonMmpFinExp)}`);
  for (const [c, v] of [...finExpByCat.entries()].sort((a, b) => b[1] - a[1])) {
    if (c === "Match Manager Pay") continue;
    console.log(`    ${c.padEnd(28)} ${fmtUsd(v).padStart(10)}`);
  }
  console.log(`  Match Manager Pay:                      ${fmtUsd(mmp)}`);
  console.log(`  fieldCostsFor:                          ${fmtUsd(fc)}`);
  console.log(`  perMatchTotalFor (subset of fc):        ${fmtUsd(pmt)}`);
  console.log(`  monthly_expenses (city_manager):        ${fmtUsd(cmTotal)}`);
  console.log(`  monthly_expenses (marketing):           ${fmtUsd(mkTotal)}`);
  console.log(`  monthly_expenses (equipment):           ${fmtUsd(eqTotal)}`);
  console.log(`  TOTAL (lib totalExpensesFor):           ${fmtUsd(libExp)}`);
  console.log(
    `  reconciliation: ${fmtUsd(nonMmpFinExp + mmp + fc + cmTotal + mkTotal + eqTotal)}\n`,
  );

  // ===== Reality check =====
  console.log("======== May 2026 reality check ========");
  console.log("DPP extrapolation IS day-of-week-blind. The factor is just");
  console.log("MONTH_DAYS / elapsed. Let's see if DOW bias matters.\n");

  // Compute realized DPP by DOW.
  const dppByDow = new Array(7).fill(0);
  const daysByDow = new Array(7).fill(0);
  for (const d of sortedDates) {
    const dt = new Date(`${d}T12:00:00`);
    dppByDow[dt.getDay()] += dppByDate.get(d)!;
    daysByDow[dt.getDay()] += 1;
  }
  const avgDppByDow = new Array(7).fill(0);
  for (let i = 0; i < 7; i++) {
    if (daysByDow[i] > 0) avgDppByDow[i] = dppByDow[i] / daysByDow[i];
  }
  console.log("  Realized $DPP per day-of-week (in elapsed window):");
  for (let i = 0; i < 7; i++) {
    if (daysByDow[i] > 0)
      console.log(
        `    ${DOW_LABELS[i].padEnd(3)} ${daysByDow[i]} day(s), avg ${fmtUsd(avgDppByDow[i])}/day`,
      );
  }

  // Smarter forecast: project remaining May using DOW-specific averages
  // when available, falling back to overall average for missing DOWs.
  const overallAvg =
    sortedDates.length > 0 ? realizedDppNet / sortedDates.length : 0;
  let smarterRemaining = 0;
  const remainingDays: { date: string; dow: number; expected: number }[] = [];
  for (let d = elapsed + 1; d <= monthDays; d++) {
    const dt = new Date(2026, 4, d);
    const dow = dt.getDay();
    const expected = daysByDow[dow] > 0 ? avgDppByDow[dow] : overallAvg;
    smarterRemaining += expected;
    remainingDays.push({
      date: `2026-05-${String(d).padStart(2, "0")}`,
      dow,
      expected,
    });
  }
  const smarterDppTotal = realizedDppNet + smarterRemaining;
  console.log(
    `\n  Smarter DPP forecast: realized + Σ(expected per remaining day, by DOW):`,
  );
  console.log(
    `    realized DPP             = ${fmtUsd(realizedDppNet)}`,
  );
  console.log(
    `    smarter remaining        = ${fmtUsd(smarterRemaining)} (${monthDays - elapsed} days)`,
  );
  console.log(`    smarter DPP month total  = ${fmtUsd(smarterDppTotal)}`);
  console.log(
    `    flat-extrapolation total = ${fmtUsd(realizedDppNet * factor)}`,
  );
  console.log(
    `    delta (flat − smarter)   = ${fmtUsd(realizedDppNet * factor - smarterDppTotal)}\n`,
  );

  const smarterMayNetRev = realizedNonDpp + smarterDppTotal;
  const smarterMayNetPL = smarterMayNetRev - libExp;
  console.log("  Comparison:");
  console.log(`    Dashboard May net P&L (current):     ${fmtUsd(libNetRev - libExp)}`);
  console.log(`    Smarter (DOW-aware) May net P&L:     ${fmtUsd(smarterMayNetPL)}`);
  console.log(
    `    Difference:                          ${fmtUsd(libNetRev - libExp - smarterMayNetPL)}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
