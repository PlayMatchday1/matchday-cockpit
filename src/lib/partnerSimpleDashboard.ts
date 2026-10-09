import "server-only";

// THE SIMPLE PARTNER PAGE'S DATA (Ryan, 2026-10-09) — for partners whose partner_dashboards.layout is
// 'simple' (migration 0217; Turf On only, set in the database, never by slug in code).
//
// NO NEW ARITHMETIC. Every number comes from what the standard page already computes:
//   periods, owed, paid      partnerPaymentFor → weeklyPayments (the same builder as every surface)
//   period state and labels  derivePeriodRow (partnerDashboardView, unchanged)
//   matches, spots, revenue  derivePartnerGrains rows (partnerGrain, unchanged)
// "Your share so far" for the OPEN period is that period's owedAmount, DISPLAY ONLY. It is not
// `payment`, it is never written anywhere, and deriveOwed (the admin owed total) still counts only
// closed scheduled / past-due periods — an open period's state is "open", which it does not sum.

import type { PartnerConfig, PartnerPaymentInfo, PartnerRegRow, MemberRateSource } from "./partnerStats";
import type { PartnerGrains } from "./partnerGrain";
import { derivePeriodRow, dfull, todayYmd } from "./partnerDashboardView";
import { isFakePlayerEmail } from "./mdapiFakePlayer";

export type SimpleMonth = {
  key: string; label: string; isOpen: boolean;
  matches: number | null; spots: number | null; revenue: number | null;
  /** The share shown in the table: the settled payment, or for the open period the amount so far. */
  share: number | null;
  status: string;
  /** True when a paid period's figures moved after payment: the paid amount stands. */
  diverged: boolean;
};

export type PartnerSimpleProps = {
  partnerName: string;
  city: string | null;
  updated: string;           // YYYY-MM-DD
  deal: string;
  unit: "month" | "week";
  sharePct: number;
  current: {
    label: string; isOpen: boolean; closes: string | null;
    shareSoFar: number | null; revenue: number | null;
    matches: number | null; spots: number | null; players: number;
    memberRateCents: number | null; memberRateSource: MemberRateSource | null;
  } | null;
  months: SimpleMonth[];     // newest first
};

/** Flat-percentage partners only: the deal sentence and the share column are a percentage. */
export function simpleLayoutApplies(p: PartnerConfig): boolean {
  const flat = (m: string | null) => m == null || m === "flat_percentage" || m === "flat_percentage_with_members";
  return p.revenueModel === "flat_percentage" && flat(p.revenueModelNext);
}

export function buildSimpleDashboard(
  partner: PartnerConfig, city: string | null, rows: PartnerRegRow[],
  payment: PartnerPaymentInfo, grains: PartnerGrains, now: Date,
): PartnerSimpleProps {
  const today = todayYmd(now);
  const unit = partner.paymentCadence === "weekly" ? "week" : "month";
  const grainRows = unit === "week" ? grains.weekRows : grains.monthRows;
  const byKey = new Map(grainRows.map((g) => [g.key, g]));

  const months: SimpleMonth[] = payment.weeklyPayments.map((pw) => {
    const pr = derivePeriodRow(pw, payment.cadence, payment.revenueModel, today);
    const g = byKey.get(pw.weekStartDate);
    const status =
      pr.state === "open" ? `So far, closes ${dfull(pw.weekEndDate)}`
        : pr.state === "paid" ? (pr.paidOn ? `Paid ${dfull(pr.paidOn)}` : "Paid")
          : pr.state === "nothing" ? "Nothing owed"
            : pr.state === "disputed" ? "Under review"
              : pr.state === "presystem" ? (pr.paidOn ? `Paid ${dfull(pr.paidOn)}` : "Paid")
                : "Owed"; // scheduled or past_due
    return {
      key: pw.weekStartDate, label: g?.label ?? pr.label, isOpen: pr.isOpen,
      matches: g?.matches ?? pr.matches, spots: g?.spots ?? null, revenue: g?.revenue ?? pr.qualifying,
      // OPEN: the computed amount to date (display only). CLOSED: exactly what the standard page shows.
      share: pr.isOpen ? pw.owedAmount : pr.payment,
      status, diverged: g?.diverged ?? false,
    };
  }).sort((a, b) => b.key.localeCompare(a.key));

  const cur = months.find((m) => m.isOpen) ?? months[0] ?? null;
  const curPw = cur ? payment.weeklyPayments.find((w) => w.weekStartDate === cur.key) ?? null : null;
  let players = 0;
  if (curPw) {
    // DIFFERENT PLAYERS = distinct player accounts with a spot this period: not a synthetic
    // @matchday.com fill, not a cancelled match or booking, and not a guest row (a guest has no
    // account; their row sits under the host's id).
    const ids = new Set<string>();
    for (const r of rows) {
      const d = r.match_start.slice(0, 10); // match wall-clock day, sliced, never parsed
      if (d < curPw.weekStartDate || d > curPw.weekEndDate) continue;
      if (isFakePlayerEmail(r.email) || r.match_canceled || (r.player_canceled_at ?? "").trim() !== "") continue;
      if (r.user_type === "GUEST") continue;
      ids.add(r.user_id);
    }
    players = ids.size;
  }

  return {
    partnerName: partner.partnerName,
    city,
    updated: today,
    deal: `You earn ${partner.revenueSharePct}% of what players pay to play at ${partner.partnerName}. Paid once each ${unit} closes.`,
    unit,
    sharePct: partner.revenueSharePct,
    current: cur && curPw ? {
      label: cur.label, isOpen: cur.isOpen, closes: cur.isOpen ? curPw.weekEndDate : null,
      shareSoFar: cur.share, revenue: cur.revenue, matches: cur.matches, spots: cur.spots, players,
      memberRateCents: curPw.memberRateCents ?? null, memberRateSource: curPw.memberRateSource ?? null,
    } : null,
    months,
  };
}
