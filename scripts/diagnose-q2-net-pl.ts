// Decompose the Q2 Net P&L hero card. Trace each input that feeds
// q2NetPLProjected, q2NetPLActualClosedMonth, and the "projected"
// difference. Also surface the PROJECTION-source rows for May/Jun
// to check whether the future portion is static.
//
// Read-only.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

const Q2 = ["Apr 2026", "May 2026", "Jun 2026"];

async function fetchAll<T>(table: string, orderCol: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from(table)
      .select("*")
      .order(orderCol)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
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

  const revenue = await fetchAll<{
    month: string;
    type: string;
    source: string;
    gross: number | string;
    net: number | string;
    fees: number | string;
    city: string;
    venue: string | null;
  }>("fin_revenue", "id");

  const expenses = await fetchAll<{
    month: string;
    category: string;
    amount: number | string;
    city: string | null;
  }>("fin_expenses", "id");

  const monthlyExp = await fetchAll<{
    month: string;
    city_manager: number | string;
    marketing: number | string;
    equipment: number | string;
  }>("fin_monthly_expenses", "id");

  const overrides = await fetchAll<{
    month: string;
    venue_id: number;
    override_amount: number | string;
  }>("fin_venue_cost_overrides", "id");

  const venues = await fetchAll<{
    id: number;
    venue_name: string;
    billing_type: string;
    per_match_rate: number | string | null;
    monthly_flat: number | string | null;
  }>("fin_venues", "id");

  const schedule = await fetchAll<{
    month: string;
    venue: string;
    venue_raw: string;
    match_count: number | string;
    venue_cost: number | string | null;
  }>("fin_schedule", "id");

  console.log("======== fin_revenue rows by (month, source) ========");
  type Bucket = {
    realizedNet: number;
    realizedGross: number;
    projectionNet: number;
    projectionGross: number;
    realizedRows: number;
    projectionRows: number;
  };
  const byMonth = new Map<string, Bucket>();
  for (const m of Q2)
    byMonth.set(m, {
      realizedNet: 0,
      realizedGross: 0,
      projectionNet: 0,
      projectionGross: 0,
      realizedRows: 0,
      projectionRows: 0,
    });
  for (const r of revenue) {
    const b = byMonth.get(r.month);
    if (!b) continue;
    const net = Number(r.net) || 0;
    const gross = Number(r.gross) || 0;
    if (r.source === "PROJECTION") {
      b.projectionNet += net;
      b.projectionGross += gross;
      b.projectionRows += 1;
    } else {
      b.realizedNet += net;
      b.realizedGross += gross;
      b.realizedRows += 1;
    }
  }
  for (const m of Q2) {
    const b = byMonth.get(m)!;
    console.log(
      `  ${m}:  realized: ${b.realizedRows} rows, gross=${fmtUsd(b.realizedGross)}, net=${fmtUsd(b.realizedNet)}`,
    );
    console.log(
      `         PROJECTION: ${b.projectionRows} rows, gross=${fmtUsd(b.projectionGross)}, net=${fmtUsd(b.projectionNet)}`,
    );
  }

  console.log("\n======== fin_expenses by month + category ========");
  const expByMonthCat = new Map<string, Map<string, number>>();
  for (const m of Q2) expByMonthCat.set(m, new Map());
  for (const e of expenses) {
    const inner = expByMonthCat.get(e.month);
    if (!inner) continue;
    const cat = e.category;
    inner.set(cat, (inner.get(cat) ?? 0) + (Number(e.amount) || 0));
  }
  for (const m of Q2) {
    const inner = expByMonthCat.get(m)!;
    let total = 0;
    for (const [, v] of inner) total += v;
    console.log(`  ${m} total fin_expenses: ${fmtUsd(total)}`);
    for (const [cat, v] of [...inner.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${cat.padEnd(28)} ${fmtUsd(v)}`);
    }
  }

  console.log("\n======== fin_monthly_expenses ========");
  for (const m of Q2) {
    const r = monthlyExp.find((x) => x.month === m);
    if (!r) {
      console.log(`  ${m}: (no row)`);
      continue;
    }
    const cm = Number(r.city_manager) || 0;
    const mk = Number(r.marketing) || 0;
    const eq = Number(r.equipment) || 0;
    console.log(
      `  ${m}: city_manager=${fmtUsd(cm)}, marketing=${fmtUsd(mk)}, equipment=${fmtUsd(eq)}, total=${fmtUsd(cm + mk + eq)}`,
    );
  }

  // Per-month field costs (best-effort: from schedule.venue_cost or
  // venue.per_match_rate * match_count, with overrides taking priority).
  console.log("\n======== fieldCostsFor (approximated) ========");
  function fieldCostsApprox(month: string): number {
    let total = 0;
    const overrideByVenue = new Map<number, number>();
    for (const o of overrides) {
      if (o.month !== month) continue;
      overrideByVenue.set(o.venue_id, Number(o.override_amount) || 0);
    }
    for (const v of venues) {
      const o = overrideByVenue.get(v.id);
      if (o !== undefined) {
        total += o;
        continue;
      }
      if (v.billing_type === "per_match") {
        const matches = schedule
          .filter((s) => s.month === month && s.venue_raw === v.venue_name)
          .reduce((s2, s) => s2 + (Number(s.match_count) || 0), 0);
        total += matches * (Number(v.per_match_rate) || 0);
      } else if (v.billing_type === "per_hour") {
        const cost = schedule
          .filter((s) => s.month === month && s.venue_raw === v.venue_name)
          .reduce((s2, s) => s2 + (Number(s.venue_cost) || 0), 0);
        total += cost;
      }
      // monthly_flat / lump_sum / profit_share / no_charge: covered by overrides if present.
    }
    return total;
  }

  for (const m of Q2) {
    console.log(`  ${m}: ~${fmtUsd(fieldCostsApprox(m))}`);
  }

  // Reconstruct the hero numbers per-month.
  console.log("\n======== Reconstructed Q2 Net P&L breakdown ========");
  function netRevenueProjection(m: string, today: Date): number {
    const b = byMonth.get(m)!;
    const monthIdx = ["Apr 2026", "May 2026", "Jun 2026"].indexOf(m);
    const todayMonth = today.getMonth(); // 0-indexed
    // Apr=3, May=4, Jun=5 in 0-indexed. Q2 month 0/1/2.
    const calendarMonth = 3 + monthIdx;
    if (todayMonth > calendarMonth) {
      // past month
      return b.realizedNet;
    }
    if (todayMonth === calendarMonth) {
      // current month: realized × extrapolation factor on DPP type
      // (we don't have DPP-only here without more filtering; approximate
      // by applying factor to all realized — close enough for diagnosis)
      const elapsed = today.getDate();
      const monthDays = [30, 31, 30][monthIdx]; // April=30, May=31, June=30
      const factor = monthDays / elapsed;
      // DPP-only extrapolation in real code — approximate as full
      const dppNet = revenue
        .filter((r) => r.month === m && r.source !== "PROJECTION" && r.type === "DPP")
        .reduce((s, r) => s + (Number(r.net) || 0), 0);
      const otherNet = b.realizedNet - dppNet;
      return dppNet * factor + otherNet;
    }
    // future month: max(PROJECTION, realized) per type
    const perType = new Map<string, { proj: number; real: number }>();
    for (const r of revenue) {
      if (r.month !== m) continue;
      const slot = perType.get(r.type) ?? { proj: 0, real: 0 };
      if (r.source === "PROJECTION") slot.proj += Number(r.net) || 0;
      else slot.real += Number(r.net) || 0;
      perType.set(r.type, slot);
    }
    let total = 0;
    for (const [, v] of perType) total += Math.max(v.proj, v.real);
    return total;
  }

  function totalExpensesProjection(m: string): number {
    const expRow = monthlyExp.find((x) => x.month === m);
    const cm = Number(expRow?.city_manager) || 0;
    const mk = Number(expRow?.marketing) || 0;
    const eq = Number(expRow?.equipment) || 0;
    const monthlyExpTotal = cm + mk + eq;
    let other = 0;
    let mmp = 0;
    for (const e of expenses) {
      if (e.month !== m) continue;
      if (e.category === "Match Manager Pay") mmp += Number(e.amount) || 0;
      else other += Number(e.amount) || 0;
    }
    const fc = fieldCostsApprox(m);
    return other + fc + mmp + monthlyExpTotal;
  }

  console.log(
    "  month     | net rev (proj) | total exp     | net P&L      | counted in 'actual' subtitle?",
  );
  let actualPL = 0;
  let projPL = 0;
  for (const m of Q2) {
    const monthIdx = Q2.indexOf(m);
    const calendarMonth = 3 + monthIdx;
    const isFuture = today.getMonth() < calendarMonth;
    const netRev = netRevenueProjection(m, today);
    const exp = totalExpensesProjection(m);
    const pl = netRev - exp;
    const inActual = !isFuture;
    if (inActual) actualPL += pl;
    projPL += pl;
    console.log(
      `  ${m}  | ${fmtUsd(netRev).padStart(14)} | ${fmtUsd(exp).padStart(13)} | ${fmtUsd(pl).padStart(12)} | ${inActual ? "yes" : "NO (counted only in projected total)"}`,
    );
  }
  console.log();
  console.log(`  q2NetPLProjected         (sum all Q2):    ${fmtUsd(projPL)}`);
  console.log(`  q2NetPLActualClosedMonth (sum started):   ${fmtUsd(actualPL)}`);
  console.log(`  projected portion (total − actual):       ${fmtUsd(projPL - actualPL)}`);
  console.log();
  console.log("→ The 'projected' portion of the hero subtitle = the");
  console.log("  net P&L of any FUTURE Q2 months (June if not yet started).");
  console.log("  Past + current months are entirely in 'actual'.");

  // Surface the PROJECTION rows for stability check.
  console.log("\n======== PROJECTION-source rows in fin_revenue ========");
  for (const m of Q2) {
    const projRows = revenue.filter(
      (r) => r.month === m && r.source === "PROJECTION",
    );
    if (projRows.length === 0) {
      console.log(`  ${m}: (none)`);
      continue;
    }
    console.log(`  ${m}: ${projRows.length} rows`);
    for (const r of projRows) {
      console.log(
        `    type=${r.type.padEnd(15)} net=${fmtUsd(Number(r.net) || 0).padStart(10)} city=${r.city ?? "—"} venue=${r.venue ?? "—"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
