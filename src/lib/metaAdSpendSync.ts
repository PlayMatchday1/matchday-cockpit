// Meta ad spend sync — the only file that talks to Meta. Server-only.
//
// READ-ONLY AGAINST META. Every request is a GET; there is no POST or DELETE path to Graph
// anywhere in this integration. The token goes in an Authorization header and never in a query
// string, so it cannot survive into a logged URL, and every error is passed through
// redactMetaError before it is thrown, logged or returned.
//
// ── WHAT DISCOVERY ESTABLISHED (2026-08-26, against the live account) ──────────────────────────
//   ONE ad account is visible to this system user: act_1613092135872657 "MatchDay", USD,
//   timezone America/Bogota, lifetime spend $31,888.09. The brief expected two; the second is not
//   assigned to this system user, which is the tighter grant and is left alone.
//
//   `breakdowns=dma` IS DEAD. Meta answers it with an explicit 400: "dma breakdown is no longer
//   supported; to retrieve market-level data, please instead use comscore_market breakdown."
//   `breakdowns=comscore_market` works and returns exactly the strings our mapping keys on
//   ("Atlanta, GA", "Dallas-Ft. Worth, TX"). Verified against a hand-read positive control:
//   seven markets, $925.42, 93,004 impressions, zero variance on every market.
//
//   SPEND CARRIES SUB-CENT PRECISION — the first real row was "519.544921". spendStringToCents
//   handles arbitrary decimals on digits; a two-place parser would have refused every row.
//
// ── THE TIMEZONE, which matters at month boundaries ────────────────────────────────────────────
// Meta buckets a day in the AD ACCOUNT's timezone (America/Bogota, UTC-5, no DST), not in
// America/Chicago. So a "2026-08-31" row is a Bogota day. For a monthly ledger figure the effect
// is confined to a few hours either side of a month boundary; it is recorded here rather than
// silently absorbed, because the alternative is someone later "fixing" a discrepancy that is not
// a bug.

import "server-only";
import {
  META_GRAPH_VERSION, META_EXPENSE_FLOOR_YMD, META_DAILY_FLOOR_YMD, META_WINDOW_DAYS, redactMetaError,
  spendStringToCents, impressionsToInt, assertUsd, isAtOrAfterFloor, isAtOrAfterDailyFloor, windowFor,
  reconcileDay, toDailyRows, monthlyExpenseRows, cityForMarket,
  ledgerMonthCoverage, coverageShortfall,
  META_ADSET_FLOOR_YMD, isAtOrAfterAdsetFloor, deriveParentMarket, actionValue,
  observationsToAppend, observationKey,
  META_INSTALL_ACTION, META_REGISTRATION_ACTION,
  type AdsetMarketSpend, type FreshInstallRow, type DerivedParent,
  META_VENDOR, META_CATEGORY, UNALLOCATED_NOTE, UNALLOCATED_MARKET,
  type MetaBreakdownRow, type DailyRow, type LedgerSourceRow, type MonthCoverage,
} from "./metaAdSpend";
import { selectAll } from "./supabasePagination";
import type { SupabaseClient } from "@supabase/supabase-js";

export type MetaSyncResult = {
  adAccountId: string; currency: string; breakdownParam: string;
  since: string; until: string;
  daysPulled: number; marketRows: number; unallocatedRows: number;
  spendCents: number; impressions: number;
  varianceByDay: { date: string; cents: number }[];
  /* NET across the window — can be NEGATIVE when market rows exceed the account total on a day. */
  varianceTotalCents: number;
  /* WHAT WAS ACTUALLY CARRIED as unallocated: the sum of the POSITIVE variances only. A negative
   * day adds no row (a negative expense would corrupt the total in the other direction), so net
   * and carried are different numbers and the verdict must not print one as the other. */
  unallocatedCents: number;
  expenseRowsWritten: number; expenseRowsDeleted: number;
  ownedBefore: number; ownedAfter: number;
  /* HOW MANY DAILY ROWS THE LEDGER WAS BUILT FROM. Not the window's row count — the whole owned
   * range read back out of fin_meta_ad_spend_daily. -1 on a dailyOnly run, where the ledger is
   * not inspected at all, matching ownedBefore's convention. */
  ledgerSourceRows: number;
  /** Per owned month: days present in the daily store against days that have happened. */
  coverage: MonthCoverage[];

  /* ── CAMPAIGN AND AD SET GRAIN. Zero on a run whose window is entirely below the 2026-08-01
   * ad-set floor, which is a legitimate historical load and not a failure. */
  adsetsSeen: number;
  adsetMarketRows: number;
  adsetDailyRows: number;
  parentsAttributed: number;
  /** Named, never dropped: the block an operator has to act on. */
  parentsNotAttributed: {
    adsetId: string; adsetName: string | null;
    marketRaw: string | null; confidence: number | null; spendCents: number;
  }[];
  observationsAppended: number;
  /* THE TWO GRAINS WILL NOT TIE, and this reports by how much rather than asserting they do. Meta
   * withholds low-volume breakdown rows at the finer grain too, so ad-set x market sums to slightly
   * LESS than account x market over the same days. A growing gap means more is being withheld. */
  adsetVsAccountCents: number;
  apiCalls: number;
};

const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
/** The parameter discovery proved works. Named, not guessed — `dma` returns a hard 400. */
export const BREAKDOWN_PARAM = "comscore_market";

function token(): string {
  const t = process.env.META_ADS_ACCESS_TOKEN?.trim();
  if (!t) throw new Error("META_ADS_ACCESS_TOKEN is not set");
  // The WhatsApp token is scoped for Business messaging and must never reach an ads endpoint.
  // Compared by value because the mistake is a copy-paste, not a typo in the variable name.
  if (t === process.env.META_ACCESS_TOKEN?.trim()) {
    throw new Error("META_ADS_ACCESS_TOKEN equals META_ACCESS_TOKEN — refusing. The WhatsApp token must never be used for ads.");
  }
  return t;
}

/* GET ONLY, and the one retry lives here. A READ may retry once on 5xx; a WRITE never retries, and
 * there are no writes to Meta at all. The URL is built without the token — an access_token param
 * would defeat the header form, so it is refused outright rather than trusted not to appear. */
let apiCalls = 0;
async function graphGet(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const u = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (u.searchParams.has("access_token")) throw new Error("refusing: token must travel in the Authorization header");
  for (let attempt = 0; attempt < 2; attempt++) {
    apiCalls++;
    const r = await fetch(u, { method: "GET", headers: { Authorization: `Bearer ${token()}` }, cache: "no-store" });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok) return body;
    const err = (body as { error?: { message?: string } }).error?.message ?? JSON.stringify(body);
    if (r.status >= 500 && attempt === 0) continue;   // one retry, reads only
    throw new Error(`meta ${r.status}: ${redactMetaError(String(err)).slice(0, 300)}`);
  }
  throw new Error("meta: unreachable");
}

async function pageAll(path: string, params: Record<string, string>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let body = await graphGet(path, params);
  out.push(...((body.data as Record<string, unknown>[]) ?? []));
  let guard = 0;
  while ((body.paging as { next?: string } | undefined)?.next && guard++ < 50) {
    apiCalls++;
    const r = await fetch((body.paging as { next: string }).next, {
      method: "GET", headers: { Authorization: `Bearer ${token()}` }, cache: "no-store",
    });
    if (!r.ok) break;
    body = (await r.json()) as Record<string, unknown>;
    out.push(...((body.data as Record<string, unknown>[]) ?? []));
  }
  return out;
}

/* OPTIONS EXIST FOR THE HISTORICAL LOAD, and it deliberately runs THE SAME CODE as the nightly
 * cron — same pull, same breakdown, same cents parser, same unmapped-to-null rule. A separate
 * one-off script would have been a second implementation of the money path, and the two would
 * drift the first time either changed.
 *
 * dailyOnly SKIPS THE LEDGER ENTIRELY. Not "writes an empty set" — the fin_expenses delete never
 * executes, so a historical load is structurally incapable of touching the ledger even if the
 * expense floor were somehow wrong. */
export type MetaSyncOptions = { since?: string; until?: string; dailyOnly?: boolean };

export async function syncMetaAdSpend(sb: SupabaseClient, todayYmd: string, opts: MetaSyncOptions = {}): Promise<MetaSyncResult> {
  apiCalls = 0;

  // ── The account, and the currency gate. A non-USD account writes NOTHING and converts nothing.
  const accs = await pageAll("me/adaccounts", { fields: "id,name,account_id,currency,timezone_name" });
  const withSpend: { id: string; currency: string; spend: number }[] = [];
  for (const a of accs) {
    const id = String(a.id);
    const ins = await graphGet(`${id}/insights`, { fields: "spend", date_preset: "maximum" });
    const rows = (ins.data as { spend?: string }[]) ?? [];
    withSpend.push({ id, currency: String(a.currency ?? ""), spend: rows[0]?.spend ? spendStringToCents(rows[0].spend) : 0 });
  }
  if (!withSpend.length) throw new Error("meta: no ad accounts visible to this system user");
  // The account WITH SPEND. The brief notes one account has never run a campaign; picking by spend
  // is stable whether or not that one is ever granted to this system user.
  const account = withSpend.slice().sort((x, y) => y.spend - x.spend)[0];
  assertUsd(account.currency);

  /* ── The window, hard-floored against the DAILY floor. An explicit window is still clamped —
   * a caller asking for November gets December, never November. */
  const auto = windowFor(todayYmd, META_WINDOW_DAYS);
  const since = opts.since && opts.since > auto.since ? opts.since : (opts.since ?? auto.since);
  const until = opts.until ?? auto.until;
  if (!isAtOrAfterDailyFloor(since)) {
    throw new Error(`meta: window start ${since} is before the ${META_DAILY_FLOOR_YMD} daily floor`);
  }

  const common = { time_range: JSON.stringify({ since, until }), time_increment: "1", limit: "500" };

  // ── Market rows, and the per-day account total that checks them.
  const broken = await pageAll(`${account.id}/insights`, { ...common, fields: "spend,impressions", breakdowns: BREAKDOWN_PARAM });
  const totals = await pageAll(`${account.id}/insights`, { ...common, fields: "spend" });

  const totalByDay = new Map<string, number>();
  for (const t of totals) {
    const d = String(t.date_start ?? "");
    if (isAtOrAfterDailyFloor(d)) totalByDay.set(d, spendStringToCents(t.spend));
  }
  const marketsByDay = new Map<string, MetaBreakdownRow[]>();
  for (const b of broken) {
    const d = String(b.date_start ?? "");
    if (!isAtOrAfterDailyFloor(d)) continue;                    // THE DAILY FLOOR, at the row level
    const market = String((b as Record<string, unknown>)[BREAKDOWN_PARAM] ?? "");
    if (!market) continue;
    const arr = marketsByDay.get(d) ?? [];
    arr.push({ date: d, marketRaw: market, spendCents: spendStringToCents(b.spend), impressions: impressionsToInt(b.impressions) });
    marketsByDay.set(d, arr);
  }

  // ── RECONCILE EACH DAY. The remainder is not noise to shrug at: Meta withholds low-volume
  // breakdown rows, and dropping the difference makes the ledger understate real spend.
  const varianceByDay: { date: string; cents: number }[] = [];
  const allRows: MetaBreakdownRow[] = [];
  for (const [date, rows] of [...marketsByDay].sort()) {
    const { rows: withUnalloc, varianceCents } = reconcileDay(date, rows, totalByDay.get(date) ?? rows.reduce((s, r) => s + r.spendCents, 0));
    if (varianceCents !== 0) varianceByDay.push({ date, cents: varianceCents });
    allRows.push(...withUnalloc);
  }
  const daily: DailyRow[] = toDailyRows(allRows, account.id, account.currency);

  // ── WRITE 1: the daily store. Upsert on the primary key; a re-pull of a revised day overwrites.
  // Writes never retry.
  if (daily.length) {
    const payload = daily.map((r) => ({
      spend_date: r.date, market_raw: r.marketRaw, market_key: r.marketKey,
      spend_cents: r.spendCents, impressions: r.impressions,
      ad_account_id: r.adAccountId, currency: r.currency, synced_at: new Date().toISOString(),
    }));
    for (let i = 0; i < payload.length; i += 500) {
      const { error } = await sb.from("fin_meta_ad_spend_daily")
        .upsert(payload.slice(i, i + 500), { onConflict: "spend_date,market_raw,ad_account_id" });
      if (error) throw new Error(`fin_meta_ad_spend_daily upsert failed: ${error.message}`);
    }
  }

  /* ══ WRITE 1b: CAMPAIGN AND AD SET GRAIN ══════════════════════════════════════════════════════
   *
   * TWO PULLS, because Meta will not serve geography and installs on one row: `comscore_market`
   * suppresses app-install actions entirely. One pull carries the market and no installs, the other
   * carries installs and no market, and the ad set is the join between them.
   *
   * THE AD-SET FLOOR IS ITS OWN. These tables start at 2026-08-01 because the campaign structure was
   * rebuilt then. A historical load reaching back to the DAILY floor (2025-12-01) is legitimate and
   * must not try to write them — the CHECK would refuse the row and take the whole run with it — so
   * every row is filtered here rather than at the database. */
  const adsetWindowOpen = until >= META_ADSET_FLOOR_YMD;
  let adsetsSeen = 0, adsetMarketRows = 0, adsetDailyRows = 0;
  let parentsAttributed = 0, observationsAppended = 0, adsetVsAccountCents = 0;
  const parentsNotAttributed: MetaSyncResult["parentsNotAttributed"] = [];

  if (adsetWindowOpen) {
    const adsetSince = since > META_ADSET_FLOOR_YMD ? since : META_ADSET_FLOOR_YMD;
    const adsetCommon = { time_range: JSON.stringify({ since: adsetSince, until }), time_increment: "1", limit: "500" };

    /* THE DIMENSION. attribution_spec is read on every run rather than assumed: every active ad set
     * is CLICK_THROUGH window_days 1 today, which is what decides how long an install can restate,
     * and a change by the agency has to be visible here instead of inferred from a number drifting. */
    const adsetMeta = await pageAll(`${account.id}/adsets`, {
      fields: "id,name,campaign_id,campaign{name},optimization_goal,attribution_spec,effective_status",
      limit: "200",
    });
    const geo = await pageAll(`${account.id}/insights`, {
      ...adsetCommon, level: "adset", breakdowns: BREAKDOWN_PARAM,
      fields: "adset_id,campaign_id,spend,impressions,clicks",
    });
    const flat = await pageAll(`${account.id}/insights`, {
      ...adsetCommon, level: "adset",
      fields: "adset_id,campaign_id,spend,impressions,clicks,reach,actions",
    });

    // ── geo rows ──────────────────────────────────────────────────────────────────────────────
    const geoRows = geo
      .filter((r) => isAtOrAfterAdsetFloor(String(r.date_start ?? "")))
      .filter((r) => String(r[BREAKDOWN_PARAM] ?? "") !== "")
      .map((r) => ({
        spend_date: String(r.date_start),
        ad_account_id: account.id,
        adset_id: String(r.adset_id ?? ""),
        campaign_id: String(r.campaign_id ?? ""),
        market_raw: String(r[BREAKDOWN_PARAM]),
        market_key: cityForMarket(String(r[BREAKDOWN_PARAM])),
        spend_cents: spendStringToCents(r.spend),
        impressions: impressionsToInt(r.impressions),
        clicks: impressionsToInt(r.clicks),
        synced_at: new Date().toISOString(),
      }))
      .filter((r) => r.adset_id !== "");
    for (let i = 0; i < geoRows.length; i += 500) {
      const { error } = await sb.from("fin_meta_adset_market_daily")
        .upsert(geoRows.slice(i, i + 500), { onConflict: "spend_date,ad_account_id,adset_id,market_raw" });
      if (error) throw new Error(`fin_meta_adset_market_daily upsert failed: ${error.message}`);
    }
    adsetMarketRows = geoRows.length;

    // ── install-bearing rows ──────────────────────────────────────────────────────────────────
    const flatRows = flat
      .filter((r) => isAtOrAfterAdsetFloor(String(r.date_start ?? "")))
      .map((r) => ({
        spend_date: String(r.date_start),
        ad_account_id: account.id,
        adset_id: String(r.adset_id ?? ""),
        campaign_id: String(r.campaign_id ?? ""),
        spend_cents: spendStringToCents(r.spend),
        impressions: impressionsToInt(r.impressions),
        clicks: impressionsToInt(r.clicks),
        // NEVER SUMMED downstream — de-duplicated, stored at the grain it was fetched at.
        reach: impressionsToInt(r.reach),
        installs: actionValue(r.actions, META_INSTALL_ACTION),
        registrations: actionValue(r.actions, META_REGISTRATION_ACTION),
        reported_at: new Date().toISOString(),
      }))
      .filter((r) => r.adset_id !== "");
    for (let i = 0; i < flatRows.length; i += 500) {
      const { error } = await sb.from("fin_meta_adset_daily")
        .upsert(flatRows.slice(i, i + 500), { onConflict: "spend_date,ad_account_id,adset_id" });
      if (error) throw new Error(`fin_meta_adset_daily upsert failed: ${error.message}`);
    }
    adsetDailyRows = flatRows.length;

    /* ── THE OBSERVATION LOG. Read the LAST recorded value per (day, ad set), then append only what
     * moved. The read is bounded by the window, not the table, so it does not grow with history. */
    const priorObs = await selectAll<{ spend_date: string; adset_id: string; installs: number; observed_at: string }>(() =>
      sb.from("fin_meta_install_observations")
        .select("spend_date, adset_id, installs, observed_at")
        .gte("spend_date", adsetSince).lte("spend_date", until)
        .order("observed_at"),
    );
    const lastKnown = new Map<string, number>();
    for (const o of priorObs) lastKnown.set(observationKey(o.spend_date, o.adset_id), o.installs);
    const fresh: FreshInstallRow[] = flatRows.map((r) => ({
      spendDate: r.spend_date, adsetId: r.adset_id, installs: r.installs, spendCents: r.spend_cents,
    }));
    const append = observationsToAppend(fresh, lastKnown);
    if (append.length) {
      const payload = append.map((o) => ({
        spend_date: o.spendDate, ad_account_id: account.id, adset_id: o.adsetId,
        installs: o.installs, spend_cents: o.spendCents,
      }));
      for (let i = 0; i < payload.length; i += 500) {
        const { error } = await sb.from("fin_meta_install_observations").insert(payload.slice(i, i + 500));
        if (error) throw new Error(`fin_meta_install_observations insert failed: ${error.message}`);
      }
    }
    observationsAppended = append.length;

    /* ── THE PARENT MARKET, DERIVED FROM THIS RUN'S OWN ROWS ──────────────────────────────────
     * Not from a second, wider pull: the parent is derived from exactly the rows that were just
     * stored, so the two can never disagree. Measured — the Aug-1 window and the lifetime window
     * produce identical parents for all 35 ad sets they share.
     *
     * AN AD SET WITH NO ROWS IN THIS RUN KEEPS ITS STORED PARENT, because it is simply absent from
     * the payload and the upsert does not touch it. That is what makes the nightly 28-day window
     * safe: it sees 16 of the 35 ad sets, and the other 19 stopped spending in August and keep the
     * parent the backfill gave them. */
    const byAdset = new Map<string, AdsetMarketSpend[]>();
    const spendByAdset = new Map<string, number>();
    for (const r of geoRows) {
      (byAdset.get(r.adset_id) ?? byAdset.set(r.adset_id, []).get(r.adset_id)!)
        .push({ marketRaw: r.market_raw, spendCents: r.spend_cents });
      spendByAdset.set(r.adset_id, (spendByAdset.get(r.adset_id) ?? 0) + r.spend_cents);
    }
    const nameOf = new Map<string, { name: string | null; campaignId: string; campaignName: string | null; goal: string | null; spec: unknown }>();
    for (const a of adsetMeta) {
      nameOf.set(String(a.id), {
        name: (a.name as string) ?? null,
        campaignId: String(a.campaign_id ?? ""),
        campaignName: ((a.campaign as { name?: string } | undefined)?.name) ?? null,
        goal: (a.optimization_goal as string) ?? null,
        spec: a.attribution_spec ?? null,
      });
    }
    const dimRows: Record<string, unknown>[] = [];
    for (const [adsetId, rows] of byAdset) {
      const parent: DerivedParent = deriveParentMarket(rows);
      const meta = nameOf.get(adsetId);
      if (parent.attributed) parentsAttributed++;
      else parentsNotAttributed.push({
        adsetId, adsetName: meta?.name ?? null,
        marketRaw: parent.marketRaw, confidence: parent.confidence,
        spendCents: spendByAdset.get(adsetId) ?? 0,
      });
      dimRows.push({
        ad_account_id: account.id, adset_id: adsetId,
        campaign_id: meta?.campaignId || (rows.length ? "" : ""),
        adset_name: meta?.name ?? null, campaign_name: meta?.campaignName ?? null,
        optimization_goal: meta?.goal ?? null, attribution_spec: meta?.spec ?? null,
        market_key: parent.marketKey, market_raw: parent.marketRaw,
        market_confidence: parent.confidence, market_method: "derived",
        computed_at: new Date().toISOString(),
      });
    }
    /* campaign_id is NOT NULL. An ad set with rows but no dimension row (deleted upstream between
     * the two calls) takes its campaign_id from the insight rows rather than failing the insert. */
    const campaignOf = new Map<string, string>();
    for (const r of geoRows) if (r.campaign_id) campaignOf.set(r.adset_id, r.campaign_id);
    for (const d of dimRows) if (!d.campaign_id) d.campaign_id = campaignOf.get(String(d.adset_id)) ?? "unknown";
    if (dimRows.length) {
      const { error } = await sb.from("fin_meta_adset")
        .upsert(dimRows, { onConflict: "ad_account_id,adset_id" });
      if (error) throw new Error(`fin_meta_adset upsert failed: ${error.message}`);
    }
    adsetsSeen = dimRows.length;

    /* ── RECONCILIATION, REPORTED NOT ASSERTED. Ad-set x market against account x market over the
     * same days and markets. They will NOT tie: Meta withholds low-volume breakdown rows at the
     * finer grain too, so the ad-set total sits slightly below. A GROWING gap is the signal. */
    const acctByKey = new Map<string, number>();
    for (const r of daily) {
      if (r.marketRaw === UNALLOCATED_MARKET) continue;
      if (!isAtOrAfterAdsetFloor(r.date)) continue;
      acctByKey.set(`${r.date}|${r.marketRaw}`, (acctByKey.get(`${r.date}|${r.marketRaw}`) ?? 0) + r.spendCents);
    }
    const adsetByKey = new Map<string, number>();
    for (const r of geoRows) {
      adsetByKey.set(`${r.spend_date}|${r.market_raw}`, (adsetByKey.get(`${r.spend_date}|${r.market_raw}`) ?? 0) + r.spend_cents);
    }
    let a = 0, b = 0;
    for (const [k, v] of acctByKey) { a += v; b += adsetByKey.get(k) ?? 0; }
    adsetVsAccountCents = b - a;
  }

  // ── WRITE 2: the ledger. THE OWNERSHIP PREDICATE AND NOTHING ELSE.
  //   vendor='Meta' AND manual_entry=false AND date >= 2026-08-01
  // Delete-then-insert inside that predicate, mirroring RECOMPUTE_OWNED_CATEGORIES. It is
  // structurally incapable of reaching a manual_entry row or anything before the cutover, because
  // both clauses are on the DELETE itself rather than applied afterwards in code.
  /* THE THREE CLAUSES ARE APPLIED TOGETHER, ALWAYS. Written once as a helper so the count query
   * and the DELETE cannot drift apart — a delete with one clause missing is the failure that eats
   * hand-entered rows, and there is no undo on the finance ledger. */
  /* THE LEDGER IS NOT TOUCHED AT ALL ON A DAILY-ONLY RUN. The early return is before the count,
   * before the delete, before anything — the historical load cannot reach fin_expenses. */
  if (opts.dailyOnly) {
    return {
      adAccountId: account.id, currency: account.currency, breakdownParam: BREAKDOWN_PARAM,
      since, until,
      daysPulled: marketsByDay.size,
      marketRows: daily.filter((r) => r.marketRaw !== UNALLOCATED_MARKET).length,
      unallocatedRows: daily.filter((r) => r.marketRaw === UNALLOCATED_MARKET).length,
      spendCents: daily.reduce((s, r) => s + r.spendCents, 0),
      impressions: daily.reduce((s, r) => s + (r.impressions ?? 0), 0),
      varianceByDay,
      varianceTotalCents: varianceByDay.reduce((s, v) => s + v.cents, 0),
      unallocatedCents: varianceByDay.reduce((s, v) => s + (v.cents > 0 ? v.cents : 0), 0),
      expenseRowsWritten: 0, expenseRowsDeleted: 0,
      ownedBefore: -1, ownedAfter: -1,   // -1 = not inspected, distinct from "zero rows owned"
      ledgerSourceRows: -1, coverage: [],
      adsetsSeen, adsetMarketRows, adsetDailyRows,
      parentsAttributed, parentsNotAttributed, observationsAppended, adsetVsAccountCents,
      apiCalls,
    };
  }

  const countOwned = async (): Promise<number> => {
    const { count, error } = await sb.from("fin_expenses")
      .select("id", { count: "exact", head: true })
      .eq("vendor", META_VENDOR).eq("manual_entry", false).gte("date", META_EXPENSE_FLOOR_YMD);
    if (error) throw new Error(`fin_expenses count failed: ${error.message}`);
    return count ?? 0;
  };

  const ownedBefore = await countOwned();

  const del = await sb.from("fin_expenses")
    .delete({ count: "exact" })
    .eq("vendor", META_VENDOR).eq("manual_entry", false).gte("date", META_EXPENSE_FLOOR_YMD);
  if (del.error) throw new Error(`fin_expenses delete failed: ${del.error.message}`);
  const expenseRowsDeleted = del.count ?? 0;

  /* ── THE LEDGER IS A PROJECTION OF THE DAILY STORE, NOT OF THE LAST PULL ────────────────────
   *
   * This read is the whole fix. It was `monthlyExpenseRows(daily)` — `daily` being the 28-day
   * window — while the DELETE above covers EVERY owned row from 2026-08-01. So each run deleted
   * the whole owned range and rewrote only the months the window happened to touch, and any
   * earlier month was deleted and never written back.
   *
   * MEASURED before the fix, on 2026-09-18 against the real stored rows: the delete removed
   * $3,321.02 of August and the insert put back $554.46. August's marketing cost would have
   * fallen by roughly two thirds, silently, on the first successful call. It never bit only
   * because the cron has been answering 405 since the day this shipped and the one manual run
   * happened inside the month it had just backfilled.
   *
   * IT ALSO CLOSES A SECOND HOLE ON THE SAME LINE. If Meta returns nothing — an outage, a
   * revoked token, a paused account — `daily` is EMPTY, the old rollup produced zero rows, and
   * the delete still ran: every Meta expense row gone, reported as a successful sync. Reading
   * the store instead means an empty pull rewrites what is already there.
   *
   * READ AFTER THE UPSERT so this run's own days are included, and PAGED, because PostgREST caps
   * at 1,000 and this range grows by ~8 rows a day forever.
   *
   * THREE COLUMNS, NOT `*`. monthlyExpenseRows now takes LedgerSourceRow, which is exactly what
   * it reads; selecting the rest would be inviting a future reader to use it. */
  const stored = await selectAll<{ spend_date: string; market_key: string | null; spend_cents: number }>(() =>
    sb.from("fin_meta_ad_spend_daily")
      .select("spend_date, market_key, spend_cents")
      .gte("spend_date", META_EXPENSE_FLOOR_YMD)
      .order("spend_date"),
  );
  const ledgerSource: LedgerSourceRow[] = stored.map((r) => ({
    date: r.spend_date, marketKey: r.market_key, spendCents: r.spend_cents,
  }));
  const coverage = ledgerMonthCoverage(ledgerSource, todayYmd);

  const monthly = monthlyExpenseRows(ledgerSource);
  const rows = monthly.map((m) => ({
    date: m.date,
    month: monthLabel(m.month),
    city: m.unallocated ? null : cityLabel(m.city),
    category: META_CATEGORY,
    vendor: META_VENDOR,
    amount: m.amountCents / 100,
    notes: m.unallocated ? UNALLOCATED_NOTE : "Ads",
    manual_entry: false,
  }));
  if (rows.length) {
    const { error } = await sb.from("fin_expenses").insert(rows);
    if (error) throw new Error(`fin_expenses insert failed: ${error.message}`);
  }

  const ownedAfter = await countOwned();

  return {
    adAccountId: account.id, currency: account.currency, breakdownParam: BREAKDOWN_PARAM,
    since, until,
    daysPulled: marketsByDay.size,
    marketRows: daily.filter((r) => r.marketRaw !== UNALLOCATED_MARKET).length,
    unallocatedRows: daily.filter((r) => r.marketRaw === UNALLOCATED_MARKET).length,
    spendCents: daily.reduce((s, r) => s + r.spendCents, 0),
    impressions: daily.reduce((s, r) => s + (r.impressions ?? 0), 0),
    varianceByDay,
    varianceTotalCents: varianceByDay.reduce((s, v) => s + v.cents, 0),
    unallocatedCents: varianceByDay.reduce((s, v) => s + (v.cents > 0 ? v.cents : 0), 0),
    expenseRowsWritten: rows.length, expenseRowsDeleted,
    ownedBefore, ownedAfter,
    ledgerSourceRows: ledgerSource.length, coverage,
    adsetsSeen, adsetMarketRows, adsetDailyRows,
    parentsAttributed, parentsNotAttributed, observationsAppended, adsetVsAccountCents,
    apiCalls,
  };
}

/* AD SETS THAT REACHED NO MARKET, NAMED. An exclusion nobody can see is the worse bug — the same
 * reasoning as unattributedVenues on the Revenue page. Empty string when every ad set resolved. */
export function notAttributedVerdict(rows: MetaSyncResult["parentsNotAttributed"]): string {
  if (!rows.length) return "";
  const shown = rows.slice(0, 5).map((r) =>
    `${r.adsetName ?? r.adsetId} ($${(r.spendCents / 100).toFixed(2)}, dominant ${r.marketRaw ?? "none"}`
    + `${r.confidence == null ? "" : ` at ${(r.confidence * 100).toFixed(1)}%`})`);
  const more = rows.length > shown.length ? ` +${rows.length - shown.length} more` : "";
  const total = rows.reduce((a, r) => a + r.spendCents, 0);
  return `NOT ATTRIBUTED: ${rows.length} ad set${rows.length === 1 ? "" : "s"} carrying `
    + `$${(total / 100).toFixed(2)} reached no market we map, or cleared no confidence floor: `
    + `${shown.join(", ")}${more}. Their spend is stored and counted; it is not in any market row.`;
}

/* The verdict line for a store short of days. Empty string when it is complete.
 *
 * NO "ADVISORY" PREFIX HERE. The route joins this with the variance line and prefixes the pair
 * once; two prefixes in one field would read as two failures. See the note at that call site for
 * why the prefix matters at all. */
export function coverageVerdict(cov: readonly MonthCoverage[]): string {
  const short = coverageShortfall(cov);
  if (!short.length) return "";
  /* CAPPED. One entry per short month, and the list only grows: unbounded, this would eventually
   * push the variance line out of a 500-character field, which is the half that reports money. */
  const shown = short.slice(0, 6).map((c) => `${c.month} ${c.daysPresent}/${c.daysExpected} days`);
  const more = short.length > shown.length ? ` +${short.length - shown.length} more` : "";
  return `COVERAGE: fin_expenses is a projection of fin_meta_ad_spend_daily and that store is short of days, so ${short.length === 1 ? "this month is" : "these months are"} understated: ${shown.join(", ")}${more}. Re-run with an explicit window to fill them.`;
}

/** fin_expenses.month is a display label ("Aug 2026"), matching the hand-entered rows. */
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function monthLabel(ym: string): string { return `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`; }

/* fin_expenses.city holds DISPLAY names ("San Antonio"), not our codes — the hand-entered rows do,
 * and a mixed column would split every city report in two. */
const CITY_LABEL: Record<string, string> = {
  ATL: "Atlanta", ATX: "Austin", DFW: "Dallas", HTX: "Houston",
  OKC: "OKC", SATX: "San Antonio", STL: "St. Louis",
};
function cityLabel(code: string | null): string | null { return code ? (CITY_LABEL[code] ?? code) : null; }

export { cityForMarket };
