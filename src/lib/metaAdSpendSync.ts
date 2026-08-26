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
  META_GRAPH_VERSION, META_FLOOR_YMD, META_WINDOW_DAYS, redactMetaError,
  spendStringToCents, impressionsToInt, assertUsd, isAtOrAfterFloor, windowFor,
  reconcileDay, toDailyRows, monthlyExpenseRows, cityForMarket,
  META_VENDOR, META_CATEGORY, UNALLOCATED_NOTE, UNALLOCATED_MARKET,
  type MetaBreakdownRow, type DailyRow,
} from "./metaAdSpend";
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

export async function syncMetaAdSpend(sb: SupabaseClient, todayYmd: string): Promise<MetaSyncResult> {
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

  // ── The window, hard-floored. windowFor clamps, and isAtOrAfterFloor refuses again per row.
  const { since, until } = windowFor(todayYmd, META_WINDOW_DAYS);
  if (!isAtOrAfterFloor(since)) throw new Error(`meta: window start ${since} is before the ${META_FLOOR_YMD} floor`);

  const common = { time_range: JSON.stringify({ since, until }), time_increment: "1", limit: "500" };

  // ── Market rows, and the per-day account total that checks them.
  const broken = await pageAll(`${account.id}/insights`, { ...common, fields: "spend,impressions", breakdowns: BREAKDOWN_PARAM });
  const totals = await pageAll(`${account.id}/insights`, { ...common, fields: "spend" });

  const totalByDay = new Map<string, number>();
  for (const t of totals) {
    const d = String(t.date_start ?? "");
    if (isAtOrAfterFloor(d)) totalByDay.set(d, spendStringToCents(t.spend));
  }
  const marketsByDay = new Map<string, MetaBreakdownRow[]>();
  for (const b of broken) {
    const d = String(b.date_start ?? "");
    if (!isAtOrAfterFloor(d)) continue;                        // THE FLOOR, at the row level
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

  // ── WRITE 2: the ledger. THE OWNERSHIP PREDICATE AND NOTHING ELSE.
  //   vendor='Meta' AND manual_entry=false AND date >= 2026-08-01
  // Delete-then-insert inside that predicate, mirroring RECOMPUTE_OWNED_CATEGORIES. It is
  // structurally incapable of reaching a manual_entry row or anything before the cutover, because
  // both clauses are on the DELETE itself rather than applied afterwards in code.
  /* THE THREE CLAUSES ARE APPLIED TOGETHER, ALWAYS. Written once as a helper so the count query
   * and the DELETE cannot drift apart — a delete with one clause missing is the failure that eats
   * hand-entered rows, and there is no undo on the finance ledger. */
  const countOwned = async (): Promise<number> => {
    const { count, error } = await sb.from("fin_expenses")
      .select("id", { count: "exact", head: true })
      .eq("vendor", META_VENDOR).eq("manual_entry", false).gte("date", META_FLOOR_YMD);
    if (error) throw new Error(`fin_expenses count failed: ${error.message}`);
    return count ?? 0;
  };

  const ownedBefore = await countOwned();

  const del = await sb.from("fin_expenses")
    .delete({ count: "exact" })
    .eq("vendor", META_VENDOR).eq("manual_entry", false).gte("date", META_FLOOR_YMD);
  if (del.error) throw new Error(`fin_expenses delete failed: ${del.error.message}`);
  const expenseRowsDeleted = del.count ?? 0;

  const monthly = monthlyExpenseRows(daily);
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
    apiCalls,
  };
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
