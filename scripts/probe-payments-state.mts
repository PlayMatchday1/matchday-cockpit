// Read-only: real per-partner payment state, using the SAME functions the admin
// API + view use. Reports awaiting / latest / older(count,total) / disputed /
// diverged(with both numbers) so the rebuild + report rest on live data.
import { createClient } from "@supabase/supabase-js";
import {
  computeWeeklyPayments, fetchPartnerRows, fetchPartnerWeeklyPayments, type PartnerConfig,
} from "../src/lib/partnerStats.ts";
import { derivePeriodRows, money } from "../src/lib/partnerDashboardView.ts";

process.loadEnvFile(".env.local");
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const today = new Date().toISOString().slice(0, 10);
console.log("today =", today, "\n");

const { data: rowsP } = await svc.from("partner_dashboards")
  .select("id, slug, partner_name, venue_id, enabled, revenue_share_pct, payment_start_date, payment_day_of_week, payment_cadence, revenue_model, manager_pay_base, manager_pay_high, manager_pay_threshold")
  .order("created_at", { ascending: true });

let badgeAwaiting = 0, badgeDisputed = 0, badgeDiverged = 0;
const contrib: Record<string, string[]> = { awaiting: [], disputed: [], diverged: [] };

for (const p of rowsP ?? []) {
  const cfg: PartnerConfig = {
    id: p.id, venueId: p.venue_id, partnerName: p.partner_name,
    revenueSharePct: p.revenue_share_pct ?? 50, paymentStartDate: p.payment_start_date ?? null,
    paymentDayOfWeek: p.payment_day_of_week ?? 0, paymentCadence: (p.payment_cadence ?? "weekly"),
    revenueModel: (p.revenue_model ?? "flat_percentage"), managerPayBase: p.manager_pay_base ?? null,
    managerPayHigh: p.manager_pay_high ?? null, managerPayThreshold: p.manager_pay_threshold ?? null,
  };
  const { rows, extra } = await fetchPartnerRows(svc, p.venue_id);
  const records = await fetchPartnerWeeklyPayments(svc, p.id);
  const payment = computeWeeklyPayments(rows, extra, cfg, records);
  const prs = derivePeriodRows(payment, today).sort((a, b) => b.pw.weekStartDate.localeCompare(a.pw.weekStartDate));

  const awaiting = prs.filter((r) => r.state === "scheduled" || r.state === "past_due" || r.state === "disputed");
  const disputed = prs.filter((r) => r.state === "disputed");
  const settledSet = prs.filter((r) => r.state === "paid" || r.state === "presystem"); // settled PAYMENTS, newest-first (presystem oldest → last)
  const diverged = settledSet.filter((r) => r.pw.calculatedAmount != null && Math.abs(r.pw.owedAmount - r.pw.calculatedAmount) > 1);
  const latest = settledSet[0] ?? null;
  const older = settledSet.slice(1);
  const foldTotal = older.reduce((s, r) => s + Math.round(r.payment ?? 0), 0);

  badgeAwaiting += awaiting.length; badgeDisputed += disputed.length; badgeDiverged += diverged.length;
  if (awaiting.length) contrib.awaiting.push(`${p.partner_name}(${awaiting.length})`);
  if (disputed.length) contrib.disputed.push(`${p.partner_name}(${disputed.length})`);
  if (diverged.length) contrib.diverged.push(`${p.partner_name}(${diverged.length})`);

  console.log(`■ ${p.partner_name}  [${p.payment_cadence}, ${p.slug}]  enabled=${p.enabled}`);
  console.log(`   total periods rendered by state: ${prs.map((r) => r.state).reduce((m: any, s) => (m[s] = (m[s] || 0) + 1, m), {}) && JSON.stringify(prs.reduce((m: any, s) => (m[s.state] = (m[s.state] || 0) + 1, m), {}))}`);
  console.log(`   SETTLED count (paid+presystem): ${settledSet.length}`);
  console.log(`   AWAITING (${awaiting.length}): ${awaiting.map((r) => `${r.label}=${money(r.payment ?? 0)}[${r.state}]`).join(", ") || "—"}`);
  console.log(`   LATEST SETTLED: ${latest ? `${latest.label}=${money(latest.payment ?? 0)} paid ${latest.paidOn} [${latest.state}]` : "—"}`);
  console.log(`   OLDER (fold): count=${older.length}  total=${money(foldTotal)}  flagged=${older.filter((r) => diverged.includes(r)).length}  opening-in-fold=${older.some((r) => r.state === "presystem")}`);
  console.log(`   DISPUTED (${disputed.length}): ${disputed.map((r) => r.label).join(", ") || "—"}`);
  console.log(`   DIVERGED (${diverged.length}): ${diverged.map((r) => `${r.label}: paid ${money(r.pw.calculatedAmount!)} → recompute ${money(r.pw.owedAmount)}`).join("; ") || "—"}`);
  console.log(`   ROWS-AT-REST would be: awaiting(${awaiting.length}) + latest(${latest ? 1 : 0}) = ${awaiting.length + (latest ? 1 : 0)}  [older folded]`);
  console.log("");
}

console.log("════ SIDEBAR BADGE (actionable across all partners) ════");
console.log(`   awaiting = ${badgeAwaiting}   ${contrib.awaiting.join(" ")}`);
console.log(`   disputed = ${badgeDisputed}   ${contrib.disputed.join(" ")}`);
console.log(`   diverged = ${badgeDiverged}   ${contrib.diverged.join(" ")}`);
console.log(`   TOTAL BADGE = ${badgeAwaiting + badgeDisputed + badgeDiverged}  → ${badgeAwaiting + badgeDisputed + badgeDiverged === 0 ? "NO BADGE RENDERED" : "badge shows this number"}`);
