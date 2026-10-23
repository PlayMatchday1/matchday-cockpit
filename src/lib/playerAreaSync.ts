// Sync GET /admin/players → player_area_seen (and, on the full pass, mdapi_users). Server-only.
// READS MatchDay, writes only Supabase.
//
// ── TWO KINDS OF RUN SINCE 2026-10-21 (Ryan, after the R15 outage at 2:05 PM Central) ────────────
//   INCREMENTAL, hourly (runIncremental): GET /admin/players?locationUpdatedSince=<the start of the
//     last successful run − 1 hour>, 200 a page. Every player whose location changed since then —
//     new players who shared a location or typed a zip, existing players who moved or changed their
//     zip (Vitalii, backend). Usually ONE request. A player it returns without an area is cleared on
//     the spot: the row is a fresh read of that player.
//   FULL, once a day at ~3 AM Central (startPass / runLeg): every page of /admin/players. It
//     (1) writes every page to mdapi_users too — names, city, signup, member and fake flags, and the
//     in-place scrub of a deleted account, which no incremental read can see; (2) clears the area of
//     anyone it saw without one, once every page has been read; (3) is the backstop for anything the
//     incremental filter misses. It replaced both the 3-a-day location walk (~800 requests a pass)
//     and /api/sync/users-full (~147).
//
// ── THE RULES OF THE WALK ────────────────────────────────────────────────────────────────────────
//   1. PACED: one request a second, no retries, the first error stops the run (getPacedClient). The
//      next scheduled run is the retry.
//   2. limit=200, NEWEST FIRST. A signup mid-walk shifts rows down, so DISTINCT ids are counted
//      against the API's totalItems (player_area_pass_seen), and only a pass that has read EVERY page
//      with at least totalItems distinct ids may mark anyone's area as cleared.
//   3. RESUMABLE. ~185 pages at ~1.3 s is ~4 minutes, near one function run, so a pass is a chain of
//      LEGS. A leg reads pages until LEG_BUDGET_MS is spent and saves next_page on the run row; the
//      continuation cron (/api/sync/player-areas/continue, every 5 minutes) runs the next leg of an
//      open pass — continueOpenPass below. Each page is written as it arrives, so a pass that stops
//      part way has still recorded what it read — it just clears nobody.
//   4. A PAGE THAT TAKES OVER SLOW_PAGE_MS stops the pass: "stopped, server under strain". (This
//      replaced the limit=1 health check before every 10th page: a tenth more requests, to learn
//      what the page's own timing says.)
//   5. NO EVENING FULL PASSES. Between 22:00 and 04:00 UTC (5 PM to 11 PM Central) no full pass
//      starts, and a leg that reaches 22:00 stops: "stopped, evening match hours". An incremental run
//      (one request) is allowed.
//   6. Never two runs at once — the run row's heartbeat is the lock (startPass / claimLeg), and an
//      incremental run stands down while a full pass is live.
//
// WRITES ONLY WHAT CHANGED. A row is upserted when one of its values differs from what is stored —
// which includes every row when the city geometry changes, since verdict_geometry is part of the
// comparison. The geometry is fetched once per pass and kept on the run row, so every leg of a pass
// computes against the same cities.
//
// SEEDING. The first successful pass marks every area it finds seeded = true: those areas were set
// before tracking began and first_seen_at is NOT their set time.
//
// first_seen_at IS NEVER OVERWRITTEN. New rows go in with ignoreDuplicates; updates carry the
// stored first_seen_at back unchanged.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getPacedClient, MatchdayApiError, type PacedClient } from "./matchdayApi";
import { mapRow as mapUserRow, type ApiPlayer as ApiUser, type DbRow as UserRow } from "./mdapiUsersSync";
import { selectAll } from "./supabasePagination";
import {
  apiCoords, computeVerdict, geometryKey, hasArea, isInternalEmail, areaCities, zip5, zipOf, type AreaCity, type LocationSource,
} from "./playerAreaModel";
import { stateForPoint } from "./usState";
import { activeFields } from "./locationsMap";
import { fetchFieldSnapshots } from "./locationsData";

export const PAGE_LIMIT = 200;
/** Walking time per leg. The route's maxDuration is 300 s; the rest is the leg's writes and the hand-on. */
export const LEG_BUDGET_MS = 230_000;
/** Rule 4: a single page slower than this stops the pass. */
export const SLOW_PAGE_MS = 10_000;
const WRITE_BATCH = 500;
const USER_BATCH = 100; // mdapi_users upserts: 100 a statement (mdapiUsersSync, UPSERT_BATCH)
/** A pass whose heartbeat is older than this has stalled (a leg was killed, or no continuation came):
 *  it no longer holds the lock. Legs run every 5 minutes and last under 4, so an open pass's heartbeat
 *  is never more than a few minutes old; 12 minutes tolerates one missed tick. */
export const LOCK_WINDOW_MS = 12 * 60 * 1000;
/** A heartbeat this fresh means a leg is reading pages RIGHT NOW (it beats every ~2.3 s): a
 *  continuation tick must not start a second leg beside it. */
export const LEG_RUNNING_MS = 45 * 1000;

/* ── THE EVENING BLOCK, 22:00–04:00 UTC (full passes only) ─────────────────────────────────────────────────────────── */
export const EVENING_FROM_UTC = 22, EVENING_TO_UTC = 4;
export function inEveningBlock(now: Date): boolean {
  const h = now.getUTCHours();
  return h >= EVENING_FROM_UTC || h < EVENING_TO_UTC;
}
export const EVENING_MESSAGE = "No full location pass between 5 PM and 11 PM Central (22:00 to 04:00 UTC), when matches are on.";

type ApiPlayer = ApiUser & {
  id?: number; email?: string | null; zipCode?: unknown; lat?: unknown; lng?: unknown;
  /** Since 2026-10-08 the coordinates of a ZIP share are only here (apiCoords). */
  currentLat?: unknown; currentLng?: unknown;
  areaLabel?: unknown; areaSource?: unknown;
  /** Since 2026-10-08: when the player's location last changed. */
  locationUpdatedAt?: unknown;
};
type ApiPage = { totalItems?: number; data?: ApiPlayer[] };

export type AreaRow = {
  player_id: number;
  first_seen_at: string;
  seeded: boolean;
  has_area: boolean;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  area_label: string | null;
  area_source: string | null;
  /** Two-letter US state from lat/lng against Census boundaries (usState.ts). Migration 0216. */
  state: string | null;
  /** Migration 0221: 'matchday' (the record's coordinates) or 'zip_centroid' (located from zip). */
  location_source: LocationSource | null;
  is_internal: boolean;
  verdict: "in_market" | "waitlist" | "unidentified";
  verdict_city_id: number | null;
  nearest_city_id: number | null;
  nearest_city_mi: number | null;
  verdict_geometry: string;
  updated_at: string;
};

const COMPARED: (keyof AreaRow)[] = [
  "has_area", "zip", "lat", "lng", "area_label", "area_source", "state", "location_source", "is_internal",
  "verdict", "verdict_city_id", "nearest_city_id", "nearest_city_mi", "verdict_geometry",
];

export type StopReason = "complete" | "strain" | "evening" | "error" | "stalled";
export type RunKind = "full" | "incremental";

export type RunRow = {
  id: number; started_at: string; finished_at: string | null; ok: boolean | null; triggered_by: string;
  next_page: number | null; pages_total: number | null; page_size: number | null; legs: number;
  heartbeat_at: string | null; stop_reason: StopReason | null; players_total: number | null;
  api_calls: number | null; areas_seen: number | null; rows_inserted: number | null; rows_updated: number | null;
  players_internal: number | null; cities: unknown; error: string | null;
  /** Migration 0230. */
  kind: RunKind; since: string | null;
};
const RUN_COLS = "id,started_at,finished_at,ok,triggered_by,next_page,pages_total,page_size,legs,heartbeat_at,stop_reason,players_total,api_calls,areas_seen,rows_inserted,rows_updated,players_internal,cities,error,kind,since";

/** A run row is a live pass when it is unfinished and its heartbeat (or start) is recent. */
export const isLive = (r: Pick<RunRow, "finished_at" | "heartbeat_at" | "started_at">, nowMs: number) =>
  r.finished_at == null && nowMs - Date.parse(r.heartbeat_at ?? r.started_at) < LOCK_WINDOW_MS;

export type LegResult = {
  ok: boolean;
  skipped?: string;
  runId: number | null;
  /** The pass needs another leg. */
  more: boolean;
  pagesRead: number;
  stopReason?: StopReason;
  error?: string;
};

/* ── STARTING A PASS ─────────────────────────────────────────────────────────────────────────────
 * Insert our row, THEN look for a live pass. Two starts together both insert and both look: only the
 * higher id sees the lower one, so exactly one proceeds. Any unfinished pass with a stale heartbeat
 * is closed as stalled first — it can never resume, and the next pass starts from page 1. */
export async function startPass(sb: SupabaseClient, triggeredBy: "cron" | "manual", now = new Date()):
  Promise<{ runId: number } | { skipped: string }> {
  const nowMs = now.getTime();
  const open = await sb.from("player_area_sync_runs").select(RUN_COLS).is("finished_at", null).order("id");
  if (open.error) throw new Error(`player_area_sync_runs read failed: ${open.error.message}`);
  for (const r of (open.data ?? []) as RunRow[]) {
    if (isLive(r, nowMs)) return { skipped: `pass ${r.id} (started ${r.started_at}) is still in progress` };
    await finishPass(sb, r.id, { ok: false, stopReason: "stalled",
      error: `stalled after page ${(r.next_page ?? 1) - 1}: no leg for ${Math.round((nowMs - Date.parse(r.heartbeat_at ?? r.started_at)) / 60000)} minutes` });
  }
  const ins = await sb.from("player_area_sync_runs").insert({
    triggered_by: triggeredBy, started_at: now.toISOString(), heartbeat_at: now.toISOString(),
    next_page: 1, page_size: PAGE_LIMIT, legs: 0, api_calls: 0, kind: "full",
  }).select("id").single<{ id: number }>();
  if (ins.error) throw new Error(`player_area_sync_runs insert failed: ${ins.error.message}`);
  const runId = ins.data.id;
  const again = await sb.from("player_area_sync_runs").select("id,started_at,heartbeat_at,finished_at").is("finished_at", null).lt("id", runId);
  if (again.error) {
    await sb.from("player_area_sync_runs").delete().eq("id", runId);
    throw new Error(`player_area_sync_runs lock read failed: ${again.error.message}`);
  }
  const rival = ((again.data ?? []) as RunRow[]).find((r) => isLive(r, nowMs));
  if (rival) {
    await sb.from("player_area_sync_runs").delete().eq("id", runId);
    return { skipped: `pass ${rival.id} started at the same moment` };
  }
  return { runId };
}

async function finishPass(sb: SupabaseClient, runId: number, f: {
  ok: boolean; stopReason: StopReason; error?: string | null; extra?: Partial<RunRow>;
}): Promise<void> {
  await sb.from("player_area_sync_runs").update({
    ...(f.extra ?? {}), finished_at: new Date().toISOString(), ok: f.ok, stop_reason: f.stopReason,
    complete: f.stopReason === "complete", error: f.error ?? null,
  }).eq("id", runId);
  // next_page is KEPT on a finished pass: pages read = next_page − 1, which the sync history shows.
  // The pass's seen-set has done its job (or can no longer be used): drop it.
  await sb.from("player_area_pass_seen").delete().eq("run_id", runId);
  await logFullPass(sb, runId);
}

/* THE FULL PASS IS ALSO mdapi_users' DAILY FULL SYNC, so it is logged where that sync always was:
 * fin_sync_log source 'mdapi-users-full' (Recent Syncs, the Data page). One row per pass, written
 * when the pass ends however it ends — complete, stopped, or closed as stalled. Best effort: the
 * pass's own record is the run row. */
async function logFullPass(sb: SupabaseClient, runId: number): Promise<void> {
  const got = await sb.from("player_area_sync_runs").select(RUN_COLS).eq("id", runId).maybeSingle<RunRow>();
  const r = got.data;
  if (got.error || !r || r.kind !== "full") return;
  const { error } = await sb.from("fin_sync_log").insert({
    source: "mdapi-users-full", triggered_by: r.triggered_by, started_at: r.started_at,
    completed_at: r.finished_at ?? new Date().toISOString(),
    rows_imported: r.ok ? r.players_total : null,
    error_message: r.ok ? null : (r.error ?? `stopped: ${r.stop_reason}`).slice(0, 500),
    api_calls: r.api_calls, run_mode: "full",
  });
  if (error) console.warn(`[player-areas] fin_sync_log row for pass ${runId} failed: ${error.message}`);
}

/* ── THE CONTINUATION ─────────────────────────────────────────────────────────────────────────────
 * Called every 5 minutes by the cron. With no open pass it does one Supabase read and returns. With
 * one, it runs the next leg — unless a leg is reading pages right now (heartbeat under 45 s old), or
 * the pass has stalled (heartbeat past the lock window), which it closes instead.
 *
 * WHY A CRON AND NOT A REQUEST TO ITSELF. The first version handed on with a POST to this route. On
 * 2026-10-09 05:10 UTC that POST came back HTTP 200 instead of 202: Vercel deployment protection
 * covers every host except custom domains (ssoProtection all_except_custom_domains), so the request
 * was sent to Vercel's login page. Cron invocations pass that protection; a function's own request
 * does not. */
export async function continueOpenPass(sb: SupabaseClient, now = new Date()): Promise<LegResult | { idle: string }> {
  // FULL passes only: an incremental run is one function call and never has a next leg.
  const open = await sb.from("player_area_sync_runs").select(RUN_COLS).is("finished_at", null).eq("kind", "full").order("id", { ascending: false }).limit(1).maybeSingle<RunRow>();
  if (open.error) throw new Error(open.error.message);
  const run = open.data;
  if (!run) return { idle: "no pass open" };
  const age = now.getTime() - Date.parse(run.heartbeat_at ?? run.started_at);
  if (age < LEG_RUNNING_MS) return { idle: `a leg of pass ${run.id} is running` };
  if (!isLive(run, now.getTime())) {
    await finishPass(sb, run.id, { ok: false, stopReason: "stalled",
      error: `stalled after page ${(run.next_page ?? 1) - 1}: no leg for ${Math.round(age / 60000)} minutes` });
    return { idle: `pass ${run.id} had stalled and was closed` };
  }
  return runLeg(sb, run.id);
}

/* ── ONE LEG ──────────────────────────────────────────────────────────────────────────────────────
 * Reads pages from the run row's next_page until the leg budget is spent, the walk ends, or a stop
 * rule fires. `runId` must be a live pass; a leg that finds it finished, or another leg holding it,
 * stands down. */
export async function runLeg(sb: SupabaseClient, runId: number): Promise<LegResult> {
  const t0 = Date.now();
  const out: LegResult = { ok: false, runId, more: false, pagesRead: 0 };
  const got = await sb.from("player_area_sync_runs").select(RUN_COLS).eq("id", runId).maybeSingle<RunRow>();
  if (got.error) throw new Error(got.error.message);
  const run = got.data;
  if (!run) return { ...out, ok: true, skipped: `pass ${runId} not found` };
  if (run.finished_at) return { ...out, ok: true, skipped: `pass ${runId} has already ended` };
  // A leg claims the pass by bumping legs; a stale heartbeat means the previous leg is gone.
  const claim = await sb.from("player_area_sync_runs")
    .update({ legs: run.legs + 1, heartbeat_at: new Date().toISOString() })
    .eq("id", runId).eq("legs", run.legs).is("finished_at", null).select("id");
  if (claim.error) throw new Error(claim.error.message);
  if (!claim.data?.length) return { ...out, ok: true, skipped: `another leg of pass ${runId} is running` };

  let client: PacedClient | null = null;
  const calls = () => (run.api_calls ?? 0) + (client?.calls ?? 0);
  const stop = async (reason: StopReason, error: string) => {
    await finishPass(sb, runId, { ok: false, stopReason: reason, error, extra: { api_calls: calls() } as Partial<RunRow> });
    return { ...out, ok: false, stopReason: reason, error };
  };

  let page = run.next_page ?? 1;
  try {
    if (inEveningBlock(new Date())) return await stop("evening", `stopped, evening match hours (before page ${page})`);
    client = getPacedClient();

    // THE GEOMETRY, once per pass: the first leg reads /admin/cities and keeps it on the run row.
    let cities: AreaCity[] = Array.isArray(run.cities) && run.cities.length ? (run.cities as AreaCity[]) : [];
    if (cities.length === 0) {
      const raw = await client.get<unknown>("/admin/cities");
      cities = areaCities(Array.isArray(raw) ? raw : []);
      if (cities.length === 0) throw new Error("/admin/cities returned no city with lat/lng/radiusMiles — refusing to compute verdicts");
      await sb.from("player_area_sync_runs").update({ cities }).eq("id", runId);
    }
    const g = await geometryFor(sb, cities);
    const bootstrap = await isBootstrap(sb);

    let totalItems = run.players_total ?? 0;
    let pagesTotal = run.pages_total;
    let tally = { areas: run.areas_seen ?? 0, inserted: run.rows_inserted ?? 0, updated: run.rows_updated ?? 0, internal: run.players_internal ?? 0 };
    let walkEnded = false;

    while (Date.now() - t0 < LEG_BUDGET_MS) {
      if (inEveningBlock(new Date())) return await stop("evening", `stopped, evening match hours (before page ${page})`);
      const p0 = Date.now();
      const res = await client.get<ApiPage>("/admin/players",
        { page, limit: PAGE_LIMIT, sortColumn: "createdAt", sortDirection: "desc" });
      const pageMs = Date.now() - p0;
      if (page === 1) {
        totalItems = typeof res.totalItems === "number" ? res.totalItems : 0;
        if (totalItems === 0) throw new Error("/admin/players returned totalItems 0");
        pagesTotal = Math.ceil(totalItems / PAGE_LIMIT);
      }
      const rows = (Array.isArray(res.data) ? res.data : []).filter((r) => typeof r.id === "number");
      const w = await writePage(sb, runId, rows, { ...g, bootstrap }, { users: true, clearInline: false });
      tally = { areas: tally.areas + w.areas, inserted: tally.inserted + w.inserted, updated: tally.updated + w.updated, internal: tally.internal + w.internal };
      out.pagesRead++;
      page++;
      // Progress and heartbeat, on the run row: the Data page's card reads these.
      const hb = await sb.from("player_area_sync_runs").update({
        next_page: page, pages_total: pagesTotal, players_total: totalItems, heartbeat_at: new Date().toISOString(),
        api_calls: calls(), areas_seen: tally.areas, rows_inserted: tally.inserted,
        rows_updated: tally.updated, players_internal: tally.internal,
      }).eq("id", runId);
      if (hb.error) throw new Error(`progress write failed: ${hb.error.message}`);
      // Rule 4: the page is written (it is good data); the pass goes no further.
      if (pageMs > SLOW_PAGE_MS) return await stop("strain", `stopped, server under strain: page ${page - 1} took ${(pageMs / 1000).toFixed(1)} s`);
      if (rows.length < PAGE_LIMIT) { walkEnded = true; break; }
      if (pagesTotal != null && page > pagesTotal + 2) { walkEnded = true; break; } // runaway guard
    }

    if (!walkEnded) { out.ok = true; out.more = true; return out; }
    await completePass(sb, runId, totalItems, g.geom, cities, g.markets, { ...tally, apiCalls: calls() });
    out.ok = true;
    out.stopReason = "complete";
    return out;
  } catch (e) {
    // Rule 1: one failure ends the pass. No page is asked for twice; the next scheduled pass retries.
    return await stop("error", `stopped on page ${page}: ${errText(e)}`);
  }
}

/** An error for the run log: an API failure leads with its HTTP status. */
const errText = (e: unknown) =>
  e instanceof MatchdayApiError ? `HTTP ${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e);

/** The markets (cities with an active field) and the geometry key every verdict is computed against. */
async function geometryFor(sb: SupabaseClient, cities: AreaCity[]): Promise<{ cities: AreaCity[]; markets: Set<number>; geom: string }> {
  const { fields: liveFields } = activeFields(await fetchFieldSnapshots(sb), cities);
  const markets = new Set(liveFields.map((f) => f.cityId));
  if (markets.size === 0) throw new Error("no active field in any city — refusing to compute statuses");
  return { cities, markets, geom: geometryKey(cities, markets) };
}

/* ── THE INCREMENTAL RUN ──────────────────────────────────────────────────────────────────────────
 * GET /admin/players?locationUpdatedSince=<since>&limit=200, every page until the set ends (the order is
 * UNKNOWN and not relied on; the filter, and a full ISO timestamp, are probed — docs/matchday-api-facts.md).
 *   since = the START of the last successful run of either kind, minus INCREMENTAL_OVERLAP_MS. A start
 *           time, not a finish: a location changed while that run was reading has a later stamp.
 *   No successful run on record → refused (a full pass seeds it). A live full pass → stands down:
 *   that pass is reading everyone already.
 * The city geometry is the one the last complete full pass fetched (its run row), so an incremental
 * run makes no /admin/cities request.
 * THE FILTER IS CHECKED, NOT TRUSTED. The API silently ignores parameters it does not know (unknown
 * sort columns return the default order). If page 1's totalItems exceeds INCREMENTAL_MAX the filter is
 * taken to be ignored and the run stops before writing anything. */
export const INCREMENTAL_OVERLAP_MS = 60 * 60 * 1000;
export const INCREMENTAL_MAX = 5000;
/** How `since` is written on the query: a full ISO timestamp, probed 2026-10-21 (docs/matchday-api-facts.md). */
export const sinceParam = (since: Date): string => since.toISOString();

export type IncrementalResult = {
  ok: boolean; skipped?: string; runId: number | null; since: string | null;
  apiCalls: number; players: number; inserted: number; updated: number; cleared: number; error?: string;
};

export async function runIncremental(sb: SupabaseClient, triggeredBy: "cron" | "manual",
  deps: { client?: PacedClient; now?: Date; geometry?: { cities: AreaCity[]; markets: Set<number>; geom: string } } = {}): Promise<IncrementalResult> {
  const now = deps.now ?? new Date();
  const out: IncrementalResult = { ok: false, runId: null, since: null, apiCalls: 0, players: 0, inserted: 0, updated: 0, cleared: 0 };
  const open = await sb.from("player_area_sync_runs").select(RUN_COLS).is("finished_at", null).order("id");
  if (open.error) throw new Error(`player_area_sync_runs read failed: ${open.error.message}`);
  const live = ((open.data ?? []) as RunRow[]).find((r) => isLive(r, now.getTime()));
  if (live) return { ...out, ok: true, skipped: `${live.kind} run ${live.id} (started ${live.started_at}) is in progress` };

  const last = await sb.from("player_area_sync_runs").select("id,started_at").eq("ok", true)
    .order("started_at", { ascending: false }).limit(1).maybeSingle<{ id: number; started_at: string }>();
  if (last.error) throw new Error(`last successful run read failed: ${last.error.message}`);
  if (!last.data) return { ...out, ok: true, skipped: "no successful run on record to start from; the full pass seeds it" };
  const geo = await sb.from("player_area_sync_runs").select("cities").eq("kind", "full").eq("ok", true)
    .order("id", { ascending: false }).limit(1).maybeSingle<{ cities: unknown }>();
  if (geo.error) throw new Error(`geometry read failed: ${geo.error.message}`);
  const cities = Array.isArray(geo.data?.cities) ? (geo.data.cities as AreaCity[]) : [];
  if (cities.length === 0) return { ...out, ok: true, skipped: "no complete full pass with city geometry on record" };

  const since = new Date(Date.parse(last.data.started_at) - INCREMENTAL_OVERLAP_MS);
  out.since = since.toISOString();
  const ins = await sb.from("player_area_sync_runs").insert({
    triggered_by: triggeredBy, started_at: now.toISOString(), heartbeat_at: now.toISOString(),
    next_page: 1, page_size: PAGE_LIMIT, legs: 1, api_calls: 0, kind: "incremental", since: out.since,
  }).select("id").single<{ id: number }>();
  if (ins.error) throw new Error(`player_area_sync_runs insert failed: ${ins.error.message}`);
  const runId = out.runId = ins.data.id;

  const client = deps.client ?? getPacedClient();
  let page = 1;
  try {
    const g = deps.geometry ?? await geometryFor(sb, cities);
    for (let pagesTotal = 1; page <= pagesTotal; page++) {
      const res = await client.get<ApiPage>("/admin/players", { locationUpdatedSince: sinceParam(since), page, limit: PAGE_LIMIT });
      if (page === 1) {
        const total = typeof res.totalItems === "number" ? res.totalItems : 0;
        if (total > INCREMENTAL_MAX) {
          throw new Error(`locationUpdatedSince returned totalItems ${total} (over ${INCREMENTAL_MAX}): the filter looks ignored — nothing written`);
        }
        pagesTotal = Math.ceil(total / PAGE_LIMIT);
      }
      const rows = (Array.isArray(res.data) ? res.data : []).filter((r) => typeof r.id === "number");
      const w = await writePage(sb, null, rows, { ...g, bootstrap: false }, { users: false, clearInline: true });
      out.players += rows.length; out.inserted += w.inserted; out.updated += w.updated; out.cleared += w.cleared;
      if (rows.length < PAGE_LIMIT) break;
    }
    out.ok = true;
  } catch (e) {
    out.error = `stopped on page ${page}: ${errText(e)}`;
  }
  out.apiCalls = client.calls;
  await sb.from("player_area_sync_runs").update({
    finished_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), ok: out.ok,
    stop_reason: out.ok ? "complete" : "error", complete: out.ok, error: out.error ?? null,
    next_page: page + 1, pages_total: page, api_calls: out.apiCalls, players_total: out.players,
    rows_inserted: out.inserted, rows_updated: out.updated + out.cleared,
  }).eq("id", runId);
  return out;
}

async function isBootstrap(sb: SupabaseClient): Promise<boolean> {
  const prior = await sb.from("player_area_sync_runs").select("id", { count: "exact", head: true }).eq("ok", true);
  if (prior.error) throw new Error(prior.error.message);
  if ((prior.count ?? 0) > 0) return false;
  const stored = await sb.from("player_area_seen").select("player_id", { count: "exact", head: true });
  if (stored.error) throw new Error(stored.error.message);
  return (stored.count ?? 0) === 0;
}

/* ONE PAGE: write the area rows that changed.
 *   FULL pass (runId set, clearInline false): also remember who was seen, for the distinct count and
 *     the end-of-pass clearing — a player seen without an area is only recorded here, and cleared by
 *     completePass once every page has been read. With `users`, the page is upserted into
 *     mdapi_users as well (mapRow, the same mapping the users sync uses).
 *   INCREMENTAL run (clearInline true): each row is a fresh read of one player whose location
 *     changed, so a player we hold with an area who comes back without one is cleared here. */
async function writePage(sb: SupabaseClient, runId: number | null, rows: ApiPlayer[], g: {
  cities: AreaCity[]; markets: Set<number>; geom: string; bootstrap: boolean;
}, opts: { users: boolean; clearInline: boolean }): Promise<{ areas: number; inserted: number; updated: number; internal: number; cleared: number }> {
  const now = new Date().toISOString();
  if (runId != null) {
    const seen = rows.map((p) => ({ run_id: runId, player_id: p.id as number, has_area: hasArea(p) }));
    if (seen.length) {
      const { error } = await sb.from("player_area_pass_seen").upsert(seen, { onConflict: "run_id,player_id" });
      if (error) throw new Error(`player_area_pass_seen: ${error.message}`);
    }
  }
  if (opts.users) await upsertUsers(sb, rows, now);
  let cleared = 0;
  if (opts.clearInline) {
    const noArea = rows.filter((p) => !hasArea(p)).map((p) => p.id as number);
    if (noArea.length) {
      const held = await sb.from("player_area_seen").select("*").in("player_id", noArea).eq("has_area", true);
      if (held.error) throw new Error(`player_area_seen read: ${held.error.message}`);
      const clears = ((held.data ?? []) as AreaRow[]).map((r) => ({ ...r, has_area: false, updated_at: now }));
      if (clears.length) {
        const { error } = await sb.from("player_area_seen").upsert(clears, { onConflict: "player_id" });
        if (error) throw new Error(`player_area_seen clear: ${error.message}`);
      }
      cleared = clears.length;
    }
  }
  const withArea = rows.filter(hasArea);
  const ids = withArea.map((p) => p.id as number);
  const stored = ids.length
    ? await sb.from("player_area_seen").select("*").in("player_id", ids)
    : { data: [] as AreaRow[], error: null };
  if (stored.error) throw new Error(`player_area_seen read: ${stored.error.message}`);
  const byId = new Map(((stored.data ?? []) as AreaRow[]).map((r) => [r.player_id, r]));
  /* LOCATED FROM ZIP — only for a player whose record has a zip and NO coordinates: the Census ZCTA
   * centroid of that zip (zip_centroids, migration 0221). A zip with no centroid stays unidentified. */
  const needZip = [...new Set(withArea.filter((p) => apiCoords(p).lat == null).map((p) => zip5(p.zipCode)).filter((z): z is string => z != null))];
  const centroid = new Map<string, { lat: number; lng: number }>();
  if (needZip.length) {
    const { data, error } = await sb.from("zip_centroids").select("zip,lat,lng").in("zip", needZip);
    if (error) throw new Error(`zip_centroids: ${error.message}`);
    for (const z of data ?? []) centroid.set(z.zip as string, { lat: Number(z.lat), lng: Number(z.lng) });
  }
  const inserts: AreaRow[] = [], updates: AreaRow[] = [];
  for (const p of withArea) {
    const id = p.id as number;
    const prev = byId.get(id);
    const own = apiCoords(p);
    const fromZip = own.lat == null ? centroid.get(zip5(p.zipCode) ?? "") ?? null : null;
    const lat = own.lat ?? fromZip?.lat ?? null, lng = own.lng ?? fromZip?.lng ?? null;
    const location_source: LocationSource | null = own.lat != null ? "matchday" : fromZip ? "zip_centroid" : null;
    const v = computeVerdict(lat, lng, g.cities, g.markets);
    const next: AreaRow = {
      player_id: id, first_seen_at: prev?.first_seen_at ?? now, seeded: prev?.seeded ?? g.bootstrap, has_area: true,
      zip: zipOf(p.zipCode), lat, lng, area_label: str(p.areaLabel), area_source: str(p.areaSource),
      state: lat != null && lng != null ? stateForPoint(lat, lng) : null, location_source,
      is_internal: isInternalEmail(p.email), verdict: v.verdict, verdict_city_id: v.verdictCityId,
      nearest_city_id: v.nearestCityId, nearest_city_mi: v.nearestCityMi, verdict_geometry: g.geom, updated_at: now,
    };
    if (!prev) inserts.push(next);
    else if (COMPARED.some((k) => prev[k] !== next[k])) updates.push(next);
  }
  if (inserts.length) {
    const { error } = await sb.from("player_area_seen").upsert(inserts, { onConflict: "player_id", ignoreDuplicates: true });
    if (error) throw new Error(`player_area_seen insert: ${error.message}`);
  }
  if (updates.length) {
    const { error } = await sb.from("player_area_seen").upsert(updates, { onConflict: "player_id" });
    if (error) throw new Error(`player_area_seen update: ${error.message}`);
  }
  return { areas: withArea.length, inserted: inserts.length, updated: updates.length, internal: rows.filter((p) => isInternalEmail(p.email)).length, cleared };
}

/* mdapi_users from a full-pass page. A row mapRow rejects (no id, email or createdAt) is skipped, as
 * the users sync skips it. Because a deleted account is scrubbed in place, this upsert is what
 * blanks its name, phone and email here (docs/matchday-api-facts.md, "A DELETED PLAYER IS SCRUBBED
 * IN PLACE"). */
async function upsertUsers(sb: SupabaseClient, rows: ApiPlayer[], syncedAt: string): Promise<void> {
  const unmapped = new Set<string>();
  const byId = new Map<number, UserRow>();
  for (const r of rows) { const m = mapUserRow(r, syncedAt, unmapped); if (m) byId.set(m.id, m); }
  const users = [...byId.values()];
  for (let i = 0; i < users.length; i += USER_BATCH) {
    const { error } = await sb.from("mdapi_users").upsert(users.slice(i, i + USER_BATCH), { onConflict: "id" });
    if (error) throw new Error(`mdapi_users upsert: ${error.message}`);
  }
}

/* THE END OF A PASS. Every page has been read; the pass is complete only if it saw at least
 * totalItems DISTINCT players. Only then are areas cleared (players we hold with an area whom this
 * pass saw without one) and the verdicts of players we hold but did not see recomputed when the
 * geometry moved. */
async function completePass(sb: SupabaseClient, runId: number, totalItems: number, geom: string,
  cities: AreaCity[], markets: Set<number>, t: { areas: number; inserted: number; updated: number; internal: number; apiCalls: number }): Promise<void> {
  const seenRows = await selectAll<{ player_id: number; has_area: boolean }>(() =>
    sb.from("player_area_pass_seen").select("player_id,has_area").eq("run_id", runId).order("player_id"));
  const distinct = seenRows.length;
  const complete = distinct >= totalItems;
  const base = { players_total: distinct, players_internal: t.internal, areas_seen: t.areas, api_calls: t.apiCalls };
  if (!complete) {
    await finishPass(sb, runId, { ok: false, stopReason: "error",
      error: `every page read but only ${distinct} distinct players of ${totalItems}: signups shifted the pages; nothing cleared`,
      extra: { ...base, rows_inserted: t.inserted, rows_updated: t.updated } as Partial<RunRow> });
    return;
  }
  const now = new Date().toISOString();
  const noArea = new Set(seenRows.filter((r) => !r.has_area).map((r) => r.player_id));
  const seenIds = new Set(seenRows.map((r) => r.player_id));
  const stored = await selectAll<AreaRow>(() => sb.from("player_area_seen").select("*").order("player_id"));
  const updates: AreaRow[] = [];
  for (const prev of stored) {
    if (prev.has_area && noArea.has(prev.player_id)) { updates.push({ ...prev, has_area: false, updated_at: now }); continue; }
    if (!seenIds.has(prev.player_id) && prev.verdict_geometry !== geom) {
      const v = computeVerdict(prev.lat, prev.lng, cities, markets);
      updates.push({ ...prev, verdict: v.verdict, verdict_city_id: v.verdictCityId,
        nearest_city_id: v.nearestCityId, nearest_city_mi: v.nearestCityMi, verdict_geometry: geom, updated_at: now });
    }
  }
  for (let i = 0; i < updates.length; i += WRITE_BATCH) {
    const { error } = await sb.from("player_area_seen").upsert(updates.slice(i, i + WRITE_BATCH), { onConflict: "player_id" });
    if (error) throw new Error(`player_area_seen clear: ${error.message}`);
  }
  await finishPass(sb, runId, { ok: true, stopReason: "complete",
    extra: { ...base, rows_inserted: t.inserted, rows_updated: t.updated + updates.length } as Partial<RunRow> });
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/* ── ACCOUNTS THE LIST NO LONGER RETURNS (night pass, after the full walk) ──────────────────────
 * /admin/players stops returning some accounts: the hidden-unverified ones (docs/matchday-api-facts.md,
 * "GET /admin/players HIDES ACCOUNTS WITH emailVerifiedAt NULL") and, it appears, accounts deleted since
 * they were last listed — on 2026-10-21, 9 mdapi_users rows (all October signups, all counted by the
 * Registrations card) had not been returned since 10-14..10-19 and none was scrubbed here, the same
 * count the Download players probe found unscrubbed. A full walk cannot blank what it is not given.
 *
 * So: every row the night's COMPLETE full pass did not return (synced_at before that pass started) is
 * re-read through the detail endpoint, GET /admin/players/{id}, which still serves it — at most
 * UNLISTED_MAX a night, least recently read first, paced. The name, email and phone are written back
 * (columns and the copies inside raw), so a deleted account's scrub lands here like any other.
 * A 404 marks the row raw.unlistedGoneAt and leaves it: the download blanks any row whose synced_at
 * predates the last complete pass (lib/signupExport.ts), so an account nobody can confirm is never
 * exported with its old address. A 404 does not stop the run; any other failure does. */
export const UNLISTED_MAX = 60;

export type UnlistedResult = { ok: boolean; skipped?: string; checked: number; refreshed: number; scrubbed: number; gone: number; apiCalls: number; error?: string };

export async function refreshUnlisted(sb: SupabaseClient, deps: { client?: PacedClient; now?: Date } = {}): Promise<UnlistedResult> {
  const now = deps.now ?? new Date();
  const out: UnlistedResult = { ok: false, checked: 0, refreshed: 0, scrubbed: 0, gone: 0, apiCalls: 0 };
  const pass = await sb.from("player_area_sync_runs").select("id,started_at,finished_at").eq("kind", "full").eq("ok", true)
    .order("id", { ascending: false }).limit(1).maybeSingle<{ id: number; started_at: string; finished_at: string }>();
  if (pass.error) throw new Error(`last full pass read failed: ${pass.error.message}`);
  if (!pass.data || now.getTime() - Date.parse(pass.data.finished_at) > 3 * 3600_000) {
    return { ...out, ok: true, skipped: "no complete full pass in the last 3 hours: without one, 'not returned' means nothing" };
  }
  const rows = await sb.from("mdapi_users").select("id,email,first_name,last_name,phone_number,raw")
    .lt("synced_at", pass.data.started_at).is("raw->>unlistedGoneAt", null)
    .order("synced_at", { ascending: true }).limit(UNLISTED_MAX);
  if (rows.error) throw new Error(`mdapi_users unlisted read failed: ${rows.error.message}`);
  const client = deps.client ?? getPacedClient({ stopsOn: (e) => !(e instanceof MatchdayApiError && e.status === 404) });
  try {
    for (const r of (rows.data ?? []) as { id: number; raw: Record<string, unknown> | null }[]) {
      out.checked++;
      const stamp = new Date().toISOString();
      let p: Record<string, unknown> | null;
      try {
        p = await client.get<Record<string, unknown>>(`/admin/players/${r.id}`);
      } catch (e) {
        if (!(e instanceof MatchdayApiError && e.status === 404)) throw e;
        out.gone++;
        const { error } = await sb.from("mdapi_users").update({ raw: { ...(r.raw ?? {}), unlistedGoneAt: stamp } }).eq("id", r.id);
        if (error) throw new Error(`mdapi_users ${r.id} gone-mark failed: ${error.message}`);
        continue;
      }
      const s = (v: unknown) => (typeof v === "string" ? v : null);
      const pii = { email: s(p?.email), firstName: s(p?.firstName), lastName: s(p?.lastName), phoneNumber: s(p?.phoneNumber) };
      if (!pii.email) throw new Error(`/admin/players/${r.id} came back without an email — refusing to write`);
      const { error } = await sb.from("mdapi_users").update({
        email: pii.email, first_name: pii.firstName, last_name: pii.lastName, phone_number: pii.phoneNumber,
        raw: { ...(r.raw ?? {}), ...pii, unlistedCheckedAt: stamp }, synced_at: stamp,
      }).eq("id", r.id);
      if (error) throw new Error(`mdapi_users ${r.id} update failed: ${error.message}`);
      out.refreshed++;
      if (pii.firstName === "Deleted" && pii.lastName === "Account") out.scrubbed++;
    }
    out.ok = true;
  } catch (e) {
    out.error = errText(e);
  }
  out.apiCalls = client.calls;
  return out;
}
