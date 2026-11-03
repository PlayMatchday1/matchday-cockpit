import "server-only"; // no-op under --conditions=react-server
// HEALTH: one period read live, the Gameday Ops board's way (src/app/api/matchday/[env]/gameday), then
// summarised (healthModel). The board pages /admin/matches for ONE wall-clock day; this pages it for a
// range (fromDate..toDate, the same parameters), then the same trimMatch, the same city filter for a
// confined account BEFORE anything is decorated, withVenueMaxPlayers and withSpots.
//
// CACHED (Ryan, 2026-11-01; lengths 2026-11-02), in the Next.js data cache, keyed by environment,
// dates and city scope:
//   a period that ended more than 2 days ago   7 days (it does not change);
//   a period that ended in the last 2 days     1 hour (late cancels and syncs can still land);
//   the current period                         5 minutes, served at once and refreshed in the
//                             background once stale (unstable_cache is stale-while-revalidate), and
//                             kept warm by /api/app/cron/warm. A pull to refresh (fresh) expires it
//                             first, so that read is live and becomes the cached copy.
//
// THE RANGE IS READ IN PARALLEL: page 1 says how many matches there are, then every other page is
// asked for at once (4 at a time) and put back in page order. A month was 7 pages one after another,
// 612 matches and 9.5 MB with their rosters, 16 s measured from a laptop.

import { revalidateTag, unstable_cache } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { apiGet, type MatchdayEnv } from "./matchdayStageApi";
import { fetchVenueMaxPlayers, trimMatch, withVenueMaxPlayers, type Raw } from "./gamedayApiShape";
import { withSpots } from "./gamedaySpots";
import { cityNameFor } from "./cityScope";
import { loadCancelFacts } from "./cancelReasonsLoad";
import { summarize, type HealthMatch, type PeriodSummary } from "./healthModel";
import { todayBusinessDate } from "./goalPace";

const PAGE_LIMIT = 100;

async function readRange(env: MatchdayEnv, from: string, to: string): Promise<Raw[]> {
  const pageOf = async (page: number) => {
    const res = await apiGet<{ data?: Raw[]; totalItems?: number }>(env, "/admin/matches", {
      fromDate: from, toDate: to, page, limit: PAGE_LIMIT, sortColumn: "startDate", sortDirection: "asc",
    });
    return { rows: Array.isArray(res) ? (res as Raw[]) : (res.data ?? []), total: Array.isArray(res) ? null : (res.totalItems ?? null) };
  };
  const first = await pageOf(1);
  if (first.rows.length < PAGE_LIMIT) return first.rows;
  if (first.total == null) {
    // No total to plan from: one page after another, as before.
    const out = [...first.rows];
    for (let page = 2; page <= 60; page++) {
      const r = await pageOf(page);
      out.push(...r.rows);
      if (r.rows.length < PAGE_LIMIT) break;
    }
    return out;
  }
  const pages = Math.min(60, Math.ceil(first.total / PAGE_LIMIT));
  const rest: Raw[][] = new Array(Math.max(0, pages - 1));
  for (let i = 2; i <= pages; i += 4) {
    const batch = await Promise.all([i, i + 1, i + 2, i + 3].filter((n) => n <= pages).map((n) => pageOf(n)));
    batch.forEach((r, k) => { rest[i - 2 + k] = r.rows; });
  }
  return [first.rows, ...rest].flat();
}

export type LoadedPeriod = PeriodSummary & { spotsError: string | null; matches: number; readAt: string; cancelReasonsUnavailable: boolean };

async function loadLive(sb: SupabaseClient, env: MatchdayEnv, from: string, to: string, scopeCity: string | null, nowMs: number): Promise<LoadedPeriod> {
  const raw = await readRange(env, from, to);
  let matches = raw.map(trimMatch);
  if (scopeCity) {
    const want = cityNameFor(scopeCity);
    matches = matches.filter((m) => (m.field?.city?.name ?? null) === want);
  }
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
  return { ...s, spotsError, matches: withCounts.length, readAt: new Date(nowMs).toISOString(), cancelReasonsUnavailable: facts.storedUnavailable };
}

export const CURRENT_TTL_S = 5 * 60;
export const RECENT_TTL_S = 3600;
export const ENDED_TTL_S = 7 * 24 * 3600;
const addDaysYmd = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** The cache life of a period: current 5 minutes, ended in the last 2 days 1 hour, older 7 days. */
export const ttlFor = (to: string, current: boolean, today: string) => (current ? CURRENT_TTL_S : to >= addDaysYmd(today, -2) ? RECENT_TTL_S : ENDED_TTL_S);

/** A period from the data cache (ttlFor). `fresh` reads it live. */
export async function loadPeriod(sb: SupabaseClient, env: MatchdayEnv, from: string, to: string, scopeCity: string | null, current: boolean, fresh = false): Promise<LoadedPeriod & { cached: boolean }> {
  const tag = `health:${env}:${from}:${to}:${scopeCity ?? "all"}`;
  if (fresh) revalidateTag(tag, { expire: 0 });
  let live = false;
  const cached = unstable_cache(async () => { live = true; return loadLive(sb, env, from, to, scopeCity, Date.now()); },
    ["health-period-v4", current ? "current" : "ended", env, from, to, scopeCity ?? "all"],
    { revalidate: ttlFor(to, current, todayBusinessDate(new Date())), tags: ["health", tag] });
  const r = await cached();
  return { ...r, cached: !live };
}
