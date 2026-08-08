# Retool PRODUCTION export inventory (Phase 6) — read-only

Source: retool-export-prod.json (gitignored). Decoded from Retool's Transit-encoded
`page.data.appState`. NOTHING was fired; no endpoint was called; no write performed.
Base URL is indirected through `globalVar.value.serverApiUrl`; the production API is
https://playmatchday.herokuapp.com (Phase 8). Note: this export's SAVED globalVar
value points at an ngrok dev tunnel — the host is selected per Retool environment,
not hardcoded to prod in the saved state.

~192 query plugins. Folder counts (query plugins incl REST/SQL/JS/Function):
  special_events 43 | (loose, no folder) 33 | promocodes_folder 30 | Matches 24 |
  memeberships 17 | users 14 | database 9 | cityManagers 8 | goals 4 | fields 3 |
  userReviews 3 | leaderBoard 2 | Messages 2

## PART A — how Retool updates a match (partial vs full)

`updateMatch` = PUT `/admin/matches/{id}`. The body is a HAND-BUILT object of ~28
writable fields (not an echo of the GET). Most fields are sent UNCONDITIONALLY at
their current widget values; four are guarded so they are OMITTED (JS `undefined`,
dropped by JSON.stringify) when unchanged:

    "endDate":   {{ matches.selectedRow.data.endDate   !== updateMatchEndDate.value   ? updateMatchEndDate.value   : undefined }},
    "startDate": {{ matches.selectedRow.data.startDate !== updateMatchStartDate.value ? updateMatchStartDate.value : undefined }},
    "fieldId":   {{ parseInt(...) !== parseInt(updateMatchFieldSelect.value) ? parseInt(updateMatchFieldSelect.value) : undefined }},
    "registrationPrice": {{ ...!== parseInt(updateMatchRegistrationPrice.value*100) ? parseInt(...*100) : undefined }},

Answers:
1. FULL-ish object, not a computed diff. ~28 fields every time; only start/end/
   fieldId/registrationPrice are conditional.
2. It never includes the 22 read-only fields — the body is hand-built, so there is
   nothing to strip. (It does NOT echo-and-strip.)
3. Not a diff. It relies on the API's partial-update semantics only for the four
   guarded fields (undefined -> key omitted -> untouched).
4. Rides-along fields the admin does not directly edit: `hasOrganizer: true`
   (HARDCODED), `teams: {{ teamListView.data }}` (the FULL teams array, every
   write), `maxPlayerCount` (computed = recommend * teamNumbers), `maxTeamSize2Team`
   (=recommend*2), `maxTeamSize4Team` (=recommend*4), and `teamNumbers`.
   `teamNumbers` is WRITE-ONLY: it is accepted on write but is NOT one of the 54
   fields the GET returns (so it was invisible to Phase 8's echo-derived set).
5. startDate and endDate are sent INDEPENDENTLY, each guarded on its own. They are
   NOT sent as a pair, and duration is NOT preserved. Moving start without end is
   reachable — this is almost certainly how staging match 2473 got a negative
   duration.
6. maxPlayerCount is sent on EVERY update, right alongside the team-size fields —
   never omitted.

Also proving partial-apply: `attachCityManagerToMatch` PUTs `/admin/matches/{id}`
with a body of JUST `{ "managerId": ... }` (and the 2nd-manager variant just
`{ "secondManagerId": ... }`). Single-field PUTs have worked in production for
years.

PREDICTION for Phase 9: **the production PUT is a PARTIAL apply** — it applies
exactly the keys present and leaves omitted keys untouched (same as staging).
Retool depends on this (undefined-omission + single-field manager PUTs). If Phase 9
finds production does a FULL replace (nulling omitted fields), that contradicts
both Retool and staging and IS the finding.

## PART B — operation inventory (match + roster)

    operation                         method + path                                              payload
    add player to a match             POST   /admin/matches/{matchId}/players/{userId}           [{team},{playerNumber}]
    add RANDOM/fake player            POST   /admin/matches/{matchId}/fake-players               [{team},{playerNumber}]
    add fake players in bulk          POST   /admin/matches/{matchId}/batch/fake-players         [{totalFakes}]
    move player between teams          POST   /admin/user-matches                                 {userMatchId,team,playerNumber}
    remove player from a match        DELETE /admin/matches/{matchId}/players/{playerId}          (none)
    remove player (by user-match id)  DELETE /admin/matches/user-matches/{userMatchId}            (none)
    set/reset player as fake          PATCH  /admin/players/{playerId}/fake-player                (none)
    mark player absent                PATCH  /admin/matches/{matchId}/user-matches/{umId}/absent  (none)
    refund + cancel a player          PATCH  /admin/matches/{matchId}/players/{playerId}/refund-and-cancel  (none)
    update team tee price             PUT    /admin/teams/{teamId}                                {name,locked,password,price*100}
    lock / unlock a team              PUT    /admin/teams/{teamId}                                {locked} (same body as tee price)
    get players in a match            GET    /admin/matches/{matchId}/players                     -
    get players to add                GET    /admin/players?email&id&limit&page&sortColumn&sortDirection  -
    update a match                    PUT    /admin/matches/{id}                                  ~28-field body (see Part A)
    attach manager / 2nd manager      PUT    /admin/matches/{id}                                  {managerId} / {secondManagerId}
    cancel a match                    PATCH  /admin/matches/{id}/cancel                           {id}
    create a match                    POST   /admin/matches                                       ~26-field body
    copy one match                    POST   /admin/matches/{id}/copy                             []
    clone this week                   POST   /admin/matches/clone-by-week?                        []
    copy from/to week                 POST   /admin/matches/copy-by-week                          {fromWeekStartDate,toWeekStartDate}
    delete a match                    DELETE /admin/matches/{id}                                  (none)
    get a match                       GET    /admin/matches/{id}                                  -
    get matches (list)                GET    /admin/matches?limit&page&cityId&fromDate&toDate&fieldId&sortColumn&sortDirection&isCancelled=false  -

All of the above are REST. No roster/match WRITE is SQL.

## PART C — the four copy/schedule operations

All copies are a SINGLE server-side POST — Retool is a thin trigger; the date math
(add a week, DST, per-city timezone) lives on the SERVER and is NOT visible in the
export. None is a client loop, so there is no half-finished client state.

- **Make Copy Match** (`createCopyMatchById`): POST `/admin/matches/{id}/copy`,
  body `[]`. One request. On success -> getMatches. Copies whatever the server's
  /copy does (roster/manager/price not decidable from the client).
- **Make Copy Matches by this week** (`makeCopyMatchesByThisWeek`): POST
  `/admin/matches/clone-by-week?`, body `[]` (no params). Server picks the week.
- **Make Copy Matches From/To Week** (`makeCopyMatchesByFromToWeek`): POST
  `/admin/matches/copy-by-week`, body `{fromWeekStartDate: copyMatchesFromWeek.value,
  toWeekStartDate: copyMatchesToWeek.value}` — two week-start strings from date
  pickers, passed verbatim. No client date arithmetic.
- **Add Manager** (`attachCityManagerToMatch` / `...2...`): PUT `/admin/matches/{id}`
  with `{managerId}` (or `{secondManagerId}`). Not a copy — a single-field match
  update.

Date handling: the copy buttons do NOT add days to a string or round-trip a Date —
they delegate to the server (or pass a week-start string). The only client-side
date math in the app is the MANAGER-REPORT week nav (`nextWeek`/`previousWeek`/
`setCurrentStartWeek`), which is NOT wired to copy. Those DO show the naive pattern
(`new Date(str)` then `setDate(getDate()+7)`, and unpadded `YYYY-M-D` formatting) —
worth remembering as the house style, but it does not touch the copy operations.

DOUBLE-RUN / idempotency (the important part): none of the three copies carries an
idempotency key. Each is a create. Running "copy this week" or "copy from/to week"
twice fires a second POST and the server creates a SECOND full set — a duplicated
week of the schedule. "Make Copy Match" twice makes two copies. Whether the
server-side batch is transactional on partial failure is NOT observable from the
export.

## PART D — direct SQL

Direct Postgres (SqlQueryUnified, resource 17d8a898-... ; NOT the API), all
read-only SELECTs for CSV export / reporting:
  - database folder: getForDownloadMembers, getForDownloadUserAnalysisData,
    getTotalCountForUserForAnalysis, getUnverifiedUsersFromDB, getUserForAnalysis,
    getUsersFromDB
  - userReviews folder: getForDownloadUserReviews
(The database folder's other 3 — downloadMemberships/downloadUserAnalysis/
downloadUserData — are JavascriptQuery CSV builders, not SQL.)

Exists ONLY as direct SQL (no REST equivalent): the analysis/reporting exports
(getUserForAnalysis, getForDownloadUserAnalysisData, getTotalCountForUserForAnalysis,
getForDownloadMembers, getForDownloadUserReviews) — heavy joins with tz conversion,
no API endpoint. getUnverifiedUsersFromDB / getUsersFromDB DO have REST twins
(getUnverifiedUsers / getUsers).

Consequence: **no WRITE and no roster/match operation is SQL-only** — every match/
roster operation is a REST endpoint. Direct SQL is read-only reporting only. So a
database URL from Vitalii is NOT needed to build the roster/match write work; it
would only be needed to reproduce the reporting exports (read-only), and only for
whichever environment we want to report on.

## PART E — the manager dropdown

It comes from REST endpoints, NOT SQL, NOT hardcoded:
  - `getCityManagersForAttachToMatch`: GET `/city-managers/users?email={search}&cityId={match city}`
  - `getCityManagers`: GET `/city-managers?cityId={filter}`
Both are on the `/city-managers` route family (NO `/admin` prefix). It filters by
the match's city (and optional email search). Active/deleted (`del_<hash>`) handling
is not done client-side (the transformer is a pass-through / commented out) — the
server returns the city's managers. What it does when the current managerId is not
in the list is not handled client-side.

=> Contradicts the Phase 7 assumption that "the API has no list-managers endpoint."
There IS one. The drawer can populate a real city-scoped manager dropdown from
`GET /city-managers/users?cityId=...` instead of numeric ID inputs.

## PART F — name-only diff vs stage

prod query plugins 192, stage 190.
  IN PROD NOT STAGE (2): query1, query2  (both empty `connectResource` scaffolds —
    not real operations)
  IN STAGE NOT PROD: none
Every match/roster operation exists in BOTH apps. Roster creates/deletes can be
rehearsed on staging before pointing at real matches.

## PART G — reconciliation with docs/matchday-api-facts.md

- CONTRADICTION (manager endpoint): facts/Phase 7 said no list-managers endpoint;
  Retool uses GET /city-managers/users and /city-managers. There is one.
- DISAGREEMENT (date pair): Phase 7 chose to send startDate+endDate as a PAIR to
  preserve duration and forbid inversion. Retool sends them INDEPENDENTLY and can
  invert a match — which is consistent with staging 2473's negative duration.
  Observed behaviour wins; our paired approach is the deliberately-safer choice, and
  production has历 inverted-capable writes. (Keep pairing in our client.)
- `teams` is on OUR write-client deny-list, yet Retool writes `teams`
  (teamListView.data) on EVERY match update. So `teams` IS writable via the match
  PUT (Retool proves it); we deny it by choice, not because the API refuses it.
- NEW: `teamNumbers` is a WRITE-ONLY field (accepted on write, absent from the 54
  GET fields / the Phase-8 echo-derived 32). `hasOrganizer:true` is hardcoded on
  every Retool write; maxPlayerCount/maxTeamSize* are computed from "recommend *
  teamNumbers".
- CONSISTENT: prices in cents (value*100); partial-update apply (undefined-omission
  + single-field manager PUTs); the 22 read-only set is never sent by Retool.
