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
  // ALL ages (not capped at 12): the retention CURVE runs 0..(months since first
  // match), well past 12. The cohort TABLE still caps at 12 client-side.
  const base = () =>
    sb
      .from("growth_cohort_matrix")
      .select("first_match_month, age, players")
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

// Potential-churn list over growth_player_profile. Ranked by MATCHES PLAYED desc
// (days-inactive breaks ties) — the point is finding deeply-involved players who
// stopped, not whoever's oldest. Two time bounds form a WINDOW on last_match_date:
//   floor "inactive for N days"  ⇔ last_match_date <= today − N   (the ceiling of recency)
//   ceiling "last played after D" ⇔ last_match_date >= D          (optional; default none)
// so the kept set is D <= last_match_date <= (today − N). If D is more recent than
// (today − N) the window is empty — the route surfaces that rather than a blank table.
// Field is canonicalised in Node, so filtering/tiles over it happen here (not SQL).
export type ChurnListRow = { u: number; city: string; field: string; days: number; matches: number; last: string };
export type ChurnResult = {
  impossible: boolean;
  impliedDate: string; // today − N days (the staleness floor, for the empty-window message)
  window: { after: string | null; before: string; days: number };
  tiles: { filteredPlayers: number; tenPlus: number; fields: number };
  total: number; // rows in the working (post-filter) set
  rows: ChurnListRow[]; // the requested page (or all, for CSV)
  availableFields: string[]; // canonical fields present for the selected city (pre field/heavy filter)
};

const HEAVY = 10; // "10+ prior matches"

export async function fetchChurnList(
  sb: SupabaseClient,
  opts: {
    cityAbbr: string | null;
    days: number;
    after?: string | null; // "last played after" YYYY-MM-DD
    field?: string | null; // canonical field name
    heavyOnly?: boolean;
    page: number;
    pageSize: number;
    all?: boolean; // ignore pagination (CSV)
  },
): Promise<ChurnResult> {
  const now = new Date();
  const before = new Date(now.getTime() - opts.days * 86400000).toISOString().slice(0, 10); // today − N
  const after = opts.after && opts.after.trim() ? opts.after.trim() : null;
  const window = { after, before, days: opts.days };

  // impossible window: the recency ceiling (after) is later than the staleness floor.
  if (after && after > before) {
    return { impossible: true, impliedDate: before, window, tiles: { filteredPlayers: 0, tenPlus: 0, fields: 0 }, total: 0, rows: [], availableFields: [] };
  }

  // fetch every profile inside the window (+ city), in parallel pages.
  type Raw = { user_id: number; last_match_city: string | null; last_match_field_title: string | null; last_match_field_id: number | null; last_match_date: string; matches_played: number };
  const cols = "user_id, last_match_city, last_match_field_title, last_match_field_id, last_match_date, matches_played";
  const raw = await selectAllRange<Raw>((from, to) => {
    let q = sb.from("growth_player_profile").select(cols).lte("last_match_date", before).range(from, to);
    if (after) q = q.gte("last_match_date", after);
    if (opts.cityAbbr != null) q = q.eq("last_match_city", opts.cityAbbr);
    return q;
  });

  const mapped = raw.map((r) => ({
    u: r.user_id,
    city: cityDisplay(r.last_match_city),
    field: fieldDisplay(r.last_match_field_title, r.last_match_field_id),
    days: Math.floor((now.getTime() - Date.parse(r.last_match_date)) / 86400000),
    matches: r.matches_played,
    last: r.last_match_date,
  }));

  // fields available for the current city (before the field/heavy filters).
  const availableFields = [...new Set(mapped.map((r) => r.field))].sort((a, b) => a.localeCompare(b));

  // apply the field filter, then compute tiles over that (pre-heavy) set.
  const scoped = opts.field ? mapped.filter((r) => r.field === opts.field) : mapped;
  const tenPlusCount = scoped.filter((r) => r.matches >= HEAVY).length;
  const working = opts.heavyOnly ? scoped.filter((r) => r.matches >= HEAVY) : scoped;

  // RANK: matches played desc, days inactive desc (= last_match_date asc) on ties.
  working.sort((a, b) => b.matches - a.matches || a.last.localeCompare(b.last) || a.u - b.u);

  const tiles = {
    filteredPlayers: working.length,
    tenPlus: tenPlusCount,
    fields: new Set(working.map((r) => r.field)).size,
  };
  const rows = opts.all ? working : working.slice(opts.page * opts.pageSize, opts.page * opts.pageSize + opts.pageSize);
  return { impossible: false, impliedDate: before, window, tiles, total: working.length, rows, availableFields };
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
