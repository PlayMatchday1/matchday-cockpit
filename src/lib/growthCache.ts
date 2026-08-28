// One in-process cached aggregate that serves BOTH growth endpoints. A single
// keyset-paginated fetch (never OFFSET — a deep OFFSET on 232k match_players hits
// the Postgres statement timeout, which is what 504'd /api/lifecycle) feeds BOTH
// computeGrowth (funnel / behavior / ARPP / churn) and buildRetention (curve +
// cohorts) from the SAME matches + players rows — no second participation fetch.
// Cached keyed on the max match date, so a backfill lands a newer match and the
// next request rebuilds; concurrent cold requests share one in-flight build.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeGrowth,
  type GrowthData,
  type RawMatch,
  type RawPlayer,
  type RawUser,
  type RawSubscription,
  type RawRevenue,
} from "./growthAnalytics";
import { buildRetention, type RetentionAggregate } from "./retentionEngine";

// Generic keyset pagination: `where key > last order by key limit 1000` — an
// index seek per page, no offset scan.
/** Bumped when a fact changes MEANING rather than when a row lands. See the key below. */
export const GROWTH_MODEL_VERSION = "v2-pretax";

async function keyset<T extends Record<string, unknown>>(
  sb: SupabaseClient,
  table: string,
  cols: string,
  keyCol: string,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let last: number | string | null = null;
  for (;;) {
    let q = sb.from(table).select(cols).order(keyCol, { ascending: true }).limit(PAGE);
    if (last != null) q = q.gt(keyCol, last);
    const { data, error } = await q;
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    last = rows[rows.length - 1][keyCol] as number | string;
  }
  return out;
}

export type GrowthCache = {
  key: string;
  growth: GrowthData;
  retention: RetentionAggregate;
  builtAt: string;
  timing: { fetchMs: number; computeMs: number };
};

let cache: GrowthCache | null = null;
let building: Promise<GrowthCache> | null = null;

async function build(sb: SupabaseClient, key: string): Promise<GrowthCache> {
  const t0 = Date.now();
  const [matches, players, users, subscriptions, revenue] = await Promise.all([
    keyset<RawMatch & { api_id: number }>(
      sb,
      "mdapi_matches",
      "api_id, start_date, city_identifier, field_id, field_title, is_cancelled, deleted_at",
      "api_id",
    ),
    keyset<RawPlayer & { api_id: number }>(
      sb,
      "mdapi_match_players",
      // `amount` is the PRE-TAX price. total_amount is the card charge (base + city sales tax
      // - credit) and is not revenue — migration 0154.
      "api_id, user_id, match_api_id, paid_status, canceled_at, user_is_fake_player, deleted_at, amount",
      "api_id",
    ),
    keyset<RawUser & { id: number }>(
      sb,
      "mdapi_users",
      "id, created_at, completed_sign_up_at, preferable_city_name, is_fake_player",
      "id",
    ),
    keyset<RawSubscription & { membership_id: number }>(
      sb,
      "mdapi_subscriptions",
      "membership_id, user_id, city_identifier, activation_date, canceled_at",
      "membership_id",
    ),
    keyset<RawRevenue & { id: number }>(sb, "fin_revenue", "id, month, city, type, net", "id"),
  ]);
  // app_downloads is tiny (one row per day) — a single bounded read, no pagination.
  let androidDaily: { period_date: string; count: number }[] = [];
  try {
    const { data } = await sb
      .from("app_downloads")
      .select("period_date, count")
      .eq("platform", "android")
      .eq("period_grain", "day")
      .order("period_date")
      .limit(50000);
    androidDaily = data ?? [];
  } catch {
    androidDaily = [];
  }

  // Play-ingest health for the App downloads KPI. Determine the no-data states
  // here (the pure engine upgrades to "synced" if any android rows exist):
  //   not_configured — the runtime SA key is absent/empty (its current state)
  //   never_run      — key present, but no play-installs run has ever been logged
  //   failed         — the latest logged run recorded an error_message
  //   no_data        — the latest logged run completed but returned nothing
  // The SA key value is never read here beyond a presence/blank check.
  const rawKey = process.env.GOOGLE_PLAY_SA_KEY_B64;
  const keyConfigured = !!(rawKey && rawKey.trim().length > 0);
  let playRun: { started_at: string; completed_at: string | null; rows_imported: number | null; error_message: string | null } | null = null;
  try {
    const { data } = await sb
      .from("fin_sync_log")
      .select("started_at, completed_at, rows_imported, error_message")
      .eq("source", "play-installs")
      .order("started_at", { ascending: false })
      .limit(1);
    playRun = data?.[0] ?? null;
  } catch {
    playRun = null;
  }
  const playSync: GrowthData["playSync"] = (() => {
    if (!keyConfigured) return { state: "not_configured", lastRunAt: null, error: null, lastSyncedDate: null };
    if (!playRun) return { state: "never_run", lastRunAt: null, error: null, lastSyncedDate: null };
    if (playRun.error_message) return { state: "failed", lastRunAt: playRun.started_at, error: playRun.error_message, lastSyncedDate: null };
    return { state: "no_data", lastRunAt: playRun.started_at, error: null, lastSyncedDate: null };
  })();
  const fetchMs = Date.now() - t0;

  const t1 = Date.now();
  const playersLive = players.filter((p) => !p.deleted_at).length;
  const usersNonFake = users.filter((u) => !u.is_fake_player);
  const fakeLiveRows = players.filter((p) => !p.deleted_at && p.user_is_fake_player).length;
  const rowCounts: GrowthData["rowCounts"] = {
    matchesTotal: matches.length,
    matchesLive: matches.filter((m) => !m.deleted_at).length,
    playersTotal: players.length,
    playersLive,
    fakeLiveRows,
    fakeLivePct: playersLive > 0 ? fakeLiveRows / playersLive : 0,
    waitingLiveNonFake: players.filter((p) => !p.deleted_at && !p.user_is_fake_player && p.paid_status === "WAITING").length,
    usersTotal: users.length,
    usersNonFake: usersNonFake.length,
    usersFake: users.length - usersNonFake.length,
    usersCompletedNonFake: usersNonFake.filter((u) => u.completed_sign_up_at).length,
    subscriptions: subscriptions.length,
    finRevenue: revenue.length,
  };
  const now = new Date().toISOString();
  const growth = computeGrowth({ matches, players, users, subscriptions, revenue, androidDaily, playSync, now, rowCounts });
  const retention = buildRetention(matches, players, now); // SAME matches + players — no refetch
  const computeMs = Date.now() - t1;
  return { key, growth, retention, builtAt: now, timing: { fetchMs, computeMs } };
}

export async function getGrowthCache(
  sb: SupabaseClient,
): Promise<GrowthCache & { cached: boolean; probeMs: number }> {
  const t0 = Date.now();
  const { data: maxRow } = await sb
    .from("mdapi_matches")
    .select("start_date")
    .is("deleted_at", null)
    .not("start_date", "is", null)
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  /* THE MODEL VERSION RIDES IN THE KEY. max(start_date) moves when a MATCH lands and is blind
   * to a change in what a COLUMN MEANS — so when revenue went from the tax-inclusive card charge
   * to the pre-tax amount (migration 0154), a warm instance would have gone on serving the old
   * numbers from a cache whose key had not moved. Bump it whenever a fact changes meaning. */
  const key = `${GROWTH_MODEL_VERSION}:${(maxRow?.start_date ?? "").slice(0, 10)}`;
  const probeMs = Date.now() - t0;
  if (cache && cache.key === key) return { ...cache, cached: true, probeMs };
  // Dedup concurrent cold builds (the dashboard fires both endpoints at once).
  if (!building) building = build(sb, key).then((c) => { cache = c; building = null; return c; }, (e) => { building = null; throw e; });
  const c = await building;
  return { ...c, cached: false, probeMs };
}
