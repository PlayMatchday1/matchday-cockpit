// THE NIGHT PASS — every full read of the production MatchDay API, once a day (Ryan, 2026-10-21,
// after the R15 outage at 2:05 PM Central: "never run a full pull during the day").
//
// UTC, because Vercel cron is UTC. Central summer time in brackets; an hour earlier in winter.
//   08:00 (3:00)  /api/sync/player-areas        every player → player_area_seen + mdapi_users, in legs
//                                                (~185 pages, ~5 min; the next leg on the :05 tick)
//   08:09 (3:09)  /api/sync/player-areas/unlisted  mdapi_users rows the walk did not return, re-read one by
//                                                one from the detail endpoint (at most 60, ~1 min)
//   08:12 (3:12)  /api/sync/matches/full/1      matches + EVERY roster, first 7 days of the window
//   08:17 (3:17)  /api/sync/matches/full/2      the next 7
//   08:22 (3:22)  /api/sync/matches/full/3      the next 7
//   08:27 (3:27)  /api/sync/matches/full/4      the next 7
//   08:32 (3:32)  /api/sync/matches/full/5      the rest (~47 days, sparse: the schedule is thin beyond ~2 weeks)
//   08:47 (3:47)  /api/sync/reviews/full/1      every review, from /admin/matches/reviews: pages 1–145
//   08:53 (3:53)  /api/sync/reviews/full/2      the rest (~142 pages)
// Each is paced (one request a second, no retries, stop at the first error — getPacedClient) and is
// scheduled to end before the next starts, so only one of them talks to MatchDay at a time.
//
// THE HOURLY JOBS STAND DOWN IN THIS HOUR (inNightPassHour): the GitHub matches run (:00), the signup
// sync (:05) and the location sync (:35). The night pass is reading everything they would.
//
// A night-pass step that finds the player pass still running stands down and logs it as failed —
// two full reads at once is the thing this schedule exists to prevent.

export const NIGHT_PASS_HOUR_UTC = 8;
export const inNightPassHour = (now: Date = new Date()): boolean => now.getUTCHours() === NIGHT_PASS_HOUR_UTC;
export const NIGHT_PASS_SKIP = "Skipped: the 3 AM Central full pass (08:00–08:59 UTC) is reading this.";

/** The five match-window slices of the night pass. Contiguous, each one day into the next: whether
 *  /admin/matches' toDate is inclusive is UNKNOWN, and the overlap costs a few rosters, not a gap.
 *
 *  SLICED BY DENSITY, NOT EQUAL DAYS (2026-11-18). The window is −14 to +60 days, but matches sit in
 *  the first four weeks (~25 a day) and thin out after (~2 a day). Four equal quarters put ~470 rosters
 *  in the first one — ~485 s at a request a second against a 300 s function — so quarter 1 was cut off
 *  and never completed on any night logged (Nov 15–18). Seven-day slices hold ~180–200 rosters
 *  (~200–220 s); the last takes the sparse remainder. */
export const MATCH_SLICES = 5;
export const SLICE_DAYS = 7;
export function windowSlice(win: { fromDate: string; toDate: string }, slice: number, n = MATCH_SLICES): { fromDate: string; toDate: string } {
  if (!Number.isInteger(slice) || slice < 1 || slice > n) throw new Error(`slice must be 1..${n}`);
  const day = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`) / 86_400_000;
  const ymd = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
  const a = day(win.fromDate), b = day(win.toDate);
  const start = Math.min(b, a + (slice - 1) * SLICE_DAYS);
  const end = slice === n ? b : Math.min(b, a + slice * SLICE_DAYS);
  return { fromDate: ymd(start), toDate: ymd(end) };
}
