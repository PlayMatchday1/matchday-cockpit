# Phase 5 — Match registration data migration: design doc

Read-only investigation. No code changes, no migrations, no pushes. Output for review before Stage 2 (build).

Investigation date: **2026-05-06**.

---

## Section 1 — API exploration

Probed the live MatchDay platform API at `https://playmatchday.herokuapp.com` using the existing auth pattern (`POST /auth/signin` → bearer token, mirrors `src/lib/matchdayApi.ts`). Three endpoints captured.

### 1.1 `GET /admin/matches?page=N&limit=N` (list)

**Envelope**: `{ data: Match[], limit, page, totalItems }`. Same shape as `/admin/subscriptions` and `/admin/matches/reviews`.

**Default query (no filter)**: `totalItems = 180`. **Window appears narrow — likely upcoming/recent matches only, not "all time".** Need to discover how to widen this for backfill (see open question 1).

**Match row shape** (~50 fields). Annotated with the cockpit-relevant ones:

```
id                       number       ← PK
name                     string
description              string
divisionId, teamHomeCustomName, teamAwayCustomName, teamHomeId,
teamAwayId, bracketRound, fieldNumber, groupNumber,
teamHomeScore, teamAwayScore  -- all null in our usage
type                     string       (probably "MATCHDAY" or similar)
startDate                string       ← match start (wall-clock interpreted)
startDateUtc             string       ← match start (UTC)
endDate                  string
endDateUtc               string
fieldId                  number
category                 string
isCancelled              boolean      ← maps to MatchRow.matchCanceled
minPlayerCount           number
maxPlayerCount           number       ← maps to CSV's "max_signups"
isFreeMember             boolean
registrationPrice        number       ← match price (dollars)
hasOrganizer             boolean
createdAt, updatedAt     string       ← updatedAt useful for incremental sync
managerIntro             string
managerId                number       ← manager (plus full nested manager object)
secondManagerId          number|null
starRating               number       ← average match rating (post-match)
starRatingCount          number
guestCount               number
autoCanceled             boolean      ← match canceled by auto-bump system
autoCanceledMinutes      number
maxTeamSize2Team         number
maxTeamSize4Team         number
isAutoBump               boolean
additionalSpotPrice      number|null
fakeSpotLeft36h, 24h, 12h, 6h, 3h     -- marketing display, ignore

manager: { id, email, firstName, lastName, ... }   ← embedded user object
secondManager: object|null
teams: [...]                                       ← team-mode metadata
players: [<Array(N)>, {...}]                       ← TRUNCATED, see 1.2
field: {
  id, title, abbr, address, lat, lng, zipcode,
  cityId, cover, deletedAt,
  city: { id, name, abbr, ... }                    ← city.abbr is what we want
}
_count: { players: N, fakePlayers: N }            ← player count incl/excl fake
eventId: null
```

**⚠ The embedded `players` array is TRUNCATED.** For match `14087` the list endpoint embedded 15 players; the dedicated players endpoint returned 26 for the same match. Cancelled / bumped registrations appear to be filtered out of the list embed. **Cannot rely on the list endpoint for full registration data.**

### 1.2 `GET /admin/matches/{id}/players` (full registration roster)

**Bare array** (no envelope), ~26 rows for match 14087. **Source of truth for the row-per-registration data the cockpit consumes.**

```
id                              number       ← PK (player.id, the registration row id)
userId                          number       ← player's user id
matchId                         number
paidStatus                      string       (likely "paid"/"cancelled"/"pending"/"refunded")
team                            number
playerNumber                    number
amount                          number       ← match price paid (dollars)
totalAmount                     number       ← total inc. fees/credits?
creditAmount                    number       ← Stripe credits applied
paymentIntentId                 string|null  ← Stripe linkage
error                           string|null
userType                        string       ← LIKELY maps to "Type Of Payment" CSV col
                                              (probably MEMBER / DAILY PAID / GUEST etc.)
                                              Need real-data probe to confirm enum.
refunded                        boolean
isCancelled                     boolean      ← per-player cancellation flag
isReserved                      boolean
promocodeId                     number|null  ← FK to promocode (NOT the code text itself)
cancelledBefore24Hours          boolean|null
createdAt                       string       ← registration timestamp (= CSV "Date Of Match Registration")
updatedAt                       string
canceledAt                      string|null  ← maps to MatchRow.playerCanceledAt
isFirstMatch                    boolean      ← maps to CSV "first_match_date" boolean equiv.
isAbsent                        boolean      ← player marked absent post-match
userStatus                      string       ← player's overall membership status?
updatedAtRating, starRating, skipRating, tagsRating, comment   ← review fields
                                              (already mirrored in mdapi_reviews;
                                               redundant here but we capture them)
isMigratedStripePaymentIntent   boolean

user: {                                       ← full embedded user object
  id, email, firstName, lastName,
  isShownMembership, completedSignUpAt,
  selfRatingValue, avatar, phoneNumber,
  isFakePlayer, creditAmount, isMember
}
```

### 1.3 `GET /admin/matches/{id}` (single match detail)

Same shape as a list-endpoint match element, plus a `goals` array (empty in our case — likely a feature for tournament play we don't use). **Redundant with the list endpoint for our purposes** — list gives us everything needed for the matches table, plus we always pair it with `/players` for the full roster.

### 1.4 Pagination + filter discovery

**Resolved 2026-05-06 via the OpenAPI spec at `https://playmatchday.herokuapp.com/api-docs-json`** (public, no auth required). The earlier blind probe missed because the validator's strict whitelist rejected the param names we guessed. The spec gives the canonical answer:

- **Date filter**: `fromDate=YYYY-MM-DD` + `toDate=YYYY-MM-DD` (both optional, format `YYYY-MM-DD` per docs even though the schema declares `date-time`).
- **Default behavior**: if `fromDate` is omitted, the API defaults to "current UTC date" — explains why our naked probe returned only 180 matches.
- **Deprecated, do not use**: `startDateMin`, `startDateMax`, `endDate` — still in the param list, but the docs explicitly state "matches will NOT be filtered based on this query."
- **Pagination**: standard `page` + `limit` offset pagination. Response wrapper is `PaginatedResponseDto`: `{ page, limit, totalItems, data: [...] }`. `totalItems` is trustworthy (declared required).
- **Sort**: `sortColumn` (enum: `id`, `name`, `startDate`, `registrationPrice`, `isCancelled`, `field`) + `sortDirection` (`asc` | `desc`, default `asc`). Same NestJS convention as `/admin/subscriptions`.
- **Other useful filters**: `cityId` (number), `fieldId` (array), `category` (enum: OPEN, PREMIER, LEGENDS, ACADEMY, CO_ED, FEMINE, TOURNAMENT), `isCancelled` (boolean), `free` (boolean), `spotsLeft` (boolean).

### 1.5 Known quirks (carried from earlier syncs)

- Auth: same dual-mode pattern (CRON_SECRET vs user session) as the existing manual sync endpoints
- `totalItems` field: trustworthy on this endpoint (showed 180 consistently across page=1,2). Different from subscriptions endpoint which returns `totalItems=0` regardless of actual count
- No rate limits per Vitaly's earlier confirmation. Heroku may still enforce per-IP throttling under load — uncharacterized
- The "wall-clock interpretation" convention applies: `startDate: "2026-05-05T20:30:00.000Z"` is wall-clock 8:30 PM local, despite the Z suffix. Use the same `parseLocal` helper as elsewhere

---

## Section 2 — Schema proposal

### 2.1 Decision: two tables

**`mdapi_matches`** — one row per match (the "match metadata"). Captures everything needed for filtering/aggregation: city, field, start time, max players, manager, cancellation state, ratings.

**`mdapi_match_players`** — one row per player registration (the "row-per-registration" data, equivalent to one CSV row in the current `match_registrations` table). Foreign-keyed to `mdapi_matches.api_id` for joins.

**Why two tables (not denormalized):**
- Most match metadata is identical across the ~13–26 player rows; denormalizing would 13–26× the storage and bandwidth for queries that only care about match-level facts (like cancel patterns, fill rates).
- Some downstream insights operate at the match level (Match P&L, Field Costs); others at the registration level (avg matches per member, manager stats). Two tables let each query hit only what it needs.
- Mirrors the API source: matches and players are separate endpoints, separate concerns.

**Why not three (matches / players / users)?** The embedded `user` object is small and read-only-ish. Inlining its key fields into `mdapi_match_players` means the registration-rows join is one less hop. We're also explicitly skipping `mdapi_players` entirely (your earlier call). The user object's full data is a Phase 6+ concern if ever.

### 2.2 Proposed migration `0016_mdapi_matches_and_match_players.sql`

```sql
-- Matches and match-player registrations from the MatchDay API.
-- Replaces the manually-uploaded user_analysis CSV (match_registrations
-- table). One row per match; one row per player registration (FK on
-- mdapi_match_players.match_api_id → mdapi_matches.api_id).
--
-- Field naming: snake_case to match cockpit conventions (mdapi_reviews,
-- mdapi_subscriptions, fin_*). API fields are camelCase; the sync
-- mapper renames at write time. raw jsonb retains the full API payload
-- for forward-compat (same pattern as existing mdapi tables).
--
-- Apply via Supabase Dashboard → SQL Editor.

CREATE TABLE IF NOT EXISTS mdapi_matches (
  -- API identity
  api_id                  bigint        PRIMARY KEY,    -- match.id

  -- Field linkage
  field_id                bigint        NOT NULL,
  field_title             text,
  field_address           text,
  field_zipcode           text,
  city_identifier         text,                          -- field.city.abbr
  city_name               text,                          -- field.city.name (raw)

  -- Manager
  manager_id              bigint,
  manager_email           text,
  manager_first_name      text,
  manager_last_name       text,
  second_manager_id       bigint,

  -- Match state
  name                    text,
  description             text,
  type                    text,                          -- e.g. "MATCHDAY"
  category                text,
  start_date              timestamptz,                   -- wall-clock interpretation
  start_date_utc          timestamptz,
  end_date                timestamptz,
  end_date_utc            timestamptz,

  -- Capacity + price
  min_player_count        integer,
  max_player_count        integer,                       -- ≈ CSV "max_signups"
  registration_price      numeric(10, 2),                -- dollars
  additional_spot_price   numeric(10, 2),
  is_free_member          boolean,
  is_auto_bump            boolean,
  has_organizer           boolean,
  max_team_size_2team     integer,
  max_team_size_4team     integer,
  guest_count             integer,

  -- Cancellation state
  is_cancelled            boolean,                       -- match.isCancelled
  auto_canceled           boolean,
  auto_canceled_minutes   integer,

  -- Post-match aggregates
  star_rating             numeric(3, 2),                 -- avg
  star_rating_count       integer,                       -- how many reviews
  player_count            integer,                       -- _count.players (real)
  fake_player_count       integer,                       -- _count.fakePlayers

  -- Lifecycle
  created_at              timestamptz,
  updated_at              timestamptz,                   -- key for incremental sync

  -- Audit + future-proofing
  raw                     jsonb         NOT NULL,
  synced_at               timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mdapi_matches_start_date_idx
  ON mdapi_matches(start_date);
CREATE INDEX IF NOT EXISTS mdapi_matches_city_idx
  ON mdapi_matches(city_identifier);
CREATE INDEX IF NOT EXISTS mdapi_matches_field_id_idx
  ON mdapi_matches(field_id);
CREATE INDEX IF NOT EXISTS mdapi_matches_manager_id_idx
  ON mdapi_matches(manager_id);
CREATE INDEX IF NOT EXISTS mdapi_matches_is_cancelled_idx
  ON mdapi_matches(is_cancelled);
CREATE INDEX IF NOT EXISTS mdapi_matches_updated_at_idx
  ON mdapi_matches(updated_at DESC);
-- Composite for the most common query: "matches in city C between
-- date X and Y" — drives projections, cancel patterns, weekly views.
CREATE INDEX IF NOT EXISTS mdapi_matches_city_date_idx
  ON mdapi_matches(city_identifier, start_date);

ALTER TABLE mdapi_matches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mdapi_matches_auth_select ON mdapi_matches;
CREATE POLICY mdapi_matches_auth_select
  ON mdapi_matches FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mdapi_matches_auth_insert ON mdapi_matches;
CREATE POLICY mdapi_matches_auth_insert
  ON mdapi_matches FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS mdapi_matches_auth_update ON mdapi_matches;
CREATE POLICY mdapi_matches_auth_update
  ON mdapi_matches FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


CREATE TABLE IF NOT EXISTS mdapi_match_players (
  -- API identity
  api_id                  bigint        PRIMARY KEY,    -- player.id (registration row id)

  -- Match linkage
  match_api_id            bigint        NOT NULL,        -- match.id
  -- We DON'T add a FK constraint to mdapi_matches(api_id). Reason:
  -- backfill order isn't strict (matches first, players second). A
  -- transient FK violation during backfill would block the sync.
  -- The sync sequencing keeps this consistent at runtime; a query-
  -- time INNER JOIN does the constraint enforcement we actually need.

  -- User linkage + denormalized identity
  user_id                 bigint        NOT NULL,
  user_email              text,
  user_first_name         text,
  user_last_name          text,
  user_phone_number       text,
  user_is_member          boolean,                       -- snapshot at sync time
  user_is_fake_player     boolean,

  -- Registration state
  paid_status             text,                          -- "paid" / "cancelled" / etc
  user_type               text,                          -- "MEMBER" / "DAILY PAID" / etc
                                                         -- maps to CSV "Type Of Payment"
  user_status             text,                          -- per-player membership label
  team                    integer,
  player_number           integer,
  is_reserved             boolean,
  is_first_match          boolean,                       -- player's first match ever
  is_absent               boolean,                       -- post-match no-show

  -- Money
  amount                  numeric(10, 2),                -- match price paid
  total_amount            numeric(10, 2),
  credit_amount           numeric(10, 2),
  payment_intent_id       text,                          -- Stripe linkage
  refunded                boolean,
  is_migrated_stripe_pi   boolean,
  promocode_id            bigint,                        -- FK to promo (id only, not text)

  -- Cancellation state
  is_cancelled            boolean,
  canceled_at             timestamptz,
  cancelled_before_24h    boolean,

  -- Lifecycle
  created_at              timestamptz,                   -- registration timestamp
  updated_at              timestamptz,

  -- Audit + future-proofing
  raw                     jsonb         NOT NULL,
  synced_at               timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mdapi_match_players_match_idx
  ON mdapi_match_players(match_api_id);
CREATE INDEX IF NOT EXISTS mdapi_match_players_user_idx
  ON mdapi_match_players(user_id);
CREATE INDEX IF NOT EXISTS mdapi_match_players_email_idx
  ON mdapi_match_players(LOWER(user_email));
CREATE INDEX IF NOT EXISTS mdapi_match_players_canceled_idx
  ON mdapi_match_players(canceled_at);
CREATE INDEX IF NOT EXISTS mdapi_match_players_user_type_idx
  ON mdapi_match_players(user_type);
CREATE INDEX IF NOT EXISTS mdapi_match_players_created_at_idx
  ON mdapi_match_players(created_at);

ALTER TABLE mdapi_match_players ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mdapi_match_players_auth_select ON mdapi_match_players;
CREATE POLICY mdapi_match_players_auth_select
  ON mdapi_match_players FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mdapi_match_players_auth_insert ON mdapi_match_players;
CREATE POLICY mdapi_match_players_auth_insert
  ON mdapi_match_players FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS mdapi_match_players_auth_update ON mdapi_match_players;
CREATE POLICY mdapi_match_players_auth_update
  ON mdapi_match_players FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
```

Pattern matches `mdapi_subscriptions` (migration 0012) + `mdapi_authenticated_writes` (migration 0014):
- `api_id` PK (bigint)
- camelCase API → snake_case columns
- Permissive RLS (auth gate at API layer, RLS as defense in depth)
- `raw jsonb` for forward-compat
- `synced_at` for staleness queries

### 2.3 PK choice rationale

`mdapi_matches.api_id = match.id` (bigint, single column). The API treats `match.id` as the canonical identifier (used in the URL path on `/admin/matches/{id}`). Globally unique across all cities — same logic that proved out for subscriptions. **No spot-check probe needed** — same platform, same sequence pattern.

`mdapi_match_players.api_id = player.id` (bigint, single column). Each registration row has its own platform-side id. Matches CSV's implicit row identity.

---

## Section 3 — Sync strategy

### 3.1 Backfill scope and estimated row counts

**Scope**: all matches with `start_date >= '2026-01-01'` (per spec). Today is 2026-05-06. That's ~125 days of matches.

**Estimate** (uncertainty bands flagged):
- Matches: probe shows totalItems=180 for the API's default window (uncharacterized — likely upcoming/recent). Across all of 2026 YTD: extrapolating from the CSV's ~5-week 16,860 registrations / ~18 registrations/match ≈ ~937 matches per 5 weeks × 25 weeks YTD ≈ **~4,700 matches for Jan–early-May 2026**.
- Match-player registrations: at ~18 per match (median, including cancelled): **~85,000 registrations**.

These are 5× the CSV's footprint because the CSV is only ever the most-recent 5-week window, not historical.

If the actual numbers differ wildly from estimate, the sync still works — it just takes longer.

### 3.2 Sync function shape

**N+1 pattern** (analogous to original mdapi_subscriptions plan, before we used the broken-filter shortcut):

```
1. Paginate /admin/matches: page through with limit=100, sortColumn=matchDate, sortDirection=asc.
   → list of all matches in the API's default window. NEEDS DATE FILTER for backfill (open
     question 1) — without one, may get only recent ~180 matches per default.

2. Upsert each match into mdapi_matches (column-rename + raw jsonb).

3. For each match, call /admin/matches/{api_id}/players. Upsert each player row into
   mdapi_match_players. Skip-on-error per-match: don't crash whole sync for one bad match.

4. Return aggregate counts: { matchesFetched, matchesUpserted, playersFetched,
                              playersUpserted, perMatchErrors, durationMs }.
```

Conflict resolution: `onConflict: "api_id"` on both upserts. Last-write-wins (raw + synced_at update on every run; idempotent).

### 3.3 Backfill duration estimate

| Phase | Calls | Time @ ~200ms/call | Notes |
|---|---|---|---|
| Match list paginated | ~50 pages | ~10s | If we can filter by date; otherwise fewer pages but missing data |
| Per-match player roster | ~4,700 | **~16 minutes** | The N+1 is the bottleneck |
| Upsert batches (500/batch) | ~10 + ~170 | ~5s | Negligible |
| **Total backfill** | | **~16–20 minutes** | One-time only |

This **cannot** run inside the cron orchestrator's 300s maxDuration. Backfill has to be a one-shot script: `npx tsx scripts/sync-mdapi-matches-backfill.ts`. Same pattern as `sync-mdapi-subscriptions.ts`.

### 3.4 Daily incremental refresh

**Scope** (your spec): matches with `start_date BETWEEN now - 30 days AND now + 60 days`.

I'd recommend **slight tweak**: `start_date BETWEEN now - 14 days AND now + 60 days`. Reasoning:
- Past matches don't change much after ~14 days (no more cancellations, ratings already submitted)
- Refreshing 30 days back wastes API calls on stable data
- 60 days forward catches all upcoming matches and registration churn
- If a stat ever requires data from >14 days ago that wasn't captured at sync time, a manual re-backfill of a wider window is easy

**Smarter optimization (recommend for v2)**: track each match's last-seen `updated_at`. On incremental, fetch the match list (cheap), filter to matches where `updated_at` changed since last sync, and only re-fetch players for those. Cuts ~80% of N+1 calls. **Defer to a follow-up PR** — first version uses the time-window approach.

**Daily incremental cost** (with 14/60 window):
- Window: ~74 days × ~10 matches/day = ~740 matches in window
- API calls: 1 list call (paginated, ~8 pages = 8 calls) + 740 detail calls = **~750 calls**
- Time: ~150s

This **fits in the 300s cron orchestrator budget** with ~50% headroom. Tight but workable.

### 3.5 Risks

| Risk | Mitigation |
|---|---|
| Vercel function timeout — daily run hits 300s under load | If observed: switch to the `updatedAt`-watermark optimization (3.4). Cuts ~80% of calls. |
| Backfill > 60 minutes (Heroku slow) | Backfill is one-shot, ran via `npx tsx`. No timeout. Just a long-running terminal session. |
| API rate limits | Vitaly says no rate limits. If empirically observed: add backoff. Probe didn't characterize this. |
| Partial-failure recovery | Idempotent upsert means re-running the backfill is safe. Per-match error capture in sync result lets operator see which matches failed. |
| ~~Date filter unknown~~ | **Resolved.** `fromDate=2026-01-01` for backfill; daily incremental uses `fromDate` + `toDate` window. |
| Stale data during backfill | Dashboard reads still hit the OLD `match_registrations` table during Phase 5a. Cutover happens in Phase 5b after backfill is verified. |
| Match without players response | Probe didn't test. Likely an empty array. Sync handles via `Array.isArray(res) ? res : []`. |

### 3.6 fin_member_spots staleness

`fin_member_spots` is the pre-aggregated venue-month-spot table that drives Match P&L's allocated member revenue. It's manually maintained today (we noted in Phase 3 it's not auto-refreshed). The matches migration doesn't touch it — Phase 5 leaves Match P&L allocated rev computations on the same stale data they use today. **Not a regression.** A separate ticket can wire `fin_member_spots` regen if/when needed.

---

## Section 4 — Read site cutover

### 4.1 Audit

`useMatchData()` in `src/lib/useMatchData.ts` is the **single read site** for match-registration data. Every consumer pulls `MatchRow[]` from this hook:

| File | What it reads (via useMatchData) |
|---|---|
| `src/components/CitiesExecHero.tsx` | match counts for KPI |
| `src/components/CityDetailView.tsx` | per-city week breakdowns |
| `src/components/CitiesCancellationsLens.tsx` | cancel rates |
| `src/components/CancelHeatmap.tsx` | day-of-week cancel patterns |
| `src/components/CancelPatterns.tsx` | recurring-slot cancel detection |
| `src/components/MatchPnL.tsx` | match-by-match P&L view (uses `matchPnL.ts`) |
| `src/components/MembershipHealthTable.tsx` | per-city avg matches/member |
| `src/components/MembershipSnapshot.tsx` | snapshot computations (also reads via `membershipSnapshots.ts`) |
| `src/components/PartnerDetailAdmin.tsx` | partner dashboards |
| `src/components/RevenuePerMatchCard.tsx` | revenue/match KPI |
| `src/lib/cancelPatterns.ts` | pattern algorithm |
| `src/lib/cityStats.ts` | core aggregations |
| `src/lib/matchInsights.ts` | insights bullet generation |
| `src/lib/matchPnL.ts` | per-match P&L computation |
| `src/lib/membershipSnapshots.ts` | reads from `match_registrations` directly (snapshot refresh path) |
| `src/lib/projectionsStats.ts` | weekly projection forecasts |
| `src/lib/financeStats.ts` | financial aggregates |
| `src/lib/partnerStats.ts` | partner dashboards |

Plus **one direct DB read** outside the hook: `src/lib/membershipSnapshots.ts` reads `match_registrations` for attendance data when computing snapshots. That's the only secondary read site.

**Per-component changes required: zero.** As long as `useMatchData` produces the same `MatchRow[]` shape, every consumer is unaffected. Same architecture pattern as Phase 3a/3b worked.

### 4.2 Field mapping (CSV → API → MatchRow shape)

| Cockpit `MatchRow` field | Old (`match_registrations`) | New (`mdapi_match_players` + `mdapi_matches` join) | Conversion |
|---|---|---|---|
| `city` | `match_registrations.city` (already normalized via cityMap on upload) | `mdapi_matches.city_identifier` (abbr) | apply `cityFromAbbr()` at read time |
| `field` | `match_registrations.field` (normalized via normField on upload) | `mdapi_matches.field_title` (raw) | apply `normField()` at read time |
| `matchStart` | `match_registrations.match_start` (text) | `mdapi_matches.start_date` (timestamptz) | `parseLocal()` (existing helper) |
| `matchCanceled` | `match_registrations.match_canceled` (boolean) | `mdapi_matches.is_cancelled` | `Boolean(r.is_cancelled)` |
| `playerCanceledAt` | `match_registrations.player_canceled_at` | `mdapi_match_players.canceled_at` | `parseLocal()` |
| `paymentType` | `match_registrations.payment_type` | `mdapi_match_players.user_type` | direct (need to confirm enum equivalence — open question 2) |
| `promocode` | `match_registrations.promocode` (text) | `mdapi_match_players.promocode_id` (bigint) | **MISMATCH** — see 4.3 |
| `email` | `match_registrations.email` (lowercased) | `mdapi_match_players.user_email` | `r.user_email?.toLowerCase()` |

### 4.3 Semantic shifts

**`paymentType` / `userType`** — the CSV captured the string label (e.g., `"MEMBER"`, `"DAILY PAID"`); the API's `userType` field type is also a string but **the enum values aren't yet characterized**. The cockpit's downstream filters are exact-match string compares (e.g., `r.paymentType === "MEMBER"`). If the API returns `"member"` lowercase or `"PAID"` instead of `"DAILY PAID"`, downstream code breaks silently. Open question 2.

**`promocode` field is a text → number type change.** The CSV's "Promocode" column held the actual code text (e.g., `"FREEMATCH"`). The API's `promocodeId` is a foreign-key id (number). The cockpit's "High Promo Usage" insight in `matchInsights.ts` checks `r.promocode != null` — that still works with the id. But anywhere that displays the actual code text would now show an integer. **Need to grep — quick check below.**

```
grep -rn "promocode" /Users/ryanmancuso/Desktop/matchday-cockpit/src/
```

If the cockpit only checks "is this a promo registration" (boolean check), the change is invisible. If it shows the code text anywhere, we'd need to fetch promocodes separately (new endpoint?) or capture the code text at sync time (would need to look at the API response — the player object only had `promocodeId`, not the code text).

Open question 4 — quick to resolve at Stage 2 start.

**No grace-period / temporal logic shifts.** Match cancellation is a flag, no rolloff equivalent of Phase 3b's `isActiveAsOf` issue.

### 4.4 The data_uploads / upload_id table dependency

`useMatchData` currently filters by `upload_id` (line 103) using a metadata table called `data_uploads` (line 63). After cutover:
- `data_uploads` query goes away
- `upload_id` filter goes away
- The hook just queries `mdapi_matches` + `mdapi_match_players` directly

Same shape as Phase 3a's `useReviewData` cutover (which dropped `review_uploads`). The `meta` object that the hook returns gets repurposed (`filename: "MatchDay API"`, `uploadedAt: from fin_sync_log.completed_at where source='mdapi-matches'`). One literal display site to update if it shows `meta.filename` directly — same as Phase 3a's `/cities` footer.

---

## Section 5 — Phasing

Mirroring the Phase 3 / 4 pattern. Each step is a separate commit + verification gate.

### 5a — Backfill + table creation, NO read cutover

**Files:**
- `supabase/migrations/0016_mdapi_matches_and_match_players.sql` — new tables + RLS
- `src/lib/mdapiMatchesSync.ts` — new sync lib
- `scripts/sync-mdapi-matches-backfill.ts` — one-shot backfill script
- `scripts/sync-mdapi-matches-incremental.ts` — daily incremental script (used standalone first; later wired into cron)

**Steps:**
1. You apply migration 0016 in Supabase Dashboard
2. I ship the lib + scripts in one commit
3. You run `npx tsx scripts/sync-mdapi-matches-backfill.ts` (one-shot, ~16-20 min)
4. Verify: `SELECT COUNT(*) FROM mdapi_matches WHERE start_date >= '2026-01-01';` → ~4,700 expected
5. Verify: `SELECT COUNT(*) FROM mdapi_match_players` → ~85,000 expected
6. Spot-check 3 specific matches against the cockpit's current view: same player count, same cancel state, same field, same start time

**Risk**: low. No read paths change. New tables, new data. Old `match_registrations` table untouched and still drives the dashboard.

**Rollback**: `DROP TABLE mdapi_match_players; DROP TABLE mdapi_matches;` — surgical, reversible. Or just leave them populated and don't read from them.

**Dependencies**: open questions 1 and 2 resolved. Open question 3 (timeout impact) becomes concrete after 5c.

### 5b — Dashboard read cutover

**Branch + preview deploy verification, same pattern as Phase 3a/3b.**

**Files:**
- `src/lib/useMatchData.ts` — switch query from `match_registrations` to `mdapi_matches` JOIN `mdapi_match_players`. Same `MatchRow` shape preserved.
- `src/lib/membershipSnapshots.ts` — switch the secondary `match_registrations` read to the new tables (the attendance-row source for `computeAvgMatchesPerMember`)
- `src/lib/cityMap.ts` — already has `cityFromAbbr` (added in Phase 3b, perfect timing)

**Steps:**
1. Branch `phase-5b-matches-mdapi-read`
2. Push to branch (NOT main); Vercel preview deploy
3. Spot-check on preview: `/cities`, `/cities/houston`, Match P&L, Cancel Patterns
4. Compare numbers against production (CSV-backed). Expected: API source has ~5× more rows than CSV (full 2026 vs last 5 weeks), so historical months show actual data instead of empty. Recent weeks should match within ±1% drift.
5. Merge to main if numbers reconcile

**Risk**: medium. ~20 components consume `MatchRow[]`. The shape contract is preserved, but a subtle field mapping bug could break specific insights silently.

**Rollback**: `git revert HEAD && git push`. Old `match_registrations` table still populated by the CSV upload path (which we kept in Phase 4 — Matches uploader is still on /data).

**Dependencies**: 5a backfill complete and verified. Open question 4 (promocode text vs id) resolved.

### 5c — Wire daily refresh into cron orchestrator

**Files:**
- `supabase/migrations/0017_fin_sync_log_add_matches.sql` — relax CHECK constraint to add `'mdapi-matches'` source value
- `src/lib/syncLogging.ts` — add `'mdapi-matches'` to `SourceName` union
- `src/app/api/sync/cron/route.ts` — add 5th step running incremental matches sync
- (New) `src/app/api/sync/matches/route.ts` — manual trigger endpoint (mirrors `/api/sync/reviews`, `/api/sync/subscriptions`)
- `src/app/(internal)/data/page.tsx` — add `<SyncCard source="mdapi-matches" ... />` to Matches section above the still-existing CSV uploader (Phase 5d removes the uploader)

**Steps:**
1. You apply migration 0017
2. I ship code in one commit; push to main
3. Smoke test against production cron route (same pattern as Phase 3c)
4. Verify: 5 fin_sync_log rows next morning at 6am cron

**Risk**: low. Each cron step is per-source isolated (`runWithLog`); a matches-sync failure doesn't take down the others. Order it BEFORE membership snapshots refresh (snapshots read match_registrations / match data — wait, do they? **need to check** — probably not, snapshots only need attendance via `email`). If snapshot refresh DOES depend on the new tables, run matches sync before snapshots. Otherwise order doesn't matter.

**Rollback**: revert the cron-route commit. Daily sync continues working manually via `npx tsx`.

**Dependencies**: 5b complete (otherwise cron writes data that isn't being read).

**Timeout concern**: If 5b + 5c push the orchestrator past 300s in production, fall back to the `updatedAt`-watermark optimization. Probably fine; daily incremental is ~150s estimated.

### 5d — Remove manual matches CSV uploader (cleanup)

**Files:**
- DELETE `src/components/MatchesUploader.tsx`
- DELETE `match_registrations` parsing helpers in `MatchesUploader.tsx` (component is self-contained, unlike the financeImport.ts member helpers we removed in Phase 4)
- UPDATE `src/app/(internal)/data/page.tsx` — drop the `MatchesUploader` import + usage, leaving the `<SyncCard>` we added in 5c

**Steps**: same single-commit removal as Phase 4's Members/Reviews uploader cleanup. Push to main directly.

**Risk**: trivial. Read paths already on API (Phase 5b). The CSV upload path is unread.

**Rollback**: `git revert HEAD && git push`. The deleted files come back. CSV upload still writes to `match_registrations` (untouched table), but no code reads from it.

**Dependencies**: 5b and 5c stable for at least a few days.

### Timing summary

| Phase | Scope | Risk | Estimated effort |
|---|---|---|---|
| 5a | Migration + backfill | Low | 1 commit + ~30 min wait for backfill |
| 5b | Read cutover | Medium | 1 commit on branch + preview verify |
| 5c | Cron wire-up + manual sync UI | Low | 1 commit |
| 5d | CSV uploader removal | Trivial | 1 commit |

---

## Section 6 — Open questions

These need resolution (or accepted-uncertainty calls) before Stage 2 can start.

1. ~~**Date filter on `/admin/matches`.**~~ **Resolved 2026-05-06** via OpenAPI spec at `/api-docs-json`. Use `fromDate=YYYY-MM-DD` + `toDate=YYYY-MM-DD`. Backfill query: `?fromDate=2026-01-01&page=N&limit=100&sortColumn=startDate&sortDirection=asc`. Without `fromDate`, API defaults to "current UTC date" — that was the cause of the 180-match window in our blind probe.

2. **`userType` field enum values.** The cockpit's downstream filters are exact-match against `"MEMBER"`, `"DAILY PAID"`, `"GUEST"`, etc. We need to know what values the API returns. **Quick resolution**: add a probe step at the start of Stage 2 that pulls 100 player rows from a populated match and prints `DISTINCT(userType)`. 5-second answer.

3. **Cron timeout impact.** Adding a 5th step that takes ~150s to a 300s budget leaves ~150s for the existing 4 steps. Stripe + mdapi_subscriptions can together hit ~120s. We're flying close to the cap. Options:
    - (a) Accept the tight budget; fall back to `updatedAt`-watermark optimization if observed
    - (b) Move matches sync to a SEPARATE Vercel cron (Hobby tier limit: 1 cron/day. We'd have to move OFF Hobby to add a second cron.)
    - (c) Run matches sync as a sequential async-trigger pattern (cron pings, function returns 200 immediately, work happens in the background) — Vercel supports this via `waitUntil`
    - **Recommend (a)** for first version; (c) if observed timeouts.

4. **`promocode` field — id vs text.** Old CSV had the actual code text. New API gives `promocodeId` (number). Need to:
    - Quick-grep `src/` for any UI that displays the promo code TEXT (not just a boolean check)
    - If found, two options: capture the code text at sync time (need a separate /admin/promocodes lookup, or check if the players endpoint can include it via expand-style param) OR strip the code-text display from the UI and use a "Used promo" boolean
    - **Recommend**: at Stage 2 kickoff, run that grep, decide. If 0 sites display the code text → no work needed. If 1-2 sites → strip those displays.

5. **Total backfill scale uncertainty.** Estimate of 4,700 matches / 85,000 registrations is extrapolated from a 5-week CSV sample. Real number could be 2× or 0.5×. **Not a blocker** — the sync code works the same regardless; only the wall-clock duration changes. Mention so you don't think it's stuck if it runs 30 minutes instead of 16.

6. **Should we capture the embedded `manager` and `field.city` objects more aggressively?** The current proposal stores key fields (manager_id, manager_email, field_title, city_identifier) but not the full nested objects. If we ever want to surface manager phone numbers or per-city stripe addresses, that data is in the API but not in our schema. **Recommend**: defer. The `raw jsonb` column captures everything; we can add columns from `raw` via SQL views later if needed.

7. **Backfill safety in production.** First-run backfill writes ~85k rows to a fresh table. If the script crashes halfway, we have partial data. Re-running is idempotent (upsert), but takes another 16 minutes. Alternative: run backfill in batches of N matches with a checkpoint. **Recommend**: skip the checkpoint complexity. Accept the re-run cost. The script's per-match error capture means we already know which matches failed without halting the whole run.

---

## What I want from you to start Stage 2

| Open question | What I need |
|---|---|
| ~~1~~ | ~~Date filter param.~~ **Resolved** — `fromDate` + `toDate` per OpenAPI spec. |
| 2 | I'll probe `userType` enum values myself at Stage 2 start. No action needed from you. |
| 3 | Confirm "(a) accept tight budget, fall back to optimization if observed" |
| 4 | I'll grep at Stage 2 start. No action needed from you. |
| 6 | Confirm "defer; raw jsonb captures it" |
| 7 | Confirm "skip checkpoint complexity" |

Plus structural confirmations:
- Two tables (`mdapi_matches` + `mdapi_match_players`) vs single denormalized table — your call
- N+1 sync pattern vs an alternate (e.g., extract the embedded `players` from the list endpoint despite truncation, accept the cancellation-data gap) — probably stick with N+1 since cancellation data is load-bearing for cancel patterns / Match P&L

When you're ready, give me Stage 2 a green light and I'll write the migration + sync lib + backfill script as Phase 5a.
