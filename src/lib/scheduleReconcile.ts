// Master Schedule auto-reconcile — pure classification + eligibility. No
// server-only imports so every branch is unit-testable. The DB/write side is
// in the /api/schedule-master/reconcile route.
//
// Ground rule: a completed match definitively happened and must never sit in a
// "missing on Clubhouse" list awaiting confirmation. We DERIVE completion
// (mdapi_matches has no status field) with a corrected predicate:
//   - is_cancelled is the ONLY cancel signal (auto_canceled is a POLICY flag,
//     not an outcome — 418/440 auto_canceled rows carry star ratings).
//   - player_count / min_player_count are nullable, so a match with missing
//     player data and no ratings is NOT assumed cancelled; it's CAN'T TELL and
//     stays visible for a human, never silently dropped.

// Hard cutoff — never auto-add a match that ended before this. Set to the
// deploy date so the first run doesn't backfill pre-feature history; the
// 14-day lookback then governs day-to-day. MUST be <= now, or the eligible
// window [max(now-lookback, cutoff), now] is empty and nothing ever adds.
// Env-overridable (redeploy) to widen/narrow the initial backfill.
export const SCHEDULE_RECONCILE_START =
  process.env.SCHEDULE_RECONCILE_START ?? "2026-07-26T00:00:00Z";

// Lookback: only auto-add matches that ended within this window. Combined with
// the partial UNIQUE(match_api_id), a missed run self-heals on the next run
// rather than losing matches. 14 days (same lesson as the community poster).
export const SCHEDULE_RECONCILE_LOOKBACK_DAYS = 14;

export type CompletionBucket = "happened" | "didnt_happen" | "cant_tell";

export type ReconcileMatch = {
  api_id: number;
  end_date_utc: string | null;
  is_cancelled: boolean | null;
  player_count: number | null;
  min_player_count: number | null;
  star_rating_count: number | null;
};

// Corrected 3-bucket completion classifier (past matches).
export function classifyCompletion(m: ReconcileMatch): CompletionBucket {
  if (m.is_cancelled === true) return "didnt_happen";
  const rated = (m.star_rating_count ?? 0) > 0;
  const filled =
    m.player_count != null &&
    m.min_player_count != null &&
    m.player_count >= m.min_player_count;
  if (rated || filled) return "happened";
  // Not cancelled, no ratings, and player data is null or under-min: we can't
  // assert it happened OR that it didn't. Keep it visible for a human.
  return "cant_tell";
}

// A match is eligible for AUTOMATIC add (§1) only if it definitively happened,
// ended in the past, within the lookback window, and after the hard cutoff.
export function isAutoAddEligible(
  m: ReconcileMatch,
  ctx: { nowMs: number; cutoffMs: number; lookbackDays: number },
): boolean {
  const endMs = m.end_date_utc ? Date.parse(m.end_date_utc) : NaN;
  if (Number.isNaN(endMs)) return false;
  if (endMs > ctx.nowMs) return false; // not in the past
  if (endMs < ctx.nowMs - ctx.lookbackDays * 86_400_000) return false; // too old
  if (endMs < ctx.cutoffMs) return false; // before deploy-date cutoff
  return classifyCompletion(m) === "happened";
}

// Venue-local calendar date + minutes for a match. mdapi start_date/end_date
// are venue-local wall clock stamped at a fake +00:00 offset, so reading UTC
// parts yields the local wall-clock (same approach as veo.matchLocalStart and
// schedule-master/discrepancies). Used to place the one-off on its ACTUAL date.
export function matchLocalDateTime(
  startDate: string | null | undefined,
): { date: string; timeLabel: string } | null {
  if (!startDate) return null;
  const ts = Date.parse(startDate);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  const h24 = d.getUTCHours();
  const min = d.getUTCMinutes();
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const timeLabel = min === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
  return { date: d.toISOString().slice(0, 10), timeLabel };
}

// mdapi short code → schedule_master display city. schedule_master.city stores
// display names ("St. Louis"), so an auto-added / one-click row must too.
export const CITY_CODE_TO_DISPLAY: Record<string, string> = {
  ATX: "Austin",
  HOU: "Houston",
  SATX: "San Antonio",
  DFW: "Dallas",
  ATL: "Atlanta",
  STL: "St. Louis",
  OKC: "OKC",
  ELP: "El Paso",
  /* WARSAW. Added 2026-08-23. It was absent, and its absence was silently DROPPING every Warsaw
   * match at veoSchedule.ts:101 ("only fleet cities appear in the grid") — so a Warsaw operator saw
   * an empty Master Schedule with the matches sitting in the payload behind it.
   *
   * Ten of this map's eleven consumers already fell back to the raw code, so Warsaw was rendering
   * as the string "WAW" on dataRoom, scheduleReconcile, growth and retention. For those this is a
   * spelling fix, not a new row: same rows, same totals, "WAW" becomes "Warsaw". */
  WAW: "Warsaw",
};
