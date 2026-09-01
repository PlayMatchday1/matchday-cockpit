-- MOVE growth_registration's SIGNUP MONTH FROM UTC TO AMERICA/CHICAGO.
--
-- ── WHY, AND WHY ONCE ────────────────────────────────────────────────────────
-- Player Behavior is gaining a WEEKLY granularity. Weekly buckets are Chicago —
-- a signup at 03:36Z on the 1st happened at 22:36 on the 31st at the pitch, and
-- on a weekly bucket a shifted day crosses a boundary one time in seven rather
-- than one in thirty. Leaving the monthly buckets on UTC would put two clocks on
-- one page, which is the failure mode this estate keeps producing.
--
-- So the whole page moves to one clock. Ruled 2026-09-01, deliberately, knowing
-- it moves historical numbers on a live page.
--
-- ── WHAT MOVES, MEASURED BEFORE THE CHANGE ───────────────────────────────────
-- 27,064 completed non-fake users. The TOTAL is unchanged — this only moves
-- people between buckets, it creates and destroys nobody.
--
--   218 users (0.81%) fall in a different MONTH under the two zones.
--   The largest absolute move in any month is 11 USERS (2026-05: 1308 -> 1297).
--   The six months the panel renders by default all move by under 1%:
--       2026-03 1188->1185   2026-04 1261->1269   2026-05 1308->1297
--       2026-06 1517->1525   2026-07 2260->2255   2026-08 1922->1929
--   Eight older/partial months exceed 1% only because their denominators are
--   small (2023-05 is 170 users, so six people is 3.5%). 2026-09 reads -19% on
--   the day this shipped because the month was one day old; it self-corrects.
--
-- ── WHAT ELSE THIS MOVES ─────────────────────────────────────────────────────
-- growth_registration is read by growthFromViews.ts:813, which backs
-- /api/lifecycle, which feeds EVERY Player Lifecycle report: Player Funnel,
-- Player Behavior, Revenue per Player, Retention, Churn and the Data Room. All
-- six shift by the same small amounts. The Growth tab does NOT read it, and
-- neither does the exec summary.
--
-- ── WHAT THIS DOES *NOT* TOUCH ───────────────────────────────────────────────
-- members_monthly_snapshots stays UTC. Those rows are frozen history and some
-- have been quoted to people. It will therefore disagree with the Lifecycle
-- pages by +/-1 member per month (measured Mar-Aug 2026). Recorded in
-- docs/matchday-api-facts.md so the next reader finds it before it surprises
-- them.
--
-- ── A MATERIALIZED VIEW CANNOT BE REPLACED IN PLACE ──────────────────────────
-- CREATE OR REPLACE does not exist for materialized views, so this DROPs and
-- recreates. BOTH INDEXES ARE RECREATED BELOW — the unique one on user_id is
-- not decoration: REFRESH MATERIALIZED VIEW CONCURRENTLY requires it, and
-- refresh_growth_views() would start failing without it.
--
-- Everything other than the time zone is byte-identical to 0096.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

DROP MATERIALIZED VIEW IF EXISTS public.growth_registration;

CREATE MATERIALIZED VIEW public.growth_registration AS
SELECT
  u.id                                                   AS user_id,
  u.is_fake_player                                       AS is_fake_player,
  (u.completed_sign_up_at IS NOT NULL)                   AS completed,
  -- THE ONE CHANGED LINE: 'UTC' -> 'America/Chicago'.
  -- AT TIME ZONE on a timestamptz renders the instant in that zone, so a
  -- 03:36Z signup on the 1st becomes 22:36 on the 31st and buckets to the
  -- previous month. IANA, not a fixed offset, so it is DST-aware — a fixed
  -- -06:00 would be an hour wrong from March to November, which is the exact
  -- mistake Retool makes on promo dates.
  CASE WHEN u.completed_sign_up_at IS NOT NULL
       THEN to_char(u.completed_sign_up_at::timestamptz AT TIME ZONE 'America/Chicago', 'YYYY-MM') END AS signup_month,
  u.preferable_city_name                                 AS declared_city_raw,
  COALESCE(pp.matches_played, 0)                         AS lifetime_matches
FROM public.mdapi_users u
LEFT JOIN public.growth_player_profile pp ON pp.user_id = u.id
WHERE COALESCE(u.is_fake_player, false) = false;

-- REQUIRED for REFRESH ... CONCURRENTLY. Recreated exactly as 0096 had it.
CREATE UNIQUE INDEX growth_registration_pk ON public.growth_registration (user_id);
CREATE INDEX growth_registration_signup ON public.growth_registration (signup_month);
