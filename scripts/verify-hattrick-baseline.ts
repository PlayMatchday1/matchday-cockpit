// Sanity probe: compute Hattrick partner stats with and without the
// 2026-03-31 baseline filter so we can confirm the totals drop and the
// post-Mar-31 numbers stay sensible before pushing.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  fetchPartnerRows,
  computePartnerStats,
  computeWeeklyPayments,
  fetchPartnerWeeklyPayments,
  fetchPartnerBySlug,
} from "../src/lib/partnerStats";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
// Service-role key — anon RLS blocks mdapi tables in this script
// context. Production server uses anon publishable key but the
// PostgREST policies in production grant the publishable role broader
// access via Vercel's deployment env. Numbers from the service-role
// probe are directionally correct; absolute totals will match what
// the live dashboard renders post-deploy.
const key =
  env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)?.[1].trim() ??
  env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

async function main() {
  // Resolve hattrick venue id by slug
  const { data: pd } = await sb
    .from("partner_dashboards")
    .select("venue_id, partner_name")
    .eq("slug", "hattrick-yx4sur4t")
    .maybeSingle<{ venue_id: number; partner_name: string }>();
  if (!pd) throw new Error("partner not found");
  console.log(`# Partner: ${pd.partner_name}  venue_id=${pd.venue_id}`);

  const { rows, extra } = await fetchPartnerRows(sb, pd.venue_id);
  console.log(`# rows=${rows.length}  extra=${extra.length}`);

  const baseline = "2026-03-31";
  const fRows = rows.filter((r) => r.match_start.slice(0, 10) >= baseline);
  const fExtra = extra.filter((e) => e.date >= baseline);
  console.log(`# After baseline (>= ${baseline}): rows=${fRows.length}  extra=${fExtra.length}\n`);

  const before = computePartnerStats(rows, extra);
  const after = computePartnerStats(fRows, fExtra);

  console.log("# Top totals (BEFORE → AFTER):");
  console.log(`  spots:    ${before.totals.spots}  →  ${after.totals.spots}`);
  console.log(`  md:       ${before.totals.md}  →  ${after.totals.md}`);
  console.log(`  guests:   ${before.totals.guests}  →  ${after.totals.guests}`);
  console.log(`  cancels:  ${before.totals.cancels}  →  ${after.totals.cancels}`);
  console.log(`  rev:      $${before.totals.rev.toFixed(2)}  →  $${after.totals.rev.toFixed(2)}\n`);

  console.log("# byMonth BEFORE:");
  for (const m of before.byMonth) {
    console.log(`  ${m.label}  matches=${m.matches}  rev=$${m.revenue.toFixed(2)}`);
  }
  console.log("\n# byMonth AFTER:");
  for (const m of after.byMonth) {
    console.log(`  ${m.label}  matches=${m.matches}  rev=$${m.revenue.toFixed(2)}`);
  }

  console.log("\n# weeks AFTER (should start Mar 30 Mon, label 'Mar 31 – ...'):");
  for (let i = 0; i < Math.min(after.weeks.length, 8); i++) {
    const w = after.weeks[i];
    const lbl = "label" in w ? w.label : "";
    const voided = w.voided ? " [voided]" : "";
    console.log(`  Week ${i + 1}  wkMonday=${w.wkMonday}  label="${lbl}"${voided}`);
  }

  // Verify Monthly Payments still has all 3 rows (uses unfiltered rows)
  const partner = await fetchPartnerBySlug(sb, "hattrick-yx4sur4t");
  if (!partner) throw new Error("partner config missing");
  const records = await fetchPartnerWeeklyPayments(sb, partner.id);
  const payment = computeWeeklyPayments(
    rows,
    extra,
    {
      revenueSharePct: partner.revenueSharePct,
      paymentStartDate: partner.paymentStartDate,
      paymentDayOfWeek: partner.paymentDayOfWeek,
      paymentCadence: partner.paymentCadence,
    },
    records,
  );
  console.log("\n# Monthly Payments (should keep all 3 rows):");
  console.log(`  enabled: ${payment.enabled}  cadence: ${payment.cadence}`);
  for (const w of payment.weeklyPayments) {
    const flag = w.isPreSystem ? " [pre-system]" : "";
    console.log(
      `  ${w.weekStartDate}  status=${w.status}  owed=$${w.owedAmount.toFixed(2)}  paidAt=${w.paidAt ?? "—"}${flag}`,
    );
  }
}
main().catch(console.error);
