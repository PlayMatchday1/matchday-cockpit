// Pure presentation derivation for the partner dashboard's ONE table. Takes the
// PartnerWeeklyPayment periods that computeWeeklyPayments already produced (whose
// owedAmount / qualifyingRevenue math is NOT touched here) and derives the
// display state, due date, and cell values the mockup's nine-column table needs.
// No React, no fetching — the view, the admin index switcher, and the tests all
// read the same functions so the switcher total can never disagree with the row.

import type { PartnerPaymentCadence, PartnerRevenueModel, PartnerWeeklyPayment } from "./partnerStats";

// ── one money format for the whole page ──────────────────────────────────────
// The negative branch lives HERE, not at call sites: a caller that forgets
// prints "$-58"; the formatter is the only place that can guarantee none ever
// does. Rounded to whole dollars, grouped, minus sign is U+2212 not hyphen.
export function money(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US");
}
// Cents-aware variant — used only where BOTH exact figures must be named (the
// divergence tooltip). The whole-dollar money() is still what every row cell
// shows; a recompute of $27.50 must not read as "$28" when we're quoting it
// against the $13 that was paid.
export function moneyExact(n: number): string {
  const neg = n < 0;
  const v = Math.abs(n);
  const s = Number.isInteger(v)
    ? v.toLocaleString("en-US")
    : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? "−$" : "$") + s;
}
export function plural(n: number, one: string, many?: string): string {
  return `${n} ${Math.abs(n) === 1 ? one : many ?? one + "s"}`;
}

const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dfull(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${MONS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
export function dshort(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${MONS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function todayYmd(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
export const unitFor = (cadence: PartnerPaymentCadence) => (cadence === "weekly" ? "week" : "month");

// Monthly partners are paid on the 5th of the following month; weekly partners
// on the Friday after the week closes. Stated on the page, not assumed.
export function dueDateFor(pw: PartnerWeeklyPayment, cadence: PartnerPaymentCadence): string {
  if (cadence === "weekly") return addDaysYmd(pw.weekEndDate, 6); // Sat close → next Fri
  // monthly: 5th of the following month
  const d = new Date(`${pw.weekStartDate}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 5)).toISOString().slice(0, 10);
}

export function periodLabel(pw: PartnerWeeklyPayment, cadence: PartnerPaymentCadence): string {
  if (pw.isPreSystem) return `Through ${dfull(pw.weekStartDate)}`;
  if (cadence === "monthly") {
    const d = new Date(`${pw.weekStartDate}T00:00:00Z`);
    return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  return `Week of ${dshort(pw.weekStartDate)}`;
}

export type PeriodState = "open" | "paid" | "disputed" | "scheduled" | "past_due" | "nothing" | "presystem";

export type PeriodRow = {
  pw: PartnerWeeklyPayment;
  label: string;
  isOpen: boolean;
  state: PeriodState;
  // cell values (null → render em dash)
  matches: number | null;
  charged: number | null; // = qualifyingRevenue (refunds are not modeled)
  refunded: number | null; // always 0 → em dash; kept so charged−refunded=qualifying holds
  qualifying: number | null;
  managerPay: number; // per_match only; 0 for flat
  payment: number | null; // null for the open period (not yet calculated)
  dueDate: string;
  paidOn: string | null;
  shortfall: number; // manager pay − qualifying, when the floor fired (>0); else 0
};

// Derive every cell + the display state for one period.
export function derivePeriodRow(
  pw: PartnerWeeklyPayment,
  cadence: PartnerPaymentCadence,
  revenueModel: PartnerRevenueModel,
  today: string,
): PeriodRow {
  const paymentDisplay = pw.status === "paid" && pw.calculatedAmount != null ? pw.calculatedAmount : pw.owedAmount;
  const isOpen = !pw.isPreSystem && pw.status === "pending" && pw.weekEndDate >= today;
  const dueDate = dueDateFor(pw, cadence);
  let state: PeriodState;
  if (pw.isPreSystem) state = "presystem";
  else if (isOpen) state = "open";
  else if (pw.status === "disputed") state = "disputed";
  // A $0 payment is NEVER "Paid" on a date — a payment that never happened has
  // no date. Even a stale paid record on a $0 period reads as "Nothing owed".
  else if (Math.round(paymentDisplay) === 0) state = "nothing";
  else if (pw.status === "paid") state = "paid";
  else if (dueDate < today) state = "past_due";
  else state = "scheduled";

  const shortfall = revenueModel === "per_match_minus_manager" ? Math.max(0, pw.managerPay - pw.qualifyingRevenue) : 0;

  return {
    pw,
    label: periodLabel(pw, cadence),
    isOpen,
    state,
    matches: pw.isPreSystem ? null : pw.matches,
    charged: pw.isPreSystem ? null : pw.qualifyingRevenue,
    refunded: pw.isPreSystem ? null : 0,
    qualifying: pw.isPreSystem ? null : pw.qualifyingRevenue,
    managerPay: pw.managerPay,
    payment: isOpen ? null : paymentDisplay,
    dueDate,
    paidOn: pw.paidAt ? pw.paidAt.slice(0, 10) : null,
    shortfall,
  };
}

export function derivePeriodRows(payment: { weeklyPayments: PartnerWeeklyPayment[]; cadence: PartnerPaymentCadence; revenueModel: PartnerRevenueModel }, today: string): PeriodRow[] {
  return payment.weeklyPayments.map((pw) => derivePeriodRow(pw, payment.cadence, payment.revenueModel, today));
}

// ── the switcher amount — computed from THE SAME rows as the table ───────────
// owed = sum of Scheduled + Past-due periods (closed, unpaid, > $0). This is the
// number the switcher card shows AND what the harness reconciles against the
// table below it: one source, so they cannot disagree (the shipped index used a
// separate query and said "Pending 0" while the page showed unpaid periods).
export type PartnerOwed = { owed: number; periods: number; pastDue: number };
export function deriveOwed(rows: PeriodRow[]): PartnerOwed {
  const owing = rows.filter((r) => r.state === "scheduled" || r.state === "past_due");
  // Sum the ROUNDED per-row payments (what each table cell displays via money()),
  // so the switcher total equals the sum of the rows shown — round-of-sum would
  // drift a dollar from sum-of-rounds.
  return {
    owed: owing.reduce((s, r) => s + Math.round(r.payment ?? 0), 0),
    periods: owing.length,
    pastDue: owing.filter((r) => r.state === "past_due").length,
  };
}

// The switcher card's state line — a sentence, never a bare number.
export function stateLine(o: PartnerOwed): string {
  if (o.owed <= 0) return "Nothing owed";
  const base = `${money(o.owed)} owed across ${plural(o.periods, "period")}`;
  return o.pastDue > 0 ? `${base} · ${plural(o.pastDue, "payment")} past due` : base;
}

// The page header sentence across all partners — says nothing needs opening.
export function headerLine(owedByPartner: PartnerOwed[], partnerCount: number): string {
  const total = owedByPartner.reduce((s, o) => s + o.owed, 0);
  const n = owedByPartner.filter((o) => o.owed > 0).length;
  if (total <= 0) return `Every closed period is settled across all ${plural(partnerCount, "partner")}.`;
  return `${money(total)} is owed across ${plural(n, "partner")} — the amounts are on each partner below, so nothing needs opening.`;
}

// Totals-row payment: closed periods only (the open period has no figure yet).
export function closedPaymentTotal(rows: PeriodRow[]): number {
  return rows.filter((r) => !r.isOpen).reduce((s, r) => s + Math.round(r.payment ?? 0), 0);
}

// ── divergence + the admin "needs a look" count ──────────────────────────────
// A settled period whose live recompute (owedAmount) has moved away from the
// snapshot that was actually paid (calculatedAmount). > $1 so sub-dollar rounding
// noise never flags. The row still displays WHAT WAS PAID; this only decides
// whether to surface the coral pill / feed the badge.
export const DIVERGENCE_THRESHOLD = 1;
export function isDiverged(r: PeriodRow): boolean {
  return (
    (r.state === "paid" || r.state === "presystem") &&
    r.pw.calculatedAmount != null &&
    Math.abs(r.pw.owedAmount - r.pw.calculatedAmount) > DIVERGENCE_THRESHOLD
  );
}
// Names BOTH figures, exact — what was paid vs what recomputing today gives.
export function divergenceTooltip(r: PeriodRow): string {
  const paid = r.pw.calculatedAmount ?? 0;
  return `Paid ${moneyExact(paid)}. Recomputing today gives ${moneyExact(r.pw.owedAmount)} — the figures behind this period changed after it was paid.`;
}

// The sidebar badge counts ACTIONABLE items only, across all partners combined:
// unpaid-and-owed (awaiting), disputed, and paid-but-diverged. Disjoint buckets
// so the total never double-counts. When the total is zero the badge renders
// nothing at all (a badge that is always lit teaches the eye to ignore it).
export type ActionableCounts = { awaiting: number; disputed: number; diverged: number; total: number };
export function actionableCounts(rows: PeriodRow[]): ActionableCounts {
  const awaiting = rows.filter((r) => r.state === "scheduled" || r.state === "past_due").length;
  const disputed = rows.filter((r) => r.state === "disputed").length;
  const diverged = rows.filter(isDiverged).length;
  return { awaiting, disputed, diverged, total: awaiting + disputed + diverged };
}

// The panel's three buckets, all from the same rows: awaiting (every not-yet-paid
// closed period, incl. disputed), the settled payments newest-first (a paid or
// pre-system row — pre-system, being oldest, sorts last so it is the opening
// settlement at the bottom of the fold), split into the single latest + the rest.
export function partitionPayments(rows: PeriodRow[]): {
  awaiting: PeriodRow[];
  settled: PeriodRow[];
  latest: PeriodRow | null;
  older: PeriodRow[];
  foldTotal: number;
  flaggedInFold: number;
} {
  const sorted = [...rows].sort((a, b) => b.pw.weekStartDate.localeCompare(a.pw.weekStartDate));
  const awaiting = sorted.filter((r) => r.state === "scheduled" || r.state === "past_due" || r.state === "disputed");
  const settled = sorted.filter((r) => r.state === "paid" || r.state === "presystem");
  const latest = settled[0] ?? null;
  const older = settled.slice(1);
  const foldTotal = older.reduce((s, r) => s + Math.round(r.payment ?? 0), 0);
  const flaggedInFold = older.filter(isDiverged).length;
  return { awaiting, settled, latest, older, foldTotal, flaggedInFold };
}
