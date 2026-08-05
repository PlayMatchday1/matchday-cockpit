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
-- City/field stored RAW (city_identifier abbr, field_title, field_id); the
-- display + identity resolvers (CITY_CODE_TO_DISPLAY, canonicalVenueName,
-- venueCategory) and the declared-city attribution rule STAY IN NODE — the views
-- never reimplement the 203-line venue resolver, so there is no second matcher to
-- drift. The views do the GROUPING; Node collapses raw → canonical exactly as
-- computeGrowth does today. VALIDATED against production rows: the cohort matrix
-- reproduces buildRetention cell-for-cell, and the per-player agg + play-dims
-- reproduce computeGrowth's funnel / behavior / ARPP / reconciliation outputs.
--
-- SECURITY: materialized views (and plain views without security_invoker) are not
-- covered by RLS, and this project grants public objects to anon/authenticated by
-- default — so read access is REVOKED from anon/authenticated and granted only to
-- service_role (the key both growth endpoints already use).

-- ── the single filter ────────────────────────────────────────────────────────
-- One row per played spot. total_amount (cents) rides along for the ARPP/DPP
-- reconciliation month rollup (strictBooking = sum of per-spot amounts).
CREATE OR REPLACE VIEW public.growth_participation AS
SELECT
  p.api_id                                                AS player_api_id,
  p.user_id                                               AS user_id,
  to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM-DD')  AS match_date,
  to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM')     AS match_month,
  m.city_identifier                                       AS city_identifier,
  m.field_title                                           AS field_title,
  m.field_id                                              AS field_id,
  COALESCE(p.total_amount, 0)                             AS total_amount
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
-- firsts/lasts/counts as before, PLUS the aggregates that let Node rebuild
-- playerRows / behavior / ARPP without touching participation:
--   city_counts  jsonb  raw city_identifier -> play count  (most-frequent-city
--                       fallback for declared-city attribution — Node picks argmax)
--   ev           text[] DISTINCT 'month|city|field_title|field_id' the player was
--                       active. Node normalises city (CITY_CODE_TO_DISPLAY) and
--                       canonicalises field (canonicalVenueName), then RE-dedups —
--                       so two raw titles that canonicalise together collapse to
--                       one, exactly like computeGrowth's Set.
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
),
city_counts AS (
  SELECT user_id, jsonb_object_agg(COALESCE(city_identifier, '__NULL__'), n) AS city_counts
  FROM (
    SELECT user_id, city_identifier, COUNT(*) AS n
    FROM public.growth_participation GROUP BY user_id, city_identifier
  ) s GROUP BY user_id
),
events AS (
  SELECT user_id, array_agg(DISTINCT ev) AS ev
  FROM (
    SELECT user_id,
      match_month || '|' || COALESCE(city_identifier, '') || '|' ||
      COALESCE(field_title, '') || '|' || COALESCE(field_id::text, '') AS ev
    FROM public.growth_participation
  ) e GROUP BY user_id
)
SELECT f.user_id, f.first_match_date, f.first_match_month, f.first_match_city,
       f.first_match_field_title, f.first_match_field_id,
       l.last_match_date, l.last_match_city, l.last_match_field_title, l.last_match_field_id,
       c.matches_played, cc.city_counts, ev.ev
FROM firsts f
JOIN lasts l USING (user_id)
JOIN counts c USING (user_id)
JOIN city_counts cc USING (user_id)
JOIN events ev USING (user_id);

CREATE UNIQUE INDEX growth_player_profile_user_id ON public.growth_player_profile (user_id);
CREATE INDEX growth_player_profile_first_month ON public.growth_player_profile (first_match_month);
CREATE INDEX growth_player_profile_first_city ON public.growth_player_profile (first_match_city);
CREATE INDEX growth_player_profile_last_city ON public.growth_player_profile (last_match_city);
CREATE INDEX growth_player_profile_last_date ON public.growth_player_profile (last_match_date);

-- ── 2. one row per (player, active month, play-location city) ────────────────
-- Grain is (user, month, city) — a player active in two cities in one month emits
-- TWO rows. matches_in_month is that month's spot count in that city. The
-- all-cities rollup DEDUPES players via COUNT(DISTINCT user_id) (see cohort
-- matrix), so the multi-city split never double-counts a player. Serves the
-- cohort matrix (retention), behavior distinct-players / spots by month & city,
-- and windowed funnel thresholds (SUM matches_in_month over a window per user).
CREATE MATERIALIZED VIEW public.growth_player_month AS
SELECT
  pa.user_id,
  pa.activity_month,
  pa.city_identifier,
  pa.matches_in_month,
  pp.first_match_month,
  (substring(pa.activity_month, 1, 4)::int * 12 + substring(pa.activity_month, 6, 2)::int)
    - (substring(pp.first_match_month, 1, 4)::int * 12 + substring(pp.first_match_month, 6, 2)::int) AS age
FROM (
  SELECT user_id, match_month AS activity_month, city_identifier, COUNT(*) AS matches_in_month
  FROM public.growth_participation
  GROUP BY user_id, match_month, city_identifier
) pa
JOIN public.growth_player_profile pp ON pp.user_id = pa.user_id;

-- Unique key now includes city (the grain). COALESCE keeps NULL-city rows unique.
CREATE UNIQUE INDEX growth_player_month_pk
  ON public.growth_player_month (user_id, activity_month, COALESCE(city_identifier, '__NULL__'));
CREATE INDEX growth_player_month_cohort_age ON public.growth_player_month (first_match_month, age);
CREATE INDEX growth_player_month_user_age ON public.growth_player_month (user_id, age);
CREATE INDEX growth_player_month_month_city ON public.growth_player_month (activity_month, city_identifier);

-- ── 3. the cohort matrix (what the cohort endpoint returns) ──────────────────
-- one row per (first_match_month, age, city) with the DISTINCT player count;
-- city NULL is the all-cities rollup (GROUPING SETS). COUNT(DISTINCT user_id)
-- dedupes the per-city split in growth_player_month, so retention is unchanged.
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

-- ── 4. play dimensions: additive spots + amount by (month, city, field) ──────
-- Raw grain. Node canonicalises field_title (canonicalVenueName), flags events
-- (venueCategory), normalises city, and rolls up. Distinct-player counts do NOT
-- come from here (they don't sum) — Node derives them from growth_player_profile.ev.
-- amount is dollars (total_amount is cents). Serves behavior spots-by-field, the
-- events section, and the DPP/booking reconciliation month rollup.
CREATE MATERIALIZED VIEW public.growth_play_dims AS
SELECT
  match_month,
  city_identifier,
  field_title,
  field_id,
  COUNT(*)                        AS spots,
  SUM(total_amount)::numeric / 100 AS amount
FROM public.growth_participation
GROUP BY match_month, city_identifier, field_title, field_id;

CREATE UNIQUE INDEX growth_play_dims_pk ON public.growth_play_dims (
  match_month,
  COALESCE(city_identifier, '__NULL__'),
  COALESCE(field_title, '__NULL__'),
  COALESCE(field_id, -1)
);
CREATE INDEX growth_play_dims_month ON public.growth_play_dims (match_month);

-- ── 5. registrations: one row per non-fake user (funnel + registration cards) ─
-- signup_month = completed_sign_up_at month (NULL if never completed onboarding).
-- preferable_city_name kept RAW (Node's DECLARED_TO_CANONICAL normalises it).
-- lifetime_matches from the profile (0 if the user never played). The funnel is a
-- SIGNUP-cohort × lifetime-play nesting; registrations-by-month buckets completed
-- users; onboardingGap = non-fake users minus completed. mdapi_users is the source.
CREATE MATERIALIZED VIEW public.growth_registration AS
SELECT
  u.id                                                   AS user_id,
  u.is_fake_player                                       AS is_fake_player,
  (u.completed_sign_up_at IS NOT NULL)                   AS completed,
  CASE WHEN u.completed_sign_up_at IS NOT NULL
       THEN to_char(u.completed_sign_up_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM') END AS signup_month,
  u.preferable_city_name                                 AS declared_city_raw,
  COALESCE(pp.matches_played, 0)                         AS lifetime_matches
FROM public.mdapi_users u
LEFT JOIN public.growth_player_profile pp ON pp.user_id = u.id
WHERE COALESCE(u.is_fake_player, false) = false;

CREATE UNIQUE INDEX growth_registration_pk ON public.growth_registration (user_id);
CREATE INDEX growth_registration_signup ON public.growth_registration (signup_month);

-- Note on completed_sign_up_at typing: computeGrowth buckets registrations by
-- monthKey(completed_sign_up_at) = the leading 'YYYY-MM' of the stored string. If
-- completed_sign_up_at is timestamptz, AT TIME ZONE 'UTC' reproduces the +00:00
-- slice; if it is already text, the ::timestamptz cast parses the ISO string and
-- the UTC read returns the same YYYY-MM. Verified against production in STEP 6.

-- ── 6. app downloads rollup (KPI + behavior download series) ──────────────────
-- app_downloads is one row per (platform, grain, day). Monthly android rollup so
-- the card reads a view, not the raw table. iOS is not wired (rendered as a dash).
CREATE OR REPLACE VIEW public.growth_downloads_month AS
SELECT
  to_char(period_date::date, 'YYYY-MM') AS month,
  SUM(count)::bigint                     AS count
FROM public.app_downloads
WHERE platform = 'android' AND period_grain = 'day'
GROUP BY 1;

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
-- so a plain refresh is sub-second; the brief lock is negligible. Order matters:
-- player_profile first (player_month, cohort_matrix, registration read it). For a
-- zero-lock nightly refresh, schedule the CONCURRENTLY form via pg_cron (every
-- mat view below has the unique index CONCURRENTLY requires):
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.growth_player_profile;  (etc.)
CREATE OR REPLACE FUNCTION public.refresh_growth_views() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.growth_player_profile;
  REFRESH MATERIALIZED VIEW public.growth_player_month;
  REFRESH MATERIALIZED VIEW public.growth_cohort_matrix;
  REFRESH MATERIALIZED VIEW public.growth_play_dims;
  REFRESH MATERIALIZED VIEW public.growth_registration;
END $$;
REVOKE EXECUTE ON FUNCTION public.refresh_growth_views() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.refresh_growth_views() TO service_role;

-- ── access: service_role only (views bypass RLS; anon/authenticated are granted
-- public objects by default, so revoke that here) ────────────────────────────
REVOKE ALL ON
  public.growth_participation, public.growth_player_profile, public.growth_player_month,
  public.growth_cohort_matrix, public.growth_play_dims, public.growth_registration,
  public.growth_downloads_month
  FROM anon, authenticated;
GRANT SELECT ON
  public.growth_participation, public.growth_player_profile, public.growth_player_month,
  public.growth_cohort_matrix, public.growth_play_dims, public.growth_registration,
  public.growth_downloads_month
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.growth_cohort_players(text, int, text) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.growth_cohort_players(text, int, text) TO service_role;
