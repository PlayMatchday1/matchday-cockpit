-- Growth-tab aggregation pushed into Postgres so the endpoints don't fetch 232k
-- rows per cold lambda. mdapi_* stays READ-ONLY (no indexes/triggers/columns on
-- those tables) — these are derived objects, namespaced with a growth_ prefix,
-- kept in `public` so PostgREST reads them with no "exposed schemas" change.
--
-- ONE participation-filter definition (growth_participation), referenced by all
-- views + the drill-down function, so the filter cannot drift. Byte-identical to
-- computeGrowth.plays[]: live player row, not fake, not WAITING, not
-- player-canceled, on a live, non-cancelled match with a start_date.
--
-- start_date is timestamptz; to_char(... AT TIME ZONE 'UTC', ...) reproduces the
-- timezone-safe string slice Node does (slice(0,10)/(0,7) on the +00:00 value).
-- City/field stored RAW (city_identifier abbr, field_title); display mappings
-- (CITY_CODE_TO_DISPLAY, canonicalVenueName) stay in Node. VALIDATED against
-- production rows: growth_cohort_matrix reproduces buildRetention cell-for-cell.
--
-- SECURITY: materialized views are not covered by RLS, and this project grants
-- public objects to anon/authenticated by default — so read access is REVOKED
-- from anon/authenticated and granted only to service_role (the key both growth
-- endpoints already use).

-- ── the single filter ────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.growth_participation AS
SELECT
  p.api_id                                                AS player_api_id,
  p.user_id                                               AS user_id,
  to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM-DD')  AS match_date,
  to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM')     AS match_month,
  m.city_identifier                                       AS city_identifier,
  m.field_title                                           AS field_title,
  m.field_id                                              AS field_id
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
  -- which iterates player rows in api_id order, keeping the first min-date play).
  SELECT DISTINCT ON (user_id)
    user_id,
    match_date      AS first_match_date,
    match_month     AS first_match_month,
    city_identifier AS first_match_city,
    field_title     AS first_match_field_title,
    field_id        AS first_match_field_id
  FROM public.growth_participation
  ORDER BY user_id, match_date ASC, player_api_id ASC
),
lasts AS (
  SELECT DISTINCT ON (user_id)
    user_id,
    match_date      AS last_match_date,
    city_identifier AS last_match_city,
    field_title     AS last_match_field_title,
    field_id        AS last_match_field_id
  FROM public.growth_participation
  ORDER BY user_id, match_date DESC, player_api_id DESC
),
counts AS (
  SELECT user_id, COUNT(*) AS matches_played FROM public.growth_participation GROUP BY user_id
)
SELECT f.user_id, f.first_match_date, f.first_match_month, f.first_match_city,
       f.first_match_field_title, f.first_match_field_id,
       l.last_match_date, l.last_match_city, l.last_match_field_title, l.last_match_field_id,
       c.matches_played
FROM firsts f JOIN lasts l USING (user_id) JOIN counts c USING (user_id);

CREATE UNIQUE INDEX growth_player_profile_user_id ON public.growth_player_profile (user_id);
CREATE INDEX growth_player_profile_first_month ON public.growth_player_profile (first_match_month);
CREATE INDEX growth_player_profile_first_city ON public.growth_player_profile (first_match_city);
CREATE INDEX growth_player_profile_last_city ON public.growth_player_profile (last_match_city);
CREATE INDEX growth_player_profile_last_date ON public.growth_player_profile (last_match_date);

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
CREATE INDEX growth_player_month_user_age ON public.growth_player_month (user_id, age);

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

CREATE UNIQUE INDEX growth_cohort_matrix_pk
  ON public.growth_cohort_matrix (first_match_month, age, COALESCE(city, '__ALL__'));

-- ── drill-down: cohort roster (age 0) / churned players (age >= 1) ───────────
-- Churn is SET SUBTRACTION in SQL: active at age N-1 AND NOT active at age N.
-- p_city NULL = all cities.
CREATE OR REPLACE FUNCTION public.growth_cohort_players(p_cohort text, p_age int, p_city text DEFAULT NULL)
RETURNS TABLE (
  user_id bigint,
  first_match_city text,
  first_match_field_title text,
  first_match_field_id bigint,
  last_match_date text,
  matches_played bigint
)
LANGUAGE sql STABLE AS $$
  SELECT pp.user_id, pp.first_match_city, pp.first_match_field_title, pp.first_match_field_id,
         pp.last_match_date, pp.matches_played
  FROM public.growth_player_profile pp
  WHERE pp.first_match_month = p_cohort
    AND (p_city IS NULL OR pp.first_match_city = p_city)
    AND (
      p_age = 0
      OR (
        EXISTS (SELECT 1 FROM public.growth_player_month pm WHERE pm.user_id = pp.user_id AND pm.age = p_age - 1)
        AND NOT EXISTS (SELECT 1 FROM public.growth_player_month pm WHERE pm.user_id = pp.user_id AND pm.age = p_age)
      )
    )
  ORDER BY pp.last_match_date DESC;
$$;

-- ── refresh ──────────────────────────────────────────────────────────────────
-- The app routes call this via rpc('refresh_growth_views') at the end of the
-- matches backfill, the Stripe commit, and the nightly cron. It uses plain
-- REFRESH (not CONCURRENTLY): REFRESH ... CONCURRENTLY cannot run inside a
-- transaction, and every PostgREST/rpc call runs in one. The views are small
-- (~14k / ~50k / ~5k rows) so a plain refresh is sub-second; the brief lock is
-- negligible. For a zero-lock nightly refresh, schedule the CONCURRENTLY form
-- below via pg_cron (the unique indexes above exist for exactly that):
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.growth_player_profile;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.growth_player_month;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.growth_cohort_matrix;
CREATE OR REPLACE FUNCTION public.refresh_growth_views() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.growth_player_profile;
  REFRESH MATERIALIZED VIEW public.growth_player_month;
  REFRESH MATERIALIZED VIEW public.growth_cohort_matrix;
END $$;
REVOKE EXECUTE ON FUNCTION public.refresh_growth_views() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.refresh_growth_views() TO service_role;

-- ── access: service_role only (mat views bypass RLS; anon/authenticated are
-- granted public objects by default, so revoke that here) ─────────────────────
REVOKE ALL ON public.growth_participation, public.growth_player_profile,
               public.growth_player_month, public.growth_cohort_matrix
  FROM anon, authenticated;
GRANT SELECT ON public.growth_participation, public.growth_player_profile,
                public.growth_player_month, public.growth_cohort_matrix
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.growth_cohort_players(text, int, text) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.growth_cohort_players(text, int, text) TO service_role;
