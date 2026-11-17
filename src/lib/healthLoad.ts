import "server-only"; // no-op under --conditions=react-server
// HEALTH: one period read live, the Gameday Ops board's way (src/app/api/matchday/[env]/gameday), then
// summarised (healthModel). The board pages /admin/matches for ONE wall-clock day; this pages it for a
// range (fromDate..toDate, the same parameters), then the same trimMatch, withVenueMaxPlayers and
// withSpots.
//
// GENTLE ON THE API (Ryan, 2026-11-17, after the warm job's reads took production down at 21:50 and
// 22:05 UTC: every period for every city scope, whole months paged 4 at a time, and a month that timed
// out was never cached, so every 5 minutes it was asked for again):
//   ONE READ PER RANGE FOR ALL CITIES. The cache holds the all-cities summary; a city-confined account
//     gets its city's row out of it (summarize groups by city, so the row IS that city's summary).
//   ONE REQUEST AT A TIME, ONE A SECOND, per server instance: every page of every range goes through
//     one queue, each starting PACE_MS after the previous one ended. Pages one after another, never
//     in parallel. The first failed page ends that range's read; nothing of it is cached.
//   ENDED PERIODS COME FROM THE CACHE: read once, the first time they are asked for after they end,
//     and kept with no expiry. Only the current week or month is ever read again (CURRENT_TTL_S, served
//     at once and refreshed in the background once stale).
//   A FAILED READ BACKS OFF: after a failure no MatchDay read is made for 15 minutes, then 30, 60 and
//     120 after further failures; a success resets it. While backing off, a stale copy is served and
//     its refresh is skipped. The backoff is per server instance (no table holds it).

import { revalidateTag, unstable_cache } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { apiGet, type MatchdayEnv } from "./matchdayStageApi";
import { fetchVenueMaxPlayers, trimMatch, withVenueMaxPlayers, type Raw } from "./gamedayApiShape";
import { withSpots } from "./gamedaySpots";
import { cityNameFor } from "./cityScope";
import { loadCancelFacts } from "./cancelReasonsLoad";
import { ratesOf, summarize, type HealthMatch, type PeriodSummary } from "./healthModel";

const PAGE_LIMIT = 100;
/** A month is about 7 pages; 20 is a ceiling, not a plan. */
const MAX_PAGES = 20;
export const HEALTH_PACE_MS = 1000;
const BACKOFF_MIN = [15, 30, 60, 120];

/* ── ONE QUEUE, ONE REQUEST A SECOND, BACK OFF ON FAILURE ─────────────────────────────────────── */
let queue: Promise<unknown> = Promise.resolve();
let lastEndMs = 0;
const backoff = new Map<MatchdayEnv, { until: number; failures: number; error: string }>();
let requestsMade = 0;
/** Requests this server instance has sent for Health (for the warm route's log line). */
export const healthRequestsMade = () => requestsMade;

export class HealthBackoffError extends Error {
  constructor(env: MatchdayEnv, b: { until: number; error: string }) {
    super(`MatchDay reads for Health are paused until ${new Date(b.until).toISOString()} after a failed read (${b.error})`);
    this.name = "HealthBackoffError";
    void env;
  }
}

/** The pause in force for this environment, or null. */
export function healthBackoff(env: MatchdayEnv): { until: number; error: string } | null {
  const b = backoff.get(env);
  return b && Date.now() < b.until ? b : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function paced<T>(env: MatchdayEnv, f: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const b = healthBackoff(env);
    if (b) throw new HealthBackoffError(env, b);
    const gap = lastEndMs + HEALTH_PACE_MS - Date.now();
    if (gap > 0) await sleep(gap);
    requestsMade++;
    try {
      const r = await f();
      backoff.delete(env);
      return r;
    } catch (e) {
      const failures = (backoff.get(env)?.failures ?? 0) + 1;
      const mins = BACKOFF_MIN[Math.min(failures - 1, BACKOFF_MIN.length - 1)];
      const msg = (e instanceof Error ? e.message : String(e)).split(" Body:")[0].slice(0, 160);
      backoff.set(env, { until: Date.now() + mins * 60_000, failures, error: msg });
      throw e;
    } finally {
      lastEndMs = Date.now();
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

/** The range, page after page through the queue. The first failure ends the read (it throws). */
async function readRange(env: MatchdayEnv, from: string, to: string): Promise<Raw[]> {
  const out: Raw[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await paced(env, () => apiGet<{ data?: Raw[]; totalItems?: number } | Raw[]>(env, "/admin/matches", {
      fromDate: from, toDate: to, page, limit: PAGE_LIMIT, sortColumn: "startDate", sortDirection: "asc",
    }));
    const rows = Array.isArray(res) ? res : (res.data ?? []);
    const total = Array.isArray(res) ? null : (res.totalItems ?? null);
    out.push(...rows);
    if (rows.length < PAGE_LIMIT) break;
    if (total != null && page * PAGE_LIMIT >= total) break;
  }
  return out;
}

export type LoadedPeriod = PeriodSummary & { spotsError: string | null; matches: number; cityMatches: Record<string, number>; readAt: string; cancelReasonsUnavailable: boolean };

/** All cities, read live. */
async function loadLive(sb: SupabaseClient, env: MatchdayEnv, from: string, to: string, nowMs: number): Promise<LoadedPeriod> {
  const raw = await readRange(env, from, to);
  const matches = raw.map(trimMatch);
  /* THE FIELD ROW IS THE VENUE (fin_venue_fields), as Field Ops and the Figma name it ("NEMP" holds
   * NEMP Discounted and NEMP Tournaments); a field with no venue stands as its own row. */
  const [links, venues] = await Promise.all([
    sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id"),
    sb.from("fin_venues").select("id, venue_name"),
  ]);
  if (links.error || venues.error) throw new Error(`venues: ${(links.error ?? venues.error)!.message}`);
  const venueName = new Map<number, string>((venues.data ?? []).map((v) => [Number(v.id), String(v.venue_name ?? "")]));
  const venueOf = new Map<number, number>((links.data ?? []).map((l) => [Number(l.mdapi_field_id), Number(l.fin_venue_id)]));
  const withVenue = matches.map((m) => {
    const v = m.fieldId != null ? venueOf.get(m.fieldId) : undefined;
    return { ...m, rowKey: v != null ? `v${v}` : `f${m.fieldId ?? m.field?.title ?? "?"}`, rowName: (v != null ? venueName.get(v) : null) || m.field?.title || `Field ${m.fieldId ?? "?"}` };
  });
  const decorated = withVenueMaxPlayers(withVenue, await fetchVenueMaxPlayers(sb));
  const { matches: withCounts, spotsError } = await withSpots(sb, decorated, raw);
  const cancelledIds = withCounts.filter((m) => m.isCancelled).map((m) => m.id);
  const facts = await loadCancelFacts(sb, env, cancelledIds);
  const updatedAtOf = new Map<number, string | null>();
  for (const r of raw as { id?: unknown; updatedAt?: unknown }[]) updatedAtOf.set(Number(r.id), typeof r.updatedAt === "string" ? r.updatedAt : null);
  const s = summarize(from, to, withCounts as unknown as HealthMatch[], { updatedAtOf, stored: facts.stored, logged: facts.logged }, nowMs);
  const cityMatches: Record<string, number> = {};
  for (const m of withCounts as unknown as HealthMatch[]) { const k = m.field?.city?.name ?? "No city"; cityMatches[k] = (cityMatches[k] ?? 0) + 1; }
  return { ...s, spotsError, matches: withCounts.length, cityMatches, readAt: new Date(nowMs).toISOString(), cancelReasonsUnavailable: facts.storedUnavailable };
}

/** One city's view of the all-cities summary: its row, and a total that is that row. The old per-scope
 *  read filtered the matches to the city before summarize, which gives exactly this. */
function forScope(p: LoadedPeriod, scopeCity: string | null): LoadedPeriod {
  if (!scopeCity) return p;
  const want = cityNameFor(scopeCity);
  const row = want ? p.cities.find((c) => c.city === want) : undefined;
  if (!row) {
    const empty = ratesOf([], { updatedAtOf: new Map(), stored: new Map(), logged: new Set() }, 0);
    return { ...p, cities: [], total: { ...empty, reasonLine: "" }, matches: 0 };
  }
  const { city: _c, fields: _f, ...rates } = row;
  void _c; void _f;
  return { ...p, cities: [row], total: rates, matches: p.cityMatches[want!] ?? 0 };
}

export const CURRENT_TTL_S = 5 * 60;
export const RECENT_TTL_S = 3600;
export const ENDED_TTL_S = 7 * 24 * 3600;
const addDaysYmd = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** The Players page's cache lives (appPlayers); Health no longer uses them for ended periods. */
export const ttlFor = (to: string, current: boolean, today: string) => (current ? CURRENT_TTL_S : to >= addDaysYmd(today, -2) ? RECENT_TTL_S : ENDED_TTL_S);

class NotCached extends Error {}
const inflight = new Map<string, Promise<LoadedPeriod>>();

/** The all-cities period: the cache, or one live read (shared by concurrent callers on this instance).
 *  cacheOnly: never read; null when the cache does not hold it. */
async function sharedPeriod(sb: SupabaseClient, env: MatchdayEnv, from: string, to: string, current: boolean, cacheOnly: boolean): Promise<(LoadedPeriod & { cached: boolean }) | null> {
  const key = `${env}:${from}:${to}:${current ? "current" : "ended"}`;
  let live = false;
  const cached = unstable_cache(
    async () => {
      if (cacheOnly) throw new NotCached();
      live = true;
      let p = inflight.get(key);
      if (!p) { p = loadLive(sb, env, from, to, Date.now()).finally(() => inflight.delete(key)); inflight.set(key, p); }
      return p;
    },
    ["health-range-v5", current ? "current" : "ended", env, from, to],
    // Ended: no expiry; it is read once. Current: stale after CURRENT_TTL_S, refreshed in the background.
    { revalidate: current ? CURRENT_TTL_S : false, tags: ["health", `health:${env}:${from}:${to}`] },
  );
  try {
    const r = await cached();
    return { ...r, cached: !live };
  } catch (e) {
    if (e instanceof NotCached) return null;
    throw e;
  }
}

/** A period for a scope (null = all cities). `fresh` (pull to refresh) re-reads only the CURRENT period,
 *  only when its copy is over a minute old, and never while reads are backing off. */
export async function loadPeriod(sb: SupabaseClient, env: MatchdayEnv, from: string, to: string, scopeCity: string | null, current: boolean, fresh = false): Promise<LoadedPeriod & { cached: boolean }> {
  let r = await sharedPeriod(sb, env, from, to, current, false);
  if (fresh && current && r && r.cached && !healthBackoff(env) && Date.now() - Date.parse(r.readAt) > 60_000) {
    revalidateTag(`health:${env}:${from}:${to}`, { expire: 0 });
    r = await sharedPeriod(sb, env, from, to, current, false);
  }
  return { ...forScope(r!, scopeCity), cached: r!.cached };
}

/** From the cache only: null when it is not there. Never reads the API. */
export async function cachedPeriod(sb: SupabaseClient, env: MatchdayEnv, from: string, to: string, scopeCity: string | null, current: boolean): Promise<(LoadedPeriod & { cached: boolean }) | null> {
  const r = await sharedPeriod(sb, env, from, to, current, true);
  return r ? { ...forScope(r, scopeCity), cached: true } : null;
}
