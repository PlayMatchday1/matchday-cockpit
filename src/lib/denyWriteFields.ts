// The write-deny field list — the ONE source of truth, kept client-safe (no
// "server-only") so both the server write guard (matchdayStageApi) and the
// client-side Change Log deny-key guard import the SAME set and cannot drift.
//
// Fields no screen may write without a deliberate design decision. Result + teams
// array only (teams edited via PUT /admin/teams/{id}); scores are result entry.
// `password` is WRITE-ONLY on teams (Retool sends it, the GET never returns it), so an
// accidental write is undetectable AND unrestorable — and a log must never store it.
export const DENY_WRITE_FIELDS = new Set<string>([
  "teams", "teamHomeId", "teamAwayId", "teamHomeScore", "teamAwayScore", "password",
]);
