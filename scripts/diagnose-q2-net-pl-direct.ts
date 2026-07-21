// Call the actual financeStats helpers directly to get production
// values for the Q2 NET P&L hero card. Avoids the approximations
// in the previous diagnostic (especially fieldCostsFor).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  Q2_MONTHS,
  q2NetPLProjected,
  q2NetPLActualClosedMonth,
  q2NetRevenueProjected,
  q2ExpensesProjected,
  netRevenueFor,
  totalExpensesFor,
  isFutureMonth,
} from "../src/lib/financeStats";
import { fieldCostsFor, perMatchTotalFor } from "../src/lib/financeCosts";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
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

async function main() {
  const today = new Date();
  console.log(`today: ${today.toISOString().slice(0, 10)}\n`);

  // Build a minimal FinanceData covering everything the helpers touch.
  const [
    revRaw,
    expRaw,
    monthExpRaw,
    venuesRaw,
    schedRaw,
    overridesRaw,
    aliasesRaw,
    configRaw,
  ] = await Promise.all([
    fetchAll<Record<string, unknown>>("fin_revenue", "id"),
    fetchAll<Record<string, unknown>>("fin_expenses", "id"),
    fetchAll<Record<string, unknown>>("fin_monthly_expenses", "id"),
    fetchAll<Record<string, unknown>>("fin_venues", "id"),
    fetchAll<Record<string, unknown>>("fin_schedule", "id"),
    fetchAll<Record<string, unknown>>("fin_venue_cost_overrides", "id"),
    fetchAll<Record<string, unknown>>("fin_venue_aliases", "alias"),
    fetchAll<Record<string, unknown>>("fin_config", "key"),
  ]);

  const num = (v: unknown): number => Number(v) || 0;
  const numOrNull = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  const txt = (v: unknown): string => String(v ?? "");

  const venueAliases = new Map<string, string>();
  for (const a of aliasesRaw) {
    venueAliases.set(txt(a.alias), txt(a.canonical_venue));
  }

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

  const config: Record<string, string> = {};
  for (const c of configRaw) config[txt(c.key)] = txt(c.value);

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
    config,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fd = data as any;

  console.log("======== Hero card numbers (production helpers) ========");
  const projTotal = q2NetPLProjected(fd, today);
  const actual = q2NetPLActualClosedMonth(fd, today);
  const projPortion = projTotal - actual;
  console.log(`  q2NetPLProjected (total card value):    ${fmtUsd(projTotal)}`);
  console.log(`  q2NetPLActualClosedMonth (subtitle 1):  ${fmtUsd(actual)}`);
  console.log(`  projected portion (subtitle 2):         ${fmtUsd(projPortion)}`);

  console.log("\n======== Q2-wide totals ========");
  const netRev = q2NetRevenueProjected(fd, today);
  const expProj = q2ExpensesProjected(fd, today);
  console.log(`  q2NetRevenueProjected:                  ${fmtUsd(netRev)}`);
  console.log(`  q2ExpensesProjected:                    ${fmtUsd(expProj)}`);
  console.log(`  difference (= net P&L):                 ${fmtUsd(netRev - expProj)}`);

  console.log("\n======== Per-month breakdown ========");
  console.log("  month      |  net rev (proj) |  total exp     |  net P&L      |  is future?");
  console.log("  -----------|-----------------|----------------|---------------|------------");
  for (const m of Q2_MONTHS) {
    const nr = netRevenueFor(fd, m, "projection", today);
    const exp = totalExpensesFor(fd, m, "projection", today);
    const fut = isFutureMonth(m, today);
    console.log(
      `  ${m}   | ${fmtUsd(nr).padStart(15)} | ${fmtUsd(exp).padStart(14)} | ${fmtUsd(nr - exp).padStart(13)} | ${fut ? "YES" : "no"}`,
    );
  }

  console.log("\n======== Per-month expense breakdown ========");
  for (const m of Q2_MONTHS) {
    const total = totalExpensesFor(fd, m, "projection", today);
    const fc = fieldCostsFor(fd, m);
    const pmTotal = perMatchTotalFor(fd, m);
    const otherCats = data.expenses
      .filter((e) => e.month === m)
      .reduce((s, e) => s + e.amount, 0);
    const me = data.monthlyExpenses.find((mm) => mm.month === m);
    const meTotal =
      (me?.city_manager ?? 0) + (me?.marketing ?? 0) + (me?.equipment ?? 0);
    console.log(
      `  ${m}: total=${fmtUsd(total)}  fieldCostsFor=${fmtUsd(fc)}  perMatchTotal=${fmtUsd(pmTotal)}  fin_expenses=${fmtUsd(otherCats)}  monthly_exp=${fmtUsd(meTotal)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
