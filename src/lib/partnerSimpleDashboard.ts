import "server-only";

// THE SIMPLE PARTNER PAGE'S DATA (Ryan, 2026-10-09) — for partners whose partner_dashboards.layout is
// 'simple' (migration 0217; Turf On only, set in the database, never by slug in code).
//
// NO NEW PAYOUT ARITHMETIC. Every number that feeds a payment comes from what the standard page
// already computes:
//   periods, owed, paid      partnerPaymentFor → weeklyPayments (the same builder as every surface)
//   period state and labels  derivePeriodRow (partnerDashboardView, unchanged)
//   matches, revenue         derivePartnerGrains rows (partnerGrain, unchanged)
// "Your share so far" for the OPEN period is that period's owedAmount, DISPLAY ONLY. It is not
// `payment`, it is never written anywhere, and deriveOwed (the admin owed total) still counts only
// closed scheduled / past-due periods — an open period's state is "open", which it does not sum.
//
// THE MATCH TABLE (Ryan, 2026-10-09) explains the month's revenue match by match, using the SAME
// rules periodOwed uses to compute it, restated per match:
//   revenue      Σ match_price_paid of DAILY PAID rows on a match that was not cancelled — a
//                player-cancelled row keeps its price, exactly as dpRev does — plus member spots
//                (MEMBER, not a guest, not cancelled) × the period's member rate.
//   total spots  spots HELD. Cancelled bookings are not counted as spots (Ryan, 2026-10-09: "dont
//                count late cancels") — but a cancelled DAILY PAID booking still carries its price into
//                revenue (the payout's rule, unchanged), so a row says how much of its revenue came
//                from cancelled bookings, and the table still explains the month's revenue exactly.
//   daily paid   a DAILY PAID booking at the match price per spot (paid ÷ spots ≥ price): the buyer's
//                spot and every guest spot they bought.
//   members      a MEMBER row that is not a guest — the spots the payout values at the member rate.
//   promo        anything else: a promo code, a credit, a free first match, a below-price booking,
//                a member's guest.
// Daily paid + Members + Promo = Total spots by construction, and a period's match revenue is
// checked against the period's revenue; a mismatch is surfaced, never hidden.

import type { PartnerConfig, PartnerPaymentInfo, PartnerRegRow, MemberRateSource } from "./partnerStats";
import type { PartnerGrains } from "./partnerGrain";
import { derivePeriodRow } from "./partnerDashboardView";
import { isFakePlayerEmail } from "./mdapiFakePlayer";

const CHI = "America/Chicago";
const MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A calendar day (YYYY-MM-DD) as "Oct 31, 2026" — string maths, no time zone involved. */
const dayText = (ymd: string) => `${MONS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}, ${ymd.slice(0, 4)}`;
/** A TRUE instant → its calendar day in Central time. */
const chicagoYmd = (instant: Date | string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: CHI, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));

export type MatchMeta = { apiId: number; startWall: string; startUtc: string | null; priceCents: number | null; cancelled: boolean };

export type SimpleMatchRow = {
  apiId: number; periodKey: string;
  /** The match's LOCAL wall-clock start, "YYYY-MM-DDTHH:MM" — sliced from start_date, never parsed. */
  kickoff: string;
  priceCents: number | null;
  total: number; daily: number; members: number; promo: number;
  revenue: number;
  /** Revenue on this row that came from cancelled bookings (counted by the payout, not as spots). */
  cancelledRevenue: number;
};

export type SimpleMonth = {
  key: string; label: string; isOpen: boolean;
  matches: number | null; total: number | null; daily: number | null; members: number | null; promo: number | null;
  revenue: number | null;
  /** The share shown in the table: the settled payment, or for the open period the amount so far. */
  share: number | null;
  status: string;
  /** True when a paid period's figures moved after payment: the paid amount stands. */
  diverged: boolean;
  /** Set when this period's match rows do not add up to its revenue — shown, never hidden. */
  mismatch: string | null;
};

export type PartnerSimpleProps = {
  partnerName: string;
  city: string | null;
  updated: string;           // YYYY-MM-DD, Central
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
  matchRows: SimpleMatchRow[]; // newest first
};

/** Flat-percentage partners only: the deal sentence and the share column are a percentage. */
export function simpleLayoutApplies(p: PartnerConfig): boolean {
  const flat = (m: string | null) => m == null || m === "flat_percentage" || m === "flat_percentage_with_members";
  return p.revenueModel === "flat_percentage" && flat(p.revenueModelNext);
}

const isCancelledRow = (r: PartnerRegRow) => (r.player_canceled_at ?? "").trim() !== "";

/** Build one row per match: classify every spot, and restate the period's revenue per match. */
function matchRowsFor(rows: PartnerRegRow[], metas: Map<number, MatchMeta>, periodOf: (ymd: string) => { key: string; memberRateCents: number | null } | null): SimpleMatchRow[] {
  const byMatch = new Map<number, PartnerRegRow[]>();
  for (const r of rows) {
    if (r.match_api_id == null || isFakePlayerEmail(r.email) || r.match_canceled) continue;
    const list = byMatch.get(r.match_api_id) ?? [];
    list.push(r);
    byMatch.set(r.match_api_id, list);
  }
  const out: SimpleMatchRow[] = [];
  for (const [apiId, list] of byMatch) {
    const meta = metas.get(apiId);
    const kickoff = (meta?.startWall ?? list[0].match_start).slice(0, 16);
    const period = periodOf(kickoff.slice(0, 10));
    if (!period) continue; // a match outside every period shown
    const priceCents = meta?.priceCents ?? null;
    const counted = list.filter((r) => !isCancelledRow(r)); // spots HELD only

    // A guest's spot goes with its buyer's booking: same account, same match.
    const hostOf = new Map<string, PartnerRegRow>();
    for (const r of list) if (r.user_type !== "GUEST") hostOf.set(String(r.user_id), r);
    const spotsBought = (host: PartnerRegRow) => 1 + list.filter((g) => g.user_type === "GUEST" && String(g.user_id) === String(host.user_id) && !isCancelledRow(g)).length;
    const fullPrice = (host: PartnerRegRow) =>
      priceCents == null ? (host.match_price_paid ?? 0) > 0
        : Math.round(((Number(host.match_price_paid ?? 0) * 100) / spotsBought(host))) >= priceCents;

    let daily = 0, members = 0, promo = 0;
    for (const r of counted) {
      const host = r.user_type === "GUEST" ? hostOf.get(String(r.user_id)) ?? r : r;
      if (r.user_type !== "GUEST" && r.payment_type === "MEMBER") members += 1;
      else if (host.payment_type === "DAILY PAID" && fullPrice(host)) daily += 1;
      else promo += 1;
    }
    // Revenue: periodOwed's rule, per match.
    let revenue = 0;
    for (const r of list) if (r.payment_type === "DAILY PAID") revenue += Number(r.match_price_paid ?? 0) || 0;
    const valuedMembers = list.filter((r) => r.payment_type === "MEMBER" && r.user_type !== "GUEST" && !isCancelledRow(r)).length;
    if (valuedMembers && period.memberRateCents != null) revenue += (valuedMembers * period.memberRateCents) / 100;

    const total = counted.length;
    if (total === 0 && revenue === 0) continue; // nothing booked: no row
    const cancelledRevenue = list.filter((r) => isCancelledRow(r) && r.payment_type === "DAILY PAID")
      .reduce((s, r) => s + (Number(r.match_price_paid ?? 0) || 0), 0);
    out.push({ apiId, periodKey: period.key, kickoff, priceCents, total, daily, members, promo, revenue, cancelledRevenue });
  }
  return out.sort((a, b) => b.kickoff.localeCompare(a.kickoff) || b.apiId - a.apiId);
}

export function buildSimpleDashboard(
  partner: PartnerConfig, city: string | null, rows: PartnerRegRow[],
  payment: PartnerPaymentInfo, grains: PartnerGrains, now: Date, metas: MatchMeta[],
): PartnerSimpleProps {
  // The period engine's own "today" (UTC date), so period states read exactly as everywhere else.
  const engineToday = now.toISOString().slice(0, 10);
  const unit = partner.paymentCadence === "weekly" ? "week" : "month";
  const grainRows = unit === "week" ? grains.weekRows : grains.monthRows;
  const byKey = new Map(grainRows.map((g) => [g.key, g]));
  const metaById = new Map(metas.map((m) => [m.apiId, m]));
  const periods = payment.weeklyPayments.filter((pw) => !pw.isPreSystem);
  const periodOf = (ymd: string) => {
    const pw = periods.find((w) => ymd >= w.weekStartDate && ymd <= w.weekEndDate);
    return pw ? { key: pw.weekStartDate, memberRateCents: pw.memberRateCents ?? null } : null;
  };
  const matchRows = matchRowsFor(rows, metaById, periodOf);

  const months: SimpleMonth[] = payment.weeklyPayments.map((pw) => {
    const pr = derivePeriodRow(pw, payment.cadence, payment.revenueModel, engineToday);
    const g = byKey.get(pw.weekStartDate);
    // Dates on this page are Central: a paid date is the Central day of the payment instant.
    const paidOn = pw.paidAt ? (pw.paidAt.length > 10 ? chicagoYmd(pw.paidAt) : pw.paidAt) : null;
    const status =
      pr.state === "open" ? `So far, closes ${dayText(pw.weekEndDate)}`
        : pr.state === "paid" || pr.state === "presystem" ? (paidOn ? `Paid ${dayText(paidOn)}` : "Paid")
          : pr.state === "nothing" ? "Nothing owed"
            : pr.state === "disputed" ? "Under review"
              : "Owed"; // scheduled or past_due
    const mine = matchRows.filter((m) => m.periodKey === pw.weekStartDate);
    const sum = (f: (m: SimpleMatchRow) => number) => mine.reduce((s, m) => s + f(m), 0);
    const revenue = g?.revenue ?? pr.qualifying;
    const matchRevenue = Math.round(sum((m) => m.revenue) * 100);
    const mismatch = pw.isPreSystem || revenue == null || matchRevenue === Math.round(revenue * 100) ? null
      : `The matches below add up to $${(matchRevenue / 100).toFixed(2)}, not the month's $${revenue.toFixed(2)}.`;
    return {
      key: pw.weekStartDate, label: g?.label ?? pr.label, isOpen: pr.isOpen,
      matches: g?.matches ?? pr.matches,
      total: pw.isPreSystem ? null : sum((m) => m.total), daily: pw.isPreSystem ? null : sum((m) => m.daily),
      members: pw.isPreSystem ? null : sum((m) => m.members), promo: pw.isPreSystem ? null : sum((m) => m.promo),
      revenue,
      // OPEN: the computed amount to date (display only). CLOSED: exactly what the standard page shows.
      share: pr.isOpen ? pw.owedAmount : pr.payment,
      status, diverged: g?.diverged ?? false, mismatch,
    };
  }).sort((a, b) => b.key.localeCompare(a.key));

  const cur = months.find((m) => m.isOpen) ?? months[0] ?? null;
  const curPw = cur ? payment.weeklyPayments.find((w) => w.weekStartDate === cur.key) ?? null : null;
  const curGrain = cur ? byKey.get(cur.key) : undefined;
  let players = 0;
  if (curPw) {
    // DIFFERENT PLAYERS = distinct player accounts with a spot this period: not a synthetic
    // @matchday.com fill, not a cancelled match or booking, and not a guest row (a guest has no
    // account; their row sits under the host's id).
    const ids = new Set<string>();
    for (const r of rows) {
      const d = r.match_start.slice(0, 10); // match wall-clock day, sliced, never parsed
      if (d < curPw.weekStartDate || d > curPw.weekEndDate) continue;
      if (isFakePlayerEmail(r.email) || r.match_canceled || isCancelledRow(r)) continue;
      if (r.user_type === "GUEST") continue;
      ids.add(String(r.user_id));
    }
    players = ids.size;
  }

  return {
    partnerName: partner.partnerName,
    city,
    updated: chicagoYmd(now),
    deal: `You earn ${partner.revenueSharePct}% of what players pay to play at ${partner.partnerName}. Paid once each ${unit} closes.`,
    unit,
    sharePct: partner.revenueSharePct,
    current: cur && curPw ? {
      label: cur.label, isOpen: cur.isOpen, closes: cur.isOpen ? curPw.weekEndDate : null,
      shareSoFar: cur.share, revenue: cur.revenue, matches: cur.matches, spots: curGrain?.spots ?? null, players,
      memberRateCents: curPw.memberRateCents ?? null, memberRateSource: curPw.memberRateSource ?? null,
    } : null,
    months,
    matchRows,
  };
}
