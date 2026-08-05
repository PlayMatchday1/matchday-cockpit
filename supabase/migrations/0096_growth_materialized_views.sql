-- Growth-tab aggregation pushed into Postgres so the endpoints don't fetch 232k
-- rows per cold lambda. mdapi_* stays READ-ONLY (no indexes/triggers/columns on
-- those tables) — these are derived objects, namespaced with a growth_ prefix.
-- Kept in `public` (not a dedicated schema) so PostgREST can read them with no
-- "exposed schemas" change — they work the moment this is applied.
--
-- ONE participation-filter definition (growth_participation), referenced by all
-- three materialized views, so the filter cannot drift. Byte-identical to
-- computeGrowth.plays[]: live player row, not fake, not WAITING, not
-- player-canceled, on a live, non-cancelled match with a start_date.
--
-- City/field stored RAW (city_identifier abbr, field_title) — the display
-- mappings (CITY_CODE_TO_DISPLAY, canonicalVenueName) stay in Node, their single
-- source of truth. Month/date use the STRING PREFIX of start_date (not ::date) to
-- match the timezone-safe slicing Node does. VALIDATED: this pipeline reproduces
-- buildRetention cell-for-cell (533/533 cells, 13,942 players, footers identical).

-- ── the single filter ────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.growth_participation AS
SELECT
  p.api_id                        AS player_api_id,
  p.user_id                       AS user_id,
  substring(m.start_date, 1, 10)  AS match_date,   -- 'YYYY-MM-DD' string prefix (tz-safe)
  substring(m.start_date, 1, 7)   AS match_month,  -- 'YYYY-MM'
  m.city_identifier               AS city_identifier,
  m.field_title                   AS field_title,
  m.field_id                      AS field_id
FROM public.mdapi_match_players p
JOIN public.mdapi_matches m ON m.api_id = p.match_api_id
WHERE p.deleted_at IS NULL
  AND COALESCE(p.user_is_fake_player, false) = false
  AND p.paid_status IS DISTINCT FROM 'WAITING'
  AND p.canceled_at IS NULL
  AND p.user_id IS NOT NULL
  AND m.deleted_at IS NULL
  AND COALESCE(m.is_cancelled, false) = false
  AND m.start_date IS NOT NULL;

-- ── 1. one row per player ────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW public.growth_player_profile AS
WITH firsts AS (
  -- earliest match; ties resolve to the lowest player row api_id (matches Node,
  -- which iterates player rows in api_id order and keeps the first min-date play).
  SELECT DISTINCT ON (user_id)
    user_id,
    match_date        AS first_match_date,
    match_month       AS first_match_month,
    city_identifier   AS first_match_city,
    field_title       AS first_match_field_title,
    field_id          AS first_match_field_id
  FROM public.growth_participation
  ORDER BY user_id, match_date ASC, player_api_id ASC
),
lasts AS (
  SELECT user_id, MAX(match_date) AS last_match_date, COUNT(*) AS matches_played
  FROM public.growth_participation
  GROUP BY user_id
)
SELECT f.user_id, f.first_match_date, f.first_match_month, f.first_match_city,
       f.first_match_field_title, f.first_match_field_id,
       l.last_match_date, l.matches_played
FROM firsts f JOIN lasts l USING (user_id);

CREATE UNIQUE INDEX growth_player_profile_user_id ON public.growth_player_profile (user_id);
CREATE INDEX growth_player_profile_first_month ON public.growth_player_profile (first_match_month);
CREATE INDEX growth_player_profile_first_city ON public.growth_player_profile (first_match_city);

-- ── 2. one row per (player, active month) ────────────────────────────────────
CREATE MATERIALIZED VIEW public.growth_player_month AS
SELECT
  pa.user_id,
  pa.activity_month,
  pp.first_match_month,
  (substring(pa.activity_month, 1, 4)::int * 12 + substring(pa.activity_month, 6, 2)::int)
    - (substring(pp.first_match_month, 1, 4)::int * 12 + substring(pp.first_match_month, 6, 2)::int) AS age
FROM (SELECT DISTINCT user_id, match_month AS activity_month FROM public.growth_participation) pa
JOIN public.growth_player_profile pp ON pp.user_id = pa.user_id;

CREATE UNIQUE INDEX growth_player_month_pk ON public.growth_player_month (user_id, activity_month);
CREATE INDEX growth_player_month_cohort_age ON public.growth_player_month (first_match_month, age);

-- ── 3. the cohort matrix (what the cohort endpoint returns) ──────────────────
-- one row per (first_match_month, age, city) with the distinct player count;
-- city NULL is the all-cities rollup (GROUPING SETS).
CREATE MATERIALIZED VIEW public.growth_cohort_matrix AS
SELECT
  pm.first_match_month,
  pm.age,
  pp.first_match_city AS city,
  COUNT(DISTINCT pm.user_id) AS players
FROM public.growth_player_month pm
JOIN public.growth_player_profile pp ON pp.user_id = pm.user_id
GROUP BY GROUPING SETS ((pm.first_match_month, pm.age, pp.first_match_city), (pm.first_match_month, pm.age));

-- Unique index for REFRESH ... CONCURRENTLY. COALESCE folds the NULL rollup into
-- a real key so every row is uniquely identified.
CREATE UNIQUE INDEX growth_cohort_matrix_pk
  ON public.growth_cohort_matrix (first_match_month, age, COALESCE(city, '__ALL__'));

-- ── refresh (dependency order; CONCURRENTLY needs the unique indexes above) ───
-- Wired into: matches backfill route, Stripe commit route, and the nightly cron.
-- REFRESH MATERIALIZED VIEW CONCURRENTLY public.growth_player_profile;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY public.growth_player_month;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY public.growth_cohort_matrix;

GRANT SELECT ON public.growth_participation, public.growth_player_profile,
  public.growth_player_month, public.growth_cohort_matrix TO anon, authenticated, service_role;
