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
/* EVERY ROW IS CONTACTABLE. It carried a bare user id, which made this a report rather than a
 * task — nobody can act on "player 9". Name, email, phone and membership come from mdapi_users in
 * ONE query over the ids already in the window, so the cost is bounded by the list, not the table.
 * `spent` is parsed from growth_player_profile.ev, which holds "YYYY-MM|CITY|Field|amount". */
export type ChurnListRow = {
  u: number; city: string; field: string; days: number; matches: number; last: string;
  name: string | null; email: string | null; phone: string | null; spent: number; isMember: boolean;
};
export type ChurnResult = {
  impossible: boolean;
  impliedDate: string; // today − N days (the staleness floor, for the empty-window message)
  window: { after: string | null; before: string; days: number };
  tiles: { filteredPlayers: number; tenPlus: number; fields: number; heavy: number; regular: number; tried: number };
  heavy: number;              // the THRESHOLD in force — a control now, not the constant 10
  spent: number;              // what this list spent before it stopped
  members: number;            // still paying, stopped playing — the most urgent rows here
  windowStart: string;
  total: number; // rows in the working (post-filter) set
  scrubbed: number; // deleted accounts removed from THIS page — stated, never silent
  rows: ChurnListRow[]; // the requested page (or all, for CSV)
  availableFields: string[]; // canonical fields present for the selected city (pre field/heavy filter)
};

/* 10 WAS AN UNEXPLAINED CONSTANT compiled into the page. It is a parameter now, and the middle
 * tier's label is derived from it so the tile and the filter cannot disagree. See churnModel. */
import { clampHeavy, tierOf, spentFromEv, isScrubbed, DEFAULT_HEAVY, type Tier } from "./churnModel";

export async function fetchChurnList(
  sb: SupabaseClient,
  opts: {
    cityAbbr: string | null;
    days: number;
    after?: string | null; // "last played after" YYYY-MM-DD
    field?: string | null; // canonical field name
    heavyOnly?: boolean;
    heavy?: number;          // the Heavy threshold in force
    tier?: Tier | null;      // heavy | regular | tried — the clicked tile
    start?: string | null;   // the WINDOW start (this year by default); distinct from `after`
    page: number;
    pageSize: number;
    all?: boolean; // ignore pagination (CSV)
  },
): Promise<ChurnResult> {
  const now = new Date();
  const before = new Date(now.getTime() - opts.days * 86400000).toISOString().slice(0, 10); // today − N
  /* THE WINDOW START AND `after` ARE THE SAME BOUND FROM TWO CONTROLS. The buttons set a start;
   * the date box overrides it. Whichever is in force is the one lower bound the query uses, so the
   * page can never be filtering on one while displaying the other. */
  const after = (opts.after && opts.after.trim()) || (opts.start && opts.start.trim()) || null;
  const heavy = clampHeavy(opts.heavy ?? DEFAULT_HEAVY);
  const window = { after, before, days: opts.days };

  // impossible window: the recency ceiling (after) is later than the staleness floor.
  if (after && after > before) {
    return { impossible: true, impliedDate: before, window, tiles: { filteredPlayers: 0, tenPlus: 0, fields: 0, heavy: 0, regular: 0, tried: 0 }, total: 0, rows: [], availableFields: [], heavy, windowStart: after ?? "0000-01-01", spent: 0, members: 0, scrubbed: 0 };
  }

  // fetch every profile inside the window (+ city), in parallel pages.
  type Raw = { user_id: number; last_match_city: string | null; last_match_field_title: string | null; last_match_field_id: number | null; last_match_date: string; matches_played: number; ev: unknown };
  const cols = "user_id, last_match_city, last_match_field_title, last_match_field_id, last_match_date, matches_played, ev";
  /* .order() IS NOT OPTIONAL ON A PAGED RANGE, and its absence here was a live bug.
   *
   * selectAllRange walks .range(0,999), .range(1000,1999)… over a 14,751-row VIEW. With no ORDER BY
   * the server is free to return the rows in any order, so consecutive pages OVERLAP AND SKIP —
   * exactly what docs/matchday-api-facts.md records about /admin/promocodes, in our own database.
   * On screen it showed as the same player listed THREE TIMES ("Hash", 361 matches, three identical
   * rows) while `matches_played = 361` matches exactly one row in the source. Every churn list this
   * page has ever produced carried duplicates and was missing other people to match. */
  const raw = await selectAllRange<Raw>((from, to) => {
    let q = sb.from("growth_player_profile").select(cols).lte("last_match_date", before)
      .order("user_id", { ascending: true }).range(from, to);
    if (after) q = q.gte("last_match_date", after);
    if (opts.cityAbbr != null) q = q.eq("last_match_city", opts.cityAbbr);
    return q;
  });

  /* BELT AND BRACES ON TOP OF THE ORDER. A stable order makes overlap impossible; deduping on
   * user_id makes a duplicate impossible even if a future caller forgets the order again — and this
   * list is people, where a repeat is visible and embarrassing rather than a rounding. */
  const seen = new Set<number>();
  const uniq = raw.filter((r) => (seen.has(r.user_id) ? false : (seen.add(r.user_id), true)));
  const mapped: ChurnListRow[] = uniq.map((r) => ({
    u: r.user_id,
    city: cityDisplay(r.last_match_city),
    field: fieldDisplay(r.last_match_field_title, r.last_match_field_id),
    days: Math.floor((now.getTime() - Date.parse(r.last_match_date)) / 86400000),
    matches: r.matches_played,
    last: r.last_match_date,
    name: null, email: null, phone: null, spent: spentFromEv(r.ev), isMember: false,
  }));

  // fields available for the current city (before the field/heavy filters).
  const availableFields = [...new Set(mapped.map((r) => r.field))].sort((a, b) => a.localeCompare(b));

  // apply the field filter, then compute tiles over that (pre-tier) set.
  const scoped = opts.field ? mapped.filter((r) => r.field === opts.field) : mapped;
  /* THE TILE COUNTS ARE OVER THE PRE-TIER SET ON PURPOSE. A tile that recounted itself after its
   * own click would read the filtered total and every other tile would read zero — the tiles are
   * how you get back out of a filter, so they describe the set you are filtering FROM. */
  const counts = { heavy: 0, regular: 0, tried: 0 };
  for (const r of scoped) counts[tierOf(r.matches, heavy)]++;
  const tier = opts.tier ?? (opts.heavyOnly ? "heavy" : null);
  const working = tier ? scoped.filter((r) => tierOf(r.matches, heavy) === tier) : scoped;

  // RANK: matches played desc, days inactive desc (= last_match_date asc) on ties.
  working.sort((a, b) => b.matches - a.matches || a.last.localeCompare(b.last) || a.u - b.u);

  /* CONTACT DETAILS FOR THE PAGE BEING SHOWN, plus the whole set on a CSV export. One query per
   * 500 ids. The pivot-style rule applies: the list is the reason to fetch these, so they are
   * fetched for the rows that will be rendered and for nothing else. */
  const visible = opts.all ? working : working.slice(opts.page * opts.pageSize, opts.page * opts.pageSize + opts.pageSize);
  const ids = visible.map((r) => r.u);
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await sb.from("mdapi_users")
      .select("id, first_name, last_name, email, phone_number, is_member")
      .in("id", ids.slice(i, i + 500));
    const by = new Map<number, Record<string, unknown>>();
    for (const u of data ?? []) by.set(Number((u as { id: number }).id), u as Record<string, unknown>);
    for (const r of visible) {
      const u = by.get(r.u);
      if (!u) continue;
      const nm = [u.first_name, u.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
      r.name = nm || null;
      r.email = (u.email as string) ?? null;
      r.phone = (u.phone_number as string) ?? null;
      r.isMember = u.is_member === true;
    }
  }

  /* DELETED ACCOUNTS COME OFF THE LIST. Their matches happened and their profile row is real, but
   * `del_<hash>@playmatchday.com` is nobody — 161 of 1,000 candidates. Dropping them silently would
   * make the count quietly smaller than the tiles, so the number removed is returned and printed. */
  const scrubbed = visible.filter((r) => isScrubbed(r.email)).length;
  const contactable = visible.filter((r) => !isScrubbed(r.email));

  const tiles = {
    filteredPlayers: working.length,
    tenPlus: counts.heavy, // kept for the old key's callers; `heavy` below is the same number
    fields: new Set(working.map((r) => r.field)).size,
    ...counts,
  };
  return {
    impossible: false, impliedDate: before, window, tiles,
    total: working.length, rows: contactable, availableFields, scrubbed,
    heavy, windowStart: after ?? "0000-01-01",
    spent: Math.round(working.reduce((a, r) => a + r.spent, 0) * 100) / 100,
    members: contactable.filter((r) => r.isMember).length,
  };
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

/* THE PLAYER FINDER'S PRECOMPUTED SET (migration 0147), refreshed on the same trigger and with the
 * same posture as the growth views: best-effort, never fails the sync. It lives beside them rather
 * than in its own module because it is the same decision — a set built from the mirror has to be
 * rebuilt when the mirror moves, or the page serves a fast, confident, wrong answer.
 *
 * IF THIS DOES NOT RUN, THE PAGE SAYS SO. player_finder_freshness() compares the set's stamp to
 * the newest mdapi_matches.synced_at, and the finder prints "stale" rather than showing counts
 * that look current. That is the whole reason a warning here is enough and a throw is not. */
export async function refreshPlayerFinderViews(sb: SupabaseClient): Promise<void> {
  try {
    const { error } = await sb.rpc("refresh_player_finder_views");
    if (error) console.warn("[finder] refresh_player_finder_views failed:", error.message);
  } catch (e) {
    console.warn("[finder] refresh_player_finder_views threw:", e instanceof Error ? e.message : String(e));
  }
}
