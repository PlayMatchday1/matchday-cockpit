// THE RENTAL PAGE'S MONTHS, IN THE SHAPE THE ADMIN LIST RENDERS.
//
// The admin Partner Dashboards list draws its payment rows and its owed total from a
// PartnerPaymentInfo (derivePeriodRows / deriveOwed). A rental partner's figures come from
// buildRentalDashboard, the builder the partner's own page and Mark paid use. This adapter does no
// arithmetic of its own: every amount is a month total the rental builder already produced, so the
// list cannot drift from the page.
//
// Before this existed the list ran rental partners through the legacy revenue-share path on the
// stale revenue_share_pct column (Parmer: 50% of revenue, against a RENTAL_FLOOR_PROFIT_SHARE deal).
//
// WHAT A ROW SHOWS, mirroring PartnerRentalView's shownTotal: a paid month shows what was actually
// paid (paid_amount) when it differs from the formula, otherwise the computed total. The stored
// calculated_amount is NOT shown: on Parmer's August it is $1,935.00, a snapshot from the legacy
// formula, while $2,520.00 is what moved.

import type { PartnerPaymentInfo, PartnerWeeklyPayment, PartnerConfig } from "./partnerStats";
import type { RentalDashboardProps } from "./partnerRentalDashboard";
import type { PeriodLedger } from "./partnerPayoutModel";

type LedgerRecord = {
  id?: unknown; week_start_date?: unknown; status?: unknown; paid_at?: unknown; paid_amount?: unknown;
  paid_notes?: unknown; dispute_note?: unknown; disputed_at?: unknown;
};

/* THE LEDGER MAP buildRentalDashboard takes, built the way buildPartnerDashboardData builds it for
 * the partner's page: keyed by YYYY-MM, paid_amount rounded to cents once, here. Without it a month's
 * paidAmountCents is null and a paid month would show the formula instead of what was paid. */
export function rentalLedgerOf(records: LedgerRecord[]): Map<string, PeriodLedger> {
  return new Map<string, PeriodLedger>(
    records.map((r) => [
      String(r.week_start_date).slice(0, 7),
      {
        status: ((r.status as "pending" | "paid" | "disputed" | null | undefined) ?? "pending"),
        paidAt: (r.paid_at as string | null | undefined) ?? null,
        paidAmountCents: r.paid_amount == null ? null : Math.round(Number(r.paid_amount) * 100),
      },
    ]),
  );
}

export function rentalPaymentInfo(
  partner: PartnerConfig,
  rental: RentalDashboardProps,
  records: LedgerRecord[],
): PartnerPaymentInfo {
  // Monthly cadence keys the ledger by the first day of the month, which is the rental month's
  // periodKey and what a Mark paid write addresses.
  const byYm = new Map<string, LedgerRecord>();
  for (const r of records) byYm.set(String(r.week_start_date ?? "").slice(0, 7), r);

  const weeklyPayments: PartnerWeeklyPayment[] = rental.months.map((m) => {
    const rec = byYm.get(m.ym) ?? null;
    const status = (rec?.status === "paid" || rec?.status === "disputed" ? rec.status : "pending") as PartnerWeeklyPayment["status"];
    const computed = m.totals.partnerTotalCents / 100;
    const shown = (m.paidAmountCents ?? m.totals.partnerTotalCents) / 100;
    return {
      weekStartDate: m.periodKey,
      weekEndDate: m.closesYmd,
      qualifyingRevenue: m.totals.grossCents / 100,
      owedAmount: computed,
      matches: m.totals.matches,
      managerPay: m.totals.matchManagerCents / 100,
      status,
      recordId: rec?.id == null ? null : String(rec.id),
      // What the paid row displays (derivePeriodRow shows calculatedAmount on a paid period).
      calculatedAmount: status === "paid" ? shown : null,
      paidAt: (rec?.paid_at as string | null | undefined) ?? null,
      paidNotes: (rec?.paid_notes as string | null | undefined) ?? null,
      disputeNote: (rec?.dispute_note as string | null | undefined) ?? null,
      disputedAt: (rec?.disputed_at as string | null | undefined) ?? null,
      isPreSystem: false,
    };
  });

  const first = weeklyPayments[0]?.weekStartDate ?? null;
  return {
    enabled: true,
    cadence: "monthly",
    revenueModel: partner.revenueModel,
    revenueModelNext: null,
    revenueModelFrom: null,
    perMatchFeeCents: null,
    revenueSharePct: partner.partnerSharePct ?? partner.revenueSharePct,
    paymentStartDate: partner.paymentStartDate,
    paymentDayOfWeek: partner.paymentDayOfWeek,
    firstQualifyingPeriod: first,
    firstQualifyingSunday: first,
    weeklyPayments,
  };
}
