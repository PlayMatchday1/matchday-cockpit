# MatchDay API - facts established by observation

This file records what we know about the MatchDay admin API **from watching it
behave**, not from reading its spec. It exists because the OpenAPI spec is a
secondary source with at least two known errors (see below), and because the
match-editing screens in this app are built directly on these facts. If you are
reading this cold six months from now to build the next screen, start here.

## Authority order

When the spec, the code, and the observed behaviour disagree, trust them in this
order:

1. **Observed behaviour** - what the running staging API actually does.
2. **Code** - the NestJS backend / this repo's client.
3. **Spec** - the OpenAPI document. Secondary. Known-wrong in at least two places.

Everything below was established at authority level 1 (observed on staging,
match 2470 and five others) unless noted.

## Environments and the write client

- All writes so far are **staging only**: `https://matchday-stage.herokuapp.com`.
  Production is `https://playmatchday.herokuapp.com`.
- Writes go through `src/lib/matchdayStageApi.ts` and nowhere else. That module
  is `import "server-only"`, host-guarded on the parsed URL host (not a flag),
  single-shot with no retry (the API has no Idempotency-Key), and re-mints its
  JWT before expiry. Reads from production stay in `src/lib/matchdayApi.ts`.

## PUT /admin/matches/{id} is a PARTIAL update

Despite being a `PUT`, this endpoint has **PATCH semantics**: it whitelist-
validates the fields you send and leaves every omitted field untouched. Send
only the fields that changed; that diff object *is* the request body.

- Do **not** read-modify-write and echo the whole object back. The backend runs
  a `forbidNonWhitelisted` ValidationPipe, so echoing read-only fields
  (id, updatedAt, relations, ...) returns **HTTP 400**, naming the offending
  read-only fields. That 400 is how we mapped the read-only vs writable sets.
- A multi-field partial write moves exactly the keys you sent, plus the
  server-derived ones (updatedAt, startDateUtc, endDateUtc, ...). Proven.

## Prices are in CENTS

`registrationPrice` and `additionalSpotPrice` are integer **cents**.
`12000` renders as `$120.00`. Proven by writing `13337` and watching the editor
render `$133.37`, stored verbatim. Never send dollars.

## The field sets

There are **32 writable fields** and **22 read-only fields** on a match.

**Read-only (22)** - reject on write (they trip the 400): the id, the audit
timestamps, the derived `*Utc` dates, relation objects, `_count`, star ratings,
and the other server-owned fields surfaced by the whitelist rejection.

**Writable (32)** = the **23 modeled** editable keys (see
`EDITABLE_KEYS` in `src/lib/matchEditModel.ts`) **+ 9 writable-but-unmodeled**
fields. The 9 unmodeled writable fields are:

    teams, teamHomeId, teamAwayId, teamHomeScore, teamAwayScore,
    startDate, endDate, maxPlayerCount, hasOrganizer

## The deny-list: 5 fields blocked in the write client (was 7 - see Phase 7)

`DENY_WRITE_FIELDS` in `matchdayStageApi.ts` refuses these **5** before any
network call (throws `DeniedFieldError`):

    teams, teamHomeId, teamAwayId, teamHomeScore, teamAwayScore

Why denied: these are the match **result** and the teams array. Teams are edited
through their own endpoint (`PUT /admin/teams/{id}`); scores are a result-entry
action, not a field in a general match edit. Blind writes here corrupt outcomes.

The deny-list lives in the **write client**, not in any one screen - so every
screen built on the client inherits it. A field is dangerous because of the
API, not because a given component happens to lack a control for it.

`maxPlayerCount` and `hasOrganizer` were never denied - plausible future
controls, just unmodeled. `maxPlayerCount` is now surfaced in the full editor
(Phase 7 Part E). `startDate` and `endDate` were denied through Phase 6 and
came **off** the list in Phase 7; see the next section.

## Phase 7 date decision - startDate/endDate writable, editor owns the pair

Phase 7 lifted `startDate` and `endDate` off the deny-list. This was a
deliberate design decision, recorded here, not a bug fix.

**Evidence (staging match 2470, single writes, restored):**

- PUT `{ startDate }` shifted +1h -> startDate moved; the server re-derived
  `startDateUtc` by exactly +1h with the field offset preserved (5h, CDT);
  `endDate`/`endDateUtc` did **not** move; nothing else moved. Duration silently
  went 24.00h -> 23.00h.
- PUT `{ startDate, endDate }` both +1h -> both moved, both `*Utc` followed +1h,
  **duration preserved** at 24.00h, nothing else moved.

**The problem this created:** a start-only write silently changes a match's
duration, and because nothing validates the pair server-side (staging match 2473
has `endDate` BEFORE `startDate` - a negative duration is a reachable state), a
start-only shift can push a match past its own end.

**The decision - option (a): a time edit sends startDate AND endDate together,**
**preserving the loaded duration.** Chosen over option (b) (send startDate alone,
block any edit that would reach endDate) because:

- A "change the start time" edit that silently shortens or lengthens the match
  is a worse surprise than writing one extra, structurally identical field.
- Option (b) cannot repair a match that is *already* inverted; option (a)'s pair
  write can.
- The pair write is proven (above) and moves nothing unexpected.

**The rules any date/time control must follow:**

- Compute the delta from the loaded `startDate`, apply the SAME delta to the
  loaded `endDate`, send both. Preserve the original duration.
- The value is the wall-clock string verbatim: `date + "T" + time +
  ":00.000Z"`. **Never** call `new Date()` on it, never convert, never
  round-trip through a Date object (that reads the Z as UTC - see the landmine
  above). String surgery only.
- Never write the `*Utc` fields; the server derives them.
- A match that **loads already inverted** (`endDate` <= `startDate`) is shown as
  a warning and its date/time edit is held back - it is not silently rewritten.

## Dates: startDate/endDate are LOCAL WALL-CLOCK wearing a Z

This is the biggest landmine in the whole API.

- `startDate` and `endDate` come back with a `Z` suffix but they are **local wall
  time**, not UTC. `2026-08-07T20:04:29.753Z` means 8:04 PM *local*, not 8:04 PM
  UTC.
- `startDateUtc` and `endDateUtc` are the **DST-aware server derivations** - the
  true instant, computed through the match's timezone. Observed offsets:
  `+5h` in August (Central Daylight Time) and `+6h` in December (Central
  Standard Time). Production runs Central **and** Eastern cities, so the offset
  differs by **city AND by season**. There is no single constant to add.

**The landmine:** calling `new Date(startDate)` parses that `Z` as UTC and lands
the time 5 or 6 hours off. To read the wall-clock label safely, use the
`getUTC*` accessors on the parsed date (they pull back the labelled wall-clock
components) - which is exactly what `src/app/api/schedule-master/route.ts` does.
To get the true instant, use the `*Utc` field, which is what `matchPnL` and the
payment-window matching in `src/lib/mdapiMatchesRead.ts` use.

**Which date is authoritative:** the business already treats **`startDate`
(local wall-clock)** as the authoritative scheduling field - the schedule grids,
manager-pay, and slate views all key off the synced `start_date` column, and the
sync copies the API's `startDate` verbatim. `start_date_utc` is stored alongside
and used only where a genuine instant is required. So a future date control must
send **`startDate`** (local wall time, labelled `Z`, the same shape the API
returns) and let the server recompute `startDateUtc`/`endDateUtc`. Never write
the `*Utc` fields directly - they are derived and read-only.

**endDate carries real data, not a default:** across the six staging matches
pulled, durations (startDate -> endDate) were 24.00h, 30.93h, 9.00h, 0.75h,
0.25h, and one **negative** -9.75h (endDate before startDate). They vary widely,
so endDate is genuine per-match data (messy on staging test matches), not a
fixed 24h default. It stays denied regardless.

## autoCanceledMinutes is MINUTES (spec says hours - spec is WRONG)

`autoCanceledMinutes` is measured in **minutes**. The OpenAPI spec labels the
unit "hours"; the spec is **wrong**. Confirmed by Ryan, who operates the product.
Any control for this field is a minutes input - do not multiply or divide by 60.
(This is the authority order in action: operator + observed behaviour over spec.)

## maxPlayerCount vs maxTeamSize - the capacity landmine

Spec descriptions (level 3, but consistent with observed use):

- `maxPlayerCount` - "Maximum amount of players per match". The **total** match
  capacity cap.
- `minPlayerCount` - "Minimum amount of players per match". Total floor.
- `maxTeamSize2Team` - per-team size cap for the 2-team format.
- `maxTeamSize4Team` - per-team size cap for the 4-team format.

`maxPlayerCount` is **real and total, not vestigial and not per-team.** It was a
constant `10` on every staging test match (throwaway data), but in production
(`mdapi_matches.max_player_count`) it carries genuine varying values (12, 16, 18,
20, 30, ...) and is consumed across the app: it drives the tournament-premium
threshold in manager pay (`>= 25` / `> 22`), the "X / Y signed up" capacity
display, and the Soccer Central special-event rule (null/0 = special event).

**The landmine:** `maxTeamSize2Team` / `maxTeamSize4Team` are modeled and
editable, but `maxPlayerCount` is unmodeled and not surfaced. The two are
independent. If someone raises the per-team sizes without also raising
`maxPlayerCount`, the **total** cap can silently limit signups below the intended
team configuration (e.g. a 2-team match with per-team size 10 wants 20 players,
but `maxPlayerCount = 10` caps it at 10). Any screen that edits team sizes must
either surface `maxPlayerCount` too or explicitly account for it.

FIXED in Phase 7 Part E: the full match editor now surfaces `maxPlayerCount` as
an editable field beside the team-size controls and shows an inline warning when
the team layout seats more players than the cap allows. It does NOT auto-correct
(silently raising a capacity is its own surprise). The field is modeled as
NULLABLE, not a NUMERIC "blank = no change" field: null and 0 are both meaningful
(special event), so a blank box becomes null, 0 stays 0, and clearing it is a
real change. See `maxPlayerCount` in matchEditModel's EDITABLE_KEYS + NULLABLE_NUM.

## PRODUCTION verification (Phase 8) — reads + one rejected echo, NO write

Until Phase 8 every fact above was derived on STAGING. Phase 8 checked them
against PRODUCTION (playmatchday.herokuapp.com) with reads plus ONE full-object
echo PUT that was rejected 400 (wrote nothing, re-GET byte-for-byte identical).
No production write has ever been performed.

### Holds identically on both (production == staging)
- Field set: 54 fields, EXACTLY the same names on both — 0 production-only, 0
  staging-only.
- Read-only set: 22 fields, IDENTICAL names on both (from the forbidNonWhitelisted
  400 on a full-object echo, run on each). The 22:
  `_count, bracketRound, createdAt, divisionId, endDateUtc, field, fieldNumber,
  goals, groupNumber, id, isCancelled, manager, players, secondManager,
  starRating, starRatingCount, startDateUtc, teamAway, teamAwayCustomName,
  teamHome, teamHomeCustomName, updatedAt`.
- Writable set: 32 fields, identical (54 − 22). Same PATCH/partial-update
  validation — the echo 400'd on production exactly as on staging.
- Prices are integer cents (registrationPrice / additionalSpotPrice integers).
- startDate/endDate carry a `Z` but are local wall-clock; `startDateUtc −
  startDate = +5h` (whole hour, August / CDT) — the same DST-aware derivation.
- maxPlayerCount is populated and VARIES on real data (saw 18 and 40).
- managerId is number|null, secondManagerId number|null — same shape.

### Differs — data quality only, not schema
- Durations: the finished production matches pulled were ALL exactly 1.00h, none
  negative. Staging ranged 0.25h .. 30.93h including a NEGATIVE (match 2473). So
  the messy/negative staging durations were TEST JUNK, not a real pattern.
  endDate is a real per-match field either way.
- Note: the production LIST endpoint (`GET /admin/matches`) returns only upcoming
  matches; finished matches are reached by id through the DETAIL endpoint (ids are
  chronological).

### Production-only fields (Phase 8 check)
- NONE. The field sets are identical, so there is no never-before-seen production
  field to test. Had the echo shown a production-only field that was WRITABLE, it
  would go straight on the deny-list until understood — the way startDate/endDate
  were — but there is none.

### Still UNVERIFIED on production (staging-only evidence)
Every WRITE-APPLY behaviour. Phase 8 verified production's REJECTION (the
read-only set) and its reads, and confirmed the echoed match was unchanged. It
performed NO production write. So these remain proven on STAGING ONLY, strongly
implied by identical validation but not proven by an applied production write:
- that a production partial write APPLIES only the sent keys (omitted untouched);
- that cents are stored verbatim on write;
- that the startDate/endDate pair moves the derived *Utc by the field offset;
- that maxPlayerCount / team sizes / the rest of the 32 are writable in practice.
That is the next rung — behind the bolt.

## CREDENTIALS — the exact, non-loose version (Phase 8)

Two credential sets point at production from two places. The loose summary
("prod creds are local-only") is WRONG; the precise version:

- **MATCHDAY_API_*** (`MATCHDAY_API_BASE_URL` / `_EMAIL` / `_PASSWORD`) — the
  production READ/sync path (matchdayApi.ts, envHygiene.ts, ~22 sync/probe
  scripts). Wired to Vercel. These credentials are **admin-capable** — the
  `/admin` endpoints require admin and the sync uses them. Therefore the
  **deployed Clubhouse DOES hold production credentials capable of writing.**
- What prevents production writes is NOT a lack of capability — it is that **no
  deployed code path performs one**, now ENFORCED by the write client's two-host
  allowlist + explicit per-call environment argument + the
  `PRODUCTION_WRITES_ENABLED` bolt. Capability without a code path.
- **MATCHDAY_PROD_API_*** (`MATCHDAY_PROD_API_EMAIL` / `_PASSWORD` /
  `MATCHDAY_PROD_BASE_URL`) — the write client's production credentials.
  LOCAL-ONLY (.env.local), NEVER in Vercel; used only by hand-run Phase 8 probes.
  `MATCHDAY_PROD_BASE_URL` has no default — unset throws.
- Two naming schemes now name the same environment. A future rename of the
  Vercel-wired `MATCHDAY_API_*` set to `MATCHDAY_PROD_*` MUST keep these in
  LOCKSTEP or the sync breaks on the next auto-deploy (git-integration deploys on
  push):
    1. the ~24 code call sites (matchdayApi.ts, envHygiene.ts DETECT_ONLY list,
       the sync/probe scripts);
    2. the Vercel environment variables, renamed at the same time the code deploys;
    3. do NOT collapse the two sets into one name — the write set must stay
       local-only, so it needs a name distinct from the Vercel-wired read set.

## Retool production export (Phase 6) — corrections & corroborations

Full inventory: docs/retool-prod-inventory.md. Key points that touch this file:

- CORRECTION — there IS a list-managers endpoint. Retool populates its manager
  dropdown from `GET /city-managers/users?cityId=...&email=...` (and
  `GET /city-managers?cityId=...`), on the `/city-managers` route family (no
  `/admin` prefix). The Phase 7 drawer's numeric-id fallback ("no list-managers
  endpoint") can be replaced by a city-scoped dropdown.
- CORROBORATION — the production PUT is a PARTIAL apply. Retool has relied on it
  for years: `updateMatch` omits startDate/endDate/fieldId/registrationPrice (JS
  `undefined`) when unchanged, and `attachCityManagerToMatch` PUTs a single
  `{managerId}`. (Still unproven by an APPLIED write from us — that is Phase 9.)
- DISAGREEMENT — Retool sends startDate and endDate INDEPENDENTLY (each guarded on
  its own), NOT as a duration-preserving pair, so it can invert a match. This is
  almost certainly how staging 2473 got a negative duration. Our Phase 7 client
  pairs them on purpose; keep it.
- `teams` is writable via the match PUT — Retool sends the full teams array on
  every update. We deny it in our client by choice, not because the API refuses.
- NEW field — `teamNumbers` is WRITE-ONLY: accepted on the match write but absent
  from the 54 GET fields (so invisible to the Phase 8 echo). `hasOrganizer:true`
  is hardcoded on every Retool write; maxPlayerCount / maxTeamSize{2,4}Team are
  computed as recommend * teamNumbers on write.
- Copy/schedule ops are single SERVER-side POSTs (`/copy`, `/clone-by-week`,
  `/copy-by-week`) with no idempotency key — running a week-copy twice duplicates
  the week. All date math for copies is server-side.
- Direct SQL (a Postgres resource, not the API) is read-only reporting/export
  only; NO write or roster op is SQL-only.

## Notifications & the endpoint deny-list (Phase 9)

- The ONLY player-facing notification is match CANCELLATION. Editing a match's
  fields notifies nobody. And `isCancelled` is one of the 22 READ-ONLY fields, so a
  match PUT cannot flip it — cancellation is a separate endpoint
  (`PATCH /admin/matches/{id}/cancel`). The notification risk is therefore isolated
  to specific endpoints, not spread across fields. Confirmed by Ryan.

- The write client now has an ENDPOINT deny-list (`assertAllowedEndpoint`, matched
  on the parsed path SHAPE — method + exact segment list, `{id}` = one wildcard —
  never a substring; trailing slash and query string are stripped). Refused on BOTH
  environments before any network call (throws `DeniedEndpointError`):
    - `PATCH  /admin/matches/{id}/cancel` — cancels the match and notifies every
      signed-up player (the only player-facing notification).
    - `DELETE /admin/matches/{id}` — permanently destroys the match.
    - `PATCH  /admin/matches/{id}/players/{playerId}/refund-and-cancel` — moves
      money (refund) and cancels the player.
  A near-miss like `/admin/matches/{id}/cancel-something-else` is deliberately NOT
  caught, and normal ops (`PUT /admin/matches/{id}`, `DELETE .../players/{pid}`,
  `.../user-matches/{um}/absent`) pass.

- COPY ENDPOINTS — NOT BUILT, warning for whoever builds them. The three copy
  endpoints have NO idempotency key and fan out server-side:
    - `POST /admin/matches/{id}/copy`
    - `POST /admin/matches/clone-by-week`
    - `POST /admin/matches/copy-by-week`
  A double-fire duplicates a week of the schedule. When these are built they need a
  single-fire CLIENT guard (disable-on-submit / one-shot), and undoing one requires
  N `DELETE /admin/matches/{id}` calls — an endpoint that is now on the deny-list.

## The first PRODUCTION write, measured (Phase 9)

Proven by an APPLIED write, not inferred. Target: production match 17256 (finished
2026-08-04, nothing in flight). Body: exactly `{"name": "ATH Pearland [p9]"}` —
one key, single-shot, no retry.

- PRODUCTION PUT **PATCHES, it does not replace.** Sending one key changed exactly
  that key. Diffing ALL 54 readable fields BEFORE vs AFTER: only `name` and
  `updatedAt` moved; the other 52 were byte-for-byte identical. A full-object
  replace would have nulled the ~51 omitted fields — it did not. This matches
  staging and matches Retool's prediction (attachCityManagerToMatch has PUT a lone
  `{managerId}` to production for years).
- Server-recomputed on write: `updatedAt` (only, here). `startDateUtc`/`endDateUtc`
  are recomputed from `startDate`/`endDate` when those change (not exercised this
  phase; from staging evidence). `_count`/`starRating*` are server-owned.
- Restore: PUT `{"name":"ATH Pearland"}` put it back; a third GET matched BEFORE on
  all 54 fields except `updatedAt`. The match is exactly as found.
- Retool prediction match: YES — production applies partial writes; omitted keys
  are untouched.

BOUNDARY of what this proves / does NOT prove:
- PROVEN: a SINGLE-KEY write to a FINISHED match patches, and the 54 READABLE
  fields are otherwise untouched.
- NOT tested: multi-key writes; the startDate/endDate pair; live/upcoming matches;
  and WRITE-ONLY fields. `teamNumbers` is write-only (accepted on write, absent
  from GET) — a read-back cannot verify a write-only field was undisturbed, so this
  says nothing about write-only fields.

The bolt (`PRODUCTION_WRITES_ENABLED`) is back to `false` after this write.

## Capacity model — CORRECTED in Phase 10.1 (revert the single-perTeam model)

Phase 10's single "players per team" model was WRONG and was reverted (commit
5a717d7 reverted for MatchEditor; teamNumbers stays on the route allowlist). The
three caps are NOT three views of one number — they are a capacity plus a growth
path, set INDEPENDENTLY:
- maxPlayerCount   = total spots the match holds NOW
- maxTeamSize2Team = total spots if it becomes a 2-team match
- maxTeamSize4Team = total spots if it becomes a 4-team match
- isAutoBump       = whether it grows on its own
- 0 in a format field = that format is NOT available at all (not "0 spots").
All three are TOTALS for that format, not players per side — the old field names
misled. Production 17256 reads 40/0/40 (forty now in four teams, never a two-team
match); staging 2470 reads 10/10/20.
The full editor now has three independent inputs with corrected labels ("Capacity
now", "Total spots as 2 teams", "Total spots as 4 teams") and shows the implied
per-side number beside each ("40 total, 10 a side"; "not available as a 2-team
match" for 0). It does NOT flag the three caps as mutually inconsistent (81% of
production would trip that — noise). It flags ONLY genuine contradictions with the
current config: an N-team match whose N-team total is 0, or a capacity-now above
every available format total.

## (superseded) single-perTeam note (Phase 10, reverted in 10.1)

- The three caps are TOTALS, not per-side. maxTeamSize2Team = total when played as
  2 teams, maxTeamSize4Team = total when played as 4 teams, maxPlayerCount = total
  for the match's own team count. Production 17256: maxTeamSize4Team=40, four teams,
  ten a side. The full editor now takes players-per-team + number-of-teams and
  DERIVES the three caps (maxPlayerCount = perTeam*teamNumbers, maxTeamSize2Team =
  perTeam*2, maxTeamSize4Team = perTeam*4), writing all four (incl write-only
  teamNumbers) as one group — matching Retool so the two tools can't disagree.
- FINDING (disagrees with the single-perTeam premise): in the CURRENT WEEK, 89 of
  110 production matches (81%) have caps that do NOT reduce to any single per-team
  number — e.g. 17313 has 2-team total 22 (=>11/side), 4-team total 40 (=>10/side),
  capacity 18 over 2 teams (=>9/side). This is because Retool actually uses THREE
  independent "recommend" inputs (Phase 6: updateRecomendPlayerCount2 for capacity,
  updateRecomendPlayerCount2Teams for the 2-team total, updateRecomendPlayerCount4Teams
  for the 4-team total), so the three caps are set independently. The single-perTeam
  editor therefore flags most real matches as inconsistent and, on a capacity edit,
  would overwrite the independent values with derived ones — so it warns and never
  writes capacity unless the admin edits it. The full editor is STAGING-ONLY, so no
  production caps are at risk; but a future revision should consider three
  independent recommend inputs to match production reality. maxTeamSize2Team=0 with
  maxTeamSize4Team=40 (17256) is one such inconsistency, flagged on load.
- fakeSpotLeft{36,24,12,6,3}h are LIVE on production (17256 reads 32/24/10/6/4),
  NOT dormant. autoCanceledMinutes is LIVE too (17256 = 75, autoCanceled true).
  Staging reading zero for all of them was TEST DATA, not evidence.

## Phase 10.2 — two drawer defects fixed

- Price "$2.00 for a $12.00 match" was DISPLAY-ONLY (a CSS specificity collision:
  `.mdw-money input` padding-left:24px was overridden to 11px by the general
  `.mdw input[type=number]` rule, so the "$" overlay covered the leading digit).
  The value and diff were always correct — on a clean load the diff is EMPTY, so
  no production match could ever have been written a wrong price. Fixed by making
  the money padding rule `[type=number]`-specific (same fix in the full editor).
  Cents<->dollars centralised in src/lib/matchMoney.ts; round-trip proven for
  0/200/1200/9950/12000 (+ null shows blank, no change).
- The environment badge is now DERIVED (src/lib/matchEnvBadge.ts) from the single
  DRAWER_ENV constant that also builds the request URL, so badge and target can't
  disagree. Production is unmistakable: a solid red "● PRODUCTION — LIVE EDITS"
  pill plus a red header ground and left rail on the whole drawer (not a colour
  swap on the same chip). Mutation-tested (hardcoding the badge fails the assertion).
- HARDCODED-LABEL AUDIT (reported, not fixed): (1) the drawer's "Open full editor →"
  links to `/match-ops/matches/{id}`, which is the STAGING full editor — a
  production drawer points at a staging editor for the same id (env mismatch).
  (2) the full editor's "STAGING · guarded" chip is a hardcoded constant — accurate
  today (that editor is staging-only) but not derived; it should use envBadge if
  the editor is ever repointed.

## Phase 11 — the full editor writes production

- The full match editor now reads and writes PRODUCTION through
  /api/matchday/{FULL_EDITOR_ENV}/matches/{id} (matchEnv.ts), env named per call,
  exactly like the drawer. diff-is-the-body, shared fieldChanged/pick, both
  deny-lists, and single-shot no-retry are unchanged. The three independent
  capacity totals (Phase 10.1) are unchanged.
- Both env badges are now DERIVED from matchEnv.ts (via envBadge) — the drawer's
  and the editor's. The editor's old hardcoded "STAGING · guarded" chip is gone;
  it shows the red PRODUCTION treatment. The drawer's "open full editor" link
  renders ONLY when DRAWER_ENV === FULL_EDITOR_ENV, so it can't send an operator
  from a production match to a different-env editor.
- PROVEN by one-at-a-time production writes on finished match 17256 (restored):
  all 17 editor-only fields round-trip — category, type, description, managerIntro,
  minPlayerCount, isFreeMember, isAutoBump, autoCanceled, autoCanceledMinutes, the
  five fakeSpotLeft marks, maxTeamSize2Team, maxTeamSize4Team, maxPlayerCount. Each
  write moved ONLY itself + updatedAt; NONE cascaded (type REGULAR->EVENT did not
  trigger any side effect), and the once-"dormant" fakeSpot/autoCanceledMinutes/cap
  fields all write cleanly.
- `npm run verify` (added) = tsc + mutation-tests + prod-guard-test +
  stage-denylist-test (offline, green). NOTE: the repo's separate `npm test` has
  PRE-EXISTING failures unrelated to this work — `.test.ts` files run under plain
  `node --test` which can't resolve bare `.ts` imports (venueResolver,
  growthMetricGrid), and mdapiWallClockGuard flags start_date usages in files this
  phase never touched. Those belong to their owners, not Phase 11.

## Teams endpoint — PUT /admin/teams/{id} PATCHES (Phase 12)

- A team (from a match GET's `teams[]`) holds 8 fields, IDENTICAL on production and
  staging: `createdAt, id, locked, matchId, name, price, teamNumber, updatedAt`.
  `password` is NOT in the GET — it is WRITE-ONLY (Retool's updateTeam sends it,
  but the entity never returns it), like `teamNumbers` on matches. So a replace
  here would null an UNREADABLE password.
- PUT /admin/teams/{id} PATCHES (proven on staging team 3122, one field per write,
  restored): `{price}`, `{name}`, and `{locked}` each moved ONLY that field +
  updatedAt. So a changed-fields-only team write (name-only, locked-only) does NOT
  null the password — the roster screen's per-field team writes are safe. writable
  fields: name, locked, price, password (never send password from Clubhouse).
- The write client's guards GENERALIZE to this non-match endpoint with no change:
  host allowlist, env-named-per-call, the field deny-list (runs on the team body),
  the endpoint deny-list (does not block PUT /admin/teams/{id} and does not
  spuriously match a teams path against the matches cancel/delete/refund patterns),
  and single-shot no-retry all applied unchanged. Nothing was match-specific.
  Recommendation for the roster phase: consider adding `password` to
  DENY_WRITE_FIELDS as belt-and-suspenders (we never write it).

## Roster endpoints (Phase 13) — corrected against the live API

All proven to round-trip on staging (match 2470, cleaned up), and the two ids
matter (getting them wrong targets the wrong record):
  add player   POST   /admin/matches/{id}/players/{playerId}   {team, playerNumber}
  add fake     POST   /admin/matches/{id}/fake-players          {team, playerNumber}
  add fakes    POST   /admin/matches/{id}/batch/fake-players    {totalFakes}
  move         POST   /admin/user-matches                       {userMatchId, team, playerNumber}
  set/unset fake PATCH /admin/players/{playerId}/fake-player     (playerId = userId)
  remove       DELETE /admin/matches/user-matches/{userMatchId}
  read roster  GET    /admin/matches/{id}/players
  search       GET    /admin/players?email|id&limit&page&sort
In the roster row: `id` = userMatchId (move, remove), `userId` = playerId (add, fake).

CONFLICTS with the mockup / Phase-6 inventory (API wins):
  - REMOVE is DELETE /admin/matches/user-matches/{userMatchId}. The inventory's
    DELETE /admin/matches/{id}/players/{playerId} returns 403 USER_NOT_JOINED — so
    remove keys on userMatchId, NOT playerId.
  - MARK-ABSENT: the documented PATCH /admin/matches/{id}/user-matches/{umId}/absent
    (and 3 variants) all 404 "Cannot PATCH" on staging — the route is not
    registered. Retool's export DOES call this path, so it is either unregistered
    on staging or the path is stale. UNRESOLVED — ask the backend dev. Do not guess
    at alternatives. Omitted from the roster build.
  - add-fake to a FINISHED / over-capacity match returns 2xx with an id but does NOT
    persist a roster row (and that id is not a user-match) — only add to an active
    match with an open slot.
  - bodyless writes (DELETE, PATCH .../fake-player) must NOT send Content-Type:
    application/json with an empty body (400) — the client now omits it.

A 2xx DOES NOT MEAN THE WRITE LANDED (Phase 13 — API property, not one endpoint's
quirk; we have only tested a few). add-fake to a finished match returned 2xx and
persisted nothing. So a write has FOUR outcomes, and a row may only be called
LANDED after a READ-BACK confirms it — never on HTTP status alone:
  - LANDED      request ok AND the change shows up on re-read.
  - FAILED      request rejected (clean 4xx) — definitely did not happen; retry safe.
  - NOT APPLIED request returned 2xx but the re-read does NOT show it — the server
                accepted it and did nothing. Retry like a failure, but SAY this
                distinctly: it is a different fact from a rejection.
  - UNKNOWN     timeout / ambiguous (network, 401, 5xx) — may or may not have
                happened. STOP the run, leave the rest unsent, reload before acting.
The roster save state machine uses these four; only UNKNOWN stops the run.

## The remove path vs the match-delete near-miss (Phase 13)

DELETE /admin/matches/user-matches/{userMatchId} (remove a player) is ALLOWED;
DELETE /admin/matches/{id} (destroy the match) is on the endpoint deny-list — same
verb, one segment shorter. The matcher discriminates on the parsed segment list, not
a prefix, and this is asserted in prod-guard-test.

OPEN QUESTION — removing a player who PAID (Phase 13 Part 4, do not guess):
  Removal is NOT a refund. refund-and-cancel is a SEPARATE endpoint and is on the
  ENDPOINT deny-list (blocked in Clubhouse). What happens to an existing charge when
  a paid player is removed — stays / voided / something else — is UNCONFIRMED. The
  removal confirm states this and says to check before removing a paid player. This
  must be verified before it becomes folklore.

## Running scripts against this client

Scripts that import the server-only write module run with:

    NODE_OPTIONS="--conditions=react-server" npx tsx scripts/<name>.ts

(`server-only` is installed as a devDep and resolves to a no-op under that
condition; without the flag it throws - which is the proof it can't reach a
client bundle.)

## Gameday Ops — the live day board (Phase 15)

Probed on staging `GET /admin/matches`. The board reads matches LIVE (never the
synced mirror). Where the mockup (today-v1_6.html) and the API disagreed, the API won:

- LIST endpoint: `GET /admin/matches?fromDate&toDate&page&limit&sortColumn&sortDirection`.
  `fromDate`/`toDate` are `YYYY-MM-DD` and bound the WALL-CLOCK `startDate` date —
  exactly the operator's "day", so a day fetch is `fromDate=toDate=<day>`. There is
  NO other date filter (startDate/dateFrom/etc. → 400 "property should not exist").
  `cityId` IS accepted but we DON'T use it — the board needs every city for the chips
  and their counts, so city filtering is client-side. Response:
  `{ page, limit, totalItems, data: Match[] }`; each list item is FULLY populated
  (incl. `_count`, `field.city.timeZone`, `manager`, `teams`, the ladder).
- ORDER is by the REAL instant. Each match carries `startDate` (wall-clock, for the
  local time + `field.city.timeZone.abbr` label) AND `startDateUtc` (the true instant).
  Sort by `startDateUtc` — Atlanta 6:00 PM ET kicks off before Austin 6:30 PM CT even
  though its clock reads later. NO per-city offset maths exist in the board (the
  mockup invented them because it had no real timestamps), so the mockup's "day
  offset" auto-cancel bug cannot occur.
- CURRENT FAKES ARE OBSERVED, not derived. `_count = { players, fakePlayers }`:
  `players` = registered real players, `fakePlayers` = actual fakes on the match NOW.
  The mockup DERIVED the current fake count from the ladder; the API reports it, so
  the board uses `_count.fakePlayers`. real + fake + open === capacity, exactly (open
  is the remainder). **This resolves the Part-B question**: the current fake count is
  whatever the backend reports; the `fakeSpotLeft{36,24,12,6,3}h` ladder drives ONLY
  the next-release forecast (at the soonest upcoming mark, fakes drop to that rung,
  clamped by room). Below the 3h mark there is no further mark, so "no more releases"
  — but the displayed fake NUMBER is observed, not assumed, so the last-hours worry in
  the spec does not apply.
- CANCELLED = `isCancelled` (the derived did-it-happen, READONLY). NOT `autoCanceled`,
  which is a policy flag — see the auto_canceled memory. The cancelled band keys on
  `isCancelled`.
- `autoCanceledMinutes` is MINUTES before kickoff (spec says hours; spec is wrong —
  already recorded above). Colour is by distance to the DEADLINE (kickoff −
  autoCanceledMinutes), thresholds CRIT_HOURS=3 / WARN_HOURS=6, and only when SHORT
  (`_count.players < minPlayerCount`), upcoming, capped, not cancelled. A match meeting
  its minimum is never coloured.
- `maxPlayerCount` null/0 = special event (no cap): the board shows "no cap" and
  draws no fill bar or minimum marker.
- CONFLICT — the drawer field set. Part F listed teams/category/type/capacity/ladder/
  auto-bump as in-drawer edits, but `teamNumbers` is WRITE-ONLY (can't be read back or
  diffed — team count/shape is the roster editor's job) and the shipped Master
  Schedule drawer (MatchDrawer, the "same pattern" Part F names) edits name / field /
  manager / price / spot price / guest / date-time. Gameday reuses MatchDrawer as-is
  (same guarded production route, same fieldChanged/pick); the fuller field set is one
  click away via its "Open full editor →". The "lower a rung → fake count moves" live
  recompute does not apply on real data, because the current fake count is OBSERVED,
  not ladder-derived — editing a rung changes the forecast, which the board shows.
- Veo is Clubhouse-only (`GET /api/veo`, `POST /api/veo/intent`), NOT a MatchDay field;
  it saves instantly and stays out of the match diff.

## Change Log — recording every production write (Phase 16)

Where the hook lives: `src/lib/changeLog.ts` `recordWrite()` — the SHARED write path. Any
route that writes through it is logged, so a new screen inherits the log without anyone
remembering to add it (proven by scripts/change-log-test.ts pointing straight at
recordWrite with a memory store, no component). The match PUT route
(/api/matchday/[env]/matches/[id]) is wired through it; new write paths should call
recordWrite instead of apiWrite directly.

- BEFORE values are EVIDENCE, not a claim: recordWrite reads the resource before the
  write AND after it, and takes both sides of every change from those reads. Three round
  trips per save (the match route caches the before-read so a name lookup adds no fourth).
- ONE ENTRY PER SAVE: the store holds one row per request (each carries a saveId); the
  screen groups by saveId. A single match PUT is one row → one entry with N field changes;
  a roster save is N rows → one entry ("2 of 4 requests landed", worst outcome wins).
- Four states, never folded: landed / failed / notapplied / unknown. FAILED (rejected,
  definitely didn't happen) and NO ANSWER (ambiguous, may have) never share a label.
- Logging is BEST-EFFORT and never throws over the write: a logging outage or an
  unmigrated table must not turn a landed edit into an error the operator retries into a
  double-write. Denied keys (DENY_WRITE_FIELDS, now in the client-safe denyWriteFields.ts)
  are stripped before insert — a log is a second place a secret could leak.
- Resolving records a human's finding (POST /api/changelog). It fires NO write to
  MatchDay and NEVER changes the recorded outcome — the badge stays NO ANSWER with a note
  saying who checked and when. There is no retry, anywhere.

STORAGE + RETENTION (Part E): entries live in the Supabase table `change_log`
(migration 0113), written by the service-role hook, read via the guarded admin route.
Only writes are logged, never reads. Retention: NONE enforced yet — rows accumulate
indefinitely. `created_at` is indexed so a prune (`delete where created_at < now() -
interval '180 days'`) can be added later without a schema change. Stated here rather than
left undecided.

## The safety ladder is not what it looks like — the real emergency stop (Phase 17)

PRODUCTION_WRITES_ENABLED is a HARDCODED `true` (src/lib/matchdayStageApi.ts:54 —
`const PRODUCTION_WRITES_ENABLED = true;`). It is NOT read from env and NOT a live
rung: on production it is a pass-through, and the only way to re-engage the bolt is a
CODE CHANGE + DEPLOY. Do not think of it as a runtime control — it cannot be flipped
from a dashboard or a SQL console.

THE ACTUAL EMERGENCY STOP for production writes is the EDIT MATCHES grant in the
database. `can_edit_matches` is read FRESH from app_users on EVERY request
(src/lib/adminAuth.ts:48-49, a live SELECT; no JWT claim, no server cache, routes are
force-dynamic), and the guarded write path refuses the write before any network call
when it is false. So:

  -- KILL ALL production/staging match writes, effective on the NEXT request (instant):
  update app_users set can_edit_matches = false;

  -- kill one user:
  update app_users set can_edit_matches = false where id = '<uuid>';

There is no lag on the SERVER side — the next write 403s at authenticateAdmin. The only
thing that lags is the browser's greyed-button UI (useAuth caches AppUser per tab until
reload), and that is cosmetic: an attempted write still hits the server and is refused.

The safety rungs that are ACTUALLY live, in order (apiWrite / the routes):
  1. authenticated (route: authenticateAdmin)
  2. EDIT MATCHES  <-- the live kill switch (per-request DB read)
  3. PRODUCTION_WRITES_ENABLED bolt  <-- HARDCODED true; changeable only by deploy
  4. host allowlist
  5. field deny-list
  6. endpoint deny-list
  7. single-shot, no retry
Rung 3 is inert while hardcoded true. Rung 2 is the one you reach for in an incident.

NOT the emergency stop: migration 0115 `revoke insert,update,delete on change_log from
anon, authenticated` protects the AUDIT LOG from tampering — it has nothing to do with
stopping MatchDay writes. Do not confuse the two.
