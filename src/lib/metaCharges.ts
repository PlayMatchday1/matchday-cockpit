// META AD CHARGES — when the card is actually charged, for OpEx (Ryan, 2026-10-03, option B;
// rebuilt on Meta's record 2026-10-07).
//
// WHAT THIS IS FOR. Meta does not charge the card once a month. It charges every time the unbilled
// balance reaches the account's billing threshold, and once a month on the bill date for whatever
// is left. OpEx is a CASH calendar, so it shows those charges on their days. The Cost report and
// the P&L keep showing SPEND: the monthly "Meta" rows in Expenses are untouched, and this file is
// read by OpEx only.
//
// WHERE THE CHARGES COME FROM: META'S RECORD, AND NOTHING WORKED OUT (Ryan, 2026-10-07).
//   · PAID charges are the rows of fin_meta_billing_charge (migration 0212): Meta's Payment
//     activity page for Jul 1 – Oct 7 (paid rows only; failed payments never; the $0.51 ad credit
//     is not a card charge), then whatever the daily sync reads from the activity log, keyed on
//     Meta's transaction_id. The old reproduction from daily spend is gone: the activity log missed
//     $4,965 of $14,375 paid since Jul 1, and the reproduction drifted from Meta's balance.
//   · THE PROJECTION starts from Meta's own unbilled balance (fin_meta_billing_balance, read by the
//     same sync) and adds META_DAILY_BUDGET a day: a charge of exactly the threshold each time the
//     balance reaches it, and the whole balance on the bill date.
//
// TWO RULES THAT KEEP PAID AND PROJECTED APART (scripts/opex-meta-billing-test.ts):
//   · A REAL CHARGE REPLACES THE PROJECTED ONE. The projection starts at the balance read, which
//     already reflects every charge Meta made before it; a saved charge AFTER that read (a balance
//     read that failed) is taken off the starting balance. So a charge is never paid AND projected.
//   · A PROJECTED CHARGE NEVER SITS IN THE PAST. One whose moment has passed with no charge saved
//     yet moves to now — today — and the projection carries on from there.
//
// INTEGER CENTS THROUGHOUT. Pure: no network, no Supabase. /api/finance/meta-cash supplies the
// inputs from the two tables.
//
// FROM AUGUST 2026 ONLY. OpEx places charges in months on or after META_CASH_FLOOR_YMD, the month
// the Meta rows in Expenses start; July and earlier keep the hand-entered ad rows they have.

import { META_EXPENSE_FLOOR_YMD } from "./metaAdSpend";
export const META_CASH_FLOOR_YMD = META_EXPENSE_FLOOR_YMD;

/* ── THE THRESHOLD ON FILE. Change it here. ─────────────────────────────────────────────────── */
export const META_BILLING_THRESHOLD_CENTS = 90_000;   // $900 (Meta's Payment settings, 2026-10-07)
/** The monthly bill date (day of month, UTC) and roughly when Meta runs it — logged May–Aug at
 *  07:02–09:08 UTC on the 6th. The ad account's time zone is America/Bogota. */
export const META_BILL_DAY = 6;
export const META_BILL_HOUR_UTC = 8;

/* ── THE DAILY BUDGET ON FILE. Change it here. ────────────────────────────────────────────────
 * What OpEx projects Meta to spend each day. `from` records when it took effect; every projected
 * day uses `cents`.
 * 2026-10-07 (Ryan): $175/day — the live ad sets: Atlanta iOS $30, Austin $25, Dallas $40,
 * Houston $30, OKC $15, San Antonio $20, St. Louis $15 (Atlanta Android off). Goes to $190 when
 * Fort Worth launches; Ryan will say when. */
export const META_DAILY_BUDGET = { cents: 17_500, from: "2026-10-07" } as const;
export type DailyBudget = { cents: number; from: string };

/** A paid charge (or, negative, a refund) from Meta's record. `at` is an ISO UTC instant. */
export type PaidCharge = { at: string; cents: number };
/** Meta's unbilled balance, as the sync read it. */
export type BalanceRead = { at: string; cents: number };

export type MetaCharge = {
  /** ISO UTC instant. */
  at: string;
  cents: number;
  /** "meta" = paid, in Meta's record; "auto" = projected. */
  source: "meta" | "auto";
  kind: "threshold" | "bill" | "paid";
};

export type MetaCashModel = {
  charges: MetaCharge[];
  thresholdCents: number;
  budget: DailyBudget;
  /** The balance read the projection starts from. */
  balance: BalanceRead;
  /** Saved charges after that read, taken off it (normally none). */
  afterReadCents: number;
};

const HOUR = 3_600_000;
const bogotaDay = (ms: number) => new Date(ms - 5 * HOUR).toISOString().slice(0, 10);

/** `cents` in `n` integer parts that add up to it exactly (the remainder on the first parts). */
function parts(cents: number, n: number): number[] {
  const base = Math.floor(cents / n), rest = cents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

export function metaCashFromRecord(input: {
  paid: readonly PaidCharge[];
  balance: BalanceRead;
  now: Date;
  horizonEndMs: number;
  budget?: DailyBudget;
  thresholdCents?: number;
}): MetaCashModel {
  const T = input.thresholdCents ?? META_BILLING_THRESHOLD_CENTS;
  const budget = input.budget ?? META_DAILY_BUDGET;
  const nowMs = input.now.getTime();
  const readMs = Date.parse(input.balance.at);

  const charges: MetaCharge[] = [...input.paid]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((c) => ({ at: c.at, cents: c.cents, source: "meta" as const, kind: "paid" as const }));

  // A charge saved after the balance was read is already out of that balance.
  const afterReadCents = input.paid.filter((c) => Date.parse(c.at) > readMs).reduce((s, c) => s + c.cents, 0);
  let balance = Math.max(0, input.balance.cents - afterReadCents);

  const perHour = parts(budget.cents, 24);
  const hourIdx = (h: number) => Math.floor((h - Date.parse(`${bogotaDay(h)}T05:00:00Z`)) / HOUR);
  const take = (h: number, cents: number, kind: MetaCharge["kind"]) => {
    if (cents <= 0) return;
    balance -= cents;
    // NEVER IN THE PAST: a charge whose moment has gone by with nothing saved moves to now.
    charges.push({ at: new Date(Math.max(h, nowMs)).toISOString(), cents, source: "auto", kind });
  };

  // From the hour after the read: the budget spread over each Bogota day's 24 hours.
  for (let h = Math.floor(readMs / HOUR) * HOUR + HOUR; h < input.horizonEndMs; h += HOUR) {
    balance += perHour[hourIdx(h)];
    const d = new Date(h);
    if (d.getUTCDate() === META_BILL_DAY && d.getUTCHours() === META_BILL_HOUR_UTC) take(h, balance, "bill");
    while (balance >= T) take(h, T, "threshold");
  }
  // A balance already over the threshold when it was read (a charge Meta has not made yet) is
  // caught on the first hour above, so it lands now, not at the read.

  return { charges, thresholdCents: T, budget, balance: input.balance, afterReadCents };
}

/** The calendar day (America/Chicago) a charge lands on, as YYYY-MM-DD. */
export function chicagoYmdOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
