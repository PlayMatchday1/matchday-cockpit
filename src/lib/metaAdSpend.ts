// Meta ad spend — the PURE model. No network, no clock, no Supabase.
//
// Everything that decides where money lands lives here so it can be asserted without a token and
// without a live account. The sync route is the only part that talks to Meta, and it is deliberately
// thin: fetch, hand the rows to these functions, write what they return.
//
// ── THE CREDENTIAL, stated here because this is the file people read first ─────────────────────
// META_ADS_ACCESS_TOKEN is a Business Manager SYSTEM USER token, ads_read only, View-performance on
// the ad account and nothing else. It is NOT META_ACCESS_TOKEN — that one is scoped for WhatsApp
// Business messaging and must never be used for ads.
//
// It is sent as an Authorization: Bearer header, NEVER as an access_token query parameter, so it
// cannot end up inside a logged URL. Nothing in this codebase may echo, print, log or interpolate
// it, including into error messages and thrown exceptions — see redactMetaError below, which exists
// because the obvious `throw new Error(url)` is exactly how a token escapes.
//
// GET ONLY. There is no POST or DELETE path to Meta anywhere in this integration.

/** Graph API version. The console moved to v25; v21 is what whatsapp.ts uses for a different API. */
export const META_GRAPH_VERSION = "v25.0";

/* ── TWO FLOORS, AND THEY ARE NOT THE SAME NUMBER ───────────────────────────────────────────────
 *
 * They were one constant until the historical reconciliation, and collapsing them again is the
 * thing that must not happen. They exist for DIFFERENT reasons:
 *
 * META_EXPENSE_FLOOR_YMD (2026-08-01) — the fin_expenses ownership cutover. It is NOT arbitrary and
 * it is NOT merely about double-counting the Apr–Jul hand rows. fin_expenses HAS NO ROWS OF ANY
 * KIND BEFORE 2026-04-30: no venue cost, no manager pay, no salaries. Putting ad spend into
 * Dec–Mar would render five months of P&L that show marketing cost against nothing else — a
 * statement that reads as complete and is not. That is a worse failure than a missing number,
 * because a missing number looks missing. DO NOT LOWER THIS until those months carry their other
 * costs; meta-expense-floor-test.ts fails loudly if anyone tries.
 *
 * META_DAILY_FLOOR_YMD (2025-12-01) — the fin_meta_ad_spend_daily floor. That table only ever
 * claims to be ad spend, so it has no such problem, and the daily series is what answers questions
 * about campaign effect. It starts at December because Meta's comscore_market breakdown DOES NOT
 * EXIST before 2025-11 (probed: zero rows, with Dec as the positive control) and November is only
 * 91.3% covered — $1,992.14 of $2,181.24 — with no way to say which city lost the rest. */
export const META_EXPENSE_FLOOR_YMD = "2026-08-01";
export const META_DAILY_FLOOR_YMD = "2025-12-01";

/** @deprecated Ambiguous now that the two floors differ. Kept pointing at the EXPENSE floor so any
 *  unmigrated caller keeps the stricter of the two rather than silently widening. */
export const META_FLOOR_YMD = META_EXPENSE_FLOOR_YMD;

/** Trailing window re-pulled every run: Meta revises recent days, and an upsert makes it free. */
export const META_WINDOW_DAYS = 28;

/* ── MARKET MAPPING ─────────────────────────────────────────────────────────────────────────────
 * Comscore market names, exactly as Meta returns them, onto our city codes. Seven rows, hardcoded
 * deliberately: an admin page for seven values that do not churn is a maintenance burden with no
 * payoff, and campaign-name parsing breaks the moment somebody renames a campaign.
 *
 * MATCHED ON THE EXACT STRING. No trimming into a fuzzy match, no case folding beyond an exact
 * lookup — if Meta renames "Dallas-Ft. Worth, TX", the row must become UNMAPPED and visible, not
 * quietly attach itself to the nearest-looking city. */
export const META_MARKET_TO_CITY: Readonly<Record<string, string>> = Object.freeze({
  "Atlanta, GA": "ATL",
  "Austin, TX": "ATX",
  "Dallas-Ft. Worth, TX": "DFW",
  "Houston, TX": "HTX",
  "Oklahoma City, OK": "OKC",
  "San Antonio, TX": "SATX",
  "St. Louis, MO": "STL",
});

/** The city code for a Meta market, or null when we do not recognise it. Null is never a drop. */
export function cityForMarket(marketRaw: string): string | null {
  return Object.prototype.hasOwnProperty.call(META_MARKET_TO_CITY, marketRaw)
    ? META_MARKET_TO_CITY[marketRaw]
    : null;
}

/* ── MONEY ──────────────────────────────────────────────────────────────────────────────────────
 * Meta returns spend as a DECIMAL STRING — "240.83", sometimes "0", occasionally "1.5". Parsing it
 * with Number() and multiplying by 100 is where a payout ledger acquires a rounding error: 8.29*100
 * is 828.9999999999999 in IEEE754, and Math.round hides it right up until it does not.
 *
 * So the string is split on the decimal point and the cents are assembled from digits. No float is
 * ever involved. A value that is not a plain decimal is a REFUSAL, not a zero — a zero would look
 * exactly like a day with no spend. */
export function spendStringToCents(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw * 100;
  if (typeof raw !== "string") throw new Error(`meta spend: expected a decimal string, got ${typeof raw}`);
  const s = raw.trim();
  /* ARBITRARY PRECISION, NOT TWO PLACES. This regex was \d{1,2} until the first real call came
   * back with "519.544921" — SIX decimals. Meta reports breakdown spend at sub-cent precision, so a
   * two-place parser would have refused every account-level row on day one. The positive control is
   * what caught it, before anything was written. */
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`meta spend: unparseable value ${JSON.stringify(s)}`);
  const [whole, frac = ""] = s.split(".");
  const padded = frac.padEnd(3, "0");
  /* HALF-UP ON THE THIRD DIGIT, done on digits. Not Math.round(Number(s) * 100): 8.29 * 100 is
   * 828.9999999999999 and no amount of rounding afterwards makes that reliable. */
  const cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  return Number(padded[2]) >= 5 ? cents + 1 : cents;
}

/** Impressions arrive as a string too. Absent is null, not 0 — they are different facts. */
export function impressionsToInt(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/* ── THE FLOOR ──────────────────────────────────────────────────────────────────────────────────
 * April through July are reconciled by hand and carry manual entries. A backfill would sit
 * ALONGSIDE them rather than replace them, so the floor is enforced in code AND in the database
 * (0151), not written down in a comment and hoped for.
 *
 * YMD STRING COMPARISON, no Date parsing — same rule the rest of this codebase follows for dates
 * that are days rather than instants. */
export function isAtOrAfterFloor(ymd: string, floor: string = META_EXPENSE_FLOOR_YMD): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) && ymd >= floor;
}

/** The daily store's floor — deliberately earlier than the ledger's. See the block above. */
export function isAtOrAfterDailyFloor(ymd: string): boolean {
  return isAtOrAfterFloor(ymd, META_DAILY_FLOOR_YMD);
}

/** The request window, clamped to the floor. Never returns a `since` earlier than the floor. */
export function windowFor(todayYmd: string, days: number = META_WINDOW_DAYS): { since: string; until: string } {
  const d = new Date(`${todayYmd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  const since = d.toISOString().slice(0, 10);
  return { since: since < META_DAILY_FLOOR_YMD ? META_DAILY_FLOOR_YMD : since, until: todayYmd };
}

/* ── CURRENCY ───────────────────────────────────────────────────────────────────────────────────
 * USD only. A non-USD account is a REFUSAL — this integration does not convert currencies, and a
 * silently-written EUR figure in a USD ledger is a wrong number that looks right. */
export function assertUsd(currency: string | null | undefined): void {
  if ((currency ?? "").toUpperCase() !== "USD") {
    throw new Error(`meta ad account currency is ${JSON.stringify(currency)}, not USD — refusing to write. No conversion is performed.`);
  }
}

/* ── ROWS ───────────────────────────────────────────────────────────────────────────────────────*/
export type MetaBreakdownRow = { date: string; marketRaw: string; spendCents: number; impressions: number | null };
export type DailyRow = MetaBreakdownRow & { marketKey: string | null; adAccountId: string; currency: string };

export const UNALLOCATED_MARKET = "__unallocated__";

/**
 * RECONCILE A DAY, ASSERTED NOT ASSUMED.
 *
 * Meta withholds low-volume breakdown rows, so the parts do not always sum to the whole. The
 * remainder is not rounding noise to be shrugged at — it is real spend that the breakdown declined
 * to attribute, and dropping it makes the ledger quietly understate what was spent.
 *
 * So the difference becomes an UNALLOCATED row for that day. A negative difference (parts exceeding
 * the account total, which should not happen) is reported as a variance but never written as a
 * negative row — that would corrupt the total in the other direction.
 */
export function reconcileDay(
  date: string,
  marketRows: MetaBreakdownRow[],
  accountTotalCents: number,
): { rows: MetaBreakdownRow[]; varianceCents: number } {
  const summed = marketRows.reduce((s, r) => s + r.spendCents, 0);
  const varianceCents = accountTotalCents - summed;
  if (varianceCents <= 0) return { rows: marketRows, varianceCents };
  return {
    rows: [...marketRows, { date, marketRaw: UNALLOCATED_MARKET, spendCents: varianceCents, impressions: null }],
    varianceCents,
  };
}

/** Attach our city code and account metadata. Unmapped markets keep their spend and get null. */
export function toDailyRows(rows: MetaBreakdownRow[], adAccountId: string, currency: string): DailyRow[] {
  return rows.map((r) => ({ ...r, marketKey: cityForMarket(r.marketRaw), adAccountId, currency }));
}

/* ── INTO fin_expenses ──────────────────────────────────────────────────────────────────────────
 * ONE ROW PER CITY PER MONTH. The daily series stays in fin_meta_ad_spend_daily; the ledger gets
 * ~7 rows a month so the Cash Flow buckets stay readable.
 *
 * THE OWNERSHIP PREDICATE, following RECOMPUTE_OWNED_CATEGORIES exactly:
 *     vendor = 'Meta' AND manual_entry = false AND date >= 2026-08-01
 * The sync deletes and rewrites WITHIN that predicate and nothing else. It is structurally
 * incapable of touching a manual_entry row or anything before the cutover, and ownsExpenseRow is
 * the single place that decides — asserted in the suite, not restated at each call site.
 */
export const META_VENDOR = "Meta";
export const META_CATEGORY = "Marketing";
export const META_CUTOVER_YMD = META_EXPENSE_FLOOR_YMD;

export type ExpenseRowish = { vendor: string | null; manual_entry: boolean | null; date: string };

export function ownsExpenseRow(r: ExpenseRowish): boolean {
  if (r.vendor !== META_VENDOR) return false;
  if (r.manual_entry !== false) return false;      // true OR null → hand-entered, never ours
  return isAtOrAfterFloor(r.date, META_EXPENSE_FLOOR_YMD);
}

export type MonthlyExpense = { month: string; date: string; city: string | null; amountCents: number; unallocated: boolean };

/** Roll daily rows into one expense row per city per month, plus one unallocated row per month. */
export function monthlyExpenseRows(rows: DailyRow[]): MonthlyExpense[] {
  const acc = new Map<string, { amountCents: number; city: string | null; unallocated: boolean }>();
  for (const r of rows) {
    // THE EXPENSE FLOOR, not the daily one. A December daily row is legitimate and must never
    // reach the ledger — see the two-floors block at the top of this file.
    if (!isAtOrAfterFloor(r.date, META_EXPENSE_FLOOR_YMD)) continue;
    const ym = r.date.slice(0, 7);
    const unallocated = r.marketKey == null;
    const key = `${ym}|${unallocated ? UNALLOCATED_MARKET : r.marketKey}`;
    const cur = acc.get(key) ?? { amountCents: 0, city: unallocated ? null : r.marketKey, unallocated };
    cur.amountCents += r.spendCents;
    acc.set(key, cur);
  }
  return [...acc.entries()]
    .map(([key, v]) => ({
      month: key.slice(0, 7),
      // Dated to the LAST day of the month, matching how the hand-entered ad rows were dated.
      date: lastDayOfMonth(key.slice(0, 7)),
      city: v.city,
      amountCents: v.amountCents,
      unallocated: v.unallocated,
    }))
    .sort((a, b) => a.month.localeCompare(b.month) || String(a.city).localeCompare(String(b.city)));
}

function lastDayOfMonth(ym: string): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

/** The note on an unallocated row. Named so the ledger says what it is rather than showing a gap. */
export const UNALLOCATED_NOTE = "Meta ads - unallocated";

/* ── ERROR REDACTION ────────────────────────────────────────────────────────────────────────────
 * Graph errors quote the request. If a URL ever carried the token it would land in a log, an
 * exception and a Vercel trace at once. The token is sent as a header so it should never be in a
 * URL at all — this is the second belt: any bearer-shaped run of characters is stripped before an
 * error leaves this module. */
export function redactMetaError(msg: string): string {
  return msg
    .replace(/access_token=[^&\s"']+/gi, "access_token=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-|]+/gi, "Bearer [REDACTED]")
    .replace(/EA[A-Za-z0-9]{20,}/g, "[REDACTED]");
}
