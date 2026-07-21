// GET /api/cities/users-lens — aggregate the Cities → Users sub-tab
// data server-side, return a single JSON payload the client renders
// from. Computes hero KPIs, the 5-stage funnel, per-city table,
// signup-growth (weekly + monthly), funnel speed (last 90d cohort),
// and the signup-city × first-match-city matrix.
//
// Why a route handler instead of client-side queries:
//   - 24k mdapi_users + 38k mdapi_match_players + 2k subscriptions
//     would be ~7MB hydrated to the browser. Server-side aggregation
//     ships ~5KB of JSON instead.
//   - Service role client bypasses RLS overhead for the four reads.
//   - Single 5-min cache window per Vercel edge (s-maxage=300) means
//     repeat lens loads from any user are instant.
//
// Auth: same dual-mode pattern as /api/sync/users — Bearer
// CRON_SECRET (constant-time match) OR session token validated via
// supabase.auth.getUser. Session token is what the cockpit lens uses.
//
// PII note: mdapi_users contains emails. The aggregations below
// expose counts only — no row-level data leaves this handler.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isInternalUser } from "@/lib/users";
import { KNOWN_CITY_CODES } from "@/lib/cityNormalization";
import { selectAll } from "@/lib/supabasePagination";
import { normField } from "@/lib/normField";
import { matchStartMs } from "@/lib/matchTime";

export const runtime = "nodejs";
// Heaviest computation: paginated fetch of 24k users + 38k match_players
// + city/sub joins + per-cohort medians. Local timing puts it at <2s
// in steady state; 30s is generous headroom.
export const maxDuration = 30;

// Ordered city display: known codes first (ATX → ELP), then Unknown
// last (the abandoned-signup cohort).
const UNKNOWN = "Unknown";
const CITY_DISPLAY: readonly string[] = [...KNOWN_CITY_CODES, UNKNOWN];
const NEVER_PLAYED = "Never played";

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------
// Types — shape of the JSON the lens consumes.
// ---------------------------------------------------------------

export type ByCityRow = {
  city: string;
  registered: number;
  completedSignup: number;
  completedSignupPct: number;
  played1: number;
  played1Pct: number;
  // Retention depth: % values are share of THIS city's played1
  // (not previous stage). Lets the lens render an at-a-glance
  // retention curve per row that's directly comparable across cities.
  played3: number;
  played3PctOfPlayed1: number;
  played5: number;
  played5PctOfPlayed1: number;
  played10: number;
  played10PctOfPlayed1: number;
  active30d: number;
  members: number;
  activationRate: number;
};

// One bucket of a growth series. The same shape works for all three
// growth metrics (signups / completed / played); the bucketing date
// varies per metric (created_at for signups+completed, first_match
// date for played) but the rendered shape is identical.
export type GrowthBucket = {
  period: string;
  bucketStart: string; // ISO date
  total: number;
  // Per-city count for the period. Keys are the same set the lens
  // consumes (KNOWN_CITY_CODES + "Unknown"). Cities with zero in
  // the period get a 0 entry — predictable shape for the stacking
  // renderer + small multiples. Sums to `total`.
  byCity: Record<string, number>;
  // Rate metadata only meaningful on the Signups series — the bucket
  // member set is "users who signed up in this period", so we can
  // ask what fraction completed onboarding / went on to play. For
  // the Completed/Played series these would be ~100% by definition,
  // so they're omitted.
  completedPct?: number;
  played1Pct?: number;
};

// Three parallel series share the same bucket grid (12 months / 16
// weeks). The lens picks one based on the metric toggle.
export type GrowthSeries = {
  signups: GrowthBucket[];
  completed: GrowthBucket[];
  played: GrowthBucket[];
};

export type FunnelSpeedRow = {
  city: string;
  medianDaysCreatedToCompleted: number | null;
  medianDaysCompletedToFirstMatch: number | null;
  medianDaysFirstToThirdMatch: number | null;
  medianDaysFirstMatchToMember: number | null;
  cohortSize: number;
};

export type UsersLensPayload = {
  lastSyncedAt: string | null;
  // Echo of the applied cohort window so the client can render the
  // summary line + accent the matching growth-chart bars. null when
  // no window is applied (All time).
  window: { fromIso: string | null; toIso: string | null };
  hero: {
    registered: number;
    completedSignup: number;
    completedSignupPctOfRegistered: number;
    played1: number;
    played1PctOfCompleted: number;
    // Active 30d/60d are NOT cohort-filtered — they reflect current
    // network activity. The percentage subtitle on the card uses
    // network-wide all-time played-1+ as denominator so the metric is
    // comparable across selected windows.
    active30d: number;
    active30dPctOfNetworkPlayed1: number;
    members: number;
    membersPctOfPlayed1: number;
  };
  funnel: {
    accountCreated: number;
    completedSignup: number;
    played1: number;
    played3: number;
    played5: number;
    played10: number;
    activeMember: number;
  };
  byCity: ByCityRow[];
  // Growth series. Per Phase 2c spec, all three metrics respect the
  // selected window — bucket counts are over the WINDOWED cohort,
  // overriding Phase 2b's "growth chart unfiltered" decision. Out-of-
  // window buckets render empty (and the lens keeps the dim-bar
  // visual indicator from Phase 2b for the same buckets).
  growthMonthly: GrowthSeries;
  growthWeekly: GrowthSeries;
  funnelSpeed: FunnelSpeedRow[];
  matrix: {
    rows: string[];
    cols: string[];
    cells: number[][];
    rowTotals: number[];
    colTotals: number[];
    grandTotal: number;
  };
  // First match by field — one entry per city. Each entry carries an
  // ordered field list (largest total → smallest, used for legend +
  // stack order) and per-bucket field counts. Both monthly (12 buckets)
  // and weekly (16 buckets) reuse the same bucket grids the growth
  // chart uses, so first matches outside the grid are truncated.
  firstMatchByFieldMonthly: FirstMatchByFieldCity[];
  firstMatchByFieldWeekly: FirstMatchByFieldCity[];
};

export type FirstMatchByFieldBucket = {
  period: string;
  bucketStart: string;
  total: number;
  byField: Record<string, number>;
};

export type FirstMatchByFieldCity = {
  city: string;
  totalInWindow: number;
  fields: string[];
  buckets: FirstMatchByFieldBucket[];
};

// ---------------------------------------------------------------
// Data fetch — pulls all four tables once via selectAll() so the
// 1k-row PostgREST cap doesn't silently truncate. selectAll requires
// a stable .order() on a unique column; primary keys here cover that.
// ---------------------------------------------------------------

export type UserRow = {
  id: number;
  email: string;
  created_at: string;
  completed_sign_up_at: string | null;
  preferable_city_normalized: string | null;
  is_fake_player: boolean;
  is_member: boolean;
};

export type MatchPlayerRow = {
  user_id: number | null;
  match_api_id: number | null;
  is_cancelled: boolean;
  user_is_fake_player: boolean;
  user_type: string | null;
};

export type MatchRow = {
  api_id: number;
  city_identifier: string | null;
  // Venue-local wall-clock (fake +00:00). Correct for "which day did this
  // match fall on" bucketing; NEVER for arithmetic against a real instant.
  start_date: string | null;
  // True instant. Required for durations/recency measured against
  // genuine-UTC values (users.created_at, now). See lib/matchTime.ts.
  start_date_utc: string | null;
  is_cancelled: boolean;
  field_title: string | null;
};

export type SubRow = {
  user_id: number;
  status: string | null;
  price: number | null;
};

// Phase 3 audit instrumentation — per-table timing logged to Vercel
// function logs. Server-side only, no UI surface. Output format:
//   [users-lens] mdapi_users 482ms (24013 rows)
// so we can spot slow tables without correlating console output to
// table names by hand. Sequential fetches let us measure each one
// in isolation; if we ever switch to Promise.all the labels still
// work (each timer is keyed on its own label).
export async function fetchAll(supabase: SupabaseClient) {
  const t0 = Date.now();
  const users = await selectAll<UserRow>(() =>
    supabase
      .from("mdapi_users")
      .select(
        "id, email, created_at, completed_sign_up_at, preferable_city_normalized, is_fake_player, is_member",
      )
      .order("id"),
  );
  console.log(
    `[users-lens] mdapi_users ${Date.now() - t0}ms (${users.length} rows)`,
  );

  const t1 = Date.now();
  const players = await selectAll<MatchPlayerRow>(() =>
    supabase
      .from("mdapi_match_players")
      .select(
        "user_id, match_api_id, is_cancelled, user_is_fake_player, user_type, api_id",
      )
      // Exclude phantom registrations soft-deleted upstream.
      .is("deleted_at", null)
      .order("api_id"),
  );
  console.log(
    `[users-lens] mdapi_match_players ${Date.now() - t1}ms (${players.length} rows)`,
  );

  const t2 = Date.now();
  const matches = await selectAll<MatchRow>(() =>
    supabase
      .from("mdapi_matches")
      .select("api_id, city_identifier, start_date, start_date_utc, is_cancelled, field_title")
      // Exclude soft-deleted phantoms from scheduled-match denominators.
      .is("deleted_at", null)
      .order("api_id"),
  );
  console.log(
    `[users-lens] mdapi_matches ${Date.now() - t2}ms (${matches.length} rows)`,
  );

  const t3 = Date.now();
  const subs = await selectAll<SubRow>(() =>
    supabase
      .from("mdapi_subscriptions")
      .select("user_id, status, price, membership_id")
      .order("membership_id"),
  );
  console.log(
    `[users-lens] mdapi_subscriptions ${Date.now() - t3}ms (${subs.length} rows)`,
  );

  return { users, players, matches, subs };
}

// ---------------------------------------------------------------
// Aggregation — pure functions on the fetched data.
// ---------------------------------------------------------------

type DerivedUser = {
  id: number;
  signupCity: string; // ATX|...|ELP|Unknown
  createdAt: Date;
  completedAt: Date | null;
  played1: boolean;
  played3: boolean;
  played5: boolean;
  played10: boolean;
  active30d: boolean;
  active60d: boolean;
  member: boolean;
  // Wall-clock Date — for bucketing a match into its local day/week/month.
  firstMatchAt: Date | null;
  // True instant — for durations against genuine-UTC values.
  firstMatchUtcMs: number | null;
  firstMatchCity: string | null; // ATX|...|ELP|Unknown|null (null = never played)
  // Normalized field name of the first match (per normField). null
  // when never played OR the match's field_title was empty.
  firstMatchField: string | null;
  thirdMatchAt: Date | null;
  thirdMatchUtcMs: number | null;
};

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function safePct(n: number, d: number): number {
  if (d === 0) return 0;
  return Math.round((n / d) * 1000) / 10; // one decimal
}

function bucketCity(raw: string | null): string {
  if (!raw) return UNKNOWN;
  if ((KNOWN_CITY_CODES as readonly string[]).includes(raw)) return raw;
  return UNKNOWN;
}

export function aggregate(
  users: UserRow[],
  players: MatchPlayerRow[],
  matches: MatchRow[],
  subs: SubRow[],
  now: Date,
  windowFrom: Date | null,
  windowTo: Date | null,
): UsersLensPayload {
  // --- Filter users via isInternalUser (source-of-truth blocklist) ---
  const filteredUsers = users.filter(
    (u) => !isInternalUser(u.email, u.is_fake_player),
  );

  // Cohort window predicate. Applied to created_at; null bounds = open
  // ended on that side. "All time" = both null.
  const inWindow = (createdAt: Date): boolean => {
    if (windowFrom && createdAt < windowFrom) return false;
    if (windowTo && createdAt > windowTo) return false;
    return true;
  };

  // --- Build match → city/date/field lookup ---
  const matchInfo = new Map<
    number,
    {
      city: string | null;
      startDate: Date | null;
      startUtcMs: number | null;
      field: string | null;
    }
  >();
  for (const m of matches) {
    if (!m.api_id) continue;
    if (m.is_cancelled) continue;
    // normField returns "" when input is empty/whitespace; coerce to
    // null so downstream can distinguish "no field" from a real name.
    const normalized = m.field_title ? normField(m.field_title) : "";
    matchInfo.set(m.api_id, {
      city: m.city_identifier,
      startDate: m.start_date ? new Date(m.start_date) : null,
      startUtcMs: matchStartMs(m.start_date_utc, m.start_date),
      field: normalized || null,
    });
  }

  // --- Build per-user match list (valid plays only) ---
  // Valid play = non-cancelled, non-fake, user_type=PLAYER, AND the
  // match itself wasn't cancelled.
  const playsByUser = new Map<
    number,
    Array<{
      matchId: number;
      city: string | null;
      startDate: Date | null;
      startUtcMs: number | null;
      field: string | null;
    }>
  >();
  for (const p of players) {
    if (!p.user_id || p.match_api_id == null) continue;
    if (p.is_cancelled) continue;
    if (p.user_is_fake_player) continue;
    if (p.user_type !== "PLAYER") continue;
    const m = matchInfo.get(p.match_api_id);
    if (!m) continue; // match cancelled or missing
    let arr = playsByUser.get(p.user_id);
    if (!arr) {
      arr = [];
      playsByUser.set(p.user_id, arr);
    }
    arr.push({
      matchId: p.match_api_id,
      city: m.city,
      startDate: m.startDate,
      startUtcMs: m.startUtcMs,
      field: m.field,
    });
  }
  // Sort each user's plays ascending by date so first/third match
  // are well-defined.
  for (const arr of playsByUser.values()) {
    arr.sort((a, b) => {
      const ta = a.startDate ? a.startDate.getTime() : 0;
      const tb = b.startDate ? b.startDate.getTime() : 0;
      return ta - tb;
    });
  }

  // --- Build active-paid-member set by user_id ---
  const memberUserIds = new Set<number>();
  for (const s of subs) {
    if (!s.user_id) continue;
    if (s.status !== "ACTIVE") continue;
    if (s.price === null || s.price === undefined) continue;
    if (Number(s.price) <= 0) continue;
    memberUserIds.add(s.user_id);
  }

  // --- Derive per-user stats ---
  // Recency boundaries are genuine instants, so they are compared against
  // the match's true instant (startUtcMs), never the wall-clock Date.
  const thirtyDaysAgoMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const sixtyDaysAgoMs = now.getTime() - 60 * 24 * 60 * 60 * 1000;

  const derived: DerivedUser[] = filteredUsers.map((u) => {
    const plays = playsByUser.get(u.id) ?? [];
    const matchCount = plays.length;
    const firstPlay = plays[0] ?? null;
    const thirdPlay = plays[2] ?? null;
    const lastPlay = plays[plays.length - 1] ?? null;
    const lastUtcMs = lastPlay?.startUtcMs ?? null;
    const active30d = lastUtcMs != null && lastUtcMs >= thirtyDaysAgoMs;
    const active60d = lastUtcMs != null && lastUtcMs >= sixtyDaysAgoMs;
    const member = memberUserIds.has(u.id);
    return {
      id: u.id,
      signupCity: bucketCity(u.preferable_city_normalized),
      createdAt: new Date(u.created_at),
      completedAt: u.completed_sign_up_at ? new Date(u.completed_sign_up_at) : null,
      played1: matchCount >= 1,
      played3: matchCount >= 3,
      played5: matchCount >= 5,
      played10: matchCount >= 10,
      active30d,
      active60d,
      member,
      firstMatchAt: firstPlay?.startDate ?? null,
      firstMatchUtcMs: firstPlay?.startUtcMs ?? null,
      firstMatchCity: firstPlay ? bucketCity(firstPlay.city ?? null) : null,
      firstMatchField: firstPlay?.field ?? null,
      thirdMatchAt: thirdPlay?.startDate ?? null,
      thirdMatchUtcMs: thirdPlay?.startUtcMs ?? null,
    };
  });

  // --- Cohort split ---
  // `cohort` = windowed (cohort-based metrics: hero registered/completed/
  // played1/members, funnel, byCity, funnelSpeed, matrix rows).
  // `derived` = full network (used for current-state metrics that
  // shouldn't shift when the user changes window: Active 30d, growth
  // chart bars, and the network-wide played-1+ denominator).
  const cohort = derived.filter((u) => inWindow(u.createdAt));

  // --- Hero KPIs ---
  // Cohort-based:
  const registered = cohort.length;
  const completedSignup = cohort.filter((d) => d.completedAt).length;
  const played1 = cohort.filter((d) => d.played1).length;
  const played3 = cohort.filter((d) => d.played3).length;
  const played5 = cohort.filter((d) => d.played5).length;
  const played10 = cohort.filter((d) => d.played10).length;
  const members = cohort.filter((d) => d.member).length;
  // Network-wide (NOT cohort-filtered):
  const active30d = derived.filter((d) => d.active30d).length;
  const networkPlayed1 = derived.filter((d) => d.played1).length;

  const hero = {
    registered,
    completedSignup,
    completedSignupPctOfRegistered: safePct(completedSignup, registered),
    played1,
    played1PctOfCompleted: safePct(played1, completedSignup),
    active30d,
    active30dPctOfNetworkPlayed1: safePct(active30d, networkPlayed1),
    members,
    membersPctOfPlayed1: safePct(members, played1),
  };

  const funnel = {
    accountCreated: registered,
    completedSignup,
    played1,
    played3,
    played5,
    played10,
    activeMember: members,
  };

  // --- Per-city table (windowed cohort) ---
  const byCity: ByCityRow[] = CITY_DISPLAY.map((city) => {
    const inCity = cohort.filter((d) => d.signupCity === city);
    const reg = inCity.length;
    const compl = inCity.filter((d) => d.completedAt).length;
    const p1 = inCity.filter((d) => d.played1).length;
    const p3 = inCity.filter((d) => d.played3).length;
    const p5 = inCity.filter((d) => d.played5).length;
    const p10 = inCity.filter((d) => d.played10).length;
    const a30 = inCity.filter((d) => d.active30d).length;
    const mem = inCity.filter((d) => d.member).length;
    return {
      city,
      registered: reg,
      completedSignup: compl,
      completedSignupPct: safePct(compl, reg),
      played1: p1,
      played1Pct: safePct(p1, compl),
      // Retention depth: % share of this city's played1.
      played3: p3,
      played3PctOfPlayed1: safePct(p3, p1),
      played5: p5,
      played5PctOfPlayed1: safePct(p5, p1),
      played10: p10,
      played10PctOfPlayed1: safePct(p10, p1),
      active30d: a30,
      members: mem,
      activationRate: safePct(p1, reg),
    };
  });

  // --- Growth bucket helpers ---
  // Build a Record<city, count> with all CITY_DISPLAY keys present
  // (zero-fills missing cities) so the lens stacking renderer has a
  // predictable shape — no "is this key here?" branches per render.
  const emptyByCity = (): Record<string, number> => {
    const m: Record<string, number> = {};
    for (const c of CITY_DISPLAY) m[c] = 0;
    return m;
  };
  const buildByCity = (rows: DerivedUser[]): Record<string, number> => {
    const m = emptyByCity();
    for (const u of rows) m[u.signupCity] = (m[u.signupCity] ?? 0) + 1;
    return m;
  };

  // Build three parallel series for one bucket grid.
  // - signups: bucket users by createdAt; tooltip shows
  //   completedPct + played1Pct of the bucket member set.
  // - completed: same bucketing date (createdAt) but only counts
  //   users with completed_sign_up_at present. Bucket label is the
  //   created-at month — same x-axis as signups so the two are
  //   directly comparable.
  // - played: bucket users by FIRST MATCH DATE (firstMatchAt). Cohort
  //   is windowed users who actually played; users with no firstMatch
  //   date drop out entirely.
  //
  // Per Phase 2c spec, all three metrics use the WINDOWED cohort.
  type Bucket = { start: Date; end: Date; period: string; bucketStart: string };
  const buildSeries = (
    bs: Bucket[],
  ): GrowthSeries => {
    const signups: GrowthBucket[] = [];
    const completed: GrowthBucket[] = [];
    const played: GrowthBucket[] = [];
    for (const b of bs) {
      // SIGNUPS — by createdAt over windowed cohort.
      const signupRows = cohort.filter(
        (u) => u.createdAt >= b.start && u.createdAt < b.end,
      );
      signups.push({
        period: b.period,
        bucketStart: b.bucketStart,
        total: signupRows.length,
        byCity: buildByCity(signupRows),
        completedPct: safePct(
          signupRows.filter((u) => u.completedAt).length,
          signupRows.length,
        ),
        played1Pct: safePct(
          signupRows.filter((u) => u.played1).length,
          signupRows.length,
        ),
      });
      // COMPLETED — same bucket date (createdAt) but only completers.
      const completedRows = signupRows.filter((u) => u.completedAt);
      completed.push({
        period: b.period,
        bucketStart: b.bucketStart,
        total: completedRows.length,
        byCity: buildByCity(completedRows),
      });
      // PLAYED 1+ — bucket by firstMatchAt. Windowed cohort + has
      // played at least once.
      const playedRows = cohort.filter(
        (u) =>
          u.played1 &&
          u.firstMatchAt &&
          u.firstMatchAt >= b.start &&
          u.firstMatchAt < b.end,
      );
      played.push({
        period: b.period,
        bucketStart: b.bucketStart,
        total: playedRows.length,
        byCity: buildByCity(playedRows),
      });
    }
    return { signups, completed, played };
  };

  // --- Bucket grids: 12 monthly + 16 weekly ---
  const monthlyGrid: Bucket[] = [];
  for (let i = 11; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    monthlyGrid.push({
      start,
      end,
      period: `${start.toLocaleString("en-US", { month: "short" })} ${start.getFullYear()}`,
      bucketStart: start.toISOString().slice(0, 10),
    });
  }
  const dow = (now.getDay() + 6) % 7; // 0=Mon..6=Sun
  const thisMon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  const weeklyGrid: Bucket[] = [];
  for (let i = 15; i >= 0; i--) {
    const start = new Date(thisMon.getFullYear(), thisMon.getMonth(), thisMon.getDate() - i * 7);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    weeklyGrid.push({
      start,
      end,
      period: `${start.getMonth() + 1}/${start.getDate()}`,
      bucketStart: start.toISOString().slice(0, 10),
    });
  }
  const monthBuckets = buildSeries(monthlyGrid);
  const weekBuckets = buildSeries(weeklyGrid);

  // --- Funnel speed: per-city medians, windowed cohort ---
  // Cohort source is the same windowed cohort the hero/byCity use.
  // No hardcoded 90-day clamp — Phase 2b's window selector is the
  // single source of truth for cohort selection.
  const cityForSpeed = [...CITY_DISPLAY];
  const funnelSpeed: FunnelSpeedRow[] = cityForSpeed.map((city) => {
    const inCity = cohort.filter((d) => d.signupCity === city);
    const cohortSize = inCity.length;
    const dCreatedToCompleted = inCity
      .filter((d) => d.completedAt)
      .map((d) => (d.completedAt!.getTime() - d.createdAt.getTime()) / 86400000);
    const dCompletedToFirst = inCity
      .filter((d) => d.completedAt && d.firstMatchUtcMs != null)
      .map(
        // completedAt is genuine UTC, so the match side must be too.
        (d) => (d.firstMatchUtcMs! - d.completedAt!.getTime()) / 86400000,
      );
    const dFirstToThird = inCity
      .filter((d) => d.firstMatchUtcMs != null && d.thirdMatchUtcMs != null)
      .map(
        (d) => (d.thirdMatchUtcMs! - d.firstMatchUtcMs!) / 86400000,
      );
    // Member-conversion-from-first-match: users who have a first match
    // AND are members. We don't store the member-activation date
    // server-side here, so this is an upper bound proxy: days from
    // first match to NOW for users who eventually became members. Not
    // a perfect "days to convert" — surface as "—" if cohort is too
    // small to be meaningful.
    const dFirstMatchToMember = inCity
      .filter((d) => d.firstMatchUtcMs != null && d.member)
      .map((d) => (now.getTime() - d.firstMatchUtcMs!) / 86400000);
    // n < 5 → not enough signal, return null.
    const safeMedian = (xs: number[]): number | null =>
      xs.length < 5 ? null : Math.round((median(xs) ?? 0) * 10) / 10;
    return {
      city,
      medianDaysCreatedToCompleted: safeMedian(dCreatedToCompleted),
      medianDaysCompletedToFirstMatch: safeMedian(dCompletedToFirst),
      medianDaysFirstToThirdMatch: safeMedian(dFirstToThird),
      medianDaysFirstMatchToMember: safeMedian(dFirstMatchToMember),
      cohortSize,
    };
  });

  // --- First match by field: per-city stacked-bar series ---
  // Per Phase 3 Step 2c-followup spec: "user counted once at first
  // field". Windowed cohort + played 1+ + has firstMatchAt + has
  // firstMatchField. Bucket by firstMatchAt over the same 12mo / 16wk
  // grids the growth chart uses (truncates anything outside).
  // Field bucketing key: firstMatchCity (the bucketed UI city, not
  // raw city_identifier — keeps "Unknown" cohort together).
  const buildFirstMatchByField = (
    bs: Bucket[],
  ): FirstMatchByFieldCity[] => {
    return CITY_DISPLAY.map((city) => {
      // 1. Filter cohort to users whose first match landed in THIS
      //    city, ever (lifetime — bucket grid limits to recent window
      //    via per-bucket date filter below).
      const inCityFirstMatch = cohort.filter(
        (u) => u.firstMatchCity === city && u.firstMatchAt,
      );
      // 2. Tally lifetime totals per field for legend ordering.
      const totalsByField = new Map<string, number>();
      for (const u of inCityFirstMatch) {
        const f = u.firstMatchField ?? "(unknown field)";
        totalsByField.set(f, (totalsByField.get(f) ?? 0) + 1);
      }
      // 3. Build per-bucket field counts. Buckets that don't intersect
      //    any first-match dates simply have all-zero byField maps.
      const buckets: FirstMatchByFieldBucket[] = bs.map((b) => {
        const inBucket = inCityFirstMatch.filter(
          (u) =>
            u.firstMatchAt! >= b.start && u.firstMatchAt! < b.end,
        );
        const byField: Record<string, number> = {};
        // Pre-fill with all known fields so the renderer's stack
        // structure stays consistent across buckets (zero-fills get
        // dropped in the UI before render).
        for (const f of totalsByField.keys()) byField[f] = 0;
        for (const u of inBucket) {
          const f = u.firstMatchField ?? "(unknown field)";
          byField[f] = (byField[f] ?? 0) + 1;
        }
        return {
          period: b.period,
          bucketStart: b.bucketStart,
          total: inBucket.length,
          byField,
        };
      });
      // 4. Field order: largest lifetime total first. Stable across
      //    buckets so the legend reads top → bottom of the stack.
      const fields = [...totalsByField.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([f]) => f);
      return {
        city,
        totalInWindow: inCityFirstMatch.length,
        fields,
        buckets,
      };
    });
  };
  const firstMatchByFieldMonthly = buildFirstMatchByField(monthlyGrid);
  const firstMatchByFieldWeekly = buildFirstMatchByField(weeklyGrid);

  // --- Matrix: signup city × first-match city (windowed cohort) ---
  // Rows = signup city of the windowed cohort. First-match city is
  // lifetime per spec — users who registered in window may have first
  // played outside it, and we want to see that movement.
  const rows = [...CITY_DISPLAY];
  const cols = [...CITY_DISPLAY, NEVER_PLAYED];
  const cells: number[][] = rows.map(() => cols.map(() => 0));
  const rowTotals: number[] = rows.map(() => 0);
  const colTotals: number[] = cols.map(() => 0);
  let grandTotal = 0;
  for (const u of cohort) {
    const ri = rows.indexOf(u.signupCity);
    if (ri < 0) continue;
    const ci =
      u.firstMatchCity === null
        ? cols.indexOf(NEVER_PLAYED)
        : cols.indexOf(u.firstMatchCity);
    if (ci < 0) continue;
    cells[ri][ci] += 1;
    rowTotals[ri] += 1;
    colTotals[ci] += 1;
    grandTotal += 1;
  }

  return {
    lastSyncedAt: null, // populated by caller
    window: {
      fromIso: windowFrom ? windowFrom.toISOString() : null,
      toIso: windowTo ? windowTo.toISOString() : null,
    },
    hero,
    funnel,
    byCity,
    growthMonthly: monthBuckets,
    growthWeekly: weekBuckets,
    funnelSpeed,
    matrix: { rows, cols, cells, rowTotals, colTotals, grandTotal },
    firstMatchByFieldMonthly,
    firstMatchByFieldWeekly,
  };
}

// ---------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------

export async function GET(req: Request) {
  // --- Auth: bearer, dual-mode ---
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return Response.json(
      { error: "Missing Authorization header" },
      { status: 401 },
    );
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    return Response.json({ error: "Empty bearer token" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !serviceKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }
  const cronSecret = process.env.CRON_SECRET;
  let triggeredBy: "manual" | "cron" = "manual";
  if (cronSecret && constantTimeMatch(token, cronSecret)) {
    triggeredBy = "cron";
  } else {
    const sessionClient = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } =
      await sessionClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // --- Parse window params ---
  // Accepts ?from=YYYY-MM-DD&to=YYYY-MM-DD. Either can be omitted
  // (open-ended on that side). Malformed dates are ignored — the
  // route returns the All-time aggregation rather than 400ing, which
  // is the more forgiving behavior for a shareable URL.
  // Also accepts ?snapshot_key= — when present and recognized + rows
  // are fresh in mdapi_users_lens_snapshot, the route serves the
  // snapshot and skips the ~4.6s live aggregation. Falls through to
  // live for unknown / stale / missing snapshot keys.
  const reqUrl = new URL(req.url);
  const fromParam = reqUrl.searchParams.get("from");
  const toParam = reqUrl.searchParams.get("to");
  const snapshotKeyParam = reqUrl.searchParams.get("snapshot_key");
  const isoDateRx = /^\d{4}-\d{2}-\d{2}$/;
  const windowFrom =
    fromParam && isoDateRx.test(fromParam)
      ? new Date(`${fromParam}T00:00:00.000Z`)
      : null;
  const windowTo =
    toParam && isoDateRx.test(toParam)
      ? new Date(`${toParam}T23:59:59.999Z`)
      : null;

  const startedAt = Date.now();

  // --- Snapshot read path (Phase 3 Step 2c) ---
  // Stable windows pre-computed nightly. Reads should be <100ms.
  const VALID_SNAPSHOT_KEYS = new Set([
    "all_time",
    "2026_ytd",
    "2025_ytd",
    "2024_ytd",
    "last_90",
    "last_12mo",
  ]);
  // Treat snapshot as fresh if computed_at is within 25h (gives the
  // nightly cron a 1-hour grace window for slow runs). Older than
  // that, fall through to live so a missed cron doesn't silently
  // serve stale data.
  const SNAPSHOT_FRESHNESS_MS = 25 * 60 * 60 * 1000;
  if (snapshotKeyParam && VALID_SNAPSHOT_KEYS.has(snapshotKeyParam)) {
    const tSnap = Date.now();
    const [perCityRes, aggRes] = await Promise.all([
      supabase
        .from("mdapi_users_lens_snapshot")
        .select("*")
        .eq("window_key", snapshotKeyParam),
      supabase
        .from("mdapi_users_lens_aggregate_snapshot")
        .select("*")
        .eq("window_key", snapshotKeyParam)
        .maybeSingle(),
    ]);
    if (
      !perCityRes.error &&
      !aggRes.error &&
      perCityRes.data &&
      perCityRes.data.length > 0 &&
      aggRes.data
    ) {
      const computedAt = new Date(aggRes.data.computed_at as string);
      const isFresh =
        Date.now() - computedAt.getTime() <= SNAPSHOT_FRESHNESS_MS;
      if (isFresh) {
        const payload = composePayloadFromSnapshot(
          snapshotKeyParam,
          perCityRes.data as Array<Record<string, unknown>>,
          aggRes.data as Record<string, unknown>,
        );
        // fin_sync_log lastSyncedAt is independent of snapshot — it's
        // about mdapi-users freshness, which the operator wants to
        // see at the top of the lens regardless of which read path
        // served the page.
        const { data: lastLog } = await supabase
          .from("fin_sync_log")
          .select("completed_at")
          .eq("source", "mdapi-users")
          .not("completed_at", "is", null)
          .order("completed_at", { ascending: false })
          .limit(1)
          .maybeSingle<{ completed_at: string }>();
        payload.lastSyncedAt = lastLog?.completed_at ?? null;
        console.log(
          `[users-lens] snapshot path key=${snapshotKeyParam} ${Date.now() - tSnap}ms`,
        );
        return Response.json(
          {
            ok: true,
            triggeredBy,
            durationMs: Date.now() - startedAt,
            payload,
            servedFrom: "snapshot",
          },
          {
            status: 200,
            headers: {
              "Cache-Control":
                "private, s-maxage=300, stale-while-revalidate=600",
            },
          },
        );
      }
    }
    console.log(
      `[users-lens] snapshot path miss key=${snapshotKeyParam}; falling through to live`,
    );
  }

  // --- Live path (fallback / dynamic windows) ---
  const tFetch = Date.now();
  const { users, players, matches, subs } = await fetchAll(supabase);
  console.log(
    `[users-lens] fetchAll total ${Date.now() - tFetch}ms`,
  );

  const tAgg = Date.now();
  const payload = aggregate(
    users,
    players,
    matches,
    subs,
    new Date(),
    windowFrom,
    windowTo,
  );
  console.log(
    `[users-lens] aggregate (JS, in-memory) ${Date.now() - tAgg}ms`,
  );

  // --- Last-synced indicator from fin_sync_log ---
  const tSync = Date.now();
  const { data: lastLog } = await supabase
    .from("fin_sync_log")
    .select("completed_at")
    .eq("source", "mdapi-users")
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ completed_at: string }>();
  console.log(
    `[users-lens] fin_sync_log lookup ${Date.now() - tSync}ms`,
  );
  payload.lastSyncedAt = lastLog?.completed_at ?? null;

  return Response.json(
    {
      ok: true,
      triggeredBy,
      durationMs: Date.now() - startedAt,
      payload,
    },
    {
      status: 200,
      headers: {
        // Server-side cache for 5 minutes (matches the spec). The
        // client refetches on mount; Vercel's edge cache + this
        // header keep cold-start latency low.
        "Cache-Control":
          "private, s-maxage=300, stale-while-revalidate=600",
      },
    },
  );
}


// ---------------------------------------------------------------
// Snapshot read path — compose UsersLensPayload from snapshot rows.
// Mirrors aggregate()'s output shape exactly so the lens doesn't
// care which path served the request.
// ---------------------------------------------------------------

function composePayloadFromSnapshot(
  snapshotKey: string,
  perCityRows: Array<Record<string, unknown>>,
  aggRow: Record<string, unknown>,
): UsersLensPayload {
  const cityMap = new Map<string, Record<string, unknown>>();
  for (const r of perCityRows) cityMap.set(String(r.city), r);

  // Reconstruct byCity in the canonical CITY_DISPLAY order. Snapshot
  // doesn't guarantee row order; this also zero-fills any missing
  // city (defensive — shouldn't happen with truncate-and-insert).
  const byCity: ByCityRow[] = CITY_DISPLAY.map((city) => {
    const r = cityMap.get(city);
    const reg = num(r, 'registered');
    const compl = num(r, 'completed_signup');
    const p1 = num(r, 'played_1plus');
    const p3 = num(r, 'played_3plus');
    const p5 = num(r, 'played_5plus');
    const p10 = num(r, 'played_10plus');
    const a30 = num(r, 'active_30d');
    const mem = num(r, 'members');
    return {
      city,
      registered: reg,
      completedSignup: compl,
      completedSignupPct: safePct(compl, reg),
      played1: p1,
      played1Pct: safePct(p1, compl),
      played3: p3,
      played3PctOfPlayed1: safePct(p3, p1),
      played5: p5,
      played5PctOfPlayed1: safePct(p5, p1),
      played10: p10,
      played10PctOfPlayed1: safePct(p10, p1),
      active30d: a30,
      members: mem,
      activationRate: safePct(p1, reg),
    };
  });

  // Hero / funnel: sum across cities (snapshot has per-city only).
  const sum = (k: keyof ByCityRow) =>
    byCity.reduce((s, c) => s + (c[k] as number), 0);
  const registered = sum('registered');
  const completedSignup = sum('completedSignup');
  const played1 = sum('played1');
  const played3 = sum('played3');
  const played5 = sum('played5');
  const played10 = sum('played10');
  const members = sum('members');
  const networkActive30d = num(aggRow, 'network_active_30d');
  const networkPlayed1 = num(aggRow, 'network_played_1plus');

  const hero = {
    registered,
    completedSignup,
    completedSignupPctOfRegistered: safePct(completedSignup, registered),
    played1,
    played1PctOfCompleted: safePct(played1, completedSignup),
    active30d: networkActive30d,
    active30dPctOfNetworkPlayed1: safePct(networkActive30d, networkPlayed1),
    members,
    membersPctOfPlayed1: safePct(members, played1),
  };

  const funnel = {
    accountCreated: registered,
    completedSignup,
    played1,
    played3,
    played5,
    played10,
    activeMember: members,
  };

  // Reconstruct window dates from snapshot key + computed_at so the
  // lens summary line ('Showing X registered users from … (Mar 1 →
  // May 8, 2026)') matches the data window on the snapshot.
  const computedAt = new Date(String(aggRow.computed_at));
  const windowDates = snapshotKeyToDates(snapshotKey, computedAt);

  return {
    lastSyncedAt: null, // populated by caller
    window: {
      fromIso: windowDates.from ? windowDates.from.toISOString() : null,
      toIso: windowDates.to ? windowDates.to.toISOString() : null,
    },
    hero,
    funnel,
    byCity,
    growthMonthly: {
      signups: aggRow.growth_monthly_signups as GrowthBucket[],
      completed: aggRow.growth_monthly_completed as GrowthBucket[],
      played: aggRow.growth_monthly_played as GrowthBucket[],
    },
    growthWeekly: {
      signups: aggRow.growth_weekly_signups as GrowthBucket[],
      completed: aggRow.growth_weekly_completed as GrowthBucket[],
      played: aggRow.growth_weekly_played as GrowthBucket[],
    },
    funnelSpeed: aggRow.funnel_speed as FunnelSpeedRow[],
    matrix: aggRow.matrix_data as UsersLensPayload['matrix'],
    firstMatchByFieldMonthly:
      (aggRow.first_match_by_field_monthly as FirstMatchByFieldCity[] | null) ??
      [],
    firstMatchByFieldWeekly:
      (aggRow.first_match_by_field_weekly as FirstMatchByFieldCity[] | null) ??
      [],
  };
}

function num(r: Record<string, unknown> | undefined, k: string): number {
  if (!r) return 0;
  const v = r[k];
  return typeof v === 'number' ? v : 0;
}

// Mirror of usersLensSnapshot.snapshotKeyDates — kept inline here so
// the route doesn't pull in the snapshot-builder module (which depends
// on this file → would create a circular import). Exact same logic;
// keep in sync if either changes.
function snapshotKeyToDates(
  key: string,
  now: Date,
): { from: Date | null; to: Date | null } {
  const day = (d: Date) => {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  };
  const dayEnd = (d: Date) => {
    const out = new Date(d);
    out.setUTCHours(23, 59, 59, 999);
    return out;
  };
  if (key === 'all_time') return { from: null, to: null };
  if (key === '2026_ytd') {
    return { from: new Date(Date.UTC(2026, 0, 1)), to: dayEnd(now) };
  }
  if (key === '2025_ytd') {
    return {
      from: new Date(Date.UTC(2025, 0, 1)),
      to: new Date(Date.UTC(2025, 11, 31, 23, 59, 59, 999)),
    };
  }
  if (key === '2024_ytd') {
    return {
      from: new Date(Date.UTC(2024, 0, 1)),
      to: new Date(Date.UTC(2024, 11, 31, 23, 59, 59, 999)),
    };
  }
  if (key === 'last_90') {
    return { from: day(new Date(now.getTime() - 90 * 86400000)), to: dayEnd(now) };
  }
  if (key === 'last_12mo') {
    const f = new Date(now);
    f.setUTCFullYear(f.getUTCFullYear() - 1);
    return { from: day(f), to: dayEnd(now) };
  }
  return { from: null, to: null };
}

