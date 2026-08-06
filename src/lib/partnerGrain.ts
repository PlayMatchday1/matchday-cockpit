import "server-only";

// Per-period rows for the v1_4 partner dashboard — DERIVED FROM THE MATCH LIST.
// The money (owed / qualifying revenue / status / paid snapshot) already comes
// from computeWeeklyPayments and is NOT recomputed here; this only adds the seat
// breakdown (spots / daily / guests, with members+promo folded into "other seat
// types") and the private-rental lines, counted on the SAME period boundaries the
// payments use so a seat count never sits against the wrong period's money.
//
// The seat-counting rules mirror computePartnerStats exactly; deriveSeatTotals is
// asserted against stats.totals in verify so a miscount cannot slip through.
//
// Raw rows carry player emails — this module is server-only and returns only
// aggregates; nothing row-level ever reaches the client.

import { isFakePlayerEmail } from "./mdapiFakePlayer";
import { partnerLabelForType, type PartnerRegRow, type PartnerExtraRevRow, type PartnerPaymentInfo, type PartnerWeeklyPayment } from "./partnerStats";
import { derivePeriodRow, type PeriodRow, type PeriodState } from "./partnerDashboardView";

const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
function ceilToSunday(s: string) { const d = parse(s); const dow = d.getUTCDay(); if (dow !== 0) d.setUTCDate(d.getUTCDate() + (7 - dow)); return ymd(d); }
const monthOf = (s: string) => s.slice(0, 7);
const monthStart = (s: string) => `${monthOf(s)}-01`;
const monthEnd = (s: string) => { const d = parse(monthStart(s)); return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); };
const isCanceled = (r: PartnerRegRow) => !!r.player_canceled_at && r.player_canceled_at.trim() !== "";

export type RentalLine = { date: string; label: string; amount: number };
export type GrainRow = {
  key: string; label: string; isOpening: boolean; isOpen: boolean;
  matches: number | null; spots: number | null; daily: number | null; guests: number | null;
  revenue: number | null; rentals: RentalLine[];
  payment: number | null; paymentUnavailable: boolean;
  state: PeriodState; paidOn: string | null;
  diverged: boolean; frozenPaid: number | null; livePayment: number | null;
  weeksPaid?: number; weeksEarning?: number;
};
export type Snapshot = { row: GrainRow | null; prior: GrainRow | null };
export type PartnerGrains = {
  weekRows: GrainRow[]; monthRows: GrainRow[];
  snapshotWeek: Snapshot; snapshotMonth: Snapshot;
  cadence: "weekly" | "monthly"; sharePct: number;
  seatTotals: { spots: number; daily: number; guests: number; matches: number };
  rentalTotal: number; roundingDrift: number; anyDiverged: boolean;
};

// Seat counts for the rows that fall in [start,end] — mirrors computePartnerStats.
function countSeats(rows: PartnerRegRow[]): { matches: number; spots: number; daily: number; guests: number } {
  const wrows = rows.filter((r) => !isFakePlayerEmail(r.email) && !r.match_canceled);
  const showed = wrows.filter((r) => !isCanceled(r));
  const spots = showed.filter((r) => r.user_type === "PLAYER").length + showed.filter((r) => r.user_type === "GUEST").length;
  const guests = showed.filter((r) => r.user_type === "GUEST").length;
  const byUserMatch = new Map<string, PartnerRegRow[]>();
  for (const r of showed) { const k = `${r.user_id}|${r.match_start}`; const a = byUserMatch.get(k) ?? []; a.push(r); byUserMatch.set(k, a); }
  const daily = [...byUserMatch.values()].filter((v) => v[0].payment_type === "DAILY PAID").length;
  const matches = new Set(wrows.map((r) => r.match_start)).size;
  return { matches, spots, daily, guests };
}
function rentalsIn(extra: PartnerExtraRevRow[], start: string, end: string): RentalLine[] {
  return extra.filter((e) => e.type === "Private Rental" && e.date >= start && e.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({ date: e.date, label: partnerLabelForType(e.type), amount: e.gross }));
}
const inPeriod = (rows: PartnerRegRow[], start: string, end: string) => rows.filter((r) => { const d = r.match_start.slice(0, 10); return d >= start && d <= end; });

const divergence = (pw: PartnerWeeklyPayment) => (pw.status === "paid" && pw.calculatedAmount != null && Math.abs(pw.owedAmount - pw.calculatedAmount) > 1);

function rowFromPeriod(pw: PartnerWeeklyPayment, pr: PeriodRow, rows: PartnerRegRow[], extra: PartnerExtraRevRow[], monthGrain: boolean): GrainRow {
  const [start, end] = monthGrain
    ? [monthStart(pw.weekStartDate), monthEnd(pw.weekStartDate)]
    : [pw.weekStartDate, pw.weekEndDate];
  const seats = pw.isPreSystem ? { matches: null, spots: null, daily: null, guests: null } : countSeats(inPeriod(rows, start, end));
  const diverged = divergence(pw);
  return {
    key: pw.weekStartDate, label: pr.label, isOpening: pw.isPreSystem, isOpen: pr.isOpen,
    matches: seats.matches, spots: seats.spots, daily: seats.daily, guests: seats.guests,
    revenue: pw.isPreSystem ? null : pr.qualifying,
    rentals: pw.isPreSystem ? [] : rentalsIn(extra, start, end),
    payment: pr.payment, paymentUnavailable: false,
    state: pr.state, paidOn: pr.paidOn,
    diverged, frozenPaid: diverged ? pw.calculatedAmount : null, livePayment: diverged ? pw.owedAmount : null,
  };
}

// Roll a set of weekly period-rows (one calendar month) into one month row.
function rollMonth(monthKey: string, weeks: { pw: PartnerWeeklyPayment; pr: PeriodRow }[], rows: PartnerRegRow[], extra: PartnerExtraRevRow[], label: string): GrainRow {
  const start = monthKey + "-01", end = monthEnd(start);
  const seats = countSeats(inPeriod(rows, start, end));
  const earning = weeks.filter((w) => (w.pr.matches ?? 0) > 0);
  const paid = earning.filter((w) => w.pr.state === "paid");
  const open = weeks.some((w) => w.pr.isOpen);
  const revenue = weeks.reduce((s, w) => s + (w.pr.qualifying ?? 0), 0);
  const payment = weeks.reduce((s, w) => s + Math.round(w.pr.payment ?? 0), 0); // sum-of-weeks (rounded per week)
  const diverged = weeks.some((w) => divergence(w.pw));
  let state: PeriodState;
  if (open) state = "open";
  else if (earning.length === 0) state = "nothing";
  else if (paid.length === earning.length) state = "paid";
  else if (weeks.some((w) => w.pr.state === "past_due")) state = "past_due";
  else state = "scheduled";
  const paidOn = paid.length ? paid[paid.length - 1].pr.paidOn : null;
  return {
    key: start, label, isOpening: false, isOpen: open,
    matches: seats.matches, spots: seats.spots, daily: seats.daily, guests: seats.guests,
    revenue, rentals: rentalsIn(extra, start, end),
    payment: open ? null : payment, paymentUnavailable: false,
    state, paidOn, diverged, frozenPaid: null, livePayment: null,
    weeksPaid: paid.length, weeksEarning: earning.length,
  };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;

function snapshotOf(rows: GrainRow[]): Snapshot {
  // latest COMPLETE period = newest non-opening, closed (not open) row
  const ordered = rows.filter((r) => !r.isOpening);
  const idx = ordered.findIndex((r) => !r.isOpen); // rows are newest-first
  if (idx < 0) return { row: null, prior: null };
  return { row: ordered[idx], prior: ordered[idx + 1] ?? null };
}

export function derivePartnerGrains(
  rows: PartnerRegRow[], extra: PartnerExtraRevRow[], payment: PartnerPaymentInfo, now: Date,
): PartnerGrains {
  const today = ymd(now);
  const cadence = payment.cadence;
  const periodRows: PeriodRow[] = payment.weeklyPayments.map((pw) => derivePeriodRow(pw, cadence, payment.revenueModel, today));
  const paired = payment.weeklyPayments.map((pw, i) => ({ pw, pr: periodRows[i] }));
  const opening = paired.filter((p) => p.pw.isPreSystem);
  const live = paired.filter((p) => !p.pw.isPreSystem);

  const openingRows = opening.map((p) => rowFromPeriod(p.pw, p.pr, rows, extra, false));

  // ── WEEK grain ──
  let weekRows: GrainRow[];
  if (cadence === "weekly") {
    weekRows = live.map((p) => rowFromPeriod(p.pw, p.pr, rows, extra, false));
  } else {
    // monthly partner: generate Sunday-weeks over the data span; money unavailable
    const dates = rows.map((r) => r.match_start.slice(0, 10)).filter(Boolean).sort();
    weekRows = [];
    if (dates.length) {
      let cur = ceilToSunday(payment.paymentStartDate ?? dates[0]);
      // back up to the first Sunday on/before the earliest match if needed
      while (cur > dates[0]) cur = addDays(cur, -7);
      for (; cur <= today; cur = addDays(cur, 7)) {
        const end = addDays(cur, 6);
        const seats = countSeats(inPeriod(rows, cur, end));
        if (seats.matches === 0 && rentalsIn(extra, cur, end).length === 0) continue; // omit empty weeks
        weekRows.push({
          key: cur, label: `Week of ${MON[+cur.slice(5, 7) - 1]} ${+cur.slice(8, 10)}`, isOpening: false, isOpen: end >= today,
          matches: seats.matches, spots: seats.spots, daily: seats.daily, guests: seats.guests,
          revenue: null, rentals: rentalsIn(extra, cur, end),
          payment: null, paymentUnavailable: true, state: "nothing", paidOn: null,
          diverged: false, frozenPaid: null, livePayment: null,
        });
      }
    }
  }
  const weekDisplay = [...weekRows, ...openingRows].sort((a, b) => b.key.localeCompare(a.key)); // newest first; opening (oldest) sorts last

  // ── MONTH grain ──
  let monthRows: GrainRow[];
  if (cadence === "monthly") {
    monthRows = live.map((p) => rowFromPeriod(p.pw, p.pr, rows, extra, true));
  } else {
    const byMonth = new Map<string, { pw: PartnerWeeklyPayment; pr: PeriodRow }[]>();
    for (const p of live) { const m = monthOf(p.pw.weekStartDate); (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(p); }
    monthRows = [...byMonth.entries()].map(([m, ws]) => rollMonth(m, ws, rows, extra, monthLabel(m)));
  }
  const monthDisplay = [...monthRows, ...openingRows].sort((a, b) => b.key.localeCompare(a.key));

  // reconciliation totals (seats across the WEEK grain — the atomic one)
  const seatSrc = cadence === "weekly" ? weekRows : weekRows; // both are per-week here
  const seatTotals = seatSrc.reduce((t, r) => ({ spots: t.spots + (r.spots ?? 0), daily: t.daily + (r.daily ?? 0), guests: t.guests + (r.guests ?? 0), matches: t.matches + (r.matches ?? 0) }), { spots: 0, daily: 0, guests: 0, matches: 0 });

  const rentalTotal = extra.filter((e) => e.type === "Private Rental").reduce((s, e) => s + e.gross, 0);
  const closedRevenue = live.filter((p) => !p.pr.isOpen).reduce((s, p) => s + (p.pr.qualifying ?? 0), 0);
  const owedSumRounded = live.filter((p) => !p.pr.isOpen).reduce((s, p) => s + Math.round(p.pr.payment ?? 0), 0);
  const roundOnce = Math.round(closedRevenue * payment.revenueSharePct / 100);
  const roundingDrift = payment.revenueModel === "flat_percentage" ? owedSumRounded - roundOnce : 0;
  const anyDiverged = paired.some((p) => divergence(p.pw));

  return {
    weekRows: weekDisplay, monthRows: monthDisplay,
    snapshotWeek: snapshotOf(weekDisplay), snapshotMonth: snapshotOf(monthDisplay),
    cadence, sharePct: payment.revenueSharePct, seatTotals, rentalTotal, roundingDrift, anyDiverged,
  };
}
