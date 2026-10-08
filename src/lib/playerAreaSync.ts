// Sync GET /admin/players → player_area_seen. Server-only. READS MatchDay, writes only Supabase.
//
// WHY A FULL WALK EVERY RUN. Setting a home area is an EDIT to an existing player, and the API has
// no updatedAt and silently ignores unknown sort columns (docs/matchday-api-facts.md, "Player
// location / home area"), so there is no way to ask "who changed since". mdapi_users' hourly walk
// is createdAt-only and its full walk is daily — an area set at 10:00 would surface tomorrow. This
// walk is what makes first_seen_at accurate to one sync interval (6 hours).
//
// ── THE RULES OF THE WALK (Ryan, 2026-10-08, after a 503 storm) ──────────────────────────────────
// The first seeding attempt walked limit=1000 OLDEST FIRST. Pages 1-7 landed, page 8 returned 503
// four times (the shared client's retries), and moments later the production API was refusing
// sign-in. Whether this walk caused that is UNKNOWN — every player row carries its `matches`, so the
// oldest players make the heaviest pages. So:
//   1. limit=250, NEWEST FIRST — the page size and order the daily mdapi_users walk has run for
//      months. A signup mid-walk shifts rows down one, so DISTINCT IDS are counted against the
//      API's totalItems, and only a complete walk may mark anyone's area as cleared.
//   2. Every 6 hours at :40 UTC (vercel.json, set by Ryan after reviewing dyno memory from the
//      seeding run). Never more often than hourly.
//   3. ~half a second between page requests.
//   4. NO RETRIES. Every call passes maxRetries: 0 (including the sign-in it may trigger). The first
//      5xx, network error or bad body aborts the whole run, which is logged failed. The next
//      scheduled run is the retry.
//   5. After a failed (or killed) run, the next run first makes ONE limit=1 read, and walks only
//      if that succeeds.
//   6. Never two passes at once — see claimRun().
//
// WRITES ONLY WHAT CHANGED. A row is upserted when one of its values differs from what is stored —
// which includes every row when the city geometry (any centre or radius) changes, since
// verdict_geometry is part of the comparison. That is the "recompute for everyone" rule.
//
// SEEDING. The first successful run marks every area it finds seeded = true: those areas were set
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

export const PAGE_LIMIT = 250;
const INTER_PAGE_DELAY_MS = 500;
const WRITE_BATCH = 500;
const NO_RETRY = { maxRetries: 0 } as const;
// A run cannot outlive the route's maxDuration (300s). An unfinished row older than this is a run
// that was killed, not one in progress — it no longer holds the lock, and it counts as a failure.
export const LOCK_WINDOW_MS = 6 * 60 * 1000;

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
  /** Two-letter US state from lat/lng against Census boundaries (usState.ts); null = outside every
   *  state or no coordinates. Migration 0216. */
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
  // `state` is compared, so rows stored before 0216 (state undefined → null) fill in on the next run.
  "has_area", "zip", "lat", "lng", "area_label", "area_source", "state", "is_internal",
  "verdict", "verdict_city_id", "nearest_city_id", "nearest_city_mi", "verdict_geometry",
];

export type PlayerAreaSyncResult = {
  ok: boolean;
  skipped?: string;
  runId: number | null;
  bootstrap: boolean;
  probed: boolean;
  playersTotal: number;
  distinctIds: number;
  apiTotalItems: number;
  playersInternal: number;
  complete: boolean;
  areasSeen: number;
  rowsInserted: number;
  rowsUpdated: number;
  apiCalls: number;
  durationMs: number;
  error?: string;
};

type RunRow = { id: number; started_at: string; finished_at: string | null; ok: boolean | null };

/* THE LOCK, without DDL. Insert our row, THEN look for an OLDER unfinished run inside the lock
 * window. If there is one, delete our row and stand down. Two runs starting together both insert
 * and both look: only the higher id sees an older one, so exactly one proceeds — the lower id never
 * yields. A killed run's row stays unfinished forever, which is why the window bounds it. */
async function claimRun(supabase: SupabaseClient, triggeredBy: "cron" | "manual", nowIso: string):
  Promise<{ runId: number; previous: RunRow | null } | { skipped: string }> {
  const ins = await supabase.from("player_area_sync_runs")
    .insert({ triggered_by: triggeredBy, started_at: nowIso }).select("id").single<{ id: number }>();
  if (ins.error) throw new Error(`player_area_sync_runs insert failed: ${ins.error.message}`);
  const runId = ins.data.id;

  const older = await supabase.from("player_area_sync_runs")
    .select("id,started_at,finished_at,ok").lt("id", runId).order("id", { ascending: false }).limit(20);
  if (older.error) {
    await supabase.from("player_area_sync_runs").delete().eq("id", runId);
    throw new Error(`player_area_sync_runs lock read failed: ${older.error.message}`);
  }
  const rows = (older.data ?? []) as RunRow[];
  const cutoff = Date.parse(nowIso) - LOCK_WINDOW_MS;
  const running = rows.find((r) => r.finished_at == null && Date.parse(r.started_at) >= cutoff);
  if (running) {
    await supabase.from("player_area_sync_runs").delete().eq("id", runId);
    return { skipped: `run ${running.id} (started ${running.started_at}) is still in progress` };
  }
  return { runId, previous: rows[0] ?? null };
}

export async function syncPlayerAreas(
  supabase: SupabaseClient,
  triggeredBy: "cron" | "manual",
): Promise<PlayerAreaSyncResult> {
  const t0 = Date.now();
  const now = new Date().toISOString();
  let apiCalls = 0;

  const result: PlayerAreaSyncResult = {
    ok: false, runId: null, bootstrap: false, probed: false, playersTotal: 0, distinctIds: 0,
    apiTotalItems: 0, playersInternal: 0, complete: false, areasSeen: 0, rowsInserted: 0,
    rowsUpdated: 0, apiCalls: 0, durationMs: 0,
  };

  const claim = await claimRun(supabase, triggeredBy, now);
  if ("skipped" in claim) {
    return { ...result, ok: true, skipped: claim.skipped, durationMs: Date.now() - t0 };
  }
  const runId = claim.runId;
  result.runId = runId;
  let cities: AreaCity[] = [];

  try {
    const client = getMatchdayApiClient();

    // Rule 5: after a failed or killed run, one tiny read decides whether we walk at all.
    // (An unfinished previous row is outside the lock window by now, so it was killed.)
    if (claim.previous && claim.previous.ok !== true) {
      result.probed = true;
      apiCalls++;
      await client.get<ApiPage>("/admin/players",
        { page: 1, limit: 1, sortColumn: "createdAt", sortDirection: "desc" }, NO_RETRY);
      await sleep(INTER_PAGE_DELAY_MS);
    }

    apiCalls++;
    const rawCities = await client.get<unknown>("/admin/cities", undefined, NO_RETRY);
    cities = usCities(Array.isArray(rawCities) ? rawCities : []);
    if (cities.length === 0) throw new Error("/admin/cities returned no US city with lat/lng/radiusMiles — refusing to compute verdicts");
    const geom = geometryKey(cities);

    // --- walk every player, newest first ---
    // TODO(api): Vitalii is adding a set-at timestamp and a "changed location since <time>" filter
    // to GET /admin/players. When it ships, this full ~140-page walk gets replaced by one filtered
    // read since the last successful run — and first_seen_at by the real set time. Not built
    // against yet: the filter's name and semantics are not in evidence (docs/matchday-api-facts.md).
    const seen = new Map<number, ApiPlayer>();
    let totalItems = 0;
    for (let page = 1; ; page++) {
      await sleep(INTER_PAGE_DELAY_MS);
      apiCalls++;
      const res = await client.get<ApiPage>("/admin/players",
        { page, limit: PAGE_LIMIT, sortColumn: "createdAt", sortDirection: "desc" }, NO_RETRY);
      if (page === 1) totalItems = typeof res.totalItems === "number" ? res.totalItems : 0;
      const rows = Array.isArray(res.data) ? res.data : [];
      for (const r of rows) if (typeof r.id === "number") seen.set(r.id, r);
      /* LIVE PROGRESS for the Sync now button, written to the run row's own counters rather than new
       * columns: WHILE A RUN IS UNFINISHED, api_calls = player pages fetched so far and players_total =
       * the API's totalItems (so pages total = ceil(players_total / 250)). The final update below
       * overwrites both with their real meanings. Supabase only; a failed progress write is ignored —
       * it must never cost the run. */
      await supabase.from("player_area_sync_runs")
        .update({ api_calls: page, players_total: totalItems }).eq("id", runId)
        .then(() => undefined, () => undefined);
      if (rows.length < PAGE_LIMIT) break;
      if (page >= Math.ceil(totalItems / PAGE_LIMIT) + 2) break; // runaway guard
    }
    if (totalItems === 0 || seen.size === 0) throw new Error("/admin/players returned no players");
    result.apiTotalItems = totalItems;
    result.distinctIds = seen.size;
    result.playersTotal = seen.size;
    // Rule 1: a signup mid-walk shifts newest-first pages, which can duplicate one row and skip
    // another. Only a walk that saw at least totalItems DISTINCT ids may clear anyone's area.
    result.complete = seen.size >= totalItems;
    for (const p of seen.values()) if (isInternalEmail(p.email)) result.playersInternal++;

    // --- what we already hold ---
    const stored = await selectAll<AreaRow>(() =>
      supabase.from("player_area_seen").select("*").order("player_id"));
    const byId = new Map(stored.map((r) => [r.player_id, r]));

    const prior = await supabase.from("player_area_sync_runs")
      .select("id", { count: "exact", head: true }).eq("ok", true);
    if (prior.error) throw new Error(prior.error.message);
    result.bootstrap = (prior.count ?? 0) === 0 && stored.length === 0;

    const inserts: AreaRow[] = [];
    const updates: AreaRow[] = [];

    for (const p of seen.values()) {
      const id = p.id as number;
      const prev = byId.get(id);
      if (!hasArea(p)) {
        // Seen WITHOUT an area: if we held one, it was cleared — but only a complete walk may say so.
        if (prev && prev.has_area && result.complete) updates.push({ ...prev, has_area: false, updated_at: now });
        continue;
      }
      result.areasSeen++;
      const v = computeVerdict(p.lat, p.lng, cities);
      const next: AreaRow = {
        player_id: id,
        first_seen_at: prev?.first_seen_at ?? now,
        seeded: prev?.seeded ?? result.bootstrap,
        has_area: true,
        zip: zipOf(p.zipCode),
        lat: num(p.lat),
        lng: num(p.lng),
        area_label: str(p.areaLabel),
        area_source: str(p.areaSource),
        state: num(p.lat) != null && num(p.lng) != null ? stateForPoint(num(p.lat)!, num(p.lng)!) : null,
        is_internal: isInternalEmail(p.email),
        verdict: v.verdict,
        verdict_city_id: v.verdictCityId,
        nearest_city_id: v.nearestCityId,
        nearest_city_mi: v.nearestCityMi,
        verdict_geometry: geom,
        updated_at: now,
      };
      if (!prev) inserts.push(next);
      else if (COMPARED.some((k) => prev[k] !== next[k])) updates.push(next);
    }

    // Players we hold but did not see this run: recompute only their verdict when the geometry
    // moved, from the coordinates we stored.
    for (const prev of stored) {
      if (seen.has(prev.player_id) || prev.verdict_geometry === geom) continue;
      const v = computeVerdict(prev.lat, prev.lng, cities);
      updates.push({ ...prev, verdict: v.verdict, verdict_city_id: v.verdictCityId,
        nearest_city_id: v.nearestCityId, nearest_city_mi: v.nearestCityMi, verdict_geometry: geom, updated_at: now });
    }

    for (let i = 0; i < inserts.length; i += WRITE_BATCH) {
      const { error } = await supabase.from("player_area_seen")
        .upsert(inserts.slice(i, i + WRITE_BATCH), { onConflict: "player_id", ignoreDuplicates: true });
      if (error) throw new Error(`player_area_seen insert: ${error.message}`);
    }
    for (let i = 0; i < updates.length; i += WRITE_BATCH) {
      const { error } = await supabase.from("player_area_seen")
        .upsert(updates.slice(i, i + WRITE_BATCH), { onConflict: "player_id" });
      if (error) throw new Error(`player_area_seen update: ${error.message}`);
    }
    result.rowsInserted = inserts.length;
    result.rowsUpdated = updates.length;
    result.ok = true;
  } catch (e) {
    // Rule 4: one failure ends the run. No page is asked for twice; the next scheduled run retries.
    result.error = e instanceof Error ? e.message : String(e);
  }

  result.apiCalls = apiCalls;
  result.durationMs = Date.now() - t0;
  const fin = await supabase.from("player_area_sync_runs").update({
    finished_at: new Date().toISOString(),
    ok: result.ok,
    players_total: result.playersTotal,
    players_internal: result.playersInternal,
    complete: result.complete,
    areas_seen: result.areasSeen,
    rows_inserted: result.rowsInserted,
    rows_updated: result.rowsUpdated,
    api_calls: apiCalls,
    cities,
    error: result.error ?? null,
  }).eq("id", runId);
  if (fin.error) {
    result.ok = false;
    result.error = `${result.error ? result.error + "; " : ""}run row update failed: ${fin.error.message}`;
  }
  return result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
