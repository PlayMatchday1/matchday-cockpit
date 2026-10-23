/* BEFORE / AFTER THE NEW FAKE LADDER — the six numbers, as a pure function over mirror rows.
 * Nothing here fetches. The route (/api/matchday/production/fake-ladder/compare) reads the rows.
 *
 * EVERY NUMBER IS COMPUTED THE SAME WAY ON BOTH SIDES. The comparison is only worth anything if a
 * difference comes from the matches, not from a change in method between the two windows.
 *
 * ── THE SIX ───────────────────────────────────────────────────────────────────────────────────
 *  played rate          not cancelled / all completed matches.
 *  viable auto-cancels  auto-cancelled matches whose shown count (real + fake) at 3h was at or
 *                       above the minimum: they looked like they would play, then cancelled.
 *                       "Auto-cancelled" = cancelled, with the match last updated within the
 *                       auto-cancel window (the cancel itself is the last write; measured on 170
 *                       of 233 cancels, docs/matchday-api-facts.md). Fakes at 3h come from the
 *                       LADDER (capacity − 3h rung − real at 3h), because the mirror sees fake
 *                       removals only to within a sync interval. Today's capacity and rung.
 *  fakes at kickoff     mean of mdapi_matches.fake_player_count on played matches: the API's own
 *                       count, synced after kickoff (it matched a roster rebuild on 757 of 780).
 *  shown vs checked-in  on played matches where check-in covered ≥80% of the booked players:
 *                       (real at kickoff + fakes) − checked in (ON_TIME + LATE). Mean.
 *  real at the deadline mean real players at kickoff − autoCanceledMinutes (75 if unset), all
 *                       matches, played or not.
 *  1–2 star share       reviews of these matches rated 1 or 2, over all their reviews.
 *
 * REAL = a roster row that is not a fake booking, not WAITING (a checkout that never settled), and
 * not cancelled or removed by that moment. The same population as _count.players minus fakes.
 */

export type CmpMatch = {
  api_id: number; city_name: string | null; start_date: string; start_date_utc: string; updated_at: string | null;
  is_cancelled: boolean | null; min_player_count: number | null; max_player_count: number | null;
  auto_canceled_minutes: number | null; fake_player_count: number | null; field_title: string | null;
  rung3h: number | null;
};
export type CmpRow = {
  match_api_id: number; user_is_fake_player: boolean | null; paid_status: string | null;
  created_at: string | null; canceled_at: string | null; deleted_at: string | null;
  user_status: string | null; is_absent: boolean | null;
};
export type CmpReview = { field_title: string | null; start_date: string | null; star_rating: number | null };

export type CohortStats = {
  matches: number; played: number; playedRate: number | null;
  autoCancels: number; viableAutoCancels: number;
  fakesAtKickoff: number | null; playedWithFakeCount: number;
  gap: number | null; gapMatches: number;
  realAtDeadline: number | null;
  reviews: number; lowStarShare: number | null;
};

const T = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function realAt(rows: CmpRow[], t: number): number {
  let n = 0;
  for (const r of rows) {
    if (r.user_is_fake_player === true || r.paid_status === "WAITING") continue;
    const start = T(r.created_at);
    if (!(start <= t)) continue;
    if (Number.isFinite(T(r.canceled_at)) && T(r.canceled_at) <= t) continue;
    if (Number.isFinite(T(r.deleted_at)) && T(r.deleted_at) <= t) continue;
    n++;
  }
  return n;
}

/** Cancelled, and last written inside the auto-cancel window (the cancel was the last write). */
export function isAutoCancel(m: CmpMatch): boolean {
  if (m.is_cancelled !== true) return false;
  const mins = (T(m.start_date_utc) - T(m.updated_at)) / 60_000;
  const win = Number(m.auto_canceled_minutes) > 0 ? Number(m.auto_canceled_minutes) : 75;
  return mins >= win - 20 && mins <= win + 15;
}

export function cohortStats(matches: CmpMatch[], rowsByMatch: Map<number, CmpRow[]>, reviews: CmpReview[]): CohortStats {
  const played = matches.filter((m) => m.is_cancelled !== true);
  const auto = matches.filter(isAutoCancel);
  let viable = 0;
  for (const m of auto) {
    const k = T(m.start_date_utc), rows = rowsByMatch.get(m.api_id) ?? [];
    const real3 = realAt(rows, k - 3 * 3_600_000);
    const fake3 = Math.max(0, Number(m.max_player_count ?? 0) - Number(m.rung3h ?? 0) - real3);
    if (real3 + fake3 >= Number(m.min_player_count ?? 0)) viable++;
  }
  const withFake = played.filter((m) => m.fake_player_count != null);
  const gaps: number[] = [];
  for (const m of withFake) {
    const k = T(m.start_date_utc), rows = rowsByMatch.get(m.api_id) ?? [];
    const booked = rows.filter((r) => r.user_is_fake_player !== true && r.paid_status !== "WAITING"
      && T(r.created_at) <= k && !(T(r.canceled_at) <= k) && !(T(r.deleted_at) <= k));
    if (!booked.length) continue;
    const on = booked.filter((r) => r.is_absent !== true && (r.user_status === "ON_TIME" || r.user_status === "LATE")).length;
    const marked = booked.filter((r) => r.is_absent === true || r.user_status === "ON_TIME" || r.user_status === "LATE" || r.user_status === "NO_SHOW").length;
    if (marked / booked.length < 0.8) continue;
    gaps.push(booked.length + Number(m.fake_player_count) - on);
  }
  const deadline = matches.map((m) => {
    const win = Number(m.auto_canceled_minutes) > 0 ? Number(m.auto_canceled_minutes) : 75;
    return realAt(rowsByMatch.get(m.api_id) ?? [], T(m.start_date_utc) - win * 60_000);
  });
  /* REVIEWS HAVE NO MATCH ID. They carry the field title and the match's wall-clock start, which is
   * how they are tied back — the same pairing Reviews uses. Compared as strings, never as Dates. */
  const keys = new Set(matches.map((m) => `${m.field_title ?? ""}|${String(m.start_date).slice(0, 16)}`));
  const rv = reviews.filter((r) => r.star_rating != null && keys.has(`${r.field_title ?? ""}|${String(r.start_date ?? "").slice(0, 16)}`));
  return {
    matches: matches.length, played: played.length, playedRate: matches.length ? played.length / matches.length : null,
    autoCancels: auto.length, viableAutoCancels: viable,
    fakesAtKickoff: mean(withFake.map((m) => Number(m.fake_player_count))), playedWithFakeCount: withFake.length,
    gap: mean(gaps), gapMatches: gaps.length,
    realAtDeadline: mean(deadline),
    reviews: rv.length, lowStarShare: rv.length ? rv.filter((r) => Number(r.star_rating) <= 2).length / rv.length : null,
  };
}
