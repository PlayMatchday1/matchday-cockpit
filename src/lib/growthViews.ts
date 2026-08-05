// Server-side reads over the growth_* materialized views (migration 0096). No
// full-table fetch, no keyset over participation rows, no in-process cache of raw
// rows — Postgres does the aggregation, these just shape the rows for the cards.
// The abbr→display city map (CITY_CODE_TO_DISPLAY) and canonicalVenueName stay in
// Node, their single source of truth.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CITY_CODE_TO_DISPLAY } from "./scheduleReconcile";
import { canonicalVenueName } from "./venueResolver";

const UNKNOWN_CITY = "Unknown city";
export function cityDisplay(abbr: string | null): string {
  if (!abbr) return UNKNOWN_CITY;
  return CITY_CODE_TO_DISPLAY[abbr] ?? abbr;
}
export function cityAbbrFromDisplay(display: string): string | null {
  if (display === "All cities" || display === "Network (all cities)") return null;
  for (const [abbr, name] of Object.entries(CITY_CODE_TO_DISPLAY)) if (name === display) return abbr;
  return display; // already an abbr / unmapped
}
export function fieldDisplay(title: string | null, id: number | null): string {
  return canonicalVenueName(title ?? "") || (id != null ? `Field ${id}` : "Unknown field");
}

async function selectAllRange<T>(
  q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export type CohortMatrixPayload = {
  cohortMonths: string[];
  nowMonth: string;
  cities: string[]; // display names, for the filters
  city: string; // which city this payload is for ("all" or an abbr's display)
  cells: { month: string; age: number; players: number }[]; // ages 0..12
  generatedAt: string;
};

// The cohort/curve payload for one city (or all-cities when cityAbbr is null).
export async function fetchCohortMatrix(sb: SupabaseClient, cityAbbr: string | null): Promise<CohortMatrixPayload> {
  const nowMonth = new Date().toISOString().slice(0, 7);
  // The all-cities rollup is stored as city IS NULL; a specific city as city = abbr.
  const base = () =>
    sb
      .from("growth_cohort_matrix")
      .select("first_match_month, age, players")
      .lte("age", 12)
      .order("first_match_month", { ascending: true });
  const rows = await selectAllRange<{ first_match_month: string; age: number; players: number }>((from, to) => {
    let q = base().range(from, to);
    q = cityAbbr == null ? q.is("city", null) : q.eq("city", cityAbbr);
    return q;
  });
  // distinct cohort months + distinct cities (from the per-city rows) for filters.
  const monthsSet = new Set<string>();
  for (const r of rows) monthsSet.add(r.first_match_month);
  const cityRows = await selectAllRange<{ city: string | null }>((from, to) =>
    sb.from("growth_cohort_matrix").select("city").not("city", "is", null).eq("age", 0).range(from, to),
  );
  const cities = [...new Set(cityRows.map((r) => cityDisplay(r.city)))].sort((a, b) => a.localeCompare(b));
  return {
    cohortMonths: [...monthsSet].sort(),
    nowMonth,
    cities,
    city: cityAbbr == null ? "all" : cityDisplay(cityAbbr),
    cells: rows.map((r) => ({ month: r.first_match_month, age: r.age, players: r.players })),
    generatedAt: new Date().toISOString(),
  };
}

// One cohort split across cities (the city-detail drill-down), ages 0..12.
export async function fetchCohortCities(sb: SupabaseClient, cohort: string) {
  const rows = await selectAllRange<{ age: number; city: string | null; players: number }>((from, to) =>
    sb
      .from("growth_cohort_matrix")
      .select("age, city, players")
      .eq("first_match_month", cohort)
      .lte("age", 12)
      .range(from, to),
  );
  const nowMonth = new Date().toISOString().slice(0, 7);
  return {
    cohort,
    nowMonth,
    rows: rows.map((r) => ({ age: r.age, city: r.city == null ? null : cityDisplay(r.city), players: r.players })),
  };
}

// Drill-down: cohort roster (age 0) / churned players (age >= 1) — SQL set
// subtraction via the growth_cohort_players function. cityAbbr null = all cities.
export async function fetchCohortPlayers(sb: SupabaseClient, cohort: string, age: number, cityAbbr: string | null) {
  const { data, error } = await sb.rpc("growth_cohort_players", {
    p_cohort: cohort,
    p_age: age,
    p_city: cityAbbr,
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: {
    user_id: number;
    first_match_city: string | null;
    first_match_field_title: string | null;
    first_match_field_id: number | null;
    last_match_date: string;
    matches_played: number;
  }) => ({
    u: r.user_id,
    city: cityDisplay(r.first_match_city),
    field: fieldDisplay(r.first_match_field_title, r.first_match_field_id),
    last: r.last_match_date,
    matches: r.matches_played,
  }));
}

// Potential-churn list: server-paginated over growth_player_profile, sorted by
// days-inactive desc (= last_match_date asc). "inactive >= N days" ⇔
// last_match_date <= now - N days. cityAbbr null = all.
export type ChurnListRow = { u: number; city: string; field: string; days: number; matches: number; last: string };
export async function fetchChurnList(
  sb: SupabaseClient,
  opts: { cityAbbr: string | null; days: number; page: number; pageSize: number; countsOnly?: boolean },
) {
  const now = new Date();
  const cutoff = (n: number) => new Date(now.getTime() - n * 86400000).toISOString().slice(0, 10);
  const baseFilter = (q: ReturnType<SupabaseClient["from"]> extends never ? never : any) => {
    let x = q;
    if (opts.cityAbbr != null) x = x.eq("last_match_city", opts.cityAbbr);
    return x;
  };
  // bucket counts at 30/60/90/120 (head counts, cheap)
  const counts: Record<number, number> = {};
  for (const t of [30, 60, 90, 120]) {
    let q = sb.from("growth_player_profile").select("*", { count: "exact", head: true }).lte("last_match_date", cutoff(t));
    q = baseFilter(q);
    const { count } = await q;
    counts[t] = count ?? 0;
  }
  if (opts.countsOnly) return { counts, total: counts[opts.days] ?? 0, rows: [] as ChurnListRow[] };
  let q = sb
    .from("growth_player_profile")
    .select("user_id, last_match_city, last_match_field_title, last_match_field_id, last_match_date, matches_played")
    .lte("last_match_date", cutoff(opts.days))
    .order("last_match_date", { ascending: true })
    .range(opts.page * opts.pageSize, opts.page * opts.pageSize + opts.pageSize - 1);
  q = baseFilter(q);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows: ChurnListRow[] = (data ?? []).map((r: any) => ({
    u: r.user_id,
    city: cityDisplay(r.last_match_city),
    field: fieldDisplay(r.last_match_field_title, r.last_match_field_id),
    days: Math.floor((now.getTime() - Date.parse(r.last_match_date)) / 86400000),
    matches: r.matches_played,
    last: r.last_match_date,
  }));
  return { counts, total: counts[opts.days] ?? 0, rows };
}

// Best-effort refresh of the growth_* materialized views (rpc → refresh_growth_views).
// Non-fatal: a refresh failure must not fail the backfill/commit that triggered it.
export async function refreshGrowthViews(sb: SupabaseClient): Promise<void> {
  try {
    const { error } = await sb.rpc("refresh_growth_views");
    if (error) console.warn("[growth] refresh_growth_views failed:", error.message);
  } catch (e) {
    console.warn("[growth] refresh_growth_views threw:", e instanceof Error ? e.message : String(e));
  }
}
