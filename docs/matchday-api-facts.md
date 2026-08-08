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

## Running scripts against this client

Scripts that import the server-only write module run with:

    NODE_OPTIONS="--conditions=react-server" npx tsx scripts/<name>.ts

(`server-only` is installed as a devDep and resolves to a no-op under that
condition; without the flag it throws - which is the proof it can't reach a
client bundle.)
