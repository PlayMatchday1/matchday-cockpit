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
  active30d: number;
  members: number;
  activationRate: number;
};

export type GrowthBucket = {
  period: string;
  bucketStart: string; // ISO date
  signups: number;
  completedPct: number;
  played1Pct: number;
  // Per-city signup count for the period. Keys are the same set the
  // lens consumes (KNOWN_CITY_CODES + "Unknown"). Cities with zero
  // signups in the period get a 0 entry — predictable shape for the
  // stacking renderer. Sums to `signups`.
  byCity: Record<string, number>;
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
    activeMember: number;
  };
  byCity: ByCityRow[];
  // Growth buckets are NOT cohort-filtered. The client dims buckets
  // outside the selected window via window.fromIso / window.toIso.
  growthMonthly: GrowthBucket[];
  growthWeekly: GrowthBucket[];
  funnelSpeed: FunnelSpeedRow[];
  matrix: {
    rows: string[];
    cols: string[];
    cells: number[][];
    rowTotals: number[];
    colTotals: number[];
    grandTotal: number;
  };
};

// ---------------------------------------------------------------
// Data fetch — pulls all four tables once via selectAll() so the
// 1k-row PostgREST cap doesn't silently truncate. selectAll requires
// a stable .order() on a unique column; primary keys here cover that.
// ---------------------------------------------------------------

type UserRow = {
  id: number;
  email: string;
  created_at: string;
  completed_sign_up_at: string | null;
  preferable_city_normalized: string | null;
  is_fake_player: boolean;
  is_member: boolean;
};

type MatchPlayerRow = {
  user_id: number | null;
  match_api_id: number | null;
  is_cancelled: boolean;
  user_is_fake_player: boolean;
  user_type: string | null;
};

type MatchRow = {
  api_id: number;
  city_identifier: string | null;
  start_date: string | null;
  is_cancelled: boolean;
};

type SubRow = {
  user_id: number;
  status: string | null;
  price: number | null;
};

async function fetchAll(supabase: SupabaseClient) {
  const users = await selectAll<UserRow>(() =>
    supabase
      .from("mdapi_users")
      .select(
        "id, email, created_at, completed_sign_up_at, preferable_city_normalized, is_fake_player, is_member",
      )
      .order("id"),
  );
  const players = await selectAll<MatchPlayerRow>(() =>
    supabase
      .from("mdapi_match_players")
      .select(
        "user_id, match_api_id, is_cancelled, user_is_fake_player, user_type, api_id",
      )
      .order("api_id"),
  );
  const matches = await selectAll<MatchRow>(() =>
    supabase
      .from("mdapi_matches")
      .select("api_id, city_identifier, start_date, is_cancelled")
      .order("api_id"),
  );
  const subs = await selectAll<SubRow>(() =>
    supabase
      .from("mdapi_subscriptions")
      .select("user_id, status, price, membership_id")
      .order("membership_id"),
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
  active30d: boolean;
  active60d: boolean;
  member: boolean;
  firstMatchAt: Date | null;
  firstMatchCity: string | null; // ATX|...|ELP|Unknown|null (null = never played)
  thirdMatchAt: Date | null;
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

function aggregate(
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

  // --- Build match → city/date lookup ---
  const matchInfo = new Map<number, { city: string | null; startDate: Date | null }>();
  for (const m of matches) {
    if (!m.api_id) continue;
    if (m.is_cancelled) continue;
    matchInfo.set(m.api_id, {
      city: m.city_identifier,
      startDate: m.start_date ? new Date(m.start_date) : null,
    });
  }

  // --- Build per-user match list (valid plays only) ---
  // Valid play = non-cancelled, non-fake, user_type=PLAYER, AND the
  // match itself wasn't cancelled.
  const playsByUser = new Map<
    number,
    Array<{ matchId: number; city: string | null; startDate: Date | null }>
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
    arr.push({ matchId: p.match_api_id, city: m.city, startDate: m.startDate });
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
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const derived: DerivedUser[] = filteredUsers.map((u) => {
    const plays = playsByUser.get(u.id) ?? [];
    const matchCount = plays.length;
    const firstPlay = plays[0] ?? null;
    const thirdPlay = plays[2] ?? null;
    const lastPlay = plays[plays.length - 1] ?? null;
    const lastDate = lastPlay?.startDate ?? null;
    const active30d = !!(lastDate && lastDate >= thirtyDaysAgo);
    const active60d = !!(lastDate && lastDate >= sixtyDaysAgo);
    const member = memberUserIds.has(u.id);
    return {
      id: u.id,
      signupCity: bucketCity(u.preferable_city_normalized),
      createdAt: new Date(u.created_at),
      completedAt: u.completed_sign_up_at ? new Date(u.completed_sign_up_at) : null,
      played1: matchCount >= 1,
      played3: matchCount >= 3,
      active30d,
      active60d,
      member,
      firstMatchAt: firstPlay?.startDate ?? null,
      firstMatchCity: firstPlay ? bucketCity(firstPlay.city ?? null) : null,
      thirdMatchAt: thirdPlay?.startDate ?? null,
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
    activeMember: members,
  };

  // --- Per-city table (windowed cohort) ---
  const byCity: ByCityRow[] = CITY_DISPLAY.map((city) => {
    const inCity = cohort.filter((d) => d.signupCity === city);
    const reg = inCity.length;
    const compl = inCity.filter((d) => d.completedAt).length;
    const p1 = inCity.filter((d) => d.played1).length;
    const a30 = inCity.filter((d) => d.active30d).length;
    const mem = inCity.filter((d) => d.member).length;
    return {
      city,
      registered: reg,
      completedSignup: compl,
      completedSignupPct: safePct(compl, reg),
      played1: p1,
      played1Pct: safePct(p1, compl),
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

  // --- Growth: monthly buckets (last 12 months, NOT cohort-filtered) ---
  // Bars always show the full 12-month signup history. Client dims
  // bars outside the selected window via window.fromIso/toIso.
  const monthBuckets: GrowthBucket[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const next = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const inBucket = derived.filter(
      (u) => u.createdAt >= d && u.createdAt < next,
    );
    const signups = inBucket.length;
    const compl = inBucket.filter((u) => u.completedAt).length;
    const p1 = inBucket.filter((u) => u.played1).length;
    monthBuckets.push({
      period: `${d.toLocaleString("en-US", { month: "short" })} ${d.getFullYear()}`,
      bucketStart: d.toISOString().slice(0, 10),
      signups,
      completedPct: safePct(compl, signups),
      played1Pct: safePct(p1, signups),
      byCity: buildByCity(inBucket),
    });
  }

  // --- Growth: weekly buckets (last 16 ISO weeks, NOT cohort-filtered) ---
  const weekBuckets: GrowthBucket[] = [];
  // Anchor on this week's Monday.
  const dow = (now.getDay() + 6) % 7; // 0=Mon..6=Sun
  const thisMon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  for (let i = 15; i >= 0; i--) {
    const start = new Date(thisMon.getFullYear(), thisMon.getMonth(), thisMon.getDate() - i * 7);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    const inBucket = derived.filter(
      (u) => u.createdAt >= start && u.createdAt < end,
    );
    const signups = inBucket.length;
    const compl = inBucket.filter((u) => u.completedAt).length;
    const p1 = inBucket.filter((u) => u.played1).length;
    weekBuckets.push({
      period: `${start.getMonth() + 1}/${start.getDate()}`,
      bucketStart: start.toISOString().slice(0, 10),
      signups,
      completedPct: safePct(compl, signups),
      played1Pct: safePct(p1, signups),
      byCity: buildByCity(inBucket),
    });
  }

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
      .filter((d) => d.completedAt && d.firstMatchAt)
      .map(
        (d) => (d.firstMatchAt!.getTime() - d.completedAt!.getTime()) / 86400000,
      );
    const dFirstToThird = inCity
      .filter((d) => d.firstMatchAt && d.thirdMatchAt)
      .map(
        (d) => (d.thirdMatchAt!.getTime() - d.firstMatchAt!.getTime()) / 86400000,
      );
    // Member-conversion-from-first-match: users who have a first match
    // AND are members. We don't store the member-activation date
    // server-side here, so this is an upper bound proxy: days from
    // first match to NOW for users who eventually became members. Not
    // a perfect "days to convert" — surface as "—" if cohort is too
    // small to be meaningful.
    const dFirstMatchToMember = inCity
      .filter((d) => d.firstMatchAt && d.member)
      .map((d) => (now.getTime() - d.firstMatchAt!.getTime()) / 86400000);
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
  const reqUrl = new URL(req.url);
  const fromParam = reqUrl.searchParams.get("from");
  const toParam = reqUrl.searchParams.get("to");
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
  const { users, players, matches, subs } = await fetchAll(supabase);
  const payload = aggregate(
    users,
    players,
    matches,
    subs,
    new Date(),
    windowFrom,
    windowTo,
  );

  // --- Last-synced indicator from fin_sync_log ---
  const { data: lastLog } = await supabase
    .from("fin_sync_log")
    .select("completed_at")
    .eq("source", "mdapi-users")
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ completed_at: string }>();
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
