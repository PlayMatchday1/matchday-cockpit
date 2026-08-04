// The single cohort/retention aggregate that BOTH the retention-curve card and
// the cohort-table card read. Read-only; built once from match participation and
// cached in-process keyed on the max match date, so a backfill invalidates it and
// no request paginates 232k rows more than once per warm instance.
//
// Definitions (used verbatim by the cards):
//  - COHORT   = calendar month of a player's first ever match (min match date).
//  - ACTIVE@M = the player has >=1 match dated inside calendar month M.
//  - AGE N    = whole months between cohort month and M (cohort = age 0).
//  - The per-player `mask` is a 13-bit field: bit N set <=> active at age N.
//    Everything the cards show (retention %, counts, curve, per-city split, and
//    set-subtraction churn) is derived on the client from these masks — one
//    aggregate, no second query.

import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { UNKNOWN_CITY } from "./growthAnalytics";
import { CITY_CODE_TO_DISPLAY } from "./scheduleReconcile";
import { canonicalVenueName } from "./venueResolver";

type RawMatch = {
  api_id: number;
  start_date: string | null;
  city_identifier: string | null;
  field_id: number | null;
  field_title: string | null;
  is_cancelled: boolean | null;
  deleted_at: string | null;
};
type RawPlayer = {
  user_id: number | null;
  match_api_id: number | null;
  paid_status: string | null;
  canceled_at: string | null;
  user_is_fake_player: boolean | null;
  deleted_at: string | null;
};

export type RetentionPlayer = {
  u: number; // user_id
  c: number; // cohort index into cohortMonths
  ct: number; // first-match city index into cities
  f: number; // first-match field index into fields
  l: string; // last match date (YYYY-MM-DD)
  m: number; // lifetime participation count
  k: number; // 13-bit mask: bit N set => active at age N (ages 0..12)
};

export type RetentionAggregate = {
  cohortMonths: string[]; // "YYYY-MM" from the earliest cohort to nowMonth (index space)
  nowMonth: string;
  cities: string[]; // first-match cities (index space)
  fields: string[]; // first-match fields (index space)
  players: RetentionPlayer[];
  maxMatchDate: string; // cache key
  sourceRows: number; // participation rows that survived the filter
  distinctPlayers: number;
  buildMs: number;
  generatedAt: string;
};

const MAX_AGE = 12; // 13 age columns (0..12)

function normalizeMatchCity(code: string | null | undefined): string {
  if (!code) return UNKNOWN_CITY;
  return CITY_CODE_TO_DISPLAY[code] ?? code;
}
const idxOf = (k: string): number => {
  const [y, m] = k.split("-").map(Number);
  return y * 12 + (m - 1);
};
const keyOf = (idx: number): string =>
  `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;

// Pure builder — tested directly against production rows by the verify script.
export function buildRetention(
  matches: RawMatch[],
  players: RawPlayer[],
  nowIso: string,
): RetentionAggregate {
  const t0 = Date.now();

  const live = new Map<number, RawMatch>();
  let maxMatchDate = "";
  for (const m of matches) {
    if (m.deleted_at) continue;
    live.set(m.api_id, m);
    if (m.start_date && m.start_date > maxMatchDate) maxMatchDate = m.start_date;
  }
  maxMatchDate = maxMatchDate.slice(0, 10);

  // Participation = the SAME rule as growthAnalytics.computeGrowth's plays[]: a
  // live player row, not fake, not WAITING, not player-canceled, on a live,
  // non-cancelled match with a start_date. NEVER Stripe.
  type Play = { u: number; month: string; date: string; city: string; field: string };
  type Agg = {
    first: string;
    firstDate: string;
    firstCity: string;
    firstField: string;
    last: string;
    count: number;
    active: Set<string>;
  };
  const agg = new Map<number, Agg>();
  let sourceRows = 0;
  for (const p of players) {
    if (p.deleted_at || p.user_is_fake_player || p.paid_status === "WAITING" || p.canceled_at) continue;
    if (p.user_id == null || p.match_api_id == null) continue;
    const m = live.get(p.match_api_id);
    if (!m || m.is_cancelled || !m.start_date) continue;
    sourceRows++;
    const play: Play = {
      u: p.user_id,
      month: m.start_date.slice(0, 7),
      date: m.start_date.slice(0, 10),
      city: normalizeMatchCity(m.city_identifier),
      field:
        canonicalVenueName(m.field_title ?? "") ||
        (m.field_id != null ? `Field ${m.field_id}` : "Unknown field"),
    };
    let a = agg.get(play.u);
    if (!a) {
      a = { first: play.month, firstDate: play.date, firstCity: play.city, firstField: play.field, last: play.date, count: 0, active: new Set() };
      agg.set(play.u, a);
    }
    a.count++;
    a.active.add(play.month);
    if (play.month < a.first) a.first = play.month;
    // first-match city/field = the earliest-dated play; ties resolve to the first
    // such row encountered (deterministic given the api_id ordering of the fetch).
    if (play.date < a.firstDate) {
      a.firstDate = play.date;
      a.firstCity = play.city;
      a.firstField = play.field;
    }
    if (play.date > a.last) a.last = play.date;
  }

  const nowMonth = nowIso.slice(0, 7);
  const nowIdx = idxOf(nowMonth);
  let minIdx = Infinity;
  for (const a of agg.values()) minIdx = Math.min(minIdx, idxOf(a.first));
  const cohortMonths: string[] = [];
  if (Number.isFinite(minIdx)) for (let i = minIdx; i <= nowIdx; i++) cohortMonths.push(keyOf(i));
  const cohortIdxByKey = new Map(cohortMonths.map((k, i) => [k, i]));

  const cities: string[] = [];
  const cityIdx = new Map<string, number>();
  const fields: string[] = [];
  const fieldIdx = new Map<string, number>();
  const intern = (arr: string[], map: Map<string, number>, s: string): number => {
    let i = map.get(s);
    if (i == null) { i = arr.length; arr.push(s); map.set(s, i); }
    return i;
  };

  const out: RetentionPlayer[] = [];
  for (const [u, a] of agg) {
    const absCohort = idxOf(a.first);
    let mask = 0;
    for (let n = 0; n <= MAX_AGE; n++) if (a.active.has(keyOf(absCohort + n))) mask |= 1 << n;
    out.push({
      u,
      c: cohortIdxByKey.get(a.first) ?? 0,
      ct: intern(cities, cityIdx, a.firstCity),
      f: intern(fields, fieldIdx, a.firstField),
      l: a.last,
      m: a.count,
      k: mask,
    });
  }

  return {
    cohortMonths,
    nowMonth,
    cities,
    fields,
    players: out,
    maxMatchDate,
    sourceRows,
    distinctPlayers: out.length,
    buildMs: Date.now() - t0,
    generatedAt: nowIso,
  };
}

// In-process cache keyed on the max match date. A warm instance rebuilds only
// when a backfill lands a newer match; cold starts rebuild once. Never paginates
// the 232k participation rows per request.
let cache: { key: string; agg: RetentionAggregate } | null = null;

export async function getRetentionAggregate(
  sb: SupabaseClient,
): Promise<RetentionAggregate & { cached: boolean; fetchMs: number }> {
  const t0 = Date.now();
  // Cheap key probe (1 row): the latest live match date.
  const { data: maxRow } = await sb
    .from("mdapi_matches")
    .select("start_date")
    .is("deleted_at", null)
    .not("start_date", "is", null)
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const key = (maxRow?.start_date ?? "").slice(0, 10);
  if (cache && cache.key === key) return { ...cache.agg, cached: true, fetchMs: Date.now() - t0 };

  const [matches, players] = await Promise.all([
    selectAll<RawMatch>(() =>
      sb
        .from("mdapi_matches")
        .select("api_id, start_date, city_identifier, field_id, field_title, is_cancelled, deleted_at")
        .order("api_id"),
    ),
    selectAll<RawPlayer>(() =>
      sb
        .from("mdapi_match_players")
        .select("user_id, match_api_id, paid_status, canceled_at, user_is_fake_player, deleted_at")
        .order("api_id"),
    ),
  ]);
  const fetchMs = Date.now() - t0;
  const agg = buildRetention(matches, players, new Date().toISOString());
  cache = { key, agg };
  return { ...agg, cached: false, fetchMs };
}
