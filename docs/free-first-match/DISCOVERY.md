# Free First Match — Phase 1 discovery (read-only)

Probed 2026-11-05 against the production Supabase mirror (service role, read-only;
`scripts/_ffm_probe.mts`), two read-only production GETs (`scripts/_ffm_probe_api.ts`), and the
backend source at `~/Code/backend-189` (master, last commit 9a99a92, 2026-11-05 09:41 -0600, the
1.89 line). Every number below is as the query returned it on that day. Anything not in evidence
says UNKNOWN.

## 0. The one number that matters today

| | value | source |
|---|---|---|
| FIRST-MATCH-AUTO bookings in the mirror | **0** | `mdapi_match_players where promocode_id = 23482` |
| FIRST-MATCH-AUTO `usageCount` on production | **1** | `GET /admin/promocodes/23482` (2026-11-05, ~19:10 UTC) |
| newest mirrored booking | created 2026-11-05 11:55Z, synced 11:59Z | `mdapi_match_players order by api_id desc limit 1` |

The mirror is refreshed **once a day at 11:00 UTC** (`vercel.json` → `/api/sync/cron` →
`mdapi-matches`, window now−14d … now+60d on match date, `src/lib/mdapiMatchesSync.ts:255-269`).
So the page will run up to a day behind the app, and the first claim (made after 11:59Z today)
appears tomorrow. Nothing on the page can be checked against real claims until then.

## 1. Where bookings live, and whether they carry the promo

**Table: `mdapi_match_players`** (migration `0016`), one row per registration, fed from
`GET /admin/matches` pages (players embedded) by `src/lib/mdapiMatchesSync.ts`. Columns the page
needs: `api_id, match_api_id, user_id, paid_status, user_type, is_first_match, amount,
total_amount, credit_amount, promocode_id, payment_intent_id, refunded, is_cancelled, canceled_at,
deleted_at, user_is_fake_player, created_at`. `raw` holds the full payload; its keys on the
newest row: `id, team, user, error, amount, userId, comment, matchId, isAbsent, refunded, userType,
createdAt, updatedAt, canceledAt, isReserved, paidStatus, skipRating, starRating, tagsRating,
userStatus, isCancelled, promocodeId, totalAmount, creditAmount, isFirstMatch, playerNumber,
paymentIntentId, stripeAccountId, updatedAtRating, cancelledBefore24Hours,
isMigratedStripePaymentIntent`.

**Yes, each booking records the promo it used: `promocode_id`.** The backend writes the
FIRST-MATCH-AUTO id onto the new player's own spot (`~/Code/backend-189
apps/api/src/core/matches/matches.service.ts:926-940`: `promocodeId: firstMatch.grant.promocode.id,
price: 0, automatic: true`). Guest spots on the same join are charged and carry no promo.
`is_first_match` is NOT the signal: it marks the first *booking* (facts doc, "Who counts as a
player") and the backend sets it on every first booking, free or paid (`matches.service.ts:2088,
2203`). Since Nov 4 the mirror holds 29 `is_first_match` rows with `amount > 0` and 1 with
`amount = 0`.

**Promo 23482 in `mdapi_promocodes`:** `FIRST-MATCH-AUTO`, PERCENT 100, NEW_USERS, ALL_MATCHES,
`number_of_uses_per_user 1`, `start_date_utc 2026-11-05T06:22:00Z`, `end_date_utc 9999-12-31`,
not deleted. The backend hides this code from typed-code lookups
(`promocodes.service.ts:79-86`) and the app marks the booking `usedFirstMatchFree` only for the
signed-in player (`first-match-free.service.ts markUsedFirstMatchFree`).

**UNKNOWN until the first row mirrors:** whether the $0 own spot lands as `paid_status FREE`
(the `joinFreeMatch` path when the whole join totals 0) or `PAID` with `amount 0` (the Stripe path
when guests are charged alongside). Typed 100% codes land as `PAID`, `amount 0`, `promocode_id`
set (1,855 such rows since Aug 7). `rosterRowCounts()` counts both, so this does not change the
build; the filter is `promocode_id`, not `paid_status`.

**Marketing first-match codes.** There are **4,801** promos with `target_user_type = NEW_USERS`,
most of them per-player referral codes (`36ref`, `87633ref`…). All are 100% off. Uses are counted
below as the redemption rule in `src/lib/promoRedemptions.ts` counts them: a booking that stands
(not cancelled, not refunded, not WAITING, not soft-deleted) by a non-fake account. Window:
bookings created 2026-08-07 → 2026-11-05 (55,563 rows paged by `api_id` keyset).

| id | code | scope | standing uses | of which `is_first_match` |
|---|---|---|---|---|
| 12321 | HTXMD | NEW_USERS · SPECIFIC_FIELDS | 187 | 187 |
| 21098 | MATCHDAY | NEW_USERS · ALL_MATCHES | 142 | 142 |
| 21758 | WELCOMEMD | NEW_USERS · ALL_MATCHES | 124 | 124 |
| 2580 | matchday | NEW_USERS · ALL_MATCHES | 68 | 68 |
| 20273 | WORLDCUP | NEW_USERS · ALL_MATCHES | 64 | 64 |
| 10010 | firstmatch (deleted 2026-10-06) | NEW_USERS · ALL_MATCHES | 51 | 51 |
| 13154 | ATXMD | NEW_USERS · SPECIFIC_FIELDS | 50 | 50 |
| 18302 | ABRA | NEW_USERS · ALL_MATCHES | 31 | 31 |
| 21759 | FIRSTFREE | NEW_USERS · ALL_MATCHES | 22 | 22 |
| 13838 | DFWMD | NEW_USERS · SPECIFIC_FIELDS | 15 | 15 |
| 22253 | KICKOFF | NEW_USERS · ALL_MATCHES | 15 | 15 |
| 12320 | SATXMD | NEW_USERS · SPECIFIC_FIELDS | 14 | 14 |
| 21760 | LASTCHANCE | NEW_USERS · ALL_MATCHES | 14 | 14 |
| 18029 | OKCMD | NEW_USERS · SPECIFIC_FIELDS | 12 | 12 |
| 12122 | ATLMD | NEW_USERS · SPECIFIC_FIELDS | 10 | 10 |
| 18428 | JOBA | NEW_USERS · ALL_MATCHES | 9 | 9 |
| 21699 | 87633ref | NEW_USERS · ALL_MATCHES | 9 | 9 |
| 22946 | ONEFB | NEW_USERS · SPECIFIC_FIELDS | 7 | 7 |
| 16611 | PCHRIS | NEW_USERS · SPECIFIC_FIELDS | 5 | 5 |
| 18427 | LEO | NEW_USERS · ALL_MATCHES (cap 1000) | 5 | 5 |
| 22484 | STLFIRST2026 | NEW_USERS · SPECIFIC_FIELDS | 5 | 5 |
| 20966 | FIRSTMATCH (deleted 2026-10-06) | NEW_USERS · ALL_MATCHES | 4 | 4 |
| 11957 | WELCOMESTL | NEW_USERS · ALL_MATCHES | 3 | 3 |
| 22716 | HELLOATL | NEW_USERS · SPECIFIC_FIELDS | 3 | 3 |
| 10011 | lastcall | NEW_USERS · ALL_MATCHES | 2 | 2 |
| 20603–20609 | FIRSTINATX / ATL / DFW / HTX / OKC / SATX / STL | NEW_USERS · ALL_MATCHES, live to 2028 | fewer than 2 each in this window | |

ALL_USERS 100% codes (TOMBALL, KESWICK100, OCTOBERLBJ, SIETEFC2026, NBFOUNDER…) also produce
first-match rows (11, 25, 11, 5, 3) but are field launches, not first-match marketing. Every
NEW_USERS code is a "first match" code by construction: a NEW_USERS code is only valid for a
player with no match (`promocodes.service isUserValidForPromocode`), and the backend's own
"account has had its free match" check is exactly `promocode.targetUserType = NEW_USERS`
(`device-integrity.service.ts accountHasFreeMatch`). Which of these count as "the marketing
codes" is a question for you (below).

## 2. Paid versus free

Cross-tab of the 55,563 bookings created since 2026-08-07, non-fake, not soft-deleted, top
buckets (`amt` = `amount`, `total` = `total_amount`, `pi` = `payment_intent_id`):

| rows | paid_status | amt | total | credit | promo | pi | refunded | what it is |
|---|---|---|---|---|---|---|---|---|
| 13,613 | PAID | >0 | >0 | 0 | null | set | no | card payment |
| 9,358 | FREE | 0 | 0 | 0 | null | null | no | free spot: fake fills, member spots on `is_free_member` matches, comps |
| 3,074 | WAITING | >0 | >0 | 0 | null | set | no | checkout never settled, never counts |
| 3,067 | PAID | 0 | 0 | 0 | null | null | no | **all `user_type GUEST`**, 294 of 300 sampled on `is_free_member` matches: a member's free guest spot |
| 1,855 | PAID | 0 | 0 | 0 | set | null | no | 100%-off promo (typed code) |
| 1,158 | PAID | >0 | >0 | 0 | null | set | yes | card payment, refunded |
| 1,067 | PAID | >0 | 0 | >0 | null | null | no | paid entirely from credit balance |
| 867 | PAID | >0 | >0 | >0 | null | set | no | part credit, part card |
| 149 | PAID | >0 | >0 | 0 | set | set | no | partial promo (e.g. ROUND2 50%), card |

Identities, from `src/lib/creditsModel.ts:144-150` (facts doc): `amount` is the spot price AFTER
the promo and BEFORE credit; `credit_amount` is credit SPENT; `total_amount =
round((amount − credit_amount) × (1 + city tax))` is the card charge. So:

- **Card payment**: `amount > 0`, `payment_intent_id` set.
- **Credit**: `credit_amount > 0`; wholly credit when `total_amount = 0`. The player still gave
  up money, which is why credits treats it as paid (`creditOwedCents`).
- **Other promo**: `promocode_id` set; `amount` is what was left to pay (0 for a 100% code).
- **Refund**: `refunded = true`; `rosterRowCounts()` already drops it.
- **Membership**: NO column says a spot was taken on a membership (facts doc, "FREE IS NOT
  MEMBER BENEFIT": `user_is_member` is false on every row; `match_registrations.payment_type` is
  a stale upload). The nearest signal is `paid_status FREE` on an `is_free_member` match by a
  user holding a subscription. Membership itself: `mdapi_subscriptions` (`user_id, status,
  price, activation_date, canceled_at`, `activation_date` is TRUE UTC); `mdapi_users.is_member`
  is the current flag. "Started a membership within 60 days" = a subscription row with
  `activation_date` in the window.

**A proposed "paid match" for this page** (to confirm): a standing booking
(`rosterRowCounts()` + `deleted_at IS NULL`, i.e. a `growth_participation` row) with
`amount > 0`. That counts card and credit, excludes 100%-off promos, fake fills, member free
spots and guest spots of members. Whether a member's own free spot on a member-free match should
count as "paid" (they pay monthly) is an open question.

## 3. Platform (iOS / Android)

**No. Nothing the Clubhouse reads carries a platform.** `mdapi_users.raw` keys: `id, lat, lng,
email, avatar, address, matches, zipCode, isMember, lastName, areaLabel, createdAt, firstName,
areaSource, currentLat, currentLng, phoneNumber, cityManagers, creditAmount, isFakePlayer,
needsLocation, currentZipCode, introMatchText, preferableCity, selfRatingValue,
playingPositions, zipCodeUpdatedAt, completedSignUpAt, isShownMembership, locationUpdatedAt,
coordinatesUpdatedAt, phoneNumberVerifiedAt, receivePushNotifications`. The booking and match
payloads (keys above and `firstMatchFreeEnabled` on the match) have none either. The facts doc
already records this ("THE PLAYER SIDE HAS NO PLATFORM", 2026-09-18).

**Where the platform does exist, on the backend only** (`~/Code/backend-189 apps/api/prisma/schema.prisma`):

- `users.device_check_platform` (+ `device_check_at`, `device_check_bit0`,
  `device_check_flagged`, `device_check_device_hash`): the platform of the last app-open device
  sync. This is what the free match decision reads.
- `user_devices.platform` (`IOS`/`ANDROID`, plus `app_version` from `X-App-Version`): push
  tokens, one row per player and platform.
- `device_integrity_logs.platform` on every gate/ingest/stamp row.
- `free_match_used_devices.platform`.
- The app sends `X-App-Platform` / `X-App-Version` on every request (`user-devices/app-client.ts`).

**None of it is on an admin endpoint.** Checked every `@Controller('admin…')` and the admin
players DTO: `firstMatchFree` is on the player's own profile response only. So the platform
toggle cannot be built honestly today. Options: (a) ship the toggle disabled with "Not tracked
yet", (b) backend adds `deviceCheckPlatform` (or the `user_devices` platforms) to `/admin/players`
so the users sync picks it up. The daily aggregate `acq_app_event_daily.platform` exists but is
not per player.

## 4. Blocked repeat claims

**Not readable by the Clubhouse. There is no number to show.**

What the backend records (`device-integrity.service.ts`, `first-match-free.service.ts`):

- `device_integrity_logs` (`user_id, operation, platform, outcome, bit0, bit1, emulator,
  unlicensed, apply_promocode, granted_free_match, list_price, price, provider_status,
  error_message, details, request, created_at`). A refused automatic claim is a row with
  `operation = 'auto_gate'` and `outcome` in `bit0_set` (iPhone, Apple bit 0 already set),
  `device_used` (Android, hash already in `free_match_used_devices`), `flagged`, `no_sync`,
  `stale_sync`, `no_device_hash`, `not_ios`, `not_android`, `already_used`. A refused typed
  new-user code is `operation = 'gate'`, `outcome = 'bit0_set'`.
- **Only an attempted join is logged.** `decide()` (the price quote) has no side effects; the
  log is written by `claim()` at join (`first-match-free.service.ts claim`, `matches.service.ts:767`).
  A player who sees the full price on the quote and never taps join leaves no row.
- `free_match_used_devices` (`platform, device_hash, user_id, user_match_id, created_at`,
  unique on platform + hash) records Android devices that USED a free match, one row per device.
  It is not a log of refusals, and iOS "used" lives in Apple's DeviceCheck bits, not in a table.
- Android device recall via Play Integrity is not approved by Google; the Android check is the
  HMAC of the Android ID in `free_match_used_devices` (`device-integrity.service.ts:642-706`).

What the Clubhouse would need, without changing the backend in this task: an admin read of
`device_integrity_logs` filtered to `operation in ('auto_gate','gate')`, returning `created_at,
platform, outcome, user_id` (no tokens, no `request` json), or a nightly export of the same, and
a Clubhouse sync into a mirror table. Until then the card reads "Not tracked yet".

The Clubhouse's own `firstmatch_ledger` (migration `0053`, 14,189 rows, 124 since Nov 1) is the
older abuse ledger over `is_first_match` rows. It records claims, not refusals.

## 5. Capacity, sold out, spot price

`mdapi_matches` (migration `0016`): `max_player_count` is capacity; `player_count` is
`_count.players` (authoritative, facts doc "Roster spots in the mirror"); `registration_price` is
the list price in **cents**; `fake_player_count`, `is_free_member`, `is_cancelled`, `deleted_at`,
`city_identifier`, `field_id`, `field_title`, `start_date` (LOCAL WALL CLOCK with a false Z).
`raw.firstMatchFreeEnabled` is the per-match switch (not a column; `raw ->> 'firstMatchFreeEnabled'`).

- **Sold out** = `player_count >= max_player_count`. Since Nov 1: 611 non-cancelled matches, 30
  sold out. Caveat: `player_count` is as of the last sync; a match that filled and then lost a
  player reads as not sold out. "Hit capacity at any moment" is not stored anywhere.
- **Spot price** for the free player: the backend prices the own spot as the locked team's price
  when the team is locked with a price, else `registrationPrice` (`matches.service.ts
  getMatchPrice`). `registration_price` values seen since Nov 1: 800, 1200, 900, 1500, 500, 3900,
  0, 5500, 300, 100. UNKNOWN whether the mirror's `raw.teams[]` carries team prices; the first
  claim rows will show `amount 0` either way, so the list price has to come from the match. Plan:
  `registration_price`, and note the team-price case as a known under-count if `raw.teams` lacks it.

## 6. Exclusions the other pages apply

One rule, migration `0208` (`docs/matchday-api-facts.md`, "Who counts as a player"):

- `growth_internal_account` view: `is_fake_player`, any `@matchday.com`, any `@playmatchday.com`
  that is not a deleted-account tombstone (`del_<40 hex>@playmatchday.com`). Tombstones are real
  people and are kept.
- `growth_person_link` (materialized): a deleted account → the live account of the same person.
- `growth_participation` view: every standing play, with `user_id` = the person. Its predicate is
  `deleted_at IS NULL AND user_is_fake_player = false AND paid_status <> 'WAITING' AND canceled_at
  IS NULL AND match not deleted AND match not cancelled AND start_date not null AND user not
  internal`. It exposes `player_api_id`, `match_api_id`, `account_id`, `match_date` (wall-clock
  day), `city_identifier`, `field_id`, `amount_cents`.
- `growth_player_profile` (materialized): per person, `first_match_date`, `first_match_city`,
  `matches_played`.
- `growth_registration` (materialized): one row per person at their earliest completed signup,
  `completed_sign_up_at` (TRUE UTC → bucketed in America/Chicago), `declared_city_raw`.
- `/api/lifecycle/behavior-weekly` reads these through `authenticateCapability(req, "lifecycle")`
  (service role) with `selectAll` from `src/lib/supabasePagination.ts` and re-checks nothing.
- City vocabulary: `normalizeMatchCity` / `normalizeDeclared` in `src/lib/growthAnalytics.ts`;
  the city list is `CITY_SCOPES` in `src/lib/cityScope.ts` (ATL, ATX, DFW, HOU, OKC, SATX, STL,
  WAW). Matches since Nov 1 also carry `PHL`.

**Reuse for this page:** a free claim = a `growth_participation` row whose `player_api_id` is a
`mdapi_match_players` row with `promocode_id = 23482`. That inherits every exclusion above with
no second copy of the rule. Follow-ups (2nd/3rd paid match) come from the same person's other
`growth_participation` rows joined back to `mdapi_match_players` for `amount` / `promocode_id`.
Memberships from `mdapi_subscriptions` by `user_id` (the person's live account id; a tombstone's
subscriptions sit on the deleted id and are reached through `growth_person_link`).

Note `growth_participation` is a VIEW over the mirror, so it is as fresh as the daily sync; the
materialized views refresh after the matches sync in the same cron.

## 7. Free match log card (added mid-discovery)

- Match row: `mdapi_matches.field_title`, `city_identifier`, `start_date` sliced as wall clock
  (never `new Date()`), `player_count / max_player_count`.
- Names: `mdapi_users.first_name / last_name` of the person (Player Lookup's source), which shows
  "Deleted Account" for a tombstone rather than the pre-deletion snapshot the roster row may
  still hold. No email or phone leaves the route.
- Field grouping: `canonicalVenueName(field_title)` (`src/lib/venueResolver.ts`), the same key
  the monthly and weekly Player Activity use.

---

# Phase 2 — what was built, and the decisions behind it (2026-11-05)

Ryan's answers to the Phase 1 questions, and what they became.

## The page

- Route `/lifecycle/free-first-match`, rail entry "Free First Match" between Acquisition and Player
  Data Room (`src/app/(internal)/lifecycle/lifecycleSections.tsx`).
- One payload, `GET /api/lifecycle/free-first-match`, built by `src/lib/freeFirstMatchBuild.ts`,
  cached five minutes per warm instance (`?fresh=1` skips it). The page filters it by range and city
  with the pure functions in `src/lib/freeFirstMatchModel.ts`.
- Cards: four KPIs, the full-width Funnel, Before vs after (four rows), By city, Paid spots taken,
  Free match log (Matches / Fields).

## Decisions

- **Marketing first-match codes** = every promo with `target_user_type NEW_USERS`, `PERCENT`, `100`.
  **Referral codes** are the subset whose code is `<digits>ref` (`isReferralCode`, e.g. `36ref`,
  `87633ref`) and get their own row, "Referral codes · Friend invites". FIRST-MATCH-AUTO is matched by
  code (every row with that code, so a later re-issue still counts), with 23482 as a fallback id.
- **Paid** (`isPaidBooking`): the player's own spot (`user_type PLAYER`) with `amount > 0` (card or
  credit, after any promo), OR `amount 0`, no promo, on an `is_free_member` match while the player
  held a membership on the match's day. Guest and additional spots, 100%-off promos and fake fills
  never count.
- **Membership at match time** is approximated from `mdapi_subscriptions`: `activation_date`
  (Chicago day) on or before the match day and `canceled_at` null or on/after it. The period end is
  not in the mirror, so a cancelled member's final weeks read as not a member (under-count).
- **Follow-ups** are the person's other matches, own spot only, dated on or after the anchor day:
  "paid 2nd match" = first paid follow-up within 30 days; "paid 3rd match" = at least two paid
  follow-ups, any time; "became member" = a subscription activated within 60 days of the anchor.
  Booked future matches count on their match day, as everywhere else in Player Lifecycle.
- **Cost per paying player** = sum of the free spots' `registration_price` divided by the paid-2nd-
  match players; a dash with no payers. The free spot is valued at the match's `registration_price`;
  a locked team's own price is not read, so a free spot on a priced locked team is valued at the
  match price instead (known under-count, not on the page).
- **Before groups**: `growth_player_profile.first_match_date` in Aug 7 … Nov 4, 2026, classified by
  the earliest participating row. A first match that is none of paid / code / referral (a member's
  free spot, a field-launch code, a comp) is in no row.
- **Sold out** = `player_count >= max_player_count` as of the last sync. **Average fill** = mean of
  booked / capacity over the live matches in the range and city, split by whether a selected free
  claimant is on the match.
- **Registrations** ("N new sign-ups") = `growth_registration` by Chicago signup day, from Nov 5;
  the city filter compares the declared city with the selected match city's display name.
- **Names** come from `mdapi_users` (a deleted account reads "Deleted Account"). No email or phone
  is in the payload.
- **Platform toggle**: not built, no disabled control, no note on the page (Ryan).
- **Repeat claims blocked card**: not built (Ryan). Funnel takes the full width.
- **Sync lag**: a day; no cron change (Ryan).

## What the backend would need (not changed in this task)

1. **Blocked repeat claims.** An admin endpoint (or a nightly export) of `device_integrity_logs`
   filtered to `operation IN ('auto_gate', 'gate')`, returning only `created_at`, `platform`,
   `outcome`, `user_id`. Refusals are the outcomes `bit0_set` (iPhone), `device_used` (Android),
   `flagged`, `stale_sync`, `no_sync`, `no_device_hash`, `not_ios`, `not_android`, `already_used`.
   Only an attempted join is logged today (`claim()`); a quote that showed the full price and was
   never booked leaves no row. With that feed the Clubhouse syncs it into a mirror table and the
   "Repeat claims blocked" card goes in.
2. **Platform per player.** The same export carries `platform`, which is what lets the platform
   toggle (All / iOS / Android) come back: a free claim's platform is the `auto_gate` row's
   platform for that `user_id`. Alternatively `users.device_check_platform` (or the
   `user_devices` platforms) on `/admin/players`, so the users sync picks it up.

## Deploy check

`scripts/_ffm_build_probe.mts` (untracked) runs the build with the service role and prints the page's
claimed count beside a direct count of standing FIRST-MATCH-AUTO bookings on live matches dated
Nov 5 … today. The two numbers as returned on 2026-11-05 are in the Phase 2 report.
