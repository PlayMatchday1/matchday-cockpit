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

/* THE THREE FIELDS THE LEDGER ROLLUP ACTUALLY READS, and no more.
 *
 * It took DailyRow[] — the shape of a FRESH PULL — which quietly made the ledger a projection of
 * whatever the last API call returned. It is now fed from fin_meta_ad_spend_daily, and a read of
 * that table selects three columns rather than seven. DailyRow still satisfies this structurally,
 * so every existing caller is unchanged. */
export type LedgerSourceRow = { date: string; marketKey: string | null; spendCents: number };

/** Roll daily rows into one expense row per city per month, plus one unallocated row per month. */
export function monthlyExpenseRows(rows: readonly LedgerSourceRow[]): MonthlyExpense[] {
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

/* ── COVERAGE, BECAUSE THE LEDGER IS NOW A PROJECTION AND INHERITS THE STORE'S GAPS ─────────────
 *
 * Making fin_expenses a projection of fin_meta_ad_spend_daily is what stops the 28-day window from
 * truncating a closed month. It also means a HOLE IN THE STORE is now a quietly short ledger
 * month, where before it was a quietly short one for a different reason. Swapping one invisible
 * understatement for another is not a fix, so the gap is counted and reported.
 *
 * It is live right now, which is why this exists rather than being hypothetical: the store stops
 * at 2026-08-25 because the nightly cron has never run, so August is missing six days.
 *
 * MONTHS ARE ENUMERATED FROM THE FLOOR, NOT FROM THE ROWS. A month with NO rows at all is the
 * worst case and the one a rows-driven loop cannot see — it simply would not appear.
 *
 * `todayYmd` bounds the current month: September is not missing the days that have not happened. */
export type MonthCoverage = { month: string; daysPresent: number; daysExpected: number };

export function ledgerMonthCoverage(
  rows: readonly LedgerSourceRow[],
  todayYmd: string,
  floorYmd: string = META_EXPENSE_FLOOR_YMD,
): MonthCoverage[] {
  const present = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!isAtOrAfterFloor(r.date, floorYmd)) continue;
    const ym = r.date.slice(0, 7);
    const set = present.get(ym) ?? new Set<string>();
    set.add(r.date);
    present.set(ym, set);
  }
  const out: MonthCoverage[] = [];
  for (let ym = floorYmd.slice(0, 7); ym <= todayYmd.slice(0, 7); ym = nextMonth(ym)) {
    // The first day counted is the floor's own day in the floor's month, and the 1st thereafter.
    const first = ym === floorYmd.slice(0, 7) ? floorYmd : `${ym}-01`;
    const last = ym === todayYmd.slice(0, 7) ? todayYmd : lastDayOfMonth(ym);
    if (last < first) continue;
    const daysExpected = Math.round(
      (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000,
    ) + 1;
    out.push({ month: ym, daysPresent: present.get(ym)?.size ?? 0, daysExpected });
  }
  return out;
}

function nextMonth(ym: string): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The months short of a full set of days, for the sync verdict. Empty when the store is complete. */
export function coverageShortfall(cov: readonly MonthCoverage[]): MonthCoverage[] {
  return cov.filter((c) => c.daysPresent < c.daysExpected);
}

/** The note on an unallocated row. Named so the ledger says what it is rather than showing a gap. */
export const UNALLOCATED_NOTE = "Meta ads - unallocated";

/* ══ CAMPAIGN AND AD SET GRAIN ═══════════════════════════════════════════════════════════════════
 *
 * WHY THIS IS A SECOND SET OF SHAPES AND NOT MORE COLUMNS ON THE FIRST. Meta SUPPRESSES app-install
 * actions under `comscore_market` — measured across nine dimension combinations on 2026-09-18, 766
 * installs at every grain without it and 0 with it, on rows that carry link clicks and video views
 * perfectly well. So geography and installs cannot sit on one row, and installs reach a market only
 * through the ad set that produced them.
 */

/** The new tables' floor (0184). EARLIER than the ledger's, LATER than the daily store's — a third
 *  floor for a third reason: the campaign structure was rebuilt in August, so pre-August campaign
 *  rows describe a structure that no longer exists. A backfill reaching further back must not try
 *  to write them; the CHECK would refuse the row and the whole run with it. */
export const META_ADSET_FLOOR_YMD = "2026-08-01";

export function isAtOrAfterAdsetFloor(ymd: string): boolean {
  return isAtOrAfterFloor(ymd, META_ADSET_FLOOR_YMD);
}

/* ── THE PARENT MARKET, DERIVED FROM DELIVERY ────────────────────────────────────────────────────
 * Never from the name. The convention held at 100% of spend for eight months and fell to 28.5% in
 * six weeks when the account was rebuilt, and a campaign name is targeting INTENT while
 * comscore_market is where the impression was SERVED.
 *
 * MEASURED over all 58 ad sets, lifetime: 56 resolve to a city, dominant share of NAMED spend min
 * 80.1%, p10 98.1%, median 100.0%. Restricted to the 2026-08-01 floor the tables can actually see:
 * 35 ad sets, ALL 35 agreeing with their lifetime parent, min 80.1%, none below the floor.
 */
export const MARKET_CONFIDENCE_FLOOR = 0.6;

/** Meta's own name for "we could not resolve this". A real returned market, not a null. */
export const UNKNOWN_MARKET = "Unknown";

export type AdsetMarketSpend = { marketRaw: string; spendCents: number };

export type DerivedParent = {
  /** The dominant NAMED market, populated even when it maps to nothing or clears no floor, so the
   *  not-attributed block can name the market rather than only report that there wasn't one. */
  marketRaw: string | null;
  /** Our city code. Null when the dominant market is unmapped, or the floor was not cleared. */
  marketKey: string | null;
  /** Share of NAMED spend held by the dominant market. Null when there is no named spend at all. */
  confidence: number | null;
  attributed: boolean;
};

/**
 * UNKNOWN IS EXCLUDED FROM THE VOTE AND NEVER FROM THE MONEY.
 *
 * This is the line that makes the rule survive what actually happened. During the geo-automation
 * episode the HTX ad set was only 58.3% NAMED overall — a naive majority on TOTAL spend would have
 * refused to attribute it, or worse, attributed it to "Unknown". Of its NAMED spend, Houston was
 * 98.6%. Unknown is the absence of a place, so it cannot win a vote about which place this is.
 *
 * TIES BREAK ON THE MARKET NAME, so two runs over identical data cannot disagree.
 */
export function deriveParentMarket(rows: readonly AdsetMarketSpend[]): DerivedParent {
  const byMarket = new Map<string, number>();
  for (const r of rows) {
    if (r.marketRaw === UNKNOWN_MARKET) continue;
    // Defensive: the account-grain reconciliation row has no business at this grain, and if it ever
    // appeared it would be a market called "__unallocated__" winning a vote about geography.
    if (r.marketRaw === UNALLOCATED_MARKET) continue;
    byMarket.set(r.marketRaw, (byMarket.get(r.marketRaw) ?? 0) + r.spendCents);
  }
  const namedTotal = [...byMarket.values()].reduce((a, b) => a + b, 0);
  if (namedTotal <= 0) return { marketRaw: null, marketKey: null, confidence: null, attributed: false };
  const ranked = [...byMarket.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [marketRaw, top] = ranked[0];
  const confidence = top / namedTotal;
  const mapped = cityForMarket(marketRaw);
  return {
    marketRaw,
    marketKey: confidence >= MARKET_CONFIDENCE_FLOOR ? mapped : null,
    confidence,
    attributed: confidence >= MARKET_CONFIDENCE_FLOOR && mapped != null,
  };
}

/* ── ACTIONS ─────────────────────────────────────────────────────────────────────────────────────
 * Meta returns `actions: [{action_type, value}]` with value as a STRING. `mobile_app_install` and
 * `omni_app_install` carry the same number on this account (766 over Sep 1-17), as do
 * `complete_registration` and `omni_complete_registration` (88). The non-omni names are read.
 *
 * ABSENT IS NOT ZERO, the rule impressions already follow. A row with NO actions array is a row we
 * learned nothing from — every geo row is like this — and returns null. A row WITH an actions array
 * but no install action genuinely had none, and returns 0. Collapsing the two would make a day Meta
 * declined to break down look like a day nobody installed on. */
export const META_INSTALL_ACTION = "mobile_app_install";
export const META_REGISTRATION_ACTION = "complete_registration";

export function actionValue(actions: unknown, actionType: string): number | null {
  if (!Array.isArray(actions)) return null;
  let total = 0;
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const row = a as { action_type?: unknown; value?: unknown };
    if (row.action_type !== actionType) continue;
    const n = Number(row.value);
    if (Number.isFinite(n) && n >= 0) total += n;
  }
  return Math.round(total);
}

/* ── THE INSTALL OBSERVATION LOG (0187) ──────────────────────────────────────────────────────────
 * fin_meta_adset_daily.reported_at CANNOT measure restatement: the sync upserts on the primary key,
 * so a column in the payload is overwritten every run and would only ever say when we last asked.
 * A single mutable row cannot hold a history of itself.
 *
 * So an append-only log, written ONLY WHEN THE NUMBER MOVES. First sighting always recorded; after
 * that a row appears only if installs differ from the last recorded value. On a stable series that
 * is one row per day per ad set forever, and the restatement CURVE falls out rather than only its
 * endpoints.
 *
 * A NULL installs APPENDS NOTHING. Null means the pull told us nothing, which is not an observation
 * of zero and must not be logged as one — that would manufacture a restatement from 0 the first
 * time a real number arrived. */
export type FreshInstallRow = { spendDate: string; adsetId: string; installs: number | null; spendCents: number };
export type InstallObservation = { spendDate: string; adsetId: string; installs: number; spendCents: number };

export function observationKey(spendDate: string, adsetId: string): string {
  return `${spendDate}|${adsetId}`;
}

export function observationsToAppend(
  fresh: readonly FreshInstallRow[],
  lastKnown: ReadonlyMap<string, number>,
): InstallObservation[] {
  const out: InstallObservation[] = [];
  for (const r of fresh) {
    if (r.installs == null) continue;
    const k = observationKey(r.spendDate, r.adsetId);
    const prev = lastKnown.get(k);
    if (prev !== undefined && prev === r.installs) continue;
    out.push({ spendDate: r.spendDate, adsetId: r.adsetId, installs: r.installs, spendCents: r.spendCents });
  }
  return out;
}

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
