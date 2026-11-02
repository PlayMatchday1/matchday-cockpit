import "server-only"; // no-op under --conditions=react-server
// HEALTH: one period read live, the Gameday Ops board's way (src/app/api/matchday/[env]/gameday), then
// summarised (healthModel). The board pages /admin/matches for ONE wall-clock day; this pages it for a
// range (fromDate..toDate, the same parameters), then the same trimMatch, the same city filter for a
// confined account BEFORE anything is decorated, withVenueMaxPlayers and withSpots.
//
// CACHED WHEN COMPLETE (Ryan, 2026-11-01): a period that has ended is kept in the Next.js data cache
// for 6 hours, keyed by environment, dates and city scope; the current period is always read live.

import { unstable_cache } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { apiGet, type MatchdayEnv } from "./matchdayStageApi";
import { fetchVenueMaxPlayers, trimMatch, withVenueMaxPlayers, type Raw } from "./gamedayApiShape";
import { withSpots } from "./gamedaySpots";
import { cityNameFor } from "./cityScope";
import { loadCancelFacts } from "./cancelReasonsLoad";
import { summarize, type HealthMatch, type PeriodSummary } from "./healthModel";

const PAGE_LIMIT = 100;
export const COMPLETED_TTL_S = 6 * 3600;

async function readRange(env: MatchdayEnv, from: string, to: string): Promise<Raw[]> {
  const out: Raw[] = [];
  for (let page = 1; page <= 60; page++) {
    const res = await apiGet<{ data?: Raw[]; totalItems?: number }>(env, "/admin/matches", {
      fromDate: from, toDate: to, page, limit: PAGE_LIMIT, sortColumn: "startDate", sortDirection: "asc",
    });
    const rows = Array.isArray(res) ? (res as Raw[]) : (res.data ?? []);
    out.push(...rows);
    const total = Array.isArray(res) ? rows.length : (res.totalItems ?? rows.length);
    if (rows.length < PAGE_LIMIT || out.length >= total) break;
  }
  return out;
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

/** A period, live when it is current, from the 6-hour cache when it has ended. */
export async function loadPeriod(sb: SupabaseClient, env: MatchdayEnv, from: string, to: string, scopeCity: string | null, current: boolean): Promise<LoadedPeriod & { cached: boolean }> {
  if (current) return { ...(await loadLive(sb, env, from, to, scopeCity, Date.now())), cached: false };
  let fresh = false;
  const cached = unstable_cache(async () => { fresh = true; return loadLive(sb, env, from, to, scopeCity, Date.now()); },
    ["health-period-v3", env, from, to, scopeCity ?? "all"], { revalidate: COMPLETED_TTL_S, tags: ["health"] });
  const r = await cached();
  return { ...r, cached: !fresh };
}
