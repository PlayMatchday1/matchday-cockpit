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
    - `DELETE /admin/matches/{id}` — permanently destroys the match.
    - `PATCH  /admin/matches/{id}/players/{playerId}/refund-and-cancel` — moves
      money (refund) and cancels the player.
  A near-miss like `/admin/matches/{id}/cancel-something-else` is deliberately NOT
  caught, and normal ops (`PUT /admin/matches/{id}`, `DELETE .../players/{pid}`,
  `.../user-matches/{um}/absent`) pass.

- **CANCEL is now BUILT and OFF the deny-list (Phase 23 Step 2 Part C).**
  `PATCH /admin/matches/{id}/cancel` cancels the match, CREDITS every signed-up
  player the match value (a wallet CREDIT — no money leaves Stripe, not a card
  reversal), and TEXTS them. Ryan confirmed the effect; a **read-only audit of the
  Retool prod export** (`retool-export-prod.json`, gitignored) proved HOW: Retool's
  Cancel button fires this **single** PATCH and nothing else — the credit and the SMS
  are SERVER-SIDE effects. Evidence: the export's complete `/admin/...` surface has
  NO credit/wallet/balance/notify endpoint, and its only external host is the MatchDay
  API (no Twilio/Stripe/Supabase). So calling `/cancel` alone reproduces Retool
  exactly; it does NOT cancel-without-crediting. It is reachable ONLY through the
  dedicated cancel route (`/api/matchday/{env}/matches/{id}/cancel`): GET returns a
  LIVE credit preview `{ name, count, totalCents, alreadyCancelled }`; POST requires
  the match NAME typed and re-checked against the live name server-side, fires once
  (no retry), is `recordWrite`'d WITHOUT any player identity, and reports LANDED /
  NOT APPLIED from a re-read of `isCancelled` (not the status code). Like every other
  MatchDay write, it goes through the production bolt — which is currently OPEN
  (`PRODUCTION_WRITES_ENABLED = true`, a hardcoded pass-through; see the bolt section
  below), so a confirmed cancel LANDS on production. It is NOT bolted.

- **MEMBERSHIP ALLOCATES PER SPOT, and the convention is in the code — do not invent a new one.**
  Asked as "can membership go to field grain?", the honest first answer is that it is not STORED
  there: all 64 August membership rows in `fin_revenue` carry a `city` and `venue = null`, so
  `cityMembershipRevenueFor` (financeStats.ts:1633) is a lookup, not a split. But an allocation
  already exists, in two places, and both use the same rule:

      share = city membership revenue × (that thing's MEMBER SPOTS ÷ the city-month's member spots)

    · `matchAllocatedMemberRevenueFor` — financeStats.ts:1865, MATCH grain. The algebra is written
      out at :1881: the venue-level count cancels, so only the city-month total is needed.
    · `cityPnl.ts:231` — FIELD grain, and it says why it lives in the model: "computed here rather
      than in the view so the pitch rows sum to the city row by construction — the view used to do
      this arithmetic itself, which is how a drill-down starts disagreeing with the row it opened
      from."

  **THE DIVISOR IS MEMBER SPOTS ONLY** — not total, not paid. `financeStats.ts:1871` defines it as
  "count of MEMBER-payment registrations at this match"; the denominator is
  `mdapiMemberSpots.byCityMonth.get(city|month).member`. Per city-month.

  **NULL, NEVER ZERO.** A field or match with no member spots gets `null` and renders "—". "$0"
  would claim it earned no membership; the truth is that membership cannot be attributed to it.
  ATH Pearland (0 matches, ~$7k revenue) is the standing example.

  **A DPP-SHARE SPLIT WAS PROPOSED AND IS WRONG** — it would have invented a second basis for a
  figure the app already derives, and the two would have disagreed at the first reconciliation.
  Any new surface needing membership below city grain reads one of the two functions above.

- **CREATE IS `POST /admin/matches`, and it WHITELISTS.** Probed on staging by sending bodies that
  could never succeed (`name` omitted every time), so nothing was created. Nine required fields:

      name (string) · description (string) · type (EVENT|REGULAR|BRACKET|GROUP)
      startDate (Date) · endDate (Date) · fieldId (int) · maxPlayerCount (int)
      teamNumbers (int) · isFreeMember (boolean)

  **Per-instance fields are REFUSED BY NAME, not ignored** — `id`, `apiId`, `starRating`,
  `starRatingCount`, `playerCount`, `fakePlayerCount`, `isCancelled`, `createdAt`, `updatedAt`,
  `players`, `guestCount` each come back `"property X should not exist"`. So spreading a source
  match into a create body FAILS LOUDLY; it cannot carry a roster, a rating or an id by accident.
  Build the nine explicitly anyway.

  **THE SHAPE MISMATCH.** Create takes 9 fields, the match editor edits 21, and only 6 overlap
  (`name`, `description`, `type`, `fieldId`, `isFreeMember`, `maxPlayerCount`). A copy therefore
  cannot carry the manager, prices, fake-spot schedule or auto-bump settings through the create
  call — those need the PUT that already works, as a second step.

- **DOUBLE-SUBMIT ON CREATE IS `UNKNOWN`.** Not "probably two matches" — UNKNOWN. There is no
  Idempotency-Key and the payload carries nothing a server could dedupe on, but that was never
  measured: measuring it means creating real matches on staging, and `DELETE /admin/matches/{id}`
  is on this client's endpoint deny-list, so they could not be cleaned up. The probe was skipped
  deliberately because it buys nothing — the guard is mandatory either way.

  **THE GUARD DOES NOT DEPEND ON THE ANSWER.** A disabled button only stops a double-click; it
  does not stop a refresh mid-save, a second tab, or a retry at a layer below us. So the create
  path QUERIES FIRST for an existing match at the same `fieldId` and the same `startDate`, and
  refuses with that match's id and a link. Overriding is deliberate and explicit. That makes the
  server's dedupe behaviour irrelevant, which is the honest way to close an UNKNOWN.

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

The bolt (`PRODUCTION_WRITES_ENABLED`) is back to `false` after this write. **(Phase 9
state only — the constant was later hardcoded to `true` in Phase 17 and IS `true` today,
so production writes now LAND. See "The safety ladder is not what it looks like" below.
Do not read this line as the current state.)**

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

**The roster row carries the player's PHONE.** `p.user.phoneNumber`, a string in
E.164 (`+15125550123`, length 12). Measured on production over 49 played matches:
present on **239 of 239 REAL players (100%)** among the rows the panel renders. The
lower raw figure (240/417) is entirely fake players, which have no phone at all —
so treat a missing phone on a non-fake row as notable, not normal. The match panel
displays it; it is **display only**. It must never enter `change_log`, where the
rule remains last-4 via `phoneLast4()` — the log has different access rules and a
longer life than a screen. `scripts/roster-edit-model-test.ts` asserts both halves
(the client's write plan and the POST half of the roster route) and mutates each to
prove the assertion can fail.

**`playerNumber` comes back in NO PARTICULAR ORDER.** Over the same 49 matches,
**55 of 95 teams (58%)** were returned NOT ascending — e.g. `[9,6,4,7,2]` and
`[6,3,1,4,8,7,5]`. Any surface showing a team must sort it. A `null` playerNumber
must sort LAST, not as zero.

**Duplicate `playerNumber` on one team is a raw-payload artefact, not a real state.**
21 of 101 teams show one BEFORE filtering, and **0 of 95 after `rosterRowCounts()`** —
every duplicate came from hidden `WAITING` retry rows. It is still rendered and
marked where it occurs, because the move control writes `playerNumber` and a rare
wrong state that draws as normal survives forever.

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
- STATE BANDS partition on the true instant (Phase 21 §0 / 21b item 2): a match is
  STILL TO COME (`minsUntil > 0`), IN PLAY (`-90 < minsUntil <= 0`), DONE
  (`minsUntil <= DONE_MIN`), or CANCELLED (`isCancelled`, any time). The header chip, the
  STILL TO COME group, and the row state all call the SAME `stillToCome` predicate so the
  three can't disagree. IN PLAY is BOUNDED at `DONE_MIN`, so a morning match is not "in
  play" all night — it flips to done 90 min after kickoff.
- **VITALII LIST — `DONE_MIN = -90` is a GUESS at match length.** The API gives us kickoff
  (`startDateUtc`) but NOT match duration, so "in play vs done" uses a hardcoded 90-minute
  window. Real match length varies by format (5-a-side / 7s / 11s / special events). ASK
  the backend dev: **how long is a match, per format?** — then drive the in-play→done flip
  off the actual duration instead of a flat 90. Until then the band is cosmetic (in-play and
  done both carry no risk tier), so a wrong guess only mislabels the group header, not the ops.

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

  -- KILL ALL production/staging match writes, effective on the NEXT request (instant).
  -- The WHERE is REQUIRED: this Supabase project runs pg_safeupdate, which REJECTS an
  -- UPDATE with no WHERE clause — an unqualified `set can_edit_matches = false` errors
  -- and fires nothing, exactly when you need it. `where can_edit_matches = true` both
  -- satisfies pg_safeupdate and touches only the rows that matter. Do NOT "clean up"
  -- the WHERE.
  update app_users set can_edit_matches = false where can_edit_matches = true;

  -- kill one user (the WHERE id = ... also satisfies pg_safeupdate):
  update app_users set can_edit_matches = false where id = '<uuid>';

There is no lag on the SERVER side — the next write 403s at authenticateAdmin. The only
thing that lags is the browser's greyed-button UI (useAuth caches AppUser per tab until
reload), and that is cosmetic: an attempted write still hits the server and is refused.

## Migrations 0114 + 0115 are APPLIED — confirmed 2026-08-09

Settled. Do not re-flag `can_edit_matches` / `is_service_account` / the change_log
lockdown as pending; both migrations are live in production. Evidence (2026-08-09):
  * the guard trigger raised P0001 "Service account (clubhouse-e2e@playmatchday.com)
    cannot hold EDIT MATCHES" on a live UPDATE run as the postgres role — so the column,
    the trigger, and rule 3 are all live;
  * `is_service_account` returned TRUE on the E2E row (clubhouse-e2e@playmatchday.com);
  * `can_edit_matches` returned TRUE on Ryan's row (a real EDIT MATCHES holder exists).
So the emergency-stop UPDATEs above are pg_safeupdate-safe (both carry a WHERE), and the
E2E-can-never-edit rule is DB-enforced, not aspirational.

The emergency-stop SQL has now been EXECUTED against production — TESTED because it ran,
not because it looked right (confirmed 2026-08-09):
  * `update app_users set can_edit_matches = false where can_edit_matches = true;` ran
    clean, with NO pg_safeupdate error;
  * the follow-up `select count(*) ... where can_edit_matches = true` returned 0 rows;
  * re-granting to rmancuso@playmatchday.com returned `can_edit_matches` = true.
The kill switch is a proven runbook command, not a plausible one.

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

## Gameday Ops fake double-count fix + the auto-cancel minimum basis (Phase 17 follow-up)

BUG (production, match 17325): the card showed "6 real · 3 fake · 9 open of 18" for a
match that is 3 real + 3 fake + 12 open. `_count.players` from the LIST endpoint is the
TOTAL OCCUPIED count (real + fake), NOT real-only — confirmed live: list
`_count = {players: 6, fakePlayers: 3}`, roster shows 3 real. gamedayModel.realCount used
`players` directly, so it reported filled as real, and openSpots = cap - real - fake then
subtracted the fakes a SECOND time. The three numbers summed to cap (6+3+9=18), which is
why it looked right and why a `real+fake+open===cap` test would not catch it.

FIX: `realCount = max(0, _count.players - _count.fakePlayers)` (one line in gamedayModel).
Added `filledCount = _count.players`. The regression test asserts the REAL count DIRECTLY
against 17325's numbers (3 real), not via the sum. NOTE: the single-match GET
/admin/matches/{id} returns `_count = {players}` with NO fakePlayers key; the LIST
endpoint returns both — the board reads the LIST, which is correct here.

OPEN QUESTION (Q3) — does MatchDay's auto-cancel count fakes toward minPlayerCount? The
API does not say (minPlayerCount, autoCanceledMinutes, autoCanceled, isCancelled, and the
fakeSpotLeft ladder are exposed; none states the comparison basis). The screen now
assumes REAL players only (short = realCount < minPlayerCount) — the operationally-safe
reading, since a fake won't show up to play. Before the fix the code effectively counted
fakes (realCount was filled). If the backend actually counts fakes toward the minimum,
flip realCount -> filledCount on the two lines flagged in gamedayModel (short/shortBy).
UNCONFIRMED — verify with the backend dev.

## STRIKES — the real model (Phase 18 investigation, confirmed by Ryan + live probe)

A strike is a **COUNT toward a suspension, NOT a fine.** The per-city strike PRICE
(`getStrikePriceByCityId` / `changeStrikePrice`) is what a **player pays to REMOVE** a
strike — a redemption cost, not a penalty levied. That is why the price sits beside
`removeStrike`. **Members only. 4 active strikes ⇒ suspended for 1 week.** The mockup's
guessed rules (3 strikes, "suspends membership", 90-day expiry) were all wrong.

Source of truth (Ryan, 2026-08-09) + live production probe of `/admin/players/{id}`:

- `GET /admin/players/{id}` returns a `strike` object. TWO shapes:
  - Zero strikes: `{ isSuspended, activeStrikes: 0, suspensionStartedAt, firstStrikeAt }`
    (summary only — the parent strike row is absent).
  - Has strikes: the full parent row
    `{ id, userId, createdAt, updatedAt, expiredAt, suspendedTo, paymentIntendId (sic),
       amount, strikeLogs: [...], isSuspended, activeStrikes, suspensionStartedAt,
       firstStrikeAt }`.
- **`activeStrikes` is server-computed** — read it directly; do NOT reduce penaltyPoints
  yourself. (The `strikeLogs.reduce((p,e)=>p+e.penaltyPoint,0)` in the Retool export is
  COMMENTED-OUT legacy; the live API pre-computes the count.)
- **`isSuspended` is server-computed.** The suspension end is `suspendedTo` (a timestamp);
  Retool derived `isSuspended = suspendedTo > now`, but the API now returns the bool too.
- **`paymentIntendId` (note the typo) + `amount`** on the parent strike = the pay-to-remove
  redemption (populated when a player has paid off the strike). Null when unpaid.
- **StrikeLog (child, one per infraction):**
  `{ id, strikeId, userMatchId, penaltyPoint, active, createdAt, updatedAt }`. It links to
  a **user-match** (`userMatchId`) and carries a `penaltyPoint` (1 in the live sample) and
  an `active` bool. **It carries NO reason field** — nothing says late / no-show /
  cancelled-inside-6h. To explain WHY a strike was issued you must read the linked
  user-match's `isAbsent` / `cancelledBefore24Hours` / `isCancelled` / `canceledAt`.
- `GET /admin/strikes/strike-logs/{id}` **returns HTML, not JSON** — that path is not a
  usable JSON GET. Read strikes via the player detail (`strike` + `matches[].strikeLog`),
  not that endpoint.

### The three facts Ryan asked me to find (Phase 18)

1. **Expiry window.** The API exposes an absolute **`expiredAt` per strike** — so you do
   NOT need to know/hardcode the window: read `expiredAt` and show the date. On the one
   live strike observed (id 27883, user 80908): `createdAt 2026-07-12` → `expiredAt
   2026-09-10` = **exactly 60 days**. So the window looks like **60 days, not the 90 the
   mockup guessed** — but that is a single sample. Robust rule: render `expiredAt`
   directly; treat "60 days" as likely-but-unconfirmed and get Vitalii to confirm the
   fixed window length if a countdown ("expires in N days") is ever needed as policy.
2. **Auto vs admin-applied.** Strikes look **auto-issued by the backend**: the strike row
   carries **no issuer field** (contrast the ban system, which stores `bannedByUserId`),
   and strike + strikeLog + firstStrikeAt share an identical-to-the-millisecond timestamp
   (machine-created, not hand-entered). There is **no "suspend from strikes" endpoint** in
   the export (only add/remove/set strike + strike price), and `isSuspended`/`suspendedTo`
   are computed summary fields — so the 4-strike ⇒ 1-week suspension is most likely an
   automatic backend consequence, NOT something an admin triggers. UNPROVEN at the
   threshold crossing (no live 4-strike user observed); Vitalii confirms the automation.
   → Clubhouse should DISPLAY the count/suspension (a countdown "3 of 4"), not trigger it.
3. **StrikeLog payload** (real, live): `{ id: 38035, strikeId: 27883, userMatchId: 272473,
   penaltyPoint: 1, active: true, createdAt, updatedAt }`. No reason, no type, no paid flag
   on the log itself (payment is on the PARENT strike via paymentIntendId/amount).

### Bans are a SEPARATE mechanism from strikes

`GET /admin/players/banned` (paginated `{data,limit,page,totalItems}`) rows carry
`bannedAt, banExpiredAt, isBanPermanent, bannedByUserId, banReason, isBanned`. Live sample:
every ban was **admin-applied** (`bannedByUserId: 3193`, free-text `banReason` like
"Fraudulent Dispute" / "Repeated abusive behavior"), some permanent (`isBanPermanent:true`,
`banExpiredAt:null` = EXPEL) and some timed (`banExpiredAt` set = a fixed-date ban). This is
the SUSPEND/EXPEL/LIFT surface (`PUT /admin/players/{id}/ban`), distinct from the
strike-driven `suspendedTo`. The mockup conflated the two — keep them separate.

## The Stripe DPP-vs-membership classifier — where it lives (Phase 18 verification)

Load-bearing for the (future) payments panel. The rule: `classifyCharge` in
**`src/lib/financeImport.ts:387`**; the match-join discriminator is **line 393**:
`if (args.hasMatchId) return "DPP"` (hasMatchId = `metadata.matchId != null`, set in
`stripeSync.ts` where the charge is read). Membership charges have no matchId — that's the
discriminator; NEVER fall back to amount+timestamp. Strikes are their own charge type
(`isStrikeCharge`, line 392). The **99.8% agreement figure is a probe OUTPUT, not a source
constant** — computed by `ClassifierProbeResult` in `stripeSync.ts` (~486–608), which
cross-checks the matchId rule against the older subscription-invoice discriminator and
reports `agreeMatchIdPct`. Stripe customer is located by **email** (no stored
`stripe_customer_id`); email-mismatch → renders as "no payments" (known, `financeImport.ts`
comment ~line 87); also matching on `metadata.userId` would rescue those.

## The 24-hour REFUND rule — PAY-PER-MATCH PLAYERS ONLY (Phase 18)

Applies to **non-members** (they pay per match). Cancel **inside 24 hours** of kickoff and
you do **not** get your money back. This is a MONEY rule, nothing to do with strikes — a
pay-per-match player who cancels late is penalised by losing the fee, so no strike is
needed. The user-match flag `cancelledBefore24Hours` (boolean) is THIS rule. Do NOT use it
to derive a strike reason: it is often `null`, and it cannot tell a member who cancelled 20h
out (no strike) from one who cancelled 5h out (a strike) — both are `false`/absent under
the 24h test. Keep this rule and the 6-hour strike rule below as separate facts; they were
nearly conflated by both Ryan and me.

## The 6-hour STRIKE rule — MEMBERS ONLY (Phase 18)

Applies to **members** (they pay nothing per match, so there is no fee to withhold — the
strike IS the penalty). A member who cancels **inside 6 hours** of kickoff earns a strike.
This is a COUNT rule (see the strike model above): 4 active strikes ⇒ 1-week suspension.
Confirmed from live data: every `CANCEL_W_IN_SOME_HOURS` user-match sampled had
`paidStatus = FREE` (a member) and `startDateUtc − canceledAt` ≤ 6h (observed 0.1–4.8h).

## Strike REASON + cancellation timestamp — what the API actually stores (Phase 18)

The strike REASON is NOT derived from `cancelledBefore24Hours`. It lives in the user-match
field **`userStatus`**, a real enum. Observed distribution over 188 live user-matches:
`ON_TIME` (133), `NONE` (31), `CANCEL_W_IN_SOME_HOURS` (11), `NO_SHOW` (7), `LATE` (6). The
three strike-earning statuses are **`LATE`**, **`NO_SHOW`** and **`CANCEL_W_IN_SOME_HOURS`**
(= cancelled inside the 6h window). So the panel can state WHY a strike exists from
`userStatus` directly — no timestamp maths needed for late / no-show.

The actual cancellation timestamp **IS stored**: user-match **`canceledAt`**. It is
populated on cancellation-type rows (every `CANCEL_W_IN_SOME_HOURS` sample had it) and NULL
on `LATE`/`NO_SHOW` (correctly — those are attendance outcomes, not cancellations).
`startDateUtc − canceledAt` gives the exact hours-before-kickoff. To join a strike to its
reason: `strike.strikeLogs[].userMatchId` → the user-match `id` in the player's `matches[]`
→ read its `userStatus` (reason) and, for cancellations, `canceledAt` vs `match.startDateUtc`
(timing). `strikeLog` itself carries no reason (see the strike model above).

## DEPLOY ORDER — code ships before migrations apply (Phase 18c)

`src/lib/adminAuth.ts` reads `app_users` with **`select("*")` deliberately. Never name permission
columns explicitly there** — code deploys (git push → Vercel) BEFORE the migration is run by hand
in the Supabase SQL editor, and a named column that does not exist yet makes the whole select
error, which `authenticateAdmin` maps to a 403 — 500ing EVERY admin route until the SQL lands.
`select("*")` returns whatever columns exist; a not-yet-migrated grant column then reads as
`undefined` → the derived permission is simply `false` until the migration applies. (Caught when
adding `can_manage_promos` to the explicit select broke `verify-admin-preview`, Phase 18b.)

## The auth split — Match Ops READ vs admin (Phase 23 Step 2 Part D)

**`authenticateAdmin` requires `is_admin` BEFORE it computes `canEditMatches` /
`canManagePlayers` / `canManagePromos`. So those flags have never GRANTED access to anyone —
they have only ever RESTRICTED admins.** A non-admin who was granted `can_access_matchops`
was still 403'd ("Admin access required") on every `authenticateAdmin` route, because line-1
of the gate is `is_admin`. That is why Deonna saw "admin access needed" on Gameday Ops,
Player Lookup and Promo Codes while holding Match Ops.

The fix is a SEPARATE gate, `authenticateMatchOpsRead` (`src/lib/matchOpsAuth.ts`), and routes
move onto it ONE AT A TIME. It shares `authenticateAdmin`'s session plumbing
(`resolveSessionUser`) but requires `can_access_matchops` (NOT `is_admin`), **deny by default**
— a missing/false flag is a refusal, and the E2E service account is blocked explicitly by email
(`clubhouse-e2e@playmatchday.com`) atop the `is_service_account` DB trigger. WRITES stay gated:
the returned `canEdit/Manage*` flags are derived identically (`deriveMatchOpsFlags`) and each
write route keeps its own check. Because the split is opt-in, a route nobody moved keeps
requiring `is_admin` — an overlooked route stays CLOSED, never accidentally open.

Moved in Part D round 1 (READ only): `matchday/[env]/gameday`, `lookup/[env]`, `promos/list` (its
read no longer needs MANAGE PROMOS; `promos/create` is untouched — still admin + MANAGE PROMOS).

### Round 2 — the whole Match Ops click path (2026-08-12)

Round 1 opened the BOARD but not what a tile opens onto, so the panel would have opened and then
403'd on the next click. Round 2 moves the rest of the path. **12 routes are now on the read gate;
`authenticateAdmin` guards 22** (28 − 6 moved whole; the 3 dual-gate routes below still import it
for their writes).

READS moved whole: `lookup/[env]/payments`, `promos/detail/[id]`, `promos/fields`,
`promos/matches`, `promos/check` (all four promo reads dropped the MANAGE PROMOS requirement, like
`list`).

**DUAL-GATE routes — GET moved, write did NOT.** These are the only three files that legitimately
import both gates, and the census test pins that set exactly:

| route | GET | write |
|---|---|---|
| `matchday/[env]/matches/[id]` | Match Ops read | PUT — `authenticateAdmin` + EDIT MATCHES |
| `matchday/[env]/roster/[matchId]` | Match Ops read | POST — `authenticateAdmin` + EDIT MATCHES |
| `matchday/[env]/matches/[id]/cancel` | GET preview | POST — `authenticateAdmin` + EDIT MATCHES |

**The one WRITE that moved: `lookup/[env]/ban` — `is_admin` → MANAGE PLAYERS.** `is_admin` was
over-gating a write that already had its own permission, which is the same Part D bug (the flag
could only restrict admins, never grant). It is now the read gate + `auth.canManagePlayers`;
because `deriveMatchOpsFlags` makes every write flag imply `can_access_matchops`, this cannot open
to anyone lacking Match Ops. Verified in the same pass: `/ban` does go through `recordWrite` into
`change_log` with the actor's email, the verb/endpoint and a before/after ban state.

**`/ban` reported a false success and no longer does.** It re-read and classified correctly
(`recordWrite`'s read-after → `outcome`), but returned a bare `{ok:true}` and `PlayerLookup`
branched on `res.ok` alone — so a 2xx that did NOT apply was announced to the operator as
"X suspended". The route now returns `landed` + `status: LANDED / NOT APPLIED / UNKNOWN` and the UI
refuses to report success on `landed:false`. `cancel` already did this; `/ban` was the outlier.

`scripts/matchops-auth-test.ts` (66 assertions, was 28) pins all of it. Its new half **walks whole
paths, not routes in isolation** — it resolves each step's gate from the handler source per HTTP
method (so a dual-gate file can't fool a file-level grep, and a table entry can't claim a flag
check the code doesn't perform), then runs the real gate functions: Deonna's exact flag set walks
board → tile → panel → roster → cancel preview with zero 403s; she can ban; Match-Ops-without-
MANAGE-PLAYERS cannot; PUT match / POST roster / POST cancel each refuse her individually; a
no-flags account is 403 on all ten; the E2E account is blocked by email on every one.

## The roster population — what `_count.players` actually counts (2026-08-14)

**The old rule was true but incomplete, and the incompleteness was the bug.** "`_count.players` is
authoritative; `players.length` includes cancelled rows" leads a reader to filter cancelled and
stop — which leaves every unsettled sign-up in the list.

Proven on production **17516** (Soccer Central Field 4, Fri 14 Aug), `_count.players` **18**,
**38** user-match rows:

| bucket | rows | counted by `_count.players` |
|---|---|---|
| `paidStatus: "PAID"` | 15 | yes |
| `paidStatus: "FREE"`, not cancelled | 3 | yes |
| **`paidStatus: "WAITING"`** | **18** | **no** |
| `isCancelled: true` | 2 | no |

15 + 3 = 18, exactly. A **WAITING** row is a sign-up whose checkout never settled; a retried checkout
leaves one row per attempt — one player ("Grego mrtnz") produced **27** rows on that match, only 2 of
them cancelled, most `userType: "GUEST"`.

**Prevalence:** across 8 weeks, **578 of 897 matches (64.4%)** carry at least 3 more rows than
`_count.players`; **2,389** WAITING rows in the window; worst case **16674 "ATH Katy" — 22 counted,
59 rows**.

**THE SINGLE PREDICATE IS `rosterRowCounts()` in `src/lib/gamedayModel.ts`:**
`!cancelled && refunded !== true && paidStatus !== "WAITING"`. Every surface that lists or counts a
roster uses it. **Do not re-derive it** — a second copy is how the two numbers drift again, and the
invariant (rendered rows == `_count.players`) is asserted in `scripts/gameday-model-test.ts`.

OPEN (for Vitalii): does a WAITING row RESERVE capacity in the player-facing app? If it does, 18
WAITING rows on an 18-spot match are blocking real sign-ups, and this is a lost-revenue bug rather
than a display one.

## Manager pay: co-managed matches, and why the sheet has ONE dropdown (Phase 25)

**`mdapi_matches` carries `manager_email` for the primary but ONLY `second_manager_id` for the
secondary — there is no `second_manager_email`.** The two slots are not symmetric, and the pay model
accumulates on `lower(manager_email)` (`manager_gusto_aliases` is keyed the same way, with a DB CHECK
enforcing it). So a second dropdown would require an email↔id bridge this data does not have.

Measured on production, 8 weeks to 2026-08-12, non-cancelled matches:

| fact | value |
|---|---|
| matches | 706 |
| **co-managed** (`second_manager_id` set) | **3 (0.4%)**, never >1 in a week, all ATX |
| **unassigned** (no manager at all) | **0** |
| tournaments (`maxPlayerCount >= 25`) | 260 (37%) |

Consequences, all deliberate:

- The city-manager sheet edits the PRIMARY only and **refuses a co-managed match** (409, "This match
  has two managers"). Silently editing one of two people's pay is a payroll error with no visible
  cause.
- **Pay is never a flat $20.** `payAmount()` — now exported — is $20 solo, $30 solo tournament,
  $20 to the primary when co-managed (no tournament premium), $0 cancelled. At 37% tournaments a
  hardcoded $20 would be wrong most days, including in the "this reassignment moves $X" line.
- **A city manager is not filling gaps, they are reassigning.** Zero unassigned matches in 8 weeks.
  The unassigned handling is built in full (the model supports a null manager) but the page's copy
  leads with reassignment, and the tile reads "every match that will run has a manager" at zero.
- **The manager↔account join is EMAIL ONLY, with no id fallback.** A manager whose MatchDay email
  differs from their Clubhouse login silently looks like someone who worked nothing. The city page
  detects this and says so ("We could not match your login to any manager record for DFW") rather
  than rendering an empty row.

## Promo codes — the endpoint, proven by read-only production GETs (Phase 18a)

Live-probed on production 2026-08-10 (read-only, `scripts/promo-step0-probe.ts`). The
promo resource is `/admin/promocodes` (create/update/delete/detail) but the LIST has a
**path + param split that must not be papered over**:

- **`GET /admin/promocodes`** and **`GET /api/v1/admin/promocodes`** BOTH exist and both
  do paging (`limit`, `page` 1-based) + date filter (`endDateMin`, `endDateMax`, ISO).
- **`?code=` search is ACCEPTED ONLY on `/api/v1/admin/promocodes`.** On plain
  `/admin/promocodes` it 400s `"property code should not exist"` (the endpoint runs
  `forbidNonWhitelisted`, same as matches). So the **list/search uses `/api/v1/admin/promocodes`**
  (it accepts every list param) while **mutations use `/admin/promocodes`** (no `/api/v1`).
  This asymmetry is real, not a transcription error.
- **No sort param exists.** `sortColumn`/`sortDirection`, `orderBy` all 400 on both paths.
  There is a STABLE default order (page 1 fetched twice is byte-identical) but it is
  **neither `id`- nor `createdAt`-sorted** (page 1 begins with 2023 codes: ids 15,16,17,9,11,12…).
  So "sort by date created" is NOT expressible server-side; only reverse-paging the stable
  order is, and that order is not creation order.
- **No `isDeleted` filter** (400). Soft-deleted rows are mixed into the date-filtered results.
- **Counts:** response is `{ data, totalItems }`. `totalItems` is exact for the given filter.
  No filter → **6,260** total (NOT the mock's 2,164). `endDateMin=now` → 2,161;
  `endDateMax=now` → 4,099; 2,161 + 4,099 = 6,260, so the end-date split PARTITIONS cleanly.
  There are **no per-state counts** (active/scheduled/expired/deleted are derived, uncounted).
- **List row shape (raw payload, not Retool's column subset):** `id, code, startDateUtc,
  endDateUtc, discountType, discountValue, targetUserType, numberOfUsesPerUser,
  targetMatchType, matchTimePeriodStart, matchTimePeriodEnd, createdAt, updatedAt, deletedAt`.
  **`usageCount` (redemptions) is NOT on the list row** — it is detail-only
  (`GET /admin/promocodes/{id}`). So REDEEMED/LEFT cannot be list columns without an N+1.
- **Dates are TRUE UTC**, not wall-clock-with-Z like matches. A promo carries only
  `startDateUtc`/`endDateUtc` (no wall-clock twin); e.g. `MDTUESDAY` = `2023-06-06T20:30:00.000Z`.
  These are genuine instants — display/enter in America/Chicago (IANA, DST-aware), store UTC.
  **Do NOT reuse the match wall-clock helpers here; they implement the opposite model.**
- **`?code=` semantics:** EXACT match (querying `MDTUESDAY` returns only `MDTUESDAY`) and
  **case-INSENSITIVE** (`mdtuesday` matches). It ignores the date filter, and it **DOES return
  soft-deleted codes** (proven: `AdeMem1`, `deletedAt` set, is returned). So the duplicate
  check is ONE safe call: `GET /api/v1/admin/promocodes?code=<exact>` → any row ⇒ taken,
  including soft-deleted names.

### THE NO-ORDER-BY TRAP — paging is only sound while nothing writes (Phase 18b)

`GET /api/v1/admin/promocodes` has no ORDER BY. Paging is only sound while nothing writes to
the table. A row updated between two page fetches can be returned twice or skipped entirely.
Do not build anything that assumes a complete, non-duplicated walk of this list.

Evidence: 0b showed page 1 = ids 15,16,17,9,11,12… — non-monotonic id AND non-monotonic
createdAt is the signature of **heap order** (no ORDER BY). Heap order survives repeated reads
but not writes: an UPDATE moves the tuple to the end of the heap. So the order is not merely
unsortable, it is not durably stable. `sortColumn`/`sortDirection`/`orderBy` all 400.

**Phase 20 refinement — the two filters order DIFFERENTLY (still no global sort):** the
`endDateMin={now}` filter (the LIVE table) comes back **id-ascending and stable** — pages 1/2/3
strictly ascending within and across boundaries (…12227 | 12228…), id never drops at the 6
endDate-changes in the first 500 rows, and createdAt is monotonic along ascending id (that filter
gets an index plan). The `endDateMax={now}` filter (PAST) comes back **heap-ordered** — page 1 is
15,16,17,9,11,12 with id dropping at endDate boundaries. So LIVE alone would be branch A
(id≈creation order) but PAST is branch C (heap), and a **global** Newest/Oldest toggle needs BOTH
tables to share an order — they don't. Sort stays cut; the screen says so next to the order label.
(A LIVE-only sort is defensible on this evidence if ever wanted — but PAST cannot be ordered, and
the missing ORDER BY (#1 above) remains the real fix.)

FOR VITALII (in this order — #1 is the bug, the missing sort param is only a symptom):
  1. A deterministic ORDER BY on the promo list (id or createdAt), so paging is sound at all.
  2. **`usageCount` on the LIST payload.** It is detail-only today, so REDEEMED on the list (Phase
     20 C) is a per-visible-row N+1 (cap 5, cached, cancelled — measured ~0.6s for a page). Put
     `usageCount` on the list row and the whole lazy-fetch mechanism deletes itself.
  3. `sortColumn` / `sortDirection` params.
  4b. **THE PER-USER CAP IS IMPERFECTLY ENFORCED — measured, and CORRECTED.** Re-measured
     2026-08-15 with a STABLE keyset read (`scripts/probe-promo-excess-value.ts`), staff
     excluded (@playmatchday.com, the fake-player email tail, `is_fake_player`, promo 104):
       • **70 of 812** redeemed per-user-capped codes have been exceeded by a real player — **8.6%**
       • 118 distinct real players; 120 (code,player) pairs; **135** redemptions beyond cap
       • worst overage on one (code,player): **+3** (`comeplay` 2581 cap 1 used 4x;
         `MATCHDAY` 15356 cap 1 used 4x)
       • of the 135 excess, **71 were on CANCELLED matches** (cost nothing) and 64 priced
       • **MEASURED cost of the excess: $648.45**
     A cap of 1 redeemed 4 times still means the server does not HARD-stop at the cap, so the
     number is advisory rather than guaranteed — but at 8.6% and a worst case of +3 it is
     mostly holding, and the exposure is hundreds of dollars, not thousands.

     **THE EARLIER FIGURES IN THIS DOC WERE WRONG AND ARE WITHDRAWN** (they claimed 258/600 =
     43%, 1,416 excess, $6,872). They came from an OFFSET scan of `mdapi_match_players` with no
     ORDER BY. An unordered offset scan returns some rows twice and skips others: the row TOTAL
     was right (14,149 both times), which is exactly what made it convincing, while the
     per-(code,user) counts were inflated by the duplicates. The corrected read walks `api_id`
     forward (keyset), rides the PK index, and reports 0 duplicate ids.
     **The lesson generalises: paginate our own mirror by keyset, never by offset-without-order.**
     It is the same defect the promo LIST endpoint has (#1 above) — we reproduced it locally.

  4. OVER-REDEEMED TOTAL_USAGE codes (Phase 18c audit, Phase 20 E1 split): of 193 `TOTAL_USAGE`
     codes, 13 have `usageCount` > `numberOfUsesPerUser`. Phase 20 E1 checked `updatedAt` vs
     `createdAt` to rule out "cap lowered after the fact":
       • **6 were EDITED after creation** (`updatedAt` later than `createdAt`) — benign, the cap was
         likely lowered post-redemption. NOT a bug: `ATX485FP`(2543) 7/3, `ATX537FP`(2584),
         `ATX553FP`(2894), `ATX545FP`(2981), `Hou243FP`(11563) 5/4, `ATX1284FP`(15818).
       • **7 were NEVER edited** (`updatedAt` == `createdAt`) — the server exceeded the code's OWN
         total cap on its original settings. **This is the real bug**, all `…FP` PERCENT-100%
         (free) field promos, cap 3: `SATX47FP`(10374) 4/3, `ATX1231FP`(15457) 4/3,
         `ATX1265FP`(15521) 4/3, `SATX194FP`(15719) 5/3, `ATX1329FP`(16247) 4/3, `STL70FP`(18062)
         4/3, `HOU363FP`(18987) 4/3. Confirm whether TOTAL_USAGE is meant to hard-stop at the cap.
     The promo detail drawer shows LEFT = "over by N" (warning) for all 13 rather than clamping.
Do NOT build around #1/#2; do NOT attempt a client-side workaround. Phase 18b cut the sort
control for this reason (search-first UI instead).
- **Enums (from Retool create DTO):** `discountType` = `USD|PERCENT` (USD value in CENTS,
  ×100); `targetUserType` = `ALL_USERS|NEW_USERS|CHURN_USERS|SPECIFIC_USERS`; `targetMatchType`
  = `ALL_MATCHES|TOTAL_USAGE|TIME_PERIOD|SPECIFIC_FIELDS|SPECIFIC_MATCHES` (one value, so
  `TOTAL_USAGE` and `SPECIFIC_*` are mutually exclusive). `numberOfUsesPerUser` is the cap
  (per-user; a TOTAL cap when `targetMatchType === TOTAL_USAGE`); `>= 10000` = no-cap sentinel.
- **Delete is soft + reversible:** `DELETE /admin/promocodes/{id}` sets `deletedAt`; restore is
  `PATCH /admin/promocodes/{id}/restore`. Update is **`PATCH /admin/promocodes/{id}`** — CONFIRMED 2026-08-15 from the Retool export:
  three query nodes target it, body `{{ generateDtoToUpdatePromocode.value }}`, which starts from
  `updateFuturePromocodeState` (only touched fields) and is therefore a genuine partial diff.
  **Editable fields:** `code`, `startDateUtc`/`endDateUtc`, `discountType`/`discountValue`,
  `numberOfUsesPerUser`, `targetUserType` (+`userIDs`), `targetMatchType`
  (+`matchIDs`/`fieldIDs`/`matchTimePeriodStart`+`End`).
  **Two pairing rules the DTO enforces and any client must copy:** changing `discountValue`
  alone back-fills `discountType`; changing ONE of `startDateUtc`/`endDateUtc` back-fills the
  other. Switching `targetMatchType` DELETES the other scopes' keys. USD `discountValue` is
  multiplied by 100 (cents) on the wire; PERCENT is sent as-is.
  **Post-redemption behaviour: UNKNOWN.** The DTO has no branch on `usageCount` and excludes
  nothing once a code is redeemed, so it cannot answer which fields the server ignores. Settling
  it needs the server source or a write probe, and probing a live 100%-off code is not
  acceptable. A client should therefore RE-READ after the write and report per field — that
  read-back is what turns a silently-ignored field into a visible NOT APPLIED.
- **Code string: no constraints** (Retool validates non-empty only; no casing/regex/length/trim;
  stored exactly as typed — the caps code `MA` is real).

### `userStatus` NONE DOMINATES historical rows — no attendance metric can trust it (Phase 18)

CAUTION for any future "did they turn up" / attendance metric. On a real high-volume player
(id 78, 579 user-matches) the `userStatus` distribution was: **`NONE` 516**, CANCEL 37,
ON_TIME 25, NO_SHOW 1. So **~89% of rows carry NO attendance signal at all** — `NONE` is not
"absent" or "on time", it is "not recorded" (older matches predate attendance tracking).

Consequences, learned the hard way:
- The player header shows two numbers that don't add up unless you know this: **579 total**
  user-matches vs **161 played** (161 played + 418 cancelled = 579, 0 upcoming). Neither is
  "turned up" — 516/579 have no attendance recorded, so the honest positive signal is only
  `ON_TIME` (25), which itself undercounts because old attended matches are `NONE`.
- Player Lookup reconciles this by driving the header facts AND the match-history filter
  chips from ONE count (upcoming / played / no-show / cancelled partition the total), so the
  numbers can never disagree — but it does NOT claim any of them means "attended".
- Any attendance rate built on `userStatus` will be **mostly blind** on history. If you need
  real attendance, it must come from a source that backfills the `NONE` rows (check-in logs?),
  not from this field — confirm with Vitalii before shipping any such metric.

## CRM has TWO outbound message paths — both host-pinned, both recordWrite (Phase 19)

A message reaches a player through one of TWO paths. `/api/crm/send` is NOT the only one — do
not assume it is when auditing what we've said to players.

1. **`POST /api/crm/send`** — the OPERATOR path. A human composes and sends from Player Chats.
   Gated on `can_send_messages` (Step 1, distinct from the `can_access_chats` READ right) and on
   a real operator (`appUserId != null` — the cron/`CRON_SECRET` path is rejected: a
   player-visible message must have a human behind it). WhatsApp via `sendWhatsAppText`
   (Meta Cloud API) or SMS via Telnyx.
2. **The out-of-hours AUTO-REPLY** — the SYSTEM path. Fired by the WhatsApp inbound webhook
   (`/api/whatsapp/webhook` → `sendAutoReply`) when a player messages outside hours. Inbound-
   triggered, debounced (`auto_reply_sent_at`), reply-only, a fixed acknowledgment. It does NOT
   go through `/api/crm/send` (by design — it's a machine acknowledgment, not an operator action).

**Both are host-pinned:** `sendWhatsAppText` calls `assertAllowedOutboundHost` (`src/lib/crmHostGuard`)
against the exact parsed host allowlist (`graph.facebook.com` + `api.telnyx.com`) before the fetch,
so both paths are covered. **Both `recordWrite` into `change_log`** the same minimized shape — thread
id, recipient **LAST-4 only** (`phoneLast4`), channel, message LENGTH — **never the body AND never the
full phone** — the operator path with the operator as actor, the auto-reply with `system (out-of-hours
auto-reply)`. So the change log is a COMPLETE record of outbound messages regardless of which path
sent them. Why last-4, not the full number (Phase 19 Step 3b closeout): `change_log`'s read gate is
`is_admin` (`authenticateAdmin`) — a NARROWER audience than the CRM (`is_admin OR can_access_chats`),
so it is not a *wider*-audience leak, but the full phone is still a gratuitous second copy of player
PII that `thread_id` already resolves for any log reader. Last-4 keeps a human "which player" hint
without the duplicate PII. Pinned by `scripts/crm-characterize-test.ts`.

## How an inbound thread is linked to a player — `player_id` + `match_ambiguous` (Phase 19)

Read from the two inbound webhooks (`/api/whatsapp/webhook`, `/api/webhooks/telnyx`), identical
logic. A `crm_thread` is attached to an mdapi account at FIRST inbound and the choice is essentially
frozen:

- **`match_ambiguous` is set true when >1 `mdapi_users` row shares the phone** — the matcher gathers
  candidates by the phone in **E.164** form (`+15125550123`) AND bare **national** digits
  (`5125550123`), deduped by id; `ambiguous = candidates.length > 1`.
- **`player_id` = `candidates[0]`, ordered `created_at DESC` — the NEWEST account wins**, with
  E.164-exact matches ahead of national-only ones. (The webhook comment calls duplicates "historical
  artifacts" and newest "always the right active account" — that assumption is FALSE for a
  family-shared phone; the matcher cannot tell an abandoned re-registration from two live people.)
- **`player_id` is patched only when it was NULL** (an unlinked thread that later matches). Once set
  it is **never revised**, even if a newer account appears.
- **`match_ambiguous` latches false→true and never clears.**
- **Neither is ever re-picked, and NO candidate count or candidate ids are stored on the thread.**
  The count is computable live only via `GET /api/crm/threads/{id}/context` → `historical_account_count`
  (and only when already ambiguous). `player_id IS NULL` means no account matched at all (unlinked).

**Consequence, plainly:** on a shared phone the thread attaches to whichever account was created most
recently and stays there permanently — there is no way to correct the linkage from Clubhouse. The
docked chat + Player Chats header + context pane surface this as "This number is on N account(s).
Showing {name} — it may not be who is writing." rather than the old, too-soft "historical accounts on
file."

## Player CREDITS (Phase 27) — the only endpoint Clubhouse uses that moves money

**`creditAmount` is CENTS. PROVEN.** Read-only scan of 1,200 production players: 31 hold a
non-zero balance and **22 of those are NOT multiples of 100** (74, 99, 399, 866, 974). Read as
dollars those would be $74.00 / $866.00 balances on 22 of 31 accounts; read as cents they are the
$0.74 / $8.66 of change a match leaves behind. Retool independently agrees in both directions —
it renders `creditAmount / 100` as USD and writes back `parseInt(value * 100)`.

**The write is `PUT /admin/players/{id}/profile` with `{ "creditAmount": <cents> }`.** From
Retool's `updateUserCredits` query (`type: PUT`, `bodyType: raw`, Bearer auth). It is an
**ABSOLUTE SET, not a delta** — Retool pre-fills its stepper with the current balance and posts
the whole new value, which would double every balance on save if the field were additive. Only
that one key is sent, so this PUT has PATCH semantics like every other PUT in this API.

**Idempotency follows from that**: the same absolute call twice leaves ONE grant, not two. Not
verified by making the call twice — a duplicate credit probe is a duplicate grant to a real person.

**Side effects: UNKNOWN.** Whether setting `creditAmount` notifies the player, emails them or
touches Stripe cannot be established from the Retool export or from any read. (Note the contrast
with cancel-a-match, where the credit AND the SMS are server-side effects of a single PATCH — so
"a credit is silent" is not a safe inference.) Clubhouse states this rather than assuming it.

**Negative balances: 0 of 1,200 accounts hold one.** Whether the API would *accept* one is
UNKNOWN and untestable without writing one, so Clubhouse refuses to send a negative and says so.

**Clubhouse takes a DELTA anyway.** The operator enters `+25` / `-10` and the server computes
`fresh_balance + delta`. A stepper pre-filled with a balance means one mis-key silently replaces
someone's money and nothing on screen looks wrong. Because the endpoint is an absolute set, the
route **re-reads the balance immediately before writing and ABORTS if it moved** — otherwise a
spend between read and write would be silently put back. It never re-bases and continues.

## Field cost: `per_match_rate` and `cost_per_match` are TWO MODELS, not one fact (Finance rail, 2026-08-17)

Proven against prod `fin_venues` (32 rows) while building `/admin/finance/cost`.

**They are not duplicates and neither is a fallback for the other.**

| column | meaning | read by |
|---|---|---|
| `per_match_rate` | what the venue **invoices** per match | `canonicalVenueCost` → `autoCost` (financeCosts.ts) — the **As Billed** basis |
| `cost_per_match` | the operator's **normalized** per-match unit cost, deliberately bypassing billing-timing lumps | `legPerMatchUnitCost` → `groupPerMatchCostFor` (financeStats.ts) — the **Per-Match** basis |

**6 of 25 `per_match` venues carry `per_match_rate = null`.** Four of those hold a real rate in
`cost_per_match`: NEMP $77, Onion Creek $40, Bicentennial Park $90, Lowell H. Strike $113.50. In
As Billed mode those venues cost **$0** in any month with no override — and that is CORRECT, not a
bug: they do not invoice per match, they lump-sum, and the lumps arrive as
`fin_venue_cost_overrides` (Onion Creek "Lump 2025 up to May 21st 2026", Bicentennial Apr/May/Jun).
Reading `cost_per_match` in As Billed mode would manufacture an invoice nobody sent. I made that
change and reverted it.

The remaining two: **Carroll Senior HS** `cost_per_match = 0` — a GENUINE zero, renders `$0`.
**Helix Park** both columns null, inactive — the only venue with no rate at all, renders a dash.

### A `$0` field cost is legitimate via exactly three mechanisms
1. the unit cost really is 0 (Carroll Senior HS)
2. an operator recorded a `$0` override for the month — prepaid / lump-summed elsewhere
   (Lou Fusz Outdoor "Paid in January"; Centennial Commons "Custom billing month")
3. a share venue whose partner dashboard publishes `$0` owed — **Crossbar Rowlett May 2026:
   3 matches, $49 revenue, `payment: 0`, `state: "nothing"`**

Anything else showing `$0` is the null-rate trap. `verify-finance-sections.mjs` asserts this set
from the database rather than from a name list.

### `matchPnL.ts` reads `cost_per_match` for EVERY billing type — including `profit_share`
`resolveSoccerCentral` / the bucket builder assign `fieldCost = venue.cost_per_match` with no
billing-type branch. Crossbar Rowlett stores a **placeholder 0** there, so any money column fed
from `MatchPnLRow.fieldCost` renders `$0` for a venue whose real cost is the partner payout. The
Finance money pages route through `src/lib/fieldEconomics.ts` and never through that field.

### Partner dashboards: FIVE `profit_share` venues, FOUR dashboards
`partner_dashboards` (all `enabled`): venue 3 Hattrick (flat_percentage 50), 51 Crossbar Rowlett
(per_match_minus_manager 50), 10 PAC Global (flat_percentage 50), 63 PARMER Stadium
(flat_percentage 50). **Venue 52 Hattrick T. (Houston) has none** — its cost is UNKNOWN and
renders a dash. PAC Global and PARMER *do* have dashboards, so their cost is derivable despite
`cost_per_match` being null; an earlier report of mine said otherwise and was wrong.

Cross-check that holds: Hattrick July 2026 = **$1,428**, Crossbar Rowlett July 2026 = **$1,000** —
identical on `/admin/finance/cost` and on `GET /api/partner-dashboards/preview?slug=…`
(`monthly.months[].payment`).

### EVENTS carry revenue but no venue cost — the ratio must not mix them
`isEventSchedule` (`category === "event"`, derived from the **field title** via `EVENT_MARKERS`,
not a match flag) excludes tournament/combine rows from venue cost by policy. But those events
sell spots, and `venuePartnerRevenueFor` counts every DAILY PAID spot at the venue. A naive cost
ratio therefore divides non-event cost by ALL revenue. **ATH Pearland, July 2026: 2 billable
matches against $16,368 of revenue → a 2.0% ratio** that says the pitch is nearly free.
`fieldEconomics.rollup` holds event revenue out of the denominator and states the exclusion.

### `fin_revenue` history — the usable record starts 2026-03
Rows span 2023-05-09 → present, but 2025 has only **two** months with any rows (Jun $5,032,
Nov $2,679) and 2026-02 is empty. First substantial month is **2026-03 ($32,245)**. A
year-over-year comparison would divide by an empty ledger, which is why Revenue's "Previous year
avg" control is **disabled with its reason stated** rather than rendered.
Current-month rows are all `source: Stripe` actuals — no PROJECTION rows leak into the
month totals, so the "so far" mark is measured, not projected.

### Both loaders must gate the render
`useFinanceData` (quarter-scoped) resolves long before `useMatchData` (every match-player row).
Gating on the finance half alone put a real-looking **$0** in the revenue column of every city
until the second landed. `CityPnlTable` still gates on `useFinanceData` only and has the same
transient — not fixed here, and worth fixing.

## The gate router decides on reachability, not on size (2026-08-21)

**Gate route is decided by reachability to the MatchDay API. A diff that touches only Supabase
reads or presentation routes to TYPECHECK even when it is large.** `scripts/gate-scope.mjs` walks
the import graph and asks one question — can this path reach the MatchDay API or the gate itself.
It is not a proxy for risk or for line count. This has now been argued twice from CLAUDE.md's
"the full gate runs when the diff touches … a query", which means a MatchDay query; a Supabase
read is not one. Evidence: the Revenue-pace rebuild (four files, ~700 lines, a new `fin_revenue`
read) routed TYPECHECK, and every path in it reports `matchday-url=false`.

## `router.replace` does not navigate on a STATIC route — dev cannot see it (2026-08-21)

**On a production build, `router.replace()` to the same pathname with different search params does
not navigate on a statically prerendered route.** `/admin/finance/*` builds as `○ (Static)`. The
call is made with the correct href, Next then writes a history entry holding the CURRENT url, and
nothing changes.

**Symptom:** the entire finance period control — both steppers, This-month and all three grain
buttons — was dead in production. Reported from prod at `?p=2026`: clicking Quarter or Month did
nothing, the URL never moved.

**Why nothing caught it.** In `next dev` the route is dynamic and `router.replace` works. **The
whole e2e lane runs against `npm run dev`**, so no suite in this repo can see this class of bug.

**Evidence, on `next build && next start`:** `changeGrain` returned `{key: 2026-01, label: January
2026, anchor: Thu Jan 01 2026, valid: true}`; `setPeriod` called `router.replace("?p=2026-01")`;
`history.replaceState` was then called with `/admin/finance/revenue?p=2026-08`, and sampling
`location.search` every 20ms showed it never left `?p=2026-08`. A manual
`history.replaceState(null,"","?p=2026Q1")` moved the label immediately — so `useSearchParams()`
reacts correctly and only the router call was broken. Ruled out first: the href form
(pathname-absolute failed identically) and `src/proxy.ts` (narrowing its matcher changed nothing).

**Fix:** write the URL with `window.history.replaceState`, which is Next's supported way to update
search params without a server round trip. `FinanceShell.tsx` does this.

**To reproduce any prod-only routing behaviour:** `npm run build && npx next start -p 3100`, then
point a Playwright script at `BASE=http://localhost:3100`. Dev will not show it.

## VERIFY THROUGH THE CALL PATH PRODUCTION USES (2026-08-22)

**A test that constructs its own call shape tests a shape nobody ships.** Two instances in one
session, the same failure twice:

1. **The e2e lane runs `npm run dev` while `/admin/finance/*` builds as `○ (Static)`.** On a static
   route `router.replace()` to the same pathname with different search params does not navigate.
   Every suite passed; the whole period control was dead in production.

2. **A `language sql` function called with defaults OMITTED has its parameter-guarded branches
   constant-folded away; the route passes them as bind parameters and the planner must plan every
   branch.** `player_finder_page` unfiltered: **494ms with the arguments omitted, an 8-second
   statement timeout with the same values passed as explicit nulls.** Byte-identical function.
   Verified direct calls were fast for weeks' worth of confidence and told us nothing.

The rule: measure the shape the caller actually sends. For SQL, that means passing the argument
object the route builds, not the convenient short form.

## SQL: no correlated subquery behind a parameter guard (2026-08-22)

`and (p_mode = 'window' and exists (select 1 from t where t.user_id = r.id and ...))` is a per-row
subplan whenever `p_mode` is a parameter, because a branch reachable for SOME parameter value is
planned for ALL of them. **Compute the set once and semi-join to it:**

```sql
with win as (select distinct user_id from t where p_mode = 'window' and ...)
... and (p_mode <> 'window' or r.id in (select user_id from win))
```

Two more from the same function, both measured: `count(*) over ()` forces the WHOLE result set to
materialise before `LIMIT` can take any of it — 30,245 rows on every request for a total the caller
already had from elsewhere; and a multi-branch `CASE` in `ORDER BY` cannot be served by any index,
so it sorts the full set by a per-row expression. Neither is visible until the set is large.

## The Player Finder's SQL surface (0133–0137, 2026-08-22)

`player_finder_ids` is the ONLY place a finder filter is expressed. `player_finder_page` and
`player_finder_stats` both join to it, which is what stops the stats band describing a different set
of people than the table under it. If a filter is not in that function it does not exist.

`search_blob` is stored **lowercase** in `player_finder_rows`, and the predicate lowers the needle:
`search_blob like '%' || lower(p_search) || '%'`. Case-insensitive end to end through the function —
`Garcia`, `garcia`, `GARCIA` all return 337. **A caller querying the view directly does NOT get
that**: raw PostgREST `like '%Garcia%'` returns 0. Go through the function.
`p_search` is a bound parameter; there is no `EXECUTE`, `format()` or dynamic SQL anywhere in these
functions. The leading `%` costs a ~260ms sequential scan over 30,245 rows — real but not the
bottleneck; a `pg_trgm` GIN index on `search_blob` would remove it.

## Finance period: changing GRAIN loses the point in time (2026-08-21)

`FinanceShell.tsx:84` derives the period from the URL alone — `periodFromUrl(searchParams.get("p"))`
— and `periodFor("year", new Date(y, 0, 1), now)` (`financePeriod.ts:199`) rebuilds the anchor as
the period's **start**. So the `anchor` that `changeGrain` exists to carry is destroyed on every
change, because `p=2026` cannot encode it.

**Measured:** August 2026 → Q3 2026 → 2026 → Month lands on **January 2026**, not August.
`financePeriod.ts:8` states "August 2026 widens to Q3 2026 and then to 2026, and narrowing comes
back to August". It does not. The comment is the design; the URL round-trip is the implementation,
and they disagree.

**FIXED 2026-08-21** by carrying the anchor in a second param: `?p=2026&a=2026-08-21`. `a` is a
plain `YYYY-MM-DD` inside the period. `periodFromUrl` uses it when present and falls back to the
period's start when absent, so every link made before it existed behaves exactly as it did. Grain
changes preserve it; the steppers reset it to the new period's start and This-month resets it to
today. An `a` outside its `p` is clamped to the period's start rather than building a period the
URL does not describe.

**Nothing outside `financePeriod.ts` reads `.anchor`** — all 22 components that call
`useFinancePeriod`/`useFinanceQuarter` read the period only, so the fix touched the model and the
shell and no consumer.

Covered by `verify-period-anchor.mjs`. **`verify-pace-grain.mjs` still cannot catch a regression
here** — it clicks `period-jump` after every grain change, because half of what it asserts is only
true of the current period, so it would stay green either way.

## The 1,000-row cap: agreement below 100% is a TRUNCATION SUSPECT (2026-08-21)

**A join or cross-check that agrees at less than 100% is a truncated read until the read is proven
paged.** This is the fourth time the PostgREST 1,000-row cap has produced a plausible wrong answer.

Most recent: checking roster spots against `mdapi_matches.player_count` over a year of matches
reported **66% agreement, and 340 of 1,000 matches with a positive `player_count` but no roster
rows at all** — which reads exactly like a data-quality problem and was one sentence away from
being written up as one. The cause was `.in(...)` batches returning their first 1,000 rows with no
paging. Paged properly the same comparison is **21,731 vs 21,731 — 1000/1000, 100.0%**. The data
was fine.

`.in()` is the usual carrier: it looks like one bounded lookup, and the cap applies to the whole
response, not per key in the list. `.limit(20000)` does not lift it.

## Roster spots in the mirror: the predicate that reproduces `player_count` (2026-08-21)

`mdapi_matches.player_count` IS `_count.players` under another name — it is authoritative, and the
per-row predicate that reproduces it from `mdapi_match_players` is `rosterRowCounts()` **plus one
mirror-only condition**:

```
is_cancelled = false AND refunded IS NOT TRUE AND paid_status <> 'WAITING' AND deleted_at IS NULL
```

`deleted_at` is a soft delete the API model has no concept of, so `rosterRowCounts()` alone is NOT
enough against the mirror — it over-counts by every soft-deleted row (15 of 81 on match 17516).
Capacity is `mdapi_matches.max_player_count`. Proven over 1,000 matches / 33,399 roster rows:
summed derived spots 21,731 = summed `player_count` 21,731, exact on every match.

## Membership: there is NO tier, and the two member counts disagree by 27 (2026-08-21)

**No plan, tier, product or SKU field exists on the membership record.** The raw payload is
`price, status, userId, comment, lastName, firstName, absentOwed, canceledAt, memberEmail,
phoneNumber, suspendedTo, cancelReason, membershipId, strikePoints, activationDate,
membershipLength, cityIdentifierAndMemberId`. `city_member_slug` is a per-member identifier
(`ATX597`) with one distinct value per row; `membership_length` is a day count. **Do not infer a
tier from `price`.**

**`mdapi_users.is_member` = 397 while `mdapi_subscriptions` status ACTIVE = 424 — a 27-row
disagreement, source UNKNOWN.** Player Finder deliberately filters on **`mdapi_users.is_member`**:
it is user-grain, the page already reads it, and it costs one fewer join. Not chased.

**Observation, not a feature.** ACTIVE subscriptions cross-tabbed price × city fall into three
bands: **$66** — ATX (104 of 191), SATX (72 of 79), HOU (64 of 68); **$30** — ATL (29 of 31),
DFW (17 of 20), STL (15 of 23); **$15** — OKC (6 of 12). ATX also carries 57 at $0 and 25 at $49.
So Oklahoma City does sit at a different price point from Austin and Houston. Nothing in the app
names any price "discounted", no filter is built on it, and it is not on screen.

## `mdapi_users.preferable_city_name` — the preferred-city column (2026-08-21)

30,453 rows; **4,187 NULL (13.7%)**, zero empty strings, so `IS NULL` is the whole test. There is
also `preferable_city_normalized`. Distinct values: Austin 12,504 · Houston 5,766 · *(null)* 4,187 ·
San Antonio 3,319 · Dallas / Fort Worth 1,662 · Atlanta 1,275 · St. Louis 828 · Oklahoma City 474 ·
New York City 350 · El Paso 83 · **Warsaw 5**.

**Warsaw is five people.** The city the registered-players table was built for holds five preferred-
city rows, so a Warsaw filter returns five. That is correct, not a bug.

## A CAPABILITY GATE IS NOT A BOUNDARY (2026-08-22)

Twice in one night the only thing between a confined account and an unscoped route was a permission
nobody had granted yet — and both times the permission turned out to be **already granted**.

**`CONFINED_ROUTE_PREFIXES` allows `/api/matchday/` wholesale**, so every route beneath it is
reachable by a confined account and the only protection is whether the handler's author remembered
a scope check. Audited 2026-08-22 — **four of six remembered**:

| route | methods | scope check |
|---|---|---|
| `/api/matchday/[env]/gameday` | GET | yes |
| `/api/matchday/[env]/matches/[id]` | GET, PUT | yes |
| `/api/matchday/[env]/matches/[id]/cancel` | GET, POST | yes |
| `/api/matchday/[env]/roster/[matchId]` | GET, POST | yes |
| `/api/matchday/[env]/matches/create` | POST | **NONE** — fixed 2026-08-22 |
| `/api/matchday/[env]/players/[playerId]/credits` | GET, POST | **NONE** — fixed 2026-08-22 |

**Both Warsaw accounts held `can_edit_matches` AND `can_edit_credits` with no city check behind
either route.** `rgmstrategicventures@gmail.com` from **14 August**, `jf@playmatchday.pl` from
**21 August**. Neither had ever signed in (`last_login_at` null), so this was exposure rather than
an incident — but the window was eight days, and the reasoning that made it feel safe ("nobody has
that permission") was false the whole time.

**THE RIGHT SHAPE IS THE INVERSE**: a confined account should get an explicit route allowlist, so a
route added next month is denied by default rather than exposed by default. Not done — a design
change, Ryan's call. Recorded so the size of it is known.

## Credits are scoped by `preferable_city_name`, knowingly (2026-08-22)

A confined account may read and adjust credits only for players whose stated city equals its own.
The comparison is `preferableCity.abbr` from `GET /admin/players/{id}` against
`app_users.city_identifier` — the same identifier string, so no name mapping is involved.
**NULL is a REFUSAL**: 4,187 players have no preferred city and none of them belong to anybody.

**WHY A STATED PREFERENCE AND NOT A ROSTER TEST.** There is no player-in-city definition to build
one from: `GET /admin/players` rejects every city parameter, and a roster test breaks on real
people — someone who plays in Warsaw but prefers Austin, someone who prefers Warsaw and has never
played. In a NEW market there is no legacy overlap for a preference to be wrong about.

**IT IS PLAYER-EDITABLE, AND THAT IS ACCEPTED.** A player can change their own preferable city, so
this bounds WHO AN OPERATOR MAY ACT ON, not who may enter the set. A player switching to Warsaw does
not credit themselves — it puts them in a list an operator still has to act on. The operator is the
control, not the field. **Revisit if a confined market ever stops being new** — the moment a
confined city has players who selected it without playing there, or who play there without
selecting it, this test starts being wrong in both directions.

Covered by `scripts/credits-city-scope-test.ts` (fast gate, 10 assertions) because the route's guard
cannot be exercised without a confined login and it protects money.

## CORRECTION: there is NO 400-match ceiling and no 501 (2026-08-23)

**The 400-match cap and its 501 were deleted with the roster union in `b0a2430`.** There is no
match-count ceiling anywhere in `src/` — `grep "status: 501"` returns nothing — and Master Schedule,
being week-scoped, never had one.

It was real: the registered-players table's roster half needed a match-by-match walk because
`mdapi_match_players` has no foreign key to `mdapi_matches` and PostgREST cannot embed the join.
That walk capped the feature at 400 matches and returned a 501 naming the missing FK. When Player
Finder replaced that table the union went, and the ceiling went with it.

**It was repeated as a live constraint for a whole session after it stopped being true.** Recorded
here so it stops being folklore.

## ABSENCE IS NOT EVIDENCE, in a young market (2026-08-23)

**In a market that is weeks old, missing data means nobody has entered it yet — not that the thing
does not exist.** This cost twice in one session:

1. **Warsaw "has no Veo camera".** Inferred from an absent `veo_codes` row and a missing
   `fin_venue_fields` link for field 1684. I built a disabled tab and on-screen copy saying so.
   Warsaw HAS a camera; the absences were a data gap. The copy was false and was removed.
2. **The roster mirror "is 34% incomplete".** Inferred from a summed comparison that came back at
   66%. The data was fine; the read was truncated by the 1,000-row cap.

Both were an absence read as a fact. The test before writing one down: *could this be missing
because nobody has filled it in yet?* In a city with three matches and one field, the answer is
almost always yes.

Related and different: `mdapi_users.preferable_city_name` NULL on 4,187 players is NOT this — it is
a real, populated field that those players genuinely have not set, which is why credits treat NULL
as a refusal rather than a gap to be filled in later.

## A DESIGN CLAIM ABOUT SIZE IS ASSERTED ON THE COMPUTED SIZE (2026-08-23)

**When the claim is "this element is bigger", assert the computed font size — never the presence of
a class.** A class-presence check passes on a page that has lost its hierarchy.

The City P&L redesign exists to make Net P&L the answer: largest figure in the row, heaviest, a
darker green than Revenue. It shipped with `.net6 { font-size: 18px }` on the right element and
rendered at **14.5px — exactly Revenue's size** — because `.tbl tbody td` sets 14.5px and
outspecifies a single class. The markup was correct, the class was present, and the central claim
of the redesign was silently absent. Only `getComputedStyle(el).fontSize` caught it.

The same applies to weight, colour and anything else a reader is meant to notice first. The fix was
to scope the rule to the cell (`.tbl6 tbody td.net6`) rather than reach for `!important`.

## Pitch rows sum to the city MINUS untracked, not plus (2026-08-23)

`cityPnl.ts:196` — a city's `gross` is `mappedDpp + membership`, and `mappedDpp` **excludes**
unmapped fields. The pitch list renders **all** fields, mapped and not. So:

```
pitchSum = gross + untracked        →        gross = pitchSum − untracked
```

Houston, Aug 2026: pitches $14,591 − untracked $126 = **$14,464**, the city figure. Written the
other way round it passed on six of seven cities, because only Houston carries any untracked
revenue at all — an assertion that reconciles by having nothing to reconcile.

## VENUE NAMES ARE NOT UNIQUE ACROSS CITIES — join on `(city, name)` (2026-08-23)

Matching the Field Pipeline board (`kanban_cards`, `board_type='field_pipeline'`, city in the JSONB
`data` column) against `fin_venues` by NAME ALONE produced a **confident wrong answer**: Houston's
`The Hattrick` matched Austin's `Hattrick`. Houston's real row is `Hattrick T.`.

A missed match is a gap and looks like one. A **false positive silently attaches one city's venue to
another**, and every number downstream — cost per match, billing basis, P&L attribution — reads
plausible. This is the same failure shape as `verify-finance-sections` asserting the quarter control
existed via `querySelector("select")`: a selector broad enough to match a different subject passes on
the wrong subject.

**The rule, for Push D and anything else joining these two lists: join on `(city, name)`, never on
name alone, and never by substring across the whole table.**

### The four naming mismatches, recorded so they are not rediscovered

Measured 2026-08-23 over 23 `confirmed` pipeline cards against all 32 `fin_venues` rows, with
`fin_schedule` (1,082 rows, paged) as the corroborating evidence for which venue has actually been
billed.

| Pipeline card | `fin_venues.venue_name` | Evidence |
| --- | --- | --- |
| `ATX / RR MPC` | `Round Rock` (Austin) | 17 `fin_schedule` rows, last 2026-06-28 |
| `HOU / Katy ISC` | `KISC (Katy Intl)` (Houston) | 52 rows, last 2026-09-29, active |
| `STL / Lou Fusz Athletic Complex` | `Lou Fusz Outdoor` (St. Louis) | 128 rows, last 2026-09-30 — the only Lou Fusz string ever billed |
| `STL / Lou Fusz Training Center` | `Lou Fusz Indoor` (St. Louis) | **PROBABLE, UNPROVEN.** The row exists (launch 2026-02-16, cpm 100) but has ZERO `fin_schedule` rows and `is_active=false`. Training Center ↔ Indoor is inferred from the names. |

### `SATX / New Braunfels` is secured on the board and unknown to Finance

No `fin_venues` row (San Antonio holds only `Soccer Central`, `Soccer Central Tournament`, `STAR`)
and zero `fin_schedule` rows matching `/braunfels/i` anywhere in the table. A field marked locked
that Finance has never heard of. Not a data-model defect — an operational gap for Ryan.

## AUSTIN IS THE DEGENERATE CITY — a fixture that is Austin cannot see a name bug (2026-08-23)

**`cityScope`'s platform label and `cityMap`'s cockpit name are the same string in Austin, and only
in Austin.** Everywhere else they differ: `DFW` is `"Dallas / Fort Worth"` against `"Dallas"`, and a
comparison written against the wrong one of the pair matches in Austin and drops every row
everywhere else.

**The rule: name comparisons across `cityScope` and `cityMap` match in Austin and ONLY in Austin.
Any test whose fixture is Austin cannot see a normalisation bug.** Pick a second city deliberately,
or the suite is proving that one string equals itself.

Two worked examples, found eleven days apart by different means, and they are the same failure —
two systems that do not agree on names, with everything happening to be checked against the one city
where they do:

* **DFW reviews rendered ZERO** while the trailing-8-week strip on the same page showed **232**. The
  strip is the one panel that ignores the page filters, which is the only reason it was visible at
  all. Caught by `verify-city-confinement` section 6c — which has since been **deleted**, so this is
  uncovered again; see the entry below.
* **Houston's `"The Hattrick"` resolved onto Austin's `"Hattrick"`** when the Field Pipeline board
  was matched against `fin_venues` by name. Houston's real row is `"Hattrick T."`. Caught by hand
  while reading the match list. See the `(city, name)` rule above — it is the same lesson from the
  join side.

A miss shows up as a gap. **A false match silently attaches one city's data to another and every
number downstream reads plausible.**

## The Player Lifecycle route rename, and why the legacy redirects are ENUMERATED (2026-08-23)

`/growth` → `/lifecycle`; `can_access_growth` → `can_access_lifecycle` (migration 0139, backfilled,
10 of 16 accounts, verdict `10 / 10 / 0 / 0 / 16`). Nothing a user reads changed — the section has
said "Player Lifecycle" on screen since the Membership move.

**`/growth/:path*` would have been one line and it would have made the incoming Growth tab
unreachable the day it shipped** — every request to `/growth/field-pipeline` or
`/growth/city-launches` would 308 into a section with no such page, and nobody would connect the two
changes. `next.config.ts` therefore lists the six report paths and the eight city slugs (`citySlug()`
over `CITIES`, the same closed set `cityFromSlug()` resolves) plus the bare root as its own line.
`verify-lifecycle-rename` asserts all fifteen redirect AND that `/growth/field-pipeline` is not
swallowed, with the fifteen as its positive control in the same run.

`can_access_growth` is left in place and unread rather than dropped: a dropped column racing a
deploy 500s every admin route. It is freed for the Growth tab by an `UPDATE … WHERE`, not a
`DROP`/re-`ADD`.

**0139 also had to rewrite the 0124 city-manager exclusivity CHECK.** That constraint enumerates the
broad `can_access_*` flags BY NAME, so it is silently weaker for every flag added after it — a city
manager could have held `can_access_lifecycle` and the CHECK would have passed. Any future broad flag
must be added to it in the same migration that creates the column.

### A path rewrite matched a CSS-module import, and only the production build saw it

The rename regex `(?<![\w-])/growth\b` matched `./growth.module.css` (a `.` is neither `\w` nor `-`),
rewriting one import to a file that does not exist. `tsc --noEmit` passed — `*.module.css` is
declared loosely — and so would any dev-server run of the pages. `scripts/seam-stripped-test.ts`
caught it, because it does an isolated **production build**. A mechanical rename across a repo is not
verified by typecheck alone.

## THE CITY-MANAGER TIER'S NON-DEGENERATE-CITY COVERAGE WAS DELETED (2026-08-23)

`verify-city-confinement.mjs` section 6c — six assertions driving a **second** city manager, DFW —
was removed on Ryan's call. The account behind it, `rgmstrategicventures@gmail.com`, had been
repurposed as the **Warsaw** test account: `is_city_manager=false`, `city_identifier=WAW`. That makes
it the CONFINED tier, not the city-manager tier, so the block asserted a locked city control on an
account nothing locks. Five of its six assertions had been failing; the sixth passed as `0 === 0`
and its own positive control was what said so.

### The tier itself is still covered — the gap is narrower and sharper than that

`isConfined(row)` is **`city_identifier` non-empty and nothing else** (`cityConfinement.ts:58`).
`isCityManagerConfined(row)` is **`is_city_manager === true && is_admin !== true`**
(`capabilities.ts:68`). They are different columns and different rules, and one account can satisfy
both. `garrettsuits@gmail.com` — which the whole surviving suite runs as — holds
`is_city_manager=true` AND `city_identifier=ATX`, so it satisfies both. The city-manager tier is
still driven through a real `app_users` row against the real server.

**The precedence differs between them, and it is worth stating because it is easy to get backwards:**

```
can():  if (isCityManagerConfined(row)) return false;   // has an is_admin term → is_admin WINS
        if (confinedBlocks(row, cap))   return false;   // isConfined has none  → the boundary BEATS is_admin
```

### What is actually uncovered now

**The only non-degenerate city name** — see *Austin is the degenerate city*, above. With 6c gone the
entire remaining fixture is Austin, so a normalisation bug is invisible to it. That is precisely the
bug 6c was written for.

Nothing else covers it. `verify-city-manager.mjs` mocks the `app_users` row through a browser route
handler and says so in its own header — it proves nothing about the server.
`scripts/city-confinement-test.ts` uses `"Dallas / Fort Worth"` as an input label to a pure summary
function, not as a join key.

**To close it:** a real city-manager account scoped to a city whose platform label differs from its
cockpit name. DFW, SATX and HOU city managers already exist, so this is a name away whenever it is
wanted. Do not re-point the block at another account without first checking that the row actually
holds `is_city_manager` — repurposing the account without checking is how this broke.

**Tally on the record**, so the drop is not mistaken for suites quietly shrinking:
`80 passed / 5 failed` → `79 passed / 0 failed`.
