// META AD CHARGES — when the card is actually charged, for OpEx (Ryan, 2026-10-03, option B).
//
// WHAT THIS IS FOR. Meta does not charge the card once a month. It charges every time the unbilled
// balance reaches the account's billing threshold, and once a month on the bill date for whatever
// is left. OpEx is a CASH calendar, so it shows those charges on their days. The Cost report and
// the P&L keep showing SPEND: the monthly "Meta" rows in Expenses are untouched, and this file is
// read by OpEx only.
//
// WHERE THE CHARGES COME FROM (probed 2026-10-03, act_1613092135872657):
//   · Meta's account activity log records "Account billed" (ad_account_billing_charge) with the
//     exact amount and time — but INCOMPLETELY: since May it held $12,622.31 of charges against
//     $17,521.47 of spend while the account owed only $249.51, so some charges are not in it.
//   · So the charges are REPRODUCED from daily spend: the balance grows hour by hour (each Bogota
//     day's spend spread evenly over its 24 hours — Meta buckets days in America/Bogota, UTC−5),
//     a charge of exactly the threshold is taken whenever it reaches the threshold, and on the bill
//     date the whole remaining balance is taken. A charge Meta DID log replaces the reproduced one
//     (its real time and amount). Reproduced from the Sep 9 charge, this put September's four
//     logged charges within about four hours of their real times.
//
// INTEGER CENTS THROUGHOUT, so charges + unbilled balance = spend, exactly
// (scripts/opex-meta-charges-test.ts).
//
// Pure: no network, no Supabase. The route /api/finance/meta-cash supplies the inputs.
//
// FROM AUGUST 2026 ONLY. OpEx places charges in months on or after META_EXPENSE_FLOOR_YMD, the
// month the Meta rows in Expenses start; July and earlier keep the hand-entered ad rows they have.
// The reproduction starts at the first logged bill-date charge on or after that floor (Aug 6,
// $613.00), so nothing before it can colour what is shown.

import { META_EXPENSE_FLOOR_YMD } from "./metaAdSpend";
export const META_CASH_FLOOR_YMD = META_EXPENSE_FLOOR_YMD;

/* ── THE THRESHOLD ON FILE. Change it here. ─────────────────────────────────────────────────── */
export const META_BILLING_THRESHOLD_CENTS = 90_000;   // $900
/** The monthly bill date (day of month, UTC) and roughly when Meta runs it — logged May–Aug at
 *  07:02–09:08 UTC on the 6th. */
export const META_BILL_DAY = 6;
export const META_BILL_HOUR_UTC = 8;

export type LoggedCharge = { at: string; cents: number };          // ISO UTC instant
export type DailySpend = { date: string; cents: number };         // a Bogota day, YYYY-MM-DD

export type MetaCharge = {
  /** ISO UTC instant. */
  at: string;
  cents: number;
  /** "meta" = in Meta's record; "spend" = worked out from spend (past); "auto" = projected. */
  source: "meta" | "spend" | "auto";
  kind: "threshold" | "bill";
};

export type MetaCashModel = {
  charges: MetaCharge[];
  threshold: { stored: number; inUse: number; changed: boolean };
  /** Where the reproduction starts: a bill-date charge, after which the balance is zero. */
  anchor: { at: string; cents: number } | null;
  spendToDateCents: number;
  chargedToDateCents: number;
  unbilledCents: number;
  /** The projection's daily spend: the mean of the last 28 complete days. */
  dailyAvgCents: number;
  avgFrom: string | null;
  avgTo: string | null;
};

const HOUR = 3_600_000;
const bogotaDay = (ms: number) => new Date(ms - 5 * HOUR).toISOString().slice(0, 10);
const dayStartUtcMs = (bogotaYmd: string) => Date.parse(`${bogotaYmd}T05:00:00Z`);

/** `cents` in `n` integer parts that add up to it exactly (the remainder on the first parts). */
function parts(cents: number, n: number): number[] {
  const base = Math.floor(cents / n), rest = cents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

/** The threshold in use: the stored one, unless Meta's last two logged charges agree on another. */
export function thresholdInUse(logged: readonly LoggedCharge[], stored = META_BILLING_THRESHOLD_CENTS): { stored: number; inUse: number; changed: boolean } {
  const s = [...logged].sort((a, b) => a.at.localeCompare(b.at));
  const [a, b] = s.slice(-2);
  if (a && b && a.cents === b.cents && a.cents !== stored) return { stored, inUse: a.cents, changed: true };
  return { stored, inUse: stored, changed: false };
}

/**
 * Reproduce the card charges from `anchor` (or the first day of spend) through `horizonEndMs`.
 * Hours before `now` use the real daily spend (today's partial figure spread over the hours that
 * have run); hours after use the 28-day average. Charges before `now` are "meta" or "spend";
 * charges after are "auto".
 */
export function buildMetaCash(input: {
  daily: readonly DailySpend[];
  logged: readonly LoggedCharge[];
  now: Date;
  horizonEndMs: number;
  stored?: number;
}): MetaCashModel {
  const nowMs = input.now.getTime();
  const threshold = thresholdInUse(input.logged, input.stored);
  const T = threshold.inUse;
  const logged = [...input.logged].sort((a, b) => a.at.localeCompare(b.at));
  const daily = new Map(input.daily.map((d) => [d.date, d.cents]));
  const today = bogotaDay(nowMs);

  // ── the 28-day average, over complete days before today
  const complete = [...daily.keys()].filter((d) => d < today).sort().slice(-28);
  const dailyAvgCents = complete.length ? Math.round(complete.reduce((s, d) => s + (daily.get(d) ?? 0), 0) / complete.length) : 0;

  /* THE THRESHOLD AS OF A MOMENT: Ryan's rule applied at that moment — the stored value, unless the
   * last two charges Meta logged BEFORE it agree on another amount. So August reproduces at the
   * $691 it was then, and September on at $900, from the same rule that flags a change today. */
  const thresholdAt = (ms: number) => thresholdInUse(logged.filter((c) => Date.parse(c.at) < ms), input.stored).inUse;
  const isBillWindow = (iso: string) => { const d = Number(iso.slice(8, 10)); return d >= META_BILL_DAY && d <= META_BILL_DAY + 3; };
  const isBillCharge = (c: LoggedCharge) => isBillWindow(c.at) && c.cents !== thresholdAt(Date.parse(c.at));

  // ── the anchor: the EARLIEST logged bill-date charge on or after the floor (day 6–9, not a
  // threshold amount). The balance is zero just after it, and every month from there is reproduced — so a
  // month earlier than the latest bill date still shows its charges. Without one, start at the
  // first day of spend from zero.
  const anchorCharge = logged.find((c) => c.at.slice(0, 10) >= META_CASH_FLOOR_YMD && Date.parse(c.at) < nowMs && isBillCharge(c)) ?? null;
  const firstDay = [...daily.keys()].sort()[0];
  if (!anchorCharge && !firstDay) {
    return { charges: [], threshold, anchor: null, spendToDateCents: 0, chargedToDateCents: 0, unbilledCents: 0, dailyAvgCents, avgFrom: null, avgTo: null };
  }
  const startMs = anchorCharge ? Math.floor(Date.parse(anchorCharge.at) / HOUR) * HOUR + HOUR : dayStartUtcMs(firstDay!);

  // ── spend per hour, integer cents
  const hourCache = new Map<string, number[]>();
  const elapsedToday = Math.max(1, Math.floor((nowMs - dayStartUtcMs(today)) / HOUR));
  const hourSpend = (h: number): number => {
    const day = bogotaDay(h);
    const idx = Math.floor((h - dayStartUtcMs(day)) / HOUR);
    if (h >= nowMs) {
      if (!hourCache.has(`avg:${day}`)) hourCache.set(`avg:${day}`, parts(dailyAvgCents, 24));
      return hourCache.get(`avg:${day}`)![idx];
    }
    if (day === today) {
      if (!hourCache.has(day)) hourCache.set(day, parts(daily.get(day) ?? 0, elapsedToday));
      return idx < elapsedToday ? hourCache.get(day)![idx] : 0;
    }
    if (!hourCache.has(day)) hourCache.set(day, parts(daily.get(day) ?? 0, 24));
    return hourCache.get(day)![idx];
  };

  const charges: MetaCharge[] = [];
  let balance = 0, spendToDate = 0, chargedToDate = 0, li = 0;
  // THE RUNNING BALANCE AT `now`, read off the simulation — not derived as spend − charges, so
  // "charges + unbilled = spend" is a real check on the bookkeeping, not an identity.
  let balanceAtNow: number | null = null;
  while (li < logged.length && Date.parse(logged[li].at) < startMs) li++;    // the anchor and earlier
  const sourceAt = (h: number): "spend" | "auto" => (h < nowMs ? "spend" : "auto");
  const take = (h: number, cents: number, source: MetaCharge["source"], kind: MetaCharge["kind"], at?: string) => {
    if (cents <= 0) return;
    balance -= cents;
    charges.push({ at: at ?? new Date(h).toISOString(), cents, source, kind });
    if ((at ? Date.parse(at) : h) < nowMs) chargedToDate += cents;
  };
  // THE ANCHOR CHARGE ITSELF is real money that left: on the calendar, but not in the balance
  // bookkeeping (the reproduction starts with the balance it cleared).
  if (anchorCharge) charges.push({ at: anchorCharge.at, cents: anchorCharge.cents, source: "meta", kind: "bill" });

  /* ── CLOSED SEGMENTS: between two LOGGED bill-date charges ────────────────────────────────────
   * A bill-date charge clears the balance, so between two logged ones the cash is KNOWN exactly:
   * the spend in between. Whatever Meta's log does not show (its record is incomplete, and has
   * returned different charges for the same window on two reads) is the gap
   *     missing = spend − the logged threshold charges in between − the closing bill charge,
   * reproduced as threshold-size charges at the hours the balance crosses the threshold, the last
   * one taking what is left. So a segment always closes at zero and every logged charge keeps its
   * real time and amount. After the LAST logged bill-date charge the segment is open: the plain
   * reproduction below, which matched September's logged charges within hours. */
  const hourOf = (iso: string) => Math.floor(Date.parse(iso) / HOUR) * HOUR;
  const billsAfter = logged.filter((c) => Date.parse(c.at) >= startMs && Date.parse(c.at) < nowMs && c.at.slice(0, 10) >= META_CASH_FLOOR_YMD && isBillCharge(c));
  let segEnd: LoggedCharge | null = billsAfter[0] ?? null;
  let missing = 0;
  const openSegment = (from: number) => {
    if (!segEnd) return;
    let spend = 0;
    for (let x = from; x <= hourOf(segEnd.at); x += HOUR) spend += hourSpend(x);
    const inner = logged.filter((c) => Date.parse(c.at) >= from && Date.parse(c.at) < Date.parse(segEnd!.at)).reduce((s2, c) => s2 + c.cents, 0);
    missing = Math.max(0, spend - inner - segEnd.cents);
  };
  openSegment(startMs);

  for (let h = startMs; h < input.horizonEndMs; h += HOUR) {
    if (balanceAtNow === null && h >= nowMs) balanceAtNow = balance;
    const T = thresholdAt(Math.min(h, nowMs));
    const s = hourSpend(h);
    balance += s;
    if (h < nowMs) spendToDate += s;
    const closingHere = segEnd && hourOf(segEnd.at) === h;

    if (segEnd) {
      // CLOSED SEGMENT: reproduce only the missing cash, at threshold crossings.
      while (missing > 0 && balance >= T && !closingHere) { const c = Math.min(T, missing); missing -= c; take(h, c, "spend", "threshold"); }
      if (closingHere && missing > 0) { take(h - HOUR, missing, "spend", "threshold"); missing = 0; }
    }

    // Meta's own record: a logged charge in this hour is applied at its real time and amount.
    while (li < logged.length && Date.parse(logged[li].at) < h + HOUR) {
      const c = logged[li++];
      take(h, c.cents, "meta", isBillCharge(c) ? "bill" : "threshold", c.at);
    }
    if (closingHere) {
      // The next closed segment starts after this bill-date charge.
      segEnd = billsAfter.find((c) => Date.parse(c.at) >= h + HOUR) ?? null;
      openSegment(h + HOUR);
      continue;
    }
    if (segEnd) continue;

    // ── OPEN SEGMENT (after the last logged bill-date charge): the plain reproduction.
    // The monthly bill date: the whole balance — unless Meta logged a bill charge in the window.
    const d = new Date(h);
    if (d.getUTCDate() === META_BILL_DAY && d.getUTCHours() === META_BILL_HOUR_UTC) {
      const win0 = h - META_BILL_HOUR_UTC * HOUR, win1 = win0 + 4 * 24 * HOUR;
      const loggedBill = logged.some((c) => { const t = Date.parse(c.at); return t >= win0 && t < win1 && isBillCharge(c); });
      if (!loggedBill && balance > 0) take(h, balance, sourceAt(h), "bill");
    }
    // The threshold: a charge of exactly T — unless Meta logged one within the next day (Meta's
    // own charge lands a few hours after the crossing, and is then applied above).
    while (balance >= T) {
      const soon = logged.some((c) => { const t = Date.parse(c.at); return t >= h && t < h + 24 * HOUR; });
      if (soon && h < nowMs) break;
      take(h, T, sourceAt(h), "threshold");
    }
  }

  return {
    charges,
    threshold,
    anchor: anchorCharge,
    spendToDateCents: spendToDate,
    chargedToDateCents: chargedToDate,
    unbilledCents: balanceAtNow ?? balance,
    dailyAvgCents,
    avgFrom: complete[0] ?? null,
    avgTo: complete[complete.length - 1] ?? null,
  };
}

/** The calendar day (America/Chicago) a charge lands on, as YYYY-MM-DD. */
export function chicagoYmdOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
