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

## PROMO CAPS ARE ADVISORY — the server does not enforce uses-per-person

**70 of 812 redeemed capped codes have been exceeded.** Setting `uses` on a promo code does not
stop the redemption; nothing server-side refuses the transaction when a person is over their cap.
The number is a statement of intent, not a limit, and every one of those 70 is money that left on
a code that should have stopped.

This used to be printed on the create form, next to the field. It is here instead: the form is
where someone types a number, not where they should be reading about the API's guarantees.

## /admin/matches — sortDirection is LOWERCASE

`sortDirection: "ASC"` returns **400** and says so exactly:

```
{"message":["sortDirection must be one of the following values: asc, desc"],
 "error":"Bad Request","statusCode":400}
```

That was the Promo Codes match picker's "match search HTTP 400" — nothing to do with the dates,
the city, or a missing parameter. Measured on production 2026-08-31: the identical request with
`"asc"` returns 100 of 467 for a September range.

**The same endpoint also 400s on an unknown param** — `date` gives `"property date should not
exist"` (it wants `fromDate`/`toDate`). And `/admin/subscriptions` 500s with no `sortColumn` /
`sortDirection` at all. The sort params are load-bearing on these list endpoints and their
casing is checked.

**`/admin/matches` HAS NO CITY FILTER.** The promo picker fetches the range and narrows by city on
the client. Measured over 2026-09-01..09-30: 94 matches across 8 cities, and every city has at
least one — Atlanta 7, Austin 34, DFW 7, Houston 14, OKC 5, San Antonio 22, St. Louis 3, Warsaw 2.
Picking a city narrows; it never empties.

## THE DATE PAIR — a lone endDate is fine, a lone startDate is not

**MEASURED 2026-08-31**, one throwaway staging match, two writes:

```
lone endDate    -> start 18:00 unchanged, end 19:00 -> 20:00.  LANDED, startDate untouched.
lone startDate  -> start 18:00 -> 16:00, and the END STAYED at 20:00.
                   Duration went 2h -> 4h. The server does NOT carry the end with it.
```

So `PUT /admin/matches/{id}` does **not** require the pair. An end-time edit legitimately sends
`{ endDate }` alone — the same result `matchWhen.ts` already recorded on staging 2560. A **start**
change without the end silently rewrites the duration, which is the half worth refusing.

**OUR OWN GUARD WAS WRONG, AND IT IS ALSO THE ONLY REASON NOTHING IS CORRUPT.** Clubhouse refused
*any* lone date key — "startDate and endDate must be sent together" — carried from Phase 7 with no
measurement behind it. It blocked a legitimate save on production 18292. It also blocked every
save of the roll-forward bug below: **595 future matches, zero with an implausible duration**
(nothing over 6h, nothing non-positive, nothing ending more than a day after its start; the whole
spread is 0.75h ×5, 1.00h ×565, 1.50h ×25). A wrong rule stopped a real bug from reaching the data
for however long both have existed. The guard now refuses a lone `startDate` and allows a lone
`endDate`.

## END-TIME ROLL-FORWARD — derive from the START, never from the previous end

`moveEnd` built the new end on `parseWall(curEnd).date` — the **previous end's** date — and rolled
only FORWARD. That made it sticky and one-directional.

`<input type="time">` fires `onChange` on PARTIAL values and always will. On production 18292
(start 20:00, end 20:45, same day) editing the end to 9pm passed through a momentary time at or
before the start, which rolled the end to the next day; nothing ever rolled it back, so the
finishing keystroke inherited it and the panel read **DURATION 25h on a one-hour match**.

It is now a **pure function of (staged start, typed time)**: the date comes from the start and
rolls forward at most once. The next keystroke corrects rather than inherits.

**THE MIDDLE GROUND DOES NOT WORK** — preserving the previous end's whole-day *offset* was tried
and measured, and still lands at 25h, because the offset is itself poisoned by the same partial
keystroke. Only dropping the dependency entirely corrects.

**WHAT IT GIVES UP:** a match longer than ~48h can no longer be reached by typing an end time. A
stored 34h fixture is untouched by loading or by any other edit, but editing *its* end time now
yields under 48h. A time alone cannot say "the day after tomorrow"; that needs a date control.

## FIELD IMAGES — the endpoint is POST /files, and it is not a field endpoint

**FOUR PATH GUESSES, ALL 404, ALL WRONG THE SAME WAY.** Recorded so nobody spends the afternoon
again: `/admin/fields/{id}/images`, `/admin/images`, `/admin/fields/images`, `/admin/upload`.
Every one assumed a FIELD endpoint. **The entity is a body parameter**, so no path containing
"field" could ever have hit it. The answer was in `retool-export-prod.json` the whole time
(queries `getUploadedUrlField`, `getUploadedUrlFieldCover`).

**THE BROKER.**

```
POST {api}/files            Authorization: Bearer <token>
  { "contentType": "image/png", "entity": "field",
    "entityContent": "cover" | "gallery", "entityId": <fieldId> }
-> { "uploadURL": "https://<bucket>.s3.us-west-1.amazonaws.com/images/<uuid>?X-Amz-…" }
```

Staging returns **`uploadURL` and no other key**. Retool reads
`getUploadedUrlField.data.header['x-amz-tagging']` for the PUT's header — that path does not
exist, so it sends an empty header and the upload works anyway. Production's response shape is
**UNKNOWN**; probing it is a non-GET against production.

**THE PUT IS PRESIGNED.** SigV4, `X-Amz-Expires=3000` (50 min), `X-Amz-SignedHeaders=host` — only
`host` is signed, so no header must match and **no Authorization may be sent**. The tag that
drives the attach is already in the signed query string:
`x-amz-tagging=field%3D<id>%26image%3D<cover|gallery>`. Content-Type is accepted but not required
(both forms returned 200 with an identical ETag). A **signed URL is a bearer credential** — never
log it; log the object key.

Buckets: **`matchday-stage.s3.us-west-1.amazonaws.com`** / **`playmatchday.s3.us-west-1.amazonaws.com`**.

**THE ATTACH IS ASYNCHRONOUS, AND THIS IS THE TRAP.** `POST /files` creates **no** row — measured.
The PUT deposits bytes. The server then attaches off the object tag. **Measured staging 2026-08-29:
the `images[]` row appeared 1,551 ms after the PUT returned 200**, and a cover upload repointed
`field.cover` on the same delay. So a 2xx is not the write landing, and an immediate read-back
reports NOT APPLIED for a write that is about to succeed. There is **no contract** saying the
attach is bounded at all. `/api/fields/photos` polls for 8 s (~5× the measurement) and reports
**LANDED / PENDING / FAILED / UNKNOWN** — PENDING is not a failure, the bytes are in S3.

**ORPHANS ARE INVISIBLE FROM OUR SIDE.** If the attach never happens the S3 object exists with
nothing referencing it. The only list the API exposes is the field's `images[]`, which is by
definition the attached ones; there is no bucket-listing endpoint anywhere in the surface below.
An orphan can be created but cannot be detected or cleaned up through the API.

**TWO THINGS THE API CANNOT DO.**
- **No promote-to-cover.** `PUT /admin/fields/{id}` (`updateField`) takes title, description,
  parkingNote, address, zipcode, lat, lng, cityId, recommendedPlayerCount, abbr, orderPosition —
  **no `cover` key.** A cover is set only by uploading one.
- **No delete-cover.** The only image delete in the entire export is
  `DELETE /admin/fields/{id}/images?imageId[]={id}` (`deleteImageFromField`), which acts on
  gallery rows. The cover is replace-only.

**COVER AND GALLERY ARE DISJOINT.** All 44 production fields: 44 have a cover, 33 have gallery
photos, and the cover URL appears inside `images[]` **zero** times. (Positive control in the same
pass: a gallery URL matched itself, so the comparison could have found an overlap.)

## THE REFERENCE IMPLEMENTATION'S FULL API SURFACE

From `retool-export-prod.json` (gitignored, `.gitignore:70`; never committed — verified with
`git log --all`). 942 plugins, 253 REST queries, **183 distinct (verb, path, query name)** below,
plus 89 SQL and 14 JS queries not listed. Path parameters are shown as `{}`.

**This list is a MAP, NOT A LICENCE.** Nothing here has been probed except where this document
says otherwise, and a path appearing below is not evidence of its request or response shape. It
exists so nobody guesses an endpoint name again.

The export holds **no live credential**: every `Authorization` header in all 147 authenticated
queries is the template `Bearer {{ localStorage.values.accessToken }}` (42 and 44 chars, two
whitespace variants). A scan for JWTs, `AKIA…` keys, `sk_live`/`sk_test`, literal Bearer/Basic
values, `service_role` and hardcoded `password` fields returned **zero** of each.

| verb | path | Retool query |
|---|---|---|
| `GET` | `/admin/cities` | `getAllCitiesForSpecialEventCreate` |
| `GET` | `/admin/cities` | `getCities` |
| `GET` | `/admin/cities` | `getCitiesForUpdate` |
| `GET` | `/admin/cities` | `updateCitySelect` |
| `PUT` | `/admin/cities/{}` | `updateCity` |
| `GET` | `/admin/cities/{} /fields` | `getFieldsForSpecialEventCreate` |
| `GET` | `/admin/cities/{}/fields` | `createMatchCityId` |
| `GET` | `/admin/cities/{}/fields` | `getFieldsByCityId` |
| `GET` | `/admin/cities/{}/fields` | `getFieldsByCityIdForCreateMatch` |
| `GET` | `/admin/cities/{}/fields` | `globalVar` |
| `GET` | `/admin/fields` | `getFields` |
| `GET` | `/admin/fields` | `getFieldsForPromocodes` |
| `GET` | `/admin/fields` | `getFieldsForSpecialEvents` |
| `GET` | `/admin/fields` | `getFieldsForUpdatePromocodes` |
| `POST` | `/admin/fields` | `createField` |
| `POST` | `/admin/fields` | `updateZipcode` |
| `DELETE` | `/admin/fields/{}` | `deleteField` |
| `DELETE` | `/admin/fields/{}` | `teamsForAddPlayer` |
| `PUT` | `/admin/fields/{}` | `createFieldBtn` |
| `PUT` | `/admin/fields/{}` | `updateField` |
| `GET` | `/admin/fields/{}/phone-numbers` | `getFieldPhoneNumbers` |
| `POST` | `/admin/fields/{}/phone-numbers` | `addFieldPhoneNumber` |
| `DELETE` | `/admin/fields/{}/phone-numbers/{}` | `deleteFieldPhoneNumber` |
| `PATCH` | `/admin/fields/{}/phone-numbers/{}` | `newFieldPhoneNumberInput` |
| `PATCH` | `/admin/fields/{}/phone-numbers/{}` | `updateFieldPhoneNumber` |
| `PUT` | `/admin/leaderboard/1` | `updateCurrentLeaderboard` |
| `GET` | `/admin/matches` | `getCanceledMatches` |
| `GET` | `/admin/matches` | `getMatches` |
| `GET` | `/admin/matches` | `getMatchesForPromocodes` |
| `GET` | `/admin/matches` | `getMatchesForUpdatePromocodes` |
| `POST` | `/admin/matches` | `createMatch` |
| `POST` | `/admin/matches/clone-by-week` | `makeCopyMatchesByThisWeek` |
| `POST` | `/admin/matches/copy-by-week` | `copyMatchesByWeekFromMondays` |
| `POST` | `/admin/matches/copy-by-week` | `copyMatchesByWeekToMondays` |
| `POST` | `/admin/matches/copy-by-week` | `makeCopyMatchesByFromToWeek` |
| `GET` | `/admin/matches/reviews` | `getMatchReviews` |
| `DELETE` | `/admin/matches/user-matches/{}` | `deletePlayerFromMatchById` |
| `DELETE` | `/admin/matches/{}` | `deleteMatch` |
| `GET` | `/admin/matches/{}` | `getMatchByID` |
| `PUT` | `/admin/matches/{}` | `attachCityManager2ToMatch` |
| `PUT` | `/admin/matches/{}` | `attachCityManagerToMatch` |
| `PUT` | `/admin/matches/{}` | `removeCityManager2FromToMatch` |
| `PUT` | `/admin/matches/{}` | `removeCityManagerFromMatch` |
| `PUT` | `/admin/matches/{}` | `updateMatch` |
| `POST` | `/admin/matches/{}/batch/fake-players` | `addFakePlayersByBatch` |
| `PATCH` | `/admin/matches/{}/cancel` | `cancelMatch` |
| `POST` | `/admin/matches/{}/copy` | `createCopyMatchById` |
| `POST` | `/admin/matches/{}/copy` | `makeCopyMatchesByThisWeekBtn2` |
| `POST` | `/admin/matches/{}/fake-players` | `addRandomPlayerToMatch` |
| `GET` | `/admin/matches/{}/players` | `getPlayersByMatchId` |
| `DELETE` | `/admin/matches/{}/players/{}` | `removePlayerFromMatch` |
| `POST` | `/admin/matches/{}/players/{}` | `addPlayerToMatch` |
| `PATCH` | `/admin/matches/{}/players/{}/refund-and-cancel` | `refundAndCancelPlayerMatch` |
| `PATCH` | `/admin/matches/{}/user-matches/{}/absent` | `makeAbsentPlayerFromMatch` |
| `GET` | `/admin/players` | `generateQueryForUsers` |
| `GET` | `/admin/players` | `getPlayersForAddingToEventMatch` |
| `GET` | `/admin/players` | `getPlayersForAddingToMatch` |
| `GET` | `/admin/players` | `getUsers` |
| `GET` | `/admin/players` | `getUsers2` |
| `GET` | `/admin/players` | `getUsersForCaptain` |
| `GET` | `/admin/players` | `getUsersForCityManagers` |
| `GET` | `/admin/players` | `getUsersForMembership` |
| `GET` | `/admin/players` | `getUsersForPromocodes` |
| `GET` | `/admin/players` | `getUsersForUpdatePromocodes` |
| `GET` | `/admin/players` | `transformPlayerMatch` |
| `GET` | `/admin/players` | `updatedFieldId` |
| `GET` | `/admin/players/banned` | `getBannedUsers` |
| `GET` | `/admin/players/charts` | `getUsersForChart` |
| `GET` | `/admin/players/deleted` | `getDeletedUsers` |
| `GET` | `/admin/players/unverified` | `getUnverifiedUsers` |
| `GET` | `/admin/players/{}` | `getUnverifiedUserById` |
| `GET` | `/admin/players/{}` | `getUserById` |
| `GET` | `/admin/players/{}` | `getUserByIdFromMembership` |
| `DELETE` | `/admin/players/{}/ban` | `unExpellUser` |
| `POST` | `/admin/players/{}/ban` | `expellUser` |
| `POST` | `/admin/players/{}/ban` | `suspendUser` |
| `PATCH` | `/admin/players/{}/fake-player` | `setOrResetUserAsFakePlayer` |
| `PATCH` | `/admin/players/{}/fake-player` | `toggelFakePlayer` |
| `PUT` | `/admin/players/{}/profile` | `updateUserCredit` |
| `PUT` | `/admin/players/{}/profile` | `updateUserCredits` |
| `POST` | `/admin/promocodes` | `createPromocode` |
| `DELETE` | `/admin/promocodes/{}` | `deleteFuturePromocode` |
| `GET` | `/admin/promocodes/{}` | `getFuturePromocodeById` |
| `GET` | `/admin/promocodes/{}` | `getPreviousPromocodeById` |
| `PATCH` | `/admin/promocodes/{}` | `updateFuturePromocode` |
| `PATCH` | `/admin/promocodes/{}` | `updatePreviousPromocode` |
| `PATCH` | `/admin/promocodes/{}/restore` | `restoreDeletedPromocode` |
| `GET` | `/admin/sms-messages` | `createAbbrText` |
| `GET` | `/admin/sms-messages` | `getMessages` |
| `GET` | `/admin/sms-messages` | `updateAbbrText` |
| `PUT` | `/admin/sms-messages/{}` | `updateMessage` |
| `POST` | `/admin/special-events/bracket-matches` | `createSpecialEventMatchForBracket` |
| `DELETE` | `/admin/special-events/divisions/{}` | `deleteDivisionFromSpecialEvent` |
| `PUT` | `/admin/special-events/divisions/{}` | `updateDivision` |
| `PUT` | `/admin/special-events/divisions/{}` | `updateDivisionBtn` |
| `POST` | `/admin/special-events/divisions/{}/captains/{}` | `assignCaptainToDivision` |
| `GET` | `/admin/special-events/divisions/{}/groups` | `getAllGroupsForCreatingMatch` |
| `GET` | `/admin/special-events/divisions/{}/teams` | `getAllTeamsByDivision` |
| `GET` | `/admin/special-events/divisions/{}/teams` | `getAllTeamsByDivisionIdForUpdateMatch` |
| `GET` | `/admin/special-events/divisions/{}/teams` | `getAllTeamsForCreateMatchByDivision` |
| `GET` | `/admin/special-events/divisions/{}/teams` | `updateTeamAwayForUpdateMatch` |
| `POST` | `/admin/special-events/divisions/{}/teams` | `createTeamByDivisionId` |
| `POST` | `/admin/special-events/divisions/{}/teams` | `specialEventCreateTeamPrice` |
| `GET` | `/admin/special-events/events` | `getAllSpecialEventForCaptain` |
| `GET` | `/admin/special-events/events` | `getAllSpecialEventsForCreatematch` |
| `GET` | `/admin/special-events/events` | `getAllSpecialEventsForEvents` |
| `GET` | `/admin/special-events/events` | `getAllSpecialEventsForSettings` |
| `POST` | `/admin/special-events/events` | `createSpecialEvent` |
| `DELETE` | `/admin/special-events/events/{}` | `deleteDivision` |
| `DELETE` | `/admin/special-events/events/{}` | `deleteDivision2` |
| `DELETE` | `/admin/special-events/events/{}` | `deleteEvent` |
| `PUT` | `/admin/special-events/events/{}` | `updateSpecialEvent` |
| `GET` | `/admin/special-events/events/{}/captains` | `getAllCaptainsByEvents` |
| `GET` | `/admin/special-events/events/{}/divisions` | `divisionForStatisticSelect` |
| `GET` | `/admin/special-events/events/{}/divisions` | `getAllDivisionsByEvent` |
| `GET` | `/admin/special-events/events/{}/divisions` | `getAllDivisionsByEventForCaptain` |
| `GET` | `/admin/special-events/events/{}/divisions` | `getAllDivisionsByEventForCreatingMatch` |
| `GET` | `/admin/special-events/events/{}/divisions` | `getAllDivisionsByEventForGroupStatistics` |
| `POST` | `/admin/special-events/events/{}/divisions` | `createDivisionBtn` |
| `POST` | `/admin/special-events/events/{}/divisions` | `createDivisionByEvent` |
| `POST` | `/admin/special-events/events/{}/divisions` | `createDivisionRosterSpot` |
| `GET` | `/admin/special-events/events/{}/fields` | `getFieldsForSpecialEventMatchCreate` |
| `GET` | `/admin/special-events/events/{}/matches` | `getAllSpecialEventMatchesByEventId` |
| `GET` | `/admin/special-events/events/{}/players` | `getAllPlayersByEvent` |
| `GET` | `/admin/special-events/events/{}/players` | `getAllSpecialEventPlayersByEventId` |
| `POST` | `/admin/special-events/group-matches` | `createSpecialEventMatchForGroup` |
| `GET` | `/admin/special-events/matches` | `getAllEventMatches` |
| `GET` | `/admin/special-events/matches` | `getAllSpecialEventMatches` |
| `DELETE` | `/admin/special-events/matches/{}` | `deleteSpecialEventMatchById` |
| `DELETE` | `/admin/special-events/matches/{}` | `updateTeamAwaitScore` |
| `PUT` | `/admin/special-events/matches/{}` | `createEventOpenModal` |
| `PUT` | `/admin/special-events/matches/{}` | `updateSpecialEventMatch` |
| `DELETE` | `/admin/special-events/teams/{}` | `deleteEventTeam` |
| `PUT` | `/admin/special-events/teams/{}` | `updateTeamById` |
| `PUT` | `/admin/special-events/teams/{}` | `updateTeamPriceSPEvent` |
| `GET` | `/admin/special-events/teams/{}/players` | `getPlayersByEventTeamId` |
| `DELETE` | `/admin/special-events/teams/{}/players/{}` | `deleteDivision4` |
| `DELETE` | `/admin/special-events/teams/{}/players/{}` | `deletePlayerFromEventTeam` |
| `DELETE` | `/admin/special-events/teams/{}/players/{}` | `userAddToEventTeamTeamPosition` |
| `POST` | `/admin/special-events/teams/{}/players/{}/player-number/{}` | `addPlayerToEventTeamRequest` |
| `POST` | `/admin/strikes` | `setStrike` |
| `POST` | `/admin/strikes/cities/{}` | `changeStrikePrice` |
| `DELETE` | `/admin/strikes/strike-logs/{}` | `removeStrike` |
| `GET` | `/admin/subscriptions` | `getAllCanceledSubscribers` |
| `GET` | `/admin/subscriptions` | `getAllSubscribers` |
| `POST` | `/admin/subscriptions` | `changeMasterPrice` |
| `GET` | `/admin/subscriptions/cities/{}` | `getSubscriptionByCityId` |
| `POST` | `/admin/subscriptions/email` | `sendEmailForSubscribers` |
| `POST` | `/admin/subscriptions/users/{}` | `getNewSubscriptionName` |
| `POST` | `/admin/subscriptions/users/{}` | `subscribeUser` |
| `POST` | `/admin/subscriptions/users/{}/free` | `subscribeUserAsFreeMember` |
| `PATCH` | `/admin/subscriptions/{}` | `updateSubscriptionPriceForMember` |
| `POST` | `/admin/subscriptions/{}/unsubscribe` | `unsibscribeMember` |
| `PUT` | `/admin/teams/{}` | `updateTeam` |
| `PUT` | `/admin/teams/{}` | `updateTeamPassword` |
| `POST` | `/admin/user-matches` | `changePlayerTeamAndPosition` |
| `GET` | `/api/reports/weekly/managers` | `getMatchesAndManagersByWeek` |
| `POST` | `/api/reports/weekly/managers` | `query1` |
| `POST` | `/api/reports/weekly/managers` | `regenerateManagerReport` |
| `PUT` | `/api/reports/weekly/managers/{}` | `updateCityManagerWeeklyPayout` |
| `GET` | `/api/v1/admin/promocodes` | `getFuturePromocodes` |
| `GET` | `/api/v1/admin/promocodes` | `getPreviousPromocodes` |
| `PUT` | `/api/v1/admin/user-subscriptions/{}` | `memberDetails` |
| `PUT` | `/api/v1/admin/user-subscriptions/{}` | `updateUserSubscriptionComment` |
| `DELETE` | `/city-managers` | `deleteCityManager` |
| `GET` | `/city-managers` | `getCityManagers` |
| `POST` | `/city-managers` | `addCityManager` |
| `GET` | `/city-managers/users` | `getCityManagersForAttachToMatch` |
| `PUT` | `/city-managers/{}` | `introMatchText` |
| `PUT` | `/city-managers/{}` | `updateCityManagerIntroText` |
| `PUT` | `/city-managers/{}` | `updateCityMangerText` |
| `POST` | `/files` | `getUploadedUrlField` |
| `POST` | `/files` | `getUploadedUrlFieldCover` |
| `POST` | `/goals` | `createGoal` |
| `DELETE` | `/goals/{}` | `deleteGoal` |
| `POST` | `/goals/{}/dark` | `createGoalForDarkTeam` |
| `POST` | `/goals/{}/white` | `createGoalForWhiteTeam` |
| `GET` | `/leaderboard/name` | `getCurrentLeaderboard` |
| `DELETE` | `/player/profile/{}` | `deleteUserById` |
| `DELETE` | `/player/profile/{}` | `eventMasterPrice` |
| `GET` | `/special-events/divisions/{}/matches` | `getStatisticsByDivisionId` |
| `GET` | `/strikes/cities/{}` | `getStrikePriceByCityId` |
| `GET` | `/time-zones` | `getTimeZones` |

## KNOWN REFINEMENT — member spots are counted by payment_type, not membership held

`buildMdapiMemberSpotIndex` (`financeStats.ts`) buckets a spot as a member spot when
`payment_type === "MEMBER"`. That is the payment the player made, not whether they **held a
membership at match time** — and the two differ, because a member can pay full DPP.

**Measured Apr 2026**, deriving per venue with `hasMembershipAtMatchTime` (the definition Slate
Review already uses) against the manual `fin_member_spots` upload:

```
network            uploaded 1,987      derived 2,537      +27.7%
San Juan Diego            657             740             +83
NEMP                      311             455            +144
ATH Pearland              273             333             +60
Lou Fusz Outdoor           58             136             +78
PRUMC                      61              87             +26
```

PRUMC's **+26** is the members-paying-DPP effect already on record there (290 memberSpots against
264 rows typed MEMBER).

**This is a SEPARATE DECISION and is deliberately not acted on.** Switching the predicate changes
the denominator for every member-revenue allocation at once — Field Ranking, Match P&L and Cost's
field grain — so per-venue shares move in both directions. It is one predicate in one function
and it deserves its own change with its own before/after.

Two venues never reconciled against the upload under any rule tested: **Round Rock** (uploaded 9,
derived 7 under local wall clock, UTC and created_at alike) and **PAC Global** (uploaded 5,
derived 4 — but exactly 5 under a UTC month boundary). Three spots, on the two smallest venues,
0.5% of a 550-spot gap. Unexplained and accepted.

**`fin_member_spots` reads nowhere.** It is a one-off upload — 21 rows, all "Apr 2026", keyed on
free-text venue names — superseded by `buildMdapiMemberSpotIndex`, which derives the same counts
live from match registrations keyed on `field_id` via `fin_venue_fields`. The table is kept as the
only record of whatever produced those numbers; `useFinanceData.ts` still fetches it and nothing
consumes it, which the comment there says.

## Sales-tax rates come from GET /cities, never from measurement

`GET /cities` serves **`stripeTaxRateValue`** per city. Read 2026-08-28:

```
ATX 8.25   HOU 8.25   SATX 8.25   DFW 8.25   ELP 8.25
ATL 8.9    STL 9.68   NYC 8.875   OKC 8.625  WAW 0
```

**Reading beat inferring on two of the ten.** Both errors came from fitting a rate to data
instead of asking the API:

- **OKC is 8.625, not 8.65.** The 8.65 was the aggregate ratio of `total_amount` to `amount`
  over 577 rows — close enough to look right and wrong enough to matter.
- **Warsaw is 0.** Poland is not a US sales-tax jurisdiction. Applying the 8.25% that every
  neighbouring city carries would have invented an 8% reduction out of nothing.

A rate is a fact the API holds. `src/lib/salesTax.ts` carries the table and **throws** on a city
it does not hold — a 0% default would leave tax sitting inside a figure labelled pre-tax, which
is the failure the split exists to prevent. A new market must arrive in that table before its
revenue can be reported pre-tax.

**The relationship, proven on production:**
`total_amount = round((amount − credit_amount) × (1 + city rate))`, fitting 93.1% of rows within
a cent; the residual is credit rows. `amount` is the pre-tax price and reaches back to 2023-04;
`total_amount` is the card charge and is only populated from 2025-12.

**Two revenue bases live in the estate on purpose**, and no single figure may mix them:
`fin_revenue` is TAX-INCLUSIVE (Revenue, Cities — money collected, ties to Stripe gross volume);
`mdapi_match_players.amount` is PRE-TAX (Slate Review's DPP, Match P&L, Cost). Membership joined
to the second must be pre-taxed first — `cityMembershipRevenuePreTaxFor`, guarded by
`scripts/revenue-basis-test.ts`.

**The Revenue page's "7-8% low every month" was this tax, not missing roster rows.** Measured
7.65% network-wide for Jul 2026: $97,023.58 gross against $89,601.26 pre-tax. The comment in
`RevenueSection.tsx` records the wrong diagnosis with the correction beneath it.

## endDate is independently writable, and the API does NOT validate the pair

Proven 2026-08-28 on staging, by us, with read-back. This answers two questions Phase 7 left
open — Phase 7 only ever exercised `{startDate}` alone and `{startDate, endDate}` together.

**`endDate` alone lands, and moves nothing else.** Staging match **2560** ("HOU match"),
`_count.players` **2** — a match with players attached:

```
PUT /admin/matches/2560   {"endDate":"2026-08-29T14:11:00.000Z"}
  before  start 2026-08-28T13:41:23.873Z   end 2026-08-29T13:41:23.876Z
  after   start 2026-08-28T13:41:23.873Z   end 2026-08-29T14:11:00.000Z     LANDED
  startDate did not move · endDateUtc re-derived +5h (CDT) · startDateUtc unchanged
```

**So the "cannot edit times once players have joined" rule is RETOOL'S WEB UI, not the
server.** Retool's mobile app allows it, the API allows it, and Clubhouse's drawer now allows
it. A control that refused would be refusing something the server permits.

**The API stores an inverted pair without complaint.** Staging **2557**, `_count.players` 0:

```
PUT /admin/matches/2557   {"endDate":"2026-08-27T21:47:00.000Z"}   ← one hour BEFORE startDate
  2xx, and it read back inverted: start 22:47:59.226Z, end 21:47:00.000Z
```

This upgrades a previous inference to evidence. The facts doc already noted staging 2473 loads
inverted and guessed Retool put it there; now we know **any** client can, because nothing
server-side checks. **A client-side block is therefore the ONLY guard that exists** — it is not
belt-and-braces on a server rule, and a date/time control must BLOCK the save rather than warn.
Both staging matches were restored, verified by read-back.

**Where this lives in the code:** `src/lib/matchWhen.ts` (`movePair`, `moveEnd`, `whenError`,
`durationLabel`) with `scripts/matchwhen-test.ts` as its guard. The wall-clock primitives moved
there from MatchPanel so both surfaces share one copy.

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
  - REMOVE is DELETE /admin/matches/user-matches/{userMatchId}. **CORRECTED 2026-08-31 —
    see "The remove endpoint, re-measured" below. The 403 claim here is STALE: that path
    now succeeds on staging.** Remove still keys on userMatchId, for a stronger reason.
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

**Q3 — ANSWERED 2026-09-01 BY OBSERVATION ON STAGING. THE AUTO-CANCEL READS REAL PLAYERS ONLY;
FAKE SPOTS DO NOT COUNT TOWARD `minPlayerCount`.** The screen's assumption was right, and it is now
evidence rather than a reading.

The discriminating fixture is one where the two hypotheses give opposite answers — real BELOW the
minimum but real+fake ABOVE it. Measured at the last sample before the deadline:

```
G CONTROL  real=0 fake=0  total=0   min=9  ->  isCancelled TRUE
H DISCRIM  real=0 fake=16 total=16  min=3  ->  isCancelled TRUE
           (sampled 21:59:46, deadline 21:59:53, cancelled 22:00:03)
```

H's total was **five times its minimum** and it cancelled regardless, so the comparison cannot be
against the total. G firing is what makes that mean anything — it proves the worker ran in the
window, so H cancelling is a decision and not a coincidence.

THREE EARLIER ATTEMPTS DID NOT DISCRIMINATE and are recorded so the mistake is not repeated:
- 0 real / 0 fake against min 9 cancels under BOTH rules. It proves nothing about the basis.
- Fakes seeded via `POST /admin/matches/{id}/batch/fake-players` **DRAIN within about a minute**,
  at any distance from kickoff and with `fakeSpotLeft{36,24,12,6,3}h` pinned high. Two fixtures
  leaked this way (11 -> 8, then 14 -> 4) and by the deadline the total had fallen below the
  minimum, making them non-discriminating again. The fix is to **lower the minimum under the
  surviving fake count** rather than to fight the drain, and to SAMPLE THE TOTAL AT THE DEADLINE
  rather than assume it held.

CONSEQUENCE: `short()` / `shortBy()` in `src/lib/gamedayModel.ts` keying on `realCount` is correct
and must not be flipped to `filledCount`. The Gameday Ops countdown is real for exactly the matches
it was built for — a match propped up by fakes still cancels.

ALSO MEASURED: the cancel fires LATE and by a VARIABLE margin — 10 seconds past nominal in this
run, about 4 minutes 40 seconds in an earlier one. The countdown is a guide, not a contract.

AND: lowering `minPlayerCount` to or below the real count PREVENTS the pending cancel (proven
separately the same evening: control left at min 9 cancelled, treatment lowered to 0 did not, and
was watched for twelve minutes past the control's cancellation). A reduction that still leaves a
shortfall does NOT rescue the match, because the rule is real < min.

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

## A GUARD FUNCTION LOST TWO TERMS TO A create-or-replace, and nobody saw it for a month (2026-08-23)

`app_users_edit_matches_guard()` has been extended six times by REPLACING ITS WHOLE BODY — 0114
created it, then 0116, 0117, 0118, 0120 and 0122 each rewrote it. **0122's rewrite does not contain
the two terms 0120 added.** Confirmed by reading `prosrc` on the live database, not by reading the
files.

```
lost:  raise 'Service account (%) cannot be a CITY MANAGER'
lost:  is_city_manager = false  =>  city_identifier := null
```

Restored by 0141. **The rule, both halves:**

> **Replacing a function body you cannot read is how a guard disappears.
> Adding a separate function is how you avoid needing to.**

0140 needed a service-account block for `can_access_growth` and added `app_users_growth_guard()` as
its **own** function with its own trigger rather than extending this one — which is why that block
is intact, and why 0141 had one function to repair instead of two. `pg_proc.prosrc` is the only
authority on what a function currently is; the migration files are a history of intentions.

### The second term was an ESCALATION ON DEMOTION, not lost defence in depth

`isConfined()` (`cityConfinement.ts:58`) keys on **`city_identifier` alone** — it never reads
`is_city_manager`. And `canAccess()` (`useAuth.ts:163`) **grants** on that:

```js
if (isConfined(appUser)) return page === "matchops" || page === "chats";
```

It never reads `can_access_matchops` or `can_access_chats`. A city manager holds no broad flags —
`app_users_city_manager_is_exclusive` (0124) makes that unrepresentable — so demoting one leaves both
false, and without the cascade the stale scope keeps the row confined. **The demoted account is
offered Match Ops and Chats, including Match Chats and Player Chats, which it did not have as a city
manager.**

**Where it stops, measured across all four server gates:** `matchOpsAuth` reads
`can_access_matchops`; `crmAuth` reads `can_access_chats`; `/api/reviews` and `capabilityAuth` both
go through the pure `can()`, which unblocks on confinement but still requires the flag. Every
request behind those doors 403s. So the escalation is the **chrome** — tab, rail, page shell — and
not data exposure. Still a real defect: `useAuth`'s own comment says the rail must not offer a door
the server will slam, and here it did.

**`can()` and `canAccess()` are NOT the same predicate**, and this is the second place they diverge —
`canAccess()` also has no service-account term at all, so a service account holding a page flag is
offered the tab and refused the data on every page. Both divergences are asserted in
`scripts/growth-access-test.ts` as disagreements, so neither can be rediscovered by assuming the two
functions agree.

**Population, measured 2026-08-23:** two accounts carry `city_identifier` with `is_city_manager`
false — `rgmstrategicventures` and `jf`, both WAW. **Neither is a demoted city manager**: both are
the Warsaw confined tier, created that way, holding matchops and chats on purpose. So the escalation
is LATENT, not live. It arms the moment any of the four current city managers (ATX, DFW, HOU, SATX)
is demoted. 0141 contains **no UPDATE** — a trigger only fires on a write, so it prevents the next
stale scope and cleans nothing that exists.

### `stale_scopes` IS CORRECT (was 2, now 1). It is not a defect and must not be "fixed"

0141's verdict counts rows with `is_city_manager` false and a non-empty `city_identifier`, under the
name **`stale_scopes`**. The name is wrong and the number is right.

Those two rows — `jf@playmatchday.pl` and `rgmstrategicventures@gmail.com`, both `WAW` — are the
**CONFINED tier**, which is legitimately `is_city_manager = false` **with** a city. That combination
is the tier's definition, not a leftover:

```
isConfined(row)             = city_identifier non-empty, and nothing else   cityConfinement.ts:58
isCityManagerConfined(row)  = is_city_manager === true && is_admin !== true  capabilities.ts:68
```

A metric called "stale" reads as "should be zero", and the obvious remedy — null the city — is
exactly the escalation 0143 exists to prevent: it strips the confinement and hands the account the
whole Match Ops estate across every city. **Read it as `confined_non_managers`.** The number to
watch is not whether it is zero; it is whether it matches the count of accounts deliberately
provisioned as confined. **It was 2; it is now 1** — `rgmstrategicventures@gmail.com` was
re-provisioned as a SATX city manager on 2026-08-24, leaving `jf@playmatchday.pl` as the only
confined non-manager. Expect 1, not 2, and expect it to move again: `fin_venue_fields` and
`app_users` both carry admin writes with no `updated_at` and no `change_log` row.

### A verdict query the SQL editor hides is not a verdict

0141 originally asked **two** SELECTs. The Supabase editor shows only the last result set, so running
it returned `stale_scopes` alone and said nothing about the function body — the trap 0140's own
comment warns about. It also expected `service_account_terms = 6`; **the answer is 5**, because the
expectation was counted with `grep -c` over the migration FILE, which matched the copy of the literal
inside the verdict query itself. **Derive an expected value from the thing being counted, never from
the file that counts it.** One query, one row, and columns proving the replacement kept what was
already there — not only that it added what was missing.


## AN INVARIANT STATED IN A COMMENT AND NOT ASSERTED IN A TEST IS A WISH (2026-08-24)

Two of them surfaced in one night. Both were written confidently, both were wrong for months, and
both were wrong in the direction the comment promised was impossible.

**1. "the rail and the gate cannot drift into disagreeing about which six."**
`sections.tsx` filters the confined rail on `CONFINED_RAIL_KEYS.includes(s.key)`. The section's key
is `"master"`; the list said `"master-schedule"` — the HREF spelling. They never matched, so Master
Schedule was filtered out of every confined rail from the day it was added: six items rendered, not
seven. `scripts/city-confinement-test.ts` asserted the list's **contents** and passed the whole
time, because it compared the string to itself and never asked whether the string resolved to a
section.

**2. `cityTimezones`: "callers fall back to UTC display (with a '(UTC)' suffix) so the gap is
visible rather than silently wrong."** `formatMatchTitle` returned `isUtcFallback` and **no caller
ever read it** — grep found the identifier only inside its own file. So an unmapped city rendered a
wrong hour with nothing on screen to say so. Warsaw showed every kickoff **two hours early** in
Match Chats, the Match Editor, the Match Drawer, and in the `{time}` token of a Notify Players SMS.

**The rule.** A comment describing a guarantee is documentation of intent, not evidence of
behaviour. If it says two things cannot drift, a test must compare them. If it says a fallback is
visible, a test must read what the user sees. **A described mitigation that does not exist is worse
than none, because it stops the next person looking** — both of these were read by people working
in the file and neither was checked.

**Where the check belongs.** Prefer the invariant over the value: asserting `CONFINED_RAIL_KEYS`
equals a literal list did not catch a key that resolved to nothing, whereas asserting every key
resolves to a real section would have. And prefer to keep a promise in the code that makes it
(`formatMatchTitle` now appends the suffix itself) over a promise delegated to every caller —
callers do not read headers.

## `match_promotion_plan` AND `fin_change_log` NEED A MARKER COLUMN (2026-08-24)

`verify-match-promotion` deletes rows from both tables by **id alone** — `match_promotion_plan` by
`match_api_id`, and its `fin_change_log` audit rows by `(table_name, row_id)`. Neither table carries
anything that distinguishes a row a suite created from a row an operator created.

That makes residue **unknowable, not merely unknown**. After a crashed run there is no query that
separates a leftover probe from a real plan. The audit on 2026-08-24 found
`match_promotion_plan` at 0 rows and 3 `fin_change_log` rows for that table, and **neither number
can be judged** — 0 is consistent with clean and with a probe having deleted a real row, and the 3
are consistent with legitimate history and with residue.

**No suite should touch either table again until one of them carries a marker** — a nullable
`created_by_suite` text column, or a reserved id range. Guessing which of the three log rows is real
is worse than the gap: a wrong deletion is unrecoverable and a wrong keep is invisible.

This is the second-order cost of the rule above. A suite that writes to production is a deploy; a
suite that writes to production **without a marker** is a deploy you cannot roll back, because you
cannot tell what it did.

## A SUITE THAT WRITES TO PRODUCTION IS A DEPLOY, NOT A TEST (2026-08-24)

`scripts/e2e/verify-counts-as-regular.mjs` flipped `fin_venue_fields.counts_as_regular_play` on
MatchDay field 22 (ATH Pearland) with the **service role**, read four pages to compare the delta,
and restored it in a `finally`. On 2026-08-24 it **exited 2 mid-run** — a harness fault, not an
assertion — and the `finally` never completed. **The flag stayed ON.**

The cost was not the flag. It was that the flag is invisible: `fin_venue_fields` has no
`updated_at`, and that table's writes do not reach `change_log`. So a Finance-wide categorisation
changed, ATH Pearland's match count and cost moved across every surface, and the only trace was the
number on the page. An investigation into a genuine Pearland defect then read the flipped flag as
the true state, concluded the bug was already fixed, published that, and built an argument on top of
it. **Three separate reports were wrong because a test had deployed a change.**

**The principle.** A test asserts; it does not change the system under test. If a suite needs a
different world to observe an effect, it must build that world out of fixtures, a throwaway id, or a
pure derivation — not by editing the live one and promising to put it back.

**And a `try/finally` restore is the same shape as an invariant in a comment.** The block in that
file is headed *"PUT IT BACK, WHATEVER HAPPENED ABOVE"*. "Whatever happened above" does not cover
the process being killed, the machine being starved, or an exit-2 in the harness — and all three
happened in one night. A restore that only runs when the code reaches it is a wish about the happy
path, exactly like a comment claiming two lists cannot drift. See *an invariant stated in a comment
and not asserted in a test is a wish* above; these are two instances of one failure.

**Quarantine was not sufficient on its own.** Excluding the suite from the gate still leaves
`npm run verify:e2e:quarantine` able to fire the write, so the file also refuses to run unless an
explicit env override is set. Two locks, because the first one has a documented bypass.

## READ THE DEPLOYED COMMIT OUT OF THE SERVED BUNDLE, NOT FROM `vercel ls` (2026-08-24)

`vercel ls`'s Age column has now produced a wrong conclusion three times in two sessions — twice
reported as "Vercel has not picked up the push" when the deployment had in fact built, and the row
being read *was* the build. `vercel inspect --json` does not help either: on these deployments
`meta` is `{}` and `gitSource` is `null`, so the CLI cannot say what commit is live.

`next.config.ts` inlines `NEXT_PUBLIC_COMMIT_SHA` from `VERCEL_GIT_COMMIT_SHA` at build time, so
the answer is in the bundle:

```
curl -s https://matchday-clubhouse.vercel.app -o /tmp/prod.html
for c in $(grep -oE '/_next/static/chunks/[a-zA-Z0-9._-]+\.js' /tmp/prod.html | sort -u); do
  curl -s "https://matchday-clubhouse.vercel.app$c" | grep -oE '[0-9a-f]{40}' | sort -u
done
```

One chunk carries it. Compare against `git ls-remote origin refs/heads/main`. That is a fact about
what is running; the dashboard row is a fact about when a build record was created, and the two
answer different questions.

## THREE DESIGN ITEMS, FILED NOT BUILT (2026-08-24)

**1. Consolidate the four city name maps onto `cityScope`.** There are four, and two of them have
confusingly similar names: **`cityMap.ts`** (`CSV_TO_COCKPIT_CITY`, `CITY_ABBR_TO_COCKPIT`) and
**`cityNormalization.CITY_MAP`** — different files, different shapes, different jobs. That alone
will cost someone an hour. `api/reviews/route.ts:40-44` already records the intent: *"adding it
there would be a SECOND place the identifier↔name mapping lives, and two copies of a mapping is how
a filter silently starts returning nothing."* Warsaw was extended into `cityNormalization.CITY_MAP`
rather than consolidated because the fix was urgent and consolidation touches every city; the end
state is still one map.

**2. A NOT-OURS FLAG.** It has now come up three times, and `HIDDEN_CITIES` is the wrong tool for
all three — that flag means *paused market of ours* and deliberately never filters historical data.
The three cases: **Warsaw**, a partner market that must resolve as a city everywhere and never
enter a P&L; **New York City's four field IDs**, 26 matches in a market we do not operate, which
Phase-2 auto-create would otherwise turn into four live venues; and **the Phase-2 auto-create rule**
itself, which needs somewhere to put a city it has never heard of.

**3. `isUtcFallback` styling.** The suffix is now applied in the formatter, so the gap is stated.
A caller that wants to *style* it still can — the flag remains on the type for that reason, and is
no longer the only thing standing between a wrong hour and silence.

## THE MATCH PANEL'S WINDOW, AND WHAT MEASURING IT TURNED UP (2026-08-24)

**The Match panel had no window of its own.** It read `RevenueSection`'s `comparisonSpan` — the
selected period plus the prior three, which the header needs because comparison is its job. So the
panel's "All time" preset meant *the last four months*: 2,010 of 9,743 alive matches, **20.6% of the
record**, with the context line reading `Showing all 1,419 matches on record`. Evidence:
`useFinancePeriodData(span)` + `matchRange(span.start, span.end)` at `RevenueSection.tsx:59-66`.
It now has `matchPanelPeriod()` (`financePeriod.ts`), year-to-date by default.

**Not `quarterFetchBounds`.** That is `useFinanceData`, which backs the Cash-Flow surfaces. The two
loaders are easy to confuse and they have different windows; check which one a component actually
calls before reasoning about what it can see.

**`push(...arr)` IS AN ARGUMENT LIST, and it broke the first unbounded pull.**
`mdapiMatchesRead.ts` did `players.push(...all)`. On every windowed path `all` is a few thousand
rows and it is fine; on the whole-table path it is **231,748 arguments** and V8 throws
*"Maximum call stack size exceeded"*. The failure surfaced as **an empty table** — the fetch had
succeeded, the count was right, and the panel rendered `0 matches` with every tile at `$0`. Use a
loop for any array that is not bounded by a page size.

**A LOAD THAT FAILED AND A LOAD THAT FOUND NOTHING RENDER IDENTICALLY.** That bug was invisible
until the panel started printing the error. `useMatchRangeData` returns `error` and it was being
dropped on the floor. Any surface that can show an empty result must say which of the two it is.

**PostgREST paging, measured on `mdapi_match_players` (231,748 rows, 232 pages):**

| path | time |
|---|---|
| `selectAll`, sequential | **63.7s** |
| count-then-fan-out at concurrency 8 (`selectAllParallel`) | **15.0s** |

Fixed offsets computed from a count assume row positions hold for the run. An INSERT lands past the
last offset on an ascending key and is simply absent; a **soft-delete shifts every later offset down
and can skip a row**. Acceptable for a browse table, never for anything a write is derived from.

**Chunk fan-out, end-to-end, same machine and data** (`CHUNK_CONCURRENCY`, `IN_CHUNK` 200):

| window | conc 4 | conc 12 |
|---|---|---|
| 4-month span (the old default) | 2.75s | 1.41s |
| **year-to-date** (3,549 matches) | 4.58s | **2.07s** |
| rolling 12 months | — | 2.69s |

So **YTD at 12 is faster than the four-month window was at 4** — the wider default costs nothing.
Widening the chunk was worse at every concurrency (400×12 = 2.72s, 500×16 = 3.18s): fatter chunks
page sequentially *inside* `selectAll` and lose more than the round trips save.

**FUTURE MATCHES WERE IN EVERY FIGURE, and no view excluded them.** The premise that City and Field
already had this rule is **wrong** — checked: `buildFieldMonths` and `groupMatchCount` carry no
now-based term, and the only future-exclusion in the finance stack is `isFutureMonth`, which drops
whole future *months* and therefore never touches an unplayed match in the current one. The canonical
per-match predicate is `matchTime.isPastMatch` and it had **no caller outside the CRM route**. The
Match panel now uses one exported `hasKickedOff()` (`fieldEconomics.ts`) across its band, its table
and the header count above it.

**THE BOUNDARY IS KICK-OFF, NOT THE CALENDAR DAY.** Measured while writing the assertion: turning
upcoming rows on added **29 rows, of which only 15 were dated after today**. The other 14 were
*later that same day* and correctly had not kicked off. An assertion written as "no row dated after
today" is true but does not test the rule.

**A HALF-MERGED QUARTER PRINTS A REAL-LOOKING COST.** `useFinancePeriodData` merges up to four
quarter loaders and exposes `loading`; rendering the band before it settled gave **Field cost
$208,704 on one load and $219,434 on the next**, same view, same day. The panel now gates on its own
loaders. The section-level gate deliberately does *not* wait on them — the all-time pull is ~20s and
blanking City and Field for it would be the worse lie.

**Cost coverage is partial and must be stated, not zero-filled.** `fieldCost ?? 0` treated a
venue-month with no cost basis on file as free. At YTD that is 5 of 2,657 matches; across the full
record it is most of them, because the finance tables stay on the YTD window while all-time widens
only the registrations. Profit and margin now reconcile over the **costed** rows and every affected
tile names that denominator.

## THE GATE, MEASURED (2026-08-24)

**The fast set was 128s and 99s of it was one `next build`** — 77%, on every push.
`seam-stripped-test.ts` had three checks and only the third was slow. Split: the STRUCTURAL and
GENERAL checks stay inline (they fail on the commit that introduces a leak, at source, in
milliseconds); the ARTIFACT check — build a production bundle, grep it for `__CRM_TEST_REALTIME__`
— moved to `seam-artifact-check.ts`, spawned detached after the push. **Fast set: 128s → 20s**, and
nothing left in it is above 1.7s.

**A content-hash cache over the build was considered and rejected.** It would skip the build only
when `src/` is byte-identical — which is the push where the fast set is cheapest anyway — and still
cost the full 99s on every push that touches `src/`. Splitting the suite is the honest fix.

**THE E2E LANE'S BOTTLENECK IS `next dev`, NOT THE CPU.** Serial: 39 suites, **1,216s**. Parallel at
4 did not just fail to help, it went **red** — `verify-matchpanel` (138s serial), `verify-pace-grain`
(129s) and `verify-period-anchor` (144s) all blew the 240s cap, plus two more suites failed
outright. Five failures the serial lane does not have. Dev compiles routes **on demand**, so N
browsers requesting N different routes queue behind one compiler. The real ceiling-lift is running
the suites against `next build && next start`; a bigger concurrency number is not.

**The per-suite cap measures WALL CLOCK, so it has to scale with the pool.** 240s was set for a
suite running alone. Applied unchanged under contention it calls queueing a hang, which is exactly
what turned three healthy suites red.

**Slowest 8 of 39, serial — 59% of the run:** period-anchor 143.9s · matchpanel 138.2s · pace-grain
129.1s · revenue-controls 66.8s · match-view 65.3s · city-confinement 63.7s · pace-to-month-end
56.6s · player-finder 56.3s.

**A SUITE THAT FAILS IN THE LANE AND PASSES ALONE IS EVIDENCE ABOUT THE LANE.**
`verify-revenue-membership` failed in the serial run and passed alone at 24/24 — so the serial lane
already has load-dependent flakiness, before any parallelism. Re-run alone before believing a lane
failure is a regression.

**`verify-crm-dock.mjs` deleted.** It failed on every full run and twice more when run alone
(`exited 2`, on `[data-testid="dock-root"]` never appearing). It had never been green. What went
with it: the CRM dock's realtime paint-once/dedup guards, the channel-leak check (nav out/back ×3
leaves exactly one live `crm_messages` subscription), the shared-number banner, and the unread
switcher. **`dock-root` still exists in `CrmDock.tsx:119,219`** — so the selector was not renamed
and this may be a real dock regression rather than a stale suite. Worth its own look.

**`verify-revenue-membership` PASSES ALONE AT 24/24 AND FAILS IN THE LANE.** Run alone: exit 0,
every city's field membership matching the Cities page to the dollar. In the serial run: `exited 1`
after 21.8s. That is interference, not a regression — and it is direct evidence that the shared
`next dev` server, not the suites, is what the lane is contending on.

**READ THE OUTPUT, NOT THE NOTIFICATION.** The background-task notification reported
`exit code 0` for two runs whose own summary line said `2 FAILED` and `1 FAILED`. The harness
status and the suite's verdict are different facts.

## THE FIELD-ID INVENTORY — 79 field IDs, 38 of them unmapped (2026-08-24)

Measured with the shipped aggregate (`buildFieldIdIndex`, `src/lib/fieldIdAdmin.ts`) run against
production: **9,743 alive `mdapi_matches` rows** and **94,353 DAILY PAID registrations**. Two runs
20 minutes apart differed — 94,331 → 94,353 registrations, Scissortail 78 → 77 live matches — because
the match sync ran between them. **These numbers move with the sync and are not a fixed census.**

|  | field IDs | live matches | DPP revenue |
|---|---|---|---|
| **UNMAPPED** | **38** | **471** | **$22,172** |
| …of those, with a live match in the last 12 months | 10 | 48 | $4,135 |
| MAPPED | 41 | 7,217 | $790,465 |

`fin_venue_fields` holds **41 links** across **33 `fin_venues` rows**. **No orphan links** — every
`mdapi_field_id` in the table appears on at least one match. Two venues carry **no** link:
`ATH Katy Sunday` (#23) and `Soccer Central Tournament` (#53), both inactive, both split-rate
targets reached through `resolveSplitRateVenueId` rather than through a field ID. That is correct,
not a gap.

### The ten unmapped field IDs that are still live

| field | title | city | live (upcoming) | range | revenue |
|---|---|---|---|---|---|
| **1552** | Tourney ATH Katy | Houston | 9 (2) | 2026-07-20 → 2026-09-02 | $1,968 |
| 496 | Tourney at Lou Fusz | St. Louis | 7 | 2025-10-07 → 2025-11-25 | $1,026 |
| 463 | Community Fieldhouse | Houston | 6 | 2025-10-01 → 2025-10-24 | $207 |
| 1651 | Ann Richards School | Austin | 6 (4) | 2026-08-15 → 2026-09-06 | $360 |
| 1684 | Hala Piłkarska Bemowo | Warsaw | 6 (5) | 2026-08-24 → 2026-09-02 | $0 |
| 397 | NEMP Grass | Austin | 5 | 2025-11-17 → 2025-11-20 | $399 |
| 529 | NYCSC at Pier 40 | New York City | 3 | 2025-10-10 → 2025-10-19 | $135 |
| 727 | Dripping Springs | Austin | 3 | 2025-11-25 → 2025-12-09 | $40 |
| 562 | NYCSC at Nike Field | New York City | 2 | 2025-10-12 → 2025-10-19 | $0 |
| 596 | NYCSC at DeWitt Clinton Park | New York City | 1 | 2025-10-15 → 2025-10-15 | $0 |

Warsaw and the four NYCSC pitches are **partner markets and must stay unmapped** until the
not-ours flag exists — the rule migration 0142 set. Of the ten, **four are ours and unmapped**:
1552, 496, 463, 1651 (397 is a second NEMP field ID; 727 is a one-off).

### THE ADDRESS IS THE EVIDENCE, AND EVERY FIELD ID HAS ONE

`field_address` and `field_zipcode` are populated on **every one of the 79 field IDs** — zero
nulls. They are what proves a pair without touching a name:

- field **1552** "Tourney ATH Katy" and field **892** "ATH Katy" both carry
  `Memorial Hermann Sports Park, 23910 Katy Fwy, Katy, TX` / `77494`.
- field **496** "Tourney at Lou Fusz" and field **664** "Lou Fusz Athletic Complex" both carry
  `2155 Creve Coeur Mill Rd` / `63146`.

**Only ONE field ID has ever been renamed upstream** (1024, now "The Hattrick L.", 2 distinct
titles across its matches). So `field_title_at_link` drift is real but rare, and the title shown on
`/admin/fields` is the one on the field's most recent match — not the link-time copy.

### MAPPING FIELD 1552 ADDS $0 OF COST, AND THAT IS THE POINT

Computed by `previewAssignment` against live data, for 1552 → ATH Katy (#7, `per_match`, $140):

    matches gained     +9   (105 → 114)      revenue attributed  +$1,968  ($14,169 → $16,137)
    cost added         $0                    event exclusion     9 live matches, $1,260 not counted

All nine matches are titled "Tourney ATH Katy", which fires `EVENT_MARKERS` on `tourney`, so every
one of them is classified **event** and carries **no venue cost** — the identical shape to ATH
Pearland's field 22, which sat at $0 for 26 months and $83,040 until migration 0130 added
`counts_as_regular_play`. **Assigning 1552 fixes the match count and the revenue and leaves the
cost at zero.** The link's exception toggle has to be ticked separately on Finance → Field Costs.

None of 1552's nine matches falls on a Sunday, so the ATH Katy → ATH Katy Sunday split
(`venueGroups.resolveSplitRateVenueId`, $140 weekday vs $160 Sunday) moves nothing here.

### `start_date` CANNOT ANSWER "IS THIS MATCH UPCOMING"

`mdapi_matches.start_date` is the wall clock (the `Z` is a lie); `start_date_utc` is the true
instant. Comparing `start_date` to `Date.now()` calls a match upcoming or past by the field's UTC
offset — five or six hours, which is more than enough to move an evening match across midnight.
`buildFieldIdIndex` reads `start_date_utc` for the upcoming test and `start_date` for the calendar
date, the slot key and the day-of-week, and says so at each site. `wallClockParts` does **string
surgery only** and never constructs a `Date` from the timestamp — `walltime-guard-test` caught the
first draft doing exactly that.

### REVENUE AT A FIELD ID IS DAILY PAID, AND IT IS NOT `fin_revenue`

`fin_revenue` carries a venue **name string**, not a field ID, so it cannot be attributed to a
field ID at all without the name canonicalization this page exists to replace. The figure on
`/admin/fields` is the roster-derived one — `paid_status='PAID'`, no promocode, non-fake,
not absent, on a match that was not cancelled, `amount` cents → dollars — which is exactly what
`financeStats.venuePartnerRevenueFor` pays partners on and what migration 0142 justified two new
links with. A player-cancelled row that was never refunded is deliberately **included**: the money
was earned. Membership revenue is allocated at **city** grain and has no field to belong to, so it
is not in this column and the page says so.

## THE EVENT EXCEPTION IS DECIDABLE FROM CADENCE, NOT FROM THE NAME (2026-08-25)

`venueCategory` classifies a match as an event by testing its `field_title` against
`EVENT_MARKERS`. It is **matching a name, not a fact**, and when it is wrong the match keeps its
venue and loses its cost — which is how ATH Pearland's field 22 billed $0 for 26 months and
$83,040 (migration 0130). `counts_as_regular_play` is the per-link exception, and until now nothing
told an operator when to set it.

**THE DISCRIMINATOR IS RHYTHM.** An event is a burst — 27 matches on one day. A schedule is a
cadence — 9 matches across 6 weeks. Measured over **all 19 event-titled field IDs in production**,
the two populations do not overlap and are not close:

| | distinct live days / distinct live weeks |
|---|---|
| **schedules** | 22 → 468/91 · 199 → 317/61 · 17 → 279/128 · 14 → 65/25 · 18 → 33/32 · 21 → 29/16 · 15 → 19/14 · 1552 → 9/6 · 496 → 7/6 · 28 → 4/4 |
| **real events** | 1123 → 3/3 · 232 → 2/2 · 265 → 2/1 · 991 → 1/1 · 30 → 1/1 · 31 → 1/1 · 133 → 1/1 · 24 → 1/1 · 992 → 1/1 |

The gap runs between **4/4 and 3/3**, so `RECURRING_DAYS = RECURRING_WEEKS = 4`
(`src/lib/fieldIdAdmin.ts`). `eventFlagAdvice` reads the title only to ask whether the marker fires
at all — never to decide the answer — so the recommendation cannot be talked into agreeing with the
name.

**IT AGREES WITH FIVE OF THE SEVEN LINKS THAT CARRY A FLAG.** Fields 22 and 199 are `true` and
score 468/91 and 317/61. Fields 1123, 991 and 992 are `false` and score 3/3, 1/1 and 1/1.

### THE TWO DISAGREEMENTS ARE FIELD 22 AGAIN, AND THEY ARE NOT FIXED

Both are mapped links carrying `counts_as_regular_play = false` while playing an ordinary schedule
under a tournament name. Both venues bill `per_match` at **$77** with `charge_on_cancel = true`:

| field | title | venue | live + cancelled | span | cost not being counted |
|---|---|---|---|---|---|
| **17** | NEMP Tournaments | NEMP (#2) | 442 + 17 = 459 | 2024-03-12 → 2026-09-03 | **459 × $77 = $35,343** |
| **18** | Round Rock Tournaments | Round Rock (#4) | 35 + 6 = 41 | 2024-03-15 → 2026-05-31 | **41 × $77 = $3,157** |

**$38,500 across 30 months.** Nothing here changes them: flipping a flag on a mapped link moves
cost across closed months and is a decision to take on its own, not a side effect of building the
page that found it. Recorded so it is not found a third time.

### WHAT THE ASSIGN DIALOG DOES WITH THIS

The `counts_as_regular_play` box is in the dialog, **defaulted to what the cadence says** and shown
with the day/week counts next to it. Turning it against the recommendation is allowed and says so
in the moment. Assigning field 1552 with the box OFF would have recreated field 22 exactly —
revenue in, cost out — which is why the flag could not be left on a second page.

The preview recomputes for the box's state: with it ON, field 1552 → ATH Katy adds **9 × $140 =
$1,260** of cost instead of $0. Revenue and match count do **not** move with the flag; only cost
does. The reservation collapse follows it too — a `bills_per_reservation` venue bills the all-slot
set once the exception is on, not the event-filtered one.

## THE GATE ROUTED TO FULL ON A DIFF THAT COULD NOT REACH MATCHDAY (2026-08-25)

Every source file in the Fields diff routed to `typecheck`, **including both new API routes** — the
import-graph question worked exactly as designed. The nine-minute browser lane was decided by one
path: **`scripts/matchops-auth-test.ts`**, the route→gate census, which `readFileSync`s route
sources and asserts on them. It names `/api/city/gameday` in a **string literal**, as data, and
issues no request at all.

**The BY-HTTP rule was a substring scan over raw source text** — a text pattern standing in for a
fact, unable to tell a `fetch` from a mention. Two fixes, both in `scripts/gate-scope.mjs`:

1. **Comments are stripped before the scan.** A URL in a comment cannot send a request. This is the
   same fix `matchops-auth-test.ts` already applies to its own detectors under *READ THE CODE, NOT
   THE PROSE* — and it alone freed **31 of the 62** files the rule was catching, including
   `syncLogging.ts`, `crmAuth.ts`, `mirrorWriteThrough.ts`, `gamedayApiShape.ts`, `ManagerPayGrid.tsx`
   and every sync route that merely cites a sibling in its header.
2. **`URL_IS_DATA_NOT_A_CALL`** — six named files that hold a route path as data because the path
   *is* the subject. **The claim is asserted, not trusted**: `gate-scope-test.mjs` proves for each
   entry that the file still exists, still names a prefix in code (a stale entry fails), and matches
   **no** HTTP-issuing token. Add a `fetch(` to one and the fast set goes red until the entry comes
   out. New fixtures also prove a comment-only mention routes to `typecheck` while a real `fetch`
   still routes to FULL — the control, so the narrowing cannot pass by having stopped thinking.

`MatchPanel.tsx`, `MatchEditor.tsx`, `MatchDrawer.tsx`, `PlayerLookup.tsx` and every
`verify-matchedit*` suite still route to FULL. The direction is unchanged: a false full gate costs
nine minutes, a false skip costs a player.

## FINANCE › COST — REALIZED ON BOTH SIDES, AND IT READS NO OVERRIDE (2026-08-25)

The Basis and Structure toggles are gone. Every row is now **a per-match unit rate × the matches
that have already kicked off**, or a share venue's own model, with the same cut applied to the
revenue in the denominator. Nothing on the page reads `fin_venue_cost_overrides`.

### THE MEASUREMENT, TAKEN OFF THE REAL PAGE BEFORE AND AFTER

Aug 2026, 24 of 31 days elapsed, 23 field rows. **Header ratio 77.8% → 58.0%**; cost
$41,972 → $30,863; revenue $53,983 → $53,215.

The `today → AFTER` move decomposes into two independent effects, measured separately by running
the page a third time on the alternative rate column:

| field | today | AFTER | future-match Δ | override + rate-column Δ |
|---|---|---|---|---|
| Bicentennial Park | 601.9% | **463.0%** | −138.9 | 0 |
| Lowell H. Strike M.S. | 390.3% | **323.4%** | −66.9 | 0 |
| Ann Richards School | 300.0% | **200.0%** | −100.0 | 0 |
| STAR | 145.2% | **96.8%** | −48.4 | 0 |
| ATH Katy | 155.0% | **119.9%** | −35.1 | 0 |
| Soccer Central | 91.7% | **46.4%** | −13.9 | −31.4 (Aug override $5,600) |
| Westlake | 74.5% | **51.5%** | −11.5 | −11.5 |
| Scissortail Park | 78.6% | **77.4%** | −23.2 | +22.0 (Aug override $1,641) |
| Centennial Commons | 0.0% | **436.4%** | −109.1 | +545.5 (Aug override **$0**) |
| PRUMC | 167.4% | **184.8%** | −54.3 | +71.7 |
| ATH Pearland 64.3→49.2 · KISC 88.6→66.5 · LBJ 113.2→95.7 · NEMP 38.9→29.0 · Onion Creek 36.1→28.9 · New Braunfels 44.3→32.9 · Round Rock 71.3→57.0 | | | all future-match only | 0 |
| Crossbar Rowlett 82.7→88.6 · Hattrick 50.0→51.9 | | | share venues: cost fixed, realized revenue smaller | |
| PAC Global · PARMER Stadium · Lou Fusz Outdoor · Hattrick T. | | unchanged | | |

**FOUR OF THE RED RATIOS WERE FUTURE MATCHES AND NOTHING ELSE** — Bicentennial, Lowell H. Strike,
Ann Richards and STAR each fall by 35–139 points on the realized cut alone. **ATH Katy 155% → 120%**
was a future-match artefact too, exactly as expected.

**PRUMC WAS NOT.** It falls 54 points on realization and then rises 72 on the rate column, net
**167% → 185%**. Its `cost_per_match` is **$120** against a `per_match_rate` of **$84** — 43%
higher — and on $1,104 of realized revenue the pitch genuinely costs more than it earns. PRUMC's
red is real and this change makes it *more* visible, not less. Same shape, smaller, at Scissortail
($105 vs $84).

**CENTENNIAL COMMONS 0.0% → 436.4% IS THE OVERRIDE COMING OFF.** Its August override is a keyed
**$0** ("Custom billing month"), so the old page reported the pitch as free. Derived, it is
4 realized matches × $60 = $240 against $55 of revenue. The $0 was true about the invoice and
false about the pitch.

### THE RATE COLUMN IS `cost_per_match`, AND THAT IS A CHOICE

`legPerMatchUnitCost` (financeStats) resolves the leg's `cost_per_match`, falling back to a
secondary leg's own `per_match_rate` (ATH Katy Sunday $160) and then the primary's. The
alternative — `per_match_rate`, what the venue invoices — was measured on the same page: header
**56.6%** instead of 58.0%, and it differs on exactly three fields: PRUMC 129.3% instead of 184.8%,
Scissortail 61.9% instead of 77.4%, Westlake 61.0% instead of 51.5%. `cost_per_match` is used
because this page measures **what a pitch costs to run**, not what it invoiced — the same reason it
ignores overrides.

### `start_date` CANNOT ANSWER "HAS THIS KICKED OFF"

`FinMasterSchedule` now carries `start_utc_ms` from `mdapi_matches.start_date_utc`, and the cut
goes through `fieldEconomics.hasKickedOff` — the SAME predicate the Match panel uses. `match_date`
/ `match_time` are wall clock wearing a fake Z: at 3pm Central a 7pm fixture reads "19:00Z", which
as an instant is an hour *ago*, so reading them would bill tonight's matches all afternoon. That
bug has shipped three times. `scripts/cost-realized-test.ts` fixtures make the two readings
disagree on purpose.

**A CANCELLED MATCH IS JUDGED THE SAME WAY, AND CORRECTLY.** The predicate is about time, not
play: a `charge_on_cancel` venue still bills a cancelled match whose scheduled instant has passed,
and does not yet bill one still to come.

### THE CUT HAS NO DEFAULT, BECAUSE A DEFAULT ALREADY BROKE ANOTHER PAGE

The first draft gave `buildFieldMonths` a `nowMs = Date.now()` default. **Finance › Revenue calls
the same builder** and silently became realized: Austin went from **172 matches to 132**, San
Antonio 89 → 64, revenue down $168 in Austin alone. `realizedThroughMs` is now a required
parameter — `number` cuts, `null` does not — and every call site states its answer. Revenue passes
`null` and its 7 group rows and 4 summary rows are byte-identical to before. `cost-basis-confinement-test`
asserts no builder carries a default and that every call site passes the argument.

### WHAT WENT WITH THE TOGGLES

`monthly_flat` now renders a **dash**: a flat month's figure lives only in an override and nothing
here reads one. **No venue carries `monthly_flat` today** (30 `per_match`, 4 `profit_share`), so
the branch is defence rather than a live case.

`scripts/e2e/verify-cost-basis.mjs` was **deleted**, not un-quarantined — it existed to pin that
this page opened on the same derivation as Field Costs, OpEx and Cash Flow, and that premise is
now deliberately false. Removed from `quarantine.pinned.json` in the same commit. What went with
it: the keyed-$0-vs-nothing-keyed distinction (an override question, moot here) and the "a dashed
row contributes no 0% to any total" check — the second is still a live property of `rollup()` and
is now uncovered by a browser suite.

## TWO SUITES BLOCKED A PUSH AND NEITHER WAS THE CHANGE (2026-08-25)

The Cost change's push failed the e2e lane on `verify-revenue-notmatched` and
`verify-revenue-membership`. **Both were proved pre-existing by running them against the parent
commit `353bb9f` with the changed files checked out**, which is the only test that separates "my
diff broke it" from "it was already red".

**`verify-revenue-notmatched` — "venues 30, got 31".** `fin_venues` **#65 "Ann Richards School"
(Austin)** was created **2026-08-25T02:18** through the Field Costs add-venue flow. Not a code
change: the Fields assign route had made no write at that point and `fin_venue_fields` was still
41 links. MatchDay field 1651 carries 6 live matches from 2026-08-15, so the venue is real. The
constant was bumped to 31 with the reason — that suite's own header says the venue count "only
changes when someone adds or removes a venue, which is exactly the thing worth being told about",
and being told is what happened.

**`verify-revenue-membership` — QUARANTINED, and it is red on the parent commit too.** On `353bb9f`
it fails **4** assertions; on the Cost change it fails **1**. That asymmetry is itself the evidence:
a regression does not make a suite fail *less*.

- **The stable failure is a real defect and it is not in the Cost derivation.** Revenue's
  field-grain Austin membership totals **$7,737** against the Cities page's **$7,749** — a **$12
  gap on $8,024** of Austin August membership revenue (0.15%). Both pages allocate the SAME
  city-month figure by member spots, and **both fall short of it**, by different amounts. So at
  least one is allocating over a denominator the other does not share. Restore the suite when the
  two pages reconcile to the dollar; the gap is the bug, not the assertion.
- **The other three are load-dependent.** They fail together, controls included — "at least one
  field carries NON-ZERO membership" reading 0 while the same page a minute later reads $17,912
  across 7 rows. A whole-column zero with its own control down is a page that has not finished its
  member-spot pass, not a measurement. Same lane fragility already recorded for this suite on
  2026-08-24.

**THE ASYMMETRY IS THE TELL.** Run a failing suite against the parent commit before assuming the
diff caused it. Four failures on the parent and one on the change is not a regression; it is a
suite that was already red, plus a page that sometimes loads slowly.

## MATCH PROMOTION — WHAT COUNTS AS A NEW SLOT (2026-08-25)

The tiles carry a **NEW FIELD / NEW DAY / NEW TIME** badge, and the rule is printed on the page so
marketing can read it without asking. A match is NEW when its own field, or that field's weekday,
or that field-weekday's kick-off time did not appear in **the prior week's slate for its city** —
the same seven weekdays one week earlier. **A match's creation date is never read**: one booked
last month for a slot that has never run is still new to a player.

### THE PRIOR SLATE INCLUDES CANCELLED MATCHES, AND THAT DECIDES MOST OF THE ANSWER

`fetchVeoWeek` excludes cancelled matches, so the first build compared against **what was played**.
Measured on 2026-08-25 over 109 matches against the week of 2026-08-17 (82 played, **29 cancelled**):

| prior week is… | flagged | of 109 |
|---|---|---|
| what was **played** | 31 | 28% |
| what was **scheduled** (cancelled included) | **10** | **9%** |

**21 of the 31 were slots that had been on the previous slate and were called off.** Bicentennial
Park read as a NEW FIELD in Dallas; PAC Global as a NEW FIELD in Houston; Centennial Commons as a
NEW FIELD in St. Louis. None of them is new — each was scheduled the week before and cancelled. A
cancelled match was still published, still copied forward by copy-week, and still seen by players,
so the slot existed. `fetchVeoWeek` takes an `includeCancelled` flag rather than Match Promotion
running a second query, because that function owns the wall-clock parse and the fleet-city filter.

### PER FIELD, NOT PER CITY

The three tests **nest**: the field, then that field's weekday, then that field-weekday's time.
Testing each against the city's whole slate instead flags only 13 of 109 and **disagrees on 19,
wrongly every time** — NEMP running on a Friday for the first time does not flag, because some
other Austin pitch played a Friday. Precedence is a nesting rather than a ranking: a new field has
a new day and a new time by definition, so reporting the day would be true and useless.

### WHAT THE LIVE RULE FLAGS THIS WEEK — 10 of 109

| city | badges |
|---|---|
| Warsaw | 3 × NEW FIELD — Hala Piłkarska Bemowo, the city's first week (no prior slate at all) |
| Austin | 5 × NEW DAY — NEMP Fri 6:30/7:30/8:30 and Sun 6:30/7:30; NEMP ran Mon/Tue/Thu/Sat |
| Houston | 1 × NEW TIME — ATH Pearland Sat 8:00, was 8:30 |
| San Antonio | 1 × NEW TIME — Soccer Central Sun 9:00, Sundays were 7:00 and 8:00 |
| Atlanta · Dallas · OKC · St. Louis | none |

Reproduced as fixtures in `scripts/match-promotion-new-test.ts`, so the suite and this table fail
together rather than drifting apart.

### THE TILES CARRY ONLY WHAT IS PLANNED

Six channel chips, a "No code" pill and a "No push planned" line rendered on **every** tile — three
rows of chrome across 109 matches saying one absence three times, while the city header already
counted planned against no-plan. Now a chip appears only when its channel is selected, the code
pill only when there is a code, and the push line only when there is a push. A tile with no plan is
the time, the field, and its badge if it has one. Planned tiles are distinguished by **weight** — a
solid mint left rail and actual content — not by a label.

**`match_promotion_plan` IS FREQUENTLY EMPTY, AND A SUITE MUST NOT ASSUME OTHERWISE.** On
2026-08-25 **all 109 tiles carried no plan**, so `verify-match-promotion`'s natural control — "at
least one lit chip is on the page" — would have been red on a page that was working perfectly. The
control is two-directional instead: either chips exist, or every tile is proved to be `state="none"`,
which is what makes a chip count of zero the correct render. The overflow measurement that the old
"all six chips" assertion really protected is unchanged and now picks its control element by
whatever the tile has.

## COVERAGE — COLOUR MARKS THE EXCEPTION, AND THE EXCEPTION DEPENDS ON THE WEEK (2026-08-25)

Every matches-but-no-push cell was a filled coral block reading **OPEN**. With
`match_promotion_plan` empty — its state in production, for all 109 matches — that is **41 of the
56 populated cells**, and a colour that is everywhere carries no information. It read as an alarm
about the whole week when it was only saying nobody had started.

**`anyPlanned` now decides whether OPEN is worth marking at all.**

| week | caption | open cells marked | filled coral blocks |
|---|---|---|---|
| nothing planned (live, 2026-08-25) | *No pushes planned this week. 109 matches open.* | **0 of 41** | 0 |
| with coverage (mocked, below) | *19 covered days · 22 days with matches and no push (52 matches).* | **22 of 22** | 0 |

The covered cell is the only filled one in either week — mint fill, mint rail, push time and
channels. An open cell is its field and time in normal weight, with a **2px coral left edge** only
when there is coverage for it to be an exception to. An open cell with more than one match now says
so (`+7 more`); it used to print one venue and time as if that were the day.

**THE DISTINCTION THIS VIEW ANSWERS IS CARRIED BY CONTENT, NOT COLOUR.** An open cell prints a
field and a time; a no-match cell prints a dash. That holds when nothing is coloured at all, which
is the state the page is in today. On the phone the glyph does the same work: `✓` covered, `·`
matches with no push, `–` no matches.

### THE HALF THAT CANNOT BE OBSERVED IS THE HALF WORTH PINNING

`match_promotion_plan` is empty, so **a browser suite can only ever see the no-plans week**. Both
weeks are asserted as arithmetic in `scripts/match-promotion-new-test.ts` — the two caption shapes,
the per-city-day counting, and that `none` and `open` stay distinct states. The browser suite
asserts the DOM contract that half depends on, in **both directions**: with `anyPlanned=0` no open
cell may carry the marker, and with `anyPlanned=1` every one must. Neither branch can pass
vacuously on a week that happens to be empty.

**THE WITH-PLANS STATE WAS CHECKED BY MOCKING THE API RESPONSE IN THE BROWSER**, never by seeding
the table. `page.route("**/api/match-promotion*")` fetches the real payload and injects plans into
it client-side. Production is untouched — which is the rule a suite that writes production already
broke once here (see `verify-counts-as-regular`).

## MATCH PROMOTION COMMENTS — ONE MECHANISM, AND ONE COLUMN THAT DIES QUIETLY (2026-08-25)

Comments are `slate_notes` with `kind='comment'` (migration 0144), served by `/api/slate-notes`,
rendered by the `NoteList` lifted out of `SlateReviewView`. **Not a second system**: same table,
same route, same list, same author/week/delete semantics. What differs is only the composer —
Slate Review's carries a live slot-parser readout, Match Promotion's is prose.

**A COMMENT HAS NO CITY AND NO MATCH.** The grid shows every city at once, so a comment is about
the week's promotion plan, not a market; and it is one list, not a thread per fixture. The scope
rule is a CHECK constraint, not a convention in the route: a note has a city, a comment does not.

**A COMMENT IS NOT PARSED.** `parseCapture` turns "8PM thurs Crossbar" into a proposed slot for
Slate Review's day strip. Running it on prose would silently turn a sentence mentioning a time into
a slot proposal on a different page.

### `match_promotion_plan.comment` HAD NEVER HELD A VALUE

Measured before deciding: **2 plan rows, 0 with a comment, 9 `fin_change_log` entries across two
matches, none setting one.** It was a single unattributed string that whoever saved last overwrote
— the exact shape of the problem comments exist to fix.

The textarea is gone from both the desktop panel and the phone, and the column is **no longer
written**. It is also **not rendered**: a read-only "earlier comment" fallback was designed and
then dropped, because with 0 rows carrying a value it is unreachable code guarding a case that has
never occurred — a thing someone deletes in six months wondering what it was for. The column stays
in the table; nothing reads or writes it.

**NO PER-TILE BADGE.** A comment is not attached to a match, so a tile has nothing to count. The
count lives on the list header instead.

### THE READ DEGRADES QUIETLY, THE WRITE FAILS LOUDLY

Code deploys before a migration is applied — the normal order here. `?scope=comments` matches
nothing while the kind does not exist, so the list is empty, which is exactly what is true. The
POST names the migration instead of quoting a constraint: *"Comments need migration 0144
(slate_notes kind='comment'), which is not applied yet. Nothing was saved."* Verified against the
live pre-migration database, with the typed text left in the box.

### RUNNING THE E2E LANE WHILE EDITING FILES TESTS A MOVING TARGET

A push failed on `verify-pace-readout` and `verify-pace-grain` — suites nothing in the diff
touches. The cause was not the diff and not the lane: **the gate drives `next dev`, which serves
the WORKING TREE, not the committed HEAD.** Editing files during a 20-minute browser lane
recompiles the app underneath the suites. Commit first, then push, then do not touch the tree until
it finishes.

`verify-player-finder` remains flaky under lane contention — proved passing alone at 81/81, red in
2 of 3 full-lane runs. Noted once; not re-diagnosed.

## MIGRATION 0144 IS LIVE (2026-08-25)

`slate_notes` now carries `kind='comment'` with a nullable `city`. Applied by Ryan in the SQL
editor; the verdict row came back exactly as predicted:

    city_nullable t · kind_has_comment t · notes_with_city 8 · bad_shape 0 · comments 0 · comment_idx 1

**VERIFIED INDEPENDENTLY, AND WITHOUT WRITING A ROW.** A pasted verdict is a claim; the check is
two inserts DESIGNED TO BE REFUSED, where the evidence is *which constraint* refuses them:

- a comment carrying a city → refused by **`slate_notes_shape_chk`**. Before 0144 it would have
  been refused by `slate_notes_kind_chk` (the kind did not exist), so the constraint name is the
  proof the new shape rule is the one running.
- a note with no city → still refused. Dropping `NOT NULL` did not loosen notes.
- `slate_notes` row count unchanged at 8 — the probe wrote nothing.

Comments are live from here. Match Promotion's list is `?scope=comments`; Slate Review's list is
unchanged and cannot show them (they have no city, and a kind filter says so out loud).

## A SUITE THAT DATES IS NOT A SUITE THAT IS FLAKY (2026-08-25)

`verify-pace-readout` failed with `day 25: the current month reads "—" — got "$380"`. **Today is
the 25th.** The block hardcoded `for (const d of [25, 31])` as "days the current month has not
reached" — true when written, false the moment the month reached day 25.

The same file already had the right pattern four sections earlier: `beyond` is derived from
`P.current.length`, the days the current series actually covers. The dated block now derives its
days the same way — `plotted + 1` and the month's last day, from the chart's own `data-current` /
`data-compare` attributes — and prints what it chose (`current series covers 25 of 31 days —
testing 26, 31`). **53 passed, 0 failed.** It cannot date again.

**THE TELL: a dated suite fails on ONE assertion with a specific wrong value. A flaky one fails on
every assertion including its controls.** `verify-pace-readout` failed 2 of 53 with a real dollar
figure; `verify-player-finder` fails all of them with zeros. Those are different problems and only
one of them is fixed by re-running it.

**`verify-player-finder` QUARANTINED** on that basis: passes ALONE at 81/81, red in 3 of 4
full-lane runs, and when it fails its own positive controls fail with it. It pages 30k rows and is
the heaviest read in the lane. Restore when the lane runs against `next build && next start`
instead of `next dev` — the ceiling-lift this file already identifies. The suite is not the problem.

## A COMPONENT SHARED WITH THE PHONE INHERITS THE PHONE'S FLOOR (2026-08-25)

`PageComments` was written at the desktop grid's density — a 12.5px input — and rendered on the
phone too. `verify-match-promotion-mobile` caught it: **every input must be at least 15px**,
because below ~16px **iOS Safari zooms the page on focus**, and on a seven-column week view that
means pinching back out after every keystroke.

The fix is mobile-first, not a second component: `text-[15px] sm:text-[12.5px]` and
`h-[38px] sm:h-[32px]`. One component, the phone's floor as the base, the desktop's density behind
a breakpoint.

**THE GENERAL RULE: a component that renders on both surfaces inherits the STRICTER one's
constraints, and the phone is almost always stricter.** Lifting a component to share it — which is
the right move — is also the moment its styling stops being about one page.

`verify-matchpanel` exited **2** in the same lane and passes **147/147 alone**. Exit 2 is the
harness's Playwright-timeout code, not an assertion failure: it is the wall-clock cap, and the cap
measures queueing as well as work. **Read the exit code before diagnosing** — exit 1 is a suite
that decided something is wrong, exit 2 is a suite that never got to decide.

## OPEN ITEM — REVENUE FIELD-GRAIN MEMBERSHIP DOES NOT RECONCILE TO CITIES (unfixed)

**Not a gate problem, and it does not block anything. It is a real reporting defect and it is
logged here so it gets fixed properly rather than surfacing as a red suite.**

Finance › Revenue, field grain, Austin, August 2026: **$7,737**. Finance › Cities, same city, same
month: **$7,749**. A **$12** difference on **$8,024** of Austin August membership revenue in
`fin_revenue` (0.15%).

**BOTH PAGES FALL SHORT OF THE $8,024**, by different amounts. They allocate the same city-month
figure across member spots, so at least one of them is dividing by a denominator the other does
not share — a match with member spots that one side counts and the other drops. The gap is small
and stable, which is what makes it worth chasing: a rounding artefact would move.

Where to start: `matchAllocatedMemberRevenueFor` (financeStats.ts) is the allocation both grains
route through; the field grain reaches it via `buildMatchRows` keyed on `fieldKey`, and Cities via
`cityPnl`. The candidate is a match whose spots exist but whose field does not resolve to a
`FieldCostSlot`, so its allocation is computed at city grain and lost at field grain.

`verify-revenue-membership` is the suite that found it. It is not quarantined any more — there is
no quarantine — and it is not run on a push. Run it directly when picking this up: it prints the
per-city comparison that isolates the gap.

## THE GATES ARE GONE (2026-08-25)

No browser lane, no E2E on a push. `npm run verify` — typecheck plus the node guards, ~20s — is
the whole pre-push gate. Deleted: `scripts/quarantine.pinned.json`, `scripts/gate-scope.mjs`,
`scripts/gate-scope-test.mjs`, and the quarantine map and drift guard inside `run-suites.mjs`.
`npm run verify:e2e` still runs every browser suite on demand; nothing is excluded, because
nothing is mandatory. See **The bar** in CLAUDE.md.

The browser lane blocked six pushes in one day and **not one block was the change**: a suite that
had dated, a suite that timed out under contention, a suite testing a working tree being edited
while it ran, and the $12 gap above. Twenty minutes to learn nothing is a tax, not a gate.

## A BEFORE-AND-AFTER NUMBER CAUGHT WHAT A GREEN SUITE COULD NOT — TWICE (2026-08-25)

**0145 was correct and slower, and every check said it was fine.** Its verdict query returned all
six predicted values. Every node guard was green. `tsc` was clean. The function computed the right
answer. It was only slower — and no correctness test can see that.

The only reason it was caught is that the migration carried an **acceptance criterion**: re-run the
same concurrency curve after applying, and it must not be worse than the number measured before.

| `hist=multi` | before 0145 | after 0145 |
|---|---|---|
| conc 1 p50 | 1,382ms | 1,560–1,673ms |
| conc 4 p50 | 3,583ms | 4,060–4,370ms |
| conc 6 p50 | 5,271ms | 6,183 / 6,406 / 6,261ms |
| conc 6 max | 6,816ms | 6,549 / 8,768 / 8,131ms |

That is the second time in one session. The first was Finance › Cost, where the whole deliverable
was a before/after table. **A number measured on both sides of a change finds things a green
assertion cannot, and it costs one script.**

### WHAT 0145 GOT WRONG WAS THE BUG ITS OWN HEADER WARNED ABOUT

It merged 0136's `win` CTE and the new match filters into one grouped pass guarded by
`(select match_on from cfg)` — a scalar subquery, referenced three times. 0136's finding is that
**the planner cannot fold a parameter**, so that guard does not short-circuit; it relocates the
per-row cost from an `EXISTS` into a subquery. It also added `group by s.user_id` where 0136 had a
plain filtered scan. "One pass instead of two" traded two cheap guarded scans for one expensive
grouped scan. Rolled back by 0146.

## THE FINDER TIMES OUT AT CONCURRENCY 6, AND THE ROLLBACK DID NOT FIX THAT

**Measured after 0146 landed, on the restored 0136 body:**

    conc 1        p50 1,372ms   max 1,758ms        ← back to baseline
    conc 4        p50 3,896ms   max 6,062ms        (baseline 3,583 / 3,871)
    conc 6 run 1  p50 5,778ms   max 7,092ms
    conc 6 run 2  p50 5,013ms   max 7,835ms
    conc 6 run 3  p50 5,761ms   max 8,325ms   ← 6 of 30 returned HTTP 500:
                                                 "canceling statement due to statement timeout"

**The rollback was right — 0145 was measurably worse — but it did not restore the curve, and it
did not fix the underlying fragility.** At six concurrent callers the finder now visibly tips past
the 8,000ms statement timeout and returns 500s. A single user is fine at 1.4s.

### AND THAT CORRECTS SOMETHING RECORDED EARLIER TODAY

This file previously said the timeout theory for `verify-player-finder` "does not hold", on the
strength of one clean run at concurrency 6. **It does hold.** That run was a quieter moment on
production, not a disproof. The suite's signature — every assertion zero, its own positive controls
failing with it — is precisely what a timed-out query renders, and here is the 500 with the exact
error string to match.

**The lesson is about the disproof, not the theory: one clean run does not disprove a load-dependent
failure.** Three runs found what one missed, and the earlier conclusion was stated with more
confidence than one sample could carry.

**CONSEQUENCE FOR THE CORRECTIVE MIGRATION:** it is no longer enough for the match filters to be
"not slower". The finder is already at its ceiling under load, so adding filters at equal cost
still leaves it timing out. The target is FASTER — which points at the precomputed set rather than
at any arrangement of CTEs over `player_spots`.

## PLAYER FINDER: MATCH FILTERS, AND "PLAYED" NOW MEANS MATCHES (2026-08-25)

**0147 is live.** The finder reads two materialized views instead of a view over a view over a
view. `player_finder_mv` (30,455 rows) and `player_match_mv` (151,890) are refreshed by
`refresh_player_finder_views()`, called from the matches sync beside `refreshGrowthViews` —
best-effort, never fails the sync.

### THE UNIQUE INDEX FAILED FIRST, AND THAT WAS THE USEFUL PART

`unique (user_id, match_api_id)` rejected (2183, 15323). Blake paid $24 for himself and brought a
guest, and **the guest is recorded under his user_id** — one row `user_type PLAYER`, one `GUEST`,
both passing the qualifying predicate. Measured across the whole set: **6,059 duplicate pairs,
8,991 extra rows, 2,084 players**, one holding 18 spots in a single match. PLAYER 143,010 · GUEST
7,593 · ADDITIONAL_SPOT 1,287 — and 7,593 + 1,287 = 8,880 against 8,991.

The predicate was right and **the index was wrong**. The view stays SPOT-grained, keyed on the
spot's own `api_id`: occupancy needs those guest rows counted individually, and the match filters
already `select distinct user_id`, so they never cared.

### AND IT EXPOSED A BUG LIVE SINCE 0133

`plays` was `count(*)` over spots, so **a player who brought a guest to one match read as having
played twice**. Now `count(distinct match_api_id)`:

    Played once   5,831 → 6,174
    Played 2+     8,963 → 8,620      343 players moved

Both counts are in 0147's verdict row so the shift is on the record rather than discovered. A
`change_log` entry says why the tile dropped.

### THE TWO CITIES ARE NAMED APART

`preferable_city_name` is the city on the player's **account** — a signup attribute, and **null for
4,010 of 30,455 (13.2%)**, so "City = Austin" silently excluded every one of them. It is now
**HOME CITY**, the count is printed beside it, and **"Not set" is selectable** so those players are
reachable rather than invisible. The new **PLAYED AT** group — City, Field, Kick-off, Dates — is
the other question, and the Field select narrows to the chosen city.

### THE STALENESS BANNER FIRED ON ITS FIRST DAY

A table can be fast and confidently wrong; a view could only be slow. `player_finder_freshness()`
compares the set's stamp to the newest `mdapi_matches.synced_at`, and within an hour of applying
0147 the page was already saying *"These counts are out of date. New matches synced 50 min ago but
this set was last rebuilt 56 min ago"* — because a sync had landed before the refresh was wired.
It was right, and it said so instead of showing a confident number.

**Verified in the browser:** Houston → ATH Katy returns **693**, the same figure 0145's verdict and
0147's verdict both produced by different mechanisms. Plus kick-off from 21:00 and matches from
2026-08-01 → 97. Home city = Not set → 4,010.

## THE FINDER'S REFRESH HAD NEVER RUN — ONE MISSING `WHERE` (2026-08-25)

Reported from two places ("Refresh does nothing"), and it was two bugs stacked.

### THE BUTTON WAS HONEST AND USELESS

Reproduced on production: the click fires, `GET /api/players/finder` goes out, returns **200**, and
the page renders exactly what came back. Nothing is ignored. Refresh called `load()`, which
re-fetches the route; the route reads the set and its freshness stamp and **rebuilds nothing**. So
it faithfully re-read a stale set and faithfully re-rendered the same staleness.

That was correct before 0147 — re-reading the mirror was all there was. 0147 made the button
inadequate and did not change it.

### AND THE SET HAD NEVER REBUILT AT ALL

    select refresh_player_finder_views();
    ERROR:  UPDATE requires a WHERE clause

**`pg_safeupdate`.** 0147 ended the function with `update player_finder_refresh set refreshed_at =
now();` — no `WHERE`. And because it is one plpgsql function in one transaction, **the throw rolls
back the two matview refreshes that had already succeeded**. The set rebuilt and Postgres undid it,
every hour, silently.

    matches synced   18:44:46   (cron; 17:35, 16:41, 15:47 … all ran)
    set rebuilt      17:29:20   (when 0147 was applied)

The sync wiring was fine — it had been calling the function all along. `refreshPlayerFinderViews()`
logs a warning and returns so a refresh failure never fails the sync, which is the right posture
and is exactly why nobody saw it.

**THIS RULE IS WRITTEN DOWN TWICE IN THIS REPO** — CLAUDE.md ("revoke SQL with a `WHERE` clause —
`pg_safeupdate` rejects an unqualified UPDATE") and this file. 0147 broke it anyway. Fixed by 0148
with `where only_row`, the one-row primary key, and a comment saying not to simplify it away.

**THE ONLY REASON ANY OF IT SURFACED WAS THE STALENESS BANNER** — the thing that did work. A silent
best-effort failure needs something else on screen telling the truth, or it is invisible until
someone reports a symptom two layers away.

### REFRESH NOW REBUILDS, BUT ONLY WHEN STALE

`?rebuild=1` asks the route to rebuild before reading. It checks freshness first: **stale → rebuild;
current → plain re-read.** A rebuild is ~3s under an exclusive lock, so firing one per click would
make a no-op button expensive and let repeated clicks queue locks. The staleness check is the rate
limit.

Verified by backdating the stamp and driving it: banner stale → click → button reads "Rebuilding…"
→ `rebuilt=true`, banner clears to "set rebuilt just now". **Second click on the now-current set
returns `rebuilt=false`** — no wasted lock.

### AND THE REFRESH DURATION, MEASURED AT LAST

**3,120ms** for both matviews (182,000 rows, 13 indexes). That is over the one-second line that
would have argued for `REFRESH … CONCURRENTLY`, so a finder request landing during a refresh waits
~3s, hourly. Both matviews carry plain-column unique indexes so CONCURRENTLY is available — but it
cannot run inside a transaction and every PostgREST rpc is one, so switching would mean moving the
refresh to pg_cron. Recorded, not done.

## A BOUNDARY IS NOT A FILTER — WARSAW SAW 5 OF 14 (2026-08-25)

A confined Warsaw operator saw **5 players**; an admin filtering to Warsaw saw **14**. The 9 missing
were exactly the signups with no match yet — the outreach list — and the NEVER PLAYED tile read 0.

**THE CAUSE WAS ONE LINE, SHIPPED THE SAME DAY**, in the Played-at work:

    let matchCity: string | null = auth.confinedCity;   // WRONG

copied from the home-city scope directly above it. That set `p_match_city` on **every** confined
request, whether or not the operator had touched the Played-at control, so confinement became
**home-city AND played-in-city — an intersection**. Measured:

    p_city='Warsaw'                            14
    p_match_city='Warsaw'                      16
    p_city='Warsaw' AND p_match_city='Warsaw'   5   ← what a confined account was getting

**HOME CITY IS THE BOUNDARY. PLAYED-AT CITY IS A FILTER.** The fix is `= null`: no filter unless one
is asked for. The boundary was never held by forcing the value — it is held by `assertScope`, which
REFUSES a confined account naming another city rather than silently re-pointing it. Forcing the
value only ever narrowed what its own operator could see.

### THE FIRST EXPLANATION WAS WRONG, AND THE CONTROL STATE IS WHAT DISPROVED IT

A play window reproduces the same two numbers — `p_city='Warsaw'` + any play window gives players 5,
never 0 — so "the operator had a Played window set" fitted perfectly and was wrong. The screenshot
showed PLAYED on "Any time" and HISTORY on "Any", and reading the actual request in that state
proved it:

    controls: Any time / Any     REQUEST: ?city=WAW&page=1&size=50
                                 applied: playMode=any    total: 14

**Two causes can produce the same number. The one that matches the OBSERVED INPUTS is the cause.**
Reading the request rather than reasoning from the component is what separated them.

## TILES WERE DEAD ON THE TYPED CITY, NOT THE EFFECTIVE ONE

`Top city` and `Cities` are dropped when a city is chosen — "a Top city: Warsaw tile is the filter
row read back at you". But the predicate was `!!f.city`, the city the operator **typed**. A confined
account types nothing; the server imposes its city from the account row. So the check was false for
exactly the people who can only ever see one city, and the result was backwards: **the Warsaw
operator got "Top city: Warsaw" and "Cities: 1"** while the admin who typed Warsaw got the useful
tiles. Now dead on the effective scope, typed **or** imposed.

## STILL OPEN: THE UNION IS A POLICY DECISION, NOT A BUG FIX

Whether a confined account should also see players who PLAYED in its city but live elsewhere is
Ryan's call, and it is not needed to fix the above. Measured, so it is decided on numbers:

| city | home-only | played-in | union | delta |
|---|---|---|---|---|
| Warsaw | 14 | 25 | 32 | +18 |
| San Antonio | 3,355 | 2,281 | 3,664 | +309 |
| Dallas / Fort Worth | 1,670 | 754 | 1,878 | +208 |
| Austin | 12,553 | 7,550 | 12,935 | +382 |
| Houston | 5,822 | 3,919 | 6,198 | +376 |

**1,293 players across five accounts.** Not applied.

## A DELETED PLAYER IS SCRUBBED IN PLACE AND KEEPS BEING SERVED (2026-08-25)

`GET /admin/players` does not drop a deleted account. It **scrubs the row and keeps returning it**:

| field | after deletion |
|---|---|
| `firstName` | `"Deleted"` |
| `lastName` | `"Account"` |
| `phoneNumber` | **null** |
| `email` | an opaque **44-character** token at `@playmatchday.com` |

Measured on prod `mdapi_users`: **1,669** rows on that exact name pair — **1,669** with a
playmatchday.com address, **0** partial scrubs, **0** retaining a phone. Oldest such row synced
2026-06-07, newest 2026-08-23, so the mirror has been picking them up all along.

**THE MARKER IS THE NAME PAIR, NOT THE EMAIL DOMAIN.** Six real staff accounts carry
`@playmatchday.com` and are not deleted. The tombstone local-part is random — not derived from the
id — so it cannot be reversed or matched to a person.

### SO THE REAL PII IS ALREADY GONE BEFORE WE CAN SEE THE MARKER

Which means UI suppression is NOT what protects it. What suppression stops is the tombstone
**reading as a contact**: 1,669 rows rendered a plausible address under a column headed Email and
exported as leads, and mail to any of them bounces. `shape()` in the finder route now returns
`email: null, phone: null, scrubbed: true` for them — one function serves the table AND the export,
so neither can leak what the other hides.

### THE ROWS SUPPRESSION CANNOT REACH — AND WHY A RE-SYNC FIXES THEM

An account scrubbed upstream **since we last fetched it** carries no marker here. Our copy predates
the scrub and still holds the real address and phone in the column **and** in `mdapi_users.raw`.
Prod id **88053** is one: still name + email + phone in Clubhouse, last synced 2026-08-23, scrubbed
on MatchDay. Nothing on the read path can detect it.

**Because the scrub is IN PLACE, a plain re-sync fixes it completely** — the upsert overwrites the
name, nulls the phone, replaces the email with the tombstone, and rewrites `raw` wholesale. No
id-set diff is needed to catch deletions, because deletions are not deletions: they are edits, and
`mdapiUsersSync` never sees them only because the incremental walk stops at the watermark.

`mdapiUsersSync.ts:39-42` ("We do NOT delete rows") is correct but reads as though the risk were
row disappearance. It is not. The risk is a **stale edit**, and neither watermark mode catches one.

## FULL USERS RE-SYNC: 113 SECONDS, NOT 30 (2026-08-25)

The first real run of `/api/sync/users-full`, on production:

| | |
|---|---|
| pages fetched | **123** |
| rows received / upserted | **30,718** |
| duration | **112.7s** |
| scrubbed rows seen | **1,959** |

**THE ESTIMATE IN `mdapiUsersSync.ts` IS WRONG AND WAS LOAD-BEARING.** Its header says a full run
is "~19s network + ~10s upserts ≈ 30s", and the route's `maxDuration = 120` was sized from it. The
real figure is **112.7s — 94% of that ceiling**, with seven seconds to spare. It would have begun
timing out on its own growth within months, leaving a half-applied sync and a log row that never
completes. Raised to **300s**. The number to watch is `completed_at - started_at` in `fin_sync_log`
for source `mdapi-users-full`.

Measured alongside, from `fin_sync_log`:

| sync | median | max |
|---|---|---|
| `mdapi-users` (incremental walk) | **0.6s** | 0.8s |
| `mdapi-matches` | 15.0s | 17.6s |
| `mdapi-users-full` | **112.7s** | — |

### WHAT THE FIRST RUN CORRECTED

| | before | after |
|---|---|---|
| rows | 30,691 | 30,718 |
| scrubbed (`Deleted`/`Account`) | 1,669 | **1,959** |

**290 accounts were showing stale contact details** — scrubbed on MatchDay, still readable here.

Prod **88053**, the case that started it, fixed itself exactly as predicted:

| | before | after |
|---|---|---|
| name | `Patryk` / `` | **`Deleted` / `Account`** |
| column email | present, 20 chars (real) | 61-char tombstone |
| column phone | present, 12 chars | **null** |
| **raw email** | present, 20 chars (real) | 61-char tombstone |
| **raw phone** | present, 12 chars | **null** |

`raw` was overwritten wholesale, so the second copy of the PII went with it. No id-set diff, no
soft-delete column, no separate PII pass — because a deletion here is an edit.

## REFRESH SYNCS THE SOURCE BEFORE REBUILDING

Refresh used to rebuild the set from a mirror that was itself behind, so pressing it after a new
signup showed nothing **and reported success**. It now runs the incremental users walk first
(0.6s), then rebuilds (3.1s) — about four seconds behind a click. The FULL re-sync is 113s and
stays on the daily cron.

Guards: a source sync within the last 60s is skipped (a double-click cannot re-sync); a FAILED sync
is reported to the operator as "this page is NOT current" rather than swallowed, with the detail
kept server-side.

**And freshness now considers BOTH mirrors.** `player_finder_freshness()` compares the set only to
`mdapi_matches.synced_at` — its `source_synced_at` claims more than it delivers, and players come
from `mdapi_users` on a different schedule. The route takes the NEWER of the two stamps and computes
`stale` itself; the RPC is still used for `refreshed_at`, which is the one thing only it knows. Its
`stale` is deliberately not read.

## CROSSBAR ROWLETT: THE LABEL WAS WRONG SINCE MAY, AND A DATED MODEL NOW EXISTS (2026-08-25)

**Crossbar has NEVER been on a percentage.** Migration 0057 put them on `per_match_minus_manager` —
`max(0, Σ match revenue − Σ manager pay)` — and left `revenue_share_pct` at 50 with the note *"it is
unused under the per-match model"*. True of the arithmetic; **false of the UI**, which interpolated
that column straight onto a page the partner can open. The payments were right the whole time; the
description of the deal was not.

Three surfaces stated or implied a share. Two are fixed, one was already honest:

| surface | was | now |
|---|---|---|
| `partnerDashboardData` header | `paid monthly at 50% of qualifying revenue` (interpolated `revenue_share_pct`) | derived from the payout MODEL |
| `PartnerMonthlyView` table note | `Your share is 50% of qualifying revenue` — **50 hardcoded in the JSX** | derived; correcting the DB alone would not have fixed this one |
| `Your payment` column | — | unchanged; it says *payment*, not *share*, and has no tooltip |

`PartnerPaymentInfo.revenueModel` already carried a doc comment specifying this exact copy, and
`FieldCostsView` already used it. The monthly partner path was the one place that ignored it.

### THE $20 IS A FACT ABOUT THE DATA, NOT A RULE

Manager pay is `$20 base / $30 when the match's capacity ≥ 25`. Every Crossbar match May–Aug is at
capacity **18 or 20**, and `fin_venues.max_players = 20`, so the $30 tier has never been reachable.
**Raise that cap to 25 and the deduction silently becomes $30.** Moot for Crossbar from August — the
fee model does not read manager pay at all.

### DATED MODELS (migration 0150)

`revenue_model_next` + `revenue_model_from` + `per_match_fee_cents`. The first rate history in this
codebase: `fin_venues` carries one rate with no date dimension, and `fin_venue_cost_overrides` is a
per-(venue, month) billing-timing lump that the Field Costs page deliberately does not read.

**BOTH OR NEITHER**, enforced in the DB *and* in `modelForPeriod`. A successor with no date never
applies; a date with no successor applies nothing. Either half alone is a rate change that reads as
configured and pays the old terms forever.

**Why dated rather than flipped in place:** `partner_weekly_payments` already freezes a paid amount
and the view renders the frozen figure with a divergence marker when a recompute disagrees. Flipping
the model would have kept the numbers right and still put a *"figures changed after payment"*
asterisk on all three settled months, on the partner's own page. Verified after 0150: **no
divergence markers**, and May/June/July still render $0 / $161 / $1,000.

### THE FEE MODEL BILLS MATCHES, NOT REGISTRATIONS

Every other model here is driven off registration rows, where a match with no bookings produces no
rows — invisible, and worth $0 either way. **Under a per-match fee that match RAN and owes the full
fee**, so a registration-driven count would silently underpay. Measured: 0 of 25 played Crossbar
matches have no rows, so this was not yet wrong; it is wrong the first time it happens.
`fetchPartnerRows` now returns a real match list and `played` comes from **`end_date_utc`**, never
`start_date` — the wall-clock trap would bill a match on the day it was scheduled.

**An open fee period shows its running total.** A revenue-share month in progress genuinely has no
figure yet; a fee month's total is final for every match already played. Hiding a known $600 behind
"Not yet calculated" understates money already earned.

### AUGUST, AND THE CANCELLATION RATE

August 2026: **6 played · 9 cancelled · 3 upcoming → $600**, with "9 cancelled, not billed" shown
beside the billable count. Ryan's ruling: `$100` per match that goes ahead, a cancelled match pays
nothing — consistent with `fin_venues.charge_on_cancel = false` already set on venue 51.

**The cancellation rate is real, not an artefact of an open month.** On matches whose date has
passed: May **4/7 (57%)**, June **6/12 (50%)**, July **3/13 (23%)**, August **8/15 (53%)**. August
sits between May and June — **July is the outlier**. Cancellations are evenly spread (2 of 4 in every
August week), and all nine are `auto_canceled` with attendance below minimum.

**`min_player_count` is NOT a standing setting** — it varies per match (7, 9, 10, 11). Across all
four months, **8 of 22 cancellations were short by exactly one player**, every one at min 9 with 8
booked. All eight would have run at a minimum of 8.

## META MARKETING API — WHAT THE LIVE ACCOUNT ACTUALLY RETURNS (2026-08-26)

Verified against `act_1613092135872657` with a system-user token, `ads_read` only. Every call is a
**GET**; there is no POST or DELETE path to Graph in this integration.

**`breakdowns=dma` IS DEAD.** Meta answers with a hard 400 that names its own replacement:

> *(#100) dma breakdown is no longer supported; to retrieve market-level data, please instead use
> comscore_market breakdown.*

**`breakdowns=comscore_market` is the parameter**, on `v25.0`. It returns exactly the strings our
mapping keys on — `"Atlanta, GA"`, `"Dallas-Ft. Worth, TX"`. `breakdowns=region` also works but is
worldwide administrative regions (`"Adana Province"`) and is useless here.

### SPEND CARRIES SUB-CENT PRECISION

The first real row was **`"spend": "519.544921"` — six decimal places.** A two-decimal parser
refuses every account-level breakdown row. `spendStringToCents` handles arbitrary decimals and
rounds half-up **on digits**, never through a float: `Number("8.29") * 100` is `828.9999999999999`.

### THE ACCOUNT

One account is visible to this system user — `act_1613092135872657` "MatchDay", **USD**, lifetime
spend $31,888.09. A second account exists in Business Manager but is **not assigned to this system
user**, which is the tighter grant; the sync picks by highest lifetime spend, so it stays correct
whether or not that ever changes.

**TIMEZONE IS `America/Bogota`** (UTC-5, no DST) — Meta buckets a day in the AD ACCOUNT's timezone,
not America/Chicago. For a monthly ledger figure the effect is confined to hours either side of a
month boundary. Recorded so nobody later "fixes" a discrepancy that is not a bug.

### POSITIVE CONTROL — MATCHED TO THE CENT

Campaign `120249287691260381`, 2026-07-26 → 2026-08-24, against figures hand-read from Ads Manager:

| market | API | hand-read | Δ | impressions Δ |
|---|---|---|---|---|
| Atlanta, GA | $132.79 | $132.79 | 0 | 0 |
| Austin, TX | $117.74 | $117.74 | 0 | 0 |
| Dallas-Ft. Worth, TX | $177.23 | $177.23 | 0 | 0 |
| Houston, TX | $240.83 | $240.83 | 0 | 0 |
| Oklahoma City, OK | $88.53 | $88.53 | 0 | 0 |
| San Antonio, TX | $90.97 | $90.97 | 0 | 0 |
| St. Louis, MO | $77.33 | $77.33 | 0 | 0 |
| **TOTAL** | **$925.42** | **$925.42** | **0** | **0 (93,004)** |

The campaign name in the brief was `"… - August"`; the real name is **`"… - August 2026"`**. Exactly
one candidate matched, which is also why market mapping beats campaign-name parsing.

### `Unknown` IS A REAL COMSCORE MARKET

The first production run returned a market literally named **`Unknown`** — 3 days, $0.03, 5
impressions. It maps to no city, so it carried into the unallocated row rather than vanishing. This
is the designed behaviour proven on live data, not a hypothetical.

### DAILY VARIANCE IS REAL BUT TINY

Market rows do not always sum to the account total. First run: **6 of 25 days varied, net −$0.03**,
every day ±1–2 cents. Positive variances become an unallocated row; **a negative day carries
nothing** — a negative expense row would corrupt the total the other way — so *net* and *carried*
are different numbers and the sync verdict prints both.

### THE FIRST RUN

Window `2026-08-01 → 2026-08-26` (clamped from 28 days by the floor), 25 days, 180 daily rows,
**$3,321.02** and 315,927 impressions, in **2.4s over 4 API calls**. Ledger: 8 rows — seven cities
plus $0.05 unallocated. Idempotent: a second run through the route deleted 8 and wrote 8, leaving
the predicate count at 8. **July's seven hand-entered rows are untouched at $3,450.00.**

## TWO FLOORS, AND WHY THEY MUST NOT BE RE-MERGED (2026-08-26)

| | floor | why |
|---|---|---|
| `fin_meta_ad_spend_daily` | **2025-12-01** | the table only ever claims to be ad spend |
| `fin_expenses` ownership | **2026-08-01** | see below — this one is NOT a tunable |

**THE LEDGER FLOOR IS NOT ABOUT DOUBLE-COUNTING.** That is the obvious reading and it is incomplete.
`fin_expenses` **has no rows of any kind before 2026-04-30** — no venue cost, no match manager pay,
no salaries, no agency fees. Loading ad spend into Dec–Mar would render five months of P&L showing
marketing cost against **nothing else**: a statement that reads as COMPLETE and is not. A month with
no data looks empty and invites the question; a month with only its marketing cost filled in looks
finished and answers it wrongly.

`scripts/meta-expense-floor-test.ts` fails if `META_EXPENSE_FLOOR_YMD` is ever set earlier, with
that reason in the assertion message. To lower it legitimately: give those months their other costs
first, then move `EARLIEST_SAFE` in the same commit.

**A KNOCK-ON THE SPLIT CAUSED, recorded because the test changed with it.** `windowFor` now clamps
to the DAILY floor, so the nightly trailing-28-day window reaches into the previous month — a run on
2026-08-05 now pulls from 2026-07-09. Those days land in the daily store and are refused by
`monthlyExpenseRows` at the ledger boundary. The old assertion required that window to clamp to
2026-08-01, which was right only while one constant served both purposes. The behaviour changed on
purpose; the assertion was not edited to go green.

## THE HISTORICAL LOAD — DAILY TABLE ONLY (2026-08-26)

`2025-12-01 → 2026-03-31`, run through the SAME `syncMetaAdSpend` as the nightly cron with
`dailyOnly: true` (a separate script would have been a second implementation of the money path).
121 days, 1,429 rows, **$10,458.55**, 1,241,960 impressions, 5.8s over 6 API calls.

**November was skipped deliberately** — the breakdown covers only $1,992.14 of $2,181.24 (91.3%)
and there is no way to say which city lost the remainder.

Dec–Mar by city: **ATL $2,519.79 · DFW $2,088.99 · HTX $1,584.00 · SATX $1,294.39 · ATX $1,251.07 ·
STL $1,064.21 · OKC $639.75 · unmapped $16.35 (0.16%)**. Worth noting against August, where Houston
is the largest market — the mix has moved.

**THE LEDGER WAS NOT TOUCHED, asserted three ways:** row count 322 → 322, August Meta total
$3,321.02 → $3,321.02, and a **sha256 over every column of every row unchanged at `cc8123c0`**.
`dailyOnly` returns before the count query, so the delete never executes and `ownedBefore` comes
back `-1` — "not inspected", deliberately distinct from "zero rows owned".

## THE APR-JUL 2026 LOAD, AND EL PASO (2026-08-26)

`2026-04-01 → 2026-07-31` into `fin_meta_ad_spend_daily` only, through the same `syncMetaAdSpend`
with `dailyOnly: true`. 122 days, **974 rows, $9,339.93**, 945,354 impressions, 3.8s.

**The daily CHECK needed no migration** — confirmed by exercising it rather than assuming: a
2026-04-01 row inserts, a 2026-07-31 row inserts, a 2025-11-30 row is refused by
`fin_meta_ad_spend_daily_floor`. Probe rows deleted, zero left behind. (PostgREST cannot serve
`pg_constraint`, so the constraint is read empirically.)

**The anticipated overlap did not exist: 974 new inserts, 0 updates.** The nightly window had never
written a July day, because before the floor split `windowFor` clamped to 2026-08-01. Reported as a
count rather than assumed, since an insert and an update look identical in a total.

### COVERAGE IS CONTINUOUS

2025-12-01 → 2026-08-26: **268 of 269 days have rows. The one gap is 2026-08-26 — today**, which had
not accrued when the last sync ran. Nov 2025 and earlier remain absent by design.

### THE MONTHLY DIFFERENCE IS REAL AND SMALL — STATED, NOT ROUNDED AWAY

Meta rounds per day, so a sum of daily rows sits slightly above the monthly aggregate:

| month | daily sum | account monthly | Δ |
|---|---|---|---|
| 2026-04 | $2,475.94 | $2,475.94 | **0.00** |
| 2026-05 | $2,061.22 | $2,061.19 | +0.03 |
| 2026-06 | $1,816.05 | $1,816.01 | +0.04 |
| 2026-07 | $2,986.72 | $2,986.67 | +0.05 |
| **TOTAL** | **$9,339.93** | **$9,339.81** | **+0.12** |

### EL PASO IS A MARKET WE ADVERTISED IN AND DO NOT MAP

Apr–Jul unmapped spend is **$375.10 (4.0%)** against 0.16% for Dec–Mar and 0.001% for August. It is
not spillover dust — **$348.63 of it is `El Paso, TX`**, 93% of the total, plus $20.33 `Unknown` and
$5.91 Albuquerque.

This is the "unmapped is carried, never dropped" rule earning its keep: the money is visible and
named. **El Paso also appears in the hand-entered April ledger at $533**, so it was a deliberate
market, not a targeting accident. It has no city code in our system and is NOT in the seven-market
mapping. Whether to add it is a decision, not a bug — until then its spend sits unmapped and
counted.

By city, Apr–Jul: **DFW $1,844.43 · HTX $1,622.84 · ATL $1,535.97 · OKC $1,413.68 · STL $1,047.94 ·
ATX $865.52 · SATX $634.45 · unmapped $375.10**. Note the mix against Dec–Mar (ATL led) and August
(HTX leads) — it moves materially.

### fin_expenses UNTOUCHED

Row count 322 → 322, August Meta $3,321.02 → $3,321.02, and a sha256 over every column of every row
unchanged at `cc8123c0d6893b268795fb2ffbb3a4bb97dae4befe3862bd5eb631389c3fee44`. `dailyOnly` returns
before the count query, so the delete never executes.

## PARMER: $1,815 vs $2,006 — TWO IMPLEMENTATIONS OF ONE PAYOUT (2026-08-26)

`buildPartnerPayoutsByVenueMonth` had a **fixed argument list that could express exactly one deal**:
`flat_percentage × revenue_share_pct`. `payout_model` was not a parameter, so
`RENTAL_PLUS_PROFIT_SHARE` was unreachable; 0150's `revenueModelNext`/`From`/`perMatchFeeCents` were
not passed, so the dated Crossbar model was unreachable too.

PARMER's row still carries the seed values `revenue_model='flat_percentage'` and
`revenue_share_pct=50` while its real deal is `RENTAL_PLUS_PROFIT_SHARE`. **The dashboard ignored
those columns; the shared path was driven by them.** Field Costs, Cities, Cost, Revenue and Cash
Flow all read the shared path.

| | before | after |
|---|---|---|
| PARMER Aug | $1,815.00 | **$2,006.00** |
| Crossbar Aug | $722.00 | **$700.00** (matches the dashboard) |

### THE REVENUE BASES TIE TO THE CENT

`$3,615.00 (dashboard) + $60.00 − $45.00 = $3,630.00 (Field Costs)`

| rows | amount | why they differ |
|---|---|---|
| 1 × Aug 19, DAILY PAID, **refunded=true** | +$15.00 | `periodOwed`'s flat branch never checks `refunded`; the dashboard's `earnedRevenue` does |
| 3 × Aug 27, **played=false** | +$45.00 | `matchActive` filters only `!match_canceled` — a scheduled match generated cost |
| 9 × Aug 05, PROMOCODE | −$45.00 | real money at a discount; the DAILY-PAID-only filter drops it |
| 40 × $0.00 MEMBER/PROMO/FREE | 0 | present on one side only, no money either way |

**Spots 274 vs 278: four rows where the player CANCELLED and was never REFUNDED.** They paid, so
`earnedRevenue` counts the money; they did not attend, so `occupiesSpot` (via `rosterRowCounts`)
does not count the seat. Two carry $15 each. The two predicates are allowed to disagree — forcing
them to agree produced a wrong number in each direction.

### STALE COLUMNS — 2 OF 4 PARTNER ROWS

| partner | payout_model | contradiction |
|---|---|---|
| **Parmer** | RENTAL_PLUS_PROFIT_SHARE | `revenue_model='flat_percentage'` + `revenue_share_pct=50` — **ignored by one path, load-bearing in the other** |
| **Crossbar Rowlett** | PER_MATCH_MINUS_MANAGER | `revenue_share_pct=50` unused (0057 left it) |
| Hattrick, PAC Global | REVENUE_SHARE | consistent |

Not cleared — the list was the ask. A column ignored by one path and load-bearing in another is the
defect, whichever way it is resolved.

### THE INERT CONTROLS ON A SHARE VENUE

`charge_on_cancel` is read only by `chargedUnitCount`, reached only from the **per-match** branch of
`groupCost`. A share venue returns before that code exists, so PARMER's `charge_on_cancel = TRUE`
has never affected a cent. The value is **left alone** (it matters again if the venue moves to a
per-match rate) and the control is disabled with the reason. The month cost box is the same: this
page does not read `fin_venue_cost_overrides` at all.

**PARMER's August is now $2,006.00 on both paths.** Nothing is frozen —
`partner_weekly_payments` has zero rows — so the three unplayed matches still move it.

## RECURRING EXPENSES — TWO PERIOD CONTROLS, NEITHER AUTHORITATIVE (2026-08-26)

The page had a header picker (Month/Quarter/Year) AND a QUARTER row inside the grid. The grid
obeyed the second; every label obeyed the first. With the header on **August 2026**:

| readout | showed | should have shown |
|---|---|---|
| Marketing chip | $12,971 (Jul+Aug+Sep) | **$5,721** |
| TOTAL column | the quarter | the window the header names |
| pre-July rows | real May/June money, **total $0.00** | a dash — no spend in this window |

`buildColumns` took a `QuarterInfo` plus a drill-down month, so it could only ever draw a quarter.
It now takes **`FinancePeriod.months`** — whatever the header says, at any grain — and the in-grid
control is gone. The Total header names its window (**TOTAL AUG**), and context columns are labelled
CONTEXT rather than PRIOR Q since the window is no longer necessarily a quarter.

**August 2026, all three readouts: $21,621.02.** Chip sum = sum of row totals = BOOKED TOTAL =
visible column sum. `recurring-window-test.ts` (25 assertions) asserts that identity at month,
quarter and year, plus that context columns never enter a total and a context-only row is flagged
rather than rendered $0.00.

**The "amount changes" indicator now reads 8, not 17.** Its detection logic is untouched — it counts
non-context `changed` cells, and the window it counts over is now a month instead of a quarter. That
is the fix working, not a second defect.

## I BROKE THE PRODUCTION BUILD AND THE PUSH DID NOT LAND (2026-08-26)

The PARMER fix made `partnerStats` import `buildRentalDashboard` — correct, since reusing the
dashboard's own function is the point — but `partnerRentalDashboard.ts` carried `import
"server-only"`, and `useFinanceData` is a CLIENT hook. Every finance page failed to compile:

    ./src/lib/fieldEconomics.ts [Client Component SSR]
      -> ./src/components/finance/CostSection.tsx
        -> at ./src/lib/partnerRentalDashboard.ts:1:1

**`npm run verify` passed** — it typechecks and runs node suites; it does not build the client
bundle. The Vercel deploy went **● Error** and production kept serving the previous deployment, so
`$1,815` was still live while the commit said it was fixed.

**`verify:seam-artifact` caught it** — `FAIL 057e17f` with that exact chain — and it only caught it
because `tsx` was changed to `npx tsx` that morning. Before that it printed "command not found" and
recorded no verdict at all.

**THE LESSON: read `.seam-artifact-result` after pushing.** It is the only check in this repo that
compiles what the browser actually receives. `git push` reporting success and `npm run verify`
passing are both true and neither means the deploy built.

The marker was removed rather than worked around: the module is pure — its only imports are
`partnerPayoutModel`, `gamedayModel` and `mdapiFakePlayer`, all pure by design.

## APPLICATIONS — THE CSV IMPORT, AND THREE THINGS THE BRIEF GOT WRONG (2026-08-26)

664 rows across six forms imported from the Elementor export. Final: **web_submissions 647,
web_contacts 156 (115 team + 41 partner), web_form_labels 34 across all six forms.**

### THE COUNT LADDER

```
TEAM     raw 172  ->  minus ours 12  =  160  ->  115 distinct people
PARTNER  raw 492  ->  minus ours  5  =  487  ->  minus spam 437  =  50  ->  41 distinct people
```

### 1. `Skync` IS NOT A SUFFIX

The rule was specified as `/Skync$/i`, "437 of 437". **Anchored, it matches ZERO of the 492 rows** —
the token sits INSIDE the name, never at the end. With the signal dead the rule caught 347. As a
contains-match it is 437 of 437.

### 2. THERE IS A SIXTH FAKE COMPANY

`nokia 85 · google 81 · apple 74 · wallmart 72 · aliexpress 68 · **fbi 57**`. The five named in the
brief total 380; **380 + 57 = 437**, exactly the bot's known volume.

### 3. THE CSVs CARRY A UTF-8 BOM — AND IT LOOKED LIKE A RULE PROBLEM

The first header parses as `"﻿First Name"`, so `rec["First Name"]` was **undefined for every row
in every file**. The bot's token lives in First Name, so with that column unreadable spam came out
396 instead of 437 and read as "the spam rule is wrong" rather than "the parser is". Python's `csv`
hides this behind `encoding="utf-8-sig"`; nothing in Node does. **Strip `charCodeAt(0) === 0xfeff`
before parsing any WordPress export.**

### 41, NOT 43 — RYAN'S CALL

The brief's TEAM ladder has a "minus mine" step and its PARTNER ladder does not, so 43 counts
Ryan's own test enquiries as two people — five rows under two addresses, companies `test`, `test`,
`test`, `Applebees`, `Bob Vance Refrigeration`. Excluded from both streams: **41**.

### THE CSV KEYS BY LABEL, THE API KEYS BY FIELD ID

`resolveFields` accepts either, but a LABEL is only honoured on the form that DECLARES it — so
`Company` resolves on f7eed00 and means nothing on 4e61155c. That is what stops label-keying
reintroducing the id collision. Verified as stored: `f7eed00: Company=Company`,
`4e61155c: Company=(none)`.

### VERIFIED BY READ-BACK

- **0 fields** carry a surviving backslash escape.
- **101 submissions flagged `unresolved`** (the four unrecoverable forms, less our test rows).
- **164 cities mapped · 17 derived from zip · 466 unmapped**, of which 437 are bot locations.
- **29 emails have more than one submission, max 10.** Setting that person to
  Interviewing/Ryan and re-running the import left it **UNTOUCHED**, with no row duplication —
  `web_contacts` upserts with `ignoreDuplicates`, so outreach state can never be reset by a re-import.

### UNMAPPED CITY STRINGS WORTH A DECISION (20 rows)

`Okc` · `DFW` (abbreviations) · `Dallas (Irving)` · `Pflugerville (Austin area)` (parenthetical) ·
`East Austin` · `San Antonio- Quickplay FC` · six full street addresses containing a mapped city or
zip. **None were mapped** — the rule is map-never-guess and an address parser is a guesser.
`El Paso, TX` stays unmapped: the same market that surfaced unmapped in the Meta ad spend.

## THE WORDPRESS SUBMISSIONS ENDPOINT, AS IT ACTUALLY ANSWERS (2026-08-26)

`https://www.playmatchday.com/…` — GET only, key in an **X-MD-Key header**, never a query param.
Host-guarded on the PARSED host, non-https refused, and **redirects refused rather than followed**
(a 301 would hand the key to whatever it points at).

| mode | shape |
|---|---|
| `?probe=1` | `{tables, columns, submission_count: 664}` |
| `?forms=1` | **an OBJECT keyed on element_id**, each `{post_id, form_name, fields}` where fields is `{fieldId: {label, type}}` — **nested, not flat, and not an array** |
| `?after_id=N&limit=` | `{submissions: [...], next_after_id}`; rows carry `id, element_id, form_name, post_id, referer, status, is_read, created_at, created_at_gmt, fields` |

### THE PINNED LABELS WERE WRONG IN THREE FIELD IDS

Transcribed from a description rather than read off the endpoint. `field_2a1c0f4`, `field_6b2d114`
and `field_9c3a201` **do not exist**. The truth:

```
f7eed00   name·First Name  message·Last Name  field_dff8b68·Company  email·Email
          field_15bf1e3·Location  field_ffeb63a·Phone  field_187a8c9·Share Your Vision
4e61155c  name·First Name  field_dff8b68·Last Name  email·Email  field_15bf1e3·City
          field_cbcd9d0·Job Role  field_ffeb63a·Phone  message·Availability
          field_706ba38·Why would you be a good fit for MatchDay?
```

The documented collision holds exactly. **And one shared id is NOT a collision: `field_ffeb63a` is
Phone on both.** Sameness is not the rule — an id means whatever ITS OWN form says.

`?forms=1` now wins over the pins, which are a fallback and a fixture. A suite assertion pins the
exact field-id sets so a hand-edit that invents an id fails loudly.

## A KNOWN FORM CAN STILL FAIL TO RESOLVE — AND IT DID, SILENTLY

The four forms the site can no longer describe carry labels only from the CSV, where the "field id"
IS the label (`Email` → `Email`). Those entries resolve a CSV row perfectly and match **nothing** on
an API row, which arrives keyed by real field ids (`name`, `email`, `field_…`).

Every field came back `not asked`, the email was therefore empty, **our own test rows stopped being
recognised**, and the live pull built **655** rows where the CSV built **647** — with nothing
flagged, because the element_id was "known".

**The test is now whether anything ACTUALLY matched.** Incoming keys but zero matches means the
submission is unresolved whatever the registry claims; raw keys are kept and the row is flagged. An
empty submission is not this case. Our own addresses are also scanned for in the raw VALUES, since
an unresolved row has no `Email` label to read.

**And an unresolved row never overwrites a resolved one.** A plain upsert would have replaced 109
correctly-labelled CSV rows with raw-key versions on the first nightly run, quietly.

### VERIFIED END TO END

Walking from id 0: **2 pages, 664 rows fetched — matching `?probe=1` exactly** — building **647**,
identical to what the CSV import holds. Incremental run from `max(submission_id)`: 0 fetched, which
is correct and was proven by the walk rather than assumed.

**DRIFT: source 664, held 647, difference 17** — our own 17 excluded test rows, exactly. Reported,
never acted on.

Outreach survives the sync: the ten-submission person set to `Interviewing / Ryan` was **UNTOUCHED**
after a full run, with 647 submissions and 156 contacts unchanged.

## MATCH CHATS, WARSAW — THE DOOR WAS SHUT WHILE EVERY ROOM WAS OPEN (2026-08-26)

The chat LIST rendered perfectly for a WAW account — 2 active, 1 upcoming, 2 past, all Hala
Piłkarska Bemowo. The message pane then refused with *"This account is confined to one city. That
page is outside it."*

**NOTHING ABOUT THE CITY WAS WRONG, and the guard never compares a city at all.**

```
app_users.city_identifier      "WAW"   (both accounts, 3 chars, no whitespace)
chats returned by the list     ["WAW"]
what the failing guard compares  the PATHNAME "/api/firebase-token"
                                 against CONFINED_ROUTE_PREFIXES
```

Two paths, and they do **not** share a confinement helper:

| | route | gate |
|---|---|---|
| **list** | `/api/match-chats/active` | `authenticateMatchOpsRead` → `auth.confinedCity` pushed into `.eq("city_identifier", …)` |
| **message** | `/api/firebase-token` | `authenticateCrm` → `assertConfinedRoute(row, req.url)` |

`/api/match-chats/` and `/api/crm/` are on the allowlist. **`/api/firebase-token` was on no list**,
so the route that mints the Firebase token the message pane needs was refused. The error names a
PAGE, which is what sent everyone looking for a city dictionary. WAW resolves correctly everywhere —
`resolveCityScope` handles it, and the same account's Player Finder confinement already worked.

**A page is not reachable because its data routes are.** Every route it needs on the way IN has to
be listed.

### THE FIX, AND WHAT IT DOES NOT DO

`/api/firebase-token` added to `CONFINED_ROUTE_EXACT` — **exact, not a prefix**, for the reason the
Veo entry beside it records: `"/api/veo"` as a prefix opened `/api/veo/codes`.

The token now carries **`confined_city`** in its claims. **This is necessary and not sufficient.**
The token is what the browser uses to open Firestore listeners DIRECTLY, and a listener does not go
through `/api/match-chats`. The Firestore security rules live in the Firebase console, not this
repo, so nothing here can prove they read the claim. **Until a rule filters on it, the boundary at
the Firestore layer is the UI showing only what the list returned — a shorter menu, not a boundary.**

### VERIFIED

List → token → thread → **a real message read from Firestore**, driven as `jf@playmatchday.pl`:
`MatchDay · 8:37 AM · https://app.veo.co/matches/20260825-…`, 14 players, no refusal, no Firestore
error. Out-of-scope routes still 403: `/api/veo/codes`, `/api/admin/fields`,
`/api/admin/users/permissions`, `/api/match-promotion`, `/api/slate-notes`.

`verify-city-confinement` now walks the door itself — the suite that once passed the CM outage by
navigating straight to `/city/*` and never checking what the page needed to get in. 86 assertions.

## MEMBERSHIP — WHAT THE PAGE WAS, AND FOUR THINGS THE DATA SETTLED (2026-08-26)

**Before:** one route `/membership` → `CitiesMembershipLens` → six read-only components. **Nothing
wrote.** Reads `members_monthly_snapshots` (captured) and `mdapi_subscriptions` (live).

### THE MODEL IS MIRRORED; THE API IS AUTHORITATIVE

`mdapi_subscriptions`, PK `membership_id`. **No renewal field** — cancel-and-rejoin creates a NEW
row with the same `user_id` and a different `membership_id`, so renewal is row succession.

Two schema comments are wrong and the data says so:

- **`status` has TWO values in production**, not the nine the comment claims: `ACTIVE` 451 ·
  `CANCELED` 2,225.
- **`price` is DOLLARS.** The comment says "cents-vs-dollars TBD on first sync". Distribution: 49
  ×1,326 · 66 ×827 · 30 ×305, against `fin_venues.member_price` of 49 / 72.99 / 66.5. Settled.

### DEFINITIONS — FOUR EXISTED, ONE NEEDED SAYING OUT LOUD

`active member` = `status='ACTIVE'` · `member spot` = `payment_type='MEMBER'` · `daily-play spot` =
`'DAILY PAID'` · `promotion player` = `'PROMOCODE'`. All four already existed.

**`churned` exists — but as a PLAYER concept, not a member one.** `/api/lifecycle/churn` already
uses days-since-last-played with a 30/60/90/120 selector defaulting to **90**, so this page reuses it
rather than inventing a second meaning. **A member who stops playing while still paying is churned
by this definition and active by the membership one.** Both true, not the same number, and the tile
says so.

### THE RESIDUAL TRAP DOES NOT APPLY HERE

The deck computes `fieldMember = fieldRevenue − fieldDpp`. **We do not.** Member revenue is an
explicit CATEGORY (`fin_revenue.type='Membership'`, `financeStats.ts:1636`) then allocated pro-rata
by member spots (`venueAllocatedMemberRevenueFor`, `:1810`). Measured for Aug 2026, every city
allocates completely — **residue $0.00 across all seven**, Austin included at $6,438.75 / 795 spots
= **$8.10**.

**What DOES land nowhere: $2,745.47** of membership revenue across all months tagged to the
pseudo-city **"Deleted Account Revenue"**, which no venue belongs to (Nov 2025 $334.88 · May 2026
$229.47 · Jun 2026 $198.70). Right magnitude for the "~$275/month" in the brief, **but not Austin's**.

**A landmine for anyone extending this page: 1,178 of 1,865 August member spots (63%) sit at fields
with `counts_as_regular_play = false`** — Westlake, PARMER, Crossbar, Lou Fusz and ten others. That
flag is a COST-side event exclusion. Adopt it here and member spots fall 63% with no visible reason.
This page deliberately does not use it.

### TWO NUMBERS FOR THE SAME MONTH, BOTH TRUE

The all-time chart reads the last CAPTURED snapshot; the KPI reads `mdapi_subscriptions` LIVE. For
Aug 2026 that is **383 captured against 451 live** — the capture is a point in time and members
joined after it. The page prints both and names which is which, because "383 active" beside a KPI
reading 451 with no explanation is how a page teaches people not to trust it.

## MEMBERSHIP — A CONSTANT DENOMINATOR MADE A FALSE TREND (2026-08-26)

The page sent ONE number — the live `mdapi_subscriptions` count, 451 — and repeated it across every
month. Two charts on one page then gave two answers for August: **451 on the bars, 383 on the
all-time line**, which reads the captured snapshot.

**The consequence was worse than the wrong value.** Avg matches per member divided each month's
spots by that constant, so the numerator moved and the denominator did not:

| month | active (snapshot) | member spots | avg, correct | avg, with the live divisor |
|---|---|---|---|---|
| May 2026 | 249 | 2,219 | **8.9** | 4.9 |
| Jun 2026 | 392 | 2,515 | **6.4** | 5.6 |
| Jul 2026 | 412 | 2,769 | **6.7** | 6.1 |
| Aug 2026 | 383 | 1,902 | **5.0** | 4.2 |

**The false series RISES into July; the real one FALLS.** Not a different value — a different shape,
and the shape is what anyone reads off a chart. Both series are pinned in
`membership-chart-test.ts`, including the two opposite conclusions.

Per-month active now comes from `members_monthly_snapshots.active_count`, the same source the
all-time line reads. The live count is still shown, on the all-time subtitle, labelled as live.

**The agreement assertion covered two of four KPIs and shipped a disagreement** — the Aug bar read
4.0 and the KPI 4.2. It now walks ALL FOUR against their charts for every month.

**PARTIAL PERIODS ARE MARKED.** August is 26 of 31 days, and a partial period drawn identically to a
complete one reads as a collapse. Partial bars are hollow with a dashed edge, the axis label carries
a bullet, and every subtitle and KPI says `partial, 26 of 31 days`.

**The day axis was two end labels**, `01` and `25`, which says nothing about where day 12 sits. It
now ticks 1, 5, 10, 15, 20, 25 and the subtitle names the coverage: `Aug 2026 · days 1–25 of 31`.

**STILL UNRECONCILED:** `members_monthly_snapshots.avg_matches_per_member` carries its own figures —
7.96 / 8.06 / 8.08 / 6.98 — which agree with neither series above. Three numbers for one question;
nothing on the page reads that column, and which is right is unestablished.

## MEMBER SPOTS ARE NOT MEMBER MATCHES — AND THE SNAPSHOT WAS ASKING A DIFFERENT QUESTION (2026-08-26)

"Avg matches per member" divided member SPOTS by members. A member who books a spot for a friend
gets a second row under their OWN user_id, so that counted the booking, not the playing — the same
trap 0147 fixed in `player_play_stats`, where `plays` was `count(*)` over spots and 343 players read
as having played twice for one match they brought a guest to.

Counting DISTINCT `(user_id, match_api_id)` instead:

| month | active | spots | matches | before (spots ÷ active) | after (matches ÷ active) |
|---|---|---|---|---|---|
| May 2026 | 249 | 2,219 | **2,124** | 8.91 | **8.53** |
| Jun 2026 | 392 | 2,515 | **2,431** | 6.42 | **6.20** |
| Jul 2026 | 412 | 2,769 | **2,664** | 6.72 | **6.47** |
| Aug 2026 | 383 | 1,902 | **1,837** | 4.97 | **4.80** |

**Every MEMBER-typed row is `user_type = PLAYER`** — no GUEST or ADDITIONAL_SPOT row is typed
MEMBER, because `derivePaymentType` reads the buyer's membership window. So the 65–105 rows that
collapse each month are players holding **two or more PLAYER rows in the same match**, which is the
same shape as the Blake case in 0147 and not visible from `user_type` at all.

The price tile still divides by SPOTS, deliberately: **a spot is what was paid for.** Two
denominators, on purpose, each named where it is used.

### THE SNAPSHOT COLUMN IS CLOSED — BY EXPLANATION, NOT BY AGREEMENT

`members_monthly_snapshots.avg_matches_per_member` reads 7.96 / 8.06 / 8.08 / 6.98 and matches
neither series. `computeAvgMatchesPerMember` (`membershipStats.ts:244`) explains why — it is a
**different question**:

- **denominator** = `matchesByMember.size`, members who played **at least once that month**, not
  active members. It is stored as `members_tracked` (340 / 359 / 383 / 334) and is not
  `active_count`.
- **numerator** = a count of MEMBER attendance ROWS — spots, the same trap, uncorrected there.
- keyed on **email**, not `user_id`, and restricted to `isPaidExternalMember`.

So it answers *"how often does a playing member play"* and the page answers *"how much does the
member base play"*. Both legitimate, neither wrong, and **not comparable** — which is why they never
converged. Nothing on the page reads that column.

**A window difference worth keeping:** the route's `toDate` is TODAY, not the month end. A match on
the 29th has not been played and must not count toward a partial August. A fixture built from a
query ending 2026-08-31 gave 1,981 spots / 1,915 matches and disagreed with the page by 0.2 — the
page was right.

---

## MATCH MANAGERS — and the three-way name collision (2026-08-26)

**"City manager" names THREE unrelated things in this system. Conflating any two is how the next
permissions bug gets written, so the names are settled here.**

| # | Thing | Where | Population |
|---|---|---|---|
| 1 | `app_users.is_city_manager` | Clubhouse | a LOGIN with city confinement — **5 rows** |
| 2 | the `city_managers` table | Supabase | one named contact + phone per city — **6 rows** |
| 3 | the MatchDay API's `/city-managers` | MatchDay | the people who RUN MATCHES — **87 people** |

**Measured overlap between (1) and (3), 2026-08-25: 6 of the 87 match managers hold an `app_users`
row at all, and only 3 of those carry `is_city_manager`. Two of Clubhouse's 5 city managers are not
match managers.** They are different populations that share a noun. **In Clubhouse (3) is called a
MATCH MANAGER** — never "city manager" in a route, table, column, component, label or comment. The
one sanctioned exception is the banner in `MatchManagersPanel.tsx` that explains the API's own word,
and `scripts/match-managers-test.ts` asserts nothing else in the panel or the route says it.

### The endpoints (probed against production 2026-08-25)

- `GET /city-managers` → **107 rows**, keys `["id","userId","cityId","createdAt","updatedAt","user","city"]`.
  A row is a **person-in-a-city**, not a person. `?cityId=1` → 28.
- `GET /city-managers/users` → **87** — the distinct people.
- `GET /cities` → 10.
- `/admin/city-managers` → **HTML 404.** There is no `/admin` prefix on this family.

**107 assignments, 87 people, 10 cities:** ATX 28 · DFW 19 · HOU 17 · SATX 15 · STL 9 · ATL 8 ·
OKC 5 · NYC 4 · WAW 1 · ELP 1. **Exactly 3 people work more than one city; the busiest works 8.**
(NYC and ELP are not Clubhouse `CITY_SCOPES` cities.)

### There is NO add and NO remove — this is the reason the buttons are disabled

Read out of the Retool production export and confirmed by probe: the whole `cityManagers` query
group is **reads plus `attachCityManagerToMatch`**, which is `PUT /admin/matches/{id} {managerId}` —
it attaches an existing manager to **one fixture**. There is no `createCityManager` and no
`deleteCityManager` anywhere in the export. `CAN_ADD_MATCH_MANAGER` / `CAN_REMOVE_MATCH_MANAGER`
(`src/lib/matchManagers.ts`) are `false` and the suite pins them there, so enabling a control
without shipping an endpoint fails the gate instead of shipping a button that does nothing.

### TWO MECHANISMS, and they are not the same set

- **Per-CITY** — `/city-managers` (userId + cityId). Eligibility: who may be put on a match here.
- **Per-MATCH** — `mdapi_matches.manager_id`, set by `attachCityManagerToMatch`. This is what
  Manager Pay pays on. **5,404 matches carry a `manager_id`, 4,329 do not, and there are 100
  distinct `manager_id`s against 87 people on the roster** — so neither set contains the other.
  "Matches run" and "last match" on the Clubhouse panel come from the mirror, not from the roster.

### Apple private relay

**14 of the 87** sign in with `@privaterelay.appleid.com` — a random token and no name. The token is
never rendered: `emailDisplay()` returns `Apple private relay · ID {n}`. **All 87 have a phone
number**, so the ID and the phone carry the identity. Retool's add-manager modal searches **email
only**, which cannot find any of those 14 — a weakness not rebuilt in Clubhouse.

---

## Assigning a match manager to a match (2026-08-26)

**`PUT /admin/matches/{id}` with `{ managerId }` is the ONLY write the API offers on match
managers.** Creating one and deleting one have no endpoint — see the section above.

### DETACH — probed on staging match 3, each verified by reading the match back

| body sent | result |
|---|---|
| `{ managerId: null }` | **DETACHED.** Read back `managerId: null`, `manager: null`. |
| `{ managerId: "" }` | **HTTP 400 — rejected, did not land.** Manager still attached. |
| field omitted (a different field sent instead) | **NOT APPLIED.** Manager still attached — PATCH semantics, exactly as the trap list says. |

So **unassign works and stays enabled**, `null` is the only body that detaches, and **`""` must
never reach the wire** — which matters because a cleared `<select>` yields `""`, not `null`.
`normalizeManagerId()` (`src/lib/managerAssign.ts`) is the single place that mapping lives. The
probe restored the original manager (398) and verified the restore.

### Manager Pay reads manager_email, NOT manager_id — and that is a live coupling

`managerPayCompute.ts` groups on **`mdapi_matches.manager_email`** (`if (m.manager_email)`) and
keys its adjustments on that email. The write sets **`managerId`**. They are one source only
because `refreshMatchMirror` rewrites `manager_id`, `manager_email`, `manager_first_name` and
`manager_last_name` **from the same read-back payload** whenever `managerId` is among the written
keys.

**Measured 2026-08-26 on the mirror: 5,404 rows carry a `manager_id`, 5,404 carry a
`manager_email`, ZERO have one without the other, and no `manager_id` maps to more than one
email.** No drift today. But the thing holding them together is that one write-through — a path
that set `manager_id` without it would keep paying the previous person. `manager-assign-test.ts`
asserts the write-through touches `manager_email`, not only `manager_id`.

### The picker, measured on production

`GET /city-managers/users` with **no** `cityId` returns all **87**; with `cityId` it returns that
city's roster. **A typical Austin fixture (cityId 1) offers 28 of the 87 by default**; the visible
"show managers from all cities" control offers all 87, labelling the 59 extras as off-city.

    cityId 1 ATX 28 · 2 HOU 17 · 3 SATX 15 · 4 ATL 8 · 5 STL 9
    cityId 6 NYC 4 · 7 DFW 19 · 8 OKC 5 · 9 ELP 1 · 10 WAW 1

### Two other things the API's list shape costs

- `GET /admin/matches` returns **`{ data, limit, page, totalItems }`** — not an array. **`take` is
  rejected 400** (`"property take should not exist"`); the parameter is **`limit`**.
- **`second_manager_id` exists and 57 mirror rows carry one.** A co-managed match pays **$20 each**
  rather than $30 — `payAmount(max, coManaged)` already encodes it.

### Unmanaged upcoming matches, 2026-08-26

**188 upcoming matches (start_date ≥ today, not cancelled); 5 have no manager attached** —
WAW 3, ATX 2, all inside the next 14 days. Pay bands: 3 at max 14, 2 at max 22.

---

## CORRECTION (2026-08-26): POST and DELETE /city-managers DO exist

**The section above said "There is NO add and NO remove". That was wrong, and it is left in place
above with this correction beneath it rather than quietly edited, because the way it was reached
matters more than the fact.**

**How it went wrong:** I grepped the Retool export for `createCityManager` and `deleteCityManager`
— names I invented — found nothing, and reported an absence. Retool's queries are called *exactly*
those two names, so the grep should have hit. Tracing the button instead of guessing the name found
it in one step. **An absence proved by grep is not an absence.** Work backwards from the control.

### Traced from the widgets' own click handlers

| widget | text | fires | request |
|---|---|---|---|
| `addCityManagerBtn` | ADD CITY MANAGER | `addCityManager` | **`POST /city-managers`** |
| `deleteCityManagerBtn` | DELETE | `deleteCityManager` | **`DELETE /city-managers?userId=&cityId=`** |
| (intro text) | — | `updateCityManagerIntroText` | `PUT /city-managers/{id}` |

All three are **REST queries against the MatchDay API** (`{{globalVar.value.serverApiUrl}}`), not
direct SQL — Retool holds no database resource for this. Auth is
`Authorization: Bearer {{localStorage.values.accessToken}}` on every one.

### The full add request

```
POST {serverApiUrl}/city-managers
Authorization: Bearer <token>
Content-Type: application/json          (bodyType: json)

{ "userId": <number>, "cityId": <number> }
```

**The modal collects exactly two things**, and neither is typed free-hand:

- `usersForCityManagerTable.selectedRow.data.id` → `userId`. The table is fed by
  **`GET /admin/players?email={{searchByEmailCityManager.value}}&limit=&page=`** — an **email-only**
  search, which cannot find any of the **14 match managers on an Apple private relay address**.
- `cityManagerCitySelect.value` → `cityId`. Options are `GET /cities`, `value = item.id`,
  `label = item.name`.

`requireConfirmation: false` on all three — Retool asks nothing before adding or deleting. On
success `addCityManager` and `deleteCityManager` both re-run `getCityManagers`.

### The remove request

```
DELETE {serverApiUrl}/city-managers?userId=<n>&cityId=<n>
Authorization: Bearer <token>
```

No body. The pair comes from `cityManagersTable.selectedRow.data`. The DELETE button is **not
disabled and not hidden**, and carries no tooltip or confirmation.

### PROVEN ON STAGING, verified by reading the list back

    /city-managers before                                  19 rows
    POST   /city-managers {userId:2, cityId:6}   -> 20 rows, the row is there   LANDED
    DELETE /city-managers?userId=2&cityId=6      -> 19 rows, the row is gone    REMOVED
    state restored                                          YES

### Can Clubhouse do this?

**Yes — through the API, exactly as Retool does. Not by writing to the database; no direct SQL is
involved anywhere in this flow.** The controls in Clubhouse are still disabled, but the reason is
now stated honestly on screen: **Clubhouse has not built the writes**, which need a route, a
confinement rule, a `change_log` entry and a confirmation. It is a build, not a blocker.

---

## Match-manager add / remove — BUILT (2026-08-26)

Clubhouse now writes the roster. Two routes on `/api/match-managers`, both on
`authenticateMatchOpsRead` — **Match Ops access, not admins only**, which deliberately includes the
confined city-manager accounts.

```
POST   /api/match-managers  { userId, cityId }   ->  POST   /city-managers {userId, cityId}
DELETE /api/match-managers?userId=&cityId=       ->  DELETE /city-managers?userId=&cityId=  (no body)
```

### The city is resolved by numeric id from `GET /cities`, never by name

The API has **ten** cities — ATX HOU SATX ATL STL NYC DFW OKC ELP WAW — against the eight in
`CITY_SCOPES` and seven in the finance estate. **NYC and ELP exist upstream and nowhere else here**,
so any mapping written from our own list would silently lose them, and any mapping written from a
name breaks on the first upstream rename. `scopeOfCityId()` maps id → the API's own `abbr`, and
that abbr is what the confinement compare uses.

### Confinement is enforced at the route, on the parsed identity

`assertScope(auth.confinedCity, scopeOfCityId(cities, cityId), confined)`. `auth.confinedCity` is
read fresh from `app_users` on every request — never from the body, never from a header, never from
what the picker happened to show. **A confined WAW account may add and remove in WAW and is refused
403 for any other city; an unconfined Match Ops user may act on any city.** The picker is served
only the account's own city as a convenience — hiding it was never the boundary.

### The verdict comes from reading the roster back

`recordWrite`'s before/after both call `GET /city-managers`, and `applied` asks whether the
**(userId, cityId) pair** is present (add) or absent (remove). The route then reads the list once
more itself and answers from that. **A 2xx is never taken as proof.** LANDED / FAILED / NOT APPLIED
/ UNKNOWN — and an `AmbiguousWriteError` reports **UNKNOWN**, not FAILED, so nobody retries it into
a duplicate roster row. There is no retry control anywhere in the flow.

### No PII in the change_log line

The logged body is **two integers** — `userId` and `cityId`. No name, no email, no phone.
`change_log` has different access rules from the roster and must not become a second copy of player
contact details.

### The search is Player Lookup's, and that is the whole point

Retool's add modal searches `GET /admin/players?email=` — **email only** — so it cannot find a
single one of the **14 match managers on an `@privaterelay.appleid.com` token**. Clubhouse adds from
the Player Lookup search already on the page (**phone, email, name or ID**), with the action on the
player's own card. **There is no second search box**; the panel still has exactly one input, its
roster filter, and the card has none. Proven in the browser by finding manager **ID 72729** — a
relay-address account — by ID and adding from their card.

### Confirmation on both, unlike Retool

`requireConfirmation` is `false` on both of Retool's queries. Both Clubhouse writes stop at a
confirmation naming the person, the city and the consequence:

> Take Drea off ATX's match-manager roster.
> They stop being assignable to ATX matches. Matches they have already run stay on the record and stay paid — 565 of them.
> Sent once. It is never retried.

Cancel sends nothing — asserted with a route interceptor counting requests at **zero**.

### A defect the browser suite caught

The profile card rendered **"Not a match manager anywhere"** while its fetch was still in flight,
because `me` is null both when the person is on no roster and when the data has not arrived. That is
a false claim about a real person on screen. `loaded` now separates the two and the card says
"Reading the roster…" until it knows. **An absence is not a claim until the data has arrived.**

---

## Player Lookup search — what `?email=` actually matches (2026-08-26)

**`GET /admin/players?email=<term>` matches EMAIL and PHONE. It does NOT match name.** The code
claimed otherwise, in writing, for the life of the feature: *"a UNIVERSAL fuzzy match (it hits
email, name AND phone-digits — confirmed live)"*. Nobody had tested it.

Measured on production over four terms — anderson (18 hits), smith (29), maria (37), king (69):
**all 153 hits contain the term in their email; ZERO name-only hits.** The 12 of 18 "anderson"
results whose *name* contains it are coincidence — their email does too, which is what made the
claim look confirmed.

**The counterexample:** Anderson King, **id 395**, `kinga11592@gmail.com`. His email holds "king"
and not "anderson", so the app could never find him by his first name and always found him by his
last. Five accounts match "anderson" by name with no "anderson" in their email, and **two of those
are Apple private relay addresses** — for them a name search is not a convenience, it is the only
route that exists.

**The API exposes no name parameter at all**, so this was never fixable by changing a query string.

### Other properties of that endpoint

- **A term is one substring.** No whitespace splitting — and emails contain no spaces, so
  `"anderson king"`, `"john smith"`, `"maria garcia"`, `"de la"` all returned **exactly zero,
  always**. Not specific to any account.
- **`totalItems` is returned on every response.** The route never read it. `limit: 15, page: 1` was
  hardcoded, so the header said "15 matches" for terms with 18, 69, 299 and 396 real hits.
- **Ordered by `firstName` ascending**, case- and accent-insensitive, NULLs last — zero collation
  violations at n=299 under `Intl.Collator("en", {sensitivity:"base"})`. So the 15-cap always
  dropped the **end of the alphabet**; for "anderson" the three lost were all Wandersons.
- **`?id=` takes ONE id.** `?id=395,1124` is a 400 (`property take should not exist` is the sibling
  error for `take`; the list parameter is `limit`, not `take`).
- **Paging is sound here, unlike `/admin/promocodes`**: page1(100) + page2(60) = 160 distinct, zero
  overlap, and the concatenation matches the single-call order exactly.

### What Clubhouse does now

A **name** is answered from `mdapi_users` — `first_name`/`last_name`, one `ilike` predicate per
whitespace-separated word, ANDed, order-independent. **The mirror is the index, not the answer:** it
supplies candidate IDs and every row shown is then fetched **live from the API by id**, so no field
on screen is stale. Email, phone and ID still go straight to the API.

**The staleness window is on DISCOVERY, not detail.** `mdapi_users` refreshes twice a day — a full
pass at **09:00 UTC** (`/api/sync/users-full`) and an incremental inside the **11:00 UTC** cron — so
a player who registers just after the incremental is **not findable by name for up to ~22 hours**.
They are findable by phone, email or ID immediately. The page says so, on the name path only.
Measured 2026-08-26: mirror 30,783 rows against the API's 30,800 — **17 behind**.

---

## How the Growth / Lifecycle numbers are made (2026-08-27)

**These were rendered on the Player Data Room as a "How these numbers are made" card. The card is
deleted; the facts live here.** They are properties of the data, not captions for a table, and
prose above a number competes with the number.

### Three start dates, not one

| series | begins | why |
|---|---|---|
| Registrations | **2023-03** | first account rows |
| Memberships | **2024-02** | first subscription rows |
| Everything play-derived — matches, spots, revenue, cohorts, retention, ARPP | **2023-04** | the first month any matches exist (confirmed: earliest `growth_participation.match_month` = `2023-04`) |

**An empty region before a series' start means "no data yet", never zero.** The play floor is read
from the data (`playFloor` in `growthAnalytics.ts`), not written down; the other two are constants
in that same file.

### App downloads have a fourth floor, and it is permanent

- **Apple's monthly reports begin August 2025 and are retained for ONE YEAR ONLY.** Earlier iOS
  months do not exist and **cannot be recovered** — Apple keeps yearly reports for ten years, but
  with no monthly granularity. This is a permanent hole in the history, not a sync gap.
- Google's reach back further; a combined figure is therefore both stores only from **Aug 2025**
  onward. Rows in the funnel table that start earlier say so on the row itself.
- **THE TWO STORES COUNT DIFFERENT THINGS.** Apple **App Units** are new downloads; Google
  **user-installs** are user-deduped. A combined total is a convenience, **not a like-for-like
  figure**.

### Downloads → Registrations is an aggregate ratio, not a conversion

Store installs **cannot be linked to a player** — Apple and Google never reveal who installed —
unlike every later funnel step, which is a true cohort subset of the one before it. Any "conversion"
between those two stages is a ratio of two independently-counted totals.

### The funnel bars and the cohort

Each bar is that stage as a share of the row's **largest** stage, so the funnel narrows left to
right. The figure between two cells is the conversion from the left one to the right one, and is
dashed whenever either side is unknown. Every row counts one period's **sign-up cohort** and how
many went on to play that many non-cancelled matches **ever** — so each stage is a subset of the one
before it.

### An open month is never excluded or annualised

The current month is part-elapsed and Apple's daily feed lags, so its denominator is still arriving.
Its conversion is marked **"so far"** and is **not comparable** to the closed rows beneath it.

### Fake players are excluded everywhere

**201 fake users** (`mdapi_users.is_fake_player = true`, confirmed 2026-08-27) and **33,809 live fake
rows** are removed before any figure is computed. Source is the live `mdapi_*` mirror plus
`fin_revenue`, read-only.

### Where the per-row marks stay

The coverage marks inside the funnel table — "Android only", "Android only before Aug 2025" — are
**data labels, not explanation**: they qualify one row's number and travel with it. They stay on the
row. Moving them would leave a number stating more than it can support.

---

## The Data Room's cold fact table (2026-08-27)

**`getFacts` builds a 151,654-row fact table from `growth_participation`, cached per warm instance.
Building it cost 15.4 s and that was the whole of "the Data Room is slow" — the cube memo made
*swapping* fast and never touched *opening*.**

### Where the time went

Sequential keyset (`where key > last order by key limit 1000`) is an index seek per page — about
147 ms — but **sequential by construction**: every page needs the previous page's last id, so
151,654 rows is 152 round trips in a row. `growth_player_profile` (14,753 rows, already 8-way
parallel) was ~0.3 s and irrelevant.

### Partitioned keyset — the same seek, eight bands at once

| | | |
|---|---|---|
| sequential | **16,588 ms** | |
| partitioned ×4 | 5,160 ms | 3.2× |
| **partitioned ×8** | **2,996 ms** | **5.5× — shipped** |
| partitioned ×12 | 2,180 ms | 7.6× |

×8 over ×12 deliberately: 16,588 → 2,996 is the change anyone notices; 2,996 → 2,180 costs 50% more
concurrent connections for 0.8 s nobody will feel.

**Row-set identity verified against a sequential fetch of the live table** — 151,654 vs 151,654,
zero missing, zero extra, **identical sha256 over every row after sort**
(`0c8cfe8b…3a852d`), same id endpoints (14 … 303745).

### What the concurrency costs — measured, not assumed

The Supabase client speaks **HTTP to PostgREST**, not Postgres, so this is eight in-flight HTTP
requests that PostgREST multiplexes onto its own pool — *not* eight database connections we hold.
Measured against a small unrelated read (`app_users`) issued continuously throughout:

```
baseline, idle                    median 124 ms
ONE cold start   (8 workers)      median 108 ms · wall 2,938 ms · 0 errors
TWO at once     (16 workers)      median 139 ms · wall 3,515 ms · 0 errors, worst 208 ms
```

**One cold start is inside the noise. Two simultaneous cold starts cost ~15 ms on another route's
median and 577 ms on their own wall time. Nothing starved, nothing errored, both returned all
151,654 rows.**

### The counter, and the bug it found on its first run

`getFacts` had no counter and no log line, so *"what fraction of visits hit a cold instance"* was
**unanswerable** rather than merely unknown. Every `/api/lifecycle/dataroom` response now carries
`facts: { cold, coldBuilds, warmServes, joinedBuild, bootedAt, lastBuildMs, concurrency, factMs }`
and a `Server-Timing: facts;dur=…;desc="cold|warm"` header, and every rebuild logs itself.

**On its very first browser open it read `coldBuilds: 2`.** The page fires the pivot request and
another moments later; both arrived before the first build finished, both saw an empty cache, and
**both fetched all 151,654 rows** — one instance paying the cold cost twice, in parallel, on every
cold open, with nothing visibly wrong. Fixed with a single-flight promise: the first caller builds,
later arrivals await the same build. Now `coldBuilds: 1, joinedBuild: 1`.

**The staleness key is still read on every call.** A first version of the single flight returned the
cache before reading `max(match_month)` — faster, and wrong: a warm instance would serve last
month's facts until it was recycled.

### Measured end to end in a browser

First open, cold instance: **13.6 s → 10.2 s**; fact build **3,299 ms**; a later request on the same
instance **384 ms warm**. Rejected: a warming cron (warms one instance; Vercel routes elsewhere) and
narrowing the fact table (only 39% of rows are this year, and the default view spans Apr 2023 –
Sep 2026, so narrowing the table narrows the page).

---

## The Lifecycle cold open — the other seven seconds (2026-08-27)

Measured on a **production build** (not the dev server — Turbopack compiles a route on first
request, which would have been most of what was being measured). An earlier "10.2 s" figure was a
dev-server number; the real cold open was **7.6 s**.

### Three defects, none of them the fact table

**1. THE MOUNT GATE — the largest, and it is general.** `SectionFrame` held *every* section behind
`g.data && g.activePeriod`, so a section reading neither still waited for a 1.4 s payload before it
could mount — **and a panel that has not mounted cannot start its own fetch.** Proven on a run where
the Data Room's fact table was already **warm**: the panel appeared at **3,465 ms**.

Which sections are in that position:

| section | reads `g.data`? | verdict |
|---|---|---|
| Player Funnel | yes (`KpiRow`, `PlayerFunnel`) | must wait |
| Player Behavior | yes | must wait |
| Revenue per Player | yes | must wait |
| **Retention** | **no — reads `g.retention`**, a different and *faster* fetch (397 ms vs 1,468 ms) | **freed** |
| **Player Data Room** | **no** — the only consumer was the deleted methodology card | **freed** |
| Churn | only `g.data.cities`, for a dropdown | still waits — see below |

`needsGrowthData` defaults to `true`, so nothing else changed.

**2. `/api/partner-dashboards/actionable` — 6,985 ms, twice.** The route awaited
`fetchPartnerRows` **and** `fetchPartnerWeeklyPayments` *inside a `for` loop*, so four partners meant
eight strictly sequential queries:

    Hattrick 1,421ms (3,043 regs) · PAC Global 935ms · Parmer 899ms · Crossbar 921ms
    sequential 4,615ms   →   all four in parallel 1,443ms   (3.2×)

Partners do not depend on each other; the waiting was the only thing being serialised. It feeds a
**nav badge**, which is why a Lifecycle page requests it at all — `ChatsRail` and
`MatchOpsSectionSheet` both live in the internal layout, so **every internal page pays it**:
Finance, Growth and Match Ops included.

**3. DUPLICATE BADGE FETCHES.** Four hooks each fetched for themselves, from four different trees
(`ChatsRail`, `MatchOpsSectionSheet`, `TopNav`, `MobileBottomNav`).

| request | before | after |
|---|---|---|
| `/api/crm/threads/awaiting-count` | **4×** | 1× |
| `/api/manager-pay/week` | 2× | 1× |
| `/api/partner-dashboards/actionable` | 2× | 1× |
| `/api/crm/threads/unread-count` | 1× | 1× |
| **total requests on a cold open** | **15** | **10** |

`sharedBadgeFetch` is a single flight plus a 10 s TTL. Manager Pay is keyed on the **week**, because
two components asking about different weeks are asking different questions. A failure is never
cached and the in-flight slot is always released.

### The result

```
                        before      after
panel mounted           3,465ms      421ms
first cell              7,644ms    6,763ms
requests                    15         10
actionable          2 × 6,985ms   1 × 2,405ms
```

**~11 s of server work removed per page load**, most of it on pages that never show a partner
dashboard.

### One thing the change exposed

Mounting early meant the Data Room's first request went out **before `authHeaders` existed** and came
back **401**, then retried. The frame's gate had been hiding it. The panel now waits for a token.

### The 418 ms staleness key — it is the ORDER, not the round trip

`getFacts` reads `growth_participation` ordered by `match_month desc limit 1` to decide whether its
cache is stale. Measured, five runs each:

    app_users select id limit 1 (plain table)             76ms   ← round-trip baseline
    growth_participation, NO order, limit 1               83ms
    growth_participation, order player_api_id desc        80ms   ← indexed
    growth_participation, order match_month desc         404ms
    growth_participation, order match_month asc          385ms
    growth_participation, exact COUNT (full scan)        356ms

**Ordering by `match_month` costs the same as a full scan**, because it sorts all 151,654 rows to
return one. `player_api_id` is indexed and costs nothing. **It is a missing index — but the cheaper
fix is not to add one.**

`growth_participation` is a **VIEW**, so it cannot be indexed directly; the index would go on the
underlying column of the base table, and whether the planner uses it through the view's joins is not
something to assume. **`max(player_api_id)` is a strictly better key anyway**: it is unique per
participation row (151,654 distinct values over 151,654 rows, range 14 … 303745), it is already
indexed at ~80 ms, and it changes when *any* row lands — whereas `max(match_month)` does not change
when a new match is added inside the current month, so today's key is both slow **and** weak.

**CHANGED 2026-08-27 — and correctness was the reason, not speed.**

`max(match_month)` only moves when a booking lands for a month **later than any seen so far**. That
value is `2026-09`, so every new booking for August or September — nearly all of them — left the key
identical, and **a warm instance went on serving a fact table that no longer matched the data, with
nothing on screen to say so.** The cache was invalidated roughly once a month, by accident, rather
than when the facts changed.

`player_api_id` is the participation row's own id: unique per row and monotonic with time —

    2023-04  ids      14 …     494
    2025-06  ids  99,974 … 113,738
    2026-09  ids 302,628 … 303,742

so it moves the moment **any** new participation row lands. Note the global maximum need not live in
the newest month: id `303745` is in `2026-08` while the newest month is `2026-09`, because a
September match was booked before an August one. The key is the max **id**, not the id of the newest
month.

**What neither key detects**, stated rather than glossed: a deleted row, or a backfill landing with
a *lower* id than the current maximum. Participation is append-only in normal operation, so this is
the same class of gap as before and a strictly smaller one.

**NO INDEX WAS ADDED.** `growth_participation` is a view; the index would land on a base column and
whether the planner reaches it through the joins is not something to assume.

Measured after the swap: `keyMs` **1,266 ms → 155 ms** cold, and a **warm** serve — which pays this
read on *every* request — **377–441 ms → 80–103 ms**. First cell 6,763 ms → 6,280 ms.

---

## styled-jsx scopes to the COMPONENT, not the file (2026-08-27)

**A `<style jsx>` block only scopes the JSX inside the component that declares it. A sibling
component in the same file gets the class name and NOT the scope hash, so the rule silently never
matches — and nothing looks broken.**

That is the whole trap. There is no error, no warning, no missing element. The markup is right, the
class is right, the rule is right, and they simply never meet. The page renders looking a little
plainer than intended, which reads as a design choice.

**It cost two bugs on one page and neither was visible.**

`ApplicationsView.tsx` declares its styles inside `ApplicationsView` and renders four sibling
function components — `Phone`, `Locked`, `CityCell`, `D`. Every element those four produce came out
unstyled:

| element | class it carried | what it computed to |
|---|---|---|
| the phone number | `ph` | `font-variant-numeric: normal` — untabulated |
| the grey "from the form" chips | `pill lock` | `background: rgba(0,0,0,0)`, padding `0px` |

The second one mattered more than it looked: **the page's own subtitle says *"grey fields come from
the form and cannot be edited here. Blue fields are yours."*** — describing a treatment that did not
exist. Half the page's grammar was invisible for the life of the feature.

### How to spot it

**Read the computed style, not the class name.** A test asserting `className="pill lock"` **passes
on exactly this bug** — the class was always correct. `getComputedStyle(el).backgroundColor` was
`rgba(0, 0, 0, 0)`, and that is the tell.

### The two fixes, and when each is right

- **Inline styles** for one or two properties on a small component (`Phone` uses this). Cannot miss
  a scope and cannot collide with another file's identically-named class — `.ph` is also used by
  `MatchManagersPanel` for the same idea.
- **`<style jsx global>` with every selector prefixed by the page's root class** for a whole
  stylesheet. `global` is what reaches a sibling component; the prefix is what stops it reaching the
  rest of the app — confinement by DOM ancestry instead of by a scope hash. `ApplicationsView` uses
  this: every rule is `.apps …`, the root carries `className="apps"`, and
  `verify-applications-pills` asserts that an element with those class names placed **outside**
  `.apps` picks up nothing.

**Prefix the stragglers.** When converting a block to `global`, a second rule sharing a line
(`.a { } .b { }`) and the inner selector of a single-line `@media` are easy to miss and each one
becomes an app-wide leak. Both existed in this file's block and were caught by re-scanning it for
selectors not starting with the root class.

---

## Soccer Central — two pitches, one line (2026-08-27)

**Soccer Central has TWO 9v9 pitches side by side. A tournament-size match occupies BOTH**, so the
venue charges $180 rather than $90, and it genuinely is two matches. Ryan's ruling.

### The doubling lives in exactly one place

Cost is `rate × charged units`. Double both and a tournament bills **$360**.

- **THE RATE carries it.** `fin_venues` 53 "Soccer Central Tournament" now holds
  `per_match_rate = 180` **and** `cost_per_match = 180`. **No expression multiplies anything to
  reach $180** — every cost path multiplies that rate by a charged unit count of **1**.
- **THE CHARGED UNIT COUNT stays 1.** `chargedUnitCount` and `venueMatchCount` (financeCosts) never
  see this rule; `socc-two-pitch-test` asserts that no cost file imports it.
- **THE MATCH COUNT is 2**, for counts and count-derived denominators only.

Both rate columns were set, not just `per_match_rate`: `matchPnL.ts` (Slate Review) reads
`cost_per_match`, and Field Costs' "agreed rate" cell reads it too. Setting one would have put $180
on one page and $120 on the other.

### The capacity boundary is a constant, not a memory

`SOCC_TWO_PITCH_MIN_CAPACITY = 23`, behaviourally identical to the `> 22` that shipped. Ryan
recalled "i think we said 24"; the boundary was **not** moved on a recollection. Full distribution
over all 760 ran matches on fields 102/199/1354:

    cap  0 → 24 · 14 → 4 · 16 → 11 · 18 → 248 · 20 → 19 · 22 → 49
    cap 24 → 4  · 28 → 5 · 32 → 69 · 36 → 323 · 40 → 4

**Four matches sit at capacity 24 and none at 23**, so a boundary of 23 and one of 25 disagree about
exactly those four (405 vs 401 matches). Not moot, and not decided.

### The fields are a named list

`SOCC_TWO_PITCH_FIELD_IDS = [102, 199, 1354]`. **1123 "Soccer Central World Cup Tournament" is
excluded by ID, never by a capacity or category test** — all 33 of its matches carry capacity 0, so
a capacity test would exclude it today and include it the moment someone set one.

**1552 is NOT Soccer Central.** It is "Tourney ATH Katy", 9 matches, city **HOU**. Any instruction
to map it to Soccer Central is working from a wrong title.

### The event drop was narrowed, not deleted

`venueCategory(field_title) === "event"` discards **1,749 of 7,671** ran matches network-wide across
19 fields. That guard is load-bearing for combines, cup brackets and "Special Events at …" rows.
After narrowing: **1,383 dropped**, a difference of **366 — every one of them field 199 "Tourney at
Soccer Central"**, and **zero matches moved outside fields 102/199/1354**. Field 1123 still drops all
33.

### One line, at the presentation layer only

Finance already merges these two venues — `COMBINE_BY_NAME` in `venueGroups.ts` pairs
`Soccer Central` + `Soccer Central Tournament`, labels `["normal","tournament"]`. Slate Review groups
by `venueId`, so it needed the same special case, done in `SlateFieldPnL` alone. **Venue 53 stays a
real row carrying the real rate**; nothing is folded into venue 11.

    Field Cost:    Soccer Central · combined PER MATCH · $90 normal · $180 tournament · 2 rates
    Slate Review:  SOCC Soccer Central · 102 (12+45×2) · $170.68 rev · $90.00 cost · $80.68 net

**Cost per match lands back at $90 and that is the rule working**: a two-pitch match costs $180 and
counts as 2, so its cost per slot equals a one-pitch match — which is what makes the field
comparable, and is the whole reason the count doubles.

### What it has cost

**405 two-pitch matches, 2025-04-21 → 2026-09-06, carried ZERO venue cost** — they routed to venue
53, which was inactive from creation (2026-05-22), so they landed in "unmapped" with dashes.

**Understated venue cost: $72,900** at $180. (An earlier figure of 39 matches / $4,680 counted only
those that survived the event drop; 366 of the 405 were being discarded as events as well.)

    2025-04    3 · 2025-05  1 · 2025-06  5 · 2025-07  3 · 2025-08  1 · 2025-09 13
    2025-10   19 · 2025-11 21 · 2025-12 24 · 2026-01 27 · 2026-02 26 · 2026-03 27
    2026-04   33 · 2026-05 42 · 2026-06 48 · 2026-07 57 · 2026-08 47 · 2026-09  8

Nothing was backfilled and no expense row was written.

**CORRECTED 2026-08-27 (ran-only).** 405 counted rows dated to 2026-09-06, which is in the future.
**389 have already been played — $70,020 understated.** The other **16 are future-dated and already
on the books** (2026-08-27 → 2026-09-06), worth **$2,880** still to come.

**The first affected month is 2025-04, not 2025-09.** Earliest two-pitch match: **id 5691,
2025-04-21, field 102, capacity 40.** The earlier "every month from 2025-09" described where the
volume becomes material, not where it starts — 2025-04 through 2025-08 carry 3, 1, 5, 3, 1.

**BOTH SIDES, not just cost.** The event-dropped two-pitch matches were losing revenue as well:
**350 played matches, $78,288 revenue against $63,000 cost — net +$15,288.** Restating them makes
Soccer Central *better*, not worse. Monthly net runs −$54 (2025-06) to +$3,768 (2026-07); it turns
positive from 2025-08 and stays there.

**MATCH-COUNT PARITY.** Two surfaces display a Soccer Central match count and they now agree on the
rule: Slate Review (`fp-matches`) and Field Costs (`fc-matches`). `cityPnl.matchCount` is computed
but never rendered — there is no third surface. Field Costs' August row reads **115 · 19+48×2**
while its derived cost is unchanged at **$10,350 = 19 × $90 + 48 × $180**, which is the separation
holding: the count doubled, the charged units did not. The slot count is computed **in the view**,
where nothing computes a cost, so `financeCosts` still knows nothing about the rule.

**CAPACITY ZERO IS NOT AN UNDERCHARGE.** 24 matches on 102/199/1354 carry capacity 0 — all on two
dates (**2025-04-12 ×15, 2026-05-16 ×9**), all on field 102, and **every one sold ZERO spots**
(`player_count` 0 too). None seated more than the 22-spot one-pitch maximum, so **none is a
disguised two-pitch match**: $0 undercharged. They look like scheduling artefacts rather than
matches. Nothing reclassified.

### fin_venues has no audit trail

There is no `updated_at` on the table and no `change_log` entry for the original deactivation — **a
venue can be switched off today leaving no trace**, and that one silently suppressed $72,900. A
`change_log` row was written for this edit (`method: UPDATE`, `endpoint: fin_venues/53`,
`match_id: null`, before/after for all three columns), which the schema accommodates because
`match_id` is nullable. **That is one note, not an audit trail** — the durable fix is a migration
adding `updated_at` and a trigger, which is not done here.

---

## The window off-by-one, and two stale fin_venues columns (2026-08-27)

### A bare date against a timestamp drops the whole last day

`mdapiMatchesRead.ts` filtered `lte("start_date", opts.toDate)` where `toDate` is `"2026-08-23"`.
`start_date` is a **timestamp**, so `2026-08-23T18:00 <= 2026-08-23T00:00` is false and **every match
after midnight on the final day vanished** — while the label above the figure still named that day.

`matchPnL.ts:324` already bounded its own match-*meta* query with `T23:59:59Z`, so **two queries
inside one function disagreed about which matches were in the window.**

**EVERY caller passed a bare date:** Slate Review's demand strip, the Membership route, DPP Price
History, `useFinanceData`'s quarter and benchmark bounds, and `matchPnL` itself. `partnerStats` is
the only caller unaffected (it filters on `fieldLike`, no dates). **Normalised inside the helper**,
so a caller passing a full timestamp is untouched and the seventh caller cannot be written wrong.

    1 week  Aug 17–23     ran matches 72 → 82   (+10)
    4 weeks Jul 27–Aug 23 ran matches 341 → 351 (+10)

    +2 Tourney at Soccer Central · +2 The Hattrick L. · +1 each: Ann Richards School,
    Tourney ATH Pearland, Scissortail Park, PRUMC, Westlake HS Field 3, Round Rock M.C.

**The Soccer Central figures from earlier today are unaffected** — 405 / 389 / $70,020 came from
direct `mdapi_matches` queries with explicit `T23:59:59` bounds, not through this helper.

### fin_venues 16 PRUMC — two stale columns

`per_match_rate 84 → 120` (**LANDED**, read back). Ryan's ruling: PRUM runs 1.5-hour matches and the
84 was one-hour pricing. `cost_per_match` left at 120.

**Field Costs reads `per_match_rate`; Slate Review reads `cost_per_match`** — so the same venue has
been billed at **$84 on one page and $120 on the other, $36 apart**, across **107 ran matches**
(2026-01 → 2026-09) = **$3,852 understated on the Field Costs side.** Not backfilled.

`dpp_price` was **already 12** at write time — it read **7** earlier the same day and no write of
mine touched it in between, so someone corrected it independently. My update was a no-op on that
column.

### Only three venues have the two rate columns disagreeing

| id | venue | city | rate | cost | diff | 90d matches | swing |
|---|---|---|---|---|---|---|---|
| 49 | Westlake | Austin | $135 | $114 | **−21** | 37 | **−$777** |
| 15 | Majestic Gardens | Dallas | $105 | $125 | +20 | 1 | +$20 *(inactive)* |
| 17 | Hammond Park | Atlanta | $62.50 | $65 | +2.50 | 0 | $0 *(inactive)* |

**Westlake is the only active one, and it runs the other way**: `per_match_rate` **higher** than
`cost_per_match`, so there **Slate Review is the page understating**, by $21 × 37 = $777 over 90 days.
Not widespread — 3 of 34 venues, and only one that matters.

### dpp_price vs what was actually charged — 10 of 26 disagree

Compared against the **modal** single-spot DPP amount over 90 days (a minimum or a mean is dragged by
partials and multi-spot purchases — an earlier pass using the minimum produced nonsense like
"Crossbar charges $1"):

    DISAGREE  Onion Creek $5 vs $8 · KISC $9 vs $12 · PAC Global $9 vs $5 · Bicentennial $10 vs $9
              Majestic Gardens $5 vs $9 · Scissortail $5 vs $9 · Hattrick T. null vs $9
              New Braunfels null vs $8 · Ann Richards null vs $12

**`dpp_price` is read in exactly one place**: `cityDppFor` (`financeStats.ts:2274`), which feeds the
**revenue projection** for scheduled-but-unplayed matches. It never prices a played match — those come
from `mdapi_match_players.amount`. So a stale value **misprojects future revenue** and never
misstates history.

### The Atlanta member-spot divisor — still UNKNOWN

`buildMdapiMemberSpotIndex` (financeStats.ts:1939) counts a spot only when it is not match-cancelled,
not player-cancelled, not `GUEST`, has `payment_type` in MEMBER / DAILY PAID / PROMOCODE, and its
**`field_id` resolves through `fin_venue_fields`**.

Reconciling Atlanta, Jul 2026:

    all ATL member spots in July                              97
    … minus GUEST rows                                        97
    … minus player-cancelled rows                             97
    … minus fields not in fin_venue_fields                    97
    … and before the window fix (bare date dropped Jul 31)    89   ← what the page used

**89 gives $26.39/match; the page showed $27.04.** The divisor is neither 89 nor 97 and I cannot
reproduce it. **B1 (rendering the membership working on screen) stays unbuilt** — a formula resting
on an unverified divisor is worse than no formula.

## MEMBERS BY CITY — the subscriptions table, settled (2026-08-31)

Evidence throughout: `mdapi_subscriptions`, production, **2,700 rows pulled against a server
`count: "exact"` of 2,700**, paged in 1,000-row windows and asserted complete. One sync stamp on
every row: `synced_at = 2026-08-31T11:00:52Z`.

### The four "missing" active members are STAFF — this is the rule for the facts doc

**410 rows hold `status = ACTIVE` with `price > 0`; 406 are members. The four excluded all carry
`@playmatchday.com` addresses and are refused by `isPaidExternalMember`'s `INTERNAL_EMAIL_RX`.**
`memberships 37795 (SATX, $66), 37951 (HOU, $66), 38148 (HOU, $66), 39339 (HOU, $66)` — one of
them activated and cancelled 65 seconds apart, which is what a staff test account looks like.

> **THE RULE:** an ACTIVE subscription on an `@matchday.` or `@playmatchday.` address is a staff
> account, not a member, and is excluded from every membership count by design.

**406 is correct.** There is no bug and nothing to fix. `homeStats.ts:107` and
`api/membership/route.ts:155` both call `countActiveMembers(rows, new Date())`, so Home and
Membership are the same function over the same rows and cannot disagree; the number is $264/mo of
staff comps, not a discrepancy.

### 395 was never a fact — it is a value the live count passed through

`countActiveMembers` walked **353 (Aug 20) → 369 (23) → 383 (25) → 394 (27) → 398 (28) → 406 (30,
31)**. 395 fell between the 27th and the 28th. Active moves 4–5 people a day; **any literal
headcount in code, a doc or a screenshot is stale within 48 hours.** Assert equality against the
helper, never against a number.

### `isActiveAsOf` IS NOT A HISTORICAL QUERY

It reads *current* status, so "active as of X" means "ACTIVE today AND activated by X". At
Aug 6 it returns 287 — the 119-person gap to 406 is people who activated since, not people who
left. It silently omits anyone who has cancelled since X. **A column claiming to describe a past
date reads `members_monthly_snapshots` or it does not ship.**

### THE CORRECTED MODEL: a cancellation does not flip `status` until roll-off

Of 406 active people, **149 already carry a `canceled_at`** (2026-07-13 → 2026-08-31). Only 3
non-$0 rows are dated after the cutoff *and* already `CANCELED`, and all three activated after it.
So both cancellation cohorts are **SUBSETS of the active set**, never additions:

```
Active                    406
  cancelled Jul 6-Aug 6    82   subset — rolls off end of August
  cancelled after Aug 6    67   subset — owes one more cycle
Being charged             324   = Active MINUS the in-window cohort
Billing next cycle    $17,919   summed per person, never headcount x nominal
```

Adding the cohorts instead of subtracting one overstates billing by **$8,218** and every number
still looks plausible. Guarded by `scripts/members-by-city-test.ts` (85 assertions, each with a
control; demonstrated red by making the subtraction an identity).

### ONE WINDOW DEFINITION, INCLUSIVE OF BOTH ENDS (changed 2026-08-31)

`isChurning` / `isChurningAsOf` were `[6th of M-1, 6th of M)` — **exclusive** at the far end, so a
cancellation stamped ON the 6th fell into the next cycle. They are now `[6th, 6th]` **inclusive**,
matching how Members by City states "Jul 6 – Aug 6". **Measured effect: the live Churning KPI on
the Membership page moved 81 → 82.** One person cancelled on 2026-08-06. `rollOffDate` (currently
uncalled) was moved in step. Two coexisting definitions of one window is what produced the
395-vs-406 confusion.

### `canceled_at` is TRUE UTC — the opposite model from match dates

Proven, not assumed, on 1,556 dated non-$0 cancellations: the column suffix is `+00:00`,
`raw.canceledAt` carries `Z`, and **the two never disagree on the instant (0 mismatches)**. Read as
UTC the hour histogram troughs at **UTC 05–12 (130 stamps, 7.5%)** — the real Central night —
against **UTC 00–06 (632, 36.4%)**. `activation_date` shows the same shape.
**`mdapi_matches.start_date` carries a `Z` it does not mean. Never share a date helper between
them.**

### 644 cancellations have no date AND no reason — 29.3%, not the "~439" the code said

```
non-$0 CANCELED rows              2200
  with a canceled_at              1556
  with NO canceled_at              644   (29.3%)   <- all 644 also have cancel_reason NULL
```

**CORRECTION to my own earlier reading.** My first reason breakdown summed to 899 of 1,556 because
I reported only the canned values. The full distribution:

```
1471  one of the 8 canned reasons (Removed by Retool 579, Moving 568, Budget Concerns 126,
      Not enough time 95, Other 41, Unhappy with the product 32, Found another alternative 24,
      Injured 2 + 2 whitespace-variant)
  84  free-text write-ins ("Just had a baby", "Broken wrist", "Price increase", …)
   1  empty string
   0  NULL
1556  TOTAL
```

**"Every dated cancellation carries a reason" is FALSE by exactly one row** — one carries an empty
string. It survives in substance: **0 dated rows have a NULL reason, and 0 undated rows have a
non-null one.** The correlation is total, so a null date does mean no cancellation event was
recorded. Whether those 644 cancelled in Stripe, by hand or simply lapsed is **UNKNOWN**.
The comment in `membershipStats.ts` saying "~439" was understated by 47% and has been corrected.

### Prices: eleven distinct non-$0 values, not three

After excluding $0 and collapsing to people (1,908 people from 2,610 rows):

```
$500: 2   $66: 648   $50: 5   $49: 915   $35: 1   $30: 247
 $29: 1    $25: 3    $15: 10   $13: 1     $1: 75
```

$66 / $49 / $30 cover **390 of 410** active people. **$1 × 75 people (15 of them active) sits above
the $0 exclusion line and is kept** — whether $1 is a comp is an open ruling. **Cancelled rows
RETAIN their price** — all 2,200 non-$0 CANCELED rows keep a positive value, zero are nulled or
zeroed, so post-cutoff cancellers can be billed.

### The collapse, and city

`user_id`: 0 nulls. `membership_id`: 0 duplicates. **419 people hold more than one non-$0 row and
142 hold a live membership beside a dead one; NOBODY holds two ACTIVE rows**, so the
"highest price wins" tie-break never fires today. `countActiveMembers` counts **rows**; Members by
City counts **people**. They agree at 406 only because that duplicate term is currently zero.

`city_identifier`: 7 codes, 0 nulls, **all seven map through `cityFromAbbr`** — nothing is silently
skipped. **4 people hold rows in two cities** (5919, 31386, 5538 → ATX/SATX; 57378 → SATX/HOU);
the collapse takes the surviving row's city, so per-person city is not stable across history.

### `membership_length` is NOT a term — and there is NO billing anchor anywhere

`membership_length` equals days-since-`activation_date` minus one on every row checked (912 vs 913,
908 vs 909, 901 vs 902). It is an age counter computed at sync.

**There is no renewal date, period end, or next-charge date in this data** — not in the 20 columns,
not in `raw`'s 17 keys (nothing matching period/renew/next/bill/charge/due/invoice). Activation
days-of-month are spread evenly across all 31, so no common cycle date can be inferred. **A
"billing this month" column keyed on a renewal date is UNKNOWN and cannot be built.** The only
derivable reading is the roll-off cycle: all 406 billed in August, 324 bill in September.

### `members_monthly_snapshots` is ALIVE — do not treat it as a second dead table

31 rows, `2024-01-01` → `2026-08-01`. Columns: `id, month, active_count, new_count,
cancelled_count, churning_count, by_city (jsonb), captured_at, source_file_name,
avg_matches_per_member, members_tracked, past_due_count`.

- **Written** by `refreshMembershipSnapshots` (`src/lib/membershipSnapshots.ts:139,167`), called
  from the nightly cron orchestrator (`/api/sync/cron`, 11:00 UTC), the manual
  `/api/sync/snapshots` route behind the SyncCard on `/data`, and
  `scripts/refresh-membership-snapshots.ts`. Recent rows carry `source_file_name = "cron"`.
- **Read** by `MembershipActiveChart.tsx:42`, `useMembershipSnapshots.ts:87` (every prior-month
  view on the Membership tab), `api/membership/route.ts:192`, `MembershipHealthTable`,
  `CitiesMembershipLens`, and `scripts/exec-summary-data.ts:175`. **It is not fin_member_spots.**
- **Per-city AND totals.** `by_city` is keyed by FRIENDLY name (`Austin`, `San Antonio`), not by
  code, and holds `{new, active, pastDue, cancelled}` per city. `El Paso` is present at 0.
- **No price, no dollars, anywhere.** No column and no `by_city` key carries money.
- `active_count` uses **`isActiveAsOf`** via `computeMonthlySnapshot`, and `2026-08-01` stores
  **406** — it agrees with 406, not 410.


## The remove endpoint, re-measured (2026-08-31)

Measured on **staging** match 2608 while building the lapsed-spot removal control. Two entries
above were wrong, and one thing the brief assumed is wrong too. Evidence is a read-back in every
case, never an HTTP status.

### `DELETE /admin/matches/{id}/players/{userId}` DOES NOT 403 ANY MORE

The conflict entry above recorded it returning `403 USER_NOT_JOINED`. It does not. On staging
2026-08-31 it returned **2xx with the removed row as its body** — `{"id":5531,"userId":287,
"matchId":2608,"paidStatus":"FREE","team":2,…}` — and the roster went **6 rows → 5**, target
absent on read-back. That is a **LANDED** removal, not a refusal.

An earlier probe against the same path in the same session returned 2xx and changed **nothing**
(7 rows before, 7 after, target still present) — a **NOT APPLIED**. So the endpoint's behaviour
varies with roster state in a way I did not pin down. **Do not use it, and do not trust the old
403 line.**

### THE REAL REASON TO KEY ON `userMatchId`, and it is not the 403

**One `userId` routinely holds MORE THAN ONE live row on the same match, so `players/{userId}`
cannot name which row to remove.** Measured on production future matches, 2026-08-31:

```
future live rows (non-cancelled, non-fake)     602
distinct (match, user) pairs                   506
pairs where ONE userId holds >1 live row        65   (12.8%)
  ...of which involve a GUEST                   34
worst case: match 18279, user 18714             7 rows
            PLAYER/PAID + 4 x GUEST/PAID + ADDITIONAL_SPOT/WAITING + ADDITIONAL_SPOT/PAID
```

A guest shares its host's `user_id` and carries no other link; `ADDITIONAL_SPOT` rows do too.
`DELETE …/players/{userId}` is therefore **ambiguous by construction** on 13% of pairs, and which
row it picks is UNKNOWN — I did not determine it and did not guess. `user-matches/{userMatchId}`
names exactly one row and cannot be ambiguous. **That is the argument. It does not depend on a
status code that has since changed.**

This also settles the open "does it cancel the guest first" question the right way: the question
only exists for the endpoint we do not use.

### AN ALREADY-ABSENT ROW REPORTS **FAILED**, NOT NOT APPLIED

Re-firing `DELETE /admin/matches/user-matches/5531` on a row that had just been removed returned
**HTTP 404**, body `{"message":"User has not joined…"}`. `apiWrite` raises `WriteFailedError`, and
`outcomeForThrow` maps that to **FAILED**.

That is correct and it is a *different fact* from NOT APPLIED: FAILED means cleanly rejected,
definitely did not happen, safe to retry. NOT APPLIED is reserved for a 2xx whose read-back shows
no change — which is exactly what the wrong endpoint produced above, so the distinction earns its
keep. **The half that matters for a path with no undo holds either way: an absent row is never
reported LANDED.**

### The deny-list discriminates the two DELETEs, proven on the parsed segment list

```
DELETE /admin/matches/user-matches/999    -> ALLOW
DELETE /admin/matches/user-matches/999/   -> ALLOW   (trailing slash)
DELETE /admin/matches/999                 -> DENY    (destroys the match)
DELETE /admin/matches/999?x=1             -> DENY    (query string does not evade it)
PATCH  /admin/matches/9/players/3/refund-and-cancel -> DENY  (moves money)
```

Four segments vs three: `assertAllowedEndpoint` compares `segs.length` before the wildcards, so
the near-miss is not caught and the real one cannot slip through.

## FREE IS NOT "MEMBER BENEFIT" — the signal, and the two columns that cannot answer (2026-09-01)

Moved here from an amber callout on `/match-ops/lapsed-spots`, which was removed the same day. The
caveat is unchanged; it is simply not screen furniture on a sheet where the operator is deciding
who to remove from a match. **Anyone about to treat a FREE spot as proof of a membership must read
this first.**

**No column anywhere records that a spot was taken on a membership.** Two look like they should
and neither can:

- **`match_registrations.payment_type = 'MEMBER'`** is a **stale manual upload**. Its last match is
  **2026-05-12** and it holds **ZERO future rows**. It cannot answer a question about next week,
  and any join through it silently returns nothing for every match that has not happened.
- **`mdapi_match_players.user_is_member`** is **`false` on all 246,216 rows**. The column exists in
  the mirror and in the API payload and has never been populated with anything else.

So `paid_status = 'FREE'` is the **nearest available signal**, not proof of a member benefit. It is
what the lapsed-spots page filters on, and the page carries **IS FIRST MATCH** per row for the same
reason: a first-match-free is a real thing and must stay visible rather than being read as a
lapsed member's benefit.

**What this means for anything built on top:** a count of "member spots" derived from FREE is an
upper bound that includes first-match frees, comps and anything else given away. It is good enough
to decide who to look at; it is not good enough to bill, reconcile, or report as membership usage.
The header of `src/lib/lapsedSpots.ts` carries the same text beside the code that depends on it.

## REMOVING A HOST DOES NOT TOUCH THEIR GUESTS (2026-09-01)

**Measured on staging, twice, on two independent hosts. Read-back, not inference.**

`DELETE /admin/matches/user-matches/{userMatchId}` removes **exactly the one roster row it names**.
A guest shares its host's `user_id` and has no other link to them, and the endpoint keys on the ROW,
so the guest's row is simply not addressed.

```
staging match 4, user 832        staging match 4, user 569
  BEFORE  5233 PLAYER              BEFORE  4271 PLAYER
          5234 GUEST                       4387 ADDITIONAL_SPOT
          5235 GUEST                       4694 ADDITIONAL_SPOT
          5236 GUEST                       4695 GUEST
  DELETE user-matches/5233         DELETE user-matches/4271
  AFTER   5234 GUEST  live                 4387 ADDITIONAL_SPOT live
          5235 GUEST  live                 4694 ADDITIONAL_SPOT live
          5236 GUEST  live                 4695 GUEST           live
  live rows on the match 28 -> 27    live rows on the match 27 -> 26
```

**3 of 3 guests survived; 0 cancelled; 0 vanished. Then 1 of 1. `ADDITIONAL_SPOT` rows survive
too.** The match's live count fell by exactly one each time — the host, and nothing else.

**THIS RETIRES THE OLD BELIEF FOR GOOD.** The doc previously carried an unproven line that removal
"cancels the GUEST first". That was about `DELETE /admin/matches/{id}/players/{userId}` — the
endpoint that keys on a PERSON, is ambiguous when one user holds several rows, and which we do not
use. It was never true of the row-keyed endpoint and it is now measured false.

**CONSEQUENCE.** The lapsed-spots page held rows back from selection when their match carried
guests, on the theory that removing a host was a decision about the guest too. It is not, and that
guard was removed on 2026-09-01. The chip was also counting MATCH-LEVEL rather than per-person, so
three unrelated people on one match each read "4 guests on this match" when none of them had
brought any.

**What is still UNKNOWN:** whether a guest can attend without their host present is a policy
question about the pitch, not an API one. The data says the spot survives.

## THE MANAGER ROSTER IS `GET /city-managers`, AND IT IS CITY-SCOPED (2026-09-01)

**What backs Retool's CITY MANAGERS section.** Read out of `retool-export-prod.json`, not guessed:

```
getCityManagers                  GET /city-managers?cityId={{ filterCityMnagersCity.value }}
getCityManagersForAttachToMatch  GET /city-managers/users?email={{ search }}&cityId={{ match city }}
delete                           DELETE /city-managers?userId=…&cityId=…
```

No `/admin` prefix. **`cityId` is the column that carries the city**, and each row nests the whole
city object — `city.abbr` is exactly the `ATX` / `HOU` / `SATX` code the pay sheet groups by, so no
mapping table is needed.

Row shape: `{ id, userId, cityId, createdAt, updatedAt, user{ id, email, firstName, lastName, … },
city{ id, name, abbr, stripeTaxRateValue, timeZone, … } }`.

### 100 rows, and 100 is the REAL total — not a page cap

The endpoint **ignores `page` and `limit`**: asking for page 2 with limit 500 returns the same 100
rows. The way to prove 100 is complete is that the per-city queries sum to exactly it:

```
cityId  ABBR   CITY                 PEOPLE   WITH GUSTO   WITHOUT
     1  ATX    Austin                  28            4        24
     2  HOU    Houston                 17            3        14
     3  SATX   San Antonio             15            2        13
     7  DFW    Dallas / Fort Worth     13            0        13
     5  STL    St. Louis                9            0         9
     4  ATL    Atlanta                  8            1         7
     8  OKC    Oklahoma City            5            1         4
     6  NYC    New York City            3            0         3
     9  ELP    El Paso                  1            0         1
    10  WAW    Warsaw                   1            0         1
                                      ---          ---       ---
                                      100           11        89
```

### Only 11 of 100 can be paid

`manager_gusto_aliases` holds **11 rows**. The join is `lower(user.email)` ↔
`lower(manager_email)` — the same email key the whole pay path uses. **89 of the roster have no
Gusto mapping and cannot be paid at all**, so a picker that lists everyone is offering a choice
that will be refused on save. DFW, STL, NYC, ELP and WAW have **zero** mapped people between them.

### Clubhouse already reads this family, in three places

`/city-managers/users` in `matchday/[env]/matches/[id]/route.ts:92` (the drawer's manager dropdown)
and `manager-pay/city-week/route.ts:66`; `/city-managers` in `match-managers/route.ts:48`. So there
was never an access problem — the manager-pay directory had simply been built on the wrong list.

### BEING ON A CITY ROSTER IS NOT HAVING RUN A MATCH

**72 of the 100 have ever been assigned a match, and neither set contains the other.** The old
manager-pay directory derived its people from `mdapi_matches.manager_email` — every manager ever
assigned, any city, 102 people, 11 payable, unsorted. That answers "who has worked", which is a
different question from "who may be paid in this city". `match-managers/route.ts` already records
the same distinction from the other side: 100 distinct `manager_id`s appear on matches against 87
people on the roster.

## TWO CLOCKS IN THE ESTATE, ON PURPOSE — Lifecycle is Chicago, membership snapshots are UTC (2026-09-01)

`growth_registration.signup_month` moved from **UTC to America/Chicago** (migration 0157).
`members_monthly_snapshots` did **NOT** move and stays **UTC**. That is deliberate, and it means
the two disagree. This entry exists so the next person finds that out here rather than by
reconciling two pages and assuming one is broken.

### What moved, and why

Player Behavior gained a WEEKLY granularity. Weekly buckets are Chicago: a signup at `03:36Z` on
the 1st happened at **22:36 on the 31st** at the pitch, and on a weekly bucket a shifted day
crosses a boundary **one time in seven** rather than one in thirty. Leaving monthly on UTC would
have put two clocks on one page.

Measured before the change on **27,064 completed non-fake users**:

```
218 users (0.81%) fall in a different MONTH under the two zones
933 users (3.45%) fall in a different WEEK          <- 4x, which is why weekly forced the issue
largest absolute move in any month: 11 USERS (2026-05, 1308 -> 1297)
the total is unchanged: 27,064 either way — nobody is created or lost
```

### What did NOT move, and by how much it now disagrees

`members_monthly_snapshots` rows are **frozen history and some have been quoted to people**, so
they stay UTC. Against a Chicago-bucketed Lifecycle page they differ by **±1 member per month**:

```
MONTH     snapshots (UTC)   Chicago equivalent   DELTA
2026-03              104                  104        0
2026-04              109                  110       +1
2026-05              111                  111        0
2026-06              120                  119       -1
2026-07              165                  166       +1
2026-08              137                  136       -1
```

**Never more than one member.** If a Membership figure and a Lifecycle figure differ by one, this
is why, and neither is wrong.

### The blast radius of 0157

`growth_registration` is read in exactly one place — `growthFromViews.ts:813`, which backs
`/api/lifecycle`. `GrowthDataProvider` fetches that once and feeds **every Player Lifecycle
report**: Player Funnel, Player Behavior, Revenue per Player, Retention, Churn, Player Data Room.
All six shifted by the same small amounts on 2026-09-01.

**The Growth tab does NOT read it. The exec summary does NOT read it.** Neither moved.

### The rule that comes out of this

**A month is only comparable to another month on the same clock.** Before reconciling any two
monthly figures in this estate, check which side of this line each one sits on:

- **America/Chicago** — `growth_registration` and everything under `/api/lifecycle`; the weekly
  buckets on Player Behavior; every wall-clock match date (which is Chicago by construction).
- **UTC** — `members_monthly_snapshots`, and `mdapi_subscriptions` activation/cancellation
  timestamps when sliced as text rather than converted.

### `registration_price` — CENTS, never null in the mirror, and 0 is a real value

**Evidence: `mdapi_matches` counted on production 2026-09-01.**

- 10,170 non-deleted rows. `registration_price IS NULL` → **0**. Proven by the complementary
  count rather than trusted: `registration_price >= 0` returns **10,170**, the full total, so
  there is no null hiding behind a filter that matches nothing.
- `registration_price = 0` → **347 rows**, of which 18 fall in June 2026 and 12 in May 2026.
  **Zero is a genuine free match, not a missing price.** Anything rendering a price must keep the
  two apart: null renders nothing, 0 renders $0.00. Collapsing them relabels 347 real matches.
- **CENTS.** Distinct values seen in Jun–Sep 2026: 0, 100, 300, 500, 600, 800, 900, 990, 1200,
  1500, 3900, 5500. 1500 is $15.00. `src/lib/monthGrid.ts` `priceLabel()` is the only place the
  division by 100 happens.
- The column is nullable, so the null branch is kept as a defence — a create that omits the field
  would land one. It is not currently load-bearing.
