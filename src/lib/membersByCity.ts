/* MEMBERS BY CITY — the model. Nothing here fetches and nothing here writes.
 *
 * ── A MONTH-END REPORT ────────────────────────────────────────────────────────────────────────
 * It answers one question: WHO PAYS on the 1st of next month — and marks, beside it, who is on
 * that charge for the last time. Everything below exists to keep those numbers honest.
 *
 *     Total active        status ACTIVE today, price > $0, internal addresses excluded
 *     Cancelled before    of those, canceled_at earlier than the cutoff
 *     Paying members      Total active − Cancelled before
 *     Billing             Σ each paying member's own price
 *     Cancelled cutoff+   of the PAYING members, canceled_at on or after the cutoff. A COUNT, not
 *                         dollars — they pay on the billing date and not on the one after it, and
 *                         the column's sub-label names both.
 *
 * IT IS A SUBTRACTION, AND THE BASE IS TODAY'S STATUS. A cancellation does not flip `status` to
 * CANCELED until it rolls off, so the cancelled cohorts sit INSIDE the active set rather than
 * beside it. A build that adds them to Total active instead of subtracting one of them
 * double-counts. The suite asserts the subset relation on every row for exactly that reason.
 *
 * ── WHAT THIS FILE USED TO GET WRONG, TWICE ───────────────────────────────────────────────────
 * 1. THE DATES WERE LITERAL STRINGS. `CUTOFF_YMD = "2026-08-06"` and `WINDOW_START_YMD =
 *    "2026-07-06"`, with a comment calling the rollover "a one-line change to each". Nobody made
 *    the change. On 2026-09-30 the page still named a window that had closed 55 days earlier, and
 *    the failure was silent in the worst way: every cancellation in that window had already rolled
 *    its status to CANCELED and left the active base, so the subtraction removed nobody and the
 *    page rendered Being charged 393 = Active with $23,187 beside it. A stale window does not look
 *    stale. It looks like a month with no churn. THERE ARE NO DATE CONSTANTS IN THIS FILE NOW.
 *
 * 2. IT ASKED A QUESTION THE DATA CANNOT ANSWER. The old shape was a CYCLE — a cutoff plus a
 *    month-long window — and it invited "what did last month look like?". It cannot be answered
 *    here: `status` is current, not as-of, so any past cutoff this page renders is understated by
 *    everyone who has rolled off since. The report is anchored to TODAY and only to today, there
 *    is no window and no picker, and the cutoff is calculated rather than chosen. See the
 *    reportDatesFor note.
 *
 * ── DOLLARS AND CENTS ─────────────────────────────────────────────────────────────────────────
 * `price` on mdapi_subscriptions is DOLLARS. `MemberLike.price_cents` is CENTS. Everything here
 * goes through memberLikeFromSubscription and works in CENTS; `price` is never read directly. A
 * caller that forgets the ×100 does not get a type error, it gets a plausible number.
 *
 * ── WHY THE DATES COMPARE AS TEXT ─────────────────────────────────────────────────────────────
 * `canceled_at` is TRUE UTC — proven on 1,556 dated rows: the column suffix is +00:00, raw.canceledAt
 * carries Z, the two never disagree on the instant, and the UTC hour histogram troughs across the
 * real Central night. The cutoff is a calendar date in that same UTC frame, so YYYY-MM-DD against
 * YYYY-MM-DD is the correct comparison and a Date would only add a re-shift.
 * THIS IS THE OPPOSITE MODEL FROM mdapi_matches.start_date, which carries a Z it does not mean.
 * Never share a date helper between this file and anything match-shaped.
 */

import { cityFromAbbr } from "./cityMap";
import { INTERNAL_EMAIL_RX, memberLikeFromSubscription } from "./membershipStats";
import { BUSINESS_TZ } from "./businessHours";

/* THE BILLING DAY. The 6th, as isChurning in membershipStats has always had it — but NOT imported
 * from there, deliberately. That file's `6` is one end of a rolling CHURN window anchored on the
 * calendar month; this one is the day a month-end report closes its books. They are the same
 * number today and they answer different questions, so binding them would mean a change to either
 * silently moving the other. The suite asserts they agree, which is the honest version of the
 * coupling: it catches a divergence without creating one. */
export const CUTOFF_DAY = 6;

/* THE THREE TIERS THE MIX NAMES, in CENTS, highest first. Eleven distinct non-$0 prices exist;
 * these three cover the overwhelming majority. Everything else — $500, $100, $50, $35, $30, $29,
 * $25, $15, $13, $1 — rolls into ONE "other" entry that carries its own headcount and its own
 * exact dollar sum, so the mix still totals to the cent. Never average, never headcount × nominal. */
export const MIX_TIERS_CENTS = [6600, 4900, 3000] as const;

/* THE UNASSIGNED SET EXISTS BECAUSE memberLikeFromSubscription RETURNS NULL FOR AN UNMAPPED CITY.
 * That null is a SKIP, and a skip is precisely how a new market vanishes from a dashboard without
 * anyone noticing — today it would be the single NYC member at $100/month, the largest price on
 * the board. Re-mapping an unmapped row through a placeholder code changes nothing about whether
 * it counts (the predicates below never read `.city`), and the person is then counted in the
 * UNASSIGNED tally where the page can say they exist.
 *
 * THEY ARE NOT IN THE CITY ROWS AND NOT IN THE MATCHDAY TOTAL. A member whose city we cannot name
 * cannot be allocated to one, and quietly folding them into the total would make the total
 * unreconcilable against the rows beneath it. The page states them on their own line instead. */
const CITY_PROBE = "ATX";

export type SubscriptionRow = {
  user_id?: number | string | null;
  status?: string | null;
  price?: number | null;
  member_email?: string | null;
  activation_date?: string | null;
  canceled_at?: string | null;
  city_identifier?: string | null;
};

export type MixEntry = {
  /** Cents for a named tier; "other" for the rolled-up remainder. */
  tier: number | "other";
  heads: number;
  cents: number;
};

/** The three dates the report is about, all derived from one instant. Never stored. */
export type ReportDates = {
  /** YYYY-MM-DD. The most recent CUTOFF_DAY on or before today, in BUSINESS_TZ. */
  cutoffYmd: string;
  /** YYYY-MM-DD. The 1st of the month AFTER the cutoff's month — the day Billing is charged. */
  billingYmd: string;
  /** YYYY-MM-DD. The 1st after that — the day the cutoff+ cohort is NO LONGER billed. It appears
   *  only in the last column's sub-label ("pay Oct 1, not Nov 1"); no column is computed from it. */
  runRateYmd: string;
};

export type ByCityRow = {
  /** city_identifier, verbatim — the grouping key. "TOTAL" on the total row. */
  code: string;
  /** Friendly name from cityFromAbbr. Null only on the total row. */
  city: string | null;
  /** status ACTIVE today, non-$0, external. */
  totalActive: number;
  /** SUBSET of totalActive: canceled_at earlier than the cutoff. */
  cancelledBefore: number;
  /** totalActive − cancelledBefore. */
  paying: number;
  /** Sum over the mix. Equals Σ heads × price, exactly, with `other` included. */
  billingCents: number;
  /** SUBSET of paying: canceled_at on or after the cutoff. Charged once more, then gone.
   *  A COUNT ONLY. Their dollars are deliberately not carried: the report's one money figure is
   *  Billing, and a second one beside it invites the two to be read as a difference. */
  cancelledAfter: number;
  /** Always four entries, in MIX_TIERS_CENTS order then "other". Heads sum to `paying`. */
  mix: MixEntry[];
};

export type MembersByCityTable = {
  /** The cities, ordered by Billing, high to low. No empty Unassigned row. */
  rows: ByCityRow[];
  /** The cities summed. EXCLUDES unassigned members — see the CITY_PROBE note. */
  total: ByCityRow;
  /** Stated on its own line, never folded into `total`. Zero members means the line is hidden. */
  unassigned: { members: number; cents: number };
  /** People considered — active, non-$0, external, collapsed one per user_id, cities + unassigned. */
  people: number;
  /** How many rows the page pulled, and whether the pull was complete. */
  rowsPulled: number;
};

const ymd = (s: string | null | undefined): string => String(s ?? "").slice(0, 10);

/** Today in the business zone. A UTC `now` at 02:00Z is still yesterday in Chicago. */
const businessYmd = (now: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ }).format(now);

/** `y-m-d` from parts, normalised through UTC midnight so month overflow rolls the year. */
const dateFrom = (year: number, monthIdx: number, day: number): string =>
  new Date(Date.UTC(year, monthIdx, day)).toISOString().slice(0, 10);

/**
 * THE REPORT'S THREE DATES, FROM AN INSTANT. Calculated on every render; stored nowhere.
 *
 * The cutoff is the most recent CUTOFF_DAY ON OR BEFORE today in BUSINESS_TZ — the books that have
 * already closed, not the ones that are still open. Billing is the 1st of the month after the
 * cutoff's month, and the run rate is the 1st after that.
 *
 *   2026-09-30 -> cutoff 2026-09-06, bills 2026-10-01, run rate 2026-11-01
 *   2026-10-05 -> cutoff 2026-09-06   (the 6th has not come round again)
 *   2026-10-06 -> cutoff 2026-10-06, bills 2026-11-01, run rate 2026-12-01
 *   2026-12-10 -> cutoff 2026-12-06, bills 2027-01-01, run rate 2027-02-01
 *
 * ON OR BEFORE, NOT STRICTLY BEFORE: on the 6th itself that day's cutoff is the current one.
 *
 * THERE IS NO PICKER AND NO WAY TO PASS A DIFFERENT DATE IN. The base of every column is status
 * ACTIVE TODAY, which is not an as-of quantity — a cancellation that has since rolled off is gone
 * from it entirely. Handing this function an earlier cutoff would render a confident, wrong,
 * understated month. The only honest cutoff is the one derived from now.
 */
export function reportDatesFor(now: Date): ReportDates {
  const [y, m, d] = businessYmd(now).split("-").map(Number);
  // m is 1-based, so m-1 is this month's index and m-2 is last month's.
  const cutoffYmd = dateFrom(y, d >= CUTOFF_DAY ? m - 1 : m - 2, CUTOFF_DAY);
  const [cy, cm] = cutoffYmd.split("-").map(Number);
  return {
    cutoffYmd,
    billingYmd: dateFrom(cy, cm, 1),
    runRateYmd: dateFrom(cy, cm + 1, 1),
  };
}

/** Cancelled before the cutoff — out of the paying set entirely. */
export const isCancelledBefore = (canceledAt: string | null | undefined, cutoffYmd: string): boolean => {
  const d = ymd(canceledAt);
  return d !== "" && d < cutoffYmd;
};

/** Cancelled on or after the cutoff — pays once more, then drops off. */
export const isCancelledOnOrAfter = (canceledAt: string | null | undefined, cutoffYmd: string): boolean => {
  const d = ymd(canceledAt);
  return d !== "" && d >= cutoffYmd;
};

type Person = { userId: string; code: string; mapped: boolean; priceCents: number; canceledAt: string | null };

/* THE BASE, AND EVERY EXCLUSION IT APPLIES, IN ONE PLACE:
 *   price > $0            a $0 membership bills nothing and is not a paying member
 *   status ACTIVE today   the report is about who is on the next charge, which is a live question.
 *                         THIS IS ALSO WHY THE 683 CANCELED-WITH-NO-canceled_at ROWS ARE ABSENT:
 *                         they are not ACTIVE, so they never enter. That data problem is left
 *                         alone deliberately — it is not this page's to fix.
 *   external email        @matchday. / @playmatchday. accounts are staff, not revenue. Two today.
 *
 * NOT isActiveAsOf. That helper is shared with the Membership page and the snapshot cron and takes
 * an `asOf` it cannot honour (it tests the CURRENT status), so calling it here would import a
 * promise this page would then appear to make. The predicate is three lines and it is written out.
 *
 * THE COLLAPSE: one row per user_id. Hundreds of people hold more than one non-$0 row and many
 * hold a live membership beside a dead one, so counting rows double-counts them. Measured
 * 2026-09-30, all 395 active rows resolve to 395 distinct users, so the highest-price tie-break
 * never fires today — it is here because "never fires today" is not a guarantee, and a silent
 * second row would land in billing as a second charge. */
function collapseToPeople(rows: readonly SubscriptionRow[]): Person[] {
  const byUser = new Map<string, Person>();
  for (const r of rows) {
    if (String(r.status ?? "") !== "ACTIVE") continue;
    const code = String(r.city_identifier ?? "").trim();
    const mapped = cityFromAbbr(code) != null;
    const m =
      memberLikeFromSubscription(r) ??
      memberLikeFromSubscription({ ...r, city_identifier: CITY_PROBE });
    if (!m) continue;
    if (m.price_cents <= 0) continue;
    if (m.email && INTERNAL_EMAIL_RX.test(m.email)) continue;
    const userId = String(r.user_id ?? `membership:${r.activation_date}:${m.price_cents}`);
    const prev = byUser.get(userId);
    if (prev && prev.priceCents >= m.price_cents) continue;
    byUser.set(userId, { userId, code, mapped, priceCents: m.price_cents, canceledAt: m.canceled_at });
  }
  return [...byUser.values()];
}

/* THE MIX IS BUILT FROM THE PAYING SET, not from the active set, so heads sum to Paying members and
 * the dollars are what is actually about to be billed. Exact by construction: every person lands in
 * exactly one entry and contributes their own price, so no rounding step exists to drift and no
 * tail can be dropped. */
function buildMix(people: readonly Person[]): { mix: MixEntry[]; billingCents: number } {
  const mix: MixEntry[] = MIX_TIERS_CENTS.map((tier) => ({ tier, heads: 0, cents: 0 }));
  const other: MixEntry = { tier: "other", heads: 0, cents: 0 };
  for (const p of people) {
    const slot = mix.find((e) => e.tier === p.priceCents) ?? other;
    slot.heads += 1;
    slot.cents += p.priceCents;
  }
  const all = [...mix, other];
  return { mix: all, billingCents: all.reduce((s, e) => s + e.cents, 0) };
}

function makeRow(code: string, people: readonly Person[], cutoffYmd: string): ByCityRow {
  const paying = people.filter((p) => !isCancelledBefore(p.canceledAt, cutoffYmd));
  const { mix, billingCents } = buildMix(paying);
  return {
    code,
    city: code === "TOTAL" ? null : cityFromAbbr(code),
    totalActive: people.length,
    cancelledBefore: people.filter((p) => isCancelledBefore(p.canceledAt, cutoffYmd)).length,
    paying: paying.length,
    billingCents,
    cancelledAfter: paying.filter((p) => isCancelledOnOrAfter(p.canceledAt, cutoffYmd)).length,
    mix,
  };
}

export function buildMembersByCity(
  rows: readonly SubscriptionRow[],
  dates: ReportDates,
): MembersByCityTable {
  const people = collapseToPeople(rows);
  const cities = people.filter((p) => p.mapped);
  const unmapped = people.filter((p) => !p.mapped);

  const byCode = new Map<string, Person[]>();
  for (const p of cities) byCode.set(p.code, [...(byCode.get(p.code) ?? []), p]);

  const out = [...byCode.entries()]
    .map(([code, ps]) => makeRow(code, ps, dates.cutoffYmd))
    // BY BILLING, HIGH TO LOW — the column the report is for. Code breaks a tie, so the order is
    // total rather than dependent on Map insertion.
    .sort((a, b) => b.billingCents - a.billingCents || a.code.localeCompare(b.code));

  /* UNASSIGNED MEMBERS ARE COUNTED ON THE PAYING BASIS, the same basis as the Billing column they
   * are being excluded from — otherwise the line under the table would be measuring something
   * different from the total it is qualifying. */
  const unassignedPaying = unmapped.filter((p) => !isCancelledBefore(p.canceledAt, dates.cutoffYmd));

  return {
    rows: out,
    total: { ...makeRow("TOTAL", cities, dates.cutoffYmd), city: null },
    unassigned: {
      members: unassignedPaying.length,
      cents: unassignedPaying.reduce((s, p) => s + p.priceCents, 0),
    },
    people: people.length,
    rowsPulled: rows.length,
  };
}

/* ── FORMATTERS, shared by the table and the CSV so the two cannot disagree ─────────────────── */

export const dollars = (cents: number): string =>
  "$" + Math.round(cents / 100).toLocaleString("en-US");

export const tierLabel = (t: number | "other"): string =>
  t === "other" ? "other" : `$${t / 100}`;

/** "78 × $66 · 7 × $49 · 19 × $30 · 6 × other ($68)" — empty tiers are dropped, never shown as 0. */
export const mixLabel = (mix: readonly MixEntry[]): string =>
  mix
    .filter((e) => e.heads > 0)
    .map((e) =>
      e.tier === "other"
        ? `${e.heads} × other (${dollars(e.cents)})`
        : `${e.heads} × ${tierLabel(e.tier)}`,
    )
    .join(" · ");

/* NOON UTC IN BOTH, so no zone can shift the day off the date it names. The bar carries the year
 * and the column labels do not — a header reading "Cancelled before Sep 6, 2026" twice over six
 * columns is noise, and the year is stated once, above, where it belongs. */

/** "Sep 6, 2026" from a YYYY-MM-DD. For the bar. */
export const prettyDate = (ymdStr: string): string =>
  new Date(`${ymdStr}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });

/** "Sep 6" from a YYYY-MM-DD. For the column labels. */
export const prettyDateShort = (ymdStr: string): string =>
  new Date(`${ymdStr}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  });

/* ── CSV — the same numbers, the same rows and the same dates as the screen, with the mix EXPANDED
 * one column per tier so the file opens as arithmetic rather than as a string somebody has to
 * re-parse. The unassigned line rides along as a trailing comment, excluded from the TOTAL exactly
 * as it is on the page. ─────────────────────────────────────────────────────────────────────── */
export function membersByCityCsv(
  t: MembersByCityTable, asOfLabel: string, dates: ReportDates,
): string {
  const head = [
    "City", "Code", "Total active",
    `Cancelled before ${dates.cutoffYmd}`,
    "Paying members",
    `Billing ${dates.billingYmd}`,
    `Cancelled ${dates.cutoffYmd}+`,
    ...MIX_TIERS_CENTS.map((c) => `Heads ${tierLabel(c)}`),
    "Heads other", "Other dollars",
  ];
  const cell = (s: string | number) => {
    const v = String(s);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const line = (r: ByCityRow, label: string) => [
    label, r.code, r.totalActive, r.cancelledBefore, r.paying,
    (r.billingCents / 100).toFixed(2),
    r.cancelledAfter,
    ...MIX_TIERS_CENTS.map((c) => r.mix.find((e) => e.tier === c)?.heads ?? 0),
    r.mix.find((e) => e.tier === "other")?.heads ?? 0,
    ((r.mix.find((e) => e.tier === "other")?.cents ?? 0) / 100).toFixed(2),
  ].map(cell).join(",");

  return [
    `# Members by City — as of ${asOfLabel}. Cutoff ${dates.cutoffYmd}, bills ${dates.billingYmd}.`
      + ` The cutoff+ column pays ${dates.billingYmd} and not ${dates.runRateYmd}.`
      + ` Excludes $0 members and internal accounts.`,
    head.map(cell).join(","),
    ...t.rows.map((r) => line(r, r.city ?? r.code)),
    line(t.total, "TOTAL"),
    ...(t.unassigned.members > 0
      ? [`# Not in totals: ${t.unassigned.members} unassigned member${t.unassigned.members === 1 ? "" : "s"}, ${dollars(t.unassigned.cents)}.`]
      : []),
  ].join("\n");
}
