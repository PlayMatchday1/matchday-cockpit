// Sync GET /admin/players → player_area_seen. Server-only. READS MatchDay, writes only Supabase.
//
// WHY A FULL WALK EVERY PASS. Setting a home area is an EDIT to an existing player, and the API has
// no updatedAt and silently ignores unknown sort columns (docs/matchday-api-facts.md, "Player
// location / home area"), so there is no way to ask "who changed since". This walk is what makes
// first_seen_at accurate to one pass interval.
//
// ── THE RULES OF THE WALK (Ryan, 2026-10-08, after three outages in one day) ─────────────────────
// The seeding attempt (limit=1000, oldest first) died on page 8 with 503s; the 00:40 UTC cron
// (limit=250, newest first, half a second apart) died on page 113 with a 503. So:
//   1. limit=50, NEWEST FIRST. A signup mid-walk shifts rows down, so DISTINCT ids are counted
//      against the API's totalItems (player_area_pass_seen), and only a pass that has read EVERY
//      page with at least totalItems distinct ids may mark anyone's area as cleared.
//   2. 2 seconds between pages.
//   3. RESUMABLE. ~700 pages × ~2.3 s ≈ 30 minutes, longer than one function run, so a pass is a
//      chain of LEGS. A leg reads pages until LEG_BUDGET_MS is spent, saves next_page on the run
//      row, and the route hands on to the next leg (see the route for the chaining). Each page's
//      players are written as they arrive, so a pass that stops part way has still recorded what
//      it read — it just clears nobody.
//   4. HEALTH CHECK before every 10th page: one limit=1 request, timed. Over 5 seconds, or any
//      failure, stops the pass: "stopped, server under strain". The next scheduled pass starts fresh.
//   5. NO RETRIES. Every call passes maxRetries: 0. The first 5xx, network error or bad body stops
//      the pass, logged failed.
//   6. NO EVENING RUNS. Between 22:00 and 04:00 UTC (5 PM to 11 PM Central) nothing starts, and a
//      leg that reaches 22:00 stops the pass: "stopped, evening match hours".
//   7. Never two legs at once — the run row's heartbeat is the lock (claimPass / claimLeg).
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
import { getMatchdayApiClient } from "./matchdayApi";
import { selectAll } from "./supabasePagination";
import {
  computeVerdict, geometryKey, hasArea, isInternalEmail, usCities, zipOf, type AreaCity,
} from "./playerAreaModel";
import { stateForPoint } from "./usState";
import { activeFields } from "./locationsMap";
import { fetchFieldSnapshots } from "./locationsData";

export const PAGE_LIMIT = 50;
export const INTER_PAGE_DELAY_MS = 2000;
/** Walking time per leg. The route's maxDuration is 300 s; the rest is the leg's writes and the hand-on. */
export const LEG_BUDGET_MS = 230_000;
const HEALTH_EVERY = 10;
const HEALTH_MAX_MS = 5000;
const WRITE_BATCH = 500;
const NO_RETRY = { maxRetries: 0 } as const;
/** A pass whose heartbeat is older than this has stalled (a leg was killed or the hand-on failed):
 *  it no longer holds the lock. Longer than one leg, so a live leg is never mistaken for dead. */
export const LOCK_WINDOW_MS = 6 * 60 * 1000;

/* ── THE EVENING BLOCK, 22:00–04:00 UTC ─────────────────────────────────────────────────────────── */
export const EVENING_FROM_UTC = 22, EVENING_TO_UTC = 4;
export function inEveningBlock(now: Date): boolean {
  const h = now.getUTCHours();
  return h >= EVENING_FROM_UTC || h < EVENING_TO_UTC;
}
export const EVENING_MESSAGE = "No location syncs between 5 PM and 11 PM Central (22:00 to 04:00 UTC), when matches are on.";

type ApiPlayer = {
  id?: number; email?: string | null; zipCode?: unknown; lat?: unknown; lng?: unknown;
  areaLabel?: unknown; areaSource?: unknown;
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
  is_internal: boolean;
  verdict: "in_market" | "waitlist" | "unidentified";
  verdict_city_id: number | null;
  nearest_city_id: number | null;
  nearest_city_mi: number | null;
  verdict_geometry: string;
  updated_at: string;
};

const COMPARED: (keyof AreaRow)[] = [
  "has_area", "zip", "lat", "lng", "area_label", "area_source", "state", "is_internal",
  "verdict", "verdict_city_id", "nearest_city_id", "nearest_city_mi", "verdict_geometry",
];

export type StopReason = "complete" | "strain" | "evening" | "error" | "stalled";

export type RunRow = {
  id: number; started_at: string; finished_at: string | null; ok: boolean | null; triggered_by: string;
  next_page: number | null; pages_total: number | null; page_size: number | null; legs: number;
  heartbeat_at: string | null; stop_reason: StopReason | null; players_total: number | null;
  api_calls: number | null; areas_seen: number | null; rows_inserted: number | null; rows_updated: number | null;
  players_internal: number | null; cities: unknown; error: string | null;
};
const RUN_COLS = "id,started_at,finished_at,ok,triggered_by,next_page,pages_total,page_size,legs,heartbeat_at,stop_reason,players_total,api_calls,areas_seen,rows_inserted,rows_updated,players_internal,cities,error";

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
    next_page: 1, page_size: PAGE_LIMIT, legs: 0, api_calls: 0,
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
    complete: f.stopReason === "complete", error: f.error ?? null, next_page: null,
  }).eq("id", runId);
  // The pass's seen-set has done its job (or can no longer be used): drop it.
  await sb.from("player_area_pass_seen").delete().eq("run_id", runId);
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

  const stop = async (reason: StopReason, error: string) => {
    await finishPass(sb, runId, { ok: false, stopReason: reason, error,
      extra: { api_calls: (run.api_calls ?? 0) + apiCalls } as Partial<RunRow> });
    return { ...out, ok: false, stopReason: reason, error };
  };

  let apiCalls = 0;
  let page = run.next_page ?? 1;
  try {
    if (inEveningBlock(new Date())) return await stop("evening", `stopped, evening match hours (before page ${page})`);
    const client = getMatchdayApiClient();

    // THE GEOMETRY, once per pass: the first leg reads /admin/cities and keeps it on the run row.
    let cities: AreaCity[] = Array.isArray(run.cities) && run.cities.length ? (run.cities as AreaCity[]) : [];
    if (cities.length === 0) {
      apiCalls++;
      const raw = await client.get<unknown>("/admin/cities", undefined, NO_RETRY);
      cities = usCities(Array.isArray(raw) ? raw : []);
      if (cities.length === 0) throw new Error("/admin/cities returned no US city with lat/lng/radiusMiles — refusing to compute verdicts");
      await sb.from("player_area_sync_runs").update({ cities }).eq("id", runId);
    }
    const { fields: liveFields } = activeFields(await fetchFieldSnapshots(sb), cities);
    const markets = new Set(liveFields.map((f) => f.cityId));
    if (markets.size === 0) throw new Error("no active field in any city — refusing to compute statuses");
    const geom = geometryKey(cities, markets);
    const bootstrap = await isBootstrap(sb);

    let totalItems = run.players_total ?? 0;
    let pagesTotal = run.pages_total;
    let tally = { areas: run.areas_seen ?? 0, inserted: run.rows_inserted ?? 0, updated: run.rows_updated ?? 0, internal: run.players_internal ?? 0 };
    let walkEnded = false;

    while (Date.now() - t0 < LEG_BUDGET_MS) {
      if (inEveningBlock(new Date())) return await stop("evening", `stopped, evening match hours (before page ${page})`);
      // Rule 4: the health check, before every 10th page (and before the first page of a pass).
      if (page === 1 || page % HEALTH_EVERY === 0) {
        const h0 = Date.now();
        apiCalls++;
        try {
          await client.get<ApiPage>("/admin/players", { page: 1, limit: 1, sortColumn: "createdAt", sortDirection: "desc" }, NO_RETRY);
        } catch (e) {
          return await stop("strain", `stopped, server under strain: the limit=1 check before page ${page} failed (${e instanceof Error ? e.message : String(e)})`);
        }
        const ms = Date.now() - h0;
        if (ms > HEALTH_MAX_MS) return await stop("strain", `stopped, server under strain: the limit=1 check before page ${page} took ${(ms / 1000).toFixed(1)} s`);
        await sleep(INTER_PAGE_DELAY_MS);
      }

      apiCalls++;
      const res = await client.get<ApiPage>("/admin/players",
        { page, limit: PAGE_LIMIT, sortColumn: "createdAt", sortDirection: "desc" }, NO_RETRY);
      if (page === 1) {
        totalItems = typeof res.totalItems === "number" ? res.totalItems : 0;
        if (totalItems === 0) throw new Error("/admin/players returned totalItems 0");
        pagesTotal = Math.ceil(totalItems / PAGE_LIMIT);
      }
      const rows = (Array.isArray(res.data) ? res.data : []).filter((r) => typeof r.id === "number");
      const w = await writePage(sb, runId, rows, { cities, markets, geom, bootstrap });
      tally = { areas: tally.areas + w.areas, inserted: tally.inserted + w.inserted, updated: tally.updated + w.updated, internal: tally.internal + w.internal };
      out.pagesRead++;
      page++;
      // Progress and heartbeat, on the run row: the Sync now button reads these.
      const hb = await sb.from("player_area_sync_runs").update({
        next_page: page, pages_total: pagesTotal, players_total: totalItems, heartbeat_at: new Date().toISOString(),
        api_calls: (run.api_calls ?? 0) + apiCalls, areas_seen: tally.areas, rows_inserted: tally.inserted,
        rows_updated: tally.updated, players_internal: tally.internal,
      }).eq("id", runId);
      if (hb.error) throw new Error(`progress write failed: ${hb.error.message}`);
      if (rows.length < PAGE_LIMIT) { walkEnded = true; break; }
      if (pagesTotal != null && page > pagesTotal + 2) { walkEnded = true; break; } // runaway guard
      await sleep(INTER_PAGE_DELAY_MS);
    }

    if (!walkEnded) { out.ok = true; out.more = true; return out; }
    await completePass(sb, runId, totalItems, geom, cities, markets, { ...tally, apiCalls: (run.api_calls ?? 0) + apiCalls });
    out.ok = true;
    out.stopReason = "complete";
    return out;
  } catch (e) {
    // Rule 5: one failure ends the pass. No page is asked for twice; the next scheduled pass retries.
    return await stop("error", `stopped on page ${page}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function isBootstrap(sb: SupabaseClient): Promise<boolean> {
  const prior = await sb.from("player_area_sync_runs").select("id", { count: "exact", head: true }).eq("ok", true);
  if (prior.error) throw new Error(prior.error.message);
  if ((prior.count ?? 0) > 0) return false;
  const stored = await sb.from("player_area_seen").select("player_id", { count: "exact", head: true });
  if (stored.error) throw new Error(stored.error.message);
  return (stored.count ?? 0) === 0;
}

/* ONE PAGE: remember who was seen (for the distinct count and the end-of-pass clearing), and write
 * the area rows that changed. Clearing is NOT done here — a player seen without an area is only
 * recorded, and cleared by completePass once every page has been read. */
async function writePage(sb: SupabaseClient, runId: number, rows: ApiPlayer[], g: {
  cities: AreaCity[]; markets: Set<number>; geom: string; bootstrap: boolean;
}): Promise<{ areas: number; inserted: number; updated: number; internal: number }> {
  const now = new Date().toISOString();
  const seen = rows.map((p) => ({ run_id: runId, player_id: p.id as number, has_area: hasArea(p) }));
  if (seen.length) {
    const { error } = await sb.from("player_area_pass_seen").upsert(seen, { onConflict: "run_id,player_id" });
    if (error) throw new Error(`player_area_pass_seen: ${error.message}`);
  }
  const withArea = rows.filter(hasArea);
  const ids = withArea.map((p) => p.id as number);
  const stored = ids.length
    ? await sb.from("player_area_seen").select("*").in("player_id", ids)
    : { data: [] as AreaRow[], error: null };
  if (stored.error) throw new Error(`player_area_seen read: ${stored.error.message}`);
  const byId = new Map(((stored.data ?? []) as AreaRow[]).map((r) => [r.player_id, r]));
  const inserts: AreaRow[] = [], updates: AreaRow[] = [];
  for (const p of withArea) {
    const id = p.id as number;
    const prev = byId.get(id);
    const v = computeVerdict(p.lat, p.lng, g.cities, g.markets);
    const lat = num(p.lat), lng = num(p.lng);
    const next: AreaRow = {
      player_id: id, first_seen_at: prev?.first_seen_at ?? now, seeded: prev?.seeded ?? g.bootstrap, has_area: true,
      zip: zipOf(p.zipCode), lat, lng, area_label: str(p.areaLabel), area_source: str(p.areaSource),
      state: lat != null && lng != null ? stateForPoint(lat, lng) : null,
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
  return { areas: withArea.length, inserted: inserts.length, updated: updates.length, internal: rows.filter((p) => isInternalEmail(p.email)).length };
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
